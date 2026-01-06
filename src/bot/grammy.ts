// ============================================
// Grammy Bot Setup and Handlers
// ============================================

import { Bot, Context, webhookCallback } from 'grammy';
import type { Env } from '../types';
import type { SupabaseClient } from '../database/client';
import type { SettingsManager } from '../database/settings';

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
      
      // This will be implemented in Phase 2
      await ctx.reply(
        '⚠️ هذه الميزة ستكون متاحة في المرحلة 2\n' +
        'Progress report generation coming in Phase 2!'
      );
    } catch (error) {
      console.error('Progress command error:', error);
      await ctx.reply('❌ حدث خطأ أثناء إعداد الملخص. حاول مرة أخرى.');
    }
  });

  // Confirm command
  bot.command('confirm', async (ctx) => {
    await ctx.reply(
      '⚠️ هذه الميزة ستكون متاحة في المرحلة 2\n' +
      'Report confirmation will be available in Phase 2!'
    );
  });

  // Cancel command
  bot.command('cancel', async (ctx) => {
    await ctx.reply('✅ تم الإلغاء');
  });

  // Memory command
  bot.command('memory', async (ctx) => {
    try {
      await ctx.reply('🔄 جاري تحميل الذاكرة...');
      
      // Get all memory categories
      const memory = await ctx.db.select('memory', {
        columns: 'category,content,last_updated',
        order: 'category.asc',
      });

      if (memory.length === 0) {
        await ctx.reply('📝 الذاكرة فارغة حالياً');
        return;
      }

      // Format memory display
      let message = '*🧠 الذاكرة المنظمة*\n\n';
      
      for (const item of memory) {
        message += `*${item.category}:*\n`;
        
        if (item.content && item.content.trim().length > 0) {
          // Truncate if too long
          const content = item.content.length > 500 
            ? item.content.substring(0, 500) + '...'
            : item.content;
          message += `${content}\n\n`;
        } else {
          message += '_(فارغ)_\n\n';
        }
      }

      // Split message if too long (Telegram limit: 4096 chars)
      await ctx.reply(message);
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

    // This will be enhanced with conversation state in Phase 2
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
    // This will be enhanced in Phase 2 for Q&A flows
    // For now, just acknowledge
    const text = ctx.message.text.toLowerCase();
    
    // Simple responses for memory clear confirmation
    if (text === 'نعم' || text === 'yes') {
      // Check if there's a pending memory clear operation
      // This is simplified for Phase 1
      await ctx.reply('تم إلغاء العملية. استخدم /clearmemory للمحاولة مرة أخرى');
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
 * Send long message by splitting if necessary
 */
async function sendLongMessage(ctx: Context, message: string) {
  const MAX_LENGTH = 4096;
  
  if (message.length <= MAX_LENGTH) {
    await ctx.reply(message);  // Remove parse_mode
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
    await ctx.reply(part);  // Remove parse_mode
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

    const data = await response.json();
    
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

    const data = await response.json();
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
