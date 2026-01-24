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

const INITIAL_QUESTION_PROMPT = `You are a CONFRONTATIONAL productivity coach. The user just pressed /stuck, signaling they're avoiding something.

{COACHING_CONTEXT}

Generate ONE powerful, DIRECT question to uncover what they're really avoiding.

Rules:
- Be CONFRONTATIONAL - challenge them, don't comfort them
- No generic questions - make it personal based on their patterns
- Target the emotional root: fear, overwhelm, boredom, or resistance
- If you know their triggers from memory, reference them
- Arabic preferred, mix English for impact
- Max 2 sentences

Examples of good confrontational questions:
- "مرة ثانية؟ وش اللي يخليك تهرب من نفس النوع من المهام؟"
- "خايف تفشل ولا خايف تنجح وتصير مسؤول؟"
- "كم مرة قلت 'بعدين' اليوم؟ وش الحقيقة؟"

Respond with ONLY the question, nothing else.`;

const CLASSIFY_BLOCKAGE_PROMPT = `You are analyzing why someone is stuck and procrastinating.

User's response about what they're avoiding:
"{USER_RESPONSE}"

Classify this blockage into ONE of these categories:
- FEAR: Anxiety about outcome, judgment, failure, or the unknown
- OVERWHELM: Task feels too big, complex, or has too many steps
- BOREDOM: Task is tedious, repetitive, or unstimulating
- RESISTANCE: Internal conflict, values clash, or emotional avoidance

Also generate a SHORT, punchy response (2-3 sentences max) that:
1. Acknowledges their specific situation
2. Reframes it in a motivating way
3. Sets up the 2-minute sprint

Format your response EXACTLY like this:
[CLASSIFICATION]
fear/overwhelm/boredom/resistance

[RESPONSE]
Your motivating message here in Arabic or English`;

const SPRINT_NUDGE_PROMPT = `You are a productivity coach during an active 2-minute sprint.

Context:
- User was stuck due to: {BLOCKAGE_TYPE}
- They're working on: {TASK_DESCRIPTION}
- Time remaining: {TIME_REMAINING} seconds
- This is nudge #{NUDGE_NUMBER}

Generate a SHORT (1 sentence) nudge to keep momentum. Be:
- Urgent but not stressful
- Specific to their blockage type
- Encouraging their progress

For FEAR: Remind them nothing bad has happened yet
For OVERWHELM: Celebrate any tiny progress
For BOREDOM: Make it a micro-game
For RESISTANCE: Acknowledge the discomfort, push through

Respond with ONLY the nudge message.`;

const POST_SPRINT_PROMPT = `The user just completed a 2-minute action sprint.

Context:
- They were stuck due to: {BLOCKAGE_TYPE}
- Original task/situation: {TASK_DESCRIPTION}

Generate a response that:
1. Celebrates completing the sprint (briefly)
2. Asks what happened in those 2 minutes
3. Offers THREE clear options:
   - 🔥 Continue (they're in flow)
   - ✅ Mark done (they finished something)
   - ⏰ Defer with reason (need to stop)

Keep it SHORT and action-focused. Arabic preferred.

Format:
[CELEBRATION]
Brief celebration (1 sentence)

[QUESTION]
What happened question

[OPTIONS]
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

    // Parse classification
    const classificationMatch = aiResponse.match(/\[CLASSIFICATION\]\s*(fear|overwhelm|boredom|resistance)/i);
    const responseMatch = aiResponse.match(/\[RESPONSE\]\s*([\s\S]+?)(?:\[|$)/i);

    const blockageType = (classificationMatch?.[1]?.toLowerCase() || 'unknown') as BlockageType;
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

    await this.db.upsert('conversation_state', {
      chat_id: key,
      conversation_type: 'stuck_intervention',
      current_step: 0,
      data: state,
      expires_at: expiresAt,
    }, 'chat_id');
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
