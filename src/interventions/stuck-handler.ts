/**
 * Stuck Button Handler - Real-Time Intervention System
 *
 * Purpose: Attack procrastination at the moment it happens.
 *
 * Workflow:
 * 1. User signals avoidance with /stuck
 * 2. Bot asks emotionally intelligent question
 * 3. AI classifies blockage (Fear, Overwhelm, Boredom, Resistance)
 * 4. Bot forces 2-minute action sprint with countdown nudges
 * 5. AI decides next step after timer
 *
 * NOW WITH: Coaching context integration for personalized responses
 * Setting: interventions.stuck_button = ON/OFF
 */

import { SupabaseClient, op } from '../database/client';
import { SettingsManager } from '../database/settings';
import { AIMessage } from '../services/ai-client';
import {
  CoachingContextBuilder,
  createCoachingContextBuilder,
} from '../coach/coaching-context';
import { getTodayInEgypt } from '../utils/timezone';

// ============================================
// Types
// ============================================

export type BlockageType = 'fear' | 'overwhelm' | 'boredom' | 'resistance' | 'unknown';

export interface StuckState {
  phase: 'initial' | 'awaiting_response' | 'sprint_active' | 'sprint_complete';
  blockageType?: BlockageType;
  userResponse?: string;
  sprintStartTime?: number;
  sprintEndTime?: number;
  taskDescription?: string;
  interventionCount: number;
}

export interface StuckSession {
  chat_id: string;
  conversation_type: 'stuck_intervention';
  current_step: number;
  data: StuckState;
  expires_at: Date;
}

// Task recommendation types
export interface TaskRecommendation {
  taskId: string;
  taskContent: string;
  reason: string;
  daysDeferring: number;
  pattern: string; // "afternoon avoidance", "fear-based", etc.
}

export interface AvoidancePattern {
  taskId: string;
  taskContent: string;
  deferCount: number;
  lastDeferred: Date;
  commonTime: string; // "afternoon", "evening"
  category?: string;
}

// Task recommendation AI prompt
const TASK_RECOMMENDATION_PROMPT = `حلل قائمة مهام المستخدم وأنماط التجنب لديه.

⚠️ مهم جداً: لازم الرد يكون بالعامية المصرية فقط! مفيش إنجليزي خالص.

المهام المتاحة:
{TASK_LIST}

تاريخ الفشل (آخر 7 أيام):
{FAILURE_PATTERNS}

الوقت الحالي: {TIME}
اليوم: {DAY_OF_WEEK}

اقترح مهمة واحدة يجب أن يعمل عليها الآن.
اعتبر:
1. أي المهام يتجنبها باستمرار
2. أنماط الوقت خلال اليوم
3. أولوية المهمة والمواعيد النهائية
4. صعوبة المهمة مقارنة بالطاقة الحالية

الصيغة:
[المهمة_المقترحة]
اسم المهمة بالضبط كما هو مكتوب

[السبب]
2-3 جمل تشرح لماذا هذه المهمة الآن

[النمط]
نوع التجنب المكتشف (مثل: تجنب فترة بعد الظهر، مبني على الخوف، إرهاق)`;

// ============================================
// AI Prompts
// ============================================

const INITIAL_QUESTION_PROMPT = `أنت كوتش إنتاجية مواجهة. الشخص لسه ضغط /stuck، يعني بيهرب من حاجة.

⚠️ مهم جداً: لازم الرد يكون بالعامية المصرية فقط! مفيش إنجليزي خالص.

{COACHING_CONTEXT}

اكتب سؤال واحد قوي ومباشر عشان تعرف إيه اللي بيهرب منه فعلاً.

القواعد:
- كن مواجهة - تحدّيه، متواسيهوش
- مفيش أسئلة عامة - خليها شخصية بناءً على أنماطه
- استهدف الجذر العاطفي: خوف، إرهاق، ملل، أو مقاومة
- لو تعرف محفزاته من الذاكرة، اشر ليها
- جملتين ماكس

أمثلة لأسئلة مواجهة كويسة:
- "تاني مرة؟ إيه اللي بيخليك تهرب من نفس نوع المهام دي؟"
- "خايف تفشل ولا خايف تنجح وتبقى مسؤول؟"
- "كام مرة قلت 'بعدين' النهارده؟ إيه الحقيقة؟"

رد بالسؤال بس، من غير أي حاجة تانية.`;

const CLASSIFY_BLOCKAGE_PROMPT = `أنت بتحلل ليه الشخص واقف ومش قادر يكمل.

⚠️ مهم جداً: لازم الرد يكون بالعامية المصرية فقط! مفيش إنجليزي خالص.

رد الشخص عن اللي بيهرب منه:
"{USER_RESPONSE}"

صنّف السبب لفئة واحدة بس:
- خوف: قلق من النتيجة أو الحكم عليه أو الفشل
- إرهاق: المهمة كبيرة أوي أو معقدة أو خطواتها كتير
- ملل: المهمة مملة أو متكررة
- مقاومة: صراع داخلي أو تجنب عاطفي

كمان اكتب رد قصير وقوي (2-3 جمل ماكس) بيعمل الآتي:
1. يعترف بموقفه المحدد
2. يعيد صياغته بشكل محفز
3. يمهد لسبرنت الدقيقتين

صيغة الرد لازم تكون كدا بالظبط:
[التصنيف]
خوف/إرهاق/ملل/مقاومة

[الرد]
رسالتك المحفزة هنا بالمصري`;

const SPRINT_NUDGE_PROMPT = `أنت كوتش إنتاجية في نص سبرنت دقيقتين.

⚠️ مهم جداً: لازم الرد يكون بالعامية المصرية فقط! مفيش إنجليزي خالص.

السياق:
- الشخص واقف بسبب: {BLOCKAGE_TYPE}
- بيشتغل على: {TASK_DESCRIPTION}
- الوقت المتبقي: {TIME_REMAINING} ثانية
- دا تنبيه رقم #{NUDGE_NUMBER}

اكتب تنبيه قصير (جملة واحدة) عشان تحافظ على الزخم:
- ملحّ بس مش ضاغط
- مخصص لنوع السبب
- بيشجع على التقدم

للخوف: فكّره إن مفيش حاجة وحشة حصلت لحد دلوقتي
للإرهاق: احتفل بأي تقدم صغير
للملل: حوّلها لعبة صغيرة
للمقاومة: اعترف بالصعوبة، وادفع للأمام

رد بالتنبيه بس.`;

const POST_SPRINT_PROMPT = `الشخص لسه خلّص سبرنت دقيقتين.

⚠️ مهم جداً: لازم الرد يكون بالعامية المصرية فقط! مفيش إنجليزي خالص.

السياق:
- كان واقف بسبب: {BLOCKAGE_TYPE}
- المهمة/الموقف الأصلي: {TASK_DESCRIPTION}

اكتب رد بيعمل الآتي:
1. يحتفل بإكمال السبرنت (بسرعة)
2. يسأل إيه اللي حصل في الدقيقتين
3. يقدّم ٣ خيارات واضحة:
   - 🔥 كمّل (في حالة تدفق)
   - ✅ خلّص حاجة (أنجز شي)
   - ⏰ أجّل مع سبب (محتاج يوقف)

خليه قصير ومركز على الفعل.

الصيغة:
[الاحتفال]
احتفال قصير (جملة واحدة)

[السؤال]
سؤال عن اللي حصل

[الخيارات]
The three options formatted nicely`;

// ============================================
// Stuck Handler Class
// ============================================

export class StuckHandler {
  private aiComplete: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>;
  private contextBuilder: CoachingContextBuilder;

  constructor(
    private db: SupabaseClient,
    settings: SettingsManager,
    aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>
  ) {
    this.aiComplete = aiCompleteFunc;
    this.contextBuilder = createCoachingContextBuilder(db, settings);
  }

  /**
   * Start a stuck intervention session
   */
  async startIntervention(chatId: string): Promise<string> {
    // Check for existing session
    const existing = await this.getSession(chatId);
    if (existing) {
      await this.clearSession(chatId);
    }

    // Build coaching context
    const context = await this.contextBuilder.buildContext(chatId, 'stuck', {
      includeBattleState: true,
      maxInteractions: 5,
    });
    const contextStr = this.contextBuilder.formatForPrompt(context, 'stuck');

    // Generate initial question via AI with context
    const promptWithContext = INITIAL_QUESTION_PROMPT.replace('{COACHING_CONTEXT}', contextStr);
    const question = await this.aiComplete(
      [{ role: 'user', content: promptWithContext }],
      0.9,
      200
    );

    // Log this interaction
    await this.contextBuilder.logInteraction({
      chat_id: chatId,
      interaction_date: getTodayInEgypt(),
      timestamp: new Date().toISOString(),
      interaction_type: 'stuck',
      bot_response: question,
      outcome: 'pending',
    });

    // Create new session
    const state: StuckState = {
      phase: 'awaiting_response',
      interventionCount: 1,
    };

    await this.saveSession(chatId, state);

    return `🚨 *وضع التدخل*\n\n${question.trim()}`;
  }

  /**
   * Process user's response about what they're avoiding
   */
  async processResponse(chatId: string, userResponse: string): Promise<{
    message: string;
    startSprint: boolean;
    blockageType: BlockageType;
  }> {
    const session = await this.getSession(chatId);
    if (!session || session.data.phase !== 'awaiting_response') {
      throw new Error('No active stuck session awaiting response');
    }

    // Classify blockage via AI
    const prompt = CLASSIFY_BLOCKAGE_PROMPT.replace('{USER_RESPONSE}', userResponse);
    const aiResponse = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.7,
      300
    );

    // Parse classification - support both English and Arabic
    const classificationMatch = aiResponse.match(/\[(?:CLASSIFICATION|التصنيف)\]\s*(fear|overwhelm|boredom|resistance|خوف|إرهاق|ملل|مقاومة)/i);
    const responseMatch = aiResponse.match(/\[(?:RESPONSE|الرد)\]\s*([\s\S]+?)(?:\[|$)/i);

    // Map Arabic to English blockage types
    const blockageMap: Record<string, BlockageType> = {
      'fear': 'fear', 'خوف': 'fear',
      'overwhelm': 'overwhelm', 'إرهاق': 'overwhelm',
      'boredom': 'boredom', 'ملل': 'boredom',
      'resistance': 'resistance', 'مقاومة': 'resistance',
    };
    const rawBlockage = classificationMatch?.[1]?.toLowerCase() || 'unknown';
    const blockageType = (blockageMap[rawBlockage] || 'unknown') as BlockageType;
    const motivatingResponse = responseMatch?.[1]?.trim() || 'خلينا نبدأ سبرنت دقيقتين!';

    // Update session
    const newState: StuckState = {
      ...session.data,
      phase: 'sprint_active',
      blockageType,
      userResponse,
      taskDescription: userResponse,
      sprintStartTime: Date.now(),
      sprintEndTime: Date.now() + (2 * 60 * 1000), // 2 minutes
    };

    await this.saveSession(chatId, newState);

    const sprintMessage = `${motivatingResponse}\n\n⏱️ *سبرنت دقيقتين يبدأ الآن!*\n\nاشتغل على أي شيء صغير - حتى لو جملة وحدة أو خطوة وحدة.\nهدف للعمل حتى تسمع مني.`;

    return {
      message: sprintMessage,
      startSprint: true,
      blockageType,
    };
  }

  /**
   * Generate a sprint nudge message
   */
  async generateNudge(chatId: string, nudgeNumber: number): Promise<string | null> {
    const session = await this.getSession(chatId);
    if (!session || session.data.phase !== 'sprint_active') {
      return null;
    }

    const timeRemaining = Math.max(0, (session.data.sprintEndTime || 0) - Date.now()) / 1000;

    if (timeRemaining <= 0) {
      return null;
    }

    const prompt = SPRINT_NUDGE_PROMPT
      .replace('{BLOCKAGE_TYPE}', session.data.blockageType || 'unknown')
      .replace('{TASK_DESCRIPTION}', session.data.taskDescription || 'their task')
      .replace('{TIME_REMAINING}', Math.round(timeRemaining).toString())
      .replace('{NUDGE_NUMBER}', nudgeNumber.toString());

    const nudge = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.9,
      100
    );

    return `⚡ ${nudge.trim()}`;
  }

  /**
   * Complete the sprint and show options
   */
  async completeSprint(chatId: string): Promise<string> {
    const session = await this.getSession(chatId);
    if (!session) {
      return 'لا توجد جلسة نشطة.';
    }

    // Generate post-sprint message
    const prompt = POST_SPRINT_PROMPT
      .replace('{BLOCKAGE_TYPE}', session.data.blockageType || 'unknown')
      .replace('{TASK_DESCRIPTION}', session.data.taskDescription || 'their task');

    const aiResponse = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.8,
      400
    );

    // Update session phase
    await this.saveSession(chatId, {
      ...session.data,
      phase: 'sprint_complete',
    });

    // Parse response sections
    const celebrationMatch = aiResponse.match(/\[CELEBRATION\]\s*([\s\S]+?)\[/i);
    const questionMatch = aiResponse.match(/\[QUESTION\]\s*([\s\S]+?)\[/i);
    const optionsMatch = aiResponse.match(/\[OPTIONS\]\s*([\s\S]+?)$/i);

    const celebration = celebrationMatch?.[1]?.trim() || '🎉 أحسنت! خلصت الدقيقتين!';
    const question = questionMatch?.[1]?.trim() || 'شو صار خلال السبرنت؟';
    const options = optionsMatch?.[1]?.trim() ||
      '🔥 /stuck_continue - كمّل، أنا في الفلو\n✅ /stuck_done - خلصت شي\n⏰ /stuck_defer - محتاج أوقف';

    return `${celebration}\n\n${question}\n\n${options}`;
  }

  /**
   * Handle continue action after sprint
   */
  async handleContinue(chatId: string): Promise<string> {
    const session = await this.getSession(chatId);

    // Start a new sprint
    const newState: StuckState = {
      phase: 'sprint_active',
      blockageType: session?.data.blockageType,
      taskDescription: session?.data.taskDescription,
      sprintStartTime: Date.now(),
      sprintEndTime: Date.now() + (2 * 60 * 1000),
      interventionCount: (session?.data.interventionCount || 0) + 1,
    };

    await this.saveSession(chatId, newState);

    return `🔥 *يلا نكمل!*\n\nسبرنت جديد - دقيقتين إضافية.\nانت في الفلو، استغلها!`;
  }

  /**
   * Handle done action after sprint
   */
  async handleDone(chatId: string): Promise<string> {
    const session = await this.getSession(chatId);
    await this.clearSession(chatId);

    const count = session?.data.interventionCount || 1;

    // Log this intervention for future roasts/analysis
    await this.logIntervention(chatId, {
      type: 'stuck_resolved',
      blockageType: session?.data.blockageType || 'unknown',
      duration: Date.now() - (session?.data.sprintStartTime || Date.now()),
      sprintCount: count,
    });

    // Update coaching interaction outcome to POSITIVE
    await this.contextBuilder.updateInteractionOutcome(chatId, 'stuck', 'positive');

    // Log to coaching memory what worked
    await this.contextBuilder.logInteraction({
      chat_id: chatId,
      interaction_date: getTodayInEgypt(),
      timestamp: new Date().toISOString(),
      interaction_type: 'stuck',
      user_input: 'completed sprint',
      outcome: 'positive',
      metadata: {
        blockageType: session?.data.blockageType,
        sprintCount: count,
        resolved: true,
      },
    });

    return `✅ *ممتاز!*\n\n${count > 1 ? `${count} سبرنتات` : 'سبرنت واحد'} وخلصت!\nهذا إثبات إنك تقدر تبدأ وقتما تريد.\n\nخليك فاكر هالشعور. 💪`;
  }

  /**
   * Handle defer action after sprint
   */
  async handleDefer(chatId: string, reason?: string): Promise<string> {
    const session = await this.getSession(chatId);
    await this.clearSession(chatId);

    // Update coaching interaction outcome to NEGATIVE
    await this.contextBuilder.updateInteractionOutcome(chatId, 'stuck', 'negative');

    // Log to coaching memory what didn't work
    await this.contextBuilder.logInteraction({
      chat_id: chatId,
      interaction_date: getTodayInEgypt(),
      timestamp: new Date().toISOString(),
      interaction_type: 'stuck',
      user_input: reason || 'deferred without reason',
      outcome: 'negative',
      metadata: {
        blockageType: session?.data.blockageType,
        sprintCount: session?.data.interventionCount,
        deferred: true,
        deferReason: reason,
      },
    });

    // Log deferral for future analysis
    await this.logIntervention(chatId, {
      type: 'stuck_deferred',
      blockageType: session?.data.blockageType || 'unknown',
      reason: reason || 'no reason given',
      sprintCount: session?.data.interventionCount || 1,
    });

    return `⏰ *تم التأجيل*\n\nسجلت إنك أجلت هالمهمة.\nالسبب: ${reason || 'غير محدد'}\n\nلا بأس، بس خلينا نرجعلها قريب. 📝`;
  }

  /**
   * Check if there's an active sprint
   */
  async isSprintActive(chatId: string): Promise<boolean> {
    const session = await this.getSession(chatId);
    return session?.data.phase === 'sprint_active';
  }

  /**
   * Get remaining sprint time in seconds
   */
  async getSprintTimeRemaining(chatId: string): Promise<number> {
    const session = await this.getSession(chatId);
    if (!session || session.data.phase !== 'sprint_active') {
      return 0;
    }
    return Math.max(0, ((session.data.sprintEndTime || 0) - Date.now()) / 1000);
  }

  // ============================================
  // Task Recommendation Methods (Enhanced Stuck Mode)
  // ============================================

  /**
   * Analyze tasks and recommend the one task to tackle
   */
  async analyzeAndRecommendTask(
    chatId: string,
    todoistToken: string,
    projectId?: string
  ): Promise<TaskRecommendation | null> {
    try {
      // Fetch active tasks from Todoist
      let url = 'https://api.todoist.com/api/v1/tasks';
      if (projectId) {
        url += `?project_id=${projectId.trim()}`;
      }

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
      });

      if (!response.ok) {
        console.error('Todoist API error:', response.status);
        return null;
      }

      const tasksJson = await response.json() as any;
      const tasks = (Array.isArray(tasksJson) ? tasksJson : (tasksJson.results || [])) as Array<{
        id: string;
        content: string;
        priority: number;
        due?: { date: string };
      }>;

      // Filter to today's tasks
      const today = getTodayInEgypt();
      const todayTasks = tasks.filter(t => {
        if (!t.due?.date) return false;
        const dueDate = t.due.date.split('T')[0];
        return dueDate && dueDate <= today;
      });

      if (todayTasks.length === 0) {
        return null;
      }

      // Get avoidance patterns
      const patterns = await this.getAvoidancePatterns(chatId);

      // Build task list string
      const taskListStr = todayTasks
        .map((t, i) => `${i + 1}. ${t.content} (أولوية: ${5 - t.priority})`)
        .join('\n');

      // Build failure patterns string
      const patternStr = patterns.length > 0
        ? patterns.map(p => `- ${p.taskContent}: ${p.deferCount} مرات تأجيل (${p.commonTime})`).join('\n')
        : 'لا توجد أنماط تأجيل واضحة';

      // Get current time and day
      const egyptTime = new Date().toLocaleString('ar-EG', {
        timeZone: 'Africa/Cairo',
        hour: '2-digit',
        minute: '2-digit',
      });
      const dayNames = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
      const dayOfWeek = dayNames[new Date().getDay()] || '';

      // Ask AI for recommendation
      const prompt = TASK_RECOMMENDATION_PROMPT
        .replace('{TASK_LIST}', taskListStr)
        .replace('{FAILURE_PATTERNS}', patternStr)
        .replace('{TIME}', egyptTime)
        .replace('{DAY_OF_WEEK}', dayOfWeek);

      const aiResponse = await this.aiComplete(
        [{ role: 'user', content: prompt }],
        0.7,
        400
      );

      // Parse AI response
      const taskMatch = aiResponse.match(/\[(?:المهمة_المقترحة|RECOMMENDED_TASK)\]\s*(.+?)(?:\[|$)/is);
      const reasonMatch = aiResponse.match(/\[(?:السبب|REASON)\]\s*([\s\S]+?)(?:\[|$)/i);
      const patternMatch = aiResponse.match(/\[(?:النمط|PATTERN)\]\s*(.+?)(?:\[|$)/is);

      if (!taskMatch) {
        return null;
      }

      const recommendedTaskName = taskMatch[1]?.trim() || '';
      const reason = reasonMatch?.[1]?.trim() || 'مهمة ذات أولوية عالية';
      const detectedPattern = patternMatch?.[1]?.trim() || 'غير محدد';

      // Find matching task
      const matchedTask = todayTasks.find(t =>
        t.content.toLowerCase().includes(recommendedTaskName.toLowerCase()) ||
        recommendedTaskName.toLowerCase().includes(t.content.toLowerCase())
      );

      if (!matchedTask) {
        // If no exact match, return first high priority task
        const highPriority = todayTasks.filter(t => t.priority >= 3)[0] || todayTasks[0];
        if (!highPriority) return null;

        return {
          taskId: highPriority.id,
          taskContent: highPriority.content,
          reason,
          daysDeferring: 0,
          pattern: detectedPattern,
        };
      }

      // Find deferral count for this task
      const taskPattern = patterns.find(p =>
        p.taskContent.toLowerCase().includes(matchedTask.content.toLowerCase()) ||
        matchedTask.content.toLowerCase().includes(p.taskContent.toLowerCase())
      );

      return {
        taskId: matchedTask.id,
        taskContent: matchedTask.content,
        reason,
        daysDeferring: taskPattern?.deferCount || 0,
        pattern: detectedPattern,
      };
    } catch (error) {
      console.error('Task recommendation error:', error);
      return null;
    }
  }

  /**
   * Get avoidance patterns from failure history
   */
  async getAvoidancePatterns(chatId: string): Promise<AvoidancePattern[]> {
    try {
      // Get failures from last 7 days
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      // Get intervention logs for deferrals
      const logs = await this.db.select('intervention_logs', {
        filter: {
          chat_id: op.eq(chatId),
          intervention_type: op.eq('stuck'),
        },
        order: 'created_at.desc',
        limit: 50,
      });

      // Also get from daily_failures
      const failures = await this.db.select('daily_failures', {
        order: 'failure_date.desc',
        limit: 7,
      });

      // Count task deferrals
      const deferralCounts = new Map<string, {
        count: number;
        lastDate: Date;
        times: string[];
      }>();

      // Process intervention logs
      for (const log of logs) {
        const data = log.data as any;
        if (data?.type === 'stuck_deferred' || data?.deferred) {
          const taskContent = data.taskDescription || data.taskContent || 'unknown';
          const createdAt = new Date(log.created_at as string);

          if (createdAt >= sevenDaysAgo) {
            const existing = deferralCounts.get(taskContent);
            const hour = createdAt.getHours();
            const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

            if (existing) {
              existing.count++;
              existing.times.push(timeOfDay);
              if (createdAt > existing.lastDate) {
                existing.lastDate = createdAt;
              }
            } else {
              deferralCounts.set(taskContent, {
                count: 1,
                lastDate: createdAt,
                times: [timeOfDay],
              });
            }
          }
        }
      }

      // Process daily_failures
      for (const failure of failures) {
        const failuresJson = failure.failures_json;
        const parsed = typeof failuresJson === 'string' ? JSON.parse(failuresJson) : failuresJson;
        const failedTasks = parsed?.failed_tasks || [];
        const failureDate = new Date(failure.failure_date as string);

        for (const task of failedTasks) {
          const taskContent = task.content || task.name || 'unknown';
          const existing = deferralCounts.get(taskContent);

          if (existing) {
            existing.count++;
            if (failureDate > existing.lastDate) {
              existing.lastDate = failureDate;
            }
          } else {
            deferralCounts.set(taskContent, {
              count: 1,
              lastDate: failureDate,
              times: ['afternoon'], // Default for daily failures
            });
          }
        }
      }

      // Convert to patterns array
      const patterns: AvoidancePattern[] = [];
      for (const [taskContent, data] of deferralCounts) {
        if (data.count >= 2) { // Only include tasks deferred 2+ times
          // Find most common time
          const timeCounts = data.times.reduce((acc, t) => {
            acc[t] = (acc[t] || 0) + 1;
            return acc;
          }, {} as Record<string, number>);
          const commonTime = Object.entries(timeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'afternoon';

          patterns.push({
            taskId: '', // We don't have task ID from logs
            taskContent,
            deferCount: data.count,
            lastDeferred: data.lastDate,
            commonTime,
          });
        }
      }

      // Sort by deferral count
      return patterns.sort((a, b) => b.deferCount - a.deferCount);
    } catch (error) {
      console.error('Get avoidance patterns error:', error);
      return [];
    }
  }

  /**
   * Start intervention with task recommendation
   */
  async startInterventionWithRecommendation(
    chatId: string,
    todoistToken: string,
    projectId?: string
  ): Promise<{ message: string; recommendation: TaskRecommendation | null }> {
    // Get recommendation
    const recommendation = await this.analyzeAndRecommendTask(chatId, todoistToken, projectId);

    if (!recommendation) {
      // Fall back to regular intervention
      const message = await this.startIntervention(chatId);
      return { message, recommendation: null };
    }

    // Check for existing session
    const existing = await this.getSession(chatId);
    if (existing) {
      await this.clearSession(chatId);
    }

    // Create session with recommendation
    const state: StuckState = {
      phase: 'awaiting_response',
      interventionCount: 1,
      taskDescription: recommendation.taskContent,
    };

    await this.saveSession(chatId, state);

    // Store recommendation for later use
    const recommendKey = `stuck_recommend_${chatId}`;
    await this.db.delete('conversation_state', { chat_id: op.eq(recommendKey) }).catch(() => {});
    await this.db.insert('conversation_state', {
      chat_id: recommendKey,
      conversation_type: 'stuck_recommendation',
      data: recommendation,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });

    // Build message with recommendation
    let message = `🎯 *تحليل المهام*\n\n`;
    message += `اقتراحي لك:\n`;
    message += `📌 *${recommendation.taskContent}*\n\n`;
    message += `💡 ${recommendation.reason}\n`;
    if (recommendation.daysDeferring > 0) {
      message += `⚠️ تأجيلات سابقة: ${recommendation.daysDeferring} مرات\n`;
    }
    message += `\n━━━━━━━━━━━━━━━━━━\n`;
    message += `1️⃣ موافق - نبدأ سبرنت\n`;
    message += `2️⃣ مهمة تانية - عايز أشوف بدائل\n`;
    message += `3️⃣ أختار بنفسي - عايز أدخل اسم المهمة`;

    return { message, recommendation };
  }

  /**
   * Show alternative task suggestions
   */
  async showAlternatives(
    chatId: string,
    todoistToken: string,
    rejectedTask: string,
    projectId?: string
  ): Promise<string> {
    try {
      // Fetch tasks
      let url = 'https://api.todoist.com/api/v1/tasks';
      if (projectId) {
        url += `?project_id=${projectId.trim()}`;
      }

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
      });

      if (!response.ok) {
        return '❌ فشل في جلب المهام من Todoist';
      }

      const tasksJson2 = await response.json() as any;
      const tasks = (Array.isArray(tasksJson2) ? tasksJson2 : (tasksJson2.results || [])) as Array<{
        id: string;
        content: string;
        priority: number;
        due?: { date: string };
      }>;

      const today = getTodayInEgypt();
      const todayTasks = tasks
        .filter(t => {
          if (!t.due?.date) return false;
          const dueDate = t.due.date.split('T')[0];
          return dueDate && dueDate <= today && t.content !== rejectedTask;
        })
        .slice(0, 5);

      if (todayTasks.length === 0) {
        return '❌ لا توجد مهام بديلة متاحة';
      }

      // Build task list
      let message = `📋 *المهام البديلة:*\n\n`;
      todayTasks.forEach((t, i) => {
        const priorityStars = '⭐'.repeat(5 - t.priority);
        message += `${i + 1}. ${t.content} ${priorityStars}\n`;
      });
      message += `\n🔢 أرسل رقم المهمة للبدء:`;

      // Store alternatives for selection
      const altKey = `stuck_alt_${chatId}`;
      await this.db.delete('conversation_state', { chat_id: op.eq(altKey) }).catch(() => {});
      await this.db.insert('conversation_state', {
        chat_id: altKey,
        conversation_type: 'stuck_alternatives',
        data: { tasks: todayTasks },
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

      return message;
    } catch (error) {
      console.error('Show alternatives error:', error);
      return '❌ حدث خطأ في جلب البدائل';
    }
  }

  /**
   * Handle alternative selection
   */
  async handleAlternativeSelection(
    chatId: string,
    selection: number
  ): Promise<{ success: boolean; task?: { id: string; content: string }; message: string }> {
    const altKey = `stuck_alt_${chatId}`;
    const alternatives = await this.db.select('conversation_state', {
      filter: { chat_id: op.eq(altKey) },
      limit: 1,
    });

    if (alternatives.length === 0) {
      return { success: false, message: '❌ انتهت صلاحية القائمة. استخدم /stuck مرة أخرى.' };
    }

    const tasks = (alternatives[0]?.data as any)?.tasks || [];
    await this.db.delete('conversation_state', { chat_id: op.eq(altKey) });

    if (selection < 1 || selection > tasks.length) {
      return { success: false, message: '❌ رقم غير صحيح' };
    }

    const selectedTask = tasks[selection - 1];
    if (!selectedTask) {
      return { success: false, message: '❌ حدث خطأ' };
    }

    // Update session with selected task
    const session = await this.getSession(chatId);
    if (session) {
      await this.saveSession(chatId, {
        ...session.data,
        taskDescription: selectedTask.content,
      });
    }

    return {
      success: true,
      task: { id: selectedTask.id, content: selectedTask.content },
      message: `✅ تم اختيار: ${selectedTask.content}`,
    };
  }

  // ============================================
  // Private Helper Methods
  // ============================================

  private async getSession(chatId: string): Promise<StuckSession | null> {
    const key = `stuck_${chatId}`;
    const result = await this.db.select('conversation_state', {
      filter: { chat_id: op.eq(key) },
      limit: 1,
    });

    if (result.length === 0) return null;

    const record = result[0];
    if (!record) return null;

    // Check expiry
    const expiresAt = typeof record.expires_at === 'string'
      ? new Date(record.expires_at)
      : record.expires_at;

    if (expiresAt && expiresAt < new Date()) {
      await this.clearSession(chatId);
      return null;
    }

    return {
      chat_id: record.chat_id as string,
      conversation_type: 'stuck_intervention',
      current_step: record.current_step as number,
      data: record.data as StuckState,
      expires_at: expiresAt as Date,
    };
  }

  private async saveSession(chatId: string, state: StuckState): Promise<void> {
    const key = `stuck_${chatId}`;
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 15); // 15 min expiry

    // Delete any existing session first, then insert new one
    // (conversation_state doesn't have unique constraint on chat_id alone)
    try {
      await this.db.delete('conversation_state', { chat_id: op.eq(key) });
    } catch (e) {
      // Ignore delete errors
    }

    await this.db.insert('conversation_state', {
      chat_id: key,
      conversation_type: 'stuck_intervention',
      current_step: 0,
      data: state,
      expires_at: expiresAt.toISOString(),
    });
  }

  private async clearSession(chatId: string): Promise<void> {
    const key = `stuck_${chatId}`;
    await this.db.delete('conversation_state', { chat_id: op.eq(key) });
  }

  private async logIntervention(chatId: string, data: Record<string, any>): Promise<void> {
    // Store intervention log for future analysis (used by roast mode, etc.)
    try {
      await this.db.insert('intervention_logs', {
        chat_id: chatId,
        intervention_type: 'stuck',
        data: data,
        created_at: new Date().toISOString(),
      });
    } catch {
      // Table might not exist yet, that's okay
      console.log('Could not log intervention (table may not exist)');
    }
  }
}

// ============================================
// Factory Function
// ============================================

export function createStuckHandler(
  db: SupabaseClient,
  settings: SettingsManager,
  aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>
): StuckHandler {
  return new StuckHandler(db, settings, aiCompleteFunc);
}
