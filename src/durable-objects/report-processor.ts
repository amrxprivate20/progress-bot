// ============================================
// Report Processor Durable Object - FIXED
// ============================================
// FIXED: Removed unused escapeMarkdown function (TypeScript error)
// FIXED: Removed noisy progress messages
// FIXED: Uses timezone utilities for Egypt UTC+2

import { DurableObject } from 'cloudflare:workers';
import { createSupabaseClient, op } from '../database/client';
import { SettingsManager as SettingsMgr } from '../database/settings';
import { createReportGenerator } from '../services/report-generator';
import { createUnifiedAIClient } from '../services/ai-client';
import { createMemoryManager } from '../services/memory-manager';
import { createDriveService } from '../services/google-drive';
import type { Env } from '../types';

// ============================================
// Types
// ============================================

export interface ReportJobData {
  jobId: string;
  chatId: string;
  reportData: any;
  userAnswers: Record<string, string>;
  apiKey: string; // OpenRouter API key
  anthropicApiKey?: string; // Anthropic API key (optional, takes priority)
  aiModel: string;
  botToken: string;
  useAnthropicPrimary?: boolean; // Default true if anthropicApiKey provided
}

export interface JobStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: string;
  result?: any;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// ============================================
// Report Processor Durable Object
// ============================================

export class ReportProcessor extends DurableObject<Env> {
  private status: JobStatus = {
    status: 'pending',
    progress: 'في قائمة الانتظار...',
  };

  /**
   * Handle HTTP requests to this Durable Object
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // GET /status - Check job status
    if (path === '/status' && request.method === 'GET') {
      return new Response(JSON.stringify(this.status), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /process - Start processing job
    if (path === '/process' && request.method === 'POST') {
      const jobData = await request.json() as ReportJobData;

      // Start processing in background (don't await)
      this.ctx.waitUntil(this.processReport(jobData));

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Processing started',
          jobId: jobData.jobId
        }),
        {
          status: 202, // Accepted
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // POST /createtasks - Create Todoist tasks in background
    if (path === '/createtasks' && request.method === 'POST') {
      const { jobId } = await request.json() as { jobId: string };

      // Start processing in background (don't await)
      this.ctx.waitUntil(this.processCreateTasks(jobId));

      return new Response(
        JSON.stringify({ success: true, message: 'Task creation started', jobId }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Process the report in background
   * This runs WITHOUT timeout limits!
   */
  private async processReport(jobData: ReportJobData): Promise<void> {
    const {
      jobId,
      chatId,
      reportData,
      userAnswers,
      apiKey,
      anthropicApiKey,
      aiModel,
      botToken,
      useAnthropicPrimary
    } = jobData;

    console.log(`🎯 [Job ${jobId}] Starting report processing`);

    try {
      // Update status
      this.status = {
        status: 'processing',
        progress: 'جاري التحليل بالذكاء الاصطناعي...',
        startedAt: new Date().toISOString(),
      };

      // Send initial status to user
      await this.sendTelegramMessage(
        chatId, 
        botToken, 
        '🤖 جاري التحليل بالذكاء الاصطناعي...'
      );

      // Validate API keys - need at least one valid key
      const hasValidAnthropicKey = anthropicApiKey && anthropicApiKey.startsWith('sk-ant-');
      const hasValidOpenRouterKey = apiKey && apiKey.startsWith('sk-or-v1-');

      if (!hasValidAnthropicKey && !hasValidOpenRouterKey) {
        throw new Error('No valid AI API key provided. Need either Anthropic or OpenRouter key.');
      }

      // Create database clients
      const db = createSupabaseClient({
        SUPABASE_URL: this.env.SUPABASE_URL,
        SUPABASE_ANON_KEY: this.env.SUPABASE_ANON_KEY,
        TELEGRAM_BOT_TOKEN: '', // Not needed for DB
        TELEGRAM_CHAT_ID: '', // Not needed for DB
        TODOIST_API_TOKEN: '', // Not needed for DB
      } as any);
      const settings = new SettingsMgr(db);

      console.log(`🏗️ [Job ${jobId}] Creating services...`);
      console.log(`🔑 [Job ${jobId}] Anthropic: ${hasValidAnthropicKey ? 'available' : 'not configured'}, OpenRouter: ${hasValidOpenRouterKey ? 'available' : 'not configured'}`);

      // Create services
      const reportGen = createReportGenerator(db, settings);
      const aiClient = createUnifiedAIClient({
        anthropicApiKey: hasValidAnthropicKey ? anthropicApiKey : undefined,
        openRouterApiKey: hasValidOpenRouterKey ? apiKey : undefined,
        anthropicModel: 'claude-sonnet-4-20250514',
        openRouterModel: aiModel,
        useAnthropicPrimary: useAnthropicPrimary !== false, // Default to Anthropic if available
      });
      const memoryMgr = createMemoryManager(db, aiClient as any);

      // Generate past week summary
      const pastWeekSummary = reportGen.generatePastWeekSummary(
        reportData.previousReports || []
      );

      console.log(`🤖 [Job ${jobId}] Calling AI (may take 15-60 seconds)...`);
      const startTime = Date.now();

      // Call AI - THIS IS THE LONG OPERATION (no timeout here!)
      // AFTER (CORRECT):
const aiResponse = await aiClient.generateDailyReport({
  reportDate: reportData.date,
  tasks: reportData.tasks,
  failedTasksJson: reportData.failedTasksJson, // ✅ ADD THIS
  streaks: reportData.streaks,
  weeklyGoals: reportData.weeklyGoals?.goals_text || null,
  dailyChallenge: reportData.dailyChallenge?.challenge_text || null,
  memory: reportData.memory,
  pastWeekSummary,
  strategicGoals: reportData.strategicGoals,
  userAnswers: Object.keys(userAnswers).length > 0 ? userAnswers : undefined,
  journalContent: reportData.journal,
});
    // ✅ TEMPORARY DEBUG: Log raw AI response
    console.log('🤖 RAW AI RESPONSE - MEMORY_UPDATES section:');
    const debugMatch = aiResponse.mainCommentary.match(/\[MEMORY_UPDATES\]([\s\S]*?)(?:\[|$)/i);
        if (debugMatch) {
      console.log(debugMatch[1]);
        } else {
      console.log('No MEMORY_UPDATES section found');
}

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ [Job ${jobId}] AI analysis complete in ${elapsed}s`);

      // Send results to user
      await this.sendReportResults(chatId, botToken, reportData, aiResponse);

      // Update memory with detailed logging
if (aiResponse.memoryUpdates && Object.keys(aiResponse.memoryUpdates).length > 0) {
  console.log(`🧠 [Job ${jobId}] Updating memory with ${Object.keys(aiResponse.memoryUpdates).length} categories...`);
  console.log(`🧠 [Job ${jobId}] Memory updates object:`, JSON.stringify(aiResponse.memoryUpdates));
  
  try {
    // Log what we're updating
    for (const [category, content] of Object.entries(aiResponse.memoryUpdates)) {
      console.log(`  📝 Category: "${category}"`);
      console.log(`  📝 Content preview: ${content.substring(0, 100)}...`);
    }
    
    await memoryMgr.updateMemory(aiResponse.memoryUpdates);
    console.log(`✅ [Job ${jobId}] Memory updated successfully`);
    
    // Send notification to user
    await this.sendTelegramMessage(chatId, botToken, '🧠 تم تحديث الذاكرة بنجاح');
  } catch (memError) {
    console.error(`❌ [Job ${jobId}] Memory update failed:`, memError);
    console.error(`❌ [Job ${jobId}] Memory error stack:`, (memError as Error).stack);
    await this.sendTelegramMessage(chatId, botToken, '⚠️ فشل تحديث الذاكرة: ' + (memError as Error).message);
  }
} else {
  console.log(`ℹ️ [Job ${jobId}] No memory updates in AI response`);
}

      // Check memory optimization
      if (aiResponse.memoryOptimization === 'OPTIMIZE_NEEDED') {
        console.log(`🔄 [Job ${jobId}] Optimizing memory...`);
        await memoryMgr.checkOptimizationTriggers();
      }

      // Save report to database
      console.log(`💾 [Job ${jobId}] Saving report to database...`);
      const stats = reportGen.calculateStatistics(reportData.tasks, reportData.failedTasksJson);

      await db.upsert('daily_reports', {
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
      }, 'report_date');

      console.log(`✅ [Job ${jobId}] Report saved successfully`);

      // Save to Google Drive (if configured)
      try {
        const driveService = createDriveService(db, settings);
        const driveResult = await driveService.saveReport({
          report_date: new Date(reportData.date),
          report_markdown: aiResponse.mainCommentary,
          success_rate: stats.success_rate,
          total_tasks: stats.total_tasks,
          completed_tasks: stats.completed_tasks,
          failed_tasks: stats.failed_tasks,
        } as any);

        if (driveResult.success) {
          console.log(`☁️ [Job ${jobId}] Report saved to Google Drive`);
          // Also update _LastUpdate.md
          await driveService.updateLastUpdateFile();
        } else if (driveResult.error !== 'Google Drive not configured') {
          console.warn(`⚠️ [Job ${jobId}] Google Drive save failed:`, driveResult.error);
        }
      } catch (driveError) {
        console.warn(`⚠️ [Job ${jobId}] Google Drive error (non-fatal):`, driveError);
        // Don't fail the whole job if Google Drive fails
      }

      // Final success message
      await this.sendTelegramMessage(chatId, botToken, '✅ تم حفظ التقرير بنجاح!');

      // Mark as completed
      this.status = {
        status: 'completed',
        progress: 'تم بنجاح!',
        result: {
          commentary: aiResponse.mainCommentary,
          challenge: aiResponse.challengeEvaluation,
          reward: aiResponse.reward,
          goals: aiResponse.goalsAnalysis,
        },
        startedAt: this.status.startedAt,
        completedAt: new Date().toISOString(),
      };

      console.log(`🎉 [Job ${jobId}] Processing complete!`);

    } catch (error) {
      console.error(`💥 [Job ${jobId}] Error:`, error);

      // Mark as failed
      this.status = {
        status: 'failed',
        progress: 'حدث خطأ',
        error: (error as Error).message,
        startedAt: this.status.startedAt,
        completedAt: new Date().toISOString(),
      };

      // Notify user
      await this.sendTelegramMessage(
        chatId,
        botToken,
        '❌ حدث خطأ أثناء معالجة التقرير:\n' + (error as Error).message
      );
    }
  }

  /**
   * Send Telegram message
   * Don't use Markdown parse_mode to avoid formatting errors
   */
  private async sendTelegramMessage(
    chatId: string,
    botToken: string,
    text: string
  ): Promise<void> {
    console.log(`[Telegram] Sending message to ${chatId}, length: ${text.length}`);
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: text,
          }),
        }
      );

      const responseText = await response.text();
      console.log(`[Telegram] Response status: ${response.status}, body: ${responseText.substring(0, 200)}`);

      if (!response.ok) {
        console.error('Telegram API error:', responseText);
      }
    } catch (error) {
      console.error('Failed to send Telegram message:', error);
    }
  }

  /**
   * Send long message with splitting
   */
  private async sendLongMessage(
    chatId: string,
    botToken: string,
    text: string
  ): Promise<void> {
    const MAX_LENGTH = 4096;

    if (text.length <= MAX_LENGTH) {
      await this.sendTelegramMessage(chatId, botToken, text);
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
      await this.sendTelegramMessage(chatId, botToken, part);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Send all report results
   */
  private async sendReportResults(
    chatId: string,
    botToken: string,
    reportData: any,
    aiResponse: any
  ): Promise<void> {
    // Send commentary
    await this.sendTelegramMessage(chatId, botToken, '💬 *التحليل والتعليق:*');
    await this.sendLongMessage(chatId, botToken, aiResponse.mainCommentary);

    // Send challenge evaluation
    if (reportData.dailyChallenge) {
      await this.sendTelegramMessage(
        chatId,
        botToken,
        `🎯 *تقييم التحدي اليومي:* ${aiResponse.challengeEvaluation}\n` +
        `"${reportData.dailyChallenge.challenge_text}"`
      );
    }

    // Send reward
    if (aiResponse.reward) {
      await this.sendTelegramMessage(
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
        aiResponse.goalsAnalysis.completed.forEach((g: string) => {
          goalsMsg += `- ${g}\n`;
        });
        goalsMsg += '\n';
      }

      if (aiResponse.goalsAnalysis.inProgress.length > 0) {
        goalsMsg += '🔄 *قيد التنفيذ:*\n';
        aiResponse.goalsAnalysis.inProgress.forEach((g: string) => {
          goalsMsg += `- ${g}\n`;
        });
        goalsMsg += '\n';
      }

      if (aiResponse.goalsAnalysis.neglected.length > 0) {
        goalsMsg += '⚠️ *مهملة:*\n';
        aiResponse.goalsAnalysis.neglected.forEach((g: string) => {
          goalsMsg += `- ${g}\n`;
        });
      }

      await this.sendTelegramMessage(chatId, botToken, goalsMsg);
    }
  }

  /**
   * Process create tasks job in background
   */
  private async processCreateTasks(jobId: string): Promise<void> {
    console.log(`🎯 [CreateTasks ${jobId}] Starting task creation`);

    let chatId = '';
    let botToken = '';
    let lockKey = '';

    try {
      // Get job data from database
      const db = createSupabaseClient({
        SUPABASE_URL: this.env.SUPABASE_URL,
        SUPABASE_ANON_KEY: this.env.SUPABASE_ANON_KEY,
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
        TODOIST_API_TOKEN: '',
      } as any);

      const jobData = await db.select('conversation_state', {
        filter: { chat_id: op.eq(`job_${jobId}`) },
      });

      if (jobData.length === 0) {
        console.error(`[CreateTasks ${jobId}] Job data not found`);
        return;
      }

      // data is JSONB, already parsed by Supabase
      const data = (jobData[0].data || {}) as any;
      chatId = data.chatId;
      lockKey = data.lockKey;
      botToken = data.botToken;
      const openRouterKey = data.openRouterKey;
      const anthropicApiKey = data.anthropicApiKey;
      const aiModel = data.aiModel;

      console.log(`[CreateTasks ${jobId}] Processing for chat ${chatId}`);

      // Create AI client
      const { createUnifiedAIClient } = await import('../services/ai-client');
      const aiClient = createUnifiedAIClient({
        anthropicApiKey: anthropicApiKey || undefined,
        openRouterApiKey: openRouterKey || undefined,
        openRouterModel: aiModel,
      });

      // Create task generator
      const settings = new SettingsMgr(db);
      const { createTaskGeneratorService } = await import('../services/todoist-client');
      const taskGen = createTaskGeneratorService(db, settings, aiClient as any);

      console.log(`[CreateTasks ${jobId}] Generating tasks...`);
      const result = await taskGen.generateAndCreateTasks();
      console.log(`[CreateTasks ${jobId}] Generation complete:`, result.success);
      console.log(`[CreateTasks ${jobId}] Result:`, JSON.stringify(result));

      // Send results
      if (result.success && result.createdTasks && result.createdTasks.length > 0) {
        console.log(`[CreateTasks ${jobId}] Sending success message with ${result.createdTasks.length} tasks`);
        let message = `🎉 تم إنشاء ${result.createdTasks.length} مهمة في Todoist!\n\n`;

        for (const task of result.createdTasks) {
          const priority = '⭐'.repeat(task.priority);
          const dueDate = task.due?.date || 'بدون موعد';
          message += `✅ ${task.content}\n`;
          message += `   📅 ${dueDate} ${priority}\n\n`;
        }

        message += '━━━━━━━━━━━━━━━━━━━━\n';
        message += '📱 افتح Todoist لرؤية المهام!';

        await this.sendTelegramMessage(chatId, botToken, message);
        console.log(`[CreateTasks ${jobId}] Success message sent`);
      } else {
        console.log(`[CreateTasks ${jobId}] No tasks created or error:`, result.error);
        console.log(`[CreateTasks ${jobId}] createdTasks:`, result.createdTasks);
        await this.sendTelegramMessage(
          chatId,
          botToken,
          `❌ ${result.error || 'لم يتم إنشاء أي مهام'}`
        );
      }

      // Clean up job data
      await db.delete('conversation_state', { chat_id: op.eq(`job_${jobId}`) });

      console.log(`🎉 [CreateTasks ${jobId}] Complete!`);

    } catch (error) {
      console.error(`💥 [CreateTasks ${jobId}] Error:`, error);

      if (chatId && botToken) {
        await this.sendTelegramMessage(
          chatId,
          botToken,
          '❌ حدث خطأ أثناء إنشاء المهام: ' + (error as Error).message
        );
      }
    } finally {
      // Always clear the lock
      if (lockKey) {
        try {
          const db = createSupabaseClient({
            SUPABASE_URL: this.env.SUPABASE_URL,
            SUPABASE_ANON_KEY: this.env.SUPABASE_ANON_KEY,
            TELEGRAM_BOT_TOKEN: '',
            TELEGRAM_CHAT_ID: '',
            TODOIST_API_TOKEN: '',
          } as any);
          await db.delete('conversation_state', { chat_id: op.eq(lockKey) });
        } catch (e) {
          console.error('Failed to clear lock:', e);
        }
      }
    }
  }
}
