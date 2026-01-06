// ============================================
// Cloudflare Worker - Main Entry Point
// ============================================

import type { Env } from './types';
import { createSupabaseClient } from './database/client';
import { SettingsManager, SETTINGS_KEYS } from './database/settings';
import { createBot, createTelegramWebhookHandler } from './bot/grammy';
import { handleTodoistWebhook, sendTaskNotification } from './handlers/todoist';
import { validateEnvironment } from './utils/validation';
import { asyncHandler, formatErrorResponse, ValidationError } from './utils/errors';

/**
 * Main worker request handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Validate environment variables
    const envValidation = validateEnvironment(env);
    if (!envValidation.valid) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Missing environment variables',
          details: envValidation.errors,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Create database client and settings manager
    const db = createSupabaseClient(env);
    const settings = new SettingsManager(db);

    // Parse URL
    const url = new URL(request.url);
    const path = url.pathname;

    // Route handling
    try {
      // Health check endpoint
      if (path === '/health' && request.method === 'GET') {
        return handleHealth(db);
      }

      // Todoist webhook endpoint
      if (path === '/webhook/todoist' && request.method === 'POST') {
        return asyncHandler(async () => {
          return await handleTodoistWebhookEndpoint(request, env, db, settings);
        })(request, env, ctx);
      }

      // Telegram webhook endpoint
      if (path === '/telegram/webhook' && request.method === 'POST') {
        const botToken = env.TELEGRAM_BOT_TOKEN;
        const bot = createBot(botToken, db, settings);
        const handler = createTelegramWebhookHandler(bot);
        return await handler(request);
      }

      // Settings API endpoints
      if (path.startsWith('/api/settings')) {
        return asyncHandler(async () => {
          return await handleSettingsAPI(request, path, settings);
        })(request, env, ctx);
      }

      // Root endpoint
      if (path === '/' && request.method === 'GET') {
        return new Response(
          JSON.stringify({
            name: 'Progress Bot API',
            version: '1.0.0',
            status: 'online',
            endpoints: {
              health: 'GET /health',
              todoist_webhook: 'POST /webhook/todoist',
              telegram_webhook: 'POST /telegram/webhook',
              settings: {
                get: 'GET /api/settings/:key',
                set: 'POST /api/settings',
                list: 'GET /api/settings',
              },
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // 404 for unknown routes
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Not found',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } catch (error) {
      console.error('Request handling error:', error);
      const errorResponse = formatErrorResponse(error as Error);
      
      return new Response(JSON.stringify(errorResponse), {
        status: errorResponse.statusCode,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

/**
 * Health check handler
 */
async function handleHealth(db: any): Promise<Response> {
  try {
    const isHealthy = await db.healthCheck();
    
    return new Response(
      JSON.stringify({
        status: 'ok',
        database: isHealthy ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString(),
      }),
      {
        status: isHealthy ? 200 : 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        status: 'error',
        database: 'error',
        error: (error as Error).message,
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Todoist webhook handler
 */
async function handleTodoistWebhookEndpoint(
  request: Request,
  env: Env,
  db: any,
  settings: SettingsManager
): Promise<Response> {
  try {
    // Parse webhook payload
    const payload = await request.json();

    // Process webhook
    const result = await handleTodoistWebhook(payload, db, settings);

    // Send Telegram notification if task was processed
    if (result.task) {
      const chatId = env.TELEGRAM_CHAT_ID;
      const botToken = env.TELEGRAM_BOT_TOKEN;
      const threadId = await settings.get(SETTINGS_KEYS.TELEGRAM_THREAD_ARABIC);
      
      // Fire and forget (don't wait for notification)
      sendTaskNotification(
        result.task,
        chatId,
        botToken,
        threadId || undefined
      ).catch(err => {
        console.error('Notification failed:', err);
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: result.message,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Todoist webhook error:', error);
    throw error;
  }
}

/**
 * Settings API handler
 */
async function handleSettingsAPI(
  request: Request,
  path: string,
  settings: SettingsManager
): Promise<Response> {
  // GET /api/settings - List all settings
  if (path === '/api/settings' && request.method === 'GET') {
    const allSettings = await settings.getAll();
    
    return new Response(
      JSON.stringify({
        success: true,
        data: allSettings,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // GET /api/settings/:key - Get specific setting
  if (path.startsWith('/api/settings/') && request.method === 'GET') {
    const key = path.split('/').pop();
    if (!key) {
      throw new ValidationError('Setting key is required');
    }

    const value = await settings.get(key);
    
    if (value === null) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Setting not found',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: { key, value },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // POST /api/settings - Set setting
  if (path === '/api/settings' && request.method === 'POST') {
    const body: any = await request.json();
    
    if (!body.key || !body.value) {
      throw new ValidationError('Both key and value are required');
    }

    await settings.set(body.key, body.value);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Setting updated',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // DELETE /api/settings/:key - Delete setting
  if (path.startsWith('/api/settings/') && request.method === 'DELETE') {
    const key = path.split('/').pop();
    if (!key) {
      throw new ValidationError('Setting key is required');
    }

    await settings.delete(key);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Setting deleted',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  throw new ValidationError('Invalid settings API endpoint');
}
