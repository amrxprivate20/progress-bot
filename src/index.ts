// ============================================
// Cloudflare Worker - Main Entry Point
// FIXED: Await notification completion to prevent premature termination
// ============================================

import type { Env } from './types';
import { createSupabaseClient } from './database/client';
import { SettingsManager, SETTINGS_KEYS } from './database/settings';
import { createBot, createTelegramWebhookHandler } from './bot/grammy';
import { handleTodoistWebhook, sendTaskNotification } from './handlers/todoist';
import { validateEnvironment } from './utils/validation';
import { asyncHandler, formatErrorResponse, ValidationError } from './utils/errors';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    const db = createSupabaseClient(env);
    const settings = new SettingsManager(db);
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/health' && request.method === 'GET') {
        return handleHealth(db);
      }

      if (path === '/webhook/todoist' && request.method === 'POST') {
        return asyncHandler(async () => {
          const rawBody = await request.text();
          
          // Log raw payload for debugging
          console.log('📥 Raw Todoist webhook:', rawBody);
          
          const payload = JSON.parse(rawBody);
          
          console.log('📥 Parsed webhook:', {
            event: payload.event_name,
            task: payload.event_data?.content,
            project: payload.event_data?.project_id,
          });
          
          return await handleTodoistWebhookEndpoint(payload, env, db, settings);
        })(request, env, ctx);
      }

      if (path === '/telegram/webhook' && request.method === 'POST') {
        const botToken = env.TELEGRAM_BOT_TOKEN;
        const bot = createBot(botToken, db, settings);
        const handler = createTelegramWebhookHandler(bot);
        return await handler(request);
      }

      if (path.startsWith('/api/settings')) {
        return asyncHandler(async () => {
          return await handleSettingsAPI(request, path, settings);
        })(request, env, ctx);
      }

      if (path === '/' && request.method === 'GET') {
        return new Response(
          JSON.stringify({
            name: 'Progress Bot API',
            version: '1.0.0',
            status: 'online',
            timezone: 'Africa/Cairo (GMT+2)',
            endpoints: {
              health: 'GET /health',
              todoist_webhook: 'POST /webhook/todoist',
              telegram_webhook: 'POST /telegram/webhook',
              settings: 'GET/POST/DELETE /api/settings',
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      return new Response(
        JSON.stringify({ success: false, error: 'Not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
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

async function handleHealth(db: any): Promise<Response> {
  try {
    const isHealthy = await db.healthCheck();
    
    return new Response(
      JSON.stringify({
        status: 'ok',
        database: isHealthy ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString(),
        timezone: 'Africa/Cairo (GMT+2)',
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
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function handleTodoistWebhookEndpoint(
  payload: any,
  env: Env,
  db: any,
  settings: SettingsManager
): Promise<Response> {
  try {
    const result = await handleTodoistWebhook(payload, db, settings);

    // FIXED: Await notification completion before responding
    if (result.task) {
      const botToken = env.TELEGRAM_BOT_TOKEN;
      const chatId = env.TELEGRAM_CHAT_ID;
      
      console.log('📤 Sending notification to:', chatId);
      
      // Send notification and wait for completion
      try {
        await sendTaskNotification(
          result.task,
          chatId,
          botToken
        );
        console.log('✅ Notification sent successfully');
      } catch (err) {
        console.error('❌ Notification failed:', err);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: result.message,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Todoist webhook error:', error);
    throw error;
  }
}

async function handleSettingsAPI(
  request: Request,
  path: string,
  settings: SettingsManager
): Promise<Response> {
  if (path === '/api/settings' && request.method === 'GET') {
    const allSettings = await settings.getAll();
    return new Response(
      JSON.stringify({ success: true, data: allSettings }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (path.startsWith('/api/settings/') && request.method === 'GET') {
    const key = path.split('/').pop();
    if (!key) {
      throw new ValidationError('Setting key is required');
    }

    const value = await settings.get(key);
    
    if (value === null) {
      return new Response(
        JSON.stringify({ success: false, error: 'Setting not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, data: { key, value } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (path === '/api/settings' && request.method === 'POST') {
    const body: any = await request.json();
    
    if (!body.key || !body.value) {
      throw new ValidationError('Both key and value are required');
    }

    await settings.set(body.key, body.value);

    return new Response(
      JSON.stringify({ success: true, message: 'Setting updated' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (path.startsWith('/api/settings/') && request.method === 'DELETE') {
    const key = path.split('/').pop();
    if (!key) {
      throw new ValidationError('Setting key is required');
    }

    await settings.delete(key);

    return new Response(
      JSON.stringify({ success: true, message: 'Setting deleted' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  throw new ValidationError('Invalid settings API endpoint');
}