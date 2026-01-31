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
import { createDebugLogger } from '../utils/debug-logger';

// ============================================
// Extended Env with Durable Object binding
// ============================================

interface EnvWithDO {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TODOIST_API_TOKEN: string;
  REPORT_PROCESSOR: DurableObjectNamespace;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AUTOFAIL_SECRET?: string;
}

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
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'waiting_for_answers';
  progress: string;
  result?: any;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// ============================================
// Report Processor Durable Object
// ============================================

export class ReportProcessor extends DurableObject<EnvWithDO> {
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

	// Auto-fail queue management routes
    if (url.pathname === '/autofail/check-queue' && request.method === 'POST') {
      const body = await request.json() as { today: string };
      const queue = await this.ctx.storage.get<string[]>(`autofail_queue_${body.today}`);
      return new Response(
        JSON.stringify({ exists: !!queue }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/autofail/init-queue' && request.method === 'POST') {
      const body = await request.json() as {
        today: string;
        taskIds: string[];
        tasks: any[];
        metadata: any;
      };
      await this.ctx.storage.put(`autofail_queue_${body.today}`, body.taskIds);
      await this.ctx.storage.put(`autofail_tasks_${body.today}`, body.tasks);
      await this.ctx.storage.put(`autofail_metadata_${body.today}`, body.metadata);
      await this.ctx.storage.put(`autofail_processed_${body.today}`, []);
      
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/autofail/process-batch' && request.method === 'POST') {
      try {
        const result = await this.processAutoFailBatch();
        return new Response(
          JSON.stringify(result),
          { headers: { 'Content-Type': 'application/json' } }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ error: (error as Error).message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    if (url.pathname === '/autofail/cleanup' && request.method === 'POST') {
      const body = await request.json() as { today: string };
      await this.ctx.storage.delete(`autofail_queue_${body.today}`);
      await this.ctx.storage.delete(`autofail_tasks_${body.today}`);
      await this.ctx.storage.delete(`autofail_metadata_${body.today}`);
      await this.ctx.storage.delete(`autofail_processed_${body.today}`);
      
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { 'Content-Type': 'application/json' } }
      );
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
    // ✅ NEW: Initialize debug logger
    const db = createSupabaseClient({
      SUPABASE_URL: this.env.SUPABASE_URL,
      SUPABASE_ANON_KEY: this.env.SUPABASE_ANON_KEY,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: '',
      TODOIST_API_TOKEN: '',
    } as any);
    const settings = new SettingsMgr(db);
    
    const debugLogger = createDebugLogger(settings);
    await debugLogger.init();
    
    await debugLogger.log(`[Job ${jobId}] Starting report processing`);
    
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

      console.log(`🏗️ [Job ${jobId}] Creating services...`);
      console.log(`🔑 [Job ${jobId}] Anthropic: ${hasValidAnthropicKey ? 'available' : 'not configured'}, OpenRouter: ${hasValidOpenRouterKey ? 'available' : 'not configured'}`);

      await debugLogger.log(
        `🏗️ **Creating AI Services**\n\n` +
        `Anthropic: ${hasValidAnthropicKey ? '✅' : '❌'}\n` +
        `OpenRouter: ${hasValidOpenRouterKey ? '✅' : '❌'}\n` +
        `Primary: ${useAnthropicPrimary ? 'Anthropic' : 'OpenRouter'}\n` +
        `Model: ${aiModel}`
      );

      // Create services
      const reportGen = createReportGenerator(db, settings);
      const aiClient = createUnifiedAIClient({
        anthropicApiKey: hasValidAnthropicKey ? anthropicApiKey : undefined,
        openRouterApiKey: hasValidOpenRouterKey ? apiKey : undefined,
        anthropicModel: 'claude-sonnet-4-20250514',
        openRouterModel: aiModel,
        useAnthropicPrimary: useAnthropicPrimary !== false,
      });

      // ✅ IMPROVED: Set debug logger with verification
      aiClient.setDebugLogger(debugLogger);
      
      if (debugLogger.isEnabled()) {
        console.log('🐛 Debug logger set on AI client');
        await debugLogger.log(
          `🤖 **AI Client Initialized**\n\n` +
          `Debug logging: ENABLED\n` +
          `Model: ${aiModel}\n` +
          `Provider: ${useAnthropicPrimary ? 'Anthropic (primary)' : 'OpenRouter (primary)'}`
        );
      }
      
      const memoryMgr = createMemoryManager(db, aiClient as any);

      // Generate past week summary
      const pastWeekSummary = reportGen.generatePastWeekSummary(
        reportData.previousReports || []
      );

            console.log(`🤖 [Job ${jobId}] Calling AI (may take 15-60 seconds)...`);
      await debugLogger.log(`🤖 **Starting AI Analysis** (may take 15-60s)`);
      
      const startTime = Date.now();

      // Generate formatted report first
console.log('📋 Generating formatted report for AI...');
const formattedReport = await reportGen.getFormattedReportForAI(reportData.date);
console.log('✅ Formatted report generated:', formattedReport.length, 'chars');

// ✅ NEW: Log the COMPLETE formatted report if debug enabled
if (debugLogger.isEnabled()) {
  await debugLogger.log(
    `📋 **FORMATTED REPORT (Complete)**\n\n` +
    `Length: ${formattedReport.length} characters\n` +
    `Date: ${reportData.date}\n\n` +
    `─────────────────────────────\n\n` +
    formattedReport,
    '📋'
  );
}

// ✅ NEW: Build and log the EXACT prompt that will be sent
if (debugLogger.isEnabled()) {
  // Manually build the prompt (same logic as buildUnifiedPrompt)
  let fullPrompt = `# تحليل التقدم اليومي - ${reportData.date}\n\n`;
  
  if (userAnswers && Object.keys(userAnswers).length > 0) {
    fullPrompt += `## إجابات المستخدم:\n`;
    fullPrompt += Object.entries(userAnswers).map(([q, a]) => `**س:** ${q}\n**ج:** ${a}`).join('\n\n') + '\n\n';
  }
  
  fullPrompt += `## التقرير اليومي:\n${formattedReport || 'لا توجد بيانات للتقرير'}\n\n`;
  
  if (reportData.journal) {
    fullPrompt += `## يوميات اليوم:\n${reportData.journal}\n\n`;
  }
  
  fullPrompt += `## ملخص الأسبوع الماضي:\n${pastWeekSummary}\n\n`;
  fullPrompt += `## الأهداف الأسبوعية:\n${reportData.weeklyGoals?.goals_text || 'لا توجد أهداف محددة لهذا الأسبوع'}\n\n`;
  fullPrompt += `## التحدي اليومي:\n${reportData.dailyChallenge?.challenge_text || 'لا يوجد تحدي محدد لهذا اليوم'}\n\n`;
  fullPrompt += `## الأهداف الاستراتيجية طويلة المدى:\n${reportData.strategicGoals}\n\n`;
  
  fullPrompt += `## الذاكرة المنظمة:\n`;
  for (const [category, content] of Object.entries(reportData.memory)) {
    fullPrompt += `### ${category}\n${content || 'لا توجد معلومات'}\n\n`;
  }

  // Add the full prompt template (same as buildUnifiedPrompt)
  fullPrompt += `
---

# المطلوب منك:

قدم تحليلاً شاملاً ومحفزاً بناءً على كل المعلومات أعلاه. اتبع هذا الهيكل بدقة:

## [QUESTIONS]
(اطرح 1-3 أسئلة توضيحية قصيرة ومباشرة إذا كنت تحتاج معلومات إضافية لفهم السياق بشكل أفضل. كل سؤال في سطر منفصل يبدأ بـ "Q:")
Q: [سؤالك هنا]

## [COMMENTARY]
(تعليق شامل ومحفز باللهجة المصرية، يشمل:
- تحليل الأداء اليوم
- ملاحظات على الأنماط والتحسينات
- تشجيع وتحفيز شخصي
- نصائح عملية للتطوير
- ربط الإنجازات بالأهداف طويلة المدى

اكتب بطريقة طبيعية ودافئة، كأنك صديق مقرب يعرفك جيداً.)

## [CHALLENGE_EVAL]
(تقييم التحدي اليومي:
✅ إذا تم إنجازه
❌ إذا لم يتم إنجازه
فقط رمز واحد بدون تفسير)

## [REWARD]
(اقترح مكافأة مناسبة لإنجازات اليوم - شيء عملي وممتع، جملة واحدة قصيرة)

## [GOALS_ANALYSIS]
تحليل الأهداف الأسبوعية (استخدم هذا الشكل بالضبط):

### منجزة ✅
- [اذكر الأهداف المنجزة أو اكتب "لا يوجد"]

### قيد التنفيذ 🔄
- [اذكر الأهداف قيد التنفيذ أو اكتب "لا يوجد"]

### مهملة ⚠️
- [اذكر الأهداف المهملة أو اكتب "لا يوجد"]

## [MEMORY_UPDATES]
⚠️ **CRITICAL FORMAT RULES:**
1. Each memory update MUST start with "CATEGORY:" on its own line
2. Followed by "CONTENT:" on the next line
3. Leave a blank line between different category updates
4. Category names MUST match EXACTLY (copy-paste from list above)

**Available Categories:**
- Personal Insights & Patterns
- Successful Strategies & What Works
- Triggers & Challenges
- Important Milestones & Breakthroughs
- Recurring Themes & Lessons
- Personal Information & Facts

## [MEMORY_OPTIMIZATION]
(إذا كانت الذاكرة بحاجة لتحسين وإعادة تنظيم، اكتب "OPTIMIZE_NEEDED"، وإلا اكتب "NOT_NEEDED")

---
`;
  
  // Log the complete prompt
  await debugLogger.log(
    `📤 **COMPLETE UNIFIED PROMPT**\n\n` +
    `Total Length: ${fullPrompt.length} characters\n\n` +
    `─────────────────────────────\n\n` +
    fullPrompt,
    '📤'
  );
  
  console.log(`✅ Complete unified prompt logged (${fullPrompt.length} chars)`);
}

// Call AI - THIS IS THE LONG OPERATION (no timeout here!)
const aiResponse = await aiClient.generateDailyReport({
  reportDate: reportData.date,
  tasks: reportData.tasks,
  failedTasksJson: reportData.failedTasksJson,
  streaks: reportData.streaks,
  weeklyGoals: reportData.weeklyGoals?.goals_text || null,
  dailyChallenge: reportData.dailyChallenge?.challenge_text || null,
  memory: reportData.memory,
  pastWeekSummary,
  strategicGoals: reportData.strategicGoals,
  userAnswers: Object.keys(userAnswers).length > 0 ? userAnswers : undefined,
  journalContent: reportData.journal,
  formattedReport,
});
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ [Job ${jobId}] AI analysis complete in ${elapsed}s`);

      // ✅ Log the FULL AI response to Telegram
      if (debugLogger.isEnabled()) {
        // Log summary
        await debugLogger.log(
          `✅ **AI Analysis Complete**\n\n` +
          `Duration: ${elapsed}s\n` +
          `Questions: ${aiResponse.questions.length}\n` +
          `Memory updates: ${Object.keys(aiResponse.memoryUpdates).length}\n` +
          `Challenge eval: ${aiResponse.challengeEvaluation}\n` +
          `Reward: ${aiResponse.reward || 'None'}`
        );

        // Log full commentary
        await debugLogger.log(
          `📝 **AI COMMENTARY (Full)**\n\n` +
          aiResponse.mainCommentary,
          '📝'
        );

        // Log questions if any
        if (aiResponse.questions.length > 0) {
          await debugLogger.log(
            `❓ **AI QUESTIONS**\n\n` +
            aiResponse.questions.map((q, i) => `${i + 1}. ${q}`).join('\n'),
            '❓'
          );
        }

        // Log memory updates
        if (Object.keys(aiResponse.memoryUpdates).length > 0) {
          let memoryLog = `🧠 **MEMORY UPDATES**\n\n`;
          for (const [category, content] of Object.entries(aiResponse.memoryUpdates)) {
            memoryLog += `**${category}:**\n${content}\n\n`;
          }
          await debugLogger.log(memoryLog, '🧠');
        }

        // Log goals analysis
        if (aiResponse.goalsAnalysis) {
          await debugLogger.log(
            `🎯 **GOALS ANALYSIS**\n\n` +
            `Completed: ${aiResponse.goalsAnalysis.completed.join(', ') || 'None'}\n` +
            `In Progress: ${aiResponse.goalsAnalysis.inProgress.join(', ') || 'None'}\n` +
            `Neglected: ${aiResponse.goalsAnalysis.neglected.join(', ') || 'None'}`,
            '🎯'
          );
        }
      }

      // Send results to user
      await this.sendReportResults(chatId, botToken, reportData, aiResponse);

      // ✅ CHECK FOR POST-ANALYSIS QUESTIONS
      const postAnalysisQuestions = aiResponse.questions || [];
      const stats = reportGen.calculateStatistics(reportData.tasks, reportData.failedTasksJson);
      const aiSummary = aiResponse.daySummary || this.generateBriefSummary(aiResponse, stats);

      if (postAnalysisQuestions.length > 0) {
        console.log(`❓ [Job ${jobId}] AI has ${postAnalysisQuestions.length} follow-up questions`);

        // Save pending report state for after Q&A
        const pendingReportKey = `pending_report_save_${chatId}`;
        try {
          await db.delete('conversation_state', { chat_id: op.eq(pendingReportKey) }).catch(() => {});
        } catch (e) { /* ignore */ }

        await db.insert('conversation_state', {
          chat_id: pendingReportKey,
          conversation_type: 'pending_report_save',
          data: {
            reportDate: reportData.date,
            formattedReport,
            stats,
            aiSummary,
            aiResponse: {
              mainCommentary: aiResponse.mainCommentary,
              challengeEvaluation: aiResponse.challengeEvaluation,
              reward: aiResponse.reward,
              goalsAnalysis: aiResponse.goalsAnalysis,
              memoryUpdates: aiResponse.memoryUpdates,
              memoryOptimization: aiResponse.memoryOptimization,
            },
            preAnalysisAnswers: userAnswers || {},
          },
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
        });

        // Start post-analysis Q&A session
        const postQAKey = `post_qa_${chatId}`;
        try {
          await db.delete('conversation_state', { chat_id: op.eq(postQAKey) }).catch(() => {});
        } catch (e) { /* ignore */ }

        await db.insert('conversation_state', {
          chat_id: postQAKey,
          conversation_type: 'post_analysis_qa',
          data: {
            questions: postAnalysisQuestions,
            answers: {},
            currentIndex: 0,
          },
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });

        // Send first question
        await this.sendTelegramMessage(
          chatId,
          botToken,
          `❓ لدي ${postAnalysisQuestions.length} أسئلة متابعة لفهم أفضل:\n\n` +
          `[1/${postAnalysisQuestions.length}] ${postAnalysisQuestions[0]}\n\n` +
          `💡 أجب على السؤال أو استخدم /skip_questions لتخطي وحفظ التقرير`
        );

        // Mark as waiting for post-analysis answers
        this.status = {
          status: 'waiting_for_answers',
          progress: 'في انتظار إجابات المتابعة',
          startedAt: this.status.startedAt,
        };

        console.log(`⏳ [Job ${jobId}] Waiting for post-analysis answers...`);
        return; // Don't save yet - wait for answers
      }

      // ✅ No questions - Save report immediately
      console.log(`💾 [Job ${jobId}] Saving report to database...`);

      await db.upsert('daily_reports', {
        report_date: reportData.date,
        report_markdown: formattedReport,
        success_rate: stats.success_rate,
        total_tasks: stats.total_tasks,
        completed_tasks: stats.completed_tasks,
        failed_tasks: stats.failed_tasks,
        achievement_time_minutes: stats.total_time_minutes,
        challenge_evaluation: aiResponse.challengeEvaluation,
        ai_commentary: aiResponse.mainCommentary,
        suggested_reward: aiResponse.reward,
        weekly_goals_analysis: JSON.stringify(aiResponse.goalsAnalysis),
        user_comments: userAnswers && Object.keys(userAnswers).length > 0
          ? JSON.stringify(userAnswers)
          : null,
        obsidian_file_id: aiSummary,
      }, 'report_date');

      console.log(`✅ [Job ${jobId}] Report saved successfully`);
      await this.sendTelegramMessage(chatId, botToken, '✅ تم حفظ التقرير بنجاح!');

      // ✅ Wait before memory operations to avoid subrequest limits
      console.log(`⏳ [Job ${jobId}] Waiting 2s before memory operations...`);
      await this.delay(2000);

      // Update memory (can fail without losing report)
      if (aiResponse.memoryUpdates && Object.keys(aiResponse.memoryUpdates).length > 0) {
        console.log(`🧠 [Job ${jobId}] Updating memory with ${Object.keys(aiResponse.memoryUpdates).length} categories...`);

        try {
          // Update memory categories one by one with small delays
          for (const [category, content] of Object.entries(aiResponse.memoryUpdates)) {
            try {
              await memoryMgr.updateSingleCategory(category, content);
              console.log(`  ✅ Updated: ${category}`);
              await this.delay(500); // Small delay between categories
            } catch (catError) {
              console.error(`  ❌ Failed: ${category}:`, catError);
            }
          }
          console.log(`✅ [Job ${jobId}] Memory updates completed`);
        } catch (memError) {
          console.error(`❌ [Job ${jobId}] Memory update failed (report already saved):`, memError);
        }
      }

      // Skip memory optimization to reduce subrequests
      if (aiResponse.memoryOptimization === 'OPTIMIZE_NEEDED') {
        console.log(`ℹ️ [Job ${jobId}] Memory optimization needed - will run on next report`);
      }

      // Save to Google Drive (if configured) - wrapped in try to avoid subrequest limits
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
        }
      } catch (driveError) {
        console.warn(`⚠️ [Job ${jobId}] Google Drive skipped (subrequest limit)`);
      }

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
	// ✅ Auto-trigger autofail if report saved on same day (earlier trigger at 11 PM Egypt time)
const reportDate = reportData.date;
const egyptNow = new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' });
const egyptToday = new Date(egyptNow).toISOString().split('T')[0];
const egyptHour = new Date(egyptNow).getHours();

// Trigger if: same day AND after 11 PM Egypt time (23:00)
if (reportDate === egyptToday && egyptHour >= 23) {
  console.log(`✅ Same-day report (${reportDate}) after 11 PM - triggering auto-fail`);
  
  // Trigger auto-fail in background (don't await)
  this.ctx.waitUntil((async () => {
    try {
      const todoistToken = await settings.get('todoist_api_token');
      const todoistProjectId = await settings.get('todoist_project_id');
      const priorityThresholdStr = await settings.get('failure_priority_threshold');
      const priorityThreshold = priorityThresholdStr ? parseInt(priorityThresholdStr, 10) : 2;

      if (!todoistToken) return;

      // Fetch tasks
      let url = 'https://api.todoist.com/rest/v3/tasks';
      if (todoistProjectId) url += `?project_id=${todoistProjectId.trim()}`;

      const tasksResponse = await fetch(url, {
        headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
      });

      if (!tasksResponse.ok) return;

      const allTasks = await tasksResponse.json() as Array<{
        id: string; content: string; priority: number;
        due?: { date: string } | null;
      }>;

      const tasksDueToday = allTasks.filter(task => {
        if (!task.due?.date) return false;
        const dueDate = task.due.date.split('T')[0];
        return dueDate && dueDate <= reportDate;
      });

      const highPriorityTasks = tasksDueToday.filter(task => {
        const ourPriority = 5 - (task.priority || 1);
        return ourPriority <= priorityThreshold;
      });

      const lowPriorityTasks = tasksDueToday.filter(task => {
        const ourPriority = 5 - (task.priority || 1);
        return ourPriority > priorityThreshold;
      });

      const allTasksToComplete = [...highPriorityTasks, ...lowPriorityTasks];
      if (allTasksToComplete.length === 0) return;

      // ✅ FIX: Use this.ctx.env instead of this.env
      const jobId = `autofail_${reportDate}`;
      const id = this.env.REPORT_PROCESSOR.idFromName(jobId);
      const stub = this.env.REPORT_PROCESSOR.get(id);

      // Check if already processing
      const queueCheck = await stub.fetch(new Request('https://fake-host/autofail/check-queue', {
        method: 'POST',
        body: JSON.stringify({ today: reportDate }),
      }));
      const queueData = await queueCheck.json() as { exists: boolean };
      if (queueData.exists) return; // Already processing

      // Initialize queue
      await stub.fetch(new Request('https://fake-host/autofail/init-queue', {
        method: 'POST',
        body: JSON.stringify({
          today: reportDate,
          taskIds: allTasksToComplete.map(t => t.id),
          tasks: allTasksToComplete,
          metadata: {
            chatId,
            todoistToken: todoistToken.trim(),
            botToken,
            totalTasks: allTasksToComplete.length,
            priorityThreshold,
            highPriorityIds: highPriorityTasks.map(t => t.id),
          },
        }),
      }));

      console.log(`🌙 Auto-fail triggered: ${allTasksToComplete.length} tasks`);

      // Process batches
      while (true) {
        const result = await stub.fetch(new Request('https://fake-host/autofail/process-batch', {
          method: 'POST',
        }));
        const data = await result.json() as { complete: boolean };
        if (data.complete) break;
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (error) {
      console.error('Auto-fail trigger error:', error);
    }
  })());
} else if (reportDate !== egyptToday) {
  console.log(`⏭️ Different-day report (${reportDate} vs ${egyptToday}) - skipping auto-fail`);
} else {
  console.log(`⏭️ Same-day report but before 6 PM (${egyptHour}:00) - skipping auto-fail`);
}
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
   * Generate a brief summary from AI response for future reference
   */
  private generateBriefSummary(
    aiResponse: { mainCommentary: string; challengeEvaluation: string; goalsAnalysis: any },
    stats: { success_rate: number; completed_tasks: number; failed_tasks: number }
  ): string {
    // Extract key points from AI commentary (first 2 sentences or 200 chars)
    let commentaryExcerpt = '';
    if (aiResponse.mainCommentary) {
      // Split by sentence endings and take first 2
      const sentences = aiResponse.mainCommentary.split(/[.!؟。]/);
      commentaryExcerpt = sentences.slice(0, 2).join('. ').trim();
      if (commentaryExcerpt.length > 200) {
        commentaryExcerpt = commentaryExcerpt.substring(0, 200) + '...';
      }
    }

    // Build summary
    const parts: string[] = [];
    parts.push(`نسبة النجاح ${stats.success_rate}%`);
    parts.push(`${stats.completed_tasks} منجزة، ${stats.failed_tasks} فاشلة`);

    if (aiResponse.challengeEvaluation) {
      parts.push(`التحدي: ${aiResponse.challengeEvaluation}`);
    }

    if (aiResponse.goalsAnalysis?.completed?.length > 0) {
      parts.push(`${aiResponse.goalsAnalysis.completed.length} أهداف أسبوعية منجزة`);
    }

    if (commentaryExcerpt) {
      parts.push(`الملخص: ${commentaryExcerpt}`);
    }

    return parts.join(' | ');
  }

  /**
   * Delay helper to avoid Cloudflare subrequest limits
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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

/**
   * Process one batch of auto-fail tasks (20 tasks)
   */
   private async processAutoFailBatch(): Promise<{
    complete: boolean;
    processed: number;
    totalProcessed: number;
    remaining: number;
  }> {
    // Import getTodayInEgypt
    const { getTodayInEgypt } = await import('../utils/timezone');
    const today = getTodayInEgypt();
    const BATCH_SIZE = 4;

    // Load state
    const queue = await this.ctx.storage.get<string[]>(`autofail_queue_${today}`);
    if (!queue || queue.length === 0) {
      return { complete: true, processed: 0, totalProcessed: 0, remaining: 0 };
    }

    const processed = await this.ctx.storage.get<string[]>(`autofail_processed_${today}`) || [];
    const tasks = await this.ctx.storage.get<any[]>(`autofail_tasks_${today}`) || [];
    const metadata = await this.ctx.storage.get<any>(`autofail_metadata_${today}`);

    if (!metadata) {
      throw new Error('Metadata not found');
    }

    const { chatId, todoistToken, botToken } = metadata;

    // Get remaining task IDs
    const remaining = queue.filter(id => !processed.includes(id));
    if (remaining.length === 0) {
      // All done - cleanup and notify
      await this.sendAutoFailCompletion(chatId, botToken, processed.length, today);
      await this.ctx.storage.delete(`autofail_queue_${today}`);
      await this.ctx.storage.delete(`autofail_tasks_${today}`);
      await this.ctx.storage.delete(`autofail_metadata_${today}`);
      await this.ctx.storage.delete(`autofail_processed_${today}`);
      
      return { complete: true, processed: 0, totalProcessed: processed.length, remaining: 0 };
    }

    // Process batch
    const batch = remaining.slice(0, BATCH_SIZE);
    const batchProcessed: string[] = [];

    // Import required functions
    const { getDailyFailures, upsertDailyFailures } = await import('../services/failure-manager');
    const { extractCleanTaskName } = await import('../utils/task-parser');
    const { createSupabaseClient, op } = await import('../database/client');

    const db = createSupabaseClient(this.env);
    let dailyFailures = await getDailyFailures(db, today);

    if (!dailyFailures) {
      dailyFailures = {
        date: today,
        last_sync: new Date().toISOString(),
        failed_tasks: [],
      };
    }

    for (const taskId of batch) {
      try {
        const task = tasks.find(t => t.id === taskId);
        if (!task) {
          console.warn(`Task ${taskId} not found in metadata`);
          batchProcessed.push(taskId);
          continue;
        }

        const cleanName = extractCleanTaskName(task.content);

        // Get metadata to check priority
const highPriorityIds = new Set(metadata.highPriorityIds || []);

// Only add to failures JSON if high priority
if (highPriorityIds.has(task.id)) {
  const existingIndex = dailyFailures.failed_tasks.findIndex(f =>
    extractCleanTaskName(f.content) === cleanName
  );

  if (existingIndex < 0) {
    dailyFailures.failed_tasks.push({
      id: task.id,
      content: task.content,
      parent_id: null,
      parent_content: null,
      priority: task.priority,
      is_subtask: false,
      description: 'Auto-failed at end of day',
    });
  }
}

	// Create failure completion marker (for ALL tasks)
	const markerKey = `failure_completion_${task.id}`;
        await db.delete('conversation_state', { chat_id: op.eq(markerKey) }).catch(() => {});
        await db.insert('conversation_state', {
          chat_id: markerKey,
          conversation_type: 'failure_completion',
          data: { taskId: task.id, taskName: task.content, autoFail: true },
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });

        // Complete in Todoist
        const closeResponse = await fetch(
          `https://api.todoist.com/rest/v3/tasks/${task.id}/close`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${todoistToken}` },
          }
        );

        if (closeResponse.ok) {
          batchProcessed.push(taskId);
          console.log(`✓ Auto-failed: ${cleanName}`);
        } else {
          console.error(`Failed to close task ${task.id}: ${closeResponse.status}`);
        }
      } catch (error) {
        console.error(`Error processing task ${taskId}:`, error);
      }
    }

    // Save failures
    dailyFailures.last_sync = new Date().toISOString();
    await upsertDailyFailures(db, dailyFailures);

    // Update processed list
    const newProcessed = [...processed, ...batchProcessed];
    await this.ctx.storage.put(`autofail_processed_${today}`, newProcessed);

    const newRemaining = queue.length - newProcessed.length;

    // Send progress update every 20 tasks
    if (newProcessed.length % 20 === 0 && newRemaining > 0) {
      await this.sendTelegramMessage(
        chatId,
        botToken,
        `⏳ Auto-fail: ${newProcessed.length}/${queue.length}`
      );
    }

    return {
      complete: newRemaining === 0,
      processed: batchProcessed.length,
      totalProcessed: newProcessed.length,
      remaining: newRemaining,
    };
  }

  /**
   * Send auto-fail completion notification
   */
  private async sendAutoFailCompletion(
    chatId: string,
    botToken: string,
    count: number,
    date: string
  ): Promise<void> {
    const message = `🌙 **Auto-fail complete**\n\n` +
      `📅 ${date}\n` +
      `✅ ${count} tasks processed\n\n` +
      `_Recurring tasks postponed to next due date_`;

    await this.sendTelegramMessage(chatId, botToken, message);
  }

}
