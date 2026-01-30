// ============================================
// Cloudflare Worker - Main Entry Point (WITH DURABLE OBJECTS)
// ============================================

import type { Env } from './types';
import { createSupabaseClient, op } from './database/client';
import { SettingsManager, getAIModelByTier } from './database/settings';
import { createBot, createTelegramWebhookHandler } from './bot/grammy';
import { handleTodoistWebhook, sendTaskNotification } from './handlers/todoist';
import { syncFailuresFromTodoist } from './handlers/todoist';
import { validateEnvironment } from './utils/validation';
import { asyncHandler, formatErrorResponse, ValidationError } from './utils/errors';
import { ReportProcessor } from './durable-objects/report-processor';
import { createReportGenerator } from './services/report-generator';
import { getTodayInEgypt } from './utils/timezone';

// Extended Env with Durable Object binding
interface EnvWithDO extends Env {
  REPORT_PROCESSOR: DurableObjectNamespace; // Durable Object namespace
  SUPABASE_SERVICE_ROLE_KEY?: string; // For storage operations (bypasses RLS)
  AUTOFAIL_SECRET?: string; // Secret for authenticating external cron requests
}

export { ReportProcessor }; // Export the Durable Object class

export default {
  /**
   * Scheduled handler for automatic check-ins (cron-triggered)
   * Configure in wrangler.toml with crons trigger for auto-coach check-ins
   */
  async scheduled(_event: ScheduledEvent, env: EnvWithDO, _ctx: ExecutionContext): Promise<void> {
    console.log('🕐 Scheduled task triggered at:', new Date().toISOString());

    const db = createSupabaseClient(env);
    const settings = new SettingsManager(db);

    // Get Egypt time
    const egyptTime = new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' });
    const egyptDate = new Date(egyptTime);
    const egyptHour = egyptDate.getHours();
    const egyptMinute = egyptDate.getMinutes();
    console.log(`🕐 Egypt time: ${egyptHour}:${egyptMinute.toString().padStart(2, '0')}`);

    // ============================================
    // AUTO-COACH: Run every 30 minutes
    // ============================================
    try {
      // Import auto-coach dependencies
      const { createAutoCoach } = await import('./coach/auto-coach');
      const { createAIClient } = await import('./services/ai-client');

      // Get API key and chat ID
      const apiKey = await settings.get('openrouter_api_key');
      const chatId = env.TELEGRAM_CHAT_ID || await settings.get('telegram_chat_id');
      const botToken = env.TELEGRAM_BOT_TOKEN;

      if (!apiKey || !chatId) {
        console.log('⏭️ Auto-coach skipped: missing API key or chat ID');
        return;
      }

      // Create auto-coach - use LOW-TIER model for coaching probes
      const aiModel = await getAIModelByTier(settings, 'low');
      const aiClient = createAIClient(apiKey, aiModel);
      const autoCoach = createAutoCoach(db, settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));

      // Check if we should send a probe
      const probeResult = await autoCoach.shouldProbe(chatId);

      if (probeResult.shouldProbe && probeResult.reason !== 'none') {
        console.log(`✅ Auto-coach probe triggered: ${probeResult.reason}`);

        // Generate and send the probe
        const message = await autoCoach.generateProbe(chatId, probeResult.reason);

        // Send via Telegram API directly
        const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown',
          }),
        });

        if (telegramResponse.ok) {
          console.log('✅ Auto-coach message sent successfully');
        } else {
          console.error('❌ Failed to send auto-coach message:', await telegramResponse.text());
        }
      } else {
        console.log('⏭️ No auto-coach probe needed');
      }
    } catch (error) {
      console.error('❌ Scheduled task error:', error);
    }
  },

  /**
   * Main HTTP request handler
   */
  async fetch(request: Request, env: EnvWithDO, ctx: ExecutionContext): Promise<Response> {
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
  console.log('📨 Telegram webhook received');
  
  // ✅ ADD THIS: Idempotency check to prevent duplicate processing
  try {
    const update = await request.clone().json() as { update_id: number };
    const updateId = update.update_id;
    const idempotencyKey = `webhook_${updateId}`;
    
    // Check if we already processed this update
    const existing = await db.select('conversation_state', {
      filter: { chat_id: op.eq(idempotencyKey) }
    });
    
    if (existing.length > 0) {
      console.log(`⏭️ Skipping duplicate webhook update ${updateId}`);
      return new Response('OK', { status: 200 });
    }
    
    // Mark as processing (expires in 5 minutes)
    await db.insert('conversation_state', {
      chat_id: idempotencyKey,
      conversation_type: 'webhook_processing',
      data: { processing: true },
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    });
  } catch (idempotencyError) {
    console.error('Idempotency check failed:', idempotencyError);
    // Continue anyway - don't block legitimate requests
  }
  
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const bot = createBot(botToken, db, settings, env.REPORT_PROCESSOR, {
          SUPABASE_URL: env.SUPABASE_URL,
          SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
          SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
          TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
        }, ctx); // Pass ExecutionContext for waitUntil
        const handler = createTelegramWebhookHandler(bot);

        try {
          const response = await handler(request);
          console.log('✅ Telegram webhook handled successfully');
          return response;
        } catch (webhookError) {
          console.error('❌ Telegram webhook error:', webhookError);
          throw webhookError;
        }
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
      // JOB STATUS API - Poll for job status
      // ============================================
      if (path.startsWith('/api/jobs/') && request.method === 'GET') {
        const jobId = path.split('/').pop();
        if (!jobId) {
          return new Response('Job ID required', { status: 400 });
        }

        // Get Durable Object for this job
        const id = env.REPORT_PROCESSOR.idFromName(jobId);
        const stub = env.REPORT_PROCESSOR.get(id);

        // Forward request to Durable Object
        const doResponse = await stub.fetch(new Request(`https://fake-host/status`));
        const status = await doResponse.json();

        return new Response(
          JSON.stringify({ success: true, data: status }),
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
            version: '2.0.0-durable-objects',
            status: 'online',
            features: [
              'Durable Objects for async processing',
              'No timeout limits on AI generation',
              'Free tier compatible'
            ],
            timezone: 'Africa/Cairo (GMT+2)',
            endpoints: {
              health: 'GET /health',
              todoist_webhook: 'POST /webhook/todoist',
              telegram_webhook: 'POST /telegram/webhook',
              settings: 'GET/POST/DELETE /api/settings',
              job_status: 'GET /api/jobs/{jobId}',
              widget_last_reward: 'GET /api/widget/last-reward',
              widget_today_report: 'GET /api/widget/today-report',
              widget_daily_challenge: 'GET /api/widget/daily-challenge',
              widget_weekly_challenges: 'GET /api/widget/weekly-challenges',
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // ============================================
      // AUTO-FAIL API ENDPOINTS
      // ============================================
      if (path === '/api/autofail/init' && request.method === 'POST') {
        return asyncHandler(async () => {
          return await handleAutoFailInit(request, env, db, settings);
        })(request, env, ctx);
      }

      if (path === '/api/autofail/process' && request.method === 'POST') {
        return asyncHandler(async () => {
          return await handleAutoFailProcess(request, env, db, settings);
        })(request, env, ctx);
      }

      if (path === '/api/autofail/cleanup' && request.method === 'POST') {
        return asyncHandler(async () => {
          return await handleAutoFailCleanup(request, env, db);
        })(request, env, ctx);
      }

      // ============================================
      // WIDGET API ENDPOINTS
      // ============================================
      if (path.startsWith('/api/widget/') && request.method === 'GET') {
        return asyncHandler(async () => {
          return await handleWidgetAPI(path, db, settings);
        })(request, env, ctx);
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
          backend: 'durable_objects',
          free_tier: 'yes',
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
  env: EnvWithDO,
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
        // FIXED: Added db as 4th parameter
        await sendTaskNotification(result.task, chatId, botToken, db);
        console.log('✅ Notification sent successfully');

        // ✅ Trigger dopamine hit and battle mode AFTER notification
        const { triggerOnTaskComplete } = await import('./handlers/todoist');
        await triggerOnTaskComplete(result.task, chatId, botToken, db, settings);
        console.log('✅ Coach features triggered');
      } catch (err) {
        console.error('❌ Notification/coach error:', err);
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


// ============================================
// Widget API Handlers
// ============================================

async function handleWidgetAPI(
  path: string,
  db: any,
  settings: SettingsManager
): Promise<Response> {
  const endpoint = path.replace('/api/widget/', '');
  const today = getTodayInEgypt();

  // Common headers for widget responses (plain text, CORS enabled)
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=60', // Cache for 1 minute
  };

  try {
    switch (endpoint) {
      case 'last-reward': {
        // Get the most recent daily report with a reward
        const reports = await db.select('daily_reports', {
          order: 'report_date.desc',
          limit: 5,
        });

        for (const report of reports) {
          if (report.suggested_reward) {
            return new Response(
              `🎁 ${report.suggested_reward}\n📅 ${report.report_date}`,
              { status: 200, headers }
            );
          }
        }
        return new Response('لا توجد مكافآت حتى الآن', { status: 200, headers });
      }

      case 'today-report': {
  // Sync with Todoist first
  try {
    await syncFailuresFromTodoist(today, db, settings);
  } catch (syncError) {
    console.error('Widget sync warning:', syncError);
  }

  const reportGen = createReportGenerator(db, settings);
  const preview = await reportGen.generatePreview();

  // Return the FULL formatted text (same as /today command)
  return new Response(preview.formatted_text, { status: 200, headers });
}

      case 'daily-challenge': {
  // ✅ NEW: Auto-evaluate past challenges first
  const { createGoalsManager } = await import('./services/goals-manager');
  const { createAIClient } = await import('./services/ai-client');
  
  const openRouterKey = await settings.get('openrouter_api_key');
  // Use LOW-TIER model for goals management
  const aiModel = await getAIModelByTier(settings, 'low');
  const aiClient = createAIClient(openRouterKey?.trim() || '', aiModel);
  
  const goalsMgr = createGoalsManager(db, settings, aiClient);
  await goalsMgr.autoEvaluatePastChallenges();
  
  // Get today's challenge AND weekly challenges list
  const weekStart = getWeekStartDate();
  const weekEnd = getWeekEndDate();

  // Get all challenges for the week
  const allChallenges = await db.select('daily_challenges', {
    order: 'challenge_date.asc',
  });

  const weekChallenges = allChallenges.filter((c: any) => {
    const date = c.challenge_date;
    return date >= weekStart && date <= weekEnd;
  });

  if (weekChallenges.length === 0) {
    return new Response('لا يوجد تحدي لليوم', { status: 200, headers });
  }

  // Find today's challenge
  const todayChallenge = weekChallenges.find((c: any) => c.challenge_date === today);

  // Build response with today's challenge highlighted and weekly list
  const arabicDays: Record<number, string> = {
    0: 'الأحد', 1: 'الإثنين', 2: 'الثلاثاء',
    3: 'الأربعاء', 4: 'الخميس', 5: 'الجمعة', 6: 'السبت'
  };

  let response = '';

  // Today's challenge first (highlighted)
  if (todayChallenge) {
    const statusIcon = todayChallenge.result === true ? '✅' : todayChallenge.result === false ? '❌' : '⏳';
    response += `🎯 تحدي اليوم:\n${statusIcon} ${todayChallenge.challenge_text}\n\n`;
  }

  // ✅ NEW: Detailed weekly summary (moved from weekly goals)
  const completed = weekChallenges.filter((c: any) => c.result === true).length;
  const failed = weekChallenges.filter((c: any) => c.result === false).length;
  const pending = weekChallenges.filter((c: any) => c.result === undefined || c.result === null).length;

  response += `━━━━━━━━━━━━━━━━━━\n`;
  response += `📊 ملخص الأسبوع:\n`;
  response += `✅ مكتمل: ${completed}\n`;
  response += `❌ فاشل: ${failed}\n`;
  response += `⏳ قيد الانتظار: ${pending}\n`;

  if (completed > 0 || failed > 0) {
    const rate = Math.round((completed / (completed + failed)) * 100);
    response += `📈 نسبة النجاح: ${rate}%\n`;
  }
  
  response += `━━━━━━━━━━━━━━━━━━\n\n`;

  // List all weekly challenges
  response += `⚡ التحديات اليومية:\n\n`;
  for (const c of weekChallenges) {
    const date = new Date(c.challenge_date + 'T12:00:00Z');
    const dayName = arabicDays[date.getDay()] || '';
    const statusIcon = c.result === true ? '✅' : c.result === false ? '❌' : '⏳';
    const isToday = c.challenge_date === today ? ' ← اليوم' : '';
    response += `${statusIcon} ${dayName} (${c.challenge_date})${isToday}\n`;
    response += `   ${c.challenge_text}\n\n`;
  }

  return new Response(response.trim(), { status: 200, headers });
}

      // AFTER (showing GOALS with challenge results):
case 'weekly-goals': // Also support this name
case 'weekly-challenges': {
  const weekStart = getWeekStartDate();
  const weekEnd = getWeekEndDate();

  // Get weekly goals
  const goals = await db.select('weekly_goals', {
    filter: { week_start_date: op.eq(weekStart) },
    limit: 1,
  });

  let response = '';

  if (goals.length === 0 || !goals[0]) {
    return new Response(
      '⚠️ لا توجد أهداف لهذا الأسبوع',
      { status: 200, headers }
    );
  }

  const weekGoals = goals[0];
  
  // Header
  response += `🎯 الأهداف الأسبوعية\n`;
  response += `📅 ${weekStart} → ${weekEnd}\n`;
  response += `━━━━━━━━━━━━━━━━━━\n\n`;
  
  // Goals text
  response += weekGoals.goals_text + '\n\n';
  
  // ✅ NEW: Get latest weekly goals analysis from daily reports
  const recentReports = await db.select('daily_reports', {
    order: 'report_date.desc',
    limit: 7, // Check last 7 days for analysis
  });

  // Find the most recent report with goals analysis
  let latestAnalysis: any = null;
  for (const report of recentReports) {
    if (report.weekly_goals_analysis) {
      try {
        const analysis = typeof report.weekly_goals_analysis === 'string'
          ? JSON.parse(report.weekly_goals_analysis)
          : report.weekly_goals_analysis;
        
        // Check if analysis has content
        if (analysis && (
          (analysis.completed && analysis.completed.length > 0) ||
          (analysis.inProgress && analysis.inProgress.length > 0) ||
          (analysis.neglected && analysis.neglected.length > 0)
        )) {
          latestAnalysis = analysis;
          break;
        }
      } catch (e) {
        // Skip invalid JSON
        continue;
      }
    }
  }

  // Display latest analysis if found
  if (latestAnalysis) {
    response += `━━━━━━━━━━━━━━━━━━\n`;
    response += `📊 آخر تحديث:\n\n`;

    if (latestAnalysis.completed && latestAnalysis.completed.length > 0) {
      response += `✅ منجزة:\n`;
      latestAnalysis.completed.forEach((g: string) => {
        response += `• ${g}\n`;
      });
      response += '\n';
    }

    if (latestAnalysis.inProgress && latestAnalysis.inProgress.length > 0) {
      response += `🔄 قيد التنفيذ:\n`;
      latestAnalysis.inProgress.forEach((g: string) => {
        response += `• ${g}\n`;
      });
      response += '\n';
    }

    if (latestAnalysis.neglected && latestAnalysis.neglected.length > 0) {
      response += `⚠️ مهملة:\n`;
      latestAnalysis.neglected.forEach((g: string) => {
        response += `• ${g}\n`;
      });
    }
  } else {
    response += `━━━━━━━━━━━━━━━━━━\n`;
    response += `ℹ️ لم يتم تحليل الأهداف بعد\n`;
  }

  return new Response(response.trim(), { status: 200, headers });
}

      default:
        return new Response(
          `Unknown widget endpoint: ${endpoint}\nAvailable: last-reward, today-report, daily-challenge, weekly-challenges`,
          { status: 404, headers }
        );
    }
  } catch (error) {
    console.error('Widget API error:', error);
    return new Response(
      `خطأ: ${error instanceof Error ? error.message : 'Unknown'}`,
      { status: 500, headers }
    );
  }
}

// Helper: Get week start date (Saturday)
function getWeekStartDate(): string {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 = Sunday, 6 = Saturday
  const daysFromSat = dayOfWeek === 6 ? 0 : dayOfWeek + 1;
  const saturday = new Date(today);
  saturday.setDate(today.getDate() - daysFromSat);
  return saturday.toISOString().split('T')[0] || '';
}

// Helper: Get week end date (Friday)
function getWeekEndDate(): string {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const daysToFri = dayOfWeek <= 5 ? 5 - dayOfWeek : 6;
  const friday = new Date(today);
  friday.setDate(today.getDate() + daysToFri);
  return friday.toISOString().split('T')[0] || '';
}

// ============================================
// Auto-Fail HTTP Handlers (External Cron)
// ============================================

/**
 * Initialize auto-fail: fetch tasks and queue them
 */
async function handleAutoFailInit(
  request: Request,
  env: EnvWithDO,
  db: any,
  settings: SettingsManager
): Promise<Response> {
  // Authenticate
  const authHeader = request.headers.get('Authorization');
  if (!env.AUTOFAIL_SECRET || authHeader !== `Bearer ${env.AUTOFAIL_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const today = getTodayInEgypt();
  const todoistToken = await settings.get('todoist_api_token');
  const todoistProjectId = await settings.get('todoist_project_id');
  const priorityThresholdStr = await settings.get('failure_priority_threshold');
  const priorityThreshold = priorityThresholdStr ? parseInt(priorityThresholdStr, 10) : 2;
  const chatId = env.TELEGRAM_CHAT_ID || await settings.get('telegram_chat_id');
  const botToken = env.TELEGRAM_BOT_TOKEN;

  if (!todoistToken || !chatId) {
    return new Response(
      JSON.stringify({ success: false, error: 'Missing configuration' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Check if already processing
  const jobId = `autofail_${today}`;
  const id = env.REPORT_PROCESSOR.idFromName(jobId);
  const stub = env.REPORT_PROCESSOR.get(id);
  
  const existingQueue = await stub.fetch(new Request('https://fake-host/autofail/check-queue', {
    method: 'POST',
    body: JSON.stringify({ today }),
  }));
  const queueData = await existingQueue.json() as { exists: boolean };
  
  if (queueData.exists) {
    return new Response(
      JSON.stringify({ success: false, error: 'Already processing' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Fetch tasks from Todoist
  let url = 'https://api.todoist.com/rest/v3/tasks';
  if (todoistProjectId) {
    url += `?project_id=${todoistProjectId.trim()}`;
  }

  const tasksResponse = await fetch(url, {
    headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
  });

  if (!tasksResponse.ok) {
    return new Response(
      JSON.stringify({ success: false, error: `Todoist API error: ${tasksResponse.status}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const allTasks = await tasksResponse.json() as Array<{
    id: string;
    content: string;
    priority: number;
    due?: { date: string; is_recurring?: boolean } | null;
  }>;

  // Filter tasks
  const tasksDueToday = allTasks.filter(task => {
    if (!task.due?.date) return false;
    const dueDate = task.due.date.split('T')[0];
    return dueDate && dueDate <= today;
  });

// Split tasks: high-priority (track failures) vs low-priority (just complete)
const highPriorityTasks = tasksDueToday.filter(task => {
  const ourPriority = 5 - (task.priority || 1);
  return ourPriority <= priorityThreshold;
});

const lowPriorityTasks = tasksDueToday.filter(task => {
  const ourPriority = 5 - (task.priority || 1);
  return ourPriority > priorityThreshold;
});

const allTasksToComplete = [...highPriorityTasks, ...lowPriorityTasks];

if (allTasksToComplete.length === 0) {
  // ... (no tasks message)
}

// Store BOTH lists in metadata
await stub.fetch(new Request('https://fake-host/autofail/init-queue', {
  method: 'POST',
  body: JSON.stringify({
    today,
    taskIds: allTasksToComplete.map(t => t.id),
    tasks: allTasksToComplete,
    metadata: { 
      chatId, 
      todoistToken: todoistToken.trim(), 
      botToken, 
      totalTasks: allTasksToComplete.length,
      priorityThreshold, // ADD THIS
      highPriorityIds: highPriorityTasks.map(t => t.id), // ADD THIS
    },
  }),
}));

  if (filteredTasks.length === 0) {
    // Send message to user
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ لا توجد مهام للتسجيل كفاشلة',
      }),
    });

    return new Response(
      JSON.stringify({ success: true, totalTasks: 0, message: 'No tasks to process' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Store in Durable Object
  await stub.fetch(new Request('https://fake-host/autofail/init-queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      today,
      taskIds: filteredTasks.map(t => t.id),
      tasks: filteredTasks,
      metadata: { chatId, todoistToken: todoistToken.trim(), botToken, totalTasks: filteredTasks.length },
    }),
  }));

  // Send notification
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `🌙 Auto-fail initialized\n📋 ${filteredTasks.length} tasks queued`,
    }),
  });

  return new Response(
    JSON.stringify({ success: true, totalTasks: filteredTasks.length, jobId }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * Process one batch of auto-fail tasks
 */
async function handleAutoFailProcess(
  request: Request,
  env: EnvWithDO,
  _db: any,
  _settings: SettingsManager
): Promise<Response> {
  // Authenticate
  const authHeader = request.headers.get('Authorization');
  if (!env.AUTOFAIL_SECRET || authHeader !== `Bearer ${env.AUTOFAIL_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const today = getTodayInEgypt();
  const jobId = `autofail_${today}`;
  const id = env.REPORT_PROCESSOR.idFromName(jobId);
  const stub = env.REPORT_PROCESSOR.get(id);

  // Process batch in Durable Object
  const response = await stub.fetch(new Request('https://fake-host/autofail/process-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ today, db: env.SUPABASE_URL }),
  }));

  return response; // Forward response from Durable Object
}

async function handleAutoFailCleanup(
  request: Request,
  env: EnvWithDO,
  _db: any
): Promise<Response> {
  // Authenticate
  const authHeader = request.headers.get('Authorization');
  if (!env.AUTOFAIL_SECRET || authHeader !== `Bearer ${env.AUTOFAIL_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const today = getTodayInEgypt();
  const jobId = `autofail_${today}`;
  const id = env.REPORT_PROCESSOR.idFromName(jobId);
  const stub = env.REPORT_PROCESSOR.get(id);

  await stub.fetch(new Request('https://fake-host/autofail/cleanup', {
    method: 'POST',
    body: JSON.stringify({ today }),
  }));

  return new Response(
    JSON.stringify({ success: true }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}