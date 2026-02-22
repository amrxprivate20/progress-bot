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

// Coach Features
import { createStuckHandler } from '../interventions/stuck-handler';
import { createBattleMode } from '../gamification/battle-mode';
import { createRoastMode } from '../coach/roast-mode';
import { createMetaCoach } from '../coach/meta-coach';
import { createAutofailService, PreparedAutofailData } from '../services/autofail-service';

// New Interactive Features
import { createCelebrationsService } from '../services/celebrations';
import { createCoachingAnalytics } from '../coach/coaching-analytics';
import { createCoachingContextBuilder } from '../coach/coaching-context';
import { isUserInTaskOrReportFlow } from '../utils/tasking-state';
import {
  createCoachCheckInKeyboard,
  createMoodKeyboard,
  createQuickModeKeyboard,
  createQuickModeEndKeyboard,
  createTaskSelectionKeyboard,
  createTaskStartedKeyboard,
  createDurationInputKeyboard,
  createQuantityInputKeyboard,
  createResumeChoiceKeyboard,
} from '../utils/keyboards';

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
    const debugMode = await ctx.settings.get('debug_mode');
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
👋 مرحباً! أنا بوت تتبع التقدم والكوتش الشخصي!

⚡ **البداية السريعة:**
/quick - ابدأ جلسة 5 دقايق (التزام صغير)
/starttask - ابدأ تتبع مهمة
/stuck - مساعدة فورية عند التأجيل

📊 **التقارير:**
/today - ملخص اليوم
/progress - تحليل AI
/streak - سلسلتك ونقاطك

⏱️ **تتبع المهام:**
/starttask [اسم] - بدء مهمة
/completetask - إنهاء المهمة
/resumelater - إيقاف مؤقت
/resumetask - استئناف مهمة

🎯 **التخطيط:**
/todayplan - خطة اليوم
/goals - الأهداف والتحديات

🔥 **الكوتش:**
/stuck - تدخل فوري
/battle_mode - معركة اليوم
/roast_me - إحراق شخصي 😏
/mood - تحديد حالتك

📔 **اليوميات:**
/journal_start - بدء جلسة

🧠 **الذاكرة:**
/memory - عرض الذاكرة
/optimize_memory - تحسين الذاكرة

⚙️ **النظام:**
/status - حالة النظام
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
⚡ البداية السريعة:
━━━━━━━━━━━━━━━━━━━━
/quick - جلسة 5 دقايق (التزام صغير)
/starttask - بدء تتبع مهمة
/stuck - مساعدة فورية عند التأجيل

━━━━━━━━━━━━━━━━━━━━
📊 التقارير والملخصات:
━━━━━━━━━━━━━━━━━━━━
/today - ملخص سريع لمهام اليوم
/progress - ملخص اليوم مع خيار التحليل
/confirm - بدء التحليل بالذكاء الاصطناعي
/report YYYY-MM-DD - عرض تقرير محفوظ
/streak - عرض سلسلتك ونقاطك 🔥
/status - حالة النظام والمهام

━━━━━━━━━━━━━━━━━━━━
⏱️ تتبع المهام:
━━━━━━━━━━━━━━━━━━━━
/starttask - عرض المهام المتاحة
/starttask [اسم] - بدء مهمة محددة
/quick - جلسة قصيرة (5-15 دقيقة)
/completetask - إنهاء المهمة
/canceltask - إلغاء بدون حفظ
/addduration - إضافة مدة يدوياً
/addquantity - إضافة كمية

━━━━━━━━━━━━━━━━━━━━
⏸️ جلسات المهام:
━━━━━━━━━━━━━━━━━━━━
/resumelater - إيقاف مؤقت + حفظ الوقت
/resumetask - استئناف مهمة موقوفة
/abandonsession - إلغاء الجلسة

━━━━━━━━━━━━━━━━━━━━
🎯 التخطيط والأهداف:
━━━━━━━━━━━━━━━━━━━━
/todayplan - خطة اليوم بالـ AI
/tomorrowplan - خطة الغد
/goals - الأهداف والتحديات
/generate_goals - توليد أهداف جديدة
/createtasks - إنشاء مهام في Todoist
/sync - مزامنة Todoist

━━━━━━━━━━━━━━━━━━━━
🔥 الكوتش:
━━━━━━━━━━━━━━━━━━━━
/stuck - 🚨 تدخل فوري
/stuck_continue - سبرنت آخر
/stuck_done - خلصت
/stuck_defer - أجّل مع سبب

/battle_mode - ⚔️ معركة اليوم
/battle_status - حالة المعركة

/roast_me - 😏 إحراق شخصي
/weekly_roast - إحراق أسبوعي

/mood - تحديد حالتك النفسية
/coach_check - تنبيه من الكوتش
/coach_settings - إعدادات الكوتش
/autofail - تسجيل المهام كفاشلة

━━━━━━━━━━━━━━━━━━━━
📔 اليوميات:
━━━━━━━━━━━━━━━━━━━━
/journal_start - بدء جلسة
/journal_end - إنهاء الجلسة
/journal - عرض اليوميات

━━━━━━━━━━━━━━━━━━━━
🧠 الذاكرة:
━━━━━━━━━━━━━━━━━━━━
/memory - عرض الذاكرة
/optimize_memory - تحسين الذاكرة بالـ AI
/optimize_memory force - تحسين إجباري لكل الفئات
/clearmemory - مسح الذاكرة

━━━━━━━━━━━━━━━━━━━━
⚙️ الإعدادات:
━━━━━━━━━━━━━━━━━━━━
/debug - وضع التصحيح (يظهر AI prompts)
/log_failure - تسجيل فشل مهمة
/cancel - إلغاء عملية معلقة

━━━━━━━━━━━━━━━━━━━━
💡 نصائح:
• /quick للبداية بالتزام صغير
• /stuck عند الشعور بالتأجيل
• /streak لمتابعة سلسلة إنجازاتك
• الكوتش يتفاعل معاك ويسأل عن حالتك
• /resumelater يحفظ وقتك للاستكمال لاحقاً
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

    let allTasks: typeof tasksData = [];
    if (todoistToken) {
      try {
        const response = await fetch('https://api.todoist.com/api/v1/tasks', {
          headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
        });
        if (response.ok) {
          const json = await response.json() as any;
          allTasks = Array.isArray(json) ? json : (json.results || []);
        }
      } catch (e) {
        console.error('Todoist fetch error:', e);
      }
    }

    if (allTasks.length === 0) {
      return `📅 **خطة ${titleWord} (${dayName} ${targetDate})**\n\n` +
        `📋 لا توجد مهام في المشروع.\n\n` +
        `💡 استخدم /createtasks لإنشاء مهام جديدة.`;
    }

    // Split tasks into today's dated tasks and available tasks
    const todayTasks = allTasks.filter(t => {
      const taskDate = t.due?.date?.split('T')[0];
      return taskDate === targetDate;
    });
    const availableTasks = allTasks.filter(t => {
      const taskDate = t.due?.date?.split('T')[0];
      return !taskDate || taskDate !== targetDate;
    });

    // Format tasks for AI
    const formatTask = (t: typeof tasksData[0]) => {
      const priorityLabel = t.priority === 4 ? 'عاجل' :
                           t.priority === 3 ? 'مهم' :
                           t.priority === 2 ? 'عادي' : 'منخفض';
      const timeInfo = t.due?.datetime ?
        ` (موعد: ${new Date(t.due.datetime).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })})` : '';
      const dateInfo = t.due?.date && t.due.date.split('T')[0] !== targetDate ? ` [تاريخ: ${t.due.date.split('T')[0]}]` : '';
      return `- ${t.content} [أولوية: ${priorityLabel}]${timeInfo}${dateInfo}`;
    };

    const todayTasksForAI = todayTasks.map(formatTask).join('\n') || 'لا توجد مهام مجدولة لهذا التاريخ';
    const availableTasksForAI = availableTasks.slice(0, 20).map(formatTask).join('\n') || 'لا توجد';

    // Build AI prompt
    const prompt = `
أنت مساعد ذكي متخصص في التخطيط اليومي. قم بإنشاء خطة يومية ذكية ومنظمة.

## المعلومات المتاحة:

**التاريخ:** ${dayName} ${targetDate} (${titleWord})

**مهام اليوم المجدولة (${todayTasks.length}):**
${todayTasksForAI}

**مهام متاحة أخرى (${availableTasks.length}):**
${availableTasksForAI}

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
   - أولوية لمهام اليوم المجدولة، ثم المهام المتاحة
3. **🎯 الالتزامات** - المهام السلبية (عدم فعل شيء) في قسم منفصل
4. **📌 إذا سمح الوقت** - المهام الأقل أولوية من القائمة المتاحة
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
        `**المهام المجدولة:**\n${todayTasksForAI}`;
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
  async function sendTelegramMessageDirect(botToken: string, chatId: string, text: string, parseMode?: string, replyMarkup?: any): Promise<void> {
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
      const chunkText = chunks[i] || '';
      const chunk = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n${chunkText}` : chunkText;
      const body: Record<string, any> = { chat_id: chatId, text: chunk };
      if (parseMode) body.parse_mode = parseMode;
      // Only add keyboard to the last chunk
      if (replyMarkup && i === chunks.length - 1) body.reply_markup = replyMarkup;
      const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`❌ sendTelegramMessageDirect failed: ${resp.status} ${errText}`);
        // Retry without parse_mode if Markdown failed
        if (parseMode && resp.status === 400) {
          const retryBody = { ...body };
          delete retryBody.parse_mode;
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(retryBody),
          });
        }
      }
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

  /**
   * Helper: Show task selection keyboard (shared by coach:start_task, coach:suggest, cmd:starttask)
   */
  // Helper: fetch ALL tasks from Todoist with pagination
  async function fetchAllTodoistTasks(token: string, projectId: string): Promise<any[]> {
    const allTasks: any[] = [];
    let cursor: string | null = null;

    do {
      let url = `https://api.todoist.com/api/v1/tasks?project_id=${projectId}`;
      if (cursor) url += `&cursor=${cursor}`;

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`Todoist API error: ${resp.status}`);

      const json = await resp.json() as any;
      const pageTasks = Array.isArray(json) ? json : (json.results || []);
      allTasks.push(...pageTasks);
      cursor = json.next_cursor || null;
    } while (cursor);

    return allTasks;
  }

  async function showTaskSelection(ctx: BotContext): Promise<boolean> {
    const chatId = ctx.chat?.id.toString() || '';
    const todoistToken = await ctx.settings.get('todoist_api_token');
    const todoistProjectId = await ctx.settings.get('todoist_project_id');

    if (todoistToken && todoistProjectId) {
      try {
        const tasks = await fetchAllTodoistTasks(todoistToken, todoistProjectId);
        if (tasks.length > 0) {
          const today = getTodayInEgypt();
          // Filter to tasks due today or earlier, or without due date
          const availableTasks = tasks.filter((t: any) => {
            if (t.is_completed) return false;
            if (!t.due?.date) return true;
            const dueDate = t.due.date.split('T')[0];
            return dueDate && dueDate <= today;
          });

          if (availableTasks.length === 0) return false;

          const selectKey = `task_select_${chatId}`;
          const taskList = availableTasks.map((t: any) => ({ id: t.id, content: t.content }));
          await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) }).catch(() => {});
          await ctx.db.insert('conversation_state', {
            chat_id: selectKey,
            conversation_type: 'task_selection',
            data: { availableTasks: taskList },
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          });
          const keyboard = createTaskSelectionKeyboard(taskList, 'start', 0);
          await ctx.reply('📋 **اختر مهمة للبدء:**', { parse_mode: 'Markdown', reply_markup: keyboard });
          return true;
        }
      } catch (_e) { /* fall through */ }
    }
    return false;
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
      // Use HIGH tier for unified report analysis (critical task)
      const aiModel = await getAIModelByTier(ctx.settings, 'high');
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

      // Fetch all tasks from Todoist project (with pagination)
      let allTasks: Array<{ id: string; content: string; due?: { date: string }; is_completed?: boolean }>;
      try {
        allTasks = await fetchAllTodoistTasks(todoistToken.trim(), todoistProjectId.trim());
      } catch (err) {
        await ctx.reply(`❌ فشل الاتصال بـ Todoist: ${err instanceof Error ? err.message : 'Unknown'}`);
        return;
      }

      // Filter to tasks available today (due today or overdue, not completed)
      const availableToday = allTasks.filter(t => {
        if (t.is_completed) return false;
        if (!t.due?.date) return true; // Tasks without due date
        const dueDate = t.due.date.split('T')[0];
        return dueDate && dueDate <= today;
      });

      // Store key for selection
      const selectKey = `failure_select_${chatId}`;

      // Delete any existing selection state
      try {
        await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) });
      } catch (e) { /* ignore */ }

      // NO PARAMETERS - Show full list with inline keyboard
      if (!args.trim()) {
        if (availableToday.length === 0) {
          await ctx.reply(
            '📋 لا توجد مهام متاحة اليوم في Todoist.\n\n' +
            '📝 يمكنك كتابة اسم مهمة جديدة:\n' +
            '/log_failure [اسم المهمة]'
          );
          return;
        }

        // Show with inline keyboard
        const message = '📋 **اختر المهمة التي فشلت:**';

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

        // Create inline keyboard with tasks
        const taskKeyboard = createTaskSelectionKeyboard(
          availableToday.map(t => ({ id: t.id, content: t.content })),
          'failure'
        );

        await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: taskKeyboard });
        return;
      }

      // WITH PARAMETERS - Search for matching tasks and show inline keyboard
      const searchTerm = args.trim().toLowerCase();
      const matchedTasks = availableToday.filter(t =>
        t.content.toLowerCase().includes(searchTerm) ||
        searchTerm.includes(t.content.toLowerCase())
      );

      if (matchedTasks.length === 0) {
        // No matches - store for new task entry
        const newTaskKey = `failure_new_task_${chatId}`;
        await ctx.db.delete('conversation_state', { chat_id: op.eq(newTaskKey) }).catch(() => {});
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

      // Show matched tasks with inline keyboard (same UX as no-args)
      await ctx.db.insert('conversation_state', {
        chat_id: selectKey,
        conversation_type: 'failure_selection',
        data: {
          availableTasks: matchedTasks,
          allowNewTask: true,
        },
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

      const taskKeyboard = createTaskSelectionKeyboard(
        matchedTasks.map(t => ({ id: t.id, content: t.content })),
        'failure'
      );

      await ctx.reply(
        `📋 **تم العثور على ${matchedTasks.length} مهمة مطابقة - اختر:**`,
        { parse_mode: 'Markdown', reply_markup: taskKeyboard }
      );

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

  // Optimize memory command
  bot.command(['optimize_memory', 'optimizememory'], async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';
      const args = ctx.message?.text?.split(' ').slice(1).join(' ').trim() || '';
      const force = args.toLowerCase() === 'force';

      const openRouterKey = await ctx.settings.get('openrouter_api_key');
      if (!openRouterKey) {
        await ctx.reply('❌ لم يتم تكوين مفتاح AI.');
        return;
      }

      // Use high-tier model for optimization
      const highTierModel = await getAIModelByTier(ctx.settings, 'high');
      const highTierClient = createAIClient(openRouterKey, highTierModel);
      const lowTierModel = await getAIModelByTier(ctx.settings, 'low');
      const lowTierClient = createAIClient(openRouterKey, lowTierModel);
      const memoryMgr = createMemoryManager(ctx.db, lowTierClient);

      // First check if optimization is needed
      if (!force) {
        const check = await memoryMgr.checkOptimizationNeeded();
        if (!check.needed) {
          await ctx.reply(
            '✅ الذاكرة لا تحتاج تحسين حالياً.\n\n' +
            'استخدم `/optimize_memory force` لفرض التحسين.',
            { parse_mode: 'Markdown' }
          );
          return;
        }
        await ctx.reply(
          `🔄 **جاري تحسين الذاكرة...**\n\n` +
          `📋 الأسباب:\n${check.reasons.map(r => `• ${r}`).join('\n')}\n\n` +
          `📂 الفئات: ${check.categories.length}`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply('🔄 **جاري تحسين الذاكرة (فرض)...**', { parse_mode: 'Markdown' });
      }

      const botToken = ctx.env.TELEGRAM_BOT_TOKEN;

      // Run optimization in background
      const backgroundTask = (async () => {
        try {
          const result = await memoryMgr.runOptimization(highTierClient, force);

          if (result.categoriesOptimized.length > 0) {
            const savedChars = result.totalSizeBefore - result.totalSizeAfter;
            const savedPercent = result.totalSizeBefore > 0
              ? Math.round((savedChars / result.totalSizeBefore) * 100)
              : 0;

            await sendTelegramMessageDirect(botToken, chatId,
              `✅ **تم تحسين الذاكرة!**\n\n` +
              `📊 الحجم: ${result.totalSizeBefore} → ${result.totalSizeAfter} حرف` +
              (savedChars > 0 ? ` (وفرنا ${savedPercent}%)` : '') + `\n` +
              `📂 الفئات المحسّنة: ${result.categoriesOptimized.length}\n` +
              result.categoriesOptimized.map(c => `  • ${c}`).join('\n'),
              'Markdown'
            );
          } else {
            await sendTelegramMessageDirect(botToken, chatId, '✅ لا توجد فئات تحتاج تحسين');
          }
        } catch (error) {
          console.error('Memory optimization error:', error);
          await sendTelegramMessageDirect(botToken, chatId,
            '❌ حدث خطأ أثناء تحسين الذاكرة: ' + (error instanceof Error ? error.message : 'Unknown')
          );
        }
      })();

      if (ctx.executionContext?.waitUntil) {
        ctx.executionContext.waitUntil(backgroundTask);
      } else {
        await backgroundTask;
      }
    } catch (error) {
      console.error('Optimize memory command error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
  });

  // ============================================
  // Debug & Configuration Commands
  // ============================================

  // Toggle debug mode
  bot.command('debug', async (ctx) => {
    try {
      const currentMode = await ctx.settings.get('debug_mode');
      const isEnabled = currentMode === 'true';

      // Toggle the mode
      const newMode = isEnabled ? 'false' : 'true';
      await ctx.settings.set('debug_mode', newMode);

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
        `⚠️ لديك مهمة نشطة بالفعل:\n📌 ${taskData.taskName}`,
        { reply_markup: createTaskStartedKeyboard() }
      );
      return;
    }

    // Check for paused session matching the task name (if provided)
    const { createTaskSessionManager } = await import('../services/task-session-manager');
    const sessionMgr = createTaskSessionManager(ctx.db);

    if (args.trim()) {
      // Check if there's a paused session for this task
      const pausedSession = await sessionMgr.hasPausedSession(chatId, args.trim());
      if (pausedSession) {
        // Format time nicely
        const formatTime = (mins: number): string => {
          if (mins < 60) return `${mins}د`;
          const h = Math.floor(mins / 60);
          const m = mins % 60;
          if (m === 0) return `${h}س`;
          return `${h}س ${m}د`;
        };

        await ctx.reply(
          `⏸️ *لديك جلسة موقوفة لهذه المهمة!*\n\n` +
          `📌 ${pausedSession.taskContent}\n` +
          `⏱️ الوقت المسجل: ${formatTime(pausedSession.totalTimeWorked)}\n` +
          `🔄 الجلسات: ${pausedSession.sessionCount}\n\n` +
          `اختر ما تريد:`,
          { parse_mode: 'Markdown', reply_markup: createResumeChoiceKeyboard(pausedSession.id) }
        );

        // Store pending decision
        const resumeDecisionKey = `resume_decision_${chatId}`;
        await ctx.db.insert('conversation_state', {
          chat_id: resumeDecisionKey,
          conversation_type: 'resume_decision',
          data: {
            sessionId: pausedSession.id,
            taskName: args.trim(),
            taskContent: pausedSession.taskContent,
            taskId: pausedSession.taskId,
          },
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });
        return;
      }
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

    // Get available tasks (due today or overdue) with pagination
    const { getTodayInEgypt } = await import('../utils/timezone');
    const today = getTodayInEgypt();

    let allTasks: Array<{ id: string; content: string; due?: { date: string }; is_completed?: boolean }>;
    try {
      allTasks = await fetchAllTodoistTasks(todoistToken.trim(), todoistProjectId.trim());
    } catch (err) {
      await ctx.reply(`❌ فشل الاتصال بـ Todoist: ${err instanceof Error ? err.message : 'Unknown'}`);
      return;
    }

    // Filter to tasks available today (due today or overdue, not completed)
   const availableToday = allTasks.filter(t => {
     if (t.is_completed) return false;
     if (!t.due?.date) return true; // Tasks without due date
     const dueDate = t.due.date.split('T')[0];
     return dueDate && dueDate <= today;
   });

   // Count tasks by due status for context
   const todayTasks = availableToday.filter(t => {
     if (!t.due?.date) return false;
     const dueDateStr = t.due.date.split('T')[0];
     return dueDateStr === today;
   });
   const overdueTasks = availableToday.filter(t => {
     if (!t.due?.date) return false;
     const dueDate = t.due.date.split('T')[0];
     return dueDate ? dueDate < today : false;
   });
   const noDueDateTasks = availableToday.filter(t => !t.due?.date);

   // NO PARAMETERS - Show list of all available tasks with inline keyboard
   if (!args.trim()) {
     if (availableToday.length === 0) {
       await ctx.reply(
         '📋 لا توجد مهام متاحة اليوم في Todoist.\n\n' +
         '📝 يمكنك كتابة اسم مهمة جديدة:\n' +
         '/starttask [اسم المهمة]'
       );
       return;
     }

     // Show list with context header and inline keyboard
     let message = '📋 **اختر مهمة للبدء:**\n';
     message += `📅 اليوم: ${todayTasks.length} | ⚠️ متأخرة: ${overdueTasks.length} | 📌 بدون موعد: ${noDueDateTasks.length}`;

      // Store available tasks for potential "new task" flow
      const selectKey = `task_select_${chatId}`;
      try {
        await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) });
      } catch (e) { /* ignore */ }

      await ctx.db.insert('conversation_state', {
        chat_id: selectKey,
        conversation_type: 'task_selection',
        data: {
          availableTasks: availableToday,
          allowNewTask: true,
        },
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

      // Create inline keyboard with tasks
      const taskKeyboard = createTaskSelectionKeyboard(
        availableToday.map(t => ({ id: t.id, content: t.content })),
        'start'
      );

      await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: taskKeyboard });
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
     // Exactly one match - show with inline keyboard
     const task = matchedTasks[0]!;
     const { extractCleanTaskName } = await import('../utils/task-parser');
     const message = `📋 **هل تريد تتبع هذه المهمة؟**\n\n📌 ${extractCleanTaskName(task.content).trim()}`;

      // Store for potential "new task" flow
      const selectKey = `task_select_${chatId}`;
      try {
        await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) });
      } catch (e) { /* ignore */ }

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

      // Create inline keyboard
      const taskKeyboard = createTaskSelectionKeyboard(
        [{ id: task.id, content: task.content }],
        'start'
      );

      await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: taskKeyboard });
      return;
    }

   // Multiple matches - show with inline keyboard
   const message = `📋 **تم العثور على ${matchedTasks.length} مهام مطابقة:**`;

    // Store matched tasks for potential "new task" flow
    const selectKey = `task_select_${chatId}`;
    try {
      await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) });
    } catch (e) { /* ignore */ }

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

    // Create inline keyboard
    const taskKeyboard = createTaskSelectionKeyboard(
      matchedTasks.map(t => ({ id: t.id, content: t.content })),
      'start'
    );

    await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: taskKeyboard });

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

    // If no args, prompt for duration with keyboard
    if (!args.trim()) {
      await ctx.reply(
        '⏱️ **إضافة مدة زمنية**\n\n' +
        `📌 المهمة: ${taskData.taskName}\n\n` +
        'اختر مدة أو أرسل المدة يدوياً:\n' +
        '• 30m أو 30د (30 دقيقة)\n' +
        '• 2h أو 2س (ساعتان)',
        { parse_mode: 'Markdown', reply_markup: createDurationInputKeyboard() }
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

    // Update task with manual duration (accumulate, don't replace)
    const existingManualDuration = taskData.manualDuration || 0;
    const newManualDuration = existingManualDuration + metadata.duration_minutes;
    await ctx.db.update(
      'conversation_state',
      { chat_id: op.eq(taskKey) },
      {
        data: {
          ...taskData,
          manualDuration: newManualDuration,
        }
      }
    );

    await ctx.reply(
      `✅ تم إضافة المدة: ${metadata.duration_minutes} دقيقة` +
      (existingManualDuration > 0 ? ` (الإجمالي المضاف: ${newManualDuration} دقيقة)` : '') +
      `\n\n📌 ${taskData.taskName}`,
      { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
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

    // If no args, prompt for quantity with keyboard
    if (!args.trim()) {
      await ctx.reply(
        '📊 **إضافة كمية**\n\n' +
        `📌 المهمة: ${taskData.taskName}\n\n` +
        'اختر كمية أو أرسل الكمية والوحدة:\n' +
        'مثال: 20 صفحة، 5 تمارين',
        { parse_mode: 'Markdown', reply_markup: createQuantityInputKeyboard() }
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
      `📌 ${taskData.taskName}`,
      { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
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
    const previousTimeWorked = taskData.previousTimeWorked || 0; // From resumed session

    if (!startTime || !taskName) {
      await ctx.reply('❌ بيانات المهمة غير صحيحة');
      await ctx.db.delete('conversation_state', { chat_id: op.eq(taskKey) });
      return;
    }

    // Calculate duration (elapsed + previous sessions + manual additions)
    let durationMinutes: number;
    let sessionCount = 1;
    let cumulativeTime = 0;

    const endTime = Date.now();
    const durationMs = endTime - startTime;
    const thisSessionMinutes = Math.round(durationMs / 60000);

    // Add cumulative time from previous sessions + manual additions
    cumulativeTime = previousTimeWorked + thisSessionMinutes;
    durationMinutes = cumulativeTime + (manualDuration || 0);

    // Complete session in TaskSessionManager if it exists
    const { createTaskSessionManager } = await import('../services/task-session-manager');
    const sessionMgr = createTaskSessionManager(ctx.db);

    try {
      const activeSession = await sessionMgr.getActiveSession(chatId);
      if (activeSession) {
        const result = await sessionMgr.completeSession(chatId);
        // Use session manager's tracked time + any manual additions
        durationMinutes = result.totalTime + (manualDuration || 0);
        sessionCount = result.session.sessionCount;
      }
    } catch (sessionError) {
      console.log('Session completion note:', sessionError);
      // Continue with calculated duration if session manager fails
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
      // Add session count if more than 1
      if (sessionCount > 1) {
        durationStr += ` (${sessionCount} جلسات)`;
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
            manualQuantity: manualQuantity || null,
            manualQuantityUnit: manualQuantityUnit || null,
            createdAt: Date.now(),
            startDate: startDate,
          },
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });

        // Update task content
        const updateResponse = await fetch(`https://api.todoist.com/api/v1/tasks/${todoistTaskId}`, {
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
          await fetch(`https://api.todoist.com/api/v1/tasks/${todoistTaskId}/close`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
          });

          // ✅ FIX: Check if parent should autocomplete (pass undefined for parent hint - DB lookup as fallback)
          await completeParentInTodoistIfAllDone(
            ctx.db,
            ctx.settings,
            todoistTaskId,
            startDate,
            undefined, // No parent hint for /completetask - this is typically a main task
            { TELEGRAM_BOT_TOKEN: ctx.env.TELEGRAM_BOT_TOKEN }
          );

           const { createPostCompletionKeyboard } = await import('../utils/keyboards');
           const completionSuffix = '\n\n💪 جاهز للمهمة الجاية؟ ابدأ بـ /starttask';
           await ctx.reply(
              `✅ **تم إكمال المهمة!**\n\n` +
              `📌 ${updatedTaskName}\n` +
              `⏱️ المدة: ${durationMinutes} دقيقة${sessionCount > 1 ? ` (${sessionCount} جلسات)` : ''}\n` +
              `${manualQuantity ? `📊 الكمية: ${manualQuantity} ${manualQuantityUnit}\n` : ''}` +
              `✓ تم التحديث في Todoist` + completionSuffix,
              { parse_mode: 'Markdown', reply_markup: createPostCompletionKeyboard() }
           );

          // 🎉 Send AI celebration message
          try {
            const apiKey = await ctx.settings.get('openrouter_api_key');
            if (apiKey) {
              const { createMetaCoach } = await import('../coach/meta-coach');
              const { createAIClient } = await import('../services/ai-client');
              const { getAIModelByTier } = await import('../database/settings');

              const aiModel = await getAIModelByTier(ctx.settings, 'low');
              const aiClient = createAIClient(apiKey, aiModel);
              const metaCoach = createMetaCoach(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max), ctx.env.TELEGRAM_BOT_TOKEN);

              const celebrationMsg = await metaCoach.generateCelebration(chatId, cleanName, durationMinutes);
              if (celebrationMsg) {
                await ctx.reply(celebrationMsg);
              }
            }
          } catch (celebrationError) {
            console.log('Celebration message skipped:', celebrationError);
          }
        } else {
          throw new Error('Todoist update failed');
        }
      } catch (todoistError) {
        console.error('Todoist error:', todoistError);
        const { createPostCompletionKeyboard: postKb } = await import('../utils/keyboards');
        const completionSuffix = '\n\n💪 جاهز للمهمة الجاية؟ ابدأ بـ /starttask';
        await ctx.reply(
          `✅ **تم إكمال المهمة محلياً!**\n\n` +
          `📌 ${updatedTaskName}\n` +
          `⚠️ فشل التحديث في Todoist` + completionSuffix,
          { parse_mode: 'Markdown', reply_markup: postKb() }
        );
      }
    } else if (todoistToken && !todoistTaskId) {
      // Create new task
      try {
        const todoistProjectId = await ctx.settings.get('todoist_project_id');
        const createResponse = await fetch('https://api.todoist.com/api/v1/tasks', {
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
          await fetch(`https://api.todoist.com/api/v1/tasks/${newTask.id}/close`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
          });

          const { createPostCompletionKeyboard: pcKb1 } = await import('../utils/keyboards');
          const completionSuffix = '\n\n💪 جاهز للمهمة الجاية؟ ابدأ بـ /starttask';
          await ctx.reply(
            `✅ **تم إكمال المهمة!**\n\n` +
            `📌 ${updatedTaskName}\n` +
            `✓ تم الإنشاء في Todoist` + completionSuffix,
            { parse_mode: 'Markdown', reply_markup: pcKb1() }
          );
        }
      } catch (e) {
        const { createPostCompletionKeyboard: pcKb2 } = await import('../utils/keyboards');
        const completionSuffix = '\n\n💪 جاهز للمهمة الجاية؟ ابدأ بـ /starttask';
        await ctx.reply(
          `✅ **تم إكمال المهمة محلياً!**\n\n` +
          `📌 ${updatedTaskName}` + completionSuffix,
          { parse_mode: 'Markdown', reply_markup: pcKb2() }
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

      const { createPostCompletionKeyboard: pcKb3 } = await import('../utils/keyboards');
      const completionSuffix = '\n\n💪 جاهز للمهمة الجاية؟ ابدأ بـ /starttask';
      await ctx.reply(
        `✅ **تم إكمال المهمة!**\n\n` +
        `📌 ${updatedTaskName}` + completionSuffix,
        { parse_mode: 'Markdown', reply_markup: pcKb3() }
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
  // Task Session Commands (Pause/Resume)
  // ============================================

  // Pause current task and save progress
  bot.command(['resumelater', 'resume_later', 'pausetask'], async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';
      const taskKey = `active_task_${chatId}`;

      // Get active task from conversation_state
      const existingTask = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(taskKey) },
      });

      if (existingTask.length === 0) {
        await ctx.reply('❌ لا توجد مهمة نشطة لإيقافها مؤقتاً.\nاستخدم /starttask لبدء مهمة جديدة');
        return;
      }

      const taskData = (existingTask[0] as any).data || {};
      const taskName = taskData.taskName;
      const todoistTaskId = taskData.todoistTaskId;
      const pauseManualDuration = taskData.manualDuration || 0;

      // Import session manager
      const { createTaskSessionManager } = await import('../services/task-session-manager');
      const sessionMgr = createTaskSessionManager(ctx.db);

      // Check if session already exists (started via previous /starttask)
      let session = await sessionMgr.getActiveSession(chatId);

      if (!session) {
        // Create new session first, then pause it
        session = await sessionMgr.startSession(chatId, todoistTaskId || null, taskName);
      }

      // Now pause the session
      const pauseResult = await sessionMgr.pauseSession(chatId);

      // Add manual duration to session total (before active_task is deleted)
      if (pauseManualDuration > 0) {
        const newTotal = pauseResult.session.totalTimeWorked + pauseManualDuration;
        await ctx.db.update(
          'task_sessions',
          { id: op.eq(pauseResult.session.id) },
          { total_time_worked: newTotal }
        );
        pauseResult.session.totalTimeWorked = newTotal;
      }

      // Clear the active task from conversation_state
      await ctx.db.delete('conversation_state', { chat_id: op.eq(taskKey) });

      // Format time nicely
      const formatTime = (mins: number): string => {
        if (mins < 60) return `${mins} دقيقة`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        if (m === 0) return h === 1 ? 'ساعة' : `${h} ساعات`;
        return `${h} ساعة ${m} دقيقة`;
      };

      const { createPausedSessionKeyboard } = await import('../utils/keyboards');
      await ctx.reply(
        `⏸️ *تم الإيقاف المؤقت!*\n\n` +
        `📌 ${taskName}\n` +
        `⏱️ الوقت هذه الجلسة: ${formatTime(pauseResult.timeWorkedThisSession + pauseManualDuration)}\n` +
        `📊 الوقت الإجمالي: ${formatTime(pauseResult.session.totalTimeWorked)}\n` +
        `🔄 عدد الجلسات: ${pauseResult.session.sessionCount}`,
        { parse_mode: 'Markdown', reply_markup: createPausedSessionKeyboard(pauseResult.session.id) }
      );

    } catch (error) {
      console.error('Resume later error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
    await sendAutoStatus(ctx);
  });

  // Resume a paused task
  bot.command(['resumetask', 'resume_task'], async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';
      const taskKey = `active_task_${chatId}`;

      // Check if there's already an active task
      const existingActive = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(taskKey) },
      });

      if (existingActive.length > 0) {
        const taskData = (existingActive[0] as any).data || {};
        await ctx.reply(
          `⚠️ لديك مهمة نشطة بالفعل:\n📌 ${taskData.taskName}`,
          { reply_markup: createTaskStartedKeyboard() }
        );
        return;
      }

      // Get paused sessions
      const { createTaskSessionManager } = await import('../services/task-session-manager');
      const sessionMgr = createTaskSessionManager(ctx.db);
      const pausedSessions = await sessionMgr.getAllPausedSessions(chatId);

      if (pausedSessions.length === 0) {
        await ctx.reply(
          '❌ لا توجد مهام موقوفة مؤقتاً.\n\n' +
          'استخدم /starttask لبدء مهمة جديدة'
        );
        return;
      }

      // Format time nicely
      const formatTime = (mins: number): string => {
        if (mins < 60) return `${mins}د`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        if (m === 0) return `${h}س`;
        return `${h}س ${m}د`;
      };

      if (pausedSessions.length === 1) {
        // Only one paused session - offer to resume with inline keyboard
        const session = pausedSessions[0]!;
        const { createPausedSessionKeyboard } = await import('../utils/keyboards');

        const message =
          `⏸️ *مهمة موقوفة:*\n\n` +
          `📌 ${session.taskContent}\n` +
          `⏱️ الوقت المسجل: ${formatTime(session.totalTimeWorked)}\n` +
          `🔄 الجلسات: ${session.sessionCount}`;

        await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: createPausedSessionKeyboard(session.id) });
        return;
      }

      // Multiple paused sessions - show inline keyboard with each session
      const { InlineKeyboard } = await import('grammy');
      const { extractCleanTaskName } = await import('../utils/task-parser');
      const keyboard = new InlineKeyboard();
      pausedSessions.forEach((s) => {
        const cleaned = extractCleanTaskName(s.taskContent).trim();
        const displayName = cleaned.length > 30
          ? cleaned.substring(0, 27) + '...'
          : cleaned;
        keyboard.text(`▶️ ${displayName} (${formatTime(s.totalTimeWorked)})`, `session:resume:${s.id}`).row();
      });
      keyboard.text('🎯 مهمة جديدة', 'cmd:starttask');

      const message = `⏸️ *المهام الموقوفة:*\n\nاختر مهمة لاستئنافها:`;

      await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: keyboard });

    } catch (error) {
      console.error('Resume task error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
    await sendAutoStatus(ctx);
  });

  // Abandon session without saving
  bot.command(['abandonsession', 'abandon_session'], async (ctx) => {
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

      // Import session manager and abandon
      const { createTaskSessionManager } = await import('../services/task-session-manager');
      const sessionMgr = createTaskSessionManager(ctx.db);

      try {
        await sessionMgr.abandonSession(chatId);
      } catch {
        // Session might not exist, that's OK
      }

      // Delete the active task
      await ctx.db.delete('conversation_state', { chat_id: op.eq(taskKey) });

      const { InlineKeyboard: AbandonKb } = await import('grammy');
      const abandonKeyboard = new AbandonKb()
        .text('🎯 مهمة جديدة', 'cmd:starttask')
        .text('📊 تقدمي', 'cmd:progress');
      await ctx.reply(
        `🗑️ *تم إلغاء الجلسة*\n\n` +
        `📌 ${taskData.taskName}\n\n` +
        `⚠️ لم يتم حفظ أي وقت لهذه الجلسة.`,
        { parse_mode: 'Markdown', reply_markup: abandonKeyboard }
      );

    } catch (error) {
      console.error('Abandon session error:', error);
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
  due?: { date: string; is_recurring?: boolean; recurring?: boolean } | null,
  parentInfo?: { parent_id: string | null; parent_content: string | null; is_subtask: boolean; priority?: number }
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
      parent_id: parentInfo?.parent_id || null,
      parent_content: parentInfo?.parent_content || null,
      priority: parentInfo?.priority || 1,
      is_subtask: parentInfo?.is_subtask || false,
      description: 'Manual failure logged via /log_failure',
      is_manual: true,
      is_pending: false, // Manual = confirmed failed
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

    // Trigger battle mode boss healing (fire-and-forget)
    const chatId = ctx.chat?.id.toString();
    const botToken = ctx.env?.TELEGRAM_BOT_TOKEN || (await ctx.settings.get('telegram_bot_token'));
    if (chatId && botToken) {
      const { triggerOnTaskFailed } = await import('../handlers/todoist');
      triggerOnTaskFailed(cleanName, chatId, botToken, ctx.db, ctx.settings, 1).catch((e) =>
        console.error('triggerOnTaskFailed error:', e)
      );
    }

    const isRecurring = due?.is_recurring || due?.recurring || false;

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
          `https://api.todoist.com/api/v1/tasks/${todoistTaskId}/close`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
          }
        );

        const failureSuffix = '\n\n💪 جاهز للمهمة الجاية؟ ابدأ بـ /starttask';
        if (closeResponse.ok) {
          if (isRecurring) {
            await ctx.reply(
              `✅ تم تسجيل الفشل:\n` +
              `❌ ${taskName}\n\n` +
              `🔄 تم تأجيل المهمة للموعد التالي في Todoist\n` +
              `💾 تم تسجيل الفشل في قاعدة البيانات` + failureSuffix
            );
          } else {
            await ctx.reply(
              `✅ تم تسجيل الفشل:\n` +
              `❌ ${taskName}\n\n` +
              `🗑️ تم إزالة المهمة من Todoist\n` +
              `💾 تم تسجيل الفشل في قاعدة البيانات` + failureSuffix
            );
          }
        } else {
          console.error(`Failed to close task in Todoist: ${closeResponse.status}`);
          await ctx.reply(
            `✅ تم تسجيل الفشل:\n` +
            `❌ ${taskName}\n\n` +
            `⚠️ فشل إغلاق المهمة في Todoist\n` +
            `💾 تم تسجيل الفشل في قاعدة البيانات` + failureSuffix
          );
        }
      } else {
        const failureSuffixElse = '\n\n💪 جاهز للمهمة الجاية؟ ابدأ بـ /starttask';
        await ctx.reply(
          `✅ تم تسجيل الفشل:\n` +
          `❌ ${taskName}\n\n` +
          `ستظهر في تقرير اليوم` + failureSuffixElse
        );
      }
    } else {
      // No Todoist task (manual entry)
      const failureSuffixManual = '\n\n💪 جاهز للمهمة الجاية؟ ابدأ بـ /starttask';
      await ctx.reply(
        `✅ تم تسجيل الفشل:\n` +
        `❌ ${taskName}\n\n` +
        `ستظهر في تقرير اليوم` + failureSuffixManual
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
    console.log(`🚫 Rate limited: ${commandName} for chat ${chatId} (${now - lastRun}ms since last)`);
    return false;
  }
  coachCommandCooldowns.set(cooldownKey, now);

  // DB idempotency check
  const idempotencyKey = `coach_${commandName}_${updateId}`;
  console.log(`🔑 Idempotency check: ${idempotencyKey}`);

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

    console.log(`✅ Idempotency passed for ${commandName}`);
    return true;
  } catch (err) {
    console.error(`⚠️ Idempotency check error for ${commandName}:`, err);
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

    // Get Todoist credentials for task recommendation
    const todoistToken = await ctx.settings.get('todoist_api_token');
    const projectId = await ctx.settings.get('todoist_project_id');

    // Run in background
    const backgroundTask = (async () => {
      try {
        console.log('🚨 Starting stuck intervention for chat:', chatId);
        const aiClient = createAIClient(apiKey, aiModel);
        console.log('✅ AI client created');
        const stuckHandler = createStuckHandler(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));
        console.log('✅ Stuck handler created, starting intervention...');

        // Try task recommendation first if Todoist is configured
        if (todoistToken) {
          console.log('🎯 Attempting task recommendation with Todoist...');
          const result = await stuckHandler.startInterventionWithRecommendation(chatId, todoistToken, projectId || undefined);
          console.log('✅ Intervention with recommendation generated');

          // If we got a recommendation, set conversation state
          if (result.recommendation) {
            await ctx.db.delete('conversation_state', { chat_id: op.eq(chatId) }).catch(() => {});
            await ctx.db.insert('conversation_state', {
              chat_id: chatId,
              conversation_type: 'stuck_recommendation',
              current_step: 1,
              data: { recommendation: result.recommendation },
              expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            });
          }

          await sendTelegramMessageDirect(botToken, chatId, result.message);
        } else {
          // Fall back to regular intervention without recommendation
          console.log('⚠️ No Todoist token, using regular intervention');
          const response = await stuckHandler.startIntervention(chatId);
          console.log('✅ Intervention response generated:', response.substring(0, 100) + '...');
          await sendTelegramMessageDirect(botToken, chatId, response);
        }
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

// /coach_check - Manually trigger meta-coach check
bot.command('coach_check', async (ctx) => {
  try {
    console.log('🔍 coach_check command received');
    if (!(await checkCoachIdempotency(ctx, 'coach_check'))) {
      console.log('🚫 coach_check blocked by idempotency');
      return;
    }
    console.log('✅ coach_check passed idempotency');

    const chatId = ctx.chat?.id.toString() || '';

    // Guard: block only when user has active task session or report Q&A in progress (DB state)
    const blockResult = await isUserInTaskOrReportFlow(ctx.db, chatId);
    if (blockResult.blocked) {
      console.log(`🐛 Coach send blocked: ${blockResult.reason ?? 'unknown'}`);
      await ctx.reply('⚠️ انت حالياً في مهمة أو تحليل تقرير. خلّص الأول وبعدين نفّذ /coach_check');
      return;
    }
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
    const apiKey = await ctx.settings.get('openrouter_api_key');
    if (!apiKey) {
      await ctx.reply('❌ لم يتم تكوين مفتاح AI.');
      return;
    }

    // Check for force mode: /coach_check force
    const forceMode = ctx.message?.text?.toLowerCase().includes('force');

    await ctx.reply(forceMode ? '🔍 جاري تحليل الحالة (وضع إجباري)...' : '🔍 جاري تحليل الحالة...');

    // Get low-tier model for meta-coach
    const aiModel = await getAIModelByTier(ctx.settings, 'low');

    // Run in background
    const backgroundTask = (async () => {
      try {
        console.log('🔍 coach_check background task started');
        const aiClient = createAIClient(apiKey, aiModel);
        const metaCoach = createMetaCoach(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max), ctx.env.TELEGRAM_BOT_TOKEN);

        // Analyze user state
        console.log('🔍 Analyzing user state...');
        const userState = await metaCoach.analyzeUserState(chatId);
        console.log(`🔍 User state: hour=${userState.currentHour}, inactive=${userState.hoursInactive.toFixed(1)}h, timeOfDay=${userState.timeOfDay}`);

        // Decide intervention
        let decision = await metaCoach.decideIntervention(userState);
        console.log(`🔍 Decision: ${decision.type}, escalation=${decision.escalationLevel}`);

        // Force mode: override 'none' with momentum_check
        if (forceMode && decision.type === 'none') {
          console.log('🔍 Force mode: overriding none → momentum_check');
          decision = { type: 'momentum_check', message: '', escalationLevel: 1, followUpDelay: 90 };
        }

        // Map intervention types to Arabic
        const typeNames: Record<string, string> = {
          'morning_kickoff': 'بداية الصباح',
          'midday_push': 'دفعة نص اليوم',
          'evening_check': 'مراجعة المساء',
          'momentum_check': 'متابعة الزخم',
          'night_wrapup': 'ختام اليوم',
          'inactivity_nudge': 'تنبيه خمول',
          'escalation': 'تصعيد',
          'battle_narrative': 'سرد معركة',
          'none': 'لا شيء',
        };

        const timeOfDayArabic: Record<string, string> = {
          'morning': 'الصبح',
          'afternoon': 'الضهر',
          'evening': 'المساء',
          'night': 'الليل',
        };

        // Show state analysis
        let stateMsg = `📊 تحليل الحالة\n\n`;
        stateMsg += `🕐 الساعة: ${userState.currentHour}:00 (${timeOfDayArabic[userState.timeOfDay] || userState.timeOfDay})\n`;
        stateMsg += `⏰ ساعات بدون نشاط: ${userState.hoursInactive.toFixed(1)}\n`;
        stateMsg += `✅ مهام مكتملة اليوم: ${userState.tasksCompletedToday}\n`;
        stateMsg += `❌ مهام فاشلة: ${userState.tasksFailed}\n`;
        stateMsg += `📨 تدخلات اليوم: ${userState.interventionsToday}\n`;
        stateMsg += `⏱️ آخر تدخل: ${userState.minutesSinceLastIntervention.toFixed(0)} دقيقة\n`;
        if (userState.activeTaskSession) {
          stateMsg += `🎯 مهمة نشطة: ${userState.activeTaskSession.taskContent}\n`;
        }
        stateMsg += `\n━━━━━━━━━━━━━━━━━━\n`;
        stateMsg += `🎯 القرار: ${typeNames[decision.type] || decision.type}`;
        if (forceMode) stateMsg += ' (إجباري)';
        if (decision.escalationLevel > 0) {
          stateMsg += ` (مستوى ${decision.escalationLevel})`;
        }

        console.log('🔍 Sending state message...');
        await sendTelegramMessageDirect(botToken, chatId, stateMsg);
        console.log('🔍 State message sent');

        if (decision.type !== 'none') {
          console.log(`🔍 Executing intervention: ${decision.type}`);
          let message = await metaCoach.executeIntervention(chatId, decision, userState);
          console.log(`🔍 Intervention generated, length=${message.length}`);

          // Check-in window from settings (minutes) for "متبقي X دقائق للرد"
          const windowMinutes = Math.max(1, parseInt(await ctx.settings.get('coach.checkin_window_minutes') || '10', 10) || 10);
          message = `${message}\n\nمتبقي ${windowMinutes} دقائق للرد 🕐`;

          // Send with interactive keyboard
          const coachKeyboard = {
            inline_keyboard: [
              [
                { text: '▶️ ابدأ مهمة', callback_data: 'coach:start_task' },
                { text: '📅 خطة اليوم', callback_data: 'cmd:plan' },
              ],
              [
                { text: '💬 احكيلي', callback_data: 'coach:talk' },
                { text: '😴 تعبان', callback_data: 'coach:tired' },
                { text: '⏸️ مشغول', callback_data: 'coach:busy' },
              ],
              [
                { text: '🔥 احرقني', callback_data: 'cmd:roast' },
                { text: '⚔️ معركة', callback_data: 'cmd:battle' },
              ],
            ],
          };
          await sendTelegramMessageDirect(botToken, chatId, message, 'Markdown', coachKeyboard);

          // Create pending check-in so text responses are handled
          const coachingAnalytics = createCoachingAnalytics(ctx.db);
          await coachingAnalytics.createPendingCheckin(chatId, decision.type, windowMinutes);
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

// /coach_settings - Show current coach settings
bot.command('coach_settings', async (ctx) => {
  try {
    if (!(await checkCoachIdempotency(ctx, 'coach_settings'))) return;

    // Get settings directly
    const [mode, threshold, sleepStart, sleepEnd, checkins, style] = await Promise.all([
      ctx.settings.get('coach.auto_mode'),
      ctx.settings.get('coach.inactivity_threshold_hours'),
      ctx.settings.get('coach.sleep_start'),
      ctx.settings.get('coach.sleep_end'),
      ctx.settings.get('coach.scheduled_checkins'),
      ctx.settings.get('coach.style'),
    ]);

    const config = {
      mode: mode || 'hybrid',
      inactivityThresholdHours: threshold ? parseFloat(threshold) : 2,
      sleepStart: sleepStart || '23:00',
      sleepEnd: sleepEnd || '07:00',
      scheduledCheckins: checkins ? checkins.split(',').map((t: string) => t.trim()) : ['10:00', '14:00', '18:00'],
      style: style || 'confrontational',
    };

    const modeEmoji: Record<string, string> = {
      'off': '⏹️',
      'scheduled': '📅',
      'inactivity': '⏰',
      'hybrid': '🔄',
    };

    const styleEmoji: Record<string, string> = {
      'confrontational': '🔥',
      'supportive': '💚',
      'balanced': '⚖️',
    };

    const sleepEndHour = parseInt(config.sleepEnd.split(':')[0] || '7', 10);

    const settingsMsg = `⚙️ إعدادات الكوتش الذكي

${modeEmoji[config.mode] || '❓'} الوضع: ${config.mode}
${styleEmoji[config.style] || '❓'} الأسلوب: ${config.style}

⏰ عتبة الخمول: ${config.inactivityThresholdHours} ساعة
😴 فترة النوم: ${config.sleepStart} - ${config.sleepEnd}

━━━━━━━━━━━━━━━━
📅 جدول التدخلات:

☀️ بداية الصباح: ${sleepEndHour}:00 - 10:00
⚡ دفعة نص اليوم: 12:00 - 14:00
🌆 مراجعة المساء: 18:00 - 20:00
🌙 ختام اليوم: 21:00 - ${config.sleepStart}
👀 متابعة الزخم: كل ${config.inactivityThresholdHours} ساعة
📢 تنبيه خمول: بعد ${config.inactivityThresholdHours} ساعة بدون نشاط
💪 احتفال: بعد كل مهمة

━━━━━━━━━━━━━━━━
💡 للتعديل استخدم /set:
• coach.auto_mode (off/hybrid)
• coach.style (confrontational/supportive/balanced)
• coach.inactivity_threshold_hours
• coach.sleep_start / coach.sleep_end`;

    await ctx.reply(settingsMsg);

  } catch (error) {
    console.error('Coach settings error:', error);
    await ctx.reply('❌ حدث خطأ');
  }
});

// /coach_summary - Show today's coaching interactions summary
bot.command('coach_summary', async (ctx) => {
  try {
    if (!(await checkCoachIdempotency(ctx, 'coach_summary'))) return;

    const chatId = ctx.chat?.id.toString() || '';
    const today = getTodayInEgypt();

    // Get today's coaching interactions
    const interactions = await ctx.db.select('coaching_interactions', {
      filter: {
        chat_id: op.eq(chatId),
        interaction_date: op.eq(today),
      },
      order: 'timestamp.desc',
      limit: 20,
    });

    if (interactions.length === 0) {
      await ctx.reply('📊 لا توجد تفاعلات كوتشنج اليوم.');
      return;
    }

    // Count by type and outcome
    const stats = {
      total: interactions.length,
      byType: new Map<string, number>(),
      byOutcome: { positive: 0, negative: 0, pending: 0 },
    };

    for (const interaction of interactions) {
      const type = (interaction.interaction_type as string) || 'unknown';
      stats.byType.set(type, (stats.byType.get(type) || 0) + 1);

      const outcome = (interaction.outcome as string) || 'pending';
      if (outcome === 'positive') stats.byOutcome.positive++;
      else if (outcome === 'negative') stats.byOutcome.negative++;
      else stats.byOutcome.pending++;
    }

    // Map intervention types to readable Arabic names
    const typeNames: Record<string, string> = {
      'meta_coach': 'كوتش تلقائي',
      'morning_kickoff': 'بداية الصباح',
      'midday_push': 'دفعة نص اليوم',
      'evening_check': 'مراجعة المساء',
      'momentum_check': 'متابعة الزخم',
      'night_wrapup': 'ختام اليوم',
      'inactivity_nudge': 'تنبيه خمول',
      'escalation': 'تصعيد',
      'celebration': 'احتفال',
      'battle_narrative': 'سرد معركة',
      'stuck': 'وضع عالق',
      'roast': 'إحراق',
    };

    let summaryMsg = `📈 ملخص كوتشنج اليوم\n\n`;
    summaryMsg += `📊 إجمالي التفاعلات: ${stats.total}\n\n`;

    summaryMsg += `حسب النوع:\n`;
    for (const [type, count] of stats.byType) {
      const displayName = typeNames[type] || type.replace(/_/g, ' ');
      summaryMsg += `• ${displayName}: ${count}\n`;
    }

    summaryMsg += `\nحسب النتيجة:\n`;
    summaryMsg += `✅ إيجابي: ${stats.byOutcome.positive}\n`;
    summaryMsg += `❌ سلبي: ${stats.byOutcome.negative}\n`;
    summaryMsg += `⏳ معلق: ${stats.byOutcome.pending}`;

    await ctx.reply(summaryMsg);

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

    await ctx.reply('🌙 Starting auto-fail...');

    const chatId = ctx.chat?.id.toString() || '';
    const botToken = ctx.env.TELEGRAM_BOT_TOKEN;

    // Use unified autofail service
    const autofailService = createAutofailService(ctx.db, ctx.settings);

    // Prepare autofail (forceRun = true to bypass time check)
    const result = await autofailService.prepareAutofail(botToken, chatId, true);

    // Check if it's an error result
    if ('triggered' in result) {
      if (!result.triggered) {
        await ctx.reply(`⏭️ ${result.reason}`);
        return;
      }
      if (result.taskCount === 0) {
        await ctx.reply('✅ No tasks to auto-fail!');
        return;
      }
    }

    const data = result as PreparedAutofailData;

    // Get Durable Object stub
    const jobId = autofailService.getJobId(data.today);
    const id = ctx.reportProcessorNamespace.idFromName(jobId);
    const stub = ctx.reportProcessorNamespace.get(id);

    // Check if already running
    const alreadyRunning = await autofailService.isAlreadyRunning(stub, data.today);
    if (alreadyRunning) {
      await ctx.reply('⏭️ Auto-fail already running for today');
      return;
    }

    // Initialize queue
    await autofailService.initializeQueue(stub, data);

    await ctx.reply(
      `✅ Processing started!\n\n` +
      `📋 ${data.allTasks.length} tasks (${data.highPriorityTasks.length} tracked)\n\n` +
      `Progress updates every 20 tasks.`
    );

    // Start alarm-based processing (reliable, no timeout)
    await autofailService.startAlarmProcessing(stub, data.today);

  } catch (error) {
    console.error('Autofail command error:', error);
    await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
  }
});

// ============================================
// PHASE 2: INTERACTIVE FEATURES
// ============================================

// /quick - Quick 5-minute mode (low commitment)
bot.command(['quick', 'q'], async (ctx) => {
  try {
    const chatId = ctx.chat?.id.toString() || '';
    const taskKey = `active_task_${chatId}`;

    // Check if there's already an active task
    const existingTask = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(taskKey) },
    });

    if (existingTask.length > 0) {
      await ctx.reply(
        '⚠️ لديك مهمة نشطة بالفعل.\n' +
        'استخدم /completetask أو /resumelater أولاً.'
      );
      return;
    }

    // Get available tasks from Todoist
    const todoistToken = await ctx.settings.get('todoist_api_token');
    const todoistProjectId = await ctx.settings.get('todoist_project_id');

    if (!todoistToken || !todoistProjectId) {
      await ctx.reply(
        '⏱️ **وضع الـ 5 دقايق**\n\n' +
        'اكتب اسم المهمة اللي عايز تشتغل عليها 5 دقايق بس:',
        { parse_mode: 'Markdown' }
      );

      // Store quick mode state
      await ctx.db.insert('conversation_state', {
        chat_id: `quick_mode_${chatId}`,
        conversation_type: 'quick_mode_input',
        data: { durationMinutes: 5 },
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      return;
    }

    // Show quick mode keyboard with duration options
    const keyboard = createQuickModeKeyboard();
    await ctx.reply(
      '⏱️ **وضع الالتزام السريع**\n\n' +
      'اختر المدة - ابدأ بحاجة صغيرة خالص!\n' +
      'الهدف هو إنك تبدأ، مش إنك تخلص.',
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );

  } catch (error) {
    console.error('Quick mode error:', error);
    await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
  }
});

// /streak - View streak and points
bot.command(['streak', 'streaks', 'points'], async (ctx) => {
  try {
    const chatId = ctx.chat?.id.toString() || '';
    const celebrationsService = createCelebrationsService(ctx.db);
    const streakInfo = await celebrationsService.getStreakInfo(chatId);

    await ctx.reply(streakInfo, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Streak command error:', error);
    await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
  }
});

// /mood - Set current mood for adaptive coaching
bot.command('mood', async (ctx) => {
  try {
    const keyboard = createMoodKeyboard();
    await ctx.reply(
      '🔋 **إيه حالتك دلوقتي؟**\n\n' +
      'ده بيساعدني أقدم لك اقتراحات مناسبة.',
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
  } catch (error) {
    console.error('Mood command error:', error);
    await ctx.reply('❌ حدث خطأ');
  }
});

// ============================================
// Callback Query Handlers (Inline Keyboards)
// ============================================

bot.callbackQuery(/^coach:/, async (ctx) => {
  try {
    const chatId = ctx.chat?.id.toString() || '';
    const action = ctx.callbackQuery.data.replace('coach:', '');
    const coachingAnalytics = createCoachingAnalytics(ctx.db);

    switch (action) {
      case 'start_task': {
        const contextBuilder = createCoachingContextBuilder(ctx.db, ctx.settings);
        await contextBuilder.updateLatestMetaCoachUserInput(chatId, '▶️ ابدأ مهمة').catch(() => {});
        await coachingAnalytics.recordActionTaken(chatId, 'starttask');
        await ctx.answerCallbackQuery('🎯 يلا نبدأ!');
        const shown = await showTaskSelection(ctx as BotContext);
        if (!shown) {
          await ctx.reply('📋 استخدم /starttask للبدء');
        }
        break;
      }

      case 'busy': {
        const contextBuilder = createCoachingContextBuilder(ctx.db, ctx.settings);
        await contextBuilder.updateLatestMetaCoachUserInput(chatId, 'مشغول').catch(() => {});
        await coachingAnalytics.completeCheckin(chatId, false);
        await ctx.answerCallbackQuery('👍 تمام');
        await ctx.reply('تمام، هفكرك بعد شوية! 💪');
        break;
      }

      case 'talk': {
        await ctx.answerCallbackQuery('💬 احكيلي');
        // Show duration selection keyboard
        const { createTalkDurationKeyboard } = await import('../utils/keyboards');
        await ctx.reply('💬 كام دقيقة عايز نتكلم؟', { reply_markup: createTalkDurationKeyboard() });
        break;
      }

      case 'tired': {
        const contextBuilder = createCoachingContextBuilder(ctx.db, ctx.settings);
        await contextBuilder.updateLatestMetaCoachUserInput(chatId, 'تعبان').catch(() => {});
        await coachingAnalytics.setUserMood(chatId, 'low');
        await ctx.answerCallbackQuery('💙 معلش');
        await ctx.reply(
          '💙 معلش، كلنا بنتعب.\n\n' +
          'ممكن نبدأ بحاجة صغيرة خالص - 5 دقايق بس؟',
          { reply_markup: createQuickModeKeyboard() }
        );
        break;
      }

      case 'here':
        await ctx.answerCallbackQuery('👋 أهلاً!');
        await ctx.reply('👋 حمد لله! يلا نشتغل؟', { reply_markup: createCoachCheckInKeyboard() });
        break;

      case 'remind_later': {
        const contextBuilder = createCoachingContextBuilder(ctx.db, ctx.settings);
        await contextBuilder.updateLatestMetaCoachUserInput(chatId, '⏸️ مشغول / هفكرك بعدين').catch(() => {});
        await coachingAnalytics.completeCheckin(chatId, false);
        await ctx.answerCallbackQuery('⏰ هفكرك');
        await ctx.reply('⏰ تمام، هفكرك بعد نص ساعة!');
        break;
      }

      case 'motivate':
        await ctx.answerCallbackQuery('💪');
        await ctx.reply('💪 انت قدها وقدود! كل مهمة تخلصها بتقربك لأهدافك. يلا نضرب!');
        break;

      case 'suggest': {
        await ctx.answerCallbackQuery('📋');
        const suggestShown = await showTaskSelection(ctx as BotContext);
        if (!suggestShown) {
          await ctx.reply('📋 استخدم /starttask للبدء');
        }
        break;
      }

      case 'end':
        await coachingAnalytics.completeCheckin(chatId, false);
        // Clean up any active talk session
        const talkEndKey = `talk_session_${chatId}`;
        await ctx.db.delete('conversation_state', { chat_id: op.eq(talkEndKey) });
        await ctx.answerCallbackQuery('👍');
        await ctx.reply('تمام! لما تكون جاهز، أنا هنا 💪');
        break;
    }
  } catch (error) {
    console.error('Coach callback error:', error);
    await ctx.answerCallbackQuery('❌ حدث خطأ');
  }
});

// ============================================
// Talk Duration Selection Handler
// ============================================
bot.callbackQuery(/^talk_dur:/, async (ctx) => {
  const bctx = ctx as any as BotContext;
  const chatId = ctx.chat?.id.toString() || '';
  const duration = parseInt(ctx.callbackQuery.data.replace('talk_dur:', ''), 10);
  if (isNaN(duration) || duration < 5) {
    await ctx.answerCallbackQuery('❌ مدة غير صحيحة');
    return;
  }

  const botToken = bctx.env.TELEGRAM_BOT_TOKEN;
  const durationLabel = duration === 1 ? 'دقيقة' : duration <= 10 ? `${duration} دقايق` : `${duration} دقيقة`;

  // Answer callback immediately
  await ctx.answerCallbackQuery(`💬 ${durationLabel}`);

  // Send start notification
  try {
    await sendTelegramMessageDirect(botToken, chatId,
      `💬 بدأت جلسة محادثة - ${durationLabel}\n⏱️ هتنتهي تلقائياً بعد ${durationLabel}\n\nاستنى الكوتش يبدأ الكلام...`);
  } catch (err) {
    console.error('Talk start notification error:', err);
  }

  try {
    const coachingAnalytics = createCoachingAnalytics(bctx.db);
    const maxTurns = duration; // ~1 turn per minute

    // Create pending checkin with the chosen duration
    await coachingAnalytics.createPendingCheckin(chatId, 'momentum_check', duration);

    // Store talk session state (delete old + insert new, no unique constraint on chat_id)
    const sessionKey = `talk_session_${chatId}`;
    await bctx.db.delete('conversation_state', { chat_id: op.eq(sessionKey) }).catch(() => {});
    await bctx.db.insert('conversation_state', {
      chat_id: sessionKey,
      conversation_type: 'coach_talk',
      data: {
        duration,
        maxTurns,
        currentTurn: 0,
        history: [],
        startedAt: new Date().toISOString(),
      },
      expires_at: new Date(Date.now() + duration * 60 * 1000).toISOString(),
    });

    // Generate AI opening message in background to avoid timeout
    const apiKey = await bctx.settings.get('openrouter_api_key');
    if (apiKey && botToken) {
      const backgroundTask = (async () => {
        try {
          const aiModel = await getAIModelByTier(bctx.settings, 'low');
          const aiClient = createAIClient(apiKey, aiModel);
          const metaCoach = createMetaCoach(bctx.db, bctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max), bctx.env.TELEGRAM_BOT_TOKEN);

          const opener = await metaCoach.generateTalkOpener(chatId, duration);
          const openerWithTime = `${opener}\n\n⏱️ المدة: ${durationLabel}`;
          const keyboard = {
            inline_keyboard: [
              [{ text: '🔚 إنهاء المحادثة', callback_data: 'coach:end' }],
            ]
          };
          await sendTelegramMessageDirect(botToken, chatId, openerWithTime, undefined, keyboard);
        } catch (err) {
          console.error('Talk opener generation error:', err);
          await sendTelegramMessageDirect(botToken, chatId, '💬 احكيلي... إيه اللي شاغلك؟');
        }
      })();

      if (bctx.executionContext?.waitUntil) {
        bctx.executionContext.waitUntil(backgroundTask);
      } else {
        await backgroundTask;
      }

      // Schedule end-of-session notification
      const endNotification = (async () => {
        try {
          // Wait for the session duration
          await new Promise(resolve => setTimeout(resolve, duration * 60 * 1000));

          // Check if session is still active
          const sessions = await bctx.db.select('conversation_state', {
            filter: { chat_id: op.eq(sessionKey) },
            limit: 1,
          });

          if (sessions.length > 0 && (sessions[0] as any).conversation_type === 'coach_talk') {
            // Session still active — clean up and notify
            await bctx.db.delete('conversation_state', { chat_id: op.eq(sessionKey) });
            const ca = createCoachingAnalytics(bctx.db);
            await ca.completeCheckin(chatId, true);

            const keyboard = {
              inline_keyboard: [
                [{ text: '▶️ ابدأ مهمة', callback_data: 'coach:start_task' }, { text: '📅 خطة اليوم', callback_data: 'cmd:plan' }],
                [{ text: '💬 احكيلي', callback_data: 'coach:talk' }, { text: '😴 تعبان', callback_data: 'coach:tired' }, { text: '⏸️ مشغول', callback_data: 'coach:busy' }],
                [{ text: '🔥 احرقني', callback_data: 'cmd:roast' }, { text: '⚔️ معركة', callback_data: 'cmd:battle' }],
              ]
            };
            await sendTelegramMessageDirect(botToken, chatId, `⏰ انتهى وقت المحادثة (${durationLabel})!\n\nيلا نبدأ شغل؟ 💪`, undefined, keyboard);
          }
        } catch (err) {
          console.error('Talk end notification error:', err);
        }
      })();

      if (bctx.executionContext?.waitUntil) {
        bctx.executionContext.waitUntil(endNotification);
      }
    } else {
      await ctx.reply('💬 احكيلي... إيه اللي شاغلك؟');
    }
  } catch (error) {
    console.error('Talk duration setup error:', error);
    await sendTelegramMessageDirect(botToken, chatId, '❌ حصل مشكلة في بدء المحادثة. جرب تاني.');
  }
});

bot.callbackQuery(/^mood:/, async (ctx) => {
  try {
    const chatId = ctx.chat?.id.toString() || '';
    const mood = ctx.callbackQuery.data.replace('mood:', '') as 'high' | 'normal' | 'low';
    const coachingAnalytics = createCoachingAnalytics(ctx.db);

    await coachingAnalytics.setUserMood(chatId, mood);

    const responses: Record<string, string> = {
      high: '⚡ حلو! خلينا نستغل الطاقة دي. استخدم /starttask',
      normal: '👍 تمام، يلا نشتغل! استخدم /starttask',
      low: '💙 معلش، نبدأ بحاجة صغيرة؟ استخدم /quick',
    };

    await ctx.answerCallbackQuery(mood === 'high' ? '⚡' : mood === 'low' ? '💙' : '👍');
    await ctx.editMessageText(responses[mood] || 'تمام!');

  } catch (error) {
    console.error('Mood callback error:', error);
    await ctx.answerCallbackQuery('❌ حدث خطأ');
  }
});

bot.callbackQuery(/^quick:/, async (ctx) => {
  try {
    const chatId = ctx.chat?.id.toString() || '';
    const action = ctx.callbackQuery.data.replace('quick:', '');

    if (action === 'extend') {
      // Extend quick mode by 5 more minutes
      await ctx.answerCallbackQuery('🔥 كمّل!');
      await ctx.reply('🔥 كده الكلام! كمّل شوية كمان!\n\nلما تخلص استخدم /completetask');
      return;
    }

    const duration = parseInt(action, 10);
    if (isNaN(duration)) return;

    await ctx.answerCallbackQuery(`⏱️ ${duration} دقيقة`);

    // Store quick mode pending task selection
    await ctx.db.insert('conversation_state', {
      chat_id: `quick_mode_${chatId}`,
      conversation_type: 'quick_mode_input',
      data: { durationMinutes: duration },
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    await ctx.editMessageText(
      `⏱️ **جلسة ${duration} دقايق**\n\n` +
      'اكتب اسم المهمة اللي عايز تشتغل عليها:',
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('Quick callback error:', error);
    await ctx.answerCallbackQuery('❌ حدث خطأ');
  }
});

bot.callbackQuery(/^cmd:/, async (ctx) => {
  try {
    const command = ctx.callbackQuery.data.replace('cmd:', '');
    const chatId = ctx.chat?.id.toString() || '';
    const botToken = (ctx as any as BotContext).env.TELEGRAM_BOT_TOKEN;

    switch (command) {
      case 'starttask':
      case 'tasks': {
        await ctx.answerCallbackQuery('🎯 يلا نبدأ!');
        const shown = await showTaskSelection(ctx as any as BotContext);
        if (!shown) {
          await ctx.reply('📋 استخدم /starttask للبدء');
        }
        break;
      }

      case 'roast': {
        await ctx.answerCallbackQuery('🔥 جاري التحليل...');
        await ctx.reply('🔥 جاري تحليل أنماط التسويف...');

        const backgroundRoast = (async () => {
          try {
            const apiKey = await (ctx as any as BotContext).settings.get('openrouter_api_key');
            if (!apiKey) { await sendTelegramMessageDirect(botToken, chatId, '❌ لم يتم تكوين مفتاح AI.'); return; }
            const aiModel = await getAIModelByTier((ctx as any as BotContext).settings, 'low');
            const aiClient = createAIClient(apiKey, aiModel);
            const roastMode = createRoastMode((ctx as any as BotContext).db, (ctx as any as BotContext).settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));
            const result = await roastMode.generateRoast(chatId);
            await sendTelegramMessageDirect(botToken, chatId, `${result.roast}${result.encouragement}`);
          } catch (error) {
            console.error('Roast callback error:', error);
            await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ في التحليل');
          }
        })();

        if ((ctx as any as BotContext).executionContext?.waitUntil) {
          (ctx as any as BotContext).executionContext!.waitUntil(backgroundRoast);
        } else {
          await backgroundRoast;
        }
        break;
      }

      case 'battle': {
        await ctx.answerCallbackQuery('⚔️ جاري التحضير...');
        await ctx.reply('⚔️ جاري تحضير المعركة...');

        const backgroundBattle = (async () => {
          try {
            const apiKey = await (ctx as any as BotContext).settings.get('openrouter_api_key');
            if (!apiKey) { await sendTelegramMessageDirect(botToken, chatId, '❌ لم يتم تكوين مفتاح AI.'); return; }
            const aiModel = await getAIModelByTier((ctx as any as BotContext).settings, 'low');
            const aiClient = createAIClient(apiKey, aiModel);
            const battleMode = createBattleMode((ctx as any as BotContext).db, (ctx as any as BotContext).settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));
            const { message } = await battleMode.startBattle(chatId);
            await sendTelegramMessageDirect(botToken, chatId, message);
          } catch (error) {
            console.error('Battle callback error:', error);
            await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ في تحضير المعركة');
          }
        })();

        if ((ctx as any as BotContext).executionContext?.waitUntil) {
          (ctx as any as BotContext).executionContext!.waitUntil(backgroundBattle);
        } else {
          await backgroundBattle;
        }
        break;
      }

      case 'plan': {
        await ctx.answerCallbackQuery('📅 جاري الإعداد...');
        await ctx.reply('🤖 جاري إعداد خطة اليوم بالذكاء الاصطناعي...\n⏳ قد يستغرق هذا بضع ثوان...');

        const backgroundPlan = (async () => {
          try {
            const today = getTodayInEgypt();
            const planMessage = await generateDailyPlan(ctx as any as BotContext, today, true);
            await sendTelegramMessageDirect(botToken, chatId, planMessage);
          } catch (error) {
            console.error('Plan callback error:', error);
            await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ في إعداد الخطة');
          }
        })();

        if ((ctx as any as BotContext).executionContext?.waitUntil) {
          (ctx as any as BotContext).executionContext!.waitUntil(backgroundPlan);
        } else {
          await backgroundPlan;
        }
        break;
      }

      case 'progress': {
        await ctx.answerCallbackQuery('📊 جاري التحميل...');
        try {
          const today = getTodayInEgypt();
          try { await syncFailuresFromTodoist(today, (ctx as any as BotContext).db, (ctx as any as BotContext).settings); } catch (_e) { /* continue */ }
          const reportGen = createReportGenerator((ctx as any as BotContext).db, (ctx as any as BotContext).settings);
          const preview = await reportGen.generatePreview();
          await sendLongMessage(ctx, preview.formatted_text);
        } catch (error) {
          console.error('Progress callback error:', error);
          await ctx.reply('❌ حدث خطأ أثناء إعداد الملخص');
        }
        break;
      }

      case 'streak': {
        await ctx.answerCallbackQuery('🏆');
        try {
          const celebrationsService = createCelebrationsService((ctx as any as BotContext).db);
          const streakInfo = await celebrationsService.getStreakInfo(chatId);
          await ctx.reply(streakInfo, { parse_mode: 'Markdown' });
        } catch (error) {
          console.error('Streak callback error:', error);
          await ctx.reply('❌ حدث خطأ');
        }
        break;
      }

      default:
        await ctx.answerCallbackQuery();
        break;
    }

  } catch (error) {
    console.error('Command callback error:', error);
    await ctx.answerCallbackQuery('❌ حدث خطأ');
  }
});

bot.callbackQuery(/^session:/, async (ctx) => {
  try {
    const chatId = ctx.chat?.id.toString() || '';
    const parts = ctx.callbackQuery.data.split(':');
    const action = parts[1];
    const sessionId = parts[2];

    const { createTaskSessionManager } = await import('../services/task-session-manager');
    const sessionMgr = createTaskSessionManager(ctx.db);
    const taskKey = `active_task_${chatId}`;

    switch (action) {
      case 'complete': {
        // Actually complete the task
        await ctx.answerCallbackQuery('✅ جاري الإكمال...');

        const existingTask = await ctx.db.select('conversation_state', {
          filter: { chat_id: op.eq(taskKey) },
        });

        if (existingTask.length === 0) {
          await ctx.editMessageText('❌ لا توجد مهمة نشطة');
          return;
        }

        const taskData = (existingTask[0] as any).data || {};
        const startTime = taskData.startTime;
        const taskName = taskData.taskName;
        const todoistTaskId = taskData.todoistTaskId;
        const startDate = taskData.startDate || getTodayInEgypt();
        const manualDuration = taskData.manualDuration;
        const manualQuantity = taskData.manualQuantity;
        const manualQuantityUnit = taskData.manualQuantityUnit;
        const previousTimeWorked = taskData.previousTimeWorked || 0;

        // Calculate duration (elapsed + previous sessions + manual additions)
        const elapsedMinutes = startTime ? Math.round((Date.now() - startTime) / 60000) : 0;
        let durationMinutes = (manualDuration || 0) + elapsedMinutes + previousTimeWorked;
        let sessionCount = 1;

        // Complete session if exists - use session manager's tracked time + manual
        try {
          const activeSession = await sessionMgr.getActiveSession(chatId);
          if (activeSession) {
            const result = await sessionMgr.completeSession(chatId);
            durationMinutes = result.totalTime + (manualDuration || 0);
            sessionCount = result.session.sessionCount;
          }
        } catch (_e) { /* no session */ }

        // Build updated task name with metadata
        const { extractCleanTaskName } = await import('../utils/task-parser');
        const cleanName = extractCleanTaskName(taskName);

        let durationStr = '';
        if (durationMinutes > 0) {
          if (durationMinutes < 60) {
            durationStr = `${durationMinutes} دقيقة`;
          } else {
            const hours = Math.floor(durationMinutes / 60);
            const mins = durationMinutes % 60;
            durationStr = mins > 0 ? `${hours} ساعة ${mins} دقيقة` : (hours === 1 ? 'ساعة' : `${hours} ساعات`);
          }
          if (sessionCount > 1) {
            durationStr += ` (${sessionCount} جلسات)`;
          }
        }

        let updatedTaskName = cleanName;
        if (durationStr) updatedTaskName += ` [${durationStr}]`;
        if (manualQuantity && manualQuantityUnit) updatedTaskName += ` [${manualQuantity} ${manualQuantityUnit}]`;

        // Delete active task
        await ctx.db.delete('conversation_state', { chat_id: op.eq(taskKey) });

        // Update content + close in Todoist
        const todoistToken = await ctx.settings.get('todoist_api_token');
        if (todoistToken && todoistTaskId) {
          try {
            // Store pending update
            const pendingUpdateKey = `pending_update_${todoistTaskId}`;
            await ctx.db.insert('conversation_state', {
              chat_id: pendingUpdateKey,
              conversation_type: 'pending_task_update',
              data: {
                taskId: todoistTaskId,
                updatedContent: updatedTaskName,
                durationMinutes: durationMinutes,
                manualQuantity: manualQuantity || null,
                manualQuantityUnit: manualQuantityUnit || null,
                createdAt: Date.now(),
                startDate: startDate,
              },
              expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            });

            // Update task content first
            await fetch(`https://api.todoist.com/api/v1/tasks/${todoistTaskId}`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${todoistToken.trim()}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ content: updatedTaskName }),
            });

            await new Promise(resolve => setTimeout(resolve, 500));

            // Then close
            await fetch(`https://api.todoist.com/api/v1/tasks/${todoistTaskId}/close`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
            });

            // Check if parent should autocomplete
            await completeParentInTodoistIfAllDone(ctx.db, ctx.settings, todoistTaskId, startDate, undefined, { TELEGRAM_BOT_TOKEN: ctx.env.TELEGRAM_BOT_TOKEN });
          } catch (_e) { /* todoist error */ }
        }

        const { createPostCompletionKeyboard } = await import('../utils/keyboards');
        const completionSuffixSession = '\n\n💪 جاهز للمهمة الجاية؟ ابدأ بـ /starttask';
        await ctx.editMessageText(
          `✅ **تم إكمال المهمة!**\n\n` +
          `📌 ${updatedTaskName}\n` +
          `⏱️ المدة: ${durationMinutes} دقيقة${sessionCount > 1 ? ` (${sessionCount} جلسات)` : ''}` +
          (manualQuantity ? `\n📊 الكمية: ${manualQuantity} ${manualQuantityUnit || ''}` : '') +
          `\n✓ تم التحديث في Todoist` + completionSuffixSession,
          { parse_mode: 'Markdown', reply_markup: createPostCompletionKeyboard() }
        );
        break;
      }

      case 'pause': {
        // Actually pause the task
        await ctx.answerCallbackQuery('⏸️ جاري الإيقاف...');

        const existingTask = await ctx.db.select('conversation_state', {
          filter: { chat_id: op.eq(taskKey) },
        });

        if (existingTask.length === 0) {
          await ctx.editMessageText('❌ لا توجد مهمة نشطة');
          return;
        }

        const taskData = (existingTask[0] as any).data || {};
        const taskName = taskData.taskName;
        const todoistTaskId = taskData.todoistTaskId;
        const pauseManualDuration = taskData.manualDuration || 0;

        // Start session if not exists, then pause
        let session = await sessionMgr.getActiveSession(chatId);
        if (!session) {
          session = await sessionMgr.startSession(chatId, todoistTaskId || null, taskName);
        }
        const pauseResult = await sessionMgr.pauseSession(chatId);

        // Add manual duration to session total (before active_task is deleted)
        if (pauseManualDuration > 0) {
          const newTotal = pauseResult.session.totalTimeWorked + pauseManualDuration;
          await ctx.db.update(
            'task_sessions',
            { id: op.eq(pauseResult.session.id) },
            { total_time_worked: newTotal }
          );
          pauseResult.session.totalTimeWorked = newTotal;
        }

        // Clear active task
        await ctx.db.delete('conversation_state', { chat_id: op.eq(taskKey) });

        const formatTime = (mins: number): string => {
          if (mins < 60) return `${mins} دقيقة`;
          const h = Math.floor(mins / 60);
          const m = mins % 60;
          if (m === 0) return h === 1 ? 'ساعة' : `${h} ساعات`;
          return `${h} ساعة ${m} دقيقة`;
        };

        const { createPausedSessionKeyboard } = await import('../utils/keyboards');
        await ctx.editMessageText(
          `⏸️ **تم الإيقاف المؤقت!**\n\n` +
          `📌 ${taskName}\n` +
          `⏱️ الوقت هذه الجلسة: ${formatTime(pauseResult.timeWorkedThisSession + pauseManualDuration)}\n` +
          `📊 الوقت الإجمالي: ${formatTime(pauseResult.session.totalTimeWorked)}\n` +
          `🔄 عدد الجلسات: ${pauseResult.session.sessionCount}`,
          { parse_mode: 'Markdown', reply_markup: createPausedSessionKeyboard(pauseResult.session.id) }
        );
        break;
      }

      case 'abandon':
      case 'cancel': {
        // Actually cancel the task
        await ctx.answerCallbackQuery('❌ جاري الإلغاء...');

        const existingTask = await ctx.db.select('conversation_state', {
          filter: { chat_id: op.eq(taskKey) },
        });

        if (existingTask.length === 0) {
          await ctx.editMessageText('❌ لا توجد مهمة نشطة');
          return;
        }

        const taskData = (existingTask[0] as any).data || {};

        // Abandon session and delete active task
        try { await sessionMgr.abandonSession(chatId); } catch (_e) { /* no session */ }
        await ctx.db.delete('conversation_state', { chat_id: op.eq(taskKey) });

        const { InlineKeyboard: CancelKb2 } = await import('grammy');
        const cancelKb = new CancelKb2()
          .text('🎯 مهمة جديدة', 'cmd:starttask')
          .text('📊 تقدمي', 'cmd:progress');
        await ctx.editMessageText(
          `❌ تم إلغاء المهمة:\n📌 ${taskData.taskName}`,
          { reply_markup: cancelKb }
        );
        break;
      }

      case 'resume': {
        if (sessionId) {
          // Check for existing active task first
          const existingActive = await ctx.db.select('conversation_state', {
            filter: { chat_id: op.eq(taskKey) },
          });
          if (existingActive.length > 0) {
            const activeData = (existingActive[0] as any).data || {};
            await ctx.answerCallbackQuery('⚠️ لديك مهمة نشطة');
            await ctx.editMessageText(
              `⚠️ لديك مهمة نشطة بالفعل:\n📌 ${activeData.taskName}\n\nأكملها أو ألغها أولاً`,
              { reply_markup: createTaskStartedKeyboard() }
            );
            break;
          }

          await ctx.answerCallbackQuery('▶️ جاري الاستئناف...');
          try {
            const session = await sessionMgr.resumeSession(sessionId);

            // Use delete-then-insert to avoid conflicts
            await ctx.db.delete('conversation_state', { chat_id: op.eq(taskKey) }).catch(() => {});
            await ctx.db.insert('conversation_state', {
              chat_id: taskKey,
              conversation_type: 'active_task',
              data: {
                taskName: session.taskContent,
                todoistTaskId: session.taskId,
                startTime: Date.now(),
                startDate: getTodayInEgypt(),
                previousTimeWorked: session.totalTimeWorked,
                sessionId: session.id,
              },
              expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            });

            const formatTime = (mins: number): string => {
              if (mins < 60) return `${mins}د`;
              const h = Math.floor(mins / 60);
              const m = mins % 60;
              if (m === 0) return `${h}س`;
              return `${h}س ${m}د`;
            };

            await ctx.editMessageText(
              `▶️ **تم استئناف المهمة!**\n\n` +
              `📌 ${session.taskContent}\n` +
              `⏱️ الوقت السابق: ${formatTime(session.totalTimeWorked)}\n` +
              `🔄 الجلسات: ${session.sessionCount}`,
              { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
            );
          } catch (err) {
            await ctx.reply('❌ فشل الاستئناف: ' + (err instanceof Error ? err.message : 'Unknown'));
          }
        }
        break;
      }

      case 'addduration': {
        await ctx.answerCallbackQuery('⏱️ إضافة مدة');
        const existingTask = await ctx.db.select('conversation_state', {
          filter: { chat_id: op.eq(taskKey) },
        });

        if (existingTask.length === 0) {
          await ctx.reply('❌ لا توجد مهمة نشطة');
          return;
        }

        const taskData = (existingTask[0] as any).data || {};

        await ctx.reply(
          '⏱️ **إضافة مدة زمنية**\n\n' +
          `📌 المهمة: ${taskData.taskName}\n\n` +
          'اختر مدة أو أرسل المدة يدوياً:\n' +
          '• 30m أو 30د (30 دقيقة)\n' +
          '• 2h أو 2س (ساعتان)',
          { parse_mode: 'Markdown', reply_markup: createDurationInputKeyboard() }
        );

        // Store pending state
        try {
          await ctx.db.delete('conversation_state', { chat_id: op.eq(`pending_duration_${chatId}`) });
        } catch (_e) { /* ignore */ }
        await ctx.db.insert('conversation_state', {
          chat_id: `pending_duration_${chatId}`,
          conversation_type: 'pending_duration',
          data: {},
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });
        break;
      }

      case 'addquantity': {
        await ctx.answerCallbackQuery('📊 إضافة كمية');
        const existingTask = await ctx.db.select('conversation_state', {
          filter: { chat_id: op.eq(taskKey) },
        });

        if (existingTask.length === 0) {
          await ctx.reply('❌ لا توجد مهمة نشطة');
          return;
        }

        const taskData = (existingTask[0] as any).data || {};

        await ctx.reply(
          '📊 **إضافة كمية**\n\n' +
          `📌 المهمة: ${taskData.taskName}\n\n` +
          'اختر كمية أو أرسل الكمية والوحدة:\n' +
          'مثال: 20 صفحة، 5 تمارين',
          { parse_mode: 'Markdown', reply_markup: createQuantityInputKeyboard() }
        );

        // Store pending state
        try {
          await ctx.db.delete('conversation_state', { chat_id: op.eq(`pending_quantity_${chatId}`) });
        } catch (_e) { /* ignore */ }
        await ctx.db.insert('conversation_state', {
          chat_id: `pending_quantity_${chatId}`,
          conversation_type: 'pending_quantity_input',
          data: {},
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });
        break;
      }

      default:
        await ctx.answerCallbackQuery();
        break;
    }

  } catch (error) {
    console.error('Session callback error:', error);
    await ctx.answerCallbackQuery('❌ حدث خطأ');
  }
});

bot.callbackQuery(/^resume:/, async (ctx) => {
  try {
    const chatId = ctx.chat?.id.toString() || '';
    const parts = ctx.callbackQuery.data.split(':');
    const action = parts[1];
    const sessionId = parts[2];

    if (action === 'yes' && sessionId) {
      const { createTaskSessionManager } = await import('../services/task-session-manager');
      const sessionMgr = createTaskSessionManager(ctx.db);

      await ctx.answerCallbackQuery('▶️ جاري الاستئناف...');

      const session = await sessionMgr.resumeSession(sessionId);
      const taskKey = `active_task_${chatId}`;

      await ctx.db.insert('conversation_state', {
        chat_id: taskKey,
        conversation_type: 'active_task',
        data: {
          taskName: session.taskContent,
          todoistTaskId: session.taskId,
          startTime: Date.now(),
          previousTimeWorked: session.totalTimeWorked,
        },
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      await ctx.editMessageText(
        `▶️ **تم استئناف المهمة!**\n\n` +
        `📌 ${session.taskContent}\n` +
        `⏱️ الوقت السابق: ${session.totalTimeWorked} دقيقة\n\n` +
        `يلا بينا! 💪`,
        { parse_mode: 'Markdown' }
      );

    } else if (action === 'new') {
      await ctx.answerCallbackQuery('🆕 جلسة جديدة');
      await ctx.editMessageText('استخدم /starttask لبدء جلسة جديدة');
    }

  } catch (error) {
    console.error('Resume callback error:', error);
    await ctx.answerCallbackQuery('❌ حدث خطأ');
  }
});

bot.callbackQuery(/^break:/, async (ctx) => {
  try {
    const minutes = parseInt(ctx.callbackQuery.data.replace('break:', ''), 10);
    await ctx.answerCallbackQuery(`☕ استراحة ${minutes} دقيقة`);
    await ctx.editMessageText(
      `☕ استراحة ${minutes} دقايق!\n\n` +
      `خد راحتك، وبعدين استخدم /starttask للمتابعة 💪`
    );
  } catch (error) {
    console.error('Break callback error:', error);
    await ctx.answerCallbackQuery('❌ حدث خطأ');
  }
});

// ============================================
// Task Selection Callbacks (for /starttask)
// ============================================
bot.callbackQuery(/^tasksel:/, async (ctx) => {
  try {
    const data = ctx.callbackQuery.data.replace('tasksel:', '');
    const chatId = ctx.chat?.id.toString() || '';
    const selectKey = `task_select_${chatId}`;

    // Handle pagination
    if (data.startsWith('page:')) {
      const page = parseInt(data.replace('page:', ''), 10);
      await ctx.answerCallbackQuery(`📋 صفحة ${page + 1}`);

      // Get selection state
      const pageState = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(selectKey) },
      });

      if (pageState.length > 0) {
        const pageData = (pageState[0] as any).data || {};
        const taskList = pageData.availableTasks || pageData.matchedTasks || [];
        const taskKeyboard = createTaskSelectionKeyboard(
          taskList.map((t: any) => ({ id: t.id, content: t.content })),
          'start',
          page
        );
        await ctx.editMessageReplyMarkup({ reply_markup: taskKeyboard });
      }
      return;
    }

    // Ignore noop (page indicator button)
    if (data === 'noop') {
      await ctx.answerCallbackQuery();
      return;
    }

    if (data === 'new') {
      // User wants to add a new task
      await ctx.answerCallbackQuery('📝 أرسل اسم المهمة الجديدة');
      await ctx.editMessageText(
        '📝 **إضافة مهمة جديدة**\n\n' +
        'أرسل اسم المهمة التي تريد البدء بها:',
        { parse_mode: 'Markdown' }
      );

      // Update state to expect new task name
      await ctx.db.update(
        'conversation_state',
        { chat_id: op.eq(selectKey) },
        {
          data: { expectingNewTask: true },
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }
      );
      return;
    }

    // User selected a task by ID
    const taskId = data;
    await ctx.answerCallbackQuery('⏱️ جاري بدء المهمة...');

    // Get selection state to find the task
    const selectionState = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(selectKey) },
    });

    if (selectionState.length === 0) {
      await ctx.editMessageText('❌ انتهت صلاحية الاختيار. استخدم /starttask مرة أخرى');
      return;
    }

    const selectionData = (selectionState[0] as any).data || {};
    const taskList = selectionData.availableTasks || selectionData.matchedTasks || [];
    const selectedTask = taskList.find((t: any) => t.id === taskId);

    if (!selectedTask) {
      await ctx.editMessageText('❌ لم يتم العثور على المهمة. استخدم /starttask مرة أخرى');
      return;
    }

    // Delete selection state
    await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) });

    // Check for existing active task
    const taskKey = `active_task_${chatId}`;
    const existingTask = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(taskKey) },
    });

    if (existingTask.length > 0) {
      await ctx.editMessageText(
        '⚠️ لديك مهمة نشطة بالفعل!\n\n' +
        'استخدم /completetask لإكمالها أو /canceltask لإلغائها'
      );
      return;
    }

    // Start the task
    const startDate = getTodayInEgypt();
    await ctx.db.insert('conversation_state', {
      chat_id: taskKey,
      conversation_type: 'active_task',
      data: {
        taskName: selectedTask.content,
        todoistTaskId: selectedTask.id,
        startTime: Date.now(),
        startDate: startDate,
      },
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    const now = new Date();
    const timeStr = now.toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' });
    const { extractCleanTaskName } = await import('../utils/task-parser');

    await ctx.editMessageText(
      `⏱️ **بدأ تتبع المهمة**\n\n` +
      `📌 ${extractCleanTaskName(selectedTask.content).trim()}\n` +
      `🕐 البداية: ${timeStr}`,
      { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
    );

  } catch (error) {
    console.error('Task selection callback error:', error);
    await ctx.answerCallbackQuery('❌ حدث خطأ');
  }
});

// ============================================
// Failure Selection Callbacks (for /log_failure)
// ============================================
bot.callbackQuery(/^failsel:/, async (ctx) => {
  try {
    const data = ctx.callbackQuery.data.replace('failsel:', '');
    const chatId = ctx.chat?.id.toString() || '';
    const selectKey = `failure_select_${chatId}`;

    // Handle pagination
    if (data.startsWith('page:')) {
      const page = parseInt(data.replace('page:', ''), 10);
      await ctx.answerCallbackQuery(`📋 صفحة ${page + 1}`);

      const pageState = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(selectKey) },
      });

      if (pageState.length > 0) {
        const pageData = (pageState[0] as any).data || {};
        const taskList = pageData.availableTasks || [];
        const taskKeyboard = createTaskSelectionKeyboard(
          taskList.map((t: any) => ({ id: t.id, content: t.content })),
          'failure',
          page
        );
        await ctx.editMessageReplyMarkup({ reply_markup: taskKeyboard });
      }
      return;
    }

    // Ignore noop (page indicator button)
    if (data === 'noop') {
      await ctx.answerCallbackQuery();
      return;
    }

    if (data === 'new') {
      // User wants to add a new task as failure
      await ctx.answerCallbackQuery('📝 أرسل اسم المهمة');
      await ctx.editMessageText(
        '📝 **تسجيل فشل مهمة جديدة**\n\n' +
        'أرسل اسم المهمة التي فشلت:',
        { parse_mode: 'Markdown' }
      );

      // Update state to expect new task name
      await ctx.db.update(
        'conversation_state',
        { chat_id: op.eq(selectKey) },
        {
          data: { expectingNewTask: true },
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }
      );
      return;
    }

    // User selected a task by ID
    const taskId = data;
    await ctx.answerCallbackQuery('📝 جاري تسجيل الفشل...');

    // Get selection state to find the task
    const selectionState = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(selectKey) },
    });

    if (selectionState.length === 0) {
      await ctx.editMessageText('❌ انتهت صلاحية الاختيار. استخدم /log_failure مرة أخرى');
      return;
    }

    const selectionData = (selectionState[0] as any).data || {};
    const taskList = selectionData.availableTasks || [];
    const selectedTask = taskList.find((t: any) => t.id === taskId);

    if (!selectedTask) {
      await ctx.editMessageText('❌ لم يتم العثور على المهمة. استخدم /log_failure مرة أخرى');
      return;
    }

    const { extractCleanTaskName } = await import('../utils/task-parser');

    // Delete selection state
    await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) });

    // Log the failure
    const today = getTodayInEgypt();
    const dailyFailures = await getDailyFailures(ctx.db, today);
    const failedTasks = dailyFailures?.failed_tasks || [];

    const existingIndex = failedTasks.findIndex((f: FailedTask) =>
      f.id === selectedTask.id || f.content === selectedTask.content
    );

    const existingFailed = existingIndex >= 0 ? failedTasks[existingIndex] : undefined;
    if (existingFailed && existingFailed.is_pending === false) {
      // Already confirmed failed — skip
      await ctx.editMessageText(
        `⚠️ المهمة "${extractCleanTaskName(selectedTask.content).trim()}" مسجلة بالفعل كفشل اليوم`
      );
      return;
    }

    // Determine if this is a subtask and find parent info
    const isSubtask = !!selectedTask.parent_id;
    let parentContent: string | null = null;
    if (isSubtask && selectedTask.parent_id) {
      // Look up parent name from the task list
      const parentTask = taskList.find((t: any) => t.id === selectedTask.parent_id);
      parentContent = parentTask?.content || null;
    }

    // Create confirmed failure entry
    const newFailure: FailedTask = {
      id: selectedTask.id,
      content: selectedTask.content,
      parent_id: selectedTask.parent_id || null,
      parent_content: parentContent,
      priority: selectedTask.priority || 1,
      is_subtask: isSubtask,
      description: 'Manual failure logged via /log_failure',
      is_manual: true,
      is_pending: false, // Confirmed failed
    };

    if (existingIndex >= 0) {
      failedTasks[existingIndex] = newFailure;
    } else {
      failedTasks.push(newFailure);
    }

    const updatedDailyFailures = {
      date: today,
      last_sync: new Date().toISOString(),
      failed_tasks: failedTasks,
    };
    await upsertDailyFailures(ctx.db, updatedDailyFailures);

    // Trigger battle mode boss healing (fire-and-forget)
    const botToken = ctx.env?.TELEGRAM_BOT_TOKEN || (await ctx.settings.get('telegram_bot_token'));
    if (chatId && botToken) {
      const { triggerOnTaskFailed } = await import('../handlers/todoist');
      triggerOnTaskFailed(extractCleanTaskName(selectedTask.content), chatId, botToken, ctx.db, ctx.settings, 1).catch((e) =>
        console.error('triggerOnTaskFailed error:', e)
      );
    }

    // Close the task in Todoist (so it disappears from active tasks)
    let todoistStatus = '';
    const todoistToken = await ctx.settings.get('todoist_api_token');
    if (todoistToken && selectedTask.id && !selectedTask.id.startsWith('manual_')) {
      try {
        // Create failure_completion marker so webhook ignores this completion
        const markerKey = `failure_completion_${selectedTask.id}`;
        await ctx.db.delete('conversation_state', { chat_id: op.eq(markerKey) }).catch(() => {});
        await ctx.db.insert('conversation_state', {
          chat_id: markerKey,
          conversation_type: 'failure_completion',
          data: { taskId: selectedTask.id, taskName: selectedTask.content, manualFail: true },
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });

        // Wait for marker to be visible before closing
        await new Promise(resolve => setTimeout(resolve, 300));

        const closeResponse = await fetch(
          `https://api.todoist.com/api/v1/tasks/${selectedTask.id}/close`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
          }
        );

        if (closeResponse.ok) {
          todoistStatus = '\n🔄 تم إغلاق المهمة في Todoist';
        } else {
          console.error(`Failed to close task in Todoist: ${closeResponse.status}`);
          todoistStatus = '\n⚠️ فشل إغلاق المهمة في Todoist';
        }
      } catch (err) {
        console.error('Error closing task in Todoist:', err);
        todoistStatus = '\n⚠️ فشل إغلاق المهمة في Todoist';
      }
    }

    // Build failure notification similar to completion notification
    let notificationMsg = '';

    if (isSubtask && parentContent) {
      // Subtask failed — show parent context with all sibling subtasks
      const updatedFailures = await getDailyFailures(ctx.db, today);
      const parentCleanName = extractCleanTaskName(parentContent);

      // Get completed sibling subtasks from tasks table
      const { start, end } = await import('../utils/timezone').then(m => {
        const bounds = m.getEgyptDayBoundaries(today);
        return bounds;
      });
      const allTasks = await ctx.db.select('tasks', { limit: 5000 });
      const todayTasks = (allTasks as any[]).filter((t: any) => {
        const d = new Date(t.completed_at);
        return d >= start && d <= end;
      });

      const completedSiblings = todayTasks.filter((t: any) => {
        if (!t.origin_task) return false;
        const originMatch = t.content?.match(/\(origin:\s*([^)]+)\)/i);
        if (originMatch?.[1]) {
          return extractCleanTaskName(originMatch[1]) === parentCleanName;
        }
        const parentBaseId = selectedTask.parent_id?.split('_')[0];
        if (parentBaseId) {
          return t.origin_task?.split('_')[0] === parentBaseId;
        }
        return false;
      });

      // Get failed sibling subtasks
      const failedSiblings = updatedFailures?.failed_tasks.filter((f: FailedTask) => {
        if (!f.is_subtask) return false;
        if (f.parent_content) return extractCleanTaskName(f.parent_content) === parentCleanName;
        if (f.parent_id === selectedTask.parent_id) return true;
        return false;
      }) || [];

      const totalSibs = completedSiblings.length + failedSiblings.length;
      const confirmedFailed = failedSiblings.filter((f: FailedTask) => f.is_pending === false);

      // Parent complete ONLY when ALL subtasks done in DB (never use parent row status from Todoist path)
      const parentCompleted = totalSibs > 0 && confirmedFailed.length === 0;
      let parentSymbol = '⏳';
      if (parentCompleted) parentSymbol = '✅';
      else if (confirmedFailed.length > 0 && completedSiblings.length > 0) parentSymbol = '⚠️';
      else if (confirmedFailed.length > 0 && completedSiblings.length === 0) parentSymbol = '❌';

      notificationMsg = `${parentSymbol} ${parentCleanName} (${completedSiblings.length}/${totalSibs})`;

      for (const sub of completedSiblings) {
        notificationMsg += `\n  ✓ ${extractCleanTaskName(sub.content)}`;
      }
      for (const sub of failedSiblings) {
        const subSymbol = sub.is_pending !== false ? '…' : '✕';
        notificationMsg += `\n  ${subSymbol} ${extractCleanTaskName(sub.content)}`;
      }
    } else {
      // Standalone task failed
      notificationMsg = `❌ ${extractCleanTaskName(selectedTask.content)}`;
    }

    const failureSuffix = '\n\n💪 جاهز للمهمة الجاية؟ ابدأ بـ /starttask';
    await ctx.editMessageText(
      `${notificationMsg}${todoistStatus}${failureSuffix}`
    );

  } catch (error) {
    console.error('Failure selection callback error:', error);
    await ctx.answerCallbackQuery('❌ حدث خطأ');
  }
});

// ============================================
// Duration Input Callbacks
// ============================================
bot.callbackQuery(/^duration:/, async (ctx) => {
  try {
    const data = ctx.callbackQuery.data.replace('duration:', '');
    const chatId = ctx.chat?.id.toString() || '';

    if (data === 'cancel') {
      await ctx.answerCallbackQuery('✅ تم الإلغاء');
      await ctx.db.delete('conversation_state', { chat_id: op.eq(`pending_duration_${chatId}`) });
      await ctx.editMessageText('✅ تم إلغاء إضافة المدة');
      return;
    }

    const minutes = parseInt(data, 10);
    await ctx.answerCallbackQuery(`⏱️ تم إضافة ${minutes} دقيقة`);

    // Get active task
    const taskKey = `active_task_${chatId}`;
    const existingTask = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(taskKey) },
    });

    if (existingTask.length === 0) {
      await ctx.editMessageText('❌ لا توجد مهمة نشطة');
      return;
    }

    const taskData = (existingTask[0] as any).data || {};

    // Add manual duration
    const existingDuration = taskData.manualDuration || 0;
    await ctx.db.update(
      'conversation_state',
      { chat_id: op.eq(taskKey) },
      {
        data: { ...taskData, manualDuration: existingDuration + minutes },
      }
    );

    // Delete pending state
    await ctx.db.delete('conversation_state', { chat_id: op.eq(`pending_duration_${chatId}`) });

    await ctx.editMessageText(
      `✅ تم إضافة المدة: ${minutes} دقيقة\n\n` +
      `📌 ${taskData.taskName}`,
      { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
    );

  } catch (error) {
    console.error('Duration callback error:', error);
    await ctx.answerCallbackQuery('❌ حدث خطأ');
  }
});

// ============================================
// Quantity Input Callbacks
// ============================================
bot.callbackQuery(/^quantity:/, async (ctx) => {
  try {
    const data = ctx.callbackQuery.data.replace('quantity:', '');
    const chatId = ctx.chat?.id.toString() || '';

    if (data === 'cancel') {
      await ctx.answerCallbackQuery('✅ تم الإلغاء');
      await ctx.db.delete('conversation_state', { chat_id: op.eq(`pending_quantity_${chatId}`) });
      await ctx.editMessageText('✅ تم إلغاء إضافة الكمية');
      return;
    }

    const quantity = parseInt(data, 10);
    await ctx.answerCallbackQuery(`📊 تم إضافة ${quantity}`);

    // Get active task
    const taskKey = `active_task_${chatId}`;
    const existingTask = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(taskKey) },
    });

    if (existingTask.length === 0) {
      await ctx.editMessageText('❌ لا توجد مهمة نشطة');
      return;
    }

    const taskData = (existingTask[0] as any).data || {};

    // Add quantity (default unit: وحدة)
    await ctx.db.update(
      'conversation_state',
      { chat_id: op.eq(taskKey) },
      {
        data: { ...taskData, manualQuantity: quantity, manualQuantityUnit: 'وحدة' },
      }
    );

    // Delete pending state
    await ctx.db.delete('conversation_state', { chat_id: op.eq(`pending_quantity_${chatId}`) });

    await ctx.editMessageText(
      `✅ تم إضافة الكمية: ${quantity} وحدة\n\n` +
      `📌 ${taskData.taskName}`,
      { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
    );

  } catch (error) {
    console.error('Quantity callback error:', error);
    await ctx.answerCallbackQuery('❌ حدث خطأ');
  }
});

// (session:addduration, session:addquantity, session:cancel are handled by the main /^session:/ handler above)

// ============================================
// Resume Choice Callbacks (for paused session decision)
// ============================================
bot.callbackQuery(/^resumechoice:/, async (ctx) => {
  try {
    const data = ctx.callbackQuery.data.replace('resumechoice:', '');
    const parts = data.split(':');
    const action = parts[0];
    const sessionId = parts[1];
    const chatId = ctx.chat?.id.toString() || '';
    const resumeDecisionKey = `resume_decision_${chatId}`;

    // Get decision data
    const decisionState = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(resumeDecisionKey) },
    });

    if (decisionState.length === 0) {
      await ctx.answerCallbackQuery('❌ انتهت صلاحية الاختيار');
      await ctx.editMessageText('❌ انتهت صلاحية الاختيار. استخدم /starttask مرة أخرى');
      return;
    }

    const decisionData = (decisionState[0] as any).data || {};
    const taskName = decisionData.taskName || decisionData.taskContent;

    // Delete decision state
    await ctx.db.delete('conversation_state', { chat_id: op.eq(resumeDecisionKey) });

    const { createTaskSessionManager } = await import('../services/task-session-manager');
    const sessionMgr = createTaskSessionManager(ctx.db);

    if (action === 'yes') {
      // Resume previous session
      await ctx.answerCallbackQuery('▶️ جاري الاستئناف...');

      const resumed = await sessionMgr.resumeSession(sessionId || decisionData.sessionId);
      if (!resumed) {
        await ctx.editMessageText('❌ فشل في استئناف الجلسة');
        return;
      }

      // Set active task
      const taskKey = `active_task_${chatId}`;
      const startDate = getTodayInEgypt();

      await ctx.db.insert('conversation_state', {
        chat_id: taskKey,
        conversation_type: 'active_task',
        data: {
          taskName: resumed.taskContent,
          todoistTaskId: resumed.taskId,
          startTime: Date.now(),
          startDate: startDate,
          previousTimeWorked: resumed.totalTimeWorked,
          sessionId: resumed.id,
        },
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      const formatTime = (mins: number): string => {
        if (mins < 60) return `${mins}د`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        if (m === 0) return `${h}س`;
        return `${h}س ${m}د`;
      };

      const now = new Date();
      const timeStr = now.toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' });

      await ctx.editMessageText(
        `▶️ **تم استئناف الجلسة**\n\n` +
        `📌 ${resumed.taskContent}\n` +
        `⏱️ الوقت السابق: ${formatTime(resumed.totalTimeWorked)}\n` +
        `🔄 الجلسات: ${resumed.sessionCount}\n` +
        `🕐 البداية: ${timeStr}`,
        { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
      );

    } else if (action === 'new') {
      // Start fresh - delete paused session and start new
      await ctx.answerCallbackQuery('🆕 جاري بدء جلسة جديدة...');

      // Delete the paused session directly
      const sessionToDelete = sessionId || decisionData.sessionId;
      if (sessionToDelete) {
        await ctx.db.delete('task_sessions', { id: op.eq(sessionToDelete) });
      }

      // Set active task
      const taskKey = `active_task_${chatId}`;
      const startDate = getTodayInEgypt();

      await ctx.db.insert('conversation_state', {
        chat_id: taskKey,
        conversation_type: 'active_task',
        data: {
          taskName: taskName,
          todoistTaskId: decisionData.taskId,
          startTime: Date.now(),
          startDate: startDate,
        },
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      const now = new Date();
      const timeStr = now.toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' });

      await ctx.editMessageText(
        `⏱️ **بدأ تتبع المهمة**\n\n` +
        `📌 ${taskName}\n` +
        `🕐 البداية: ${timeStr}\n` +
        `_تم إلغاء الجلسة السابقة وبدأنا من الصفر_`,
        { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
      );
    }

  } catch (error) {
    console.error('Resume choice callback error:', error);
    await ctx.answerCallbackQuery('❌ حدث خطأ');
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

      // ============================================
      // Handle Quick Mode Input
      // ============================================
      const quickModeKey = `quick_mode_${chatId}`;
      const quickModeState = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(quickModeKey) },
        limit: 1,
      });

      if (quickModeState.length > 0) {
        const quickData = (quickModeState[0] as any).data || {};
        const durationMinutes = quickData.durationMinutes || 5;

        // Delete quick mode state
        await ctx.db.delete('conversation_state', { chat_id: op.eq(quickModeKey) });

        // Start task with the entered name
        const taskName = text.trim();
        const taskKey = `active_task_${chatId}`;

        await ctx.db.insert('conversation_state', {
          chat_id: taskKey,
          conversation_type: 'active_task',
          data: {
            taskName: taskName,
            todoistTaskId: null,
            startTime: Date.now(),
            startDate: getTodayInEgypt(),
            isQuickMode: true,
            quickModeDuration: durationMinutes,
          },
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        });

        const keyboard = createQuickModeEndKeyboard();
        await ctx.reply(
          `⏱️ **جلسة ${durationMinutes} دقايق بدأت!**\n\n` +
          `📌 ${taskName}\n\n` +
          `الهدف: ابدأ بس! مش لازم تخلص.\n` +
          `لما تخلص استخدم /completetask`,
          {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          }
        );
        return;
      }

      // ============================================
      // Handle Talk Session (احكيلي) - Extended Conversation
      // ============================================
      const talkSessionKey = `talk_session_${chatId}`;
      const talkSessions = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(talkSessionKey) },
        limit: 1,
      });

      if (talkSessions.length > 0 && (talkSessions[0] as any).conversation_type === 'coach_talk') {
        const talkData = (talkSessions[0] as any).data || {};
        const { maxTurns, history = [] } = talkData;
        const currentTurn = (talkData.currentTurn || 0) + 1;

        // Check if session expired
        const expiresAt = new Date((talkSessions[0] as any).expires_at);
        if (new Date() > expiresAt || currentTurn > maxTurns) {
          // Session over — clean up
          await ctx.db.delete('conversation_state', { chat_id: op.eq(talkSessionKey) });
          const coachAnalytics = createCoachingAnalytics(ctx.db);
          await coachAnalytics.completeCheckin(chatId, true);
          await ctx.reply('💬 انتهت الجلسة! يلا نبدأ شغل؟ 💪', { reply_markup: createCoachCheckInKeyboard() });
          return;
        }

        // Use background processing for AI-heavy talk response
        const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
        const apiKey = await ctx.settings.get('openrouter_api_key');
        if (apiKey && botToken) {
          // Immediately update turn count to prevent duplicate processing
          await ctx.db.delete('conversation_state', { chat_id: op.eq(talkSessionKey) }).catch(() => {});
          await ctx.db.insert('conversation_state', {
            chat_id: talkSessionKey,
            conversation_type: 'coach_talk',
            data: { ...talkData, currentTurn, history: [...history, { role: 'user', content: text }] },
            expires_at: (talkSessions[0] as any).expires_at,
          });

          const coachAnalytics = createCoachingAnalytics(ctx.db);
          const activeCheck = await coachAnalytics.getActiveCheckin(chatId);
          if (activeCheck) {
            await coachAnalytics.recordTextResponse(activeCheck.id, 2, talkData.duration || 10);
          }

          // Run AI generation in background to avoid webhook timeout
          const backgroundTask = (async () => {
            try {
              const aiModel = await getAIModelByTier(ctx.settings, 'low');
              const aiClient = createAIClient(apiKey, aiModel);
              const metaCoach = createMetaCoach(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max), ctx.env.TELEGRAM_BOT_TOKEN);

              const response = await metaCoach.generateTalkResponse(
                chatId,
                text,
                history,
                currentTurn,
                maxTurns,
                activeCheck?.userMood
              );

              // Update session with full history including coach response
              const newHistory = [...history, { role: 'user', content: text }, { role: 'coach', content: response }];
              await ctx.db.delete('conversation_state', { chat_id: op.eq(talkSessionKey) }).catch(() => {});
              await ctx.db.insert('conversation_state', {
                chat_id: talkSessionKey,
                conversation_type: 'coach_talk',
                data: { ...talkData, currentTurn, history: newHistory.slice(-20) },
                expires_at: (talkSessions[0] as any).expires_at,
              });

              // Send response with remaining time
              const turnsLeft = maxTurns - currentTurn;
              const sessionStarted = new Date(talkData.startedAt || Date.now());
              const sessionDuration = talkData.duration || 5;
              const elapsedMs = Date.now() - sessionStarted.getTime();
              const remainingMin = Math.max(0, Math.ceil((sessionDuration * 60 * 1000 - elapsedMs) / 60000));

              if (turnsLeft <= 0 || remainingMin <= 0) {
                // Session over - log full script for intervention context, then clean up
                try {
                  const contextBuilder = createCoachingContextBuilder(ctx.db, ctx.settings);
                  await contextBuilder.logInteraction({
                    chat_id: chatId,
                    interaction_date: getTodayInEgypt(),
                    timestamp: new Date().toISOString(),
                    interaction_type: 'coach_talk',
                    outcome: 'positive',
                    metadata: { script: newHistory },
                  });
                } catch (logErr) {
                  console.error('Failed to log coach_talk script:', logErr);
                }
                await ctx.db.delete('conversation_state', { chat_id: op.eq(talkSessionKey) });
                const ca = createCoachingAnalytics(ctx.db);
                await ca.completeCheckin(chatId, true);
                const finalText = response + '\n\n✅ انتهت الجلسة! يلا نبدأ شغل؟';
                const keyboard = {
                  inline_keyboard: [
                    [{ text: '▶️ ابدأ مهمة', callback_data: 'coach:start_task' }, { text: '📅 خطة اليوم', callback_data: 'cmd:plan' }],
                    [{ text: '💬 احكيلي', callback_data: 'coach:talk' }, { text: '😴 تعبان', callback_data: 'coach:tired' }, { text: '⏸️ مشغول', callback_data: 'coach:busy' }],
                    [{ text: '🔥 احرقني', callback_data: 'cmd:roast' }, { text: '⚔️ معركة', callback_data: 'cmd:battle' }],
                  ]
                };
                await sendTelegramMessageDirect(botToken, chatId, finalText, undefined, keyboard);
              } else {
                const timeLabel = remainingMin === 1 ? 'دقيقة' : remainingMin <= 10 ? `${remainingMin} دقايق` : `${remainingMin} دقيقة`;
                const responseWithTime = `${response}\n\n⏱️ باقي ${timeLabel}`;
                const keyboard = {
                  inline_keyboard: [
                    [{ text: `🔚 إنهاء المحادثة`, callback_data: 'coach:end' }],
                  ]
                };
                await sendTelegramMessageDirect(botToken, chatId, responseWithTime, undefined, keyboard);
              }
            } catch (err) {
              console.error('Talk session background error:', err);
              await sendTelegramMessageDirect(botToken, chatId, '💬 حصل مشكلة، حاول تاني أو اكتب /coach_check');
            }
          })();

          // Use waitUntil for background processing
          if (ctx.executionContext?.waitUntil) {
            ctx.executionContext.waitUntil(backgroundTask);
          } else {
            await backgroundTask;
          }
        }
        return;
      }

      // ============================================
      // Handle pending duration input (BEFORE coach - so "20m" goes to task, not coach)
      // ============================================
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

          // Accumulate manual duration (don't replace)
          const existingManual = taskData.manualDuration || 0;
          const newManual = existingManual + metadata.duration_minutes;
          await ctx.db.update(
            'conversation_state',
            { chat_id: op.eq(taskKey) },
            {
              data: {
                ...taskData,
                manualDuration: newManual,
              }
            }
          );

          await ctx.reply(
            `✅ تم إضافة المدة: ${metadata.duration_minutes} دقيقة` +
            (existingManual > 0 ? ` (الإجمالي المضاف: ${newManual} دقيقة)` : '') +
            `\n\n📌 ${taskData.taskName}`,
            { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
          );
        }
        return;
      }

      // ============================================
      // Handle pending quantity input
      // ============================================
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
            `📌 ${taskData.taskName}`,
            { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
          );
        }
        return;
      }

      // ============================================
      // Handle Interactive Coach Conversation (regular check-in)
      // ============================================
      const coachingAnalytics = createCoachingAnalytics(ctx.db);
      const botTokenForFollowUp = ctx.env.TELEGRAM_BOT_TOKEN;
      const activeCheckin = await coachingAnalytics.getActiveCheckin(chatId, {
        onExpiredNoResponse: async (targetChatId: string) => {
          if (botTokenForFollowUp) {
            await sendTelegramMessageDirect(botTokenForFollowUp, targetChatId, 'متابعة بدون رد ✓');
          }
        },
      });

      if (activeCheckin) {
        // User responded to a coach check-in - store reply on latest meta_coach for intervention context
        const contextBuilder = createCoachingContextBuilder(ctx.db, ctx.settings);
        await contextBuilder.updateLatestMetaCoachUserInput(chatId, text.trim()).catch(() => {});

        // User responded to a coach check-in - handle interactive conversation
        const updatedCheckin = await coachingAnalytics.recordTextResponse(activeCheckin.id);

        if (updatedCheckin && updatedCheckin.conversationTurns <= updatedCheckin.maxTurns) {
          // Generate AI response
          const apiKey = await ctx.settings.get('openrouter_api_key');
          if (apiKey) {
            const aiModel = await getAIModelByTier(ctx.settings, 'low');
            const aiClient = createAIClient(apiKey, aiModel);
            const metaCoach = createMetaCoach(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max), ctx.env.TELEGRAM_BOT_TOKEN);

            const response = await metaCoach.generateConversationResponse(
              chatId,
              text,
              updatedCheckin.conversationTurns,
              updatedCheckin.userMood
            );

            // Add interactive keyboard based on conversation stage
            if (updatedCheckin.conversationTurns >= updatedCheckin.maxTurns) {
              // Last turn - show action keyboard
              await coachingAnalytics.completeCheckin(chatId, false);
              await ctx.reply(response, { reply_markup: createCoachCheckInKeyboard() });
            } else {
              // Mid-conversation - show conversation keyboard
              const { createCoachConversationKeyboard } = await import('../utils/keyboards');
              await ctx.reply(response, { reply_markup: createCoachConversationKeyboard() });
            }
          }
        }
        return;
      }

      // Handle stuck recommendation responses (1, 2, or 3)
      const stuckRecommendSession = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(chatId), conversation_type: op.eq('stuck_recommendation') },
        limit: 1,
      });

      if (stuckRecommendSession.length > 0) {
        const sessionData = (stuckRecommendSession[0] as any).data || {};
        const recommendation = sessionData.recommendation;
        const choice = text.trim();

        // Clear recommendation state
        await ctx.db.delete('conversation_state', { chat_id: op.eq(chatId), conversation_type: op.eq('stuck_recommendation') });

        const botToken = ctx.env.TELEGRAM_BOT_TOKEN;
        const apiKey = await ctx.settings.get('openrouter_api_key');
        const todoistToken = await ctx.settings.get('todoist_api_token');
        const projectId = await ctx.settings.get('todoist_project_id');

        if (choice === '1' || choice.includes('موافق') || choice.includes('نبدأ')) {
          // Accept recommendation - start sprint
          if (recommendation && apiKey) {
            await ctx.reply('⏳ جاري بدء السبرنت...');

            const backgroundTask = (async () => {
              try {
                const aiModel = await getAIModelByTier(ctx.settings, 'low');
                const aiClient = createAIClient(apiKey, aiModel);
                const stuckHandler = createStuckHandler(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));

                // Start sprint directly with the recommended task
                const result = await stuckHandler.processResponse(chatId, recommendation.taskContent);
                await sendTelegramMessageDirect(botToken, chatId, result.message);
              } catch (error) {
                console.error('Stuck recommendation accept error:', error);
                await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ في بدء السبرنت');
              }
            })();

            if (ctx.executionContext?.waitUntil) {
              ctx.executionContext.waitUntil(backgroundTask);
            } else {
              await backgroundTask;
            }
          }
          return;
        } else if (choice === '2' || choice.includes('تانية') || choice.includes('بدائل')) {
          // Show alternatives
          if (todoistToken && recommendation && apiKey) {
            await ctx.reply('⏳ جاري البحث عن بدائل...');

            const backgroundTask = (async () => {
              try {
                const aiModel = await getAIModelByTier(ctx.settings, 'low');
                const aiClient = createAIClient(apiKey, aiModel);
                const stuckHandler = createStuckHandler(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));

                const alternatives = await stuckHandler.showAlternatives(chatId, todoistToken, recommendation.taskContent, projectId || undefined);
                await sendTelegramMessageDirect(botToken, chatId, alternatives);

                // Set state for alternative selection
                await ctx.db.insert('conversation_state', {
                  chat_id: chatId,
                  conversation_type: 'stuck_alternatives',
                  current_step: 1,
                  data: { rejectedTask: recommendation.taskContent },
                  expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
                });
              } catch (error) {
                console.error('Stuck alternatives error:', error);
                await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ في عرض البدائل');
              }
            })();

            if (ctx.executionContext?.waitUntil) {
              ctx.executionContext.waitUntil(backgroundTask);
            } else {
              await backgroundTask;
            }
          }
          return;
        } else if (choice === '3' || choice.includes('أختار') || choice.includes('بنفسي')) {
          // Let user enter their own task
          await ctx.reply('📝 اكتب اسم المهمة اللي عايز تشتغل عليها:');

          // Set state for custom task entry
          await ctx.db.insert('conversation_state', {
            chat_id: chatId,
            conversation_type: 'stuck_custom_task',
            current_step: 1,
            data: {},
            expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          });
          return;
        }
        // If not a valid choice, continue to regular handling
      }

      // Handle stuck custom task entry
      const stuckCustomSession = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(chatId), conversation_type: op.eq('stuck_custom_task') },
        limit: 1,
      });

      if (stuckCustomSession.length > 0) {
        await ctx.db.delete('conversation_state', { chat_id: op.eq(chatId), conversation_type: op.eq('stuck_custom_task') });

        const apiKey = await ctx.settings.get('openrouter_api_key');
        const botToken = ctx.env.TELEGRAM_BOT_TOKEN;

        if (apiKey) {
          await ctx.reply('⏳ جاري بدء السبرنت...');

          const backgroundTask = (async () => {
            try {
              const aiModel = await getAIModelByTier(ctx.settings, 'low');
              const aiClient = createAIClient(apiKey, aiModel);
              const stuckHandler = createStuckHandler(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));

              // Process with user's custom task
              const result = await stuckHandler.processResponse(chatId, text);
              await sendTelegramMessageDirect(botToken, chatId, result.message);
            } catch (error) {
              console.error('Stuck custom task error:', error);
              await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ في بدء السبرنت');
            }
          })();

          if (ctx.executionContext?.waitUntil) {
            ctx.executionContext.waitUntil(backgroundTask);
          } else {
            await backgroundTask;
          }
        }
        return;
      }

      // Handle stuck alternatives selection
      const stuckAltSession = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(chatId), conversation_type: op.eq('stuck_alternatives') },
        limit: 1,
      });

      if (stuckAltSession.length > 0) {
        await ctx.db.delete('conversation_state', { chat_id: op.eq(chatId), conversation_type: op.eq('stuck_alternatives') });

        const apiKey = await ctx.settings.get('openrouter_api_key');
        const botToken = ctx.env.TELEGRAM_BOT_TOKEN;

        if (apiKey) {
          await ctx.reply('⏳ جاري بدء السبرنت...');

          const backgroundTask = (async () => {
            try {
              const aiModel = await getAIModelByTier(ctx.settings, 'low');
              const aiClient = createAIClient(apiKey, aiModel);
              const stuckHandler = createStuckHandler(ctx.db, ctx.settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));

              // Use the selected alternative
              const result = await stuckHandler.processResponse(chatId, text);
              await sendTelegramMessageDirect(botToken, chatId, result.message);
            } catch (error) {
              console.error('Stuck alternative selection error:', error);
              await sendTelegramMessageDirect(botToken, chatId, '❌ حدث خطأ في بدء السبرنت');
            }
          })();

          if (ctx.executionContext?.waitUntil) {
            ctx.executionContext.waitUntil(backgroundTask);
          } else {
            await backgroundTask;
          }
        }
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

  // Check if we're expecting a new task name (user tapped "➕ مهمة جديدة")
  if (selectionData.expectingNewTask) {
    await ctx.db.delete('conversation_state', { chat_id: op.eq(failureSelectKey) });
    await processTaskFailure(ctx, null, text.trim(), null);
    return;
  }

  const availableTasks = selectionData.availableTasks as Array<{
    id: string;
    content: string;
    parent_id?: string | null;
    priority?: number;
    due?: { date: string; is_recurring?: boolean; recurring?: boolean };
  }> || [];

  // Parse selection (fallback for number input)
  const selection = parseInt(text.trim(), 10);

  if (!isNaN(selection) && selection >= 1 && selection <= availableTasks.length) {
    await ctx.db.delete('conversation_state', { chat_id: op.eq(failureSelectKey) });
    const selectedTask = availableTasks[selection - 1];
    if (selectedTask) {
      // Determine parent info for subtask grouping
      const isSubtask = !!selectedTask.parent_id;
      let parentContent: string | null = null;
      if (isSubtask && selectedTask.parent_id) {
        const parentTask = availableTasks.find((t: any) => t.id === selectedTask.parent_id);
        parentContent = parentTask?.content || null;
      }
      await processTaskFailure(ctx, selectedTask.id, selectedTask.content, selectedTask.due, {
        parent_id: selectedTask.parent_id || null,
        parent_content: parentContent,
        is_subtask: isSubtask,
        priority: selectedTask.priority,
      });
      return;
    }
  }

  // Text doesn't match - prompt to use buttons
  await ctx.reply('🔘 استخدم الأزرار أعلاه لاختيار مهمة، أو اضغط "➕ مهمة جديدة" لإضافة مهمة');
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
              const tasksResponse = await fetch('https://api.todoist.com/api/v1/tasks', {
                headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
              });

              if (!tasksResponse.ok) {
                await sendTelegramMessageDirect(botToken, chatId, '❌ فشل في جلب المهام من Todoist');
                return;
              }

              const tasksJson = await tasksResponse.json() as any;
              const allTasks = (Array.isArray(tasksJson) ? tasksJson : (tasksJson.results || [])) as Array<{
                id: string;
                content: string;
                project_id: string;
                priority: number;
                parent_id?: string;
                due?: { date: string; is_recurring?: boolean; recurring?: boolean } | null;
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
                      is_manual: true, // Preserve during Todoist sync
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
                  await fetch(`https://api.todoist.com/api/v1/tasks/${task.id}/close`, {
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

  // Check if we're expecting a new task name (user tapped "➕ مهمة جديدة")
  if (selectionData.expectingNewTask) {
    // Delete selection state
    await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) });

    // Start tracking new task (not in Todoist)
    const taskKey = `active_task_${chatId}`;
    const startDate = getTodayInEgypt();
    const newName = text.trim();

    await ctx.db.insert('conversation_state', {
      chat_id: taskKey,
      conversation_type: 'active_task',
      data: {
        taskName: newName,
        originalSearch: newName,
        todoistTaskId: null,
        startTime: Date.now(),
        startDate: startDate,
      },
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

    const now = new Date();
    const timeStr = now.toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' });

    await ctx.reply(
      `⏱️ **بدأ تتبع المهمة**\n\n` +
      `📌 ${newName}\n` +
      `🕐 البداية: ${timeStr}\n` +
      `📝 مهمة جديدة (سيتم إنشاؤها في Todoist عند الإكمال)`,
      { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
    );
    return;
  }

  // Old number-based selection (kept as fallback, but inline keyboard is primary)
  const matchedTasks = selectionData.matchedTasks as Array<{ id: string; content: string }> || [];
  const availableTasks = selectionData.availableTasks as Array<{ id: string; content: string }> || [];
  const taskList = matchedTasks.length > 0 ? matchedTasks : availableTasks;
  const selection = parseInt(text.trim(), 10);

  if (!isNaN(selection) && selection >= 1 && selection <= taskList.length) {
    const selectedTask = taskList[selection - 1];
    if (selectedTask) {
      await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) });

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
      const { extractCleanTaskName } = await import('../utils/task-parser');

      await ctx.reply(
        `⏱️ **بدأ تتبع المهمة**\n\n` +
        `📌 ${extractCleanTaskName(selectedTask.content).trim()}\n` +
        `🕐 البداية: ${timeStr}`,
        { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
      );
      return;
    }
  }

  // Text doesn't match a number - ignore (let user use the inline keyboard)
  await ctx.reply('🔘 استخدم الأزرار أعلاه لاختيار مهمة، أو اضغط "➕ مهمة جديدة" لإضافة مهمة');
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
      `⏱️ **بدأ تتبع المهمة**\n\n` +
      `📌 ${taskName}\n` +
      `🕐 البداية: ${timeStr}\n` +
      `📝 مهمة جديدة (سيتم إنشاؤها في Todoist عند الإكمال)`,
      { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
    );
  } else {
    await ctx.reply('✅ تم الإلغاء');
  }
  return;
}

      // Check for pending resume selection (from /resumetask)
      const resumeKey = `resume_select_${chatId}`;
      const pendingResume = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(resumeKey) },
      });

      if (pendingResume.length > 0) {
        const resumeData = (pendingResume[0] as any).data || {};
        const sessions = resumeData.sessions as Array<{ id: string; taskId: string | null; taskContent: string; totalTimeWorked: number; sessionCount: number }> || [];

        // Parse user selection
        const lowerText = text.trim().toLowerCase();
        let selectedSession: typeof sessions[0] | undefined;

        // Handle "نعم" or "yes" for single session
        if (sessions.length === 1 && (lowerText === 'نعم' || lowerText === 'yes' || text.trim() === '1')) {
          selectedSession = sessions[0];
        } else {
          const selection = parseInt(text.trim(), 10);
          if (!isNaN(selection) && selection >= 1 && selection <= sessions.length) {
            selectedSession = sessions[selection - 1];
          }
        }

        // Delete selection state
        await ctx.db.delete('conversation_state', { chat_id: op.eq(resumeKey) });

        if (!selectedSession) {
          await ctx.reply('✅ تم الإلغاء');
          return;
        }

        // Resume the session
        const { createTaskSessionManager } = await import('../services/task-session-manager');
        const sessionMgr = createTaskSessionManager(ctx.db);

        try {
          const session = await sessionMgr.resumeSession(selectedSession.id);

          // Create active_task record in conversation_state
          const taskKey = `active_task_${chatId}`;
          const startDate = getTodayInEgypt();

          await ctx.db.insert('conversation_state', {
            chat_id: taskKey,
            conversation_type: 'active_task',
            data: {
              taskName: session.taskContent,
              todoistTaskId: session.taskId,
              startTime: Date.now(),
              startDate: startDate,
              sessionId: session.id, // Link to session
              previousTimeWorked: session.totalTimeWorked, // Track cumulative time
            },
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          });

          const now = new Date();
          const timeStr = now.toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' });

          // Format time nicely
          const formatTime = (mins: number): string => {
            if (mins < 60) return `${mins} دقيقة`;
            const h = Math.floor(mins / 60);
            const m = mins % 60;
            if (m === 0) return h === 1 ? 'ساعة' : `${h} ساعات`;
            return `${h} ساعة ${m} دقيقة`;
          };

          await ctx.reply(
            `▶️ *تم استئناف المهمة!*\n\n` +
            `📌 ${session.taskContent}\n` +
            `🕐 استئناف: ${timeStr}\n` +
            `⏱️ الوقت السابق: ${formatTime(session.totalTimeWorked)}\n` +
            `🔄 الجلسة رقم: ${session.sessionCount}\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `/completetask - إنهاء المهمة\n` +
            `/resumelater - إيقاف مؤقت`,
            { parse_mode: 'Markdown' }
          );
        } catch (error) {
          console.error('Resume session error:', error);
          await ctx.reply('❌ حدث خطأ أثناء استئناف المهمة');
        }
        return;
      }

      // Check for pending resume decision (from /starttask with paused session)
      const resumeDecisionKey = `resume_decision_${chatId}`;
      const pendingDecision = await ctx.db.select('conversation_state', {
        filter: { chat_id: op.eq(resumeDecisionKey) },
      });

      if (pendingDecision.length > 0) {
        const decisionData = (pendingDecision[0] as any).data || {};
        const selection = text.trim();

        // Delete decision state
        await ctx.db.delete('conversation_state', { chat_id: op.eq(resumeDecisionKey) });

        const { createTaskSessionManager } = await import('../services/task-session-manager');
        const sessionMgr = createTaskSessionManager(ctx.db);

        if (selection === '1' || selection === 'نعم' || selection.toLowerCase() === 'yes') {
          // Resume the paused session
          try {
            const session = await sessionMgr.resumeSession(decisionData.sessionId);

            // Create active_task record
            const taskKey = `active_task_${chatId}`;
            const startDate = getTodayInEgypt();

            await ctx.db.insert('conversation_state', {
              chat_id: taskKey,
              conversation_type: 'active_task',
              data: {
                taskName: session.taskContent,
                todoistTaskId: session.taskId,
                startTime: Date.now(),
                startDate: startDate,
                sessionId: session.id,
                previousTimeWorked: session.totalTimeWorked,
              },
              expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            });

            const now = new Date();
            const timeStr = now.toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' });

            const formatTime = (mins: number): string => {
              if (mins < 60) return `${mins} دقيقة`;
              const h = Math.floor(mins / 60);
              const m = mins % 60;
              if (m === 0) return h === 1 ? 'ساعة' : `${h} ساعات`;
              return `${h} ساعة ${m} دقيقة`;
            };

            await ctx.reply(
              `▶️ *تم استئناف المهمة!*\n\n` +
              `📌 ${session.taskContent}\n` +
              `🕐 استئناف: ${timeStr}\n` +
              `⏱️ الوقت السابق: ${formatTime(session.totalTimeWorked)}\n` +
              `🔄 الجلسة رقم: ${session.sessionCount}\n\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `/completetask - إنهاء المهمة`,
              { parse_mode: 'Markdown' }
            );
          } catch (error) {
            console.error('Resume error:', error);
            await ctx.reply('❌ حدث خطأ أثناء استئناف الجلسة');
          }
        } else if (selection === '2' || selection === 'لا' || selection.toLowerCase() === 'no') {
          // Abandon old session and start fresh
          try {
            await sessionMgr.abandonSession(chatId).catch(() => {});

            // Start new session
            const taskName = decisionData.taskName;
            const taskKey = `active_task_${chatId}`;
            const startDate = getTodayInEgypt();

            // Start new tracking session
            await sessionMgr.startSession(chatId, decisionData.taskId, taskName);

            await ctx.db.insert('conversation_state', {
              chat_id: taskKey,
              conversation_type: 'active_task',
              data: {
                taskName: taskName,
                todoistTaskId: decisionData.taskId,
                startTime: Date.now(),
                startDate: startDate,
              },
              expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            });

            const now = new Date();
            const timeStr = now.toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' });

            await ctx.reply(
              `⏱️ **بدأ تتبع المهمة**\n\n` +
              `📌 ${taskName}\n` +
              `🕐 البداية: ${timeStr}\n` +
              `_تم إلغاء الجلسة السابقة وبدأنا من الصفر_`,
              { parse_mode: 'Markdown', reply_markup: createTaskStartedKeyboard() }
            );
          } catch (error) {
            console.error('Fresh start error:', error);
            await ctx.reply('❌ حدث خطأ أثناء بدء الجلسة الجديدة');
          }
        } else {
          await ctx.reply('✅ تم الإلغاء. استخدم /starttask لبدء مهمة جديدة');
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
              const updateResponse = await fetch(`https://api.todoist.com/api/v1/tasks/${todoistTaskId}`, {
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
                await fetch(`https://api.todoist.com/api/v1/tasks/${todoistTaskId}/close`, {
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
              const createResponse = await fetch('https://api.todoist.com/api/v1/tasks', {
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
                await fetch(`https://api.todoist.com/api/v1/tasks/${newTask.id}/close`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
                });

                const { createPostCompletionKeyboard: pcKb4 } = await import('../utils/keyboards');
                await ctx.reply(
                  `✅ تم إنشاء وإكمال مهمة جديدة في Todoist:\n📌 ${taskName}`,
                  { reply_markup: pcKb4() }
                );
              } else {
                const { createPostCompletionKeyboard: pcKb5 } = await import('../utils/keyboards');
                await ctx.reply(
                  `⚠️ تم حفظ المهمة محلياً (فشل Todoist):\n📌 ${taskName}`,
                  { reply_markup: pcKb5() }
                );
              }
            }
          } catch (todoistError) {
            console.error('Todoist error:', todoistError);
            const { createPostCompletionKeyboard: pcKb6 } = await import('../utils/keyboards');
            const completionSuffixLocal = '\n\n💪 جاهز للمهمة الجاية؟ ابدأ بـ /starttask';
            await ctx.reply(
              `⚠️ تم حفظ المهمة محلياً:\n📌 ${taskName}` + completionSuffixLocal,
              { reply_markup: pcKb6() }
            );
          }
        } else {
          const { createPostCompletionKeyboard: pcKb7 } = await import('../utils/keyboards');
          const completionSuffixInline = '\n\n💪 جاهز للمهمة الجاية؟ ابدأ بـ /starttask';
          await ctx.reply(
            `✅ تم إكمال المهمة:\n📌 ${taskName}` + completionSuffixInline,
            { reply_markup: pcKb7() }
          );
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
          // Use HIGH tier for unified report analysis (critical task)
          const aiModel = await getAIModelByTier(ctx.settings, 'high');
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
