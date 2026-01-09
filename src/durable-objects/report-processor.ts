// ============================================
// Report Processor Durable Object
// ============================================
// Handles long-running AI report generation without timeout limits
// Each report job gets its own isolated Durable Object instance

import { DurableObject } from 'cloudflare:workers';
import { createSupabaseClient } from '../database/client';
import { SettingsManager as SettingsMgr } from '../database/settings';
import { createReportGenerator } from '../services/report-generator';
import { createAIClient } from '../services/ai-client';
import { createMemoryManager } from '../services/memory-manager';
import type { Env } from '../types';

// ============================================
// Types
// ============================================

export interface ReportJobData {
  jobId: string;
  chatId: string;
  reportData: any;
  userAnswers: Record<string, string>;
  apiKey: string;
  aiModel: string;
  botToken: string;
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
      aiModel, 
      botToken 
    } = jobData;

    console.log(`🎯 [Job ${jobId}] Starting report processing`);

    try {
      // Update status
      this.status = {
        status: 'processing',
        progress: 'جاري التحليل بالذكاء الاصطناعي...',
        startedAt: new Date().toISOString(),
      };

      // Send status to user
      await this.sendTelegramMessage(
        chatId, 
        botToken, 
        '🤖 جاري التحليل بالذكاء الاصطناعي...'
      );

      // Validate API key
      if (!apiKey.startsWith('sk-or-v1-')) {
        throw new Error('Invalid OpenRouter API key format');
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

      // Create services
      const reportGen = createReportGenerator(db, settings);
      const aiClient = createAIClient(apiKey, aiModel);
      const memoryMgr = createMemoryManager(db, aiClient);

      // Generate past week summary
      const pastWeekSummary = reportGen.generatePastWeekSummary(
        reportData.previousReports || []
      );

      console.log(`🤖 [Job ${jobId}] Calling AI (may take 15-60 seconds)...`);
      const startTime = Date.now();

      // Update progress
      this.status.progress = 'جاري استدعاء الذكاء الاصطناعي...';

      // Call AI - THIS IS THE LONG OPERATION (no timeout here!)
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

      // Update progress
      this.status.progress = 'جاري إرسال النتائج...';

      // Send results to user
      await this.sendReportResults(chatId, botToken, reportData, aiResponse);

      console.log(`🧠 [Job ${jobId}] Updating memory...`);
      this.status.progress = 'جاري تحديث الذاكرة...';

      // Update memory
      if (Object.keys(aiResponse.memoryUpdates).length > 0) {
        await this.sendTelegramMessage(chatId, botToken, '🧠 جاري تحديث الذاكرة...');
        await memoryMgr.updateMemory(aiResponse.memoryUpdates);
        await this.sendTelegramMessage(chatId, botToken, '✅ تم تحديث الذاكرة');
      }

      // Check memory optimization
      if (aiResponse.memoryOptimization === 'OPTIMIZE_NEEDED') {
        await this.sendTelegramMessage(chatId, botToken, '🔄 جاري تحسين الذاكرة...');
        await memoryMgr.checkOptimizationTriggers();
      }

      console.log(`💾 [Job ${jobId}] Saving report to database...`);
      this.status.progress = 'جاري حفظ التقرير...';

      // Save report to database - USE UPSERT to handle duplicates
      await this.sendTelegramMessage(chatId, botToken, '💾 جاري حفظ التقرير...');
      const stats = reportGen.calculateStatistics(reportData.tasks);

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
      }, 'report_date'); // Upsert based on report_date

      console.log(`✅ [Job ${jobId}] Report saved successfully`);

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
   * Escape markdown special characters
   */
  private escapeMarkdown(text: string): string {
    return text
      .replace(/\_/g, '\\_')
      .replace(/\*/g, '\\*')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/\~/g, '\\~')
      .replace(/\`/g, '\\`')
      .replace(/\>/g, '\\>')
      .replace(/\#/g, '\\#')
      .replace(/\+/g, '\\+')
      .replace(/\-/g, '\\-')
      .replace(/\=/g, '\\=')
      .replace(/\|/g, '\\|')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\./g, '\\.')
      .replace(/\!/g, '\\!');
  }

  /**
   * Send Telegram message
   * FIXED: Don't use Markdown parse_mode to avoid formatting errors
   */
  private async sendTelegramMessage(
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
            // Don't use parse_mode to avoid markdown parsing errors
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
}