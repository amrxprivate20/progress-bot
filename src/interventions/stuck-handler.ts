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
