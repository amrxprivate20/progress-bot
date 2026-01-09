// ============================================
// Grammy Bot Setup with Durable Objects Support
// ============================================

import { Bot, Context, webhookCallback } from 'grammy';
import type { SupabaseClient } from '../database/client';
import type { SettingsManager } from '../database/settings';
import { createConversationManager } from '../services/conversation-manager';
import { createMemoryManager } from '../services/memory-manager';
import { createReportGenerator } from '../services/report-generator';
import { createAIClient } from '../services/ai-client';
import { handleConfirmCommand, startDurableObjectJob } from './confirm-handler';

/**
 * Extended context with Durable Objects namespace
 */
export interface BotContext extends Context {
  db: SupabaseClient;
  settings: SettingsManager;
  reportProcessorNamespace: DurableObjectNamespace; // Changed from reportQueue
}

/**
 * Create and configure Grammy bot with Durable Objects support
 */
export function createBot(
  token: string,
  db: SupabaseClient,
  settings: SettingsManager,
  reportProcessorNamespace: DurableObjectNamespace // Changed from queue
): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  // Add custom properties to context
  bot.use(async (ctx, next) => {
    ctx.db = db;
    ctx.settings = settings;
    ctx.reportProcessorNamespace = reportProcessorNamespace; // Changed
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

📊 /progress - عرض ملخص اليوم
✅ /confirm - بدء التحليل الكامل (معالجة خلفية - لا انتظار!)
❌ /cancel - إلغاء المحادثة

🧠 /memory - عرض الذاكرة المنظمة
🗑 /clearmemory - مسح كل الذاكرة

📝 /createtasks - إنشاء مهام الأسبوع (قريباً)
📄 /lastupdate - إنشاء ملف LastUpdate.md (قريباً)

✨ *جديد:* التحليل يعمل الآن في الخلفية بدون حدود زمنية! 🚀
    `.trim();

    await ctx.reply(welcomeMessage);
  });

  // Help command
  bot.command('help', async (ctx) => {
    const helpMessage = `
📖 دليل الاستخدام

1️⃣ التقرير اليومي:
استخدم /progress للحصول على ملخص اليوم
استخدم /confirm لبدء التحليل الكامل

✨ *المعالجة الخلفية:*
- التحليل يعمل الآن في الخلفية
- لن تنتظر - سأرسل لك النتائج تلقائياً
- يمكنك الاستمرار باستخدام البوت
- لا حدود زمنية للمعالجة!

2️⃣ الذاكرة:
/memory - عرض كل ما تعلمته عنك
/clearmemory - مسح الذاكرة

3️⃣ المهام والأهداف:
/createtasks - إنشاء مهام من الأهداف (قريباً)
/lastupdate - ملخص الحالة الحالية (قريباً)

💡 نصيحة: البوت يتتبع المهام تلقائياً من Todoist!
    `.trim();

    await ctx.reply(helpMessage);
  });

  // Progress command (report preview)
  bot.command('progress', async (ctx) => {
    try {
      await ctx.reply('🔄 جاري إعداد ملخص اليوم...');

      const reportGen = createReportGenerator(ctx.db, ctx.settings);
      const conversationMgr = createConversationManager(ctx.db);

      // Check for active conversation
      const chatId = ctx.chat?.id.toString() || '';
      const hasConversation = await conversationMgr.hasActiveConversation(chatId);

      if (hasConversation) {
        await ctx.reply('⚠️ لديك محادثة نشطة. استخدم /cancel لإلغائها أولاً.');
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

  // Confirm command - NOW WITH DURABLE OBJECTS!
  bot.command('confirm', async (ctx) => {
    await handleConfirmCommand(ctx, ctx.reportProcessorNamespace);
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
    await ctx.reply(
      '⚠️ *تحذير*\n\n' +
      'هل أنت متأكد من رغبتك في مسح كل الذاكرة؟\n' +
      'هذا الإجراء لا يمكن التراجع عنه.\n\n' +
      'أرسل "نعم" للتأكيد أو "لا" للإلغاء',
      { parse_mode: 'Markdown' }
    );
  });

  // Placeholder commands for Phase 3
  bot.command('createtasks', async (ctx) => {
    await ctx.reply('⚠️ هذه الميزة ستكون متاحة في المرحلة 3');
  });

  bot.command('lastupdate', async (ctx) => {
    await ctx.reply('⚠️ هذه الميزة ستكون متاحة في المرحلة 3');
  });

  // Handle text messages (for Q&A flow)
  bot.on('message:text', async (ctx) => {
    try {
      const chatId = ctx.chat?.id.toString() || '';
      const text = ctx.message?.text || '';
      const conversationMgr = createConversationManager(ctx.db);

      const hasConversation = await conversationMgr.hasActiveConversation(chatId);

      if (hasConversation) {
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
          const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';
          const botToken = await ctx.settings.get('telegram_bot_token');

          if (openRouterKey && botToken) {
            await startDurableObjectJob(
              ctx,
              ctx.reportProcessorNamespace,
              reportContext,
              answers || {},
              openRouterKey.trim(),
              aiModel,
              botToken
            );
          }

        } else {
          // Send next question
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
}

/**
 * Send long message with splitting
 */
async function sendLongMessage(ctx: Context, message: string) {
  const MAX_LENGTH = 4096;
  
  if (message.length <= MAX_LENGTH) {
    await ctx.reply(message);
    return;
  }

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

  for (const part of parts) {
    await ctx.reply(part);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
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