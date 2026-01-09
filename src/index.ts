// ============================================
// Cloudflare Worker - Main Entry Point (WITH QUEUES)
// ============================================

import type { Env } from './types';
import { createSupabaseClient } from './database/client';
import { SettingsManager } from './database/settings';
import { createBot, createTelegramWebhookHandler } from './bot/grammy';
import { handleTodoistWebhook, sendTaskNotification } from './handlers/todoist';
import { validateEnvironment } from './utils/validation';
import { asyncHandler, formatErrorResponse, ValidationError } from './utils/errors';
import { processReportJob } from './queues/report-processor';
import type { ReportJobMessage } from './queues/report-processor';

// Extended Env with Queue binding
interface EnvWithQueue extends Env {
  REPORT_QUEUE: any; // Cloudflare Queue binding
}

export default {
  /**
   * Main HTTP request handler
   */
  async fetch(request: Request, env: EnvWithQueue, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    console.log(`📥 ${request.method} ${path}`);

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

    try {
      // ============================================
      // HEALTH CHECK
      // ============================================
      if (path === '/health' && request.method === 'GET') {
        return handleHealth(db);
      }

      // ============================================
      // TODOIST WEBHOOK
      // ============================================
      if (path === '/webhook/todoist' && request.method === 'POST') {
        return asyncHandler(async () => {
          const rawBody = await request.text();
          console.log('📥 Raw Todoist webhook:', rawBody);
          const payload = JSON.parse(rawBody);
          
          return await handleTodoistWebhookEndpoint(payload, env, db, settings);
        })(request, env, ctx);
      }

      // ============================================
      // TELEGRAM WEBHOOK
      // ============================================
      if (path === '/telegram/webhook' && request.method === 'POST') {
        const botToken = env.TELEGRAM_BOT_TOKEN;
        
        // Pass queue to bot context
        const bot = createBot(botToken, db, settings, env.REPORT_QUEUE);
        const handler = createTelegramWebhookHandler(bot);
        
        return await handler(request);
      }

      // ============================================
      // SETTINGS API
      // ============================================
      if (path.startsWith('/api/settings')) {
        return asyncHandler(async () => {
          return await handleSettingsAPI(request, path, settings);
        })(request, env, ctx);
      }

      // ============================================
      // JOB STATUS API (Optional - for monitoring)
      // ============================================
      if (path.startsWith('/api/jobs/') && request.method === 'GET') {
        const jobId = path.split('/').pop();
        if (!jobId) {
          return new Response('Job ID required', { status: 400 });
        }

        const job = await db.select('job_status', {
          filter: { job_id: jobId },
          limit: 1,
        });

        if (job.length === 0) {
          return new Response(
            JSON.stringify({ success: false, error: 'Job not found' }),
            { status: 404, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response(
          JSON.stringify({ success: true, data: job[0] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // ============================================
      // ROOT INFO
      // ============================================
      if (path === '/' && request.method === 'GET') {
        return new Response(
          JSON.stringify({
            name: 'Progress Bot API',
            version: '2.0.0',
            status: 'online',
            features: ['Async Report Processing', 'No Timeout Limits'],
            timezone: 'Africa/Cairo (GMT+2)',
            endpoints: {
              health: 'GET /health',
              todoist_webhook: 'POST /webhook/todoist',
              telegram_webhook: 'POST /telegram/webhook',
              settings: 'GET/POST/DELETE /api/settings',
              job_status: 'GET /api/jobs/{jobId}',
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // ============================================
      // 404 NOT FOUND
      // ============================================
      console.log(`❌ Route not found: ${path}`);
      return new Response(
        JSON.stringify({ success: false, error: 'Not found', path }),
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

  /**
   * Queue consumer handler
   * This runs when a message is received from the queue
   * NO TIMEOUT LIMITS HERE!
   */
  async queue(batch: MessageBatch<ReportJobMessage>, env: EnvWithQueue): Promise<void> {
    const db = createSupabaseClient(env);
    const settings = new SettingsManager(db);

    console.log(`📦 Processing ${batch.messages.length} messages from queue`);

    for (const message of batch.messages) {
      try {
        console.log(`🎯 Processing message ID: ${message.id}`);
        
        // Process the report job (NO TIMEOUT!)
        await processReportJob(message.body, db, settings);
        
        // Acknowledge successful processing
        message.ack();
        
        console.log(`✅ Message ${message.id} processed successfully`);
      } catch (error) {
        console.error(`❌ Failed to process message ${message.id}:`, error);
        
        // Retry the message (up to max_retries in wrangler.toml)
        message.retry();
      }
    }
  },
};

// ============================================
// Helper Functions
// ============================================

async function handleHealth(db: any): Promise<Response> {
  try {
    const isHealthy = await db.healthCheck();
    
    return new Response(
      JSON.stringify({
        status: 'ok',
        database: isHealthy ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString(),
        timezone: 'Africa/Cairo (GMT+2)',
        features: {
          async_processing: 'enabled',
          queue_system: 'cloudflare_queues',
        },
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
  env: EnvWithQueue,
  db: any,
  settings: SettingsManager
): Promise<Response> {
  try {
    const result = await handleTodoistWebhook(payload, db, settings);

    if (result.task) {
      const botToken = env.TELEGRAM_BOT_TOKEN;
      const chatId = env.TELEGRAM_CHAT_ID;
      
      console.log('📤 Sending notification to:', chatId);
      
      try {
        await sendTaskNotification(result.task, chatId, botToken);
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

// Type for Queue message batch
interface MessageBatch<T = any> {
  queue: string;
  messages: QueueMessage<T>[];
}

interface QueueMessage<T = any> {
  id: string;
  timestamp: Date;
  body: T;
  ack(): void;
  retry(): void;
}