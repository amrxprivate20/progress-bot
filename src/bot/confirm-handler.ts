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
import { createUnifiedAIClient } from '../services/ai-client';
import { createConversationManager } from '../services/conversation-manager';
import { op } from '../database/client';

/**
 * Handle /confirm command - Start Durable Object job
 */
export async function handleConfirmCommand(
  ctx: BotContext, 
  reportProcessorNamespace: DurableObjectNamespace
): Promise<void> {
  try {
    const chatId = ctx.chat?.id.toString() || '';

    // Check if there's a pending report date from /report command
    const pendingReportKey = `pending_report_${chatId}`;
    const pendingReportState = await ctx.db.select('conversation_state', {
      filter: { chat_id: op.eq(pendingReportKey) },
      limit: 1,
    });

    let targetDate: string | undefined;
    if (pendingReportState.length > 0) {
      const pendingData = (pendingReportState[0] as any).data || {};
      targetDate = pendingData.targetDate;
      // Clean up the pending state
      await ctx.db.delete('conversation_state', { chat_id: op.eq(pendingReportKey) });
    }

    const dateLabel = targetDate || 'اليوم';
    await ctx.reply(`🔄 جاري بدء التحليل الكامل لـ ${dateLabel}...`);

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
    const anthropicApiKey = await ctx.settings.get('anthropic_api_key');
    const aiModel = await ctx.settings.get('ai_model') || 'anthropic/claude-sonnet-4';
    const botToken = await ctx.settings.get('telegram_bot_token');
    const useAnthropicPrimary = (await ctx.settings.get('use_anthropic_primary')) !== 'false';

    // Validate we have at least one AI API key
    const hasValidAnthropicKey = anthropicApiKey && anthropicApiKey.trim().startsWith('sk-ant-');
    const hasValidOpenRouterKey = openRouterKey && openRouterKey.trim().startsWith('sk-or-v1-');

    if (!hasValidAnthropicKey && !hasValidOpenRouterKey) {
      await ctx.reply(
        '❌ لم يتم تكوين أي مفتاح AI API\n\n' +
        'يرجى إضافة أحد المفاتيح التالية في الإعدادات:\n' +
        '• anthropic_api_key (يبدأ بـ sk-ant-)\n' +
        '• openrouter_api_key (يبدأ بـ sk-or-v1-)'
      );
      return;
    }

    if (!botToken) {
      await ctx.reply('❌ Bot token غير مضبوط');
      return;
    }

    const trimmedOpenRouterKey = openRouterKey?.trim() || '';
    const trimmedAnthropicKey = anthropicApiKey?.trim() || '';

    // Create services - use UnifiedAIClient for question generation
    const reportGen = createReportGenerator(ctx.db, ctx.settings);
    const aiClient = createUnifiedAIClient({
      anthropicApiKey: hasValidAnthropicKey ? trimmedAnthropicKey : undefined,
      openRouterApiKey: hasValidOpenRouterKey ? trimmedOpenRouterKey : undefined,
      anthropicModel: 'claude-sonnet-4-20250514',
      openRouterModel: aiModel,
      useAnthropicPrimary,
    });

    // Collect report data (use target date if specified from /report command)
    await ctx.reply('📊 جاري جمع البيانات...');
    const reportData = await reportGen.collectReportData(targetDate);

    // Allow 0% success days to be reported - check for tasks OR failed tasks
    const hasCompletedTasks = reportData.tasks.length > 0;
    const hasFailedTasks = (reportData.failedTasksJson?.failed_tasks?.length || 0) > 0;

    if (!hasCompletedTasks && !hasFailedTasks) {
      await ctx.reply('⚠️ لا توجد مهام مكتملة أو فاشلة لهذا اليوم.\nأكمل مهمة واحدة على الأقل أو سجل مهمة فاشلة باستخدام /log_failure');
      return;
    }

    // Check if memory is empty (needs personal questions)
    const memoryIsEmpty = Object.values(reportData.memory).every(
      (content) => !content || content.trim() === ''
    );

    // Personal questions to ask when memory is empty
    const personalQuestions = memoryIsEmpty ? [
      'أخبرني عن نفسك باختصار - ما هي اهتماماتك الرئيسية وأهدافك في الحياة؟',
      'ما هو روتينك اليومي المثالي؟ (أوقات النوم، العمل، الراحة)',
      'ما هي أكبر التحديات التي تواجهها عادة في الإنتاجية؟',
      'ما الذي يحفزك ويعطيك طاقة؟ وما الذي يستنزف طاقتك؟',
    ] : [];

    // Generate AI questions based on tasks
    await ctx.reply('💭 جاري تحضير بعض الأسئلة التوضيحية...');
    const aiQuestions = await aiClient.generateQuestions({
      tasks: reportData.tasks,
      weeklyGoals: reportData.weeklyGoals?.goals_text || null,
      dailyChallenge: reportData.dailyChallenge?.challenge_text || null,
    });

    // Add the tomorrow planning question at the end (asks about circumstances for better planning)
    const tomorrowPlanningQuestion = 'ما هي ظروف الغد؟ (مواعيد، التزامات، طاقتك المتوقعة، أي شيء يساعد في التخطيط)';

    // Combine: personal questions (if memory empty) + AI questions + tomorrow question
    const questions = [...personalQuestions, ...aiQuestions, tomorrowPlanningQuestion];

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
        trimmedOpenRouterKey,
        aiModel,
        botToken,
        trimmedAnthropicKey,
        useAnthropicPrimary
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
  botToken: string,
  anthropicApiKey?: string,
  useAnthropicPrimary?: boolean
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
      anthropicApiKey,
      aiModel,
      botToken,
      useAnthropicPrimary,
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
