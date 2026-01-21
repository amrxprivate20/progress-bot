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
import { createConversationManager } from '../services/conversation-manager';
import { createMemoryManager } from '../services/memory-manager';
import { createReportGenerator } from '../services/report-generator';
import { createAIClient } from '../services/ai-client';
import { createJournalManager } from '../services/journal';
import { createGoalsManager } from '../services/goals-manager';
// createTaskGeneratorService is now used only in Durable Object
import { createMediaStorageService } from '../services/supabase-storage';
import { getTodayInEgypt, getYesterdayInEgypt, getEgyptDayBoundaries } from '../utils/timezone';
import { handleConfirmCommand } from './confirm-handler';
import { syncFailuresFromTodoist, completeParentInTodoistIfAllDone } from '../handlers/todoist';

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
  env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string; SUPABASE_SERVICE_ROLE_KEY?: string; TELEGRAM_BOT_TOKEN: string }
): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  // Add custom properties to context
  bot.use(async (ctx, next) => {
    ctx.db = db;
    ctx.settings = settings;
    ctx.reportProcessorNamespace = reportProcessorNamespace;
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

/**
 * Register all bot commands
 */
function registerCommands(bot: Bot<BotContext>) {
  // Start command
  bot.command('start', async (ctx) => {
    const welcomeMessage = `
👋 مرحباً! أنا بوت تتبع التقدم الخاص بك.

📊 **التقارير:**
/today - عرض ملخص اليوم
/report YYYY-MM-DD - تقرير تاريخ محدد
/progress - ملخص + تأكيد التحليل
/confirm - بدء التحليل الكامل

📔 **اليوميات:**
/journal_start - بدء جلسة يوميات
/journal_end - إنهاء الجلسة
/journal_resume - استئناف الجلسة

🎯 **الأهداف:**
/goals - عرض أهداف الأسبوع
/generate_goals - توليد أهداف جديدة
/createtasks - إنشاء مهام في Todoist

⚙️ **الإعدادات:**
/lastupdate - حالة النظام
/memory - عرض الذاكرة
/clearmemory - مسح الذاكرة

📝 **أخرى:**
/log_failure - تسجيل مهمة فاشلة
/skip_questions - تخطي الأسئلة
/cancel - إلغاء المحادثة
/help - المساعدة

✨ التحليل يعمل في الخلفية بدون حدود زمنية! 🚀
    `.trim();

    await ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
  });

  // Help command
  bot.command('help', async (ctx) => {
    const helpMessage = `
📖 **دليل الاستخدام الشامل**

━━━━━━━━━━━━━━━━━━━━
📊 **التقارير والملخصات:**
━━━━━━━━━━━━━━━━━━━━
/today - ملخص سريع لليوم
/progress - ملخص اليوم + خيار التحليل
/confirm - بدء التحليل الكامل بالذكاء الاصطناعي
/report YYYY-MM-DD - تقرير تاريخ محدد
/lastupdate - حالة النظام والإحصائيات

━━━━━━━━━━━━━━━━━━━━
📔 **اليوميات:**
━━━━━━━━━━━━━━━━━━━━
/journal_start - بدء جلسة يوميات
/journal_end - إنهاء الجلسة
/journal_resume - استئناف جلسة مغلقة
/journal - عرض يوميات اليوم
/journal YYYY-MM-DD - عرض يوميات تاريخ محدد
📷 أثناء الجلسة: أرسل نصوص، صور، صوت، أو فيديو

━━━━━━━━━━━━━━━━━━━━
🎯 **الأهداف والمهام:**
━━━━━━━━━━━━━━━━━━━━
/goals - أهداف الأسبوع والتحديات اليومية
/todayplan - خطة اليوم بالساعات
/tomorrowplan - خطة الغد بالساعات
/generate_goals - توليد أهداف جديدة
/edit_goals - تعديل الأهداف الأسبوعية
/edit_challenges - تعديل التحديات اليومية
/createtasks - إنشاء مهام في Todoist
/log_failure - تسجيل مهمة فاشلة يدوياً
/sync - مزامنة المهام من Todoist

━━━━━━━━━━━━━━━━━━━━
🧠 **الذاكرة:**
━━━━━━━━━━━━━━━━━━━━
/memory - عرض الذاكرة المحفوظة
/clearmemory - مسح الذاكرة

━━━━━━━━━━━━━━━━━━━━
⚙️ **أخرى:**
━━━━━━━━━━━━━━━━━━━━
/skip_questions - تخطي الأسئلة
/cancel - إلغاء المحادثة
/start - رسالة الترحيب
/help - هذه الرسالة

━━━━━━━━━━━━━━━━━━━━
💡 **نصائح:**
• المهام تُتتبع تلقائياً من Todoist
• التحليل يعمل في الخلفية
• أرسل وسائط أثناء جلسة اليوميات
    `.trim();

    await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
  });

  // Sync command - manual Todoist sync
  bot.command('sync', async (ctx) => {
    try {
      await ctx.reply('🔄 جاري المزامنة مع Todoist...');

      const today = getTodayInEgypt();

      try {
  await syncFailuresFromTodoist(today, ctx.db, ctx.settings);
  await ctx.reply('✅ تمت المزامنة بنجاح! تم تحديث حالة المهام.');
} catch (error) {
  console.error('Sync error:', error);
  const errorMsg = error instanceof Error ? error.message : 'Unknown error';
  await ctx.reply(
    `❌ حدث خطأ أثناء المزامنة:\n${errorMsg}\n\n` +
    `تحقق من:\n` +
    `• صحة Todoist API token\n` +
    `• صحة Project ID\n` +
    `• اتصال الإنترنت`
  );
}

      await ctx.reply('✅ تمت المزامنة بنجاح! تم تحديث حالة المهام.');
    } catch (error) {
      console.error('Sync command error:', error);
      await ctx.reply('❌ حدث خطأ أثناء المزامنة: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
  });

  // Helper function to generate daily plan with hourly schedule
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
    let planMessage = `📅 **خطة ${titleWord} (${dayName} ${targetDate})**\n`;
    planMessage += `ـــــــــــــــــــــــ\n\n`;

    // Get day's challenge
    const challenges = await ctx.db.select('daily_challenges', {
      filter: { challenge_date: op.eq(targetDate) },
      limit: 1,
    });

    if (challenges.length > 0 && challenges[0]) {
      planMessage += `⚡ **التحدي:**\n`;
      planMessage += `"${challenges[0].challenge_text}"\n\n`;
    }

    // Get circumstances from yesterday's report (for tomorrow plan)
    if (!isToday) {
      const todayStr = getTodayInEgypt();
      const todayReports = await ctx.db.select('daily_reports', {
        filter: { report_date: op.eq(todayStr) },
        limit: 1,
      });

      if (todayReports.length > 0 && todayReports[0]?.user_comments) {
        try {
          const comments = JSON.parse(todayReports[0].user_comments);
          const answers = Object.values(comments);
          if (answers.length > 0) {
            const lastAnswer = answers[answers.length - 1] as string;
            if (lastAnswer && lastAnswer.length > 0) {
              planMessage += `📝 **الظروف:**\n`;
              planMessage += `"${lastAnswer}"\n\n`;
            }
          }
        } catch (e) { /* skip */ }
      }
    }

    // Get scheduled Todoist tasks - ALL tasks with the target due date
    const todoistToken = await ctx.settings.get('todoist_api_token');

    console.log('Plan command - targetDate:', targetDate);

    if (todoistToken) {
      try {
        const response = await fetch('https://api.todoist.com/rest/v3/tasks', {
          headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
        });

        if (response.ok) {
          const allTasks = await response.json() as Array<{
            content: string;
            project_id: string;
            due?: { date: string; datetime?: string };
            priority: number;
          }>;

          console.log('Plan command - total tasks from Todoist:', allTasks.length);

          // Filter: ALL tasks with the target due date (any project)
          // Handle both date formats: "YYYY-MM-DD" and "YYYY-MM-DDTHH:MM:SS"
          const dayTasks = allTasks.filter(t => {
            const taskDate = t.due?.date?.split('T')[0]; // Get just the date part
            return taskDate === targetDate;
          });

          console.log('Plan command - filtered tasks for date:', dayTasks.length);

          if (dayTasks.length > 0) {
            planMessage += `📋 **الجدول (${dayTasks.length} مهام):**\n\n`;

            // Group tasks by time periods
            const morning: typeof dayTasks = [];     // 5am - 9am
            const workHours: typeof dayTasks = [];   // 9am - 5pm
            const evening: typeof dayTasks = [];     // 5pm - 10pm
            const flexible: typeof dayTasks = [];    // no specific time

            for (const task of dayTasks) {
              if (task.due?.datetime) {
                const hour = new Date(task.due.datetime).getHours();
                if (hour >= 5 && hour < 9) {
                  morning.push(task);
                } else if (hour >= 9 && hour < 17) {
                  workHours.push(task);
                } else if (hour >= 17 && hour < 22) {
                  evening.push(task);
                } else {
                  flexible.push(task);
                }
              } else {
                flexible.push(task);
              }
            }

            // Sort each group by priority
            const sortByPriority = (a: typeof dayTasks[0], b: typeof dayTasks[0]) =>
              (b.priority || 1) - (a.priority || 1);

            morning.sort(sortByPriority);
            workHours.sort(sortByPriority);
            evening.sort(sortByPriority);
            flexible.sort(sortByPriority);

            const formatTask = (task: typeof dayTasks[0]) => {
              const priorityIcon = task.priority === 4 ? '🔴' :
                                  task.priority === 3 ? '🟠' :
                                  task.priority === 2 ? '🟡' : '⚪';
              return `  ${priorityIcon} ${task.content}`;
            };

            if (morning.length > 0) {
              planMessage += `🌅 **5am - 9am (الصباح الباكر):**\n`;
              morning.forEach(t => planMessage += formatTask(t) + '\n');
              planMessage += '\n';
            }

            if (workHours.length > 0) {
              planMessage += `💼 **9am - 5pm (ساعات العمل):**\n`;
              workHours.forEach(t => planMessage += formatTask(t) + '\n');
              planMessage += '\n';
            }

            if (evening.length > 0) {
              planMessage += `🌆 **5pm - 10pm (المساء):**\n`;
              evening.forEach(t => planMessage += formatTask(t) + '\n');
              planMessage += '\n';
            }

            if (flexible.length > 0) {
              planMessage += `📌 **مرنة (بدون وقت محدد):**\n`;
              flexible.forEach(t => planMessage += formatTask(t) + '\n');
              planMessage += '\n';
            }
          } else {
            planMessage += `📋 **المهام:**\n`;
            planMessage += `لا توجد مهام مجدولة لهذا التاريخ\n\n`;
          }
        }
      } catch (todoistError) {
        console.error('Todoist error in plan:', todoistError);
        planMessage += `⚠️ خطأ في جلب المهام من Todoist\n\n`;
      }
    } else {
      planMessage += `⚠️ لم يتم تكوين Todoist API token\n\n`;
    }

    planMessage += `ـــــــــــــــــــــــ\n`;
    planMessage += `💡 استخدم /createtasks لإنشاء مهام جديدة`;

    return planMessage;
  }

  // Today plan command - show plan for today with hourly schedule
  bot.command(['todayplan', 'today_plan'], async (ctx) => {
    try {
      await ctx.reply('🔄 جاري إعداد خطة اليوم...');
      const today = getTodayInEgypt();
      const planMessage = await generateDailyPlan(ctx, today, true);
      await ctx.reply(planMessage, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Today plan error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
  });

  // Tomorrow plan command - show plan for tomorrow with hourly schedule
  bot.command(['tomorrowplan', 'tomorrow_plan'], async (ctx) => {
    try {
      await ctx.reply('🔄 جاري إعداد خطة الغد...');
      const today = new Date(getTodayInEgypt());
      today.setDate(today.getDate() + 1);
      const tomorrow = today.toISOString().split('T')[0] || '';
      const planMessage = await generateDailyPlan(ctx, tomorrow, false);
      await ctx.reply(planMessage, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Tomorrow plan error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
  });

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

  // NEW: Skip questions command
  bot.command(['skip_questions', 'skipquestions'], async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';
      const conversationMgr = createConversationManager(ctx.db);

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
      const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';
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
  });

  // Cancel command - ENHANCED to cancel ANY pending operation
bot.command('cancel', async (ctx) => {
  try {
    const chatId = ctx.chat?.id.toString() || '';
    
    // Check for all types of pending operations
    const pendingOps = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.like(`%${chatId}%`) }, // Match any key containing chatId
    });
    
    if (pendingOps.length === 0) {
      await ctx.reply('✅ لا توجد عمليات نشطة للإلغاء');
      return;
    }
    
    // List what we're canceling
    const operationTypes = new Set<string>();
    for (const op of pendingOps) {
      operationTypes.add(op.conversation_type);
    }
    
    // Delete all pending operations for this user
    for (const op of pendingOps) {
      await ctx.db.delete('conversation_state', { 
        id: op.eq(op.id as string) 
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

      // Store available tasks for selection
      const selectKey = `failure_select_${chatId}`;
      
      // Delete any existing selection state
      try {
        await ctx.db.delete('conversation_state', { chat_id: op.eq(selectKey) });
      } catch (e) { /* ignore */ }
      
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

    } catch (error) {
      console.error('Log failure error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
  });
});

  // Memory command
  bot.command('memory', async (ctx) => {
    try {
      await ctx.reply('🔄 جاري تحميل الذاكرة...');

      const openRouterKey = await ctx.settings.get('openrouter_api_key');
      const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';

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
  });

  // NEW: /report command - Get report for specific date
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

      const reportGen = createReportGenerator(ctx.db, ctx.settings);
      const preview = await reportGen.generatePreview(dateStr);

      // Save target date for /confirm to use
      const pendingReportKey = `pending_report_${chatId}`;
      // Delete any existing pending report date first
      try {
        await ctx.db.delete('conversation_state', { chat_id: op.eq(pendingReportKey) });
      } catch (e) { /* ignore */ }
      // Save new pending report date
      await ctx.db.insert('conversation_state', {
        chat_id: pendingReportKey,
        conversation_type: 'pending_report_date',
        data: { targetDate: dateStr },
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minutes
      });

      await sendLongMessage(ctx, preview.formatted_text);

      // Prompt for confirm with the specific date
      await ctx.reply(
        '─────────────────────\n' +
        `📝 هذا ملخص تاريخ ${dateStr}\n\n` +
        '🤖 لتحليل مفصل بالذكاء الاصطناعي، استخدم:\n' +
        '/confirm\n\n' +
        '💡 التحليل يشمل: تعليق شخصي، تحديث الذاكرة، تقييم التحدي، واقتراح مكافأة'
      );

    } catch (error) {
      console.error('Report command error:', error);
      await ctx.reply('❌ حدث خطأ أثناء تحميل التقرير');
    }
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
      'استخدم /completetask لإكمال المهمة الآن'
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
      'استخدم /completetask لإكمال المهمة الآن'
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
    // Format duration
    let durationStr: string;
    if (durationMinutes < 60) {
      durationStr = `${durationMinutes}م`;
    } else {
      const hours = Math.floor(durationMinutes / 60);
      const mins = durationMinutes % 60;
      durationStr = mins > 0 ? `${hours}س${mins}م` : `${hours}س`;
    }

    // Build final task name
    let updatedTaskName = `${cleanName} [${durationStr}]`;
    if (manualQuantity && manualQuantityUnit) {
      updatedTaskName += ` [${manualQuantity} ${manualQuantityUnit}]`;
    }

    // Delete the active task record
    await ctx.db.delete('conversation_state', { chat_id: op.eq(taskKey) });

    // Complete the task in Todoist
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
            createdAt: Date.now(),
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

          // ✅ FIX: Check if parent should autocomplete
          await completeParentInTodoistIfAllDone(
            ctx.db,
            ctx.settings,
            todoistTaskId,
            startDate
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
      const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';

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
  });

  // Generate new weekly goals (typically run on Friday)
  bot.command(['generate_goals', 'generategoals'], async (ctx) => {
    await ctx.reply('🔄 جاري توليد أهداف الأسبوع القادم...');
    try {

      const openRouterKey = await ctx.settings.get('openrouter_api_key');
      const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';

      if (!openRouterKey) {
        await ctx.reply('❌ مفتاح API غير مكون');
        return;
      }

      const aiClient = createAIClient(openRouterKey.trim(), aiModel);
      const goalsMgr = createGoalsManager(ctx.db, ctx.settings, aiClient);

      const result = await goalsMgr.generateWeeklyGoals();

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

        await sendLongMessage(ctx, message);
      } else {
        await ctx.reply(`❌ ${result.error || 'حدث خطأ أثناء توليد الأهداف'}`);
      }
    } catch (error) {
      console.error('Generate goals error:', error);
      await ctx.reply('❌ حدث خطأ: ' + (error instanceof Error ? error.message : 'Unknown'));
    }
  });

  // Edit weekly goals
  bot.command(['edit_goals', 'editgoals'], async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';

      // Get current week's goals
      const openRouterKey = await ctx.settings.get('openrouter_api_key');
      const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';
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
  });

  // Edit weekly challenges
  bot.command(['edit_challenges', 'editchallenges'], async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';

      // Get current week's challenges
      const openRouterKey = await ctx.settings.get('openrouter_api_key');
      const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';
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
      const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';
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
  });

/**
 * Process a task failure - log to DB and handle Todoist (postpone or delete)
 */
async function processTaskFailure(
  ctx: BotContext,
  todoistTaskId: string | null,
  taskName: string,
  due?: { date: string; is_recurring: boolean } | null
): Promise<void> {
  try {
    const today = getTodayInEgypt();
    
    // Log failure to database
    await ctx.db.insert('tasks', {
      task_id: todoistTaskId || `manual_fail_${Date.now()}`,
      content: taskName,
      completed_at: new Date(`${today}T23:59:59+02:00`).toISOString(),
      status: 'failed',
      duration_minutes: 0,
      created_at: new Date().toISOString(),
    });

    console.log(`✅ Logged failure: ${taskName}`);

    // If no Todoist task ID, just confirm
    if (!todoistTaskId) {
      await ctx.reply(
        `✅ تم تسجيل المهمة الفاشلة:\n` +
        `❌ ${taskName}\n\n` +
        `ستظهر في تقرير اليوم`
      );
      return;
    }

    // Handle Todoist task
    const todoistToken = await ctx.settings.get('todoist_api_token');
    if (!todoistToken) {
      await ctx.reply(
        `✅ تم تسجيل الفشل محلياً:\n` +
        `❌ ${taskName}\n\n` +
        `(لم يتم التعامل مع Todoist - لا يوجد token)`
      );
      return;
    }

    const isRecurring = due?.is_recurring || false;

    if (isRecurring) {
      // Recurring task - postpone to next occurrence
      console.log(`🔄 Recurring task - postponing to next due date`);
      
      // Todoist automatically moves recurring tasks to next date when you complete them
      // So we just close it and it will reappear on next due date
      const closeResponse = await fetch(
        `https://api.todoist.com/rest/v3/tasks/${todoistTaskId}/close`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
        }
      );

      if (closeResponse.ok) {
        await ctx.reply(
          `✅ تم تسجيل الفشل وتأجيل المهمة:\n` +
          `❌ ${taskName}\n\n` +
          `📅 ستظهر المهمة في الموعد التالي`
        );
      } else {
        const error = await closeResponse.text();
        console.error('Failed to postpone task:', error);
        await ctx.reply(
          `✅ تم تسجيل الفشل محلياً:\n` +
          `❌ ${taskName}\n\n` +
          `⚠️ فشل تأجيل المهمة في Todoist`
        );
      }
    } else {
      // Non-recurring task - delete it
      console.log(`🗑️ Non-recurring task - deleting from Todoist`);
      
      const deleteResponse = await fetch(
        `https://api.todoist.com/rest/v3/tasks/${todoistTaskId}`,
        {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
        }
      );

      if (deleteResponse.ok) {
        await ctx.reply(
          `✅ تم تسجيل الفشل وحذف المهمة:\n` +
          `❌ ${taskName}\n\n` +
          `🗑️ تم حذف المهمة من Todoist`
        );
      } else {
        const error = await deleteResponse.text();
        console.error('Failed to delete task:', error);
        await ctx.reply(
          `✅ تم تسجيل الفشل محلياً:\n` +
          `❌ ${taskName}\n\n` +
          `⚠️ فشل حذف المهمة من Todoist`
        );
      }
    }

    // Sync failures to update JSON
    await syncFailuresFromTodoist(today, ctx.db, ctx.settings);

  } catch (error) {
    console.error('Error processing task failure:', error);
    await ctx.reply('❌ حدث خطأ أثناء معالجة الفشل: ' + (error instanceof Error ? error.message : 'Unknown'));
  }
}

  // Handle text messages (for Q&A flow, log_failure, task quantity, and journal)
  bot.on('message:text', async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';
      const text = ctx.message?.text || '';

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

// Handle new failure task name input
const failureNewTaskKey = `failure_new_task_${chatId}`;
const pendingFailureNewTask = await ctx.db.select('conversation_state', {
  filter: { chat_id: op.eq(failureNewTaskKey) },
});

if (pendingFailureNewTask.length > 0) {
  await ctx.db.delete('conversation_state', { chat_id: op.eq(failureNewTaskKey) });

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
        const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';
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
        const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';
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
            const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';
            
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
    `⏱️ بدأ تتبع المهمة:\n📌 ${selectedTask.content}\n🕐 وقت البدء: ${timeStr}\n\n` +
    `✅ تم العثور على المهمة في Todoist\n\n` +
    `استخدم /completetask عند الانتهاء`
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
      'استخدم /completetask لإكمال المهمة الآن'
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
      'استخدم /completetask لإكمال المهمة الآن'
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
          const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';
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
