// ============================================
// Confirm Command Handler (Queue-based)
// ============================================
// Queues report generation job instead of processing synchronously

import type { BotContext } from './grammy';
import type { ReportJobMessage } from '../queues/report-processor';
import { createReportGenerator } from '../services/report-generator';
import { createAIClient } from '../services/ai-client';
import { createConversationManager } from '../services/conversation-manager';
import { v4 as uuidv4 } from 'crypto';

/**
 * Handle /confirm command - Queue report generation job
 */
export async function handleConfirmCommand(ctx: BotContext, reportQueue: any): Promise<void> {
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
      // No questions, queue job immediately
      await queueReportJob(ctx, reportQueue, reportData, {}, trimmedKey, aiModel);
    }

  } catch (error) {
    console.error('Confirm command error:', error);
    await ctx.reply('❌ حدث خطأ أثناء بدء التحليل. حاول مرة أخرى.');
  }
}

/**
 * Queue report generation job (called after Q&A or directly)
 */
export async function queueReportJob(
  ctx: BotContext,
  reportQueue: any,
  reportData: any,
  userAnswers: Record<string, string>,
  apiKey: string,
  aiModel: string
): Promise<void> {
  const chatId = ctx.chat?.id.toString() || '';
  
  // Generate unique job ID
  const jobId = uuidv4();

  console.log(`📋 [Job ${jobId}] Queueing report generation for chat ${chatId}`);

  try {
    // Create job status record
    await ctx.db.insert('job_status', {
      job_id: jobId,
      chat_id: chatId,
      job_type: 'report_generation',
      status: 'queued',
      progress_message: 'في قائمة الانتظار...',
    });

    // Create job message
    const jobMessage: ReportJobMessage = {
      jobId,
      chatId,
      reportData,
      userAnswers,
      apiKey,
      aiModel,
    };

    // Send to queue
    await reportQueue.send(jobMessage);

    console.log(`✅ [Job ${jobId}] Queued successfully`);

    // Notify user
    await ctx.reply(
      '✅ *تم بدء التحليل!*\n\n' +
      'جاري معالجة تقريرك في الخلفية. سأرسل لك النتائج خلال دقيقة أو دقيقتين.\n\n' +
      'يمكنك الاستمرار في استخدام البوت عادياً، سأرسل لك التقرير تلقائياً عند الانتهاء! 🚀',
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error(`❌ [Job ${jobId}] Failed to queue:`, error);
    
    // Update job status
    await ctx.db.update(
      'job_status',
      { job_id: jobId },
      {
        status: 'failed',
        error_message: (error as Error).message,
      }
    );

    await ctx.reply('❌ حدث خطأ أثناء إضافة المهمة للقائمة. حاول مرة أخرى.');
  }
}

/**
 * Helper to generate UUID (crypto is built-in to Workers)
 */
function uuidv4(): string {
  return crypto.randomUUID();
}