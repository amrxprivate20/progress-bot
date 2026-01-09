// ============================================
// Report Processing Queue Consumer
// ============================================
// Handles long-running AI report generation in background
// NO TIMEOUT LIMITS - Can take as long as needed!

import type { SupabaseClient } from '../database/client';
import type { SettingsManager } from '../database/settings';
import { op } from '../database/client';
import { createReportGenerator } from '../services/report-generator';
import { createAIClient } from '../services/ai-client';
import { createMemoryManager } from '../services/memory-manager';

// ============================================
// Types
// ============================================

export interface ReportJobMessage {
  jobId: string;
  chatId: string;
  reportData: any;
  userAnswers: Record<string, string>;
  apiKey: string;
  aiModel: string;
}

// ============================================
// Queue Consumer
// ============================================

/**
 * Process report generation job from queue
 * This runs in a separate execution context with NO timeout limits!
 */
export async function processReportJob(
  message: ReportJobMessage,
  db: SupabaseClient,
  settings: SettingsManager
): Promise<void> {
  const { jobId, chatId, reportData, userAnswers, apiKey, aiModel } = message;

  console.log(`🎯 [Job ${jobId}] Starting report processing for chat ${chatId}`);

  try {
    // Update job status to processing
    await updateJobStatus(db, jobId, 'processing', 'جاري التحليل بالذكاء الاصطناعي...');

    // Get bot token for sending messages
    const botToken = await settings.get('telegram_bot_token');
    if (!botToken) {
      throw new Error('Bot token not configured');
    }

    // Send status update to user
    await sendTelegramMessage(chatId, botToken, '🤖 جاري التحليل بالذكاء الاصطناعي...');

    // Validate API key
    if (!apiKey.startsWith('sk-or-v1-')) {
      throw new Error('Invalid OpenRouter API key format');
    }

    console.log(`🏗️ [Job ${jobId}] Creating services...`);

    // Create services
    const reportGen = createReportGenerator(db, settings);
    const aiClient = createAIClient(apiKey, aiModel);
    const memoryMgr = createMemoryManager(db, aiClient);

    // Generate past week summary
    const pastWeekSummary = reportGen.generatePastWeekSummary(reportData.previousReports || []);

    console.log(`🤖 [Job ${jobId}] Calling AI (this may take 15-30 seconds)...`);
    const startTime = Date.now();

    // Call AI for unified analysis (NO TIMEOUT HERE!)
    const aiResponse = await aiClient.generateDailyReport({
      reportDate: reportData.date,
      tasks: reportData.tasks,
      streaks: reportData.streaks,
      weeklyGoals: reportData.weeklyGoals?.goals_text || null,
      dailyChallenge: reportData.dailyChallenge?.challenge_text || null,
      memory: reportData.memory,
      pastWeekSummary,
      strategicGoals: reportData.strategicGoals,
      userAnswers: Object.keys(userAnswers).length > 0 ? userAnswers : undefined,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ [Job ${jobId}] AI analysis complete in ${elapsed}s`);

    // Update status
    await updateJobStatus(db, jobId, 'processing', 'جاري إرسال النتائج...');

    // Send results to user
    await sendReportResults(chatId, botToken, reportData, aiResponse);

    console.log(`🧠 [Job ${jobId}] Updating memory...`);

    // Update memory
    if (Object.keys(aiResponse.memoryUpdates).length > 0) {
      await sendTelegramMessage(chatId, botToken, '🧠 جاري تحديث الذاكرة...');
      await memoryMgr.updateMemory(aiResponse.memoryUpdates);
      await sendTelegramMessage(chatId, botToken, '✅ تم تحديث الذاكرة');
    }

    // Check if memory optimization is needed
    if (aiResponse.memoryOptimization === 'OPTIMIZE_NEEDED') {
      await sendTelegramMessage(chatId, botToken, '🔄 جاري تحسين الذاكرة...');
      await memoryMgr.checkOptimizationTriggers();
    }

    console.log(`💾 [Job ${jobId}] Saving report to database...`);

    // Save report to database
    await sendTelegramMessage(chatId, botToken, '💾 جاري حفظ التقرير...');
    const stats = reportGen.calculateStatistics(reportData.tasks);

    await db.insert('daily_reports', {
      report_date: reportData.date,
      report_markdown: aiResponse.mainCommentary,
      success_rate: stats.success_rate,
      total_tasks: stats.total_tasks,
      completed_tasks: stats.completed_tasks,
      failed_tasks: stats.failed_tasks,
      achievement_time_minutes: stats.total_time_minutes,
      challenge_evaluation: aiResponse.challengeEvaluation,
      ai_commentary: aiResponse.mainCommentary,
      suggested_reward: aiResponse.reward,
      weekly_goals_analysis: JSON.stringify(aiResponse.goalsAnalysis),
    });

    console.log(`✅ [Job ${jobId}] Report saved successfully`);

    // Final success message
    await sendTelegramMessage(chatId, botToken, '✅ تم حفظ التقرير بنجاح!');

    // Mark job as completed
    await updateJobStatus(db, jobId, 'completed', 'تم بنجاح!');

    console.log(`🎉 [Job ${jobId}] Processing complete!`);

  } catch (error) {
    console.error(`💥 [Job ${jobId}] Error:`, error);

    // Mark job as failed
    await updateJobStatus(
      db,
      jobId,
      'failed',
      'حدث خطأ أثناء المعالجة',
      (error as Error).message
    );

    // Notify user
    const botToken = await settings.get('telegram_bot_token');
    if (botToken) {
      await sendTelegramMessage(
        chatId,
        botToken,
        '❌ حدث خطأ أثناء معالجة التقرير. حاول مرة أخرى لاحقاً.'
      );
    }

    throw error;
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Update job status in database
 */
async function updateJobStatus(
  db: SupabaseClient,
  jobId: string,
  status: 'queued' | 'processing' | 'completed' | 'failed',
  progressMessage?: string,
  errorMessage?: string
): Promise<void> {
  const updateData: any = {
    status,
    progress_message: progressMessage,
  };

  if (status === 'processing' && !updateData.started_at) {
    updateData.started_at = new Date().toISOString();
  }

  if (status === 'completed' || status === 'failed') {
    updateData.completed_at = new Date().toISOString();
  }

  if (errorMessage) {
    updateData.error_message = errorMessage;
  }

  await db.update('job_status', { job_id: op.eq(jobId) }, updateData);
}

/**
 * Send message via Telegram
 */
async function sendTelegramMessage(
  chatId: string,
  botToken: string,
  text: string
): Promise<void> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: 'Markdown',
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Telegram API error:', error);
    }
  } catch (error) {
    console.error('Failed to send Telegram message:', error);
  }
}

/**
 * Send long message with splitting
 */
async function sendLongMessage(
  chatId: string,
  botToken: string,
  text: string
): Promise<void> {
  const MAX_LENGTH = 4096;

  if (text.length <= MAX_LENGTH) {
    await sendTelegramMessage(chatId, botToken, text);
    return;
  }

  // Split at paragraph breaks
  const parts: string[] = [];
  let currentPart = '';
  const lines = text.split('\n');

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
    await sendTelegramMessage(chatId, botToken, part);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Send all report results to user
 */
async function sendReportResults(
  chatId: string,
  botToken: string,
  reportData: any,
  aiResponse: any
): Promise<void> {
  // Send commentary
  await sendTelegramMessage(chatId, botToken, '💬 *التحليل والتعليق:*');
  await sendLongMessage(chatId, botToken, aiResponse.mainCommentary);

  // Send challenge evaluation
  if (reportData.dailyChallenge) {
    await sendTelegramMessage(
      chatId,
      botToken,
      `🎯 *تقييم التحدي اليومي:* ${aiResponse.challengeEvaluation}\n` +
      `"${reportData.dailyChallenge.challenge_text}"`
    );
  }

  // Send reward
  if (aiResponse.reward) {
    await sendTelegramMessage(
      chatId,
      botToken,
      `🎁 *المكافأة المقترحة:* ${aiResponse.reward}`
    );
  }

  // Send goals analysis
  if (aiResponse.goalsAnalysis) {
    let goalsMsg = '🎯 *تحليل الأهداف الأسبوعية:*\n\n';

    if (aiResponse.goalsAnalysis.completed.length > 0) {
      goalsMsg += '✅ *منجزة:*\n';
      aiResponse.goalsAnalysis.completed.forEach((g: string) => goalsMsg += `- ${g}\n`);
      goalsMsg += '\n';
    }

    if (aiResponse.goalsAnalysis.inProgress.length > 0) {
      goalsMsg += '🔄 *قيد التنفيذ:*\n';
      aiResponse.goalsAnalysis.inProgress.forEach((g: string) => goalsMsg += `- ${g}\n`);
      goalsMsg += '\n';
    }

    if (aiResponse.goalsAnalysis.neglected.length > 0) {
      goalsMsg += '⚠️ *مهملة:*\n';
      aiResponse.goalsAnalysis.neglected.forEach((g: string) => goalsMsg += `- ${g}\n`);
    }

    await sendTelegramMessage(chatId, botToken, goalsMsg);
  }
}