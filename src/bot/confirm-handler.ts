// ============================================
// Confirm Command Handler - FIXED VERSION
// ============================================
// FIXES APPLIED:
// - First question shows progress indicator [1/N]
// - Removed job ID message spam
// - Cleaner user experience

import type { BotContext } from './grammy';
import type { ReportJobData } from '../durable-objects/report-processor';
import { createReportGenerator } from '../services/report-generator';
import { createAIClient } from '../services/ai-client';
import { createConversationManager } from '../services/conversation-manager';

/**
 * Handle /confirm command - Start Durable Object job
 */
export async function handleConfirmCommand(
  ctx: BotContext, 
  reportProcessorNamespace: DurableObjectNamespace
): Promise<void> {
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
    const botToken = await ctx.settings.get('telegram_bot_token');

    if (!openRouterKey || openRouterKey.trim().length === 0) {
      await ctx.reply('❌ OpenRouter API key غير مضبوط في الإعدادات');
      return;
    }

    if (!botToken) {
      await ctx.reply('❌ Bot token غير مضبوط');
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
        'سأرسل سؤال واحد في كل مرة. أجب بحرية!\n' +
        'يمكنك استخدام /skip_questions لتخطي الأسئلة المتبقية.'
      );

      // FIXED: Send first question WITH PROGRESS
      const firstQuestion = await conversationMgr.getCurrentQuestion(chatId);
      const progress = await conversationMgr.getProgress(chatId);
      
      if (firstQuestion && progress) {
        await ctx.reply(`[${progress}] ❓ ${firstQuestion}`);
      }
    } else {
      // No questions, start job immediately
      await startDurableObjectJob(
        ctx, 
        reportProcessorNamespace, 
        reportData, 
        {}, 
        trimmedKey, 
        aiModel, 
        botToken
      );
    }

  } catch (error) {
    console.error('Confirm command error:', error);
    await ctx.reply('❌ حدث خطأ أثناء بدء التحليل. حاول مرة أخرى.');
  }
}

/**
 * Start Durable Object job for report processing
 */
export async function startDurableObjectJob(
  ctx: BotContext,
  reportProcessorNamespace: DurableObjectNamespace,
  reportData: any,
  userAnswers: Record<string, string>,
  apiKey: string,
  aiModel: string,
  botToken: string
): Promise<void> {
  const chatId = ctx.chat?.id.toString() || '';
  
  // Generate unique job ID
  const jobId = crypto.randomUUID();

  console.log(`📋 [Job ${jobId}] Starting Durable Object job for chat ${chatId}`);

  try {
    // Create job data
    const jobData: ReportJobData = {
      jobId,
      chatId,
      reportData,
      userAnswers,
      apiKey,
      aiModel,
      botToken,
    };

    // Get Durable Object instance for this job
    const id = reportProcessorNamespace.idFromName(jobId);
    const stub = reportProcessorNamespace.get(id);

    // Start processing (non-blocking)
    const response = await stub.fetch(
      new Request('https://fake-host/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jobData),
      })
    );

    await response.json() as { success: boolean; message: string };

    console.log(`✅ [Job ${jobId}] Durable Object job started`);

    // FIXED: Simplified notification without job ID spam
    await ctx.reply(
      '✅ تم بدء التحليل!\n\n' +
      'جاري معالجة تقريرك في الخلفية. سأرسل لك النتائج خلال دقيقة أو دقيقتين.\n\n' +
      'يمكنك الاستمرار في استخدام البوت عادياً! 🚀'
    );

  } catch (error) {
    console.error(`❌ [Job ${jobId}] Failed to start:`, error);
    await ctx.reply('❌ حدث خطأ أثناء بدء المعالجة. حاول مرة أخرى.');
  }
}
