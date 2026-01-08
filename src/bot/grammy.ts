// ============================================
// Grammy Bot Setup and Handlers
// FIXED: Better error handling and logging in trigger
// ============================================

import { Bot, Context, webhookCallback } from 'grammy';
import type { SupabaseClient } from '../database/client';
import type { SettingsManager } from '../database/settings';
import { createReportGenerator } from '../services/report-generator';
import { createAIClient } from '../services/ai-client';
import { createConversationManager } from '../services/conversation-manager';
import { createMemoryManager } from '../services/memory-manager';

/**
 * Extended context with custom properties
 */
export interface BotContext extends Context {
  db: SupabaseClient;
  settings: SettingsManager;
}

/**
 * Create and configure Grammy bot
 */
export function createBot(
  token: string,
  db: SupabaseClient,
  settings: SettingsManager
): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  // Add custom properties to context
  bot.use(async (ctx, next) => {
    ctx.db = db;
    ctx.settings = settings;
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

الأوامر المتاحة:

📊 /progress - عرض ملخص اليوم وطلب التأكيد للتقرير الكامل
✅ /confirm - متابعة التحليل الكامل بعد المعاينة
❌ /cancel - إلغاء معالجة التقرير

🧠 /memory - عرض الذاكرة المنظمة
🗑 /clearmemory - مسح كل الذاكرة

📝 /createtasks - إنشاء مهام الأسبوع من الأهداف
📄 /lastupdate - إنشاء ملف LastUpdate.md

استخدم /help لمزيد من المعلومات.
    `.trim();

    await ctx.reply(welcomeMessage);
  });

// Help command
  bot.command('help', async (ctx) => {
    const helpMessage = `
📖 دليل الاستخدام

1️⃣ التقرير اليومي:
استخدم /progress للحصول على ملخص اليوم
سأعرض لك معاينة سريعة وأطلب التأكيد
استخدم /confirm للمتابعة أو /cancel للإلغاء

2️⃣ الذاكرة:
/memory - عرض كل ما تعلمته عنك (مصنف في 6 فئات)
/clearmemory - مسح كل الذاكرة (سأطلب التأكيد)

3️⃣ المهام والأهداف:
/createtasks - إنشاء مهام في Todoist من أهداف الأسبوع
/lastupdate - إنشاء ملف ملخص بالحالة الحالية

💡 نصائح:
- البوت يتتبع المهام تلقائياً من Todoist
- التقارير تُنشأ بالذكاء الاصطناعي مع تحليل مفصل
- الذاكرة تُحدّث تلقائياً من التقارير اليومية
    `.trim();

    await ctx.reply(helpMessage);
  });

  // Progress command (report preview)
  bot.command('progress', async (ctx) => {
    try {
      await ctx.reply('🔄 جاري إعداد ملخص اليوم...');

      // Create services
      const reportGen = createReportGenerator(ctx.db, ctx.settings);
      const conversationMgr = createConversationManager(ctx.db);

      // Check if user has active conversation
      const chatId = ctx.chat?.id.toString() || '';
      const hasConversation = await conversationMgr.hasActiveConversation(chatId);

      if (hasConversation) {
        await ctx.reply(
          '⚠️ لديك محادثة نشطة بالفعل.\n' +
          'استخدم /cancel لإلغائها أولاً.'
        );
        return;
      }

      // Generate preview
      const preview = await reportGen.generatePreview();

      // Send preview
      await sendLongMessage(ctx, preview.formatted_text);

    } catch (error) {
      console.error('Progress command error:', error);
      await ctx.reply('❌ حدث خطأ أثناء إعداد الملخص. حاول مرة أخرى.');
    }
  });

  // Confirm command
  bot.command('confirm', async (ctx) => {
    try {
      await ctx.reply('🔄 جاري بدء التحليل الكامل...');

      const chatId = ctx.chat?.id.toString() || '';
      const conversationMgr = createConversationManager(ctx.db);

      // Check if there's an active Q&A conversation
      const hasConversation = await conversationMgr.hasActiveConversation(chatId);
      if (hasConversation) {
        await ctx.reply(
          '⚠️ لديك محادثة نشطة بالفعل.\n' +
          'استخدم /cancel لإلغائها أولاً.'
        );
        return;
      }

      // Get API keys from settings
      const openRouterKey = await ctx.settings.get('openrouter_api_key');
      const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';

      if (!openRouterKey || openRouterKey.trim().length === 0) {
        await ctx.reply('❌ OpenRouter API key غير مضبوط في الإعدادات');
        return;
      }

      // Validate API key format
      const trimmedKey = openRouterKey.trim();
      if (!trimmedKey.startsWith('sk-or-v1-')) {
        await ctx.reply(
          '❌ OpenRouter API key غير صحيح\n\n' +
          'المفتاح يجب أن يبدأ بـ sk-or-v1-\n' +
          'تحقق من المفتاح في https://openrouter.ai/keys'
        );
        return;
      }

      // Create services
      const reportGen = createReportGenerator(ctx.db, ctx.settings);
      const aiClient = createAIClient(trimmedKey, aiModel);

      // Collect report data
      await ctx.reply('📊 جاري جمع البيانات...');
      const reportData = await reportGen.collectReportData();

      if (reportData.tasks.length === 0) {
        await ctx.reply('⚠️ لا توجد مهام لهذا اليوم');
        return;
      }

      // Generate questions using AI
      await ctx.reply('💭 جاري تحضير بعض الأسئلة التوضيحية...');
      const questions = await aiClient.generateQuestions({
        tasks: reportData.tasks,
        weeklyGoals: reportData.weeklyGoals?.goals_text || null,
        dailyChallenge: reportData.dailyChallenge?.challenge_text || null,
      });

      if (questions.length > 0) {
        // Start Q&A conversation
        await conversationMgr.startQAConversation(chatId, questions, reportData);

        await ctx.reply(
          `📝 لدي ${questions.length} أسئلة توضيحية لفهم تجربتك اليوم بشكل أفضل.\n\n` +
          'سأرسل سؤال واحد في كل مرة. أجب بحرية!'
        );

        // Send first question
        const firstQuestion = await conversationMgr.getCurrentQuestion(chatId);
        if (firstQuestion) {
          await ctx.reply(`❓ ${firstQuestion}`);
        }
      } else {
        // No questions, proceed directly with analysis
        await ctx.reply('🤖 جاري التحليل الكامل...');
        
        // Store report data for processing
        await storeReportForProcessing(ctx.db, chatId, reportData, {});
        
        // Trigger processing via self-call
        const triggerResult = await triggerReportProcessing(chatId, trimmedKey);
        
        if (!triggerResult.success) {
          console.error('Failed to trigger processing:', triggerResult.error);
          await ctx.reply('❌ حدث خطأ في بدء المعالجة. جاري المحاولة مباشرة...');
          // Fallback: process directly (may timeout but worth trying)
          await processInline(ctx, reportData, {});
        }
      }

    } catch (error) {
      console.error('Confirm command error:', error);
      await ctx.reply('❌ حدث خطأ أثناء بدء التحليل. حاول مرة أخرى.');
    }
  });

  // Cancel command
  bot.command('cancel', async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';
      const conversationMgr = createConversationManager(ctx.db);

      const hasConversation = await conversationMgr.hasActiveConversation(chatId);
      if (hasConversation) {
        await conversationMgr.clearConversation(chatId);
        await ctx.reply('✅ تم إلغاء المحادثة');
      } else {
        await ctx.reply('✅ لا توجد محادثة نشطة للإلغاء');
      }
    } catch (error) {
      console.error('Cancel command error:', error);
      await ctx.reply('✅ تم الإلغاء');
    }
  });

  // Memory command
  bot.command('memory', async (ctx) => {
    try {
      await ctx.reply('🔄 جاري تحميل الذاكرة...');

      // Get API keys (needed for memory manager)
      const openRouterKey = await ctx.settings.get('openrouter_api_key');
      const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';

      if (!openRouterKey) {
        // Fallback to direct database query
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

      // Use memory manager for formatted display
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
    await ctx.reply(
      '⚠️ *تحذير*\n\n' +
      'هل أنت متأكد من رغبتك في مسح كل الذاكرة؟\n' +
      'هذا الإجراء لا يمكن التراجع عنه.\n\n' +
      'أرسل "نعم" للتأكيد أو "لا" للإلغاء',
      { parse_mode: 'Markdown' }
    );
  });

  // Create tasks command
  bot.command('createtasks', async (ctx) => {
    await ctx.reply(
      '⚠️ هذه الميزة ستكون متاحة في المرحلة 3\n' +
      'Task creation will be available in Phase 3!'
    );
  });

  // Last update command
  bot.command('lastupdate', async (ctx) => {
    await ctx.reply(
      '⚠️ هذه الميزة ستكون متاحة في المرحلة 3\n' +
      'Last update file generation will be available in Phase 3!'
    );
  });

  // Handle text messages (for conversation flows)
  bot.on('message:text', async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';
      const text = ctx.message?.text || '';
      const conversationMgr = createConversationManager(ctx.db);

      // Check if user is in Q&A conversation
      const hasConversation = await conversationMgr.hasActiveConversation(chatId);

      if (hasConversation) {
        // Save answer
        await conversationMgr.saveAnswer(chatId, text);

        // Check if all questions answered
        const isComplete = await conversationMgr.isComplete(chatId);

        if (isComplete) {
          // All questions answered
          await ctx.reply('✅ شكراً على إجاباتك! جاري التحليل الكامل الآن...');

          const reportContext = await conversationMgr.getReportContext(chatId);
          const answers = await conversationMgr.getAnswers(chatId);

          // Clear conversation
          await conversationMgr.clearConversation(chatId);

          // Store report data for processing
          await storeReportForProcessing(ctx.db, chatId, reportContext, answers || {});
          
          // Get API key
          const openRouterKey = await ctx.settings.get('openrouter_api_key');
          if (openRouterKey) {
            // Trigger processing via self-call
            const triggerResult = await triggerReportProcessing(chatId, openRouterKey.trim());
            
            if (!triggerResult.success) {
              console.error('Failed to trigger processing:', triggerResult.error);
              await ctx.reply('❌ حدث خطأ في بدء المعالجة. جاري المحاولة مباشرة...');
              // Fallback: process directly
              await processInline(ctx, reportContext, answers || {});
            }
          }

        } else {
          // Get next question
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

  // Handle callback queries (for inline buttons)
  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery('Processing...');
    
    const data = ctx.callbackQuery.data;
    
    if (data === 'confirm_report') {
      await ctx.reply('Processing report confirmation...');
    } else if (data === 'cancel_report') {
      await ctx.reply('✅ Report cancelled');
    }
  });
}

/**
 * Store report data for processing (temporary storage)
 */
async function storeReportForProcessing(
  db: SupabaseClient,
  chatId: string,
  reportData: any,
  userAnswers: Record<string, string>
): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 15);

  const storageKey = `processing_${chatId}`;

  try {
    // Delete any existing entry first
    await db.delete('conversation_state', {
      filter: { chat_id: storageKey },
    });
  } catch (error) {
    console.log('No existing processing entry to delete');
  }

  // Insert fresh
  await db.insert('conversation_state', {
    chat_id: storageKey,
    conversation_type: 'report_processing',
    current_step: 0,
    total_steps: 1,
    data: {
      reportData,
      userAnswers,
    },
    expires_at: expiresAt.toISOString(),
  });
  
  console.log('✅ Report data stored for processing');
}

/**
 * Trigger report processing via worker self-call
 * FIXED: Now returns result and logs properly
 */
async function triggerReportProcessing(
  chatId: string,
  openRouterKey: string
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log('🚀 Triggering report processing for chat:', chatId);
    
    const url = 'https://progress-bot.progressbot.workers.dev/api/process-report';
    
    console.log('📡 Calling:', url);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Internal-Call': 'true'
      },
      body: JSON.stringify({
        chat_id: chatId,
        api_key: openRouterKey
      }),
    });

    console.log('📥 Response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Trigger failed:', errorText);
      return { success: false, error: errorText };
    }
    
    const result = await response.json();
    console.log('✅ Trigger successful:', result);
    
    return { success: true };
    
  } catch (error) {
    console.error('💥 Failed to trigger report processing:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Fallback: Process inline (may timeout but worth trying)
 */
async function processInline(
  ctx: BotContext,
  reportData: any,
  _userAnswers: Record<string, string>
): Promise<void> {
  // Simple inline processing without full AI analysis
  try {
    const stats = createReportGenerator(ctx.db, ctx.settings).calculateStatistics(reportData.tasks);
    
    let message = '📊 *ملخص سريع:*\n\n';
    message += `✅ المهام المكتملة: ${stats.completed_tasks}/${stats.total_tasks}\n`;
    message += `📈 معدل النجاح: ${stats.success_rate.toFixed(1)}%\n`;
    message += `⏱ الوقت: ${stats.total_time_minutes} دقيقة\n\n`;
    message += '⚠️ التحليل الكامل بالذكاء الاصطناعي تعذر إكماله.\n';
    message += 'يمكنك المحاولة مرة أخرى لاحقاً بإرسال /progress';
    
    await ctx.reply(message);
  } catch (error) {
    console.error('Inline processing error:', error);
    await ctx.reply('❌ حدث خطأ في المعالجة');
  }
}

/**
 * Send long message by splitting if necessary
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
 * Create webhook handler for Telegram
 */
export function createTelegramWebhookHandler(
  bot: Bot<BotContext>
): (request: Request) => Promise<Response> {
  return webhookCallback(bot, 'cloudflare-mod');
}

/**
 * Set webhook URL
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

    if (!data.ok) {
      console.error('Failed to set webhook:', data);
      return false;
    }

    console.log('Webhook set successfully:', webhookUrl);
    return true;
  } catch (error) {
    console.error('Error setting webhook:', error);
    return false;
  }
}

/**
 * Delete webhook
 */
export async function deleteWebhook(botToken: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/deleteWebhook`,
      { method: 'POST' }
    );

    const data = await response.json() as { ok: boolean };
    return data.ok;
  } catch (error) {
    console.error('Error deleting webhook:', error);
    return false;
  }
}

/**
 * Get webhook info
 */
export async function getWebhookInfo(botToken: string): Promise<any> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/getWebhookInfo`
    );

    return await response.json();
  } catch (error) {
    console.error('Error getting webhook info:', error);
    return null;
  }
}