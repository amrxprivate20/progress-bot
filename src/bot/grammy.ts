// ============================================
// Grammy Bot Setup - FIXED VERSION
// ============================================
// FIXES APPLIED:
// - Correct question numbering [1/N], [2/N], [3/N]
// - /skip_questions command to exit Q&A early
// - /log_failure command for manual failure logging
// - First question shows progress indicator
// - Removed noisy job ID messages

import { Bot, Context, webhookCallback } from 'grammy';
import type { SupabaseClient } from '../database/client';
import { op } from '../database/client';
import type { SettingsManager } from '../database/settings';
import { getAIModelByTier } from '../database/settings';
import { createConversationManager } from '../services/conversation-manager';
import { createMemoryManager } from '../services/memory-manager';
import { createReportGenerator } from '../services/report-generator';
import { createAIClient } from '../services/ai-client';
import { createJournalManager } from '../services/journal';
import { createGoalsManager } from '../services/goals-manager';
// createTaskGeneratorService is now used only in Durable Object
import { createMediaStorageService } from '../services/supabase-storage';
import { getTodayInEgypt, getYesterdayInEgypt } from '../utils/timezone';
import { handleConfirmCommand } from './confirm-handler';
import { syncFailuresFromTodoist, completeParentInTodoistIfAllDone } from '../handlers/todoist';
import type { FailedTask } from '../services/failure-manager';
import { getDailyFailures, upsertDailyFailures } from '../services/failure-manager';

// Phase 1 Coach Features
import { createStuckHandler } from '../interventions/stuck-handler';
import { createBattleMode } from '../gamification/battle-mode';
import { createRoastMode } from '../coach/roast-mode';
import { createAutoCoach } from '../coach/auto-coach';

/**
 * Wrapper for commands that require exclusive lock
 */
async function withCommandLock<T>(
  ctx: BotContext,
  commandName: string,
  operation: () => Promise<T>
): Promise<T | void> {
  const { acquireCommandLock, releaseCommandLock, getLockedCommand } = await import('../utils/command-lock');
  const chatId = ctx.chat?.id.toString() || '';
  
  // Try to acquire lock
  const acquired = await acquireCommandLock(ctx.db, chatId, commandName);
  
  if (!acquired) {
    // Get the command that's currently running
    const lockedCommand = await getLockedCommand(ctx.db, chatId);
    
    await ctx.reply(
      `⚠️ يوجد أمر قيد التنفيذ حالياً: ${lockedCommand}\n\n` +
      'يرجى الانتظار حتى ينتهي، أو استخدم /cancel لإلغائه.'
    );
    return;
  }
  
  try {
    // Execute the operation
    return await operation();
  } finally {
    // Always release lock
    await releaseCommandLock(ctx.db, chatId);
  }
}

/**
 * Extended context with Durable Objects namespace
 */
export interface BotContext extends Context {
  db: SupabaseClient;
  settings: SettingsManager;
  reportProcessorNamespace: DurableObjectNamespace;
  executionContext?: ExecutionContext; // For waitUntil background processing
  env: {
    SUPABASE_URL: string;
    SUPABASE_ANON_KEY: string;
    SUPABASE_SERVICE_ROLE_KEY?: string; // For storage operations
    TELEGRAM_BOT_TOKEN: string;
  };
}

/**
 * Create and configure Grammy bot
 */
export function createBot(
  token: string,
  db: SupabaseClient,
  settings: SettingsManager,
  reportProcessorNamespace: DurableObjectNamespace,
  env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string; SUPABASE_SERVICE_ROLE_KEY?: string; TELEGRAM_BOT_TOKEN: string },
  executionContext?: ExecutionContext
): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  // Add custom properties to context
  bot.use(async (ctx, next) => {
    ctx.db = db;
    ctx.settings = settings;
    ctx.reportProcessorNamespace = reportProcessorNamespace;
    ctx.executionContext = executionContext;
    ctx.env = env;
    await next();
  });

  // Register command handlers
  registerCommands(bot);

  // Error handler
  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  return bot;
}

async function sendAutoStatus(ctx: BotContext) {
  try {
    // ✅ FIXED: Only show auto-status when debug mode is enabled
    const debugMode = await ctx.settings.get('debugger_mode');
    if (debugMode !== 'true') {
      return; // Skip auto-status when not in debug mode
    }

    const chatId = ctx.chat?.id.toString() || '';

    // Check for remaining pending operations
    const allPending = await ctx.db.select('conversation_state', {});
    const userPending = allPending.filter(s =>
      (s.chat_id as string).includes(chatId)
    );

    if (userPending.length > 0) {
      let msg = '🐛 **[DEBUG] حالة النظام:**\n';
      msg += `عمليات معلقة: ${userPending.length}\n`;
      msg += `استخدم /status لمزيد من التفاصيل`;
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    console.error('Auto-status error:', error);
  }
}

/**
 * Register all bot commands
 */
function registerCommands(bot: Bot<BotContext>) {
  // Start command
  bot.command('start', async (ctx) => {
    const welcomeMessage = `
👋 مرحباً! أنا بوت تتبع التقدم الخاص بك.

📊 التقارير:
/today - ملخص سريع لليوم
/progress - ملخص + تحليل AI
/report YYYY-MM-DD - تقرير محفوظ

⏱️ تتبع المهام:
/starttask [اسم] - بدء تتبع مهمة
/completetask - إنهاء المهمة
/addduration - إضافة مدة
/addquantity - إضافة كمية
/log_failure - تسجيل فشل

🎯 التخطيط:
/todayplan - خطة اليوم بالذكاء الاصطناعي
/tomorrowplan - خطة الغد
/goals - الأهداف والتحديات
/createtasks - إنشاء مهام

🔥 الكوتش:
/stuck - تدخل فوري عند التأجيل
/battle_mode - معركة اليوم
/roast_me - إحراق شخصي 😏
/autofail - تسجيل المهام كفاشلة

📔 اليوميات:
/journal_start - بدء جلسة
/journal - عرض اليوميات

⚙️ الإعدادات:
/status - حالة النظام
/sync - مزامنة Todoist
/memory - الذاكرة
/debug - وضع التصحيح

📝 /help للقائمة الكاملة
    `.trim();

    await ctx.reply(welcomeMessage);
    await sendAutoStatus(ctx);
  });

// Status command - show current system status and pending operations
bot.command('status', async (ctx) => {
  try {
    const chatId = ctx.chat?.id.toString() || '';

    // Check for active task timer
    const taskKey = `active_task_${chatId}`;
    const activeTaskState = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(taskKey) },
    });

    // Check for any pending conversations/operations
    const allPending = await ctx.db.select('conversation_state', {});
    const userPending = allPending.filter(s =>
      (s.chat_id as string).includes(chatId)
    );

    // Build status message (plain text to avoid Markdown issues)
    let statusMsg = '📊 حالة النظام\n\n';

    // Active task timer
    if (activeTaskState.length > 0) {
      const taskData = (activeTaskState[0] as any).data || {};
      const taskName = taskData.taskName || 'مهمة غير معروفة';
      const startTime = taskData.startTime;

      if (startTime) {
        const elapsed = Date.now() - startTime;
        const elapsedMinutes = Math.round(elapsed / 60000);
        statusMsg += `⏱️ مهمة نشطة:\n`;
        statusMsg += `   📌 ${taskName}\n`;
        statusMsg += `   🕐 الوقت المنقضي: ${elapsedMinutes} دقيقة\n\n`;
      }
    } else {
      statusMsg += `⏱️ مهمة نشطة: لا يوجد\n\n`;
    }

    // Pending operations
    if (userPending.length > 0) {
      statusMsg += `📋 عمليات معلقة: ${userPending.length}\n`;

      const operationTypes = new Map<string, number>();
      for (const pendingOp of userPending) {
        const type = pendingOp.conversation_type;
        operationTypes.set(type, (operationTypes.get(type) || 0) + 1);
      }

      for (const [type, count] of operationTypes) {
        const arabicType = getArabicOperationType(type);
        statusMsg += `   • ${arabicType}: ${count}\n`;
      }

      statusMsg += `\n💡 استخدم /cancel لإلغاء العمليات المعلقة\n\n`;
    } else {
      statusMsg += `📋 عمليات معلقة: لا يوجد\n\n`;
    }

    // System info - wrapped in try/catch to avoid breaking status
    try {
      const today = getTodayInEgypt();
      const reportGen = createReportGenerator(ctx.db, ctx.settings);
      const data = await reportGen.collectReportData(today);

      statusMsg += `📅 إحصائيات اليوم:\n`;
      statusMsg += `   ✅ مهام مكتملة: ${data.tasks.length}\n`;
      statusMsg += `   ❌ مهام فاشلة: ${data.failedTasksJson?.failed_tasks?.length || 0}\n\n`;
    } catch (reportError) {
      console.error('Report data error in status:', reportError);
      statusMsg += `📅 إحصائيات اليوم: غير متاح\n\n`;
    }

    // Journal status - wrapped in try/catch
    try {
      const today = getTodayInEgypt();
      const journalMgr = createJournalManager(ctx.db);
      const journalEntries = await journalMgr.getEntriesForDate(today);
      const hasActiveJournal = journalEntries.some(e => e.is_session_start && !journalEntries.some(end => end.is_session_end));

      statusMsg += `📔 اليوميات:\n`;
      if (hasActiveJournal) {
        const entryCount = journalEntries.filter(e => e.message_text || e.media_url).length;
        statusMsg += `   🟢 جلسة نشطة (${entryCount} إدخالات)\n`;
      } else {
        statusMsg += `   ⚪ لا توجد جلسة نشطة\n`;
      }
    } catch (journalError) {
      console.error('Journal error in status:', journalError);
      statusMsg += `📔 اليوميات: غير متاح\n`;
    }

    statusMsg += `\n━━━━━━━━━━━━━━━━━━\n`;
    statusMsg += `✅ النظام يعمل بشكل طبيعي`;

    await ctx.reply(statusMsg);

  } catch (error) {
    console.error('Status command error:', error);
    await ctx.reply('❌ حدث خطأ أثناء فحص الحالة: ' + (error instanceof Error ? error.message : 'Unknown'));
  }
});

// Helper function to translate operation types to Arabic
function getArabicOperationType(type: string): string {
  const typeMap: Record<string, string> = {
    'active_task': 'مهمة نشطة',
    'qa_report': 'أسئلة التقرير',
    'task_selection': 'اختيار مهمة',
    'failure_selection': 'تسجيل فشل',
    'edit_goals': 'تعديل أهداف',
    'edit_challenges': 'تعديل تحديات',
    'clearmemory_confirmation': 'تأكيد مسح الذاكرة',
    'autofail_confirmation': 'تأكيد Autofail',
    'command_lock': 'أمر قيد التنفيذ',
    'createtasks_lock': 'إنشاء مهام',
    'pending_duration': 'إضافة مدة',
    'pending_quantity_input': 'إضافة كمية',
  };
  
  return typeMap[type] || type;
}

  // Help command
  bot.command('help', async (ctx) => {
    const helpMessage = `
📖 دليل الاستخدام الشامل

━━━━━━━━━━━━━━━━━━━━
📊 التقارير والملخصات:
━━━━━━━━━━━━━━━━━━━━
/today - ملخص سريع لمهام اليوم
/progress - ملخص اليوم مع خيار التحليل
/confirm - بدء التحليل بالذكاء الاصطناعي
/report YYYY-MM-DD - عرض تقرير محفوظ لتاريخ معين
/lastupdate - إحصائيات وحالة النظام
/status - عرض المهمة النشطة والعمليات المعلقة

━━━━━━━━━━━━━━━━━━━━
⏱️ تتبع المهام:
━━━━━━━━━━━━━━━━━━━━
/starttask - عرض المهام المتاحة للبدء
/starttask [اسم] - بدء تتبع مهمة محددة
/completetask - إنهاء المهمة النشطة وحفظها
/canceltask - إلغاء المهمة النشطة بدون حفظ
/addduration [دقائق] - إضافة مدة يدوياً قبل الإنهاء
/addquantity [كمية] [وحدة] - إضافة كمية قبل الإنهاء
/log_failure - تسجيل مهمة كفاشلة وتأجيلها

━━━━━━━━━━━━━━━━━━━━
🎯 التخطيط والأهداف:
━━━━━━━━━━━━━━━━━━━━
/todayplan - خطة اليوم بالذكاء الاصطناعي
/tomorrowplan - خطة الغد بالذكاء الاصطناعي
/goals - عرض أهداف الأسبوع والتحديات
/generate_goals - توليد أهداف وتحديات جديدة
/edit_goals - تعديل الأهداف الأسبوعية
/edit_challenges - تعديل التحديات اليومية
/createtasks - إنشاء مهام في Todoist من الأهداف
/sync - مزامنة المهام من Todoist

━━━━━━━━━━━━━━━━━━━━
🔥 الكوتش:
━━━━━━━━━━━━━━━━━━━━
/stuck - 🚨 تدخل فوري عند التأجيل
/stuck_continue - كمّل سبرنت آخر
/stuck_done - خلصت بعد السبرنت
/stuck_defer - أجّل مع سبب

/battle_mode - ⚔️ بدء معركة اليوم
/battle_status - حالة المعركة

/roast_me - 😏 إحراق شخصي
/weekly_roast - إحراق أسبوعي

/coach_check - تنبيه يدوي من الكوتش
/coach_settings - إعدادات الكوتش التلقائي
/coach_summary - ملخص التعلم اليومي
/autofail - تسجيل المهام المتبقية كفاشلة يدوياً

━━━━━━━━━━━━━━━━━━━━
📔 اليوميات:
━━━━━━━━━━━━━━━━━━━━
/journal_start - بدء جلسة يوميات جديدة
/journal_end - إنهاء الجلسة وحفظها
/journal_resume - استئناف جلسة سابقة
/journal - عرض يوميات اليوم
/journal YYYY-MM-DD - عرض يوميات تاريخ معين

━━━━━━━━━━━━━━━━━━━━
🧠 الذاكرة:
━━━━━━━━━━━━━━━━━━━━
/memory - عرض الذاكرة المحفوظة
/clearmemory - مسح جميع فئات الذاكرة

━━━━━━━━━━━━━━━━━━━━
⚙️ الإعدادات والتصحيح:
━━━━━━━━━━━━━━━━━━━━
/debug - تفعيل/إيقاف وضع التصحيح
/setmodel [نموذج] - تغيير نموذج AI
/skip_questions - تخطي أسئلة التحليل
/cancel - إلغاء أي عملية معلقة
/start - رسالة الترحيب
/help - هذه الرسالة

━━━━━━━━━━━━━━━━━━━━
💡 نصائح:
• المهام تُسجَّل تلقائياً عند إكمالها في Todoist
• استخدم /stuck عند الشعور بالتأجيل
• /battle_mode يحوّل يومك لمعركة ممتعة
• الكوتش يراقب تلقائياً ويتدخل عند الحاجة
    `.trim();

    await ctx.reply(helpMessage);
    await sendAutoStatus(ctx);
  });

  // Sync command - manual Todoist sync
  bot.command('sync', async (ctx) => {
    await withCommandLock(ctx, '/sync', async () => {
      await ctx.reply('🔄 جاري المزامنة مع Todoist...');

      const today = getTodayInEgypt();
      await syncFailuresFromTodoist(today, ctx.db, ctx.settings);
      await ctx.reply('✅ تمت المزامنة بنجاح! تم تحديث حالة المهام.');
    });
    await sendAutoStatus(ctx);
  });

  // Helper function to generate daily plan with hourly schedule
  // AI-powered daily plan generator
  async function generateDailyPlan(
    ctx: BotContext,
    targetDate: string,
    isToday: boolean
  ): Promise<string> {
    const arabicDays: Record<number, string> = {
      0: 'الأحد', 1: 'الإثنين', 2: 'الثلاثاء',
      3: 'الأربعاء', 4: 'الخميس', 5: 'الجمعة', 6: 'السبت'
    };
    const targetDateObj = new Date(targetDate + 'T12:00:00Z');
    const dayName = arabicDays[targetDateObj.getDay()] || '';
    const titleWord = isToday ? 'اليوم' : 'الغد';

    // Check for AI keys
    const openRouterKey = await ctx.settings.get('openrouter_api_key');
    const aiModel = await getAIModelByTier(ctx.settings, 'low');

    if (!openRouterKey) {
      return `📅 **خطة ${titleWord} (${dayName} ${targetDate})**\n\n` +
        `⚠️ مفتاح OpenRouter API غير مكون.\n` +
        `يرجى تكوين المفتاح لاستخدام التخطيط الذكي.`;
    }

    // Gather all context data
    // 1. Day's challenge
    const challenges = await ctx.db.select('daily_challenges', {
      filter: { challenge_date: op.eq(targetDate) },
      limit: 1,
    });
    const dailyChallenge = challenges[0]?.challenge_text || '';

    // 2. Weekly goals
    const weeklyGoals = await ctx.db.select('weekly_goals', {
      limit: 1,
    });
    const goalsText = weeklyGoals[0]?.goals_text || '';

    // 3. Circumstances from recent report
    const circumstancesDate = isToday ? getYesterdayInEgypt() : getTodayInEgypt();
    const reports = await ctx.db.select('daily_reports', {
      filter: { report_date: op.eq(circumstancesDate) },
      limit: 1,
    });
    let circumstances = '';
    if (reports.length > 0 && reports[0]?.user_comments) {
      try {
        const comments = JSON.parse(reports[0].user_comments);
        const answers = Object.values(comments);
        if (answers.length > 0) {
          circumstances = answers[answers.length - 1] as string || '';
        }
      } catch (e) { /* skip */ }
    }

    // 4. Memory (patterns, strategies)
    const memoryItems = await ctx.db.select('memory', {});
    const memoryContext = memoryItems
      .filter((m: any) => m.content && m.content.length > 0)
      .map((m: any) => `${m.category}: ${m.content}`)
      .join('\n');

    // 5. Todoist tasks
    const todoistToken = await ctx.settings.get('todoist_api_token');
    let tasksData: Array<{
      content: string;
      priority: number;
      due?: { date: string; datetime?: string };
    }> = [];

    if (todoistToken) {
      try {
        const response = await fetch('https://api.todoist.com/rest/v3/tasks', {
          headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
        });
        if (response.ok) {
          const allTasks = await response.json() as typeof tasksData;
          tasksData = allTasks.filter(t => {
            const taskDate = t.due?.date?.split('T')[0];
            return taskDate === targetDate;
          });
        }
      } catch (e) {
        console.error('Todoist fetch error:', e);
      }
    }

    if (tasksData.length === 0) {
      return `📅 **خطة ${titleWord} (${dayName} ${targetDate})**\n\n` +
        `📋 لا توجد مهام مجدولة لهذا التاريخ.\n\n` +
        `💡 استخدم /createtasks لإنشاء مهام جديدة.`;
    }

    // Format tasks for AI
    const tasksForAI = tasksData.map(t => {
      const priorityLabel = t.priority === 4 ? 'عاجل' :
                           t.priority === 3 ? 'مهم' :
                           t.priority === 2 ? 'عادي' : 'منخفض';
      const timeInfo = t.due?.datetime ?
        ` (موعد: ${new Date(t.due.datetime).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })})` : '';
      return `- ${t.content} [أولوية: ${priorityLabel}]${timeInfo}`;
    }).join('\n');

    // Build AI prompt
    const prompt = `
أنت مساعد ذكي متخصص في التخطيط اليومي. قم بإنشاء خطة يومية ذكية ومنظمة.

## المعلومات المتاحة:

**التاريخ:** ${dayName} ${targetDate} (${titleWord})

**المهام المجدولة (${tasksData.length}):**
${tasksForAI}

${dailyChallenge ? `**تحدي اليوم:** ${dailyChallenge}` : ''}

${goalsText ? `**أهداف الأسبوع:**\n${goalsText}` : ''}

${circumstances ? `**ظروف اليوم:** ${circumstances}` : ''}

${memoryContext ? `**معلومات عن المستخدم:**\n${memoryContext}` : ''}

## المطلوب:

اكتب خطة يومية ذكية تتضمن:

1. **⏰ توصيات الاستيقاظ والنوم** - بناءً على المهام والظروف
2. **📋 الجدول المقترح** - رتب المهام بذكاء على مدار اليوم مع:
   - الوقت المقترح لكل مهمة
   - المدة المتوقعة (إذا يمكن تقديرها)
   - تجميع المهام المتشابهة
3. **🎯 الالتزامات** - المهام السلبية (عدم فعل شيء) في قسم منفصل
4. **📌 إذا سمح الوقت** - المهام الأقل أولوية
5. **💡 نصائح** - 2-3 نصائح مخصصة للنجاح في هذا اليوم

اكتب باللهجة المصرية بشكل ودود ومحفز. لا تكتب مقدمات طويلة، ابدأ مباشرة بالخطة.
استخدم الإيموجي بشكل معتدل. اجعل الخطة عملية وقابلة للتنفيذ.
`;

    // Call AI - use 4000 tokens to allow comprehensive plans
    const aiClient = createAIClient(openRouterKey, aiModel);

    try {
      const aiResponse = await aiClient.complete([
        { role: 'system', content: 'أنت مساعد تخطيط يومي ذكي. تتحدث بالعامية المصرية بشكل طبيعي ومحفز.' },
        { role: 'user', content: prompt }
      ], 0.7, 4000);

      // Build final message
      let planMessage = `📅 **خطة ${titleWord} (${dayName} ${targetDate})**\n`;
      planMessage += `🤖 _تم إنشاؤها بالذكاء الاصطناعي_\n`;
      planMessage += `ـــــــــــــــــــــــ\n\n`;
      planMessage += aiResponse;
      planMessage += `\n\nـــــــــــــــــــــــ\n`;
      planMessage += `💡 استخدم /starttask لبدء تتبع مهمة`;

      return planMessage;

    } catch (aiError) {
      console.error('AI planning error:', aiError);
      return `📅 **خطة ${titleWord} (${dayName} ${targetDate})**\n\n` +
        `⚠️ حدث خطأ أثناء إنشاء الخطة الذكية.\n` +
        `${aiError instanceof Error ? aiError.message : 'خطأ غير معروف'}\n\n` +
        `**المهام المجدولة:**\n${tasksForAI}`;
    }
  }

  // Today plan command - AI-powered plan for today
  // Uses waitUntil for background processing to avoid webhook timeout
  bot.command(['todayplan', 'today_plan'], async (ctx) => {
    const updateId = ctx.update.update_id;
    const idempotencyKey = `plan_update_${updateId}`;
    const chatId = ctx.chat?.id.toString() || '';
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;

    try {
      // Check if this update was already processed (Telegram retry)
      const existing = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(idempotencyKey) },
      });

      if (existing.length > 0) {
        console.log(`⏭️ Skipping duplicate update ${updateId}`);
        return;
      }

      // Mark this update as being processed
      await ctx.db.insert('conversation_state', {
        chat_id: idempotencyKey,
        conversation_type: 'plan_idempotency',
        data: { startedAt: Date.now() },
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

      await ctx.reply('🤖 جاري إعداد خطة اليوم بالذكاء الاصطناعي...\n⏳ قد يستغرق هذا بضع ثوان...');

      // Run AI generation in background using waitUntil
      const backgroundTask = (async () => {
        try {
          const today = getTodayInEgypt();
          console.log('📅 [Background] Generating plan for today:', today);
          const planMessage = await generateDailyPlan(ctx, today, true);
          console.log('✅ [Background] Plan generated, length:', planMessage.length);

          // Send result via Telegram API directly
          await sendTelegramMessageDirect(botToken, chatId, planMessage);
        } catch (error) {
          console.error('❌ [Background] Today plan error:', error);
          await sendTelegramMessageDirect(botToken, chatId,
            '❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
        } finally {
          await ctx.db.delete('conversation_state', { chat_id: op.eq(idempotencyKey) }).catch(() => {});
        }
      })();

      // Use waitUntil if available, otherwise just fire and forget
      if (ctx.executionContext?.waitUntil) {
        ctx.executionContext.waitUntil(backgroundTask);
      } else {
        // Fallback: just await (may timeout)
        await backgroundTask;
      }
    } catch (error) {
      console.error('Today plan error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
      await ctx.db.delete('conversation_state', { chat_id: op.eq(idempotencyKey) }).catch(() => {});
    }
  });

  // Tomorrow plan command - AI-powered plan for tomorrow
  // Uses waitUntil for background processing to avoid webhook timeout
  bot.command(['tomorrowplan', 'tomorrow_plan'], async (ctx) => {
    const updateId = ctx.update.update_id;
    const idempotencyKey = `plan_update_${updateId}`;
    const chatId = ctx.chat?.id.toString() || '';
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;

    try {
      // Check if this update was already processed (Telegram retry)
      const existing = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(idempotencyKey) },
      });

      if (existing.length > 0) {
        console.log(`⏭️ Skipping duplicate update ${updateId}`);
        return;
      }

      // Mark this update as being processed
      await ctx.db.insert('conversation_state', {
        chat_id: idempotencyKey,
        conversation_type: 'plan_idempotency',
        data: { startedAt: Date.now() },
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

      await ctx.reply('🤖 جاري إعداد خطة الغد بالذكاء الاصطناعي...\n⏳ قد يستغرق هذا بضع ثوان...');

      // Run AI generation in background using waitUntil
      const backgroundTask = (async () => {
        try {
          const todayDate = new Date(getTodayInEgypt());
          todayDate.setDate(todayDate.getDate() + 1);
          const tomorrow = todayDate.toISOString().split('T')[0] || '';
          console.log('📅 [Background] Generating plan for tomorrow:', tomorrow);
          const planMessage = await generateDailyPlan(ctx, tomorrow, false);
          console.log('✅ [Background] Plan generated, length:', planMessage.length);

          // Send result via Telegram API directly
          await sendTelegramMessageDirect(botToken, chatId, planMessage);
        } catch (error) {
          console.error('❌ [Background] Tomorrow plan error:', error);
          await sendTelegramMessageDirect(botToken, chatId,
            '❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
        } finally {
          await ctx.db.delete('conversation_state', { chat_id: op.eq(idempotencyKey) }).catch(() => {});
        }
      })();

      // Use waitUntil if available, otherwise just fire and forget
      if (ctx.executionContext?.waitUntil) {
        ctx.executionContext.waitUntil(backgroundTask);
      } else {
        // Fallback: just await (may timeout)
        await backgroundTask;
      }
    } catch (error) {
      console.error('Tomorrow plan error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
      await ctx.db.delete('conversation_state', { chat_id: op.eq(idempotencyKey) }).catch(() => {});
    }
  });

  // Helper function to send Telegram messages directly (for background tasks)
  async function sendTelegramMessageDirect(botToken: string, chatId: string, text: string): Promise<void> {
    // Split long messages
    const MAX_LENGTH = 4000;
    const chunks: string[] = [];

    if (text.length <= MAX_LENGTH) {
      chunks.push(text);
    } else {
      let remaining = text;
      while (remaining.length > 0) {
        if (remaining.length <= MAX_LENGTH) {
          chunks.push(remaining);
          break;
        }
        let splitAt = MAX_LENGTH;
        const lastNewline = remaining.lastIndexOf('\n', MAX_LENGTH);
        if (lastNewline > MAX_LENGTH * 0.5) {
          splitAt = lastNewline + 1;
        }
        chunks.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt);
      }
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n${chunks[i]}` : chunks[i];
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      });
    }
  }

  /**
 * Handle /progress command
 * Shows preview and prompts for /confirm
 * Also checks for unsaved previous day reports
 */
bot.command('progress', async (ctx) => {
  try {
    await ctx.reply('🔄 جاري المزامنة وإعداد ملخص اليوم...');

    const reportGen = createReportGenerator(ctx.db, ctx.settings);
    const conversationMgr = createConversationManager(ctx.db);

    // Check for active conversation
    const chatId = ctx.chat?.id.toString() || '';
    const hasConversation = await conversationMgr.hasActiveConversation(chatId);

    if (hasConversation) {
      await ctx.reply('⚠️ لديك محادثة نشطة. استخدم /cancel لإلغائها أولاً.');
      return;
    }

    // Pre-sync with Todoist before displaying data
    const today = getTodayInEgypt();
    try {
      await syncFailuresFromTodoist(today, ctx.db, ctx.settings);
    } catch (syncError) {
      console.error('Pre-sync warning:', syncError);
      // Continue even if sync fails
    }

    // Check for unsaved previous day's report
    const yesterday = getYesterdayInEgypt();
    const yesterdayReports = await ctx.db.select('daily_reports', {
      filter: { report_date: op.eq(yesterday) },
      limit: 1,
    });

    if (yesterdayReports.length === 0) {
      // Check if there were tasks yesterday
      const yesterdayData = await reportGen.collectReportData(yesterday);
      const hasYesterdayTasks = yesterdayData.tasks.length > 0 ||
        (yesterdayData.failedTasksJson?.failed_tasks?.length || 0) > 0;

      if (hasYesterdayTasks) {
        await ctx.reply(
          '⚠️ **تنبيه: تقرير الأمس غير محفوظ!**\n\n' +
          `📅 تاريخ: ${yesterday}\n` +
          `📋 المهام: ${yesterdayData.tasks.length} مكتملة\n\n` +
          '🔹 لعرض وحفظ تقرير الأمس:\n' +
          `/report ${yesterday}\n` +
          'ثم /confirm\n\n' +
          '🔹 أو تابع لعرض تقرير اليوم:'
        );
      }
    }

    // Generate preview
    const preview = await reportGen.generatePreview();

    // Send preview
    await sendLongMessage(ctx, preview.formatted_text);

    // Prompt for confirm
    await ctx.reply(
      '─────────────────────\n' +
      '📝 هذا ملخص يومك!\n\n' +
      '🤖 لتحليل مفصل بالذكاء الاصطناعي، استخدم:\n' +
      '/confirm\n\n' +
      '💡 التحليل يشمل: تعليق شخصي، تحديث الذاكرة، تقييم التحدي، واقتراح مكافأة'
    );

  } catch (error) {
    console.error('Progress command error:', error);
    await ctx.reply('❌ حدث خطأ أثناء إعداد الملخص. حاول مرة أخرى.');
  }
});

/**
 * Helper: Send long message with splitting
 */
async function sendLongMessage(ctx: Context, message: string) {
  const MAX_LENGTH = 4096;
  
  if (message.length <= MAX_LENGTH) {
    await ctx.reply(message);
    return;
  }

  // Split at paragraph breaks
  const parts: string[] = [];
  let currentPart = '';
  const lines = message.split('\n');

  for (const line of lines) {
    if (currentPart.length + line.length + 1 > MAX_LENGTH) {
      parts.push(currentPart);
      currentPart = line + '\n';
    } else {
      currentPart += line + '\n';
    }
  }

  if (currentPart) {
    parts.push(currentPart);
  }

  // Send all parts
  for (const part of parts) {
    await ctx.reply(part);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

  // Confirm command
  bot.command('confirm', async (ctx) => {
    await withCommandLock(ctx, '/confirm', async () => {
    await handleConfirmCommand(ctx, ctx.reportProcessorNamespace);
  });
});

  // NEW: Skip questions command (handles both pre-analysis and post-analysis Q&A)
  bot.command(['skip_questions', 'skipquestions'], async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';
      const conversationMgr = createConversationManager(ctx.db);

      // ✅ Check for post-analysis Q&A first
      const postQAKey = `post_qa_${chatId}`;
      const pendingPostQA = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(postQAKey) },
      });

      if (pendingPostQA.length > 0) {
        // Skip post-analysis questions and save report immediately
        const qaData = (pendingPostQA[0] as any).data || {};
        const answers = qaData.answers as Record<string, string> || {};

        await ctx.db.delete('conversation_state', { chat_id: op.eq(postQAKey) });

        // Get pending report data
        const pendingReportKey = `pending_report_save_${chatId}`;
        const pendingReport = await ctx.db.select('conversation_state', {
          filter: { chat_id: op.eq(pendingReportKey) },
        });

        if (pendingReport.length > 0) {
          const reportState = (pendingReport[0] as any).data || {};
          await ctx.db.delete('conversation_state', { chat_id: op.eq(pendingReportKey) });

          // Combine pre-analysis and partial post-analysis answers
          const allAnswers = {
            ...reportState.preAnalysisAnswers,
            ...Object.fromEntries(
              Object.entries(answers).map(([q, a]) => [`[متابعة] ${q}`, a])
            ),
          };

          await ctx.reply('✅ تم تخطي الأسئلة. جاري حفظ التقرير...');

          await ctx.db.upsert('daily_reports', {
            report_date: reportState.reportDate,
            report_markdown: reportState.formattedReport,
            success_rate: reportState.stats.success_rate,
            total_tasks: reportState.stats.total_tasks,
            completed_tasks: reportState.stats.completed_tasks,
            failed_tasks: reportState.stats.failed_tasks,
            achievement_time_minutes: reportState.stats.total_time_minutes,
            challenge_evaluation: reportState.aiResponse.challengeEvaluation,
            ai_commentary: reportState.aiResponse.mainCommentary,
            suggested_reward: reportState.aiResponse.reward,
            weekly_goals_analysis: JSON.stringify(reportState.aiResponse.goalsAnalysis),
            user_comments: Object.keys(allAnswers).length > 0 ? JSON.stringify(allAnswers) : null,
            obsidian_file_id: reportState.aiSummary,
          }, 'report_date');

          await ctx.reply('✅ تم حفظ التقرير بنجاح!');

          // Update memory
          if (reportState.aiResponse.memoryUpdates && Object.keys(reportState.aiResponse.memoryUpdates).length > 0) {
            try {
              const openRouterKey = await ctx.settings.get('openrouter_api_key');
              const aiModel = await getAIModelByTier(ctx.settings, 'low');
              const aiClient = createAIClient(openRouterKey?.trim() || '', aiModel);
              const memoryMgr = createMemoryManager(ctx.db, aiClient);

              for (const [category, content] of Object.entries(reportState.aiResponse.memoryUpdates)) {
                try {
                  await memoryMgr.updateSingleCategory(category, content as string);
                } catch (e) { /* ignore */ }
              }
            } catch (e) { /* ignore */ }
          }
        }
        await sendAutoStatus(ctx);
        return;
      }

      // ✅ Check for pre-analysis Q&A
      const conversation = await conversationMgr.getConversation(chatId);

      if (!conversation || conversation.conversation_type !== 'qa_report') {
        await ctx.reply('⚠️ لا توجد محادثة أسئلة نشطة حالياً');
        return;
      }

      // Get context and partial answers
      const reportContext = await conversationMgr.getReportContext(chatId);
      const partialAnswers = await conversationMgr.getAnswers(chatId);

      // Clear conversation
      await conversationMgr.clearConversation(chatId);

      await ctx.reply('✅ تم تخطي الأسئلة المتبقية. جاري بدء التحليل...');

      // Start Durable Object job with partial answers
      const openRouterKey = await ctx.settings.get('openrouter_api_key');
      const anthropicApiKey = await ctx.settings.get('anthropic_api_key');
      const aiModel = await getAIModelByTier(ctx.settings, 'low');
      const botToken = await ctx.settings.get('telegram_bot_token');
      const useAnthropicPrimary = (await ctx.settings.get('use_anthropic_primary')) !== 'false';

      const hasValidOpenRouterKey = openRouterKey && openRouterKey.trim().startsWith('sk-or-v1-');
      const hasValidAnthropicKey = anthropicApiKey && anthropicApiKey.trim().startsWith('sk-ant-');

      if ((hasValidOpenRouterKey || hasValidAnthropicKey) && botToken) {
        const { startDurableObjectJob } = await import('./confirm-handler');
        await startDurableObjectJob(
          ctx,
          ctx.reportProcessorNamespace,
          reportContext,
          partialAnswers || {},
          openRouterKey?.trim() || '',
          aiModel,
          botToken,
          anthropicApiKey?.trim(),
          useAnthropicPrimary
        );
      }

    } catch (error) {
      console.error('Skip questions error:', error);
      await ctx.reply('❌ حدث خطأ. حاول مرة أخرى.');
    }
    await sendAutoStatus(ctx);
  });

  // Cancel command - ENHANCED to cancel ANY pending operation including locks
bot.command('cancel', async (ctx) => {
  try {
    const chatId = ctx.chat?.id.toString() || '';

    // Check for all types of pending operations (including command locks)
    const pendingOps = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.like(`%${chatId}%`) }, // Match any key containing chatId
    });

    if (pendingOps.length === 0) {
      await ctx.reply('✅ لا توجد عمليات نشطة للإلغاء');
      return;
    }

    // List what we're canceling
    const operationTypes = new Set<string>();
    for (const pendingOp of pendingOps) {
      const type = pendingOp.conversation_type;
      if (type === 'command_lock') {
        const cmdName = (pendingOp as any).data?.commandName || 'أمر';
        operationTypes.add(`قفل (${cmdName})`);
      } else {
        operationTypes.add(type);
      }
    }

    // Delete all pending operations for this user
    for (const pendingOp of pendingOps) {
      await ctx.db.delete('conversation_state', {
        id: op.eq(pendingOp.id as string)
      });
    }

    const typesStr = Array.from(operationTypes).join(', ');
    await ctx.reply(
      `✅ تم إلغاء العمليات التالية:\n` +
      `${typesStr}\n\n` +
      `يمكنك البدء من جديد الآن.`
    );

  } catch (error) {
    console.error('Cancel command error:', error);
    await ctx.reply('✅ تم الإلغاء');
  }
});

  // NEW: Log failure command - Lists tasks or creates new failure
bot.command('log_failure', async (ctx) => {
  await withCommandLock(ctx, '/log_failure', async () => {
    try {
      const args = ctx.message?.text?.split(' ').slice(1).join(' ') || '';
      const chatId = ctx.chat?.id.toString() || '';

      await ctx.reply('🔄 جاري تحميل المهام...');

      // Get Todoist credentials
      const todoistToken = await ctx.settings.get('todoist_api_token');
      const todoistProjectId = await ctx.settings.get('todoist_project_id');

      if (!todoistToken || !todoistProjectId) {
        await ctx.reply('❌ Todoist غير مكون بشكل صحيح');
        return;
      }

      // Get today's date in Egypt
      const today = getTodayInEgypt();
      const todayDate = new Date(today + 'T00:00:00Z');

      // Fetch all tasks from Todoist project
      const response = await fetch(
        `https://api.todoist.com/rest/v3/tasks?project_id=${todoistProjectId.trim()}`,
        {
          headers: {
            'Authorization': `Bearer ${todoistToken.trim()}`,
          },
        }
      );

      if (!response.ok) {
        const error = await response.text();
        await ctx.reply(`❌ فشل الاتصال بـ Todoist: ${response.status}\n${error.substring(0, 100)}`);
        return;
      }

      const allTasks = await response.json() as Array<{
        id: string;
        content: string;
        due?: { date: string; is_recurring: boolean };
        is_completed?: boolean;
      }>;

      // Filter to tasks available today (due today or overdue, not completed)
      const availableToday = allTasks.filter(t => {
        if (t.is_completed) return false;
        if (!t.due?.date) return true; // Tasks without due date

        const dueDateStr = t.due.date.split('T')[0];
        if (!dueDateStr) return false;

        const taskDueDate = new Date(dueDateStr + 'T00:00:00Z');
        return taskDueDate <= todayDate;
      });

      // Store key for selection
      const selectKey = `failure_select_${chatId}`;

      // Delete any existing selection state
      try {
        await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) });
      } catch (e) { /* ignore */ }

      // NO PARAMETERS - Show full list
      if (!args.trim()) {
        if (availableToday.length === 0) {
          await ctx.reply(
            '📋 لا توجد مهام متاحة اليوم في Todoist.\n\n' +
            '📝 يمكنك كتابة اسم مهمة جديدة:\n' +
            '/log_failure [اسم المهمة]'
          );
          return;
        }

        // Show list with "Add new task" option
        let message = '📋 **المهام المتاحة:**\n\n';

        availableToday.forEach((t, i) => {
          message += `${i + 1}. ${t.content}\n`;
        });

        message += `\n0. ➕ إضافة مهمة جديدة\n\n`;
        message += `🔢 أرسل رقم المهمة أو اسم المهمة الجديدة:`;

        // Create new selection state
        await ctx.db.insert('conversation_state', {
          chat_id: selectKey,
          conversation_type: 'failure_selection',
          data: {
            availableTasks: availableToday,
            allowNewTask: true,
          },
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });

        await ctx.reply(message, { parse_mode: 'Markdown' });
        return;
      }

      // WITH PARAMETERS - Search for matching tasks
      const searchTerm = args.trim().toLowerCase();
      const matchedTasks = availableToday.filter(t =>
        t.content.toLowerCase().includes(searchTerm) ||
        searchTerm.includes(t.content.toLowerCase())
      );

      if (matchedTasks.length === 0) {
        // No matches - store for new task entry
        const newTaskKey = `failure_new_task_${chatId}`;
        await ctx.db.insert('conversation_state', {
          chat_id: newTaskKey,
          conversation_type: 'failure_new_task_input',
          data: { suggestedName: args.trim() },
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });

        await ctx.reply(
          `🔍 لم أجد مهمة تطابق "${args.trim()}"\n\n` +
          `❓ هل تريد تسجيل فشل لمهمة جديدة بهذا الاسم؟\n` +
          `أرسل "نعم" للتأكيد أو /cancel للإلغاء`
        );
        return;
      }

      if (matchedTasks.length === 1) {
        // Exactly one match - show confirmation
        const task = matchedTasks[0]!;
        let message = '📋 **هل تريد تسجيل فشل لهذه المهمة؟**\n\n';
        message += `1. ${task.content}\n`;
        message += `0. ➕ إضافة مهمة جديدة: "${args.trim()}"\n\n`;
        message += `🔢 أرسل 1 لتسجيل الفشل أو 0 لإنشاء مهمة جديدة:`;

        await ctx.db.insert('conversation_state', {
          chat_id: selectKey,
          conversation_type: 'failure_selection',
          data: {
            availableTasks: [task],
            newTaskName: args.trim(),
            allowNewTask: true,
          },
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });

        await ctx.reply(message, { parse_mode: 'Markdown' });
        return;
      }

      // Multiple matches - show list
      let message = '📋 **تم العثور على عدة مهام مطابقة:**\n\n';
      matchedTasks.forEach((t, i) => {
        message += `${i + 1}. ${t.content}\n`;
      });

      message += `\n0. ➕ إضافة مهمة جديدة: "${args.trim()}"\n\n`;
      message += `🔢 أرسل رقم المهمة المطلوبة أو 0 لإنشاء مهمة جديدة:`;

      await ctx.db.insert('conversation_state', {
        chat_id: selectKey,
        conversation_type: 'failure_selection',
        data: {
          availableTasks: matchedTasks,
          newTaskName: args.trim(),
          allowNewTask: true,
        },
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

      await ctx.reply(message, { parse_mode: 'Markdown' });

    } catch (error) {
      console.error('Log failure error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
  });
    await sendAutoStatus(ctx);
});

  // Memory command
  bot.command('memory', async (ctx) => {
    try {
      await ctx.reply('🔄 جاري تحميل الذاكرة...');

      const openRouterKey = await ctx.settings.get('openrouter_api_key');
      const aiModel = await getAIModelByTier(ctx.settings, 'low');

      if (!openRouterKey) {
        // Fallback: show raw memory if no AI key
        const memory = await ctx.db.select('memory', {});

        if (memory.length === 0) {
          await ctx.reply('📝 الذاكرة فارغة حالياً');
          return;
        }

        let message = '🧠 *الذاكرة المنظمة*\n\n';
        for (const item of memory) {
          message += `*${item.category}:*\n`;
          const content = item.content || '_فارغ_';
          message += `${content.substring(0, 300)}${content.length > 300 ? '...' : ''}\n\n`;
        }

        await sendLongMessage(ctx, message);
        return;
      }

      const aiClient = createAIClient(openRouterKey, aiModel);
      const memoryMgr = createMemoryManager(ctx.db, aiClient);

      const formattedMemory = await memoryMgr.getFormattedMemory();
      await sendLongMessage(ctx, formattedMemory);

    } catch (error) {
      console.error('Memory command error:', error);
      await ctx.reply('❌ حدث خطأ أثناء تحميل الذاكرة');
    }
    await sendAutoStatus(ctx);
  });

 // Clear memory command
bot.command('clearmemory', async (ctx) => {
  try {
    const chatId = ctx.chat?.id.toString() || '';
    
    // Store pending confirmation state
    await ctx.db.insert('conversation_state', {
      chat_id: `clearmemory_confirm_${chatId}`,
      conversation_type: 'clearmemory_confirmation',
      current_step: 0,
      total_steps: 1,
      data: {},
      expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 minutes
    });
    
    await ctx.reply(
      '⚠️ *تحذير*\n\n' +
      'هل أنت متأكد من رغبتك في مسح كل الذاكرة؟\n' +
      'هذا الإجراء لا يمكن التراجع عنه.\n\n' +
      'أرسل "نعم" للتأكيد أو "لا" للإلغاء',
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Clearmemory command error:', error);
    await ctx.reply('❌ حدث خطأ. حاول مرة أخرى.');
  }
    await sendAutoStatus(ctx);
});

  // ============================================
  // Debug & Configuration Commands
  // ============================================

  // Toggle debug mode
  bot.command('debug', async (ctx) => {
    try {
      const currentMode = await ctx.settings.get('debugger_mode');
      const isEnabled = currentMode === 'true';

      // Toggle the mode
      const newMode = isEnabled ? 'false' : 'true';
      await ctx.settings.set('debugger_mode', newMode);

      if (newMode === 'true') {
        await ctx.reply(
          '🐛 **وضع التصحيح مفعّل**\n\n' +
          '• سيتم إرسال تفاصيل طلبات AI إلى قناة التصحيح\n' +
          '• سيتم عرض حالة النظام بعد كل أمر\n' +
          '• لإيقاف: /debug',
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(
          '✅ **تم إيقاف وضع التصحيح**\n\n' +
          'لن يتم إرسال تفاصيل إضافية.\n' +
          'لتفعيل: /debug',
          { parse_mode: 'Markdown' }
        );
      }
    } catch (error) {
      console.error('Debug command error:', error);
      await ctx.reply('❌ حدث خطأ أثناء تغيير وضع التصحيح');
    }
  });

  // Set AI model
  bot.command('setmodel', async (ctx) => {
    try {
      const args = ctx.message?.text?.split(' ').slice(1).join(' ') || '';
      const currentModel = await getAIModelByTier(ctx.settings, 'low');

      if (!args.trim()) {
        // Show available models and current setting
        await ctx.reply(
          `🤖 **إعداد نموذج الذكاء الاصطناعي**\n\n` +
          `📌 النموذج الحالي: \`${currentModel}\`\n\n` +
          `**النماذج المتاحة:**\n` +
          `• \`anthropic/claude-sonnet-4\` (موصى به)\n` +
          `• \`anthropic/claude-3.5-sonnet\`\n` +
          `• \`anthropic/claude-3-haiku\` (أسرع)\n` +
          `• \`openai/gpt-4o\`\n` +
          `• \`openai/gpt-4o-mini\`\n` +
          `• \`google/gemini-pro-1.5\`\n\n` +
          `**الاستخدام:**\n` +
          `/setmodel <model_name>\n\n` +
          `**مثال:**\n` +
          `/setmodel anthropic/claude-sonnet-4`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Set the new model
      const newModel = args.trim();
      await ctx.settings.set('ai_model', newModel);

      await ctx.reply(
        `✅ **تم تغيير النموذج**\n\n` +
        `📌 النموذج الجديد: \`${newModel}\`\n\n` +
        `سيتم استخدام هذا النموذج في جميع طلبات AI القادمة.`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Setmodel command error:', error);
      await ctx.reply('❌ حدث خطأ أثناء تغيير النموذج');
    }
  });

  // NEW: /today command - Quick view of today's progress
  bot.command('today', async (ctx) => {
    try {
      await ctx.reply('🔄 جاري المزامنة وإعداد ملخص اليوم...');

      // Pre-sync with Todoist before displaying data
      const today = getTodayInEgypt();
      try {
        await syncFailuresFromTodoist(today, ctx.db, ctx.settings);
      } catch (syncError) {
        console.error('Pre-sync warning:', syncError);
        // Continue even if sync fails
      }

      const reportGen = createReportGenerator(ctx.db, ctx.settings);
      const preview = await reportGen.generatePreview();
      await sendLongMessage(ctx, preview.formatted_text);
    } catch (error) {
      console.error('Today command error:', error);
      await ctx.reply('❌ حدث خطأ أثناء إعداد الملخص');
    }
    await sendAutoStatus(ctx);
  });

  // NEW: /report command - Get report for specific date (fetches saved report if exists)
  bot.command('report', async (ctx) => {
    try {
      const args = ctx.message?.text?.split(' ').slice(1) || [];
      const chatId = ctx.chat?.id.toString() || '';

      if (args.length === 0) {
        await ctx.reply(
          '📅 استخدام الأمر:\n' +
          '/report YYYY-MM-DD\n\n' +
          'مثال: /report 2026-01-15'
        );
        return;
      }

      const dateStr = args[0] || '';

      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        await ctx.reply('❌ صيغة التاريخ غير صحيحة. استخدم: YYYY-MM-DD');
        return;
      }

      await ctx.reply(`🔄 جاري تحميل تقرير ${dateStr}...`);

      // ✅ FIRST: Check if a saved report exists in database
      const savedReports = await ctx.db.select<{
        report_date: string;
        report_markdown: string;
        success_rate: number;
        total_tasks: number;
        completed_tasks: number;
        failed_tasks: number;
        achievement_time_minutes: number;
        challenge_evaluation: string;
        ai_commentary: string;
        suggested_reward: string;
        weekly_goals_analysis: string;
        user_comments: string;
      }>('daily_reports', {
        filter: { report_date: op.eq(dateStr) },
        limit: 1
      });

      if (savedReports.length > 0 && savedReports[0]) {
        const saved = savedReports[0];

        // ✅ Display saved report with AI analysis
        let reportMessage = `📊 تقرير ${dateStr} (محفوظ)\n`;
        reportMessage += '═══════════════════════\n\n';

        // Stats
        reportMessage += `📈 معدل النجاح: ${saved.success_rate}%\n`;
        reportMessage += `✅ مهام منجزة: ${saved.completed_tasks}/${saved.total_tasks}\n`;
        reportMessage += `❌ مهام فاشلة: ${saved.failed_tasks}\n`;
        if (saved.achievement_time_minutes > 0) {
          const hours = Math.floor(saved.achievement_time_minutes / 60);
          const mins = saved.achievement_time_minutes % 60;
          reportMessage += `⏱️ وقت الإنجاز: ${hours > 0 ? hours + ' ساعة ' : ''}${mins} دقيقة\n`;
        }
        reportMessage += '\n';

        // Challenge evaluation
        if (saved.challenge_evaluation) {
          reportMessage += `🎯 التحدي اليومي: ${saved.challenge_evaluation}\n\n`;
        }

        // Full report markdown (tasks breakdown)
        if (saved.report_markdown && saved.report_markdown !== saved.ai_commentary) {
          reportMessage += '📋 تفاصيل المهام:\n';
          reportMessage += '─────────────────────\n';
          reportMessage += saved.report_markdown + '\n\n';
        }

        // AI Commentary
        if (saved.ai_commentary) {
          reportMessage += '🤖 تعليق الذكاء الاصطناعي:\n';
          reportMessage += '─────────────────────\n';
          reportMessage += saved.ai_commentary + '\n\n';
        }

        // Weekly goals analysis
        if (saved.weekly_goals_analysis) {
          try {
            const goalsAnalysis = JSON.parse(saved.weekly_goals_analysis);
            if (goalsAnalysis.completed?.length || goalsAnalysis.inProgress?.length || goalsAnalysis.neglected?.length) {
              reportMessage += '🎯 تحليل الأهداف الأسبوعية:\n';
              reportMessage += '─────────────────────\n';
              if (goalsAnalysis.completed?.length) {
                reportMessage += `✅ منجزة: ${goalsAnalysis.completed.join('، ')}\n`;
              }
              if (goalsAnalysis.inProgress?.length) {
                reportMessage += `🔄 قيد التنفيذ: ${goalsAnalysis.inProgress.join('، ')}\n`;
              }
              if (goalsAnalysis.neglected?.length) {
                reportMessage += `⚠️ مهملة: ${goalsAnalysis.neglected.join('، ')}\n`;
              }
              reportMessage += '\n';
            }
          } catch (e) { /* ignore parse errors */ }
        }

        // Suggested reward
        if (saved.suggested_reward) {
          reportMessage += `🎁 المكافأة المقترحة: ${saved.suggested_reward}\n\n`;
        }

        // User comments/journal
        if (saved.user_comments) {
          reportMessage += '📝 ملاحظات وتعليقات:\n';
          reportMessage += '─────────────────────\n';
          reportMessage += saved.user_comments + '\n';
        }

        await sendLongMessage(ctx, reportMessage);
        await ctx.reply('✅ هذا تقرير محفوظ مسبقاً مع التحليل الكامل.');

      } else {
        // ✅ No saved report - generate preview and offer to analyze
        const reportGen = createReportGenerator(ctx.db, ctx.settings);
        const preview = await reportGen.generatePreview(dateStr);

        // Save target date for /confirm to use
        const pendingReportKey = `pending_report_${chatId}`;
        try {
          await ctx.db.delete('conversation_state', { chat_id: op.eq(pendingReportKey) });
        } catch (e) { /* ignore */ }
        await ctx.db.insert('conversation_state', {
          chat_id: pendingReportKey,
          conversation_type: 'pending_report_date',
          data: { targetDate: dateStr },
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });

        await sendLongMessage(ctx, preview.formatted_text);

        await ctx.reply(
          '─────────────────────\n' +
          `📝 هذا ملخص تاريخ ${dateStr} (غير محلل بعد)\n\n` +
          '🤖 لتحليل مفصل بالذكاء الاصطناعي وحفظ التقرير، استخدم:\n' +
          '/confirm\n\n' +
          '💡 التحليل يشمل: تعليق شخصي، تحديث الذاكرة، تقييم التحدي، واقتراح مكافأة'
        );
      }

    } catch (error) {
      console.error('Report command error:', error);
      await ctx.reply('❌ حدث خطأ أثناء تحميل التقرير');
    }
    await sendAutoStatus(ctx);
  });

  // NEW: /lastupdate command - Show system status
  bot.command('lastupdate', async (ctx) => {
    try {
      const { getTodayInEgypt } = await import('../utils/timezone');
      const today = getTodayInEgypt();

      // Get today's task count
      const reportGen = createReportGenerator(ctx.db, ctx.settings);
      const data = await reportGen.collectReportData(today);

      // Get last report date
      const reports = await ctx.db.select('daily_reports', {
        order: 'report_date.desc',
        limit: 1,
      });
      const lastReportDate = reports.length > 0 ? reports[0].report_date : 'لا يوجد';

      // Get streak count
      const streaks = await ctx.db.select('streaks', {});
      const activeStreaks = streaks.filter((s: any) => s.current_streak > 0).length;

      // Get memory status
      const memory = await ctx.db.select('memory', {});
      const memoryCategories = memory.length;

      const statusMessage = `
📊 **حالة النظام**

📅 تاريخ اليوم (مصر): ${today}
🕐 الوقت الحالي: ${new Date().toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo' })}

📋 **مهام اليوم:**
- مكتملة: ${data.tasks.length}
- فاشلة: ${data.failedTasksJson?.failed_tasks.length || 0}

📈 **الإحصائيات:**
- آخر تقرير: ${lastReportDate}
- سلاسل نشطة: ${activeStreaks}
- فئات الذاكرة: ${memoryCategories}/6

✅ النظام يعمل بشكل طبيعي
      `.trim();

      await ctx.reply(statusMessage, { parse_mode: 'Markdown' });

    } catch (error) {
      console.error('Lastupdate command error:', error);
      await ctx.reply('❌ حدث خطأ أثناء جلب حالة النظام');
    }
    await sendAutoStatus(ctx);
  });

  // ============================================
  // Journal Commands
  // ============================================

  // Journal start command
  bot.command('journalstart', async (ctx) => {
    console.log('📔 /journalstart command received');
    await ctx.reply('🔄 جاري بدء الجلسة...');
    try {
      console.log('Creating journal manager...');
      const journalMgr = createJournalManager(ctx.db);
      console.log('Starting session...');
      const result = await journalMgr.startSession();
      console.log('Session result:', result);
      await ctx.reply(result.message);
    } catch (error) {
      console.error('Journal start error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
  });

  // Also register with underscore for backwards compatibility
  bot.command('journal_start', async (ctx) => {
    console.log('📔 /journal_start command received');
    await ctx.reply('🔄 جاري بدء الجلسة...');
    try {
      const journalMgr = createJournalManager(ctx.db);
      const result = await journalMgr.startSession();
      await ctx.reply(result.message);
    } catch (error) {
      console.error('Journal start error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
  });

  // Journal end command
  bot.command(['journal_end', 'journalend'], async (ctx) => {
    await ctx.reply('🔄 جاري إنهاء الجلسة...');
    try {
      const journalMgr = createJournalManager(ctx.db);
      const result = await journalMgr.endSession();
      await ctx.reply(result.message);
    } catch (error) {
      console.error('Journal end error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
    await sendAutoStatus(ctx);
  });

  // Journal resume command
  bot.command(['journal_resume', 'journalresume'], async (ctx) => {
    await ctx.reply('🔄 جاري استئناف الجلسة...');
    try {
      const journalMgr = createJournalManager(ctx.db);
      const result = await journalMgr.resumeSession();
      await ctx.reply(result.message);
    } catch (error) {
      console.error('Journal resume error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
  });

  // View journal entries for a date
  bot.command('journal', async (ctx) => {
    try {
      const args = ctx.message?.text?.split(' ').slice(1) || [];
      const dateStr = args[0] || getTodayInEgypt();

      // Validate date format if provided
      if (args[0] && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        await ctx.reply('❌ صيغة التاريخ غير صحيحة. استخدم: YYYY-MM-DD\nمثال: /journal 2026-01-16');
        return;
      }

      await ctx.reply(`🔄 جاري تحميل يوميات ${dateStr}...`);

      const journalMgr = createJournalManager(ctx.db);
      const formatted = await journalMgr.getFormattedJournalWithMedia(dateStr);

      if (!formatted) {
        await ctx.reply(`📔 لا توجد يوميات لتاريخ ${dateStr}`);
        return;
      }

      await sendLongMessage(ctx, formatted);
    } catch (error) {
      console.error('Journal view error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
    await sendAutoStatus(ctx);
  });

  // ============================================
  // Task Timer Commands
  // ============================================

  // Start tracking a task (finds existing Todoist task)
bot.command(['starttask', 'start_task'], async (ctx) => {
  try {
    const args = ctx.message?.text?.split(' ').slice(1).join(' ') || '';
    const chatId = ctx.chat?.id.toString() || '';
    const taskKey = `active_task_${chatId}`;

    // Check if there's already an active task
    const existingActiveTask = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(taskKey) },
    });

    if (existingActiveTask.length > 0) {
      const existing = existingActiveTask[0] as any;
      const taskData = existing.data || {};
      await ctx.reply(
        `⚠️ لديك مهمة نشطة بالفعل:\n📌 ${taskData.taskName}\n\n` +
        `استخدم /completetask لإكمالها أو /canceltask لإلغائها`
      );
      return;
    }

    // Get Todoist token
    const todoistToken = await ctx.settings.get('todoist_api_token');
    
    if (!todoistToken) {
      await ctx.reply('❌ Todoist API token غير مكون');
      return;
    }

// Get Todoist project ID
    const todoistProjectId = await ctx.settings.get('todoist_project_id');
    
    console.log('🔍 DEBUG - Todoist Token length:', todoistToken?.length);
    console.log('🔍 DEBUG - Todoist Token starts with:', todoistToken?.substring(0, 10));
    console.log('🔍 DEBUG - Project ID:', todoistProjectId);
    console.log('🔍 DEBUG - Project ID length:', todoistProjectId?.length);
    
    if (!todoistProjectId) {
      await ctx.reply('❌ Todoist Project ID غير مكون في الإعدادات');
      return;
    }

    // Get available tasks (due today or overdue)
    const { getTodayInEgypt } = await import('../utils/timezone');
    const today = getTodayInEgypt();
    const todayDate = new Date(today + 'T00:00:00Z');

    const url = `https://api.todoist.com/rest/v3/tasks?project_id=${todoistProjectId.trim()}`;
    console.log('🔍 DEBUG - Full URL:', url);

    const response = await fetch(url, {
      headers: { 
        'Authorization': `Bearer ${todoistToken.trim()}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('🔍 DEBUG - Response status:', response.status);
    console.log('🔍 DEBUG - Response headers:', JSON.stringify(Object.fromEntries(response.headers.entries())));

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Todoist API error:', response.status, errorText);
      await ctx.reply(
        `❌ فشل الاتصال بـ Todoist (${response.status})\n` +
        `URL: ${url}\n` +
        `Token length: ${todoistToken.length}\n` +
        `Project ID: ${todoistProjectId}\n` +
        `Error: ${errorText.substring(0, 200)}`
      );
      return;
    }
    const allTasks = await response.json() as Array<{ 
      id: string; 
      content: string; 
      due?: { date: string };
      is_completed?: boolean;
    }>;

    // Filter to tasks available today (due today or overdue, not completed)
   const availableToday = allTasks.filter(t => {
     if (t.is_completed) return false;
     if (!t.due?.date) return true; // Tasks without due date
     
     const dueDateStr = t.due.date.split('T')[0];
     if (!dueDateStr) return false;
     
     const taskDueDate = new Date(dueDateStr + 'T00:00:00Z');
     return taskDueDate <= todayDate;
   });

   // Count tasks by due status for context
   const todayTasks = availableToday.filter(t => {
     if (!t.due?.date) return false;
     const dueDateStr = t.due.date.split('T')[0];
     return dueDateStr === today;
   });
   const overdueTasks = availableToday.filter(t => {
     if (!t.due?.date) return false;
     const dueDateStr = t.due.date.split('T')[0];
     if (!dueDateStr) return false;
     return new Date(dueDateStr) < todayDate;
   });
   const noDueDateTasks = availableToday.filter(t => !t.due?.date);

   // NO PARAMETERS - Show list of all available tasks
   if (!args.trim()) {
     if (availableToday.length === 0) {
       await ctx.reply(
         '📋 لا توجد مهام متاحة اليوم في Todoist.\n\n' +
         '📝 يمكنك كتابة اسم مهمة جديدة:\n' +
         '/starttask [اسم المهمة]'
       );
       return;
     }

     // Show list with context header
     let message = '📋 **المهام المتاحة:**\n';
     message += `📅 اليوم: ${todayTasks.length} | ⚠️ متأخرة: ${overdueTasks.length} | 📌 بدون موعد: ${noDueDateTasks.length}\n\n`;
     
     availableToday.forEach((t, i) => {
       message += `${i + 1}. ${t.content}\n`;
     });
     
     message += `\n0. ➕ إضافة مهمة جديدة\n\n`;
     message += `🔢 أرسل رقم المهمة أو اسم المهمة الجديدة:`;

      // Store available tasks for selection
      const selectKey = `task_select_${chatId}`;
      await ctx.db.insert('conversation_state', {
        chat_id: selectKey,
        conversation_type: 'task_selection',
        data: {
          availableTasks: availableToday,
          allowNewTask: true,
        },
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

      await ctx.reply(message, { parse_mode: 'Markdown' });
      return;
    }

    // WITH PARAMETERS - Search for matching tasks
    const searchTerm = args.trim().toLowerCase();
    const matchedTasks = availableToday.filter(t =>
      t.content.toLowerCase().includes(searchTerm) ||
      searchTerm.includes(t.content.toLowerCase())
    );

    if (matchedTasks.length === 0) {
      // No matches - ask if they want to create new task
      await ctx.reply(
        `🔍 لم أجد مهمة تطابق "${args.trim()}"\n\n` +
        `هل تريد إنشاء مهمة جديدة بهذا الاسم؟\n` +
        `أرسل "نعم" للتأكيد أو /cancel للإلغاء`
      );

      // Store for confirmation
      const confirmKey = `task_create_confirm_${chatId}`;
      await ctx.db.insert('conversation_state', {
        chat_id: confirmKey,
        conversation_type: 'task_create_confirm',
        data: { taskName: args.trim() },
        expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      });
      return;
    }

    if (matchedTasks.length === 1) {
     // Exactly one match - show confirmation with this task + "Add new task"
     const task = matchedTasks[0]!;
     let message = '📋 **هل تريد تتبع هذه المهمة؟**\n\n';
     message += `1. ${task.content}\n`;
      message += `0. ➕ إضافة مهمة جديدة: "${args.trim()}"\n\n`;
      message += `🔢 أرسل 1 لتتبع المهمة أو 0 لإنشاء مهمة جديدة:`;

      // Store for selection
      const selectKey = `task_select_${chatId}`;
      await ctx.db.insert('conversation_state', {
        chat_id: selectKey,
        conversation_type: 'task_selection',
        data: {
          matchedTasks: [task],
          newTaskName: args.trim(),
          allowNewTask: true,
        },
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

      await ctx.reply(message, { parse_mode: 'Markdown' });
      return;
    }

   // Multiple matches - show list with "Add new task" option
   let message = '📋 **تم العثور على عدة مهام مطابقة:**\n\n';
   matchedTasks.forEach((t, i) => {
     message += `${i + 1}. ${t.content}\n`;
   });
    
    message += `\n0. ➕ إضافة مهمة جديدة: "${args.trim()}"\n\n`;
    message += `🔢 أرسل رقم المهمة المطلوبة أو 0 لإنشاء مهمة جديدة:`;

    // Store matched tasks for selection
    const selectKey = `task_select_${chatId}`;
    await ctx.db.insert('conversation_state', {
      chat_id: selectKey,
      conversation_type: 'task_selection',
      data: {
        matchedTasks: matchedTasks,
        newTaskName: args.trim(),
        allowNewTask: true,
      },
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    await ctx.reply(message, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Start task error:', error);
    await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
  }
    await sendAutoStatus(ctx);
});

  // ============================================
// 1. Add Duration Command (before completion)
// ============================================
bot.command(['addduration', 'add_duration'], async (ctx) => {
  try {
    const chatId = ctx.chat?.id.toString() || '';
    const taskKey = `active_task_${chatId}`;
    const args = ctx.message?.text?.split(' ').slice(1).join(' ') || '';

    // Get active task
    const existingTask = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(taskKey) },
    });

    if (existingTask.length === 0) {
      await ctx.reply('❌ لا توجد مهمة نشطة.\nاستخدم /starttask لبدء مهمة جديدة');
      return;
    }

    const taskData = (existingTask[0] as any).data || {};

    // If no args, prompt for duration
    if (!args.trim()) {
      await ctx.reply(
        '⏱️ **إضافة مدة زمنية**\n\n' +
        `📌 المهمة: ${taskData.taskName}\n\n` +
        'أرسل المدة بأحد الصيغ التالية:\n' +
        '• 30m (30 دقيقة)\n' +
        '• 2h (ساعتان)\n' +
        '• 1.5h (ساعة ونصف)\n' +
        '• 30د (30 دقيقة بالعربي)\n' +
        '• 2س (ساعتان بالعربي)\n\n' +
        'أو /cancel للإلغاء',
        { parse_mode: 'Markdown' }
      );

      // Store pending state
      await ctx.db.insert('conversation_state', {
        chat_id: `pending_duration_${chatId}`,
        conversation_type: 'pending_duration',
        data: {},
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      return;
    }

    // Parse duration from args
    const { parseTaskMetadata } = await import('../utils/task-parser');
    const metadata = parseTaskMetadata(`[${args}]`);

    if (!metadata.duration_minutes) {
      await ctx.reply('❌ صيغة المدة غير صحيحة. أمثلة: 30m، 2h، 1.5h، 30د، 2س');
      return;
    }

    // Update task with manual duration
    await ctx.db.update(
      'conversation_state',
      { chat_id: op.eq(taskKey) },
      {
        data: {
          ...taskData,
          manualDuration: metadata.duration_minutes,
        }
      }
    );

    await ctx.reply(
  `✅ تم إضافة المدة: ${metadata.duration_minutes} دقيقة\n\n` +
  `📌 ${taskData.taskName}\n\n` +
  `**التالي:**\n` +
  `• /addquantity - إضافة كمية\n` +
  `• /completetask - إنهاء المهمة الآن`
);

  } catch (error) {
    console.error('Add duration error:', error);
    await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
  }
});

// ============================================
// 2. Add Quantity Command (before completion)
// ============================================
bot.command(['addquantity', 'add_quantity'], async (ctx) => {
  try {
    const chatId = ctx.chat?.id.toString() || '';
    const taskKey = `active_task_${chatId}`;
    const args = ctx.message?.text?.split(' ').slice(1).join(' ') || '';

    // Get active task
    const existingTask = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(taskKey) },
    });

    if (existingTask.length === 0) {
      await ctx.reply('❌ لا توجد مهمة نشطة.\nاستخدم /starttask لبدء مهمة جديدة');
      return;
    }

    const taskData = (existingTask[0] as any).data || {};

    // If no args, prompt for quantity
    if (!args.trim()) {
      await ctx.reply(
        '📊 **إضافة كمية**\n\n' +
        `📌 المهمة: ${taskData.taskName}\n\n` +
        'أرسل الكمية والوحدة:\n' +
        'أمثلة:\n' +
        '• 20 صفحة\n' +
        '• 5 تمارين\n' +
        '• 10 مهام\n\n' +
        'أو /cancel للإلغاء',
        { parse_mode: 'Markdown' }
      );

      // Store pending state
      await ctx.db.insert('conversation_state', {
        chat_id: `pending_quantity_${chatId}`,
        conversation_type: 'pending_quantity_input',
        data: {},
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      return;
    }

    // Parse quantity: "20 صفحة" -> quantity=20, unit=صفحة
    const quantityMatch = args.match(/^(\d+)\s*(.+)$/);
    if (!quantityMatch || !quantityMatch[1] || !quantityMatch[2]) {
      await ctx.reply('❌ صيغة الكمية غير صحيحة. أمثلة: 20 صفحة، 5 تمارين');
      return;
    }

    const quantity = quantityMatch[1];
    const unit = quantityMatch[2].trim();

    // Update task with manual quantity
    await ctx.db.update(
      'conversation_state',
      { chat_id: op.eq(taskKey) },
      {
        data: {
          ...taskData,
          manualQuantity: quantity,
          manualQuantityUnit: unit,
        }
      }
    );

    await ctx.reply(
  `✅ تم إضافة الكمية: ${quantity} ${unit}\n\n` +
  `📌 ${taskData.taskName}\n\n` +
  `**التالي:**\n` +
  `• /addduration - إضافة مدة\n` +
  `• /completetask - إنهاء المهمة الآن`
);

  } catch (error) {
    console.error('Add quantity error:', error);
    await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
  }
});

// ============================================
// 3. Complete Task Command (IMMEDIATE COMPLETION)
// ============================================
bot.command(['completetask', 'complete_task'], async (ctx) => {
  await withCommandLock(ctx, '/completetask', async () => {
    try {
      const chatId = ctx.chat?.id.toString() || '';
      const taskKey = `active_task_${chatId}`;

      // Get active task
      const existingTask = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(taskKey) },
      });

      if (existingTask.length === 0) {
        await ctx.reply('❌ لا توجد مهمة نشطة.\nاستخدم /starttask لبدء مهمة جديدة');
        return;
      }

      const taskData = (existingTask[0] as any).data || {};
      const startTime = taskData.startTime;
    const taskName = taskData.taskName;
    const todoistTaskId = taskData.todoistTaskId;
    const startDate = taskData.startDate || getTodayInEgypt();
    const manualDuration = taskData.manualDuration; // From /addduration
    const manualQuantity = taskData.manualQuantity; // From /addquantity
    const manualQuantityUnit = taskData.manualQuantityUnit;

    if (!startTime || !taskName) {
      await ctx.reply('❌ بيانات المهمة غير صحيحة');
      await ctx.db.delete('conversation_state', { chat_id: op.eq(taskKey) });
      return;
    }

        // Calculate duration (use manual if set, otherwise calculate)
    let durationMinutes: number;
    if (manualDuration) {
      durationMinutes = manualDuration;
    } else {
      const endTime = Date.now();
      const durationMs = endTime - startTime;
      durationMinutes = Math.round(durationMs / 60000);
    }

    // Import utilities
    const { extractCleanTaskName } = await import('../utils/task-parser');
    const { getEgyptDayBoundaries } = await import('../utils/timezone');

    // ✅ Check if this task was already completed today
    const cleanName = extractCleanTaskName(taskName);
    const { start, end } = getEgyptDayBoundaries(startDate);

    const allTasks = await ctx.db.select('tasks', {});
    const todayTasks = allTasks.filter((t: any) => {
      const taskDate = new Date(t.completed_at);
      return taskDate >= start && taskDate <= end;
    });

    const existingCompletion = todayTasks.find((t: any) => {
      const existingCleanName = extractCleanTaskName(t.content);
      return existingCleanName === cleanName;
    });

    if (existingCompletion) {
      console.log(`🔄 Task already completed today - will replace`);
      await ctx.reply(
        `⚠️ تنبيه: تم إكمال هذه المهمة بالفعل اليوم.\n` +
        `سيتم تحديث البيانات بدلاً من التكرار.`
      );
    }

    // Build task name with metadata
    // Format duration - skip if zero, use clear Arabic format
    let durationStr: string = '';
    if (durationMinutes > 0) {
      if (durationMinutes < 60) {
        durationStr = `${durationMinutes} دقيقة`;
      } else {
        const hours = Math.floor(durationMinutes / 60);
        const mins = durationMinutes % 60;
        if (mins > 0) {
          durationStr = `${hours} ساعة ${mins} دقيقة`;
        } else {
          durationStr = hours === 1 ? 'ساعة' : `${hours} ساعات`;
        }
      }
    }

    // Build final task name - only add duration if > 0
    let updatedTaskName = cleanName;
    if (durationStr) {
      updatedTaskName += ` [${durationStr}]`;
    }
    if (manualQuantity && manualQuantityUnit) {
      updatedTaskName += ` [${manualQuantity} ${manualQuantityUnit}]`;
    }

    // Delete the active task record
    await ctx.db.delete('conversation_state', { chat_id: op.eq(taskKey) });

    // Complete the task in Todoist
    const todoistToken = await ctx.settings.get('todoist_api_token');

    if (todoistToken && todoistTaskId) {
      try {
        // Store pending update - include startDate for midnight boundary handling
        const pendingUpdateKey = `pending_update_${todoistTaskId}`;
        await ctx.db.insert('conversation_state', {
          chat_id: pendingUpdateKey,
          conversation_type: 'pending_task_update',
          data: {
            taskId: todoistTaskId,
            updatedContent: updatedTaskName,
            durationMinutes: durationMinutes,
            createdAt: Date.now(),
            startDate: startDate, // ✅ Include startDate for yesterday task handling
          },
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });

        // Update task content
        const updateResponse = await fetch(`https://api.todoist.com/rest/v3/tasks/${todoistTaskId}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${todoistToken.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: updatedTaskName }),
        });

        if (updateResponse.ok) {
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Complete the task
          await fetch(`https://api.todoist.com/rest/v3/tasks/${todoistTaskId}/close`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
          });

          // ✅ FIX: Check if parent should autocomplete (pass undefined for parent hint - DB lookup as fallback)
          await completeParentInTodoistIfAllDone(
            ctx.db,
            ctx.settings,
            todoistTaskId,
            startDate,
            undefined // No parent hint for /completetask - this is typically a main task
          );

           await ctx.reply(
    `✅ **تم إكمال المهمة!**\n\n` +
    `📌 ${updatedTaskName}\n` +
    `⏱️ المدة: ${durationMinutes} دقيقة\n` +
    `${manualQuantity ? `📊 الكمية: ${manualQuantity} ${manualQuantityUnit}\n` : ''}` +
    `✓ تم التحديث في Todoist\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🚀 **جاهز للمزيد؟**\n` +
    `استخدم /starttask لبدء مهمة جديدة`
  );
        } else {
          throw new Error('Todoist update failed');
        }
      } catch (todoistError) {
        console.error('Todoist error:', todoistError);
        await ctx.reply(
          `✅ **تم إكمال المهمة محلياً!**\n\n` +
          `📌 ${updatedTaskName}\n` +
          `⚠️ فشل التحديث في Todoist\n\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🚀 **جاهز للمزيد؟**\n` +
          `استخدم /starttask لبدء مهمة جديدة`
        );
      }
    } else if (todoistToken && !todoistTaskId) {
      // Create new task
      try {
        const todoistProjectId = await ctx.settings.get('todoist_project_id');
        const createResponse = await fetch('https://api.todoist.com/rest/v3/tasks', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${todoistToken.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: updatedTaskName,
            project_id: todoistProjectId?.trim() || undefined,
          }),
        });

        if (createResponse.ok) {
          const newTask = await createResponse.json() as { id: string };
          await fetch(`https://api.todoist.com/rest/v3/tasks/${newTask.id}/close`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
          });

          await ctx.reply(
            `✅ **تم إكمال المهمة!**\n\n` +
            `📌 ${updatedTaskName}\n` +
            `✓ تم الإنشاء في Todoist\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🚀 **جاهز للمزيد؟**\n` +
            `استخدم /starttask لبدء مهمة جديدة`
          );
        }
      } catch (e) {
        await ctx.reply(
          `✅ **تم إكمال المهمة محلياً!**\n\n` +
          `📌 ${updatedTaskName}\n\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🚀 **جاهز للمزيد؟**\n` +
          `استخدم /starttask لبدء مهمة جديدة`
        );
      }
    } else {
      // No Todoist - save locally
      const completedAt = new Date(`${startDate}T23:59:59+02:00`);
      await ctx.db.insert('tasks', {
        task_id: `timer_${Date.now()}`,
        content: updatedTaskName,
        completed_at: completedAt.toISOString(),
        status: 'done',
        duration_minutes: durationMinutes,
        created_at: new Date().toISOString(),
      });

      await ctx.reply(
        `✅ **تم إكمال المهمة!**\n\n` +
        `📌 ${updatedTaskName}\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🚀 **جاهز للمزيد؟**\n` +
        `استخدم /starttask لبدء مهمة جديدة`
      );
    }

    } catch (error) {
      console.error('Complete task error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
  });
});

  // Cancel the active task
  bot.command(['canceltask', 'cancel_task'], async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';
      const taskKey = `active_task_${chatId}`;

      // Get active task
      const existingTask = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(taskKey) },
      });

      if (existingTask.length === 0) {
        await ctx.reply('❌ لا توجد مهمة نشطة للإلغاء');
        return;
      }

      const taskData = (existingTask[0] as any).data || {};

      // Delete the active task
      await ctx.db.delete('conversation_state', { chat_id: op.eq(taskKey) });

      await ctx.reply(`🚫 تم إلغاء المهمة:\n📌 ${taskData.taskName}\n\nيمكنك المحاولة مرة أخرى لاحقاً`);
    } catch (error) {
      console.error('Cancel task error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
    await sendAutoStatus(ctx);
  });

  // ============================================
  // Goals Commands
  // ============================================

  // View current week's goals
  bot.command('goals', async (ctx) => {
    console.log('🎯 /goals command received');
    await ctx.reply('🔄 جاري جلب الأهداف...');
    try {
      console.log('Getting settings...');
      const openRouterKey = await ctx.settings.get('openrouter_api_key');
      const aiModel = await getAIModelByTier(ctx.settings, 'low');

      if (!openRouterKey) {
        console.log('No OpenRouter key configured');
        await ctx.reply('❌ مفتاح API غير مكون');
        return;
      }

      console.log('Creating AI client and goals manager...');
      const aiClient = createAIClient(openRouterKey.trim(), aiModel);
      const goalsMgr = createGoalsManager(ctx.db, ctx.settings, aiClient);

      console.log('Getting goals summary...');
      const summary = await goalsMgr.getFormattedGoalsSummary();
      console.log('Summary:', summary.substring(0, 100));
      await sendLongMessage(ctx, summary);
    } catch (error) {
      console.error('Goals command error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
    await sendAutoStatus(ctx);
  });

  // Generate new weekly goals (typically run on Friday)
// Uses waitUntil for background processing to avoid webhook timeout
bot.command(['generate_goals', 'generategoals'], async (ctx) => {
  const updateId = ctx.update.update_id;
  const idempotencyKey = `goals_update_${updateId}`;
  const chatId = ctx.chat?.id.toString() || '';
  const botToken = ctx.env.TELEGRAM_BOT_TOKEN;

  try {
    // Check if this update was already processed (Telegram retry)
    const existing = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(idempotencyKey) },
    });

    if (existing.length > 0) {
      console.log(`⏭️ Skipping duplicate update ${updateId}`);
      return;
    }

    // Mark as processing
    await ctx.db.insert('conversation_state', {
      chat_id: idempotencyKey,
      conversation_type: 'goals_idempotency',
      data: { startedAt: Date.now() },
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    await ctx.reply('🤖 جاري توليد أهداف الأسبوع القادم...\n⏳ قد يستغرق هذا 30-60 ثانية...');

    // Run AI generation in background using waitUntil
    const backgroundTask = (async () => {
      try {
        console.log('📅 [Background] Generating weekly goals');
        
        const openRouterKey = await ctx.settings.get('openrouter_api_key');
        const aiModel = await getAIModelByTier(ctx.settings, 'low');

        if (!openRouterKey) {
          await sendTelegramMessageDirect(botToken, chatId, '❌ مفتاح API غير مكون');
          return;
        }

        const aiClient = createAIClient(openRouterKey.trim(), aiModel);
        const goalsMgr = createGoalsManager(ctx.db, ctx.settings, aiClient);

        console.log('🎯 Calling generateWeeklyGoals...');
        const result = await goalsMgr.generateWeeklyGoals();
        console.log('✅ Goals generated:', result.success);

        if (result.success) {
          let message = '✅ **تم توليد أهداف الأسبوع القادم!**\n\n';

          if (result.evaluationText) {
            message += `📊 **تقييم الأسبوع الماضي:**\n${result.evaluationText}\n\n`;
          }

          message += '🎯 **الأهداف الجديدة:**\n';
          message += result.weeklyGoals?.goals_text || '';

          if (result.dailyChallenges && result.dailyChallenges.length > 0) {
            message += '\n\n⚡ **التحديات اليومية:**\n';
            for (const challenge of result.dailyChallenges) {
              const date = typeof challenge.challenge_date === 'string'
                ? challenge.challenge_date
                : new Date(challenge.challenge_date).toISOString().split('T')[0];
              message += `• ${date}: ${challenge.challenge_text}\n`;
            }
          }

          // Send via direct Telegram API
          await sendTelegramMessageDirect(botToken, chatId, message);
        } else {
          await sendTelegramMessageDirect(
            botToken,
            chatId,
            `❌ ${result.error || 'حدث خطأ أثناء توليد الأهداف'}`
          );
        }

      } catch (error) {
        console.error('❌ [Background] Goals generation error:', error);
        await sendTelegramMessageDirect(
          botToken,
          chatId,
          '❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown')
        );
      } finally {
        // Clean up idempotency marker
        await ctx.db.delete('conversation_state', { chat_id: op.eq(idempotencyKey) }).catch(() => {});
      }
    })();

    // Use waitUntil if available, otherwise just fire and forget
    if (ctx.executionContext?.waitUntil) {
      ctx.executionContext.waitUntil(backgroundTask);
    } else {
      // Fallback: just await (may timeout on free plan)
      await backgroundTask;
    }

  } catch (error) {
    console.error('Generate goals error:', error);
    await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    await ctx.db.delete('conversation_state', { chat_id: op.eq(idempotencyKey) }).catch(() => {});
  }
});

  // Edit weekly goals
  bot.command(['edit_goals', 'editgoals'], async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';

      // Get current week's goals
      const openRouterKey = await ctx.settings.get('openrouter_api_key');
      const aiModel = await getAIModelByTier(ctx.settings, 'low');
      const aiClient = createAIClient(openRouterKey?.trim() || '', aiModel);
      const goalsMgr = createGoalsManager(ctx.db, ctx.settings, aiClient);

      const goals = await goalsMgr.getCurrentWeekGoals();

      if (!goals) {
        await ctx.reply('❌ لا توجد أهداف أسبوعية حالية.\nاستخدم /generate_goals لتوليد أهداف جديدة.');
        return;
      }

      // Save edit state
      await ctx.db.insert('conversation_state', {
        chat_id: `edit_goals_${chatId}`,
        conversation_type: 'edit_goals',
        data: { weekStartDate: goals.week_start_date },
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minutes
      });

      await ctx.reply(
        '✏️ **تعديل الأهداف الأسبوعية**\n\n' +
        'الأهداف الحالية:\n\n' +
        '```\n' + goals.goals_text + '\n```\n\n' +
        '📝 انسخ النص أعلاه، عدله، وأرسله مرة أخرى.\n' +
        'أو أرسل /cancel للإلغاء.',
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Edit goals error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
    await sendAutoStatus(ctx);
  });

  // Edit weekly challenges
  bot.command(['edit_challenges', 'editchallenges'], async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';

      // Get current week's challenges
      const openRouterKey = await ctx.settings.get('openrouter_api_key');
      const aiModel = await getAIModelByTier(ctx.settings, 'low');
      const aiClient = createAIClient(openRouterKey?.trim() || '', aiModel);
      const goalsMgr = createGoalsManager(ctx.db, ctx.settings, aiClient);

      const currentWeek = goalsMgr.getCurrentWeekRange();
      const challenges = await goalsMgr.getWeekChallenges(currentWeek.weekStartDate, currentWeek.weekEndDate);

      if (challenges.length === 0) {
        await ctx.reply('❌ لا توجد تحديات أسبوعية حالية.\nاستخدم /generate_goals لتوليد أهداف وتحديات جديدة.');
        return;
      }

      // Format challenges for editing
      const arabicDays: Record<number, string> = {
        0: 'الأحد', 1: 'الإثنين', 2: 'الثلاثاء',
        3: 'الأربعاء', 4: 'الخميس', 5: 'الجمعة', 6: 'السبت'
      };

      let challengesText = '';
      for (const challenge of challenges) {
        const dateStr = typeof challenge.challenge_date === 'string'
          ? challenge.challenge_date
          : new Date(challenge.challenge_date).toISOString().split('T')[0];
        const date = new Date(dateStr + 'T12:00:00Z');
        const dayName = arabicDays[date.getDay()] || '';
        challengesText += `${dateStr} (${dayName}): ${challenge.challenge_text}\n`;
      }

      // Save edit state
      await ctx.db.insert('conversation_state', {
        chat_id: `edit_challenges_${chatId}`,
        conversation_type: 'edit_challenges',
        data: { weekStartDate: currentWeek.weekStartDate, weekEndDate: currentWeek.weekEndDate },
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minutes
      });

      await ctx.reply(
        '✏️ **تعديل التحديات الأسبوعية**\n\n' +
        'التحديات الحالية:\n\n' +
        '```\n' + challengesText + '```\n\n' +
        '📝 انسخ النص أعلاه، عدله، وأرسله مرة أخرى.\n' +
        '⚠️ حافظ على نفس التنسيق: YYYY-MM-DD (اليوم): التحدي\n' +
        'أو أرسل /cancel للإلغاء.',
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Edit challenges error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
    await sendAutoStatus(ctx);
  });

  // Create tasks in Todoist from weekly goals
  // Uses Durable Object for background processing (no timeout)
  bot.command(['createtasks', 'create_tasks'], async (ctx) => {
    const chatId = ctx.chat?.id.toString() || '';
    const lockKey = `createtasks_lock_${chatId}`;

    try {
      // Check for existing lock in database
      const existingLock = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(lockKey) },
      });

      if (existingLock.length > 0) {
        const lock = existingLock[0] as any;
        const expiresAt = new Date(lock.expires_at);

        if (expiresAt > new Date()) {
          console.log(`[createtasks] Already processing for chat ${chatId}, skipping`);
          return;
        }
        await ctx.db.delete('conversation_state', { chat_id: op.eq(lockKey) });
      }

      // Create lock (expires in 2 minutes)
      await ctx.db.insert('conversation_state', {
        chat_id: lockKey,
        conversation_type: 'createtasks_lock',
        current_step: 0,
        total_steps: 0,
        data: {},
        expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      });

      // Send immediate response
      await ctx.reply('🔄 جاري إنشاء المهام في Todoist...\n\n⏳ سأرسل لك قائمة المهام عند الانتهاء.');

      // Get settings
      const openRouterKey = await ctx.settings.get('openrouter_api_key');
      const anthropicApiKey = await ctx.settings.get('anthropic_api_key');
      const aiModel = await getAIModelByTier(ctx.settings, 'low');
      const botToken = await ctx.settings.get('telegram_bot_token');

      const hasValidOpenRouterKey = openRouterKey && openRouterKey.trim().startsWith('sk-or-v1-');
      const hasValidAnthropicKey = anthropicApiKey && anthropicApiKey.trim().startsWith('sk-ant-');

      if (!hasValidOpenRouterKey && !hasValidAnthropicKey) {
        await ctx.reply('❌ مفتاح API غير مكون');
        await ctx.db.delete('conversation_state', { chat_id: op.eq(lockKey) });
        return;
      }

      if (!botToken) {
        await ctx.reply('❌ Bot token غير مكون');
        await ctx.db.delete('conversation_state', { chat_id: op.eq(lockKey) });
        return;
      }

      // Use Durable Object for background processing
      const jobId = `createtasks_${Date.now()}`;
      const id = ctx.reportProcessorNamespace.idFromName(jobId);
      const stub = ctx.reportProcessorNamespace.get(id);

      // Store job data in DB for the processor to use (JSONB auto-parses)
      await ctx.db.insert('conversation_state', {
        chat_id: `job_${jobId}`,
        conversation_type: 'createtasks_job',
        current_step: 0,
        total_steps: 0,
        data: {
          chatId,
          lockKey,
          openRouterKey: hasValidOpenRouterKey ? openRouterKey.trim() : null,
          anthropicApiKey: hasValidAnthropicKey ? anthropicApiKey.trim() : null,
          aiModel,
          botToken,
        },
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

      // Start background processing via Durable Object
      console.log(`[createtasks] Starting background job ${jobId} for chat ${chatId}`);

      try {
        const doResponse = await stub.fetch(new Request('https://fake-host/createtasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
        }));
        const doResult = await doResponse.json();
        console.log(`[createtasks] Durable Object response:`, doResult);
      } catch (doError) {
        console.error(`[createtasks] Durable Object call failed:`, doError);
        await ctx.reply('❌ حدث خطأ في بدء المعالجة. حاول مرة أخرى.');
      }

    } catch (error) {
      console.error('Create tasks error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
      try {
        await ctx.db.delete('conversation_state', { chat_id: op.eq(lockKey) });
      } catch (e) { /* ignore */ }
    }
    await sendAutoStatus(ctx);
  });

/**
 * Process a task failure - log to DB and handle Todoist (DO NOT complete)
 * FIXED: For recurring tasks, we DON'T complete them in Todoist
 * We only log the failure locally in our database
 */
async function processTaskFailure(
  ctx: BotContext,
  todoistTaskId: string | null,
  taskName: string,
  due?: { date: string; is_recurring: boolean } | null
): Promise<void> {
  try {
    const today = getTodayInEgypt();
    const { extractCleanTaskName } = await import('../utils/task-parser');

    // ✅ FIXED: Append to daily_failures JSON instead of tasks table
    // Get existing failures for today
    let dailyFailures = await getDailyFailures(ctx.db, today);

    if (!dailyFailures) {
      // Create new daily failures document
      dailyFailures = {
        date: today,
        last_sync: new Date().toISOString(),
        failed_tasks: [],
      };
    }

    // Create the failed task entry - mark as manual so it's preserved during sync
    const failedTask: FailedTask = {
      id: todoistTaskId || `manual_fail_${Date.now()}`,
      content: taskName,
      parent_id: null,
      parent_content: null,
      priority: 1,
      is_subtask: false,
      description: 'Manual failure logged via /log_failure',
      is_manual: true, // ✅ Mark as manual to preserve during Todoist sync
    };

    // Check if task already exists in failures (by clean name)
    const cleanName = extractCleanTaskName(taskName);
    const existingIndex = dailyFailures.failed_tasks.findIndex(f =>
      extractCleanTaskName(f.content) === cleanName
    );

    if (existingIndex >= 0) {
      // Replace existing
      dailyFailures.failed_tasks[existingIndex] = failedTask;
      console.log(`🔄 Updated existing failure: ${taskName}`);
    } else {
      // Add new
      dailyFailures.failed_tasks.push(failedTask);
      console.log(`✅ Added new failure to JSON: ${taskName}`);
    }

    // Update timestamp and save
    dailyFailures.last_sync = new Date().toISOString();
    await upsertDailyFailures(ctx.db, dailyFailures);

    const isRecurring = due?.is_recurring || false;

    // If we have a Todoist task, complete it (this postpones recurring, removes non-recurring)
    // But first mark it so the webhook ignores this completion
    if (todoistTaskId) {
      const todoistToken = await ctx.settings.get('todoist_api_token');
      if (todoistToken) {
        // Store marker so webhook knows to ignore this completion
        const markerKey = `failure_completion_${todoistTaskId}`;
        console.log(`🔒 Creating failure completion marker: ${markerKey}`);

        try {
          // Delete any existing marker first (in case of retry)
          await ctx.db.delete('conversation_state', { chat_id: op.eq(markerKey) }).catch(() => {});

          await ctx.db.insert('conversation_state', {
            chat_id: markerKey,
            conversation_type: 'failure_completion',
            data: { taskId: todoistTaskId, taskName },
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 minutes
          });

          // Small delay to ensure marker is committed before Todoist webhook fires
          await new Promise(resolve => setTimeout(resolve, 300));

          console.log(`✅ Marker created successfully: ${markerKey}`);
        } catch (markerError) {
          console.error('❌ Failed to create failure completion marker:', markerError);
          // Continue anyway - we still want to complete the task
        }

        // Complete the task in Todoist
        const closeResponse = await fetch(
          `https://api.todoist.com/rest/v3/tasks/${todoistTaskId}/close`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
          }
        );

        if (closeResponse.ok) {
          if (isRecurring) {
            await ctx.reply(
              `✅ تم تسجيل الفشل:\n` +
              `❌ ${taskName}\n\n` +
              `🔄 تم تأجيل المهمة للموعد التالي في Todoist\n` +
              `💾 تم تسجيل الفشل في قاعدة البيانات`
            );
          } else {
            await ctx.reply(
              `✅ تم تسجيل الفشل:\n` +
              `❌ ${taskName}\n\n` +
              `🗑️ تم إزالة المهمة من Todoist\n` +
              `💾 تم تسجيل الفشل في قاعدة البيانات`
            );
          }
        } else {
          console.error(`Failed to close task in Todoist: ${closeResponse.status}`);
          await ctx.reply(
            `✅ تم تسجيل الفشل:\n` +
            `❌ ${taskName}\n\n` +
            `⚠️ فشل إغلاق المهمة في Todoist\n` +
            `💾 تم تسجيل الفشل في قاعدة البيانات`
          );
        }
      } else {
        await ctx.reply(
          `✅ تم تسجيل الفشل:\n` +
          `❌ ${taskName}\n\n` +
          `ستظهر في تقرير اليوم`
        );
      }
    } else {
      // No Todoist task (manual entry)
      await ctx.reply(
        `✅ تم تسجيل الفشل:\n` +
        `❌ ${taskName}\n\n` +
        `ستظهر في تقرير اليوم`
      );
    }

  } catch (error) {
    console.error('Error processing task failure:', error);
    await ctx.reply('❌ حدث خطأ أثناء معالجة الفشل: ' + (error instanceof Error ? error.message : 'Unknown'));
  }
}

// ============================================
// PHASE 1: COACH FEATURES
// ============================================

// In-memory rate limiter to prevent loops (resets on deploy)
const coachCommandCooldowns = new Map<string, number>();
const COACH_COOLDOWN_MS = 10000; // 10 second cooldown per command per chat

// Helper: Check idempotency and rate limit for coach commands
async function checkCoachIdempotency(ctx: BotContext, commandName: string): Promise<boolean> {
  const chatId = ctx.chat?.id.toString() || '';
  const updateId = ctx.update.update_id;

  // Rate limit check (in-memory, fast)
  const cooldownKey = `${chatId}_${commandName}`;
  const lastRun = coachCommandCooldowns.get(cooldownKey) || 0;
  const now = Date.now();

  if (now - lastRun < COACH_COOLDOWN_MS) {
    console.log(`🚫 Rate limited: ${commandName} for chat ${chatId}`);
    return false;
  }
  coachCommandCooldowns.set(cooldownKey, now);

  // DB idempotency check
  const idempotencyKey = `coach_${commandName}_${updateId}`;

  try {
    const existing = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(idempotencyKey) },
    });

    if (existing.length > 0) {
      console.log(`⏭️ Skipping duplicate ${commandName} (update ${updateId})`);
      return false;
    }

    // Mark as processing
    await ctx.db.insert('conversation_state', {
      chat_id: idempotencyKey,
      conversation_type: `coach_${commandName}`,
      data: { processing: true },
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    return true;
  } catch (err) {
    console.log(`⚠️ Idempotency check error for ${commandName}:`, err);
    return false; // On error, BLOCK to be safe
  }
}

// /stuck - Real-time intervention for procrastination
bot.command('stuck', async (ctx) => {
  try {
    // Idempotency check
    if (!(await checkCoachIdempotency(ctx, 'stuck'))) return;

    const chatId = ctx.chat?.id.toString() || '';
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;

    // Check if feature is enabled
    const enabled = await ctx.settings.get('interventions.stuck_button');
    if (enabled === 'false') {
      await ctx.reply('⚠️ ميزة زر التدخل معطلة.\n\nللتفعيل: قم بتغيير إعداد interventions.stuck_button إلى true');
      return;
    }

    // Get AI client
    const apiKey = await ctx.settings.get('openrouter_api_key');
    if (!apiKey) {
      await ctx.reply('❌ لم يتم تكوين مفتاح AI. تحقق من الإعدادات.');
      return;
    }

    await ctx.reply('🚨 جاري تحليل الموقف...');

    // Get low-tier model for coaching
    const aiModel = await getAIModelByTier(ctx.settings, 'low');

    // Run in background
    const backgroundTask = (async () => {
      try {
        console.log('🚨 Starting stuck intervention for chat:', chatId);
        const aiClient = createAIClient(apiKey, aiModel);
        console.log('✅ AI client created');
        const stuckHandler = createStuckHandler(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));
        console.log('✅ Stuck handler created, starting intervention...');
        const response = await stuckHandler.startIntervention(chatId);
        console.log('✅ Intervention response generated:', response.substring(0, 100) + '...');
        await sendTelegramMessageDirect(botToken, chatId, response);
        console.log('✅ Response sent to user');
      } catch (error) {
        console.error('❌ Stuck background error:', error);
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        await sendTelegramMessageDirect(botToken, chatId, `❌ حدث خطأ في التحليل:\n${errorMsg}`);
      }
    })();

    if (ctx.executionContext?.waitUntil) {
      ctx.executionContext.waitUntil(backgroundTask);
    } else {
      await backgroundTask;
    }

  } catch (error) {
    console.error('Stuck command error:', error);
    await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
  }
});

// /stuck_continue - Continue with another sprint
bot.command('stuck_continue', async (ctx) => {
  try {
    if (!(await checkCoachIdempotency(ctx, 'stuck_continue'))) return;

    const chatId = ctx.chat?.id.toString() || '';
    const apiKey = await ctx.settings.get('openrouter_api_key');
    if (!apiKey) return;

    const aiModel = await getAIModelByTier(ctx.settings, 'low');
    const aiClient = createAIClient(apiKey, aiModel);
    const stuckHandler = createStuckHandler(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));

    const response = await stuckHandler.handleContinue(chatId);
    await ctx.reply(response, { parse_mode: 'Markdown' });

    // Note: Sprint timer removed - user must manually call /stuck_done or /stuck_defer

  } catch (error) {
    console.error('Stuck continue error:', error);
    await ctx.reply('❌ حدث خطأ');
  }
});

// /stuck_done - Mark as done after sprint
bot.command('stuck_done', async (ctx) => {
  try {
    if (!(await checkCoachIdempotency(ctx, 'stuck_done'))) return;

    const chatId = ctx.chat?.id.toString() || '';
    const apiKey = await ctx.settings.get('openrouter_api_key');
    if (!apiKey) return;

    const aiModel = await getAIModelByTier(ctx.settings, 'low');
    const aiClient = createAIClient(apiKey, aiModel);
    const stuckHandler = createStuckHandler(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));

    const response = await stuckHandler.handleDone(chatId);
    await ctx.reply(response, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Stuck done error:', error);
    await ctx.reply('❌ حدث خطأ');
  }
});

// /stuck_defer - Defer with reason
bot.command('stuck_defer', async (ctx) => {
  try {
    if (!(await checkCoachIdempotency(ctx, 'stuck_defer'))) return;

    const chatId = ctx.chat?.id.toString() || '';
    const reason = ctx.message?.text?.replace('/stuck_defer', '').trim() || undefined;
    const apiKey = await ctx.settings.get('openrouter_api_key');
    if (!apiKey) return;

    const aiModel = await getAIModelByTier(ctx.settings, 'low');
    const aiClient = createAIClient(apiKey, aiModel);
    const stuckHandler = createStuckHandler(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));

    const response = await stuckHandler.handleDefer(chatId, reason);
    await ctx.reply(response, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Stuck defer error:', error);
    await ctx.reply('❌ حدث خطأ');
  }
});

// /battle_mode - Start or check today's battle
bot.command('battle_mode', async (ctx) => {
  try {
    if (!(await checkCoachIdempotency(ctx, 'battle_mode'))) return;

    const chatId = ctx.chat?.id.toString() || '';
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;

    // Check if feature is enabled
    const enabled = await ctx.settings.get('gamification.battle_mode');
    if (enabled === 'false') {
      await ctx.reply('⚠️ وضع المعركة معطل.\n\nللتفعيل: قم بتغيير إعداد gamification.battle_mode إلى true');
      return;
    }

    const apiKey = await ctx.settings.get('openrouter_api_key');
    if (!apiKey) {
      await ctx.reply('❌ لم يتم تكوين مفتاح AI.');
      return;
    }

    await ctx.reply('⚔️ جاري تحضير المعركة...');

    // Get low-tier model for battle mode
    const aiModel = await getAIModelByTier(ctx.settings, 'low');

    // Run in background
    const backgroundTask = (async () => {
      try {
        const aiClient = createAIClient(apiKey, aiModel);
        const battleMode = createBattleMode(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));
        const { message } = await battleMode.startBattle(chatId);
        await sendTelegramMessageDirect(botToken, chatId, message);
      } catch (error) {
        console.error('Battle mode background error:', error);
        await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ في تحضير المعركة');
      }
    })();

    if (ctx.executionContext?.waitUntil) {
      ctx.executionContext.waitUntil(backgroundTask);
    } else {
      await backgroundTask;
    }

  } catch (error) {
    console.error('Battle mode error:', error);
    await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
  }
});

// /battle_status - Check current battle status
bot.command('battle_status', async (ctx) => {
  try {
    if (!(await checkCoachIdempotency(ctx, 'battle_status'))) return;

    const chatId = ctx.chat?.id.toString() || '';
    const apiKey = await ctx.settings.get('openrouter_api_key');
    if (!apiKey) return;

    const aiModel = await getAIModelByTier(ctx.settings, 'low');
    const aiClient = createAIClient(apiKey, aiModel);
    const battleMode = createBattleMode(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));

    const status = await battleMode.getStatus(chatId);
    await ctx.reply(status, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Battle status error:', error);
    await ctx.reply('❌ حدث خطأ');
  }
});

// /roast_me - Get a personalized roast
bot.command('roast_me', async (ctx) => {
  try {
    if (!(await checkCoachIdempotency(ctx, 'roast_me'))) return;

    const chatId = ctx.chat?.id.toString() || '';
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;

    // Check if feature is enabled
    const enabled = await ctx.settings.get('coach.roast_mode');
    if (enabled === 'false') {
      await ctx.reply('⚠️ وضع الإحراق معطل.\n\nللتفعيل: قم بتغيير إعداد coach.roast_mode إلى true');
      return;
    }

    const apiKey = await ctx.settings.get('openrouter_api_key');
    if (!apiKey) {
      await ctx.reply('❌ لم يتم تكوين مفتاح AI.');
      return;
    }

    await ctx.reply('🔥 جاري تحليل أنماط التسويف...');

    // Get low-tier model for roast mode
    const aiModel = await getAIModelByTier(ctx.settings, 'low');

    // Run in background
    const backgroundTask = (async () => {
      try {
        const aiClient = createAIClient(apiKey, aiModel);
        const roastMode = createRoastMode(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));
        const result = await roastMode.generateRoast(chatId);
        await sendTelegramMessageDirect(botToken, chatId, `${result.roast}${result.encouragement}`);
      } catch (error) {
        console.error('Roast background error:', error);
        await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ في التحليل');
      }
    })();

    if (ctx.executionContext?.waitUntil) {
      ctx.executionContext.waitUntil(backgroundTask);
    } else {
      await backgroundTask;
    }

  } catch (error) {
    console.error('Roast mode error:', error);
    await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
  }
});

// /weekly_roast - Get a weekly pattern roast
bot.command('weekly_roast', async (ctx) => {
  try {
    if (!(await checkCoachIdempotency(ctx, 'weekly_roast'))) return;

    const chatId = ctx.chat?.id.toString() || '';
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
    const enabled = await ctx.settings.get('coach.roast_mode');
    if (enabled === 'false') {
      await ctx.reply('⚠️ وضع الإحراق معطل.');
      return;
    }

    const apiKey = await ctx.settings.get('openrouter_api_key');
    if (!apiKey) return;

    await ctx.reply('🔥 جاري تحليل أنماط الأسبوع...');

    // Get low-tier model for roast mode
    const aiModel = await getAIModelByTier(ctx.settings, 'low');

    // Run in background
    const backgroundTask = (async () => {
      try {
        const aiClient = createAIClient(apiKey, aiModel);
        const roastMode = createRoastMode(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));
        const result = await roastMode.weeklyRoast(chatId);
        await sendTelegramMessageDirect(botToken, chatId, `${result.roast}${result.encouragement}`);
      } catch (error) {
        console.error('Weekly roast background error:', error);
        await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ في التحليل');
      }
    })();

    if (ctx.executionContext?.waitUntil) {
      ctx.executionContext.waitUntil(backgroundTask);
    } else {
      await backgroundTask;
    }

  } catch (error) {
    console.error('Weekly roast error:', error);
    await ctx.reply('❌ حدث خطأ');
  }
});

// /coach_check - Manually trigger auto-coach check
bot.command('coach_check', async (ctx) => {
  try {
    if (!(await checkCoachIdempotency(ctx, 'coach_check'))) return;

    const chatId = ctx.chat?.id.toString() || '';
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
    const apiKey = await ctx.settings.get('openrouter_api_key');
    if (!apiKey) {
      await ctx.reply('❌ لم يتم تكوين مفتاح AI.');
      return;
    }

    await ctx.reply('🔍 جاري فحص الحالة...');

    // Get low-tier model for auto-coach
    const aiModel = await getAIModelByTier(ctx.settings, 'low');

    // Run in background
    const backgroundTask = (async () => {
      try {
        const aiClient = createAIClient(apiKey, aiModel);
        const autoCoach = createAutoCoach(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));
        const probeResult = await autoCoach.shouldProbe(chatId);

        if (probeResult.shouldProbe && probeResult.reason !== 'none') {
          const message = await autoCoach.generateProbe(chatId, probeResult.reason);
          await sendTelegramMessageDirect(botToken, chatId, message);
        } else {
          await sendTelegramMessageDirect(botToken, chatId, '✅ لا حاجة للتدخل الآن. كل شيء تمام!');
        }
      } catch (error) {
        console.error('Coach check background error:', error);
        await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ');
      }
    })();

    if (ctx.executionContext?.waitUntil) {
      ctx.executionContext.waitUntil(backgroundTask);
    } else {
      await backgroundTask;
    }

  } catch (error) {
    console.error('Coach check error:', error);
    await ctx.reply('❌ حدث خطأ');
  }
});

// /coach_settings - Show current auto-coach settings (no AI needed, so simpler)
bot.command('coach_settings', async (ctx) => {
  try {
    if (!(await checkCoachIdempotency(ctx, 'coach_settings'))) return;

    const autoCoach = createAutoCoach(ctx.db, ctx.settings, async () => '');
    const config = await autoCoach.getConfig();

    const modeEmoji: Record<string, string> = {
      'off': '⏹️',
      'scheduled': '📅',
      'inactivity': '⏰',
      'hybrid': '🔄',
    };

    const settingsMsg = `⚙️ *إعدادات الكوتش التلقائي*

${modeEmoji[config.mode] || '❓'} الوضع: *${config.mode}*

⏰ عتبة الخمول: *${config.inactivityThresholdHours}* ساعة
😴 فترة النوم: *${config.sleepStart}* - *${config.sleepEnd}*
📅 أوقات الفحص: *${config.scheduledCheckins.join(', ')}*

━━━━━━━━━━━━━━━━
💡 للتعديل، استخدم API الإعدادات:
- coach.auto_mode
- coach.inactivity_threshold_hours
- coach.sleep_start / coach.sleep_end
- coach.scheduled_checkins`;

    await ctx.reply(settingsMsg, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Coach settings error:', error);
    await ctx.reply('❌ حدث خطأ');
  }
});

// /coach_summary - End of day coaching summary
bot.command('coach_summary', async (ctx) => {
  try {
    if (!(await checkCoachIdempotency(ctx, 'coach_summary'))) return;

    const chatId = ctx.chat?.id.toString() || '';
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
    const apiKey = await ctx.settings.get('openrouter_api_key');
    if (!apiKey) return;

    await ctx.reply('📊 جاري تحليل تفاعلات اليوم...');

    // Get low-tier model for auto-coach
    const aiModel = await getAIModelByTier(ctx.settings, 'low');

    // Run in background
    const backgroundTask = (async () => {
      try {
        const aiClient = createAIClient(apiKey, aiModel);
        const autoCoach = createAutoCoach(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));
        const summary = await autoCoach.endOfDaySummary(chatId);
        await sendTelegramMessageDirect(botToken, chatId, `📈 ملخص الكوتشنج اليومي\n\n${summary}`);
      } catch (error) {
        console.error('Coach summary background error:', error);
        await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ في التحليل');
      }
    })();

    if (ctx.executionContext?.waitUntil) {
      ctx.executionContext.waitUntil(backgroundTask);
    } else {
      await backgroundTask;
    }

  } catch (error) {
    console.error('Coach summary error:', error);
    await ctx.reply('❌ حدث خطأ');
  }
});

// /autofail - Manually trigger end-of-day autofail
bot.command('autofail', async (ctx) => {
  try {
    // Idempotency check
    if (!(await checkCoachIdempotency(ctx, 'autofail'))) return;

    const chatId = ctx.chat?.id.toString() || '';
    
    // Quick acknowledgment
    await ctx.reply('🌙 تشغيل Autofail...');

    // Get minimal settings
    const todoistToken = await ctx.settings.get('todoist_api_token');
    const todoistProjectId = await ctx.settings.get('todoist_project_id');
    const priorityThresholdStr = await ctx.settings.get('failure_priority_threshold');
    const priorityThreshold = priorityThresholdStr ? parseInt(priorityThresholdStr, 10) : 2;
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
    
    if (!todoistToken) {
      await ctx.reply('❌ لم يتم تكوين مفتاح Todoist');
      return;
    }

    const today = getTodayInEgypt();

    // ✅ Trigger Durable Object immediately
    const jobId = `autofail_${today}`;
    const id = ctx.reportProcessorNamespace.idFromName(jobId);
    const stub = ctx.reportProcessorNamespace.get(id);

    const jobData = {
      chatId,
      today,
      todoistToken: todoistToken.trim(),
      todoistProjectId: todoistProjectId?.trim(),
      priorityThreshold,
      botToken,
    };

    // Fire and forget - don't wait
    stub.fetch(new Request('https://fake-host/autofail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jobData),
    })).then(() => {
      console.log(`✅ Autofail triggered for ${today}`);
    }).catch(err => {
      console.error('❌ Autofail trigger error:', err);
    });

    // Return immediately
    await ctx.reply(
      '✅ تم التشغيل!\n\n' +
      'المعالجة تتم في الخلفية.\n' +
      'ستصلك إشعارات بالتقدم.'
    );

  } catch (error) {
    console.error('Autofail command error:', error);
    await ctx.reply('❌ حدث خطأ');
  }
});

// ============================================
// END PHASE 1 COACH FEATURES
// ============================================

  // Handle text messages (for Q&A flow, log_failure, task quantity, and journal)
  bot.on('message:text', async (ctx) => {
    try {
      // Ignore messages from bots (including self)
      if (ctx.message?.from?.is_bot) {
        return;
      }

      const chatId = ctx.chat?.id.toString() || '';
      const text = ctx.message?.text || '';

      // Skip if this is a command
      if (text.startsWith('/')) {
        return;
      }

      // Handle stuck intervention responses
      const stuckKey = `stuck_${chatId}`;
      const stuckSession = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(stuckKey) },
        limit: 1,
      });

      if (stuckSession.length > 0) {
        const sessionData = (stuckSession[0] as any).data || {};

        // Only process if awaiting response
        if (sessionData.phase === 'awaiting_response') {
          // Idempotency check for message processing
          const updateId = ctx.update.update_id;
          const msgIdempotencyKey = `stuck_msg_${updateId}`;
          const existingMsg = await ctx.db.select('conversation_state', {
            filter: { chat_id: op.eq(msgIdempotencyKey) },
          });
          if (existingMsg.length > 0) {
            console.log(`⏭️ Skipping duplicate stuck message (update ${updateId})`);
            return;
          }
          await ctx.db.insert('conversation_state', {
            chat_id: msgIdempotencyKey,
            conversation_type: 'stuck_msg_marker',
            data: { processing: true },
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          });

          const apiKey = await ctx.settings.get('openrouter_api_key');
          const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
          if (apiKey) {
            await ctx.reply('⏳ جاري التحليل...');

            // Get low-tier model for stuck handler
            const aiModel = await getAIModelByTier(ctx.settings, 'low');

            // Run in background
            const backgroundTask = (async () => {
              try {
                const aiClient = createAIClient(apiKey, aiModel);
                const stuckHandler = createStuckHandler(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));
                const result = await stuckHandler.processResponse(chatId, text);
                await sendTelegramMessageDirect(botToken, chatId, result.message);
              } catch (error) {
                console.error('Stuck response background error:', error);
                await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ في التحليل');
              }
            })();

            if (ctx.executionContext?.waitUntil) {
              ctx.executionContext.waitUntil(backgroundTask);
            } else {
              await backgroundTask;
            }
            return;
          }
        }
      }

// Handle failure selection
const failureSelectKey = `failure_select_${chatId}`;
const pendingFailureSelect = await ctx.db.select('conversation_state', {
  filter: { chat_id: op.eq(failureSelectKey) },
});

if (pendingFailureSelect.length > 0) {
  const selectionData = (pendingFailureSelect[0] as any).data || {};
  const availableTasks = selectionData.availableTasks as Array<{
    id: string;
    content: string;
    due?: { date: string; is_recurring: boolean };
  }> || [];

  // Delete selection state
  await ctx.db.delete('conversation_state', { chat_id: op.eq(failureSelectKey) });

  // Parse selection
  const selection = parseInt(text.trim(), 10);

  // Check if user wants to add new task (0)
  if (selection === 0) {
    const newTaskName = selectionData.newTaskName;
    if (newTaskName) {
      // User selected "add new task" from matched list - use the search term
      await processTaskFailure(ctx, null, newTaskName, null);
      return;
    }

    await ctx.reply(
      '📝 **إضافة مهمة فاشلة جديدة**\n\n' +
      'أرسل اسم المهمة التي فشلت في إنجازها:\n' +
      'أو /cancel للإلغاء'
    );

    // Store state for new task name input
    await ctx.db.insert('conversation_state', {
      chat_id: `failure_new_task_${chatId}`,
      conversation_type: 'failure_new_task_input',
      data: {},
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    return;
  }

  // Validate selection
  if (isNaN(selection) || selection < 1 || selection > availableTasks.length) {
    await ctx.reply(`❌ أدخل رقماً صحيحاً بين 0 و ${availableTasks.length}`);
    return;
  }

  const selectedTask = availableTasks[selection - 1];
  if (!selectedTask) {
    await ctx.reply('❌ حدث خطأ. حاول مرة أخرى.');
    return;
  }

  // Process the failure
  await processTaskFailure(ctx, selectedTask.id, selectedTask.content, selectedTask.due);
  return;
}

// Handle new failure task name input (or confirmation)
const failureNewTaskKey = `failure_new_task_${chatId}`;
const pendingFailureNewTask = await ctx.db.select('conversation_state', {
  filter: { chat_id: op.eq(failureNewTaskKey) },
});

if (pendingFailureNewTask.length > 0) {
  const failureData = (pendingFailureNewTask[0] as any).data || {};
  const suggestedName = failureData.suggestedName;

  await ctx.db.delete('conversation_state', { chat_id: op.eq(failureNewTaskKey) });

  const lowerText = text.trim().toLowerCase();

  // Check if this is a confirmation for suggested name
  if (suggestedName && (lowerText === 'نعم' || lowerText === 'yes')) {
    // User confirmed the suggested name
    await processTaskFailure(ctx, null, suggestedName, null);
    return;
  }

  // Otherwise use the text as the task name
  const taskName = text.trim();

  if (!taskName || taskName.length === 0) {
    await ctx.reply('⚠️ اسم المهمة مطلوب');
    return;
  }

  // Log as failed task (no Todoist task to postpone/delete)
  await processTaskFailure(ctx, null, taskName, null);
  return;
}

      // Skip if it's a command
      if (text.startsWith('/')) {
        return;
      }

      const conversationMgr = createConversationManager(ctx.db);
      const journalMgr = createJournalManager(ctx.db);

      // ✅ Check for post-analysis Q&A (after AI analysis, before report save)
      const postQAKey = `post_qa_${chatId}`;
      const pendingPostQA = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(postQAKey) },
      });

      if (pendingPostQA.length > 0) {
        const qaData = (pendingPostQA[0] as any).data || {};
        const questions = qaData.questions as string[] || [];
        const answers = qaData.answers as Record<string, string> || {};
        let currentIndex = qaData.currentIndex as number || 0;

        // Save current answer
        const currentQuestion = questions[currentIndex];
        if (currentQuestion) {
          answers[currentQuestion] = text.trim();
        }
        currentIndex++;

        if (currentIndex < questions.length) {
          // More questions - update state and send next question
          await ctx.db.update(
            'conversation_state',
            { chat_id: op.eq(postQAKey) },
            { data: { questions, answers, currentIndex } }
          );

          await ctx.reply(
            `[${currentIndex + 1}/${questions.length}] ❓ ${questions[currentIndex]}`
          );
        } else {
          // All questions answered - finalize report save
          await ctx.db.delete('conversation_state', { chat_id: op.eq(postQAKey) });

          // Get pending report data
          const pendingReportKey = `pending_report_save_${chatId}`;
          const pendingReport = await ctx.db.select('conversation_state', {
            filter: { chat_id: op.eq(pendingReportKey) },
          });

          if (pendingReport.length > 0) {
            const reportState = (pendingReport[0] as any).data || {};
            await ctx.db.delete('conversation_state', { chat_id: op.eq(pendingReportKey) });

            // Combine pre-analysis and post-analysis answers
            const allAnswers = {
              ...reportState.preAnalysisAnswers,
              ...Object.fromEntries(
                Object.entries(answers).map(([q, a]) => [`[متابعة] ${q}`, a])
              ),
            };

            // Save report with all Q&A
            await ctx.reply('💾 جاري حفظ التقرير...');

            await ctx.db.upsert('daily_reports', {
              report_date: reportState.reportDate,
              report_markdown: reportState.formattedReport,
              success_rate: reportState.stats.success_rate,
              total_tasks: reportState.stats.total_tasks,
              completed_tasks: reportState.stats.completed_tasks,
              failed_tasks: reportState.stats.failed_tasks,
              achievement_time_minutes: reportState.stats.total_time_minutes,
              challenge_evaluation: reportState.aiResponse.challengeEvaluation,
              ai_commentary: reportState.aiResponse.mainCommentary,
              suggested_reward: reportState.aiResponse.reward,
              weekly_goals_analysis: JSON.stringify(reportState.aiResponse.goalsAnalysis),
              user_comments: JSON.stringify(allAnswers),
              obsidian_file_id: reportState.aiSummary,
            }, 'report_date');

            await ctx.reply('✅ تم حفظ التقرير بنجاح مع جميع الإجابات!');

            // Update memory (with delays)
            if (reportState.aiResponse.memoryUpdates && Object.keys(reportState.aiResponse.memoryUpdates).length > 0) {
              try {
                const openRouterKey = await ctx.settings.get('openrouter_api_key');
                const aiModel = await getAIModelByTier(ctx.settings, 'low');
                const aiClient = createAIClient(openRouterKey?.trim() || '', aiModel);
                const memoryMgr = createMemoryManager(ctx.db, aiClient);

                for (const [category, content] of Object.entries(reportState.aiResponse.memoryUpdates)) {
                  try {
                    await memoryMgr.updateSingleCategory(category, content as string);
                  } catch (e) {
                    console.error(`Memory update failed for ${category}:`, e);
                  }
                }
              } catch (e) {
                console.error('Memory update error:', e);
              }
            }
          } else {
            await ctx.reply('⚠️ لم يتم العثور على بيانات التقرير المعلق');
          }
        }
        return;
      }

      // Check for pending edit_goals
      const editGoalsKey = `edit_goals_${chatId}`;
      const pendingEditGoals = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(editGoalsKey) },
      });

      if (pendingEditGoals.length > 0) {
        const editData = (pendingEditGoals[0] as any).data || {};
        const weekStartDate = editData.weekStartDate;

        // Delete edit state
        await ctx.db.delete('conversation_state', { chat_id: op.eq(editGoalsKey) });

        // Update goals
        const openRouterKey = await ctx.settings.get('openrouter_api_key');
        const aiModel = await getAIModelByTier(ctx.settings, 'low');
        const aiClient = createAIClient(openRouterKey?.trim() || '', aiModel);
        const goalsMgr = createGoalsManager(ctx.db, ctx.settings, aiClient);

        const success = await goalsMgr.updateWeeklyGoals(weekStartDate, text.trim());

        if (success) {
          await ctx.reply('✅ تم تحديث الأهداف الأسبوعية بنجاح!');
        } else {
          await ctx.reply('❌ فشل تحديث الأهداف. حاول مرة أخرى.');
        }
        return;
      }

      // Check for pending edit_challenges
      const editChallengesKey = `edit_challenges_${chatId}`;
      const pendingEditChallenges = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(editChallengesKey) },
      });

      if (pendingEditChallenges.length > 0) {
        // Delete edit state
        await ctx.db.delete('conversation_state', { chat_id: op.eq(editChallengesKey) });

        // Parse and update challenges
        // Format: YYYY-MM-DD (day): challenge text
        const lines = text.trim().split('\n');
        let updatedCount = 0;

        const openRouterKey = await ctx.settings.get('openrouter_api_key');
        const aiModel = await getAIModelByTier(ctx.settings, 'low');
        const aiClient = createAIClient(openRouterKey?.trim() || '', aiModel);
        const goalsMgr = createGoalsManager(ctx.db, ctx.settings, aiClient);

        for (const line of lines) {
          const match = line.match(/^(\d{4}-\d{2}-\d{2})\s*\([^)]*\):\s*(.+)$/);
          if (match && match[1] && match[2]) {
            const date = match[1];
            const challengeText = match[2].trim();
            const success = await goalsMgr.updateChallenge(date, challengeText);
            if (success) updatedCount++;
          }
        }

        if (updatedCount > 0) {
          await ctx.reply(`✅ تم تحديث ${updatedCount} تحدي(ات) بنجاح!`);
        } else {
          await ctx.reply('❌ لم يتم العثور على تحديات صالحة للتحديث.\nتأكد من التنسيق: YYYY-MM-DD (اليوم): التحدي');
        }
        return;
      }

// Check for pending autofail confirmation
      const autofailKey = `autofail_confirm_${chatId}`;
      const pendingAutofail = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(autofailKey) },
      });

      if (pendingAutofail.length > 0) {
        // Delete confirmation state
        await ctx.db.delete('conversation_state', { chat_id: op.eq(autofailKey) });

        const lowerText = text.trim().toLowerCase();

        if (lowerText === 'نعم' || lowerText === 'yes' || lowerText === 'y') {
          await ctx.reply('🔄 جاري تنفيذ Autofail...');

          const botToken = ctx.env.TELEGRAM_BOT_TOKEN;

          // Run autofail in background
          const backgroundTask = (async () => {
            try {
              const todoistToken = await ctx.settings.get('todoist_api_token');
              const todoistProjectId = await ctx.settings.get('todoist_project_id');
              const priorityThresholdStr = await ctx.settings.get('failure_priority_threshold');
              const priorityThreshold = priorityThresholdStr ? parseInt(priorityThresholdStr, 10) : 2;
              const today = getTodayInEgypt();

              if (!todoistToken) {
                await sendTelegramMessageDirect(botToken, chatId, '❌ لم يتم تكوين مفتاح Todoist');
                return;
              }

              // Get all tasks from Todoist
              const tasksResponse = await fetch('https://api.todoist.com/rest/v3/tasks', {
                headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
              });

              if (!tasksResponse.ok) {
                await sendTelegramMessageDirect(botToken, chatId, '❌ فشل في جلب المهام من Todoist');
                return;
              }

              const allTasks = await tasksResponse.json() as Array<{
                id: string;
                content: string;
                project_id: string;
                priority: number;
                parent_id?: string;
                due?: { date: string; is_recurring?: boolean } | null;
              }>;

              // Filter tasks due today or earlier
              const tasksDueToday = allTasks.filter(task => {
                if (!task.due?.date) return false;
                const dueDate = task.due.date.split('T')[0];
                return dueDate && dueDate <= today;
              });

              // Filter to only main project and priority threshold
              const tasksToFail = tasksDueToday.filter(task => {
                const ourPriority = 5 - (task.priority || 1);
                const isInMainProject = todoistProjectId ? task.project_id === todoistProjectId.trim() : true;
                return isInMainProject && ourPriority <= priorityThreshold;
              });

              if (tasksToFail.length === 0) {
                await sendTelegramMessageDirect(botToken, chatId, '✅ لا توجد مهام للتسجيل كفاشلة!');
                return;
              }

              // Get or create daily failures
              let dailyFailures = await getDailyFailures(ctx.db, today);
              if (!dailyFailures) {
                dailyFailures = {
                  date: today,
                  last_sync: new Date().toISOString(),
                  failed_tasks: [],
                };
              }

              const failedTaskNames: string[] = [];
              const { extractCleanTaskName } = await import('../utils/task-parser');

              for (const task of tasksToFail) {
                try {
                  const cleanName = extractCleanTaskName(task.content);

                  // Check if already in failures
                  const existingIndex = dailyFailures.failed_tasks.findIndex(f =>
                    extractCleanTaskName(f.content) === cleanName
                  );

                  if (existingIndex < 0) {
                    dailyFailures.failed_tasks.push({
                      id: task.id,
                      content: task.content,
                      parent_id: task.parent_id || null,
                      parent_content: null,
                      priority: task.priority,
                      is_subtask: !!task.parent_id,
                      description: 'Manual autofail via /autofail command',
                    });
                  }

                  // Create failure completion marker
                  const markerKey = `failure_completion_${task.id}`;
                  await ctx.db.delete('conversation_state', { chat_id: op.eq(markerKey) }).catch(() => {});
                  await ctx.db.insert('conversation_state', {
                    chat_id: markerKey,
                    conversation_type: 'failure_completion',
                    data: { taskId: task.id, taskName: task.content, autoFail: true },
                    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
                  });

                  // Complete the task in Todoist
                  await fetch(`https://api.todoist.com/rest/v3/tasks/${task.id}/close`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
                  });

                  failedTaskNames.push(cleanName);
                } catch (taskError) {
                  console.error(`❌ Failed to autofail task ${task.id}:`, taskError);
                }
              }

              // Save daily failures
              dailyFailures.last_sync = new Date().toISOString();
              await upsertDailyFailures(ctx.db, dailyFailures);

              // Send completion message
              const message = `🌙 **تم تنفيذ Autofail**\n\n` +
                `عدد المهام: ${failedTaskNames.length}\n\n` +
                failedTaskNames.map(name => `❌ ${name}`).join('\n') +
                `\n\n_تم تأجيل المهام المتكررة للموعد التالي_`;

              await sendTelegramMessageDirect(botToken, chatId, message);
            } catch (error) {
              console.error('Autofail execution error:', error);
              await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ أثناء تنفيذ Autofail');
            }
          })();

          if (ctx.executionContext?.waitUntil) {
            ctx.executionContext.waitUntil(backgroundTask);
          } else {
            await backgroundTask;
          }
        } else {
          await ctx.reply('✅ تم إلغاء Autofail.');
        }
        return;
      }

// Check for pending clearmemory confirmation
      const clearmemoryKey = `clearmemory_confirm_${chatId}`;
      const pendingClearmemory = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(clearmemoryKey) },
      });

      if (pendingClearmemory.length > 0) {
        // Delete confirmation state
        await ctx.db.delete('conversation_state', { chat_id: op.eq(clearmemoryKey) });

        const lowerText = text.trim().toLowerCase();
        
        if (lowerText === 'نعم' || lowerText === 'yes') {
          await ctx.reply('🔄 جاري مسح الذاكرة...');
          
          try {
            const openRouterKey = await ctx.settings.get('openrouter_api_key');
            const aiModel = await getAIModelByTier(ctx.settings, 'low');
            
            if (!openRouterKey) {
              await ctx.reply('❌ مفتاح API غير مكون');
              return;
            }
            
            const aiClient = createAIClient(openRouterKey, aiModel);
            const memoryMgr = createMemoryManager(ctx.db, aiClient);
            
            await memoryMgr.clearAll();
            
            await ctx.reply('✅ تم مسح الذاكرة بنجاح');
          } catch (error) {
            console.error('Memory clear error:', error);
            await ctx.reply('❌ حدث خطأ أثناء مسح الذاكرة');
          }
        } else {
          await ctx.reply('✅ تم إلغاء العملية. الذاكرة لم تُمسح.');
        }
        return;
      }

      // Check for pending task selection (from /starttask)
const selectKey = `task_select_${chatId}`;
const pendingSelection = await ctx.db.select('conversation_state', {
  filter: { chat_id: op.eq(selectKey) },
});

if (pendingSelection.length > 0) {
  const selectionData = (pendingSelection[0] as any).data || {};
  const matchedTasks = selectionData.matchedTasks as Array<{ id: string; content: string }> || [];
  const availableTasks = selectionData.availableTasks as Array<{ id: string; content: string }> || [];
  const newTaskName = selectionData.newTaskName as string;
  const allowNewTask = selectionData.allowNewTask as boolean;

  // Determine which list to use
  const taskList = matchedTasks.length > 0 ? matchedTasks : availableTasks;

  // Parse user selection
  const selection = parseInt(text.trim(), 10);

  // Check if user wants to create new task (0)
  if (selection === 0 && allowNewTask) {
    // Delete selection state
    await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) });

    // Start tracking new task (not in Todoist)
    const taskKey = `active_task_${chatId}`;
    const startDate = getTodayInEgypt();
    
    await ctx.db.insert('conversation_state', {
      chat_id: taskKey,
      conversation_type: 'active_task',
      data: {
        taskName: newTaskName || text.trim(),
        originalSearch: newTaskName || text.trim(),
        todoistTaskId: null, // No Todoist task
        startTime: Date.now(),
        startDate: startDate,
      },
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    const now = new Date();
    const timeStr = now.toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' });

    await ctx.reply(
      `⏱️ بدأ تتبع المهمة:\n📌 ${newTaskName || text.trim()}\n🕐 وقت البدء: ${timeStr}\n\n` +
      `📝 مهمة جديدة (سيتم إنشاؤها في Todoist عند الإكمال)\n\n` +
      `استخدم /completetask عند الانتهاء`
    );
    return;
  }

  // Validate selection number
  if (isNaN(selection) || selection < 1 || selection > taskList.length) {
    await ctx.reply(`❌ أدخل رقماً صحيحاً بين ${allowNewTask ? '0' : '1'} و ${taskList.length}`);
    return;
  }

  const selectedTask = taskList[selection - 1];
  if (!selectedTask) {
    await ctx.reply('❌ حدث خطأ. حاول مرة أخرى.');
    await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) });
    return;
  }

  // Delete selection state
  await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) });

  // Save the active task with Todoist ID
  const taskKey = `active_task_${chatId}`;
  const startDate = getTodayInEgypt();
  
  await ctx.db.insert('conversation_state', {
    chat_id: taskKey,
    conversation_type: 'active_task',
    data: {
      taskName: selectedTask.content,
      originalSearch: selectionData.originalSearch || '',
      todoistTaskId: selectedTask.id,
      startTime: Date.now(),
      startDate: startDate,
    },
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  const now = new Date();
  const timeStr = now.toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' });

  await ctx.reply(
  `⏱️ **بدأ تتبع المهمة**\n\n` +
  `📌 ${selectedTask.content}\n` +
  `🕐 البداية: ${timeStr}\n\n` +
  `━━━━━━━━━━━━━━━━━━\n` +
  `**أوامر مفيدة:**\n` +
  `• /addduration - إضافة مدة يدوياً\n` +
  `• /addquantity - إضافة كمية\n` +
  `• /completetask - إنهاء المهمة\n` +
  `• /canceltask - إلغاء المهمة`
);
  return;
}

// Also handle task create confirmation
const confirmKey = `task_create_confirm_${chatId}`;
const pendingConfirm = await ctx.db.select('conversation_state', {
  filter: { chat_id: op.eq(confirmKey) },
});

if (pendingConfirm.length > 0) {
  const confirmData = (pendingConfirm[0] as any).data || {};
  const taskName = confirmData.taskName;

  // Delete confirmation state
  await ctx.db.delete('conversation_state', { chat_id: op.eq(confirmKey) });

  const lowerText = text.trim().toLowerCase();
  
  if (lowerText === 'نعم' || lowerText === 'yes') {
    // Start tracking new task
    const taskKey = `active_task_${chatId}`;
    const startDate = getTodayInEgypt();
    
    await ctx.db.insert('conversation_state', {
      chat_id: taskKey,
      conversation_type: 'active_task',
      data: {
        taskName: taskName,
        originalSearch: taskName,
        todoistTaskId: null,
        startTime: Date.now(),
        startDate: startDate,
      },
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    const now = new Date();
    const timeStr = now.toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' });

    await ctx.reply(
      `⏱️ بدأ تتبع المهمة:\n📌 ${taskName}\n🕐 وقت البدء: ${timeStr}\n\n` +
      `📝 مهمة جديدة (سيتم إنشاؤها في Todoist عند الإكمال)\n\n` +
      `استخدم /completetask عند الانتهاء`
    );
  } else {
    await ctx.reply('✅ تم الإلغاء');
  }
  return;
}

      // Check for pending quantity (after /completetask)
      const quantityKey = `task_quantity_${chatId}`;
      const pendingQuantity = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(quantityKey) },
      });

      if (pendingQuantity.length > 0) {
        const quantityData = (pendingQuantity[0] as any).data || {};
        let taskName = quantityData.taskName;
        const durationMinutes = quantityData.durationMinutes;
        const todoistTaskId = quantityData.todoistTaskId; // Get existing Todoist task ID
        const startDate = quantityData.startDate || getTodayInEgypt(); // Egypt date when task started (midnight boundary)

        // Delete the pending quantity record
        await ctx.db.delete('conversation_state', { chat_id: op.eq(quantityKey) });

        // Check if user wants to add quantity
        const lowerText = text.trim().toLowerCase();
        if (lowerText !== 'لا' && lowerText !== 'no' && lowerText !== 'skip') {
          // Parse quantity: "20 صفحة" -> quantity=20, unit=صفحة
          const quantityMatch = text.match(/^(\d+)\s*(.+)$/);
          if (quantityMatch && quantityMatch[1] && quantityMatch[2]) {
            const quantity = quantityMatch[1];
            const unit = quantityMatch[2].trim();
            taskName = `${taskName} [${quantity} ${unit}]`;
          } else {
            // Just append the text as-is
            taskName = `${taskName} [${text.trim()}]`;
          }
        }

        // Get Todoist credentials
        const todoistToken = await ctx.settings.get('todoist_api_token');

        if (todoistToken) {
          try {
            if (todoistTaskId) {
              // Store pending update so webhook handler can use updated content
              // This MUST complete BEFORE we close the task to avoid race condition
              const pendingUpdateKey = `pending_update_${todoistTaskId}`;
              console.log('📝 Storing pending update with key:', pendingUpdateKey);

              await ctx.db.insert('conversation_state', {
                chat_id: pendingUpdateKey,
                conversation_type: 'pending_task_update',
                data: {
                  taskId: todoistTaskId,
                  updatedContent: taskName,
                  durationMinutes: durationMinutes,
                  createdAt: Date.now(),
                },
                expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 minute expiry
              });

              console.log('✅ Pending update saved, now updating Todoist task content');

              // UPDATE existing Todoist task content, then complete it
              // Step 1: Update task content with duration/quantity
              const updateResponse = await fetch(`https://api.todoist.com/rest/v3/tasks/${todoistTaskId}`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${todoistToken.trim()}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ content: taskName }),
              });

              if (updateResponse.ok) {
                console.log('✅ Todoist content updated, now closing task');

                // Small delay to ensure content update is processed by Todoist
                await new Promise(resolve => setTimeout(resolve, 500));

                // Step 2: Complete the task
                await fetch(`https://api.todoist.com/rest/v3/tasks/${todoistTaskId}/close`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
                });

                await ctx.reply(`✅ تم تحديث وإكمال المهمة في Todoist:\n📌 ${taskName}`);
              } else {
                const errorText = await updateResponse.text();
                console.error('Todoist update error:', errorText);
                await ctx.reply(`⚠️ فشل تحديث المهمة:\n📌 ${taskName}`);
                // Clean up pending update on failure
                await ctx.db.delete('conversation_state', { chat_id: op.eq(pendingUpdateKey) });
              }
            } else {
              // CREATE new task and complete it (no existing task found)
              const todoistProjectId = await ctx.settings.get('todoist_project_id');
              const createResponse = await fetch('https://api.todoist.com/rest/v3/tasks', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${todoistToken.trim()}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  content: taskName,
                  project_id: todoistProjectId?.trim() || undefined,
                }),
              });

              if (createResponse.ok) {
                const newTask = await createResponse.json() as { id: string };
                await fetch(`https://api.todoist.com/rest/v3/tasks/${newTask.id}/close`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
                });

                await ctx.reply(`✅ تم إنشاء وإكمال مهمة جديدة في Todoist:\n📌 ${taskName}`);
              } else {
                await ctx.reply(`⚠️ تم حفظ المهمة محلياً (فشل Todoist):\n📌 ${taskName}`);
              }
            }
          } catch (todoistError) {
            console.error('Todoist error:', todoistError);
            await ctx.reply(`⚠️ تم حفظ المهمة محلياً:\n📌 ${taskName}`);
          }
        } else {
          await ctx.reply(`✅ تم إكمال المهمة:\n📌 ${taskName}`);
        }

        // Save to local database only if NO Todoist task
        // If there's a Todoist task, the webhook will handle saving with updated content
        if (!todoistTaskId) {
          // No Todoist task ID, save locally
          // Use startDate for completed_at to handle midnight boundary correctly
          // Tasks are attributed to the day they STARTED, not ended
          const completedAt = new Date(`${startDate}T23:59:59+02:00`); // End of start day in Egypt timezone
          await ctx.db.insert('tasks', {
            task_id: `timer_${Date.now()}`,
            content: taskName,
            completed_at: completedAt.toISOString(),
            status: 'done',
            duration_minutes: durationMinutes,
            created_at: new Date().toISOString(),
          });
        }
        // If todoistTaskId exists, the webhook will save it using the pending_update record

        return;
      }

// Check for pending duration input
const pendingDurationKey = `pending_duration_${chatId}`;
const pendingDurationState = await ctx.db.select('conversation_state', {
  filter: { chat_id: op.eq(pendingDurationKey) },
});

if (pendingDurationState.length > 0) {
  await ctx.db.delete('conversation_state', { chat_id: op.eq(pendingDurationKey) });
  
  // Parse duration
  const { parseTaskMetadata } = await import('../utils/task-parser');
  const metadata = parseTaskMetadata(`[${text}]`);

  if (!metadata.duration_minutes) {
    await ctx.reply('❌ صيغة المدة غير صحيحة. حاول مرة أخرى أو /cancel');
    return;
  }

  const taskKey = `active_task_${chatId}`;
  const existingTask = await ctx.db.select('conversation_state', {
    filter: { chat_id: op.eq(taskKey) },
  });

  if (existingTask.length > 0) {
    const taskData = (existingTask[0] as any).data || {};
    
    await ctx.db.update(
      'conversation_state',
      { chat_id: op.eq(taskKey) },
      {
        data: {
          ...taskData,
          manualDuration: metadata.duration_minutes,
        }
      }
    );

    await ctx.reply(
  `✅ تم إضافة المدة: ${metadata.duration_minutes} دقيقة\n\n` +
  `📌 ${taskData.taskName}\n\n` +
  `**التالي:**\n` +
  `• /addquantity - إضافة كمية\n` +
  `• /completetask - إنهاء المهمة الآن`
);
  }
  return;
}

// Check for pending quantity input
const pendingQuantityInputKey = `pending_quantity_${chatId}`;
const pendingQuantityInputState = await ctx.db.select('conversation_state', {
  filter: { chat_id: op.eq(pendingQuantityInputKey) },
});

if (pendingQuantityInputState.length > 0) {
  await ctx.db.delete('conversation_state', { chat_id: op.eq(pendingQuantityInputKey) });
  
  // Parse quantity
  const quantityMatch = text.match(/^(\d+)\s*(.+)$/);
  if (!quantityMatch || !quantityMatch[1] || !quantityMatch[2]) {
    await ctx.reply('❌ صيغة الكمية غير صحيحة. حاول مرة أخرى أو /cancel');
    return;
  }

  const quantity = quantityMatch[1];
  const unit = quantityMatch[2].trim();

  const taskKey = `active_task_${chatId}`;
  const existingTask = await ctx.db.select('conversation_state', {
    filter: { chat_id: op.eq(taskKey) },
  });

  if (existingTask.length > 0) {
    const taskData = (existingTask[0] as any).data || {};
    
    await ctx.db.update(
      'conversation_state',
      { chat_id: op.eq(taskKey) },
      {
        data: {
          ...taskData,
          manualQuantity: quantity,
          manualQuantityUnit: unit,
        }
      }
    );

    await ctx.reply(
  `✅ تم إضافة الكمية: ${quantity} ${unit}\n\n` +
  `📌 ${taskData.taskName}\n\n` +
  `**التالي:**\n` +
  `• /addduration - إضافة مدة\n` +
  `• /completetask - إنهاء المهمة الآن`
);
  }
  return;
}


      // First, try to add to journal if there's an active session
      const journalResult = await journalMgr.addTextEntry(text);
      if (journalResult.success) {
        // Successfully added to journal - send subtle confirmation
        await ctx.reply('📝 ✓');
        return;
      }

      // If no journal session, check for other conversations
      const conversation = await conversationMgr.getConversation(chatId);

      if (!conversation) {
        return; // No active conversation
      }

      // Handle Q&A conversation
      if (conversation.conversation_type === 'qa_report') {
        // Save answer
        await conversationMgr.saveAnswer(chatId, text);

        // Check if complete
        const isComplete = await conversationMgr.isComplete(chatId);

        if (isComplete) {
          await ctx.reply('✅ شكراً على إجاباتك! جاري بدء التحليل...');

          const reportContext = await conversationMgr.getReportContext(chatId);
          const answers = await conversationMgr.getAnswers(chatId);

          // Clear conversation
          await conversationMgr.clearConversation(chatId);

          // Start Durable Object job with answers
          const openRouterKey = await ctx.settings.get('openrouter_api_key');
          const anthropicApiKey = await ctx.settings.get('anthropic_api_key');
          const aiModel = await getAIModelByTier(ctx.settings, 'low');
          const botToken = await ctx.settings.get('telegram_bot_token');
          const useAnthropicPrimary = (await ctx.settings.get('use_anthropic_primary')) !== 'false';

          const hasValidOpenRouterKey = openRouterKey && openRouterKey.trim().startsWith('sk-or-v1-');
          const hasValidAnthropicKey = anthropicApiKey && anthropicApiKey.trim().startsWith('sk-ant-');

          if ((hasValidOpenRouterKey || hasValidAnthropicKey) && botToken) {
            const { startDurableObjectJob } = await import('./confirm-handler');
            await startDurableObjectJob(
              ctx,
              ctx.reportProcessorNamespace,
              reportContext,
              answers || {},
              openRouterKey?.trim() || '',
              aiModel,
              botToken,
              anthropicApiKey?.trim(),
              useAnthropicPrimary
            );
          }

        } else {
          // FIXED: Send next question with correct progress
          const nextQuestion = await conversationMgr.getCurrentQuestion(chatId);
          if (nextQuestion) {
            const progress = await conversationMgr.getProgress(chatId);
            await ctx.reply(`✅ تمام!\n\n[${progress}] ❓ ${nextQuestion}`);
          }
        }
      }
    } catch (error) {
      console.error('Text message handler error:', error);
    }
  });

  // Helper function to handle media upload
  async function handleMediaUpload(
    ctx: BotContext,
    fileId: string,
    mediaType: 'image' | 'video' | 'voice' | 'document',
    caption?: string,
    emoji: string = '📷'
  ) {
    const journalMgr = createJournalManager(ctx.db);
    const today = getTodayInEgypt();

    // First save with Telegram file_id (fallback)
    const result = await journalMgr.addMediaEntry(fileId, mediaType, caption);

    if (!result.success) {
      // No active session - silently ignore
      return;
    }

    await ctx.reply(`${emoji} ⏳ جاري الحفظ...`);

    // Try to upload to Supabase Storage
    // Use service role key for storage (bypasses RLS), fallback to anon key
    const storageKey = ctx.env.SUPABASE_SERVICE_ROLE_KEY || ctx.env.SUPABASE_ANON_KEY;
    const storageService = createMediaStorageService(
      ctx.env.SUPABASE_URL,
      storageKey,
      ctx.env.TELEGRAM_BOT_TOKEN
    );

    const uploadResult = await storageService.transferFromTelegram(fileId, mediaType, today);

    if (uploadResult.success && uploadResult.url && result.entryId) {
      // Update the entry with the Supabase URL
      await journalMgr.updateMediaUrl(result.entryId, uploadResult.url);
      await ctx.reply(`${emoji} ✓ (رفع ناجح)`);
    } else {
      // Fallback - file_id was saved
      const errorMsg = uploadResult.error || 'Unknown error';
      console.error('Storage upload failed:', errorMsg);
      // Show user-friendly error
      await ctx.reply(`${emoji} ⚠️ (محفوظ محلياً - فشل الرفع: ${errorMsg.substring(0, 50)})`);
    }
  }

  // Handle photo messages (for journal)
  bot.on('message:photo', async (ctx) => {
    try {
      const photos = ctx.message.photo;
      if (!photos || photos.length === 0) return;
      const largestPhoto = photos[photos.length - 1];
      if (!largestPhoto) return;

      await handleMediaUpload(
        ctx,
        largestPhoto.file_id,
        'image',
        ctx.message.caption || undefined,
        '📷'
      );
    } catch (error) {
      console.error('Photo message handler error:', error);
    }
  });

  // Handle video messages (for journal)
  bot.on('message:video', async (ctx) => {
    try {
      await handleMediaUpload(
        ctx,
        ctx.message.video.file_id,
        'video',
        ctx.message.caption || undefined,
        '🎥'
      );
    } catch (error) {
      console.error('Video message handler error:', error);
    }
  });

  // Handle voice messages (for journal)
  bot.on('message:voice', async (ctx) => {
    try {
      await handleMediaUpload(
        ctx,
        ctx.message.voice.file_id,
        'voice',
        undefined,
        '🎤'
      );
    } catch (error) {
      console.error('Voice message handler error:', error);
    }
  });

  // Handle document messages (for journal)
  bot.on('message:document', async (ctx) => {
    try {
      await handleMediaUpload(
        ctx,
        ctx.message.document.file_id,
        'document',
        ctx.message.caption || undefined,
        '📄'
      );
    } catch (error) {
      console.error('Document message handler error:', error);
    }
  });
}

/**
 * Create webhook handler
 */
export function createTelegramWebhookHandler(
  bot: Bot<BotContext>
): (request: Request) => Promise<Response> {
  return webhookCallback(bot, 'cloudflare-mod');
}

/**
 * Set webhook (helper function)
 */
export async function setWebhook(
  botToken: string,
  webhookUrl: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl }),
      }
    );

    const data = await response.json() as { ok: boolean; description?: string };
    return data.ok;
  } catch (error) {
    console.error('Error setting webhook:', error);
    return false;
  }
}
