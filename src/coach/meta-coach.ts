/**
 * Meta-Coach Orchestrator - Intelligent Intervention Decision-Making
 *
 * Purpose: Analyzes user state and decides which intervention to use.
 * Replaces static probes with intelligent, context-aware interventions.
 *
 * Features:
 * - State analysis (inactivity, failures, battle state, etc.)
 * - Decision matrix for choosing intervention type
 * - Escalation flow (gentle → pointed → stuck → roast → confrontation)
 * - Learning from outcomes
 */

import { SupabaseClient, op } from '../database/client';
import { SettingsManager } from '../database/settings';
import { AIMessage } from '../services/ai-client';
import { getTodayInEgypt } from '../utils/timezone';
import { createCoachingContextBuilder } from './coaching-context';
import { createTaskSessionManager, TaskSession } from '../services/task-session-manager';

// ============================================
// Types
// ============================================

export interface UserState {
  hoursInactive: number;
  tasksCompletedToday: number;
  tasksFailed: number;
  currentBattleState: any | null;
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  lastInterventionType: string | null;
  lastInterventionOutcome: 'positive' | 'negative' | 'pending' | null;
  minutesSinceLastIntervention: number;
  coachingStyle: 'confrontational' | 'supportive' | 'balanced';
  deferralsToday: number;
  avoidancePatterns: string[];
  activeTaskSession: TaskSession | null;
}

export interface InterventionDecision {
  type: 'gentle_checkin' | 'stuck_mode' | 'roast' | 'battle_narrative' | 'task_recommendation' | 'escalation' | 'combined' | 'none';
  components?: string[];
  message: string;
  targetTask?: string;
  escalationLevel: number; // 1-5
  followUpDelay?: number; // Minutes until escalation if ignored
}

// ============================================
// AI Prompts
// ============================================

const ESCALATION_PROMPT = `أنت كوتش إنتاجية مواجهة. الشخص تجاهل التنبيهات السابقة.

⚠️ مهم جداً: لازم الرد يكون بالعامية المصرية فقط! مفيش إنجليزي خالص.

حالة المستخدم:
- ساعات بدون إنجاز: {HOURS_INACTIVE}
- المهام المكتملة اليوم: {TASKS_COMPLETED}
- المهام الفاشلة: {TASKS_FAILED}
- آخر تدخل: {LAST_INTERVENTION}
- نتيجة آخر تدخل: {LAST_OUTCOME}
- مستوى التصعيد الحالي: {ESCALATION_LEVEL}/5

اكتب رسالة تصعيدية (2-3 جمل):
- مستوى 1-2: سؤال مباشر عن السبب
- مستوى 3: ذكّره بأنماط التأجيل المتكررة
- مستوى 4: تحدي قوي مع ذكر العواقب
- مستوى 5: مواجهة حادة (بدون قسوة)

اختم دايماً بطلب رد أو فعل محدد.`;

const GENTLE_CHECKIN_PROMPT = `أنت كوتش إنتاجية ودود. الشخص لسه بادي يومه.

⚠️ مهم جداً: لازم الرد يكون بالعامية المصرية فقط! مفيش إنجليزي خالص.

الوقت: {TIME_OF_DAY}
المهام المكتملة: {TASKS_COMPLETED}

اكتب رسالة صباحية قصيرة (1-2 جمل):
- لو مفيش مهام: اسأل عن خطة اليوم
- لو فيه مهام: احتفل بسرعة واسأل عن التالي

خليها خفيفة ومحفزة.`;

// ============================================
// Meta Coach Class
// ============================================

export class MetaCoach {
  private aiComplete: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>;
  private settings: SettingsManager;

  constructor(
    private db: SupabaseClient,
    settings: SettingsManager,
    aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>
  ) {
    this.settings = settings;
    this.aiComplete = aiCompleteFunc;
  }

  /**
   * Analyze current user state
   */
  async analyzeUserState(chatId: string): Promise<UserState> {
    const contextBuilder = createCoachingContextBuilder(this.db, this.settings);
    const sessionMgr = createTaskSessionManager(this.db);
    const today = getTodayInEgypt();

    // Get basic context
    const context = await contextBuilder.buildContext(chatId, 'auto', {
      includeBattleState: true,
      maxInteractions: 10,
    });

    // Calculate hours inactive
    const hoursInactive = await this.getHoursInactive();

    // Get time of day
    const egyptHour = new Date().toLocaleString('en-US', {
      timeZone: 'Africa/Cairo',
      hour: 'numeric',
      hour12: false,
    });
    const hour = parseInt(egyptHour, 10);
    let timeOfDay: UserState['timeOfDay'] = 'morning';
    if (hour >= 6 && hour < 12) timeOfDay = 'morning';
    else if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
    else if (hour >= 17 && hour < 21) timeOfDay = 'evening';
    else timeOfDay = 'night';

    // Get last intervention
    const lastInteraction = await this.getLastIntervention(chatId);
    const lastInterventionType = lastInteraction?.interaction_type || null;
    const lastInterventionOutcome = lastInteraction?.outcome as UserState['lastInterventionOutcome'] || null;
    const minutesSinceLastIntervention = lastInteraction
      ? (Date.now() - new Date(lastInteraction.timestamp).getTime()) / 60000
      : 9999;

    // Get deferrals today
    const deferralsToday = await this.getDeferralsToday(chatId);

    // Get avoidance patterns
    const avoidancePatterns = await this.getAvoidancePatternNames(chatId);

    // Get active session
    const activeSession = await sessionMgr.getActiveSession(chatId);

    // Get coaching style from settings
    const styleValue = await this.settings.get('coach.style');
    const coachingStyle = (styleValue as UserState['coachingStyle']) || 'confrontational';

    // Get failed tasks count
    const failedTasks = await this.db.select('daily_failures', {
      filter: { date: op.eq(today) },
      limit: 1,
    });
    const tasksFailed = (failedTasks[0]?.data as any)?.failed_tasks?.length || 0;

    return {
      hoursInactive,
      tasksCompletedToday: context.tasksCompletedToday,
      tasksFailed,
      currentBattleState: context.battleState,
      timeOfDay,
      lastInterventionType,
      lastInterventionOutcome,
      minutesSinceLastIntervention,
      coachingStyle,
      deferralsToday,
      avoidancePatterns,
      activeTaskSession: activeSession,
    };
  }

  /**
   * Decide which intervention to use based on state
   */
  async decideIntervention(state: UserState): Promise<InterventionDecision> {
    // If night time (23:00 - 07:00), don't intervene
    if (state.timeOfDay === 'night') {
      return {
        type: 'none',
        message: '',
        escalationLevel: 0,
      };
    }

    // If there's an active task session, don't intervene
    if (state.activeTaskSession) {
      return {
        type: 'none',
        message: '',
        escalationLevel: 0,
      };
    }

    // Decision matrix
    const escalationLevel = this.calculateEscalationLevel(state);

    // Morning with no activity: Gentle check-in
    if (state.timeOfDay === 'morning' && state.tasksCompletedToday === 0 && state.hoursInactive < 2) {
      return {
        type: 'gentle_checkin',
        message: '',
        escalationLevel: 1,
        followUpDelay: 60, // Check again in 1 hour
      };
    }

    // High inactivity + ignored last intervention: Escalate
    if (state.hoursInactive >= 2 && state.lastInterventionOutcome === 'pending' && state.minutesSinceLastIntervention >= 30) {
      return {
        type: 'escalation',
        message: '',
        escalationLevel: Math.min(5, escalationLevel + 1),
        followUpDelay: 30,
      };
    }

    // Multiple deferrals + same tasks keep failing: Stuck mode with recommendation
    if (state.deferralsToday >= 2 && state.avoidancePatterns.length > 0) {
      return {
        type: 'task_recommendation',
        message: '',
        targetTask: state.avoidancePatterns[0],
        escalationLevel,
        followUpDelay: 45,
      };
    }

    // Battle mode active + high boss HP + afternoon: Battle narrative urgency
    if (state.currentBattleState && state.timeOfDay === 'afternoon') {
      const bossHP = state.currentBattleState.bossCurrentHP || 0;
      const maxHP = state.currentBattleState.bossMaxHP || 100;
      const hpPercent = (bossHP / maxHP) * 100;

      if (hpPercent > 80) {
        return {
          type: 'battle_narrative',
          message: '',
          escalationLevel,
          followUpDelay: 60,
        };
      }
    }

    // Evening + low completion: Urgent combined intervention
    if (state.timeOfDay === 'evening' && state.tasksCompletedToday < 3 && state.tasksFailed > 2) {
      return {
        type: 'combined',
        components: ['stuck_mode', 'roast'],
        message: '',
        escalationLevel: Math.min(5, escalationLevel + 1),
        followUpDelay: 30,
      };
    }

    // General inactivity: Regular stuck mode
    if (state.hoursInactive >= 2) {
      return {
        type: 'stuck_mode',
        message: '',
        escalationLevel,
        followUpDelay: 45,
      };
    }

    // No intervention needed
    return {
      type: 'none',
      message: '',
      escalationLevel: 0,
    };
  }

  /**
   * Execute the decided intervention
   */
  async executeIntervention(chatId: string, decision: InterventionDecision): Promise<string> {
    switch (decision.type) {
      case 'gentle_checkin':
        return this.generateGentleCheckin(chatId);

      case 'escalation':
        return this.generateEscalation(chatId, decision.escalationLevel);

      case 'stuck_mode':
        return '💡 يبدو إنك محتاج دفعة. جرب /stuck لسبرنت سريع!';

      case 'task_recommendation':
        return `📌 لاحظت إنك بتأجل "${decision.targetTask}" كتير.\nجرب /stuck عشان نشتغل عليها دلوقتي!`;

      case 'battle_narrative':
        return this.generateBattleUrgency(chatId);

      case 'roast':
        return '🔥 جرب /roast_me لو عايز تعرف رأيي الصريح!';

      case 'combined':
        return this.generateCombinedIntervention(chatId, decision.escalationLevel);

      default:
        return '';
    }
  }

  /**
   * Handle ignored intervention (called after followUpDelay)
   */
  async handleIgnored(chatId: string): Promise<InterventionDecision | null> {
    const state = await this.analyzeUserState(chatId);

    // If last intervention was pending and time has passed, escalate
    if (state.lastInterventionOutcome === 'pending' && state.minutesSinceLastIntervention >= 30) {
      const currentLevel = this.calculateEscalationLevel(state);
      const newLevel = Math.min(5, currentLevel + 1);

      return {
        type: 'escalation',
        message: '',
        escalationLevel: newLevel,
        followUpDelay: newLevel >= 4 ? 60 : 30, // Longer delay at high escalation
      };
    }

    return null;
  }

  /**
   * Record intervention outcome
   */
  async recordOutcome(chatId: string, outcome: 'positive' | 'negative'): Promise<void> {
    const contextBuilder = createCoachingContextBuilder(this.db, this.settings);
    await contextBuilder.updateInteractionOutcome(chatId, 'meta_coach', outcome);
  }

  // ============================================
  // Private Helper Methods
  // ============================================

  private calculateEscalationLevel(state: UserState): number {
    let level = 1;

    // Increase based on inactivity
    if (state.hoursInactive >= 2) level++;
    if (state.hoursInactive >= 4) level++;

    // Increase based on failed tasks
    if (state.tasksFailed >= 3) level++;

    // Increase based on ignored interventions
    if (state.lastInterventionOutcome === 'pending' && state.minutesSinceLastIntervention >= 30) {
      level++;
    }

    // Cap at 5
    return Math.min(5, level);
  }

  private async getHoursInactive(): Promise<number> {
    try {
      const tasks = await this.db.select('tasks', {
        filter: { status: op.eq('done') },
        order: 'completed_at.desc',
        limit: 1,
      });

      if (tasks.length === 0) return 24;

      const lastCompletion = new Date(tasks[0]?.completed_at as string);
      return (Date.now() - lastCompletion.getTime()) / (1000 * 60 * 60);
    } catch {
      return 0;
    }
  }

  private async getLastIntervention(chatId: string): Promise<any | null> {
    try {
      const today = getTodayInEgypt();
      const result = await this.db.select('coaching_interactions', {
        filter: {
          chat_id: op.eq(chatId),
          interaction_date: op.eq(today),
        },
        order: 'timestamp.desc',
        limit: 1,
      });

      return result.length > 0 ? result[0] : null;
    } catch {
      return null;
    }
  }

  private async getDeferralsToday(chatId: string): Promise<number> {
    try {
      const today = getTodayInEgypt();
      const logs = await this.db.select('intervention_logs', {
        filter: {
          chat_id: op.eq(chatId),
        },
        order: 'created_at.desc',
        limit: 20,
      });

      return logs.filter((log: any) => {
        const createdAt = log.created_at?.split('T')[0];
        const data = log.data as any;
        return createdAt === today && (data?.type === 'stuck_deferred' || data?.deferred);
      }).length;
    } catch {
      return 0;
    }
  }

  private async getAvoidancePatternNames(chatId: string): Promise<string[]> {
    try {
      const logs = await this.db.select('intervention_logs', {
        filter: {
          chat_id: op.eq(chatId),
          intervention_type: op.eq('stuck'),
        },
        order: 'created_at.desc',
        limit: 30,
      });

      // Count task deferrals
      const taskCounts = new Map<string, number>();
      for (const log of logs) {
        const data = log.data as any;
        if (data?.type === 'stuck_deferred' || data?.deferred) {
          const taskName = data.taskDescription || data.taskContent || '';
          if (taskName) {
            taskCounts.set(taskName, (taskCounts.get(taskName) || 0) + 1);
          }
        }
      }

      // Return tasks deferred 2+ times
      return Array.from(taskCounts.entries())
        .filter(([_, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([task]) => task);
    } catch {
      return [];
    }
  }

  private async generateGentleCheckin(chatId: string): Promise<string> {
    const state = await this.analyzeUserState(chatId);

    const prompt = GENTLE_CHECKIN_PROMPT
      .replace('{TIME_OF_DAY}', state.timeOfDay)
      .replace('{TASKS_COMPLETED}', state.tasksCompletedToday.toString());

    const message = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.85,
      150
    );

    // Log interaction
    const contextBuilder = createCoachingContextBuilder(this.db, this.settings);
    await contextBuilder.logInteraction({
      chat_id: chatId,
      interaction_date: getTodayInEgypt(),
      timestamp: new Date().toISOString(),
      interaction_type: 'meta_coach',
      bot_response: message,
      outcome: 'pending',
      metadata: { interventionType: 'gentle_checkin' },
    });

    return `☀️ ${message.trim()}`;
  }

  private async generateEscalation(chatId: string, level: number): Promise<string> {
    const state = await this.analyzeUserState(chatId);

    const prompt = ESCALATION_PROMPT
      .replace('{HOURS_INACTIVE}', state.hoursInactive.toFixed(1))
      .replace('{TASKS_COMPLETED}', state.tasksCompletedToday.toString())
      .replace('{TASKS_FAILED}', state.tasksFailed.toString())
      .replace('{LAST_INTERVENTION}', state.lastInterventionType || 'none')
      .replace('{LAST_OUTCOME}', state.lastInterventionOutcome || 'none')
      .replace('{ESCALATION_LEVEL}', level.toString());

    const message = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.9,
      200
    );

    // Log interaction
    const contextBuilder = createCoachingContextBuilder(this.db, this.settings);
    await contextBuilder.logInteraction({
      chat_id: chatId,
      interaction_date: getTodayInEgypt(),
      timestamp: new Date().toISOString(),
      interaction_type: 'meta_coach',
      bot_response: message,
      outcome: 'pending',
      metadata: { interventionType: 'escalation', level },
    });

    const urgencyEmoji = level >= 4 ? '🚨' : level >= 3 ? '⚡' : '📢';
    return `${urgencyEmoji} ${message.trim()}`;
  }

  private async generateBattleUrgency(chatId: string): Promise<string> {
    const state = await this.analyzeUserState(chatId);

    if (!state.currentBattleState) {
      return '⚔️ معركتك تنتظرك! استخدم /battle_status لمعرفة حالة البوس';
    }

    const bossName = state.currentBattleState.boss?.name || 'العدو';
    const hpPercent = Math.round(
      (state.currentBattleState.bossCurrentHP / state.currentBattleState.bossMaxHP) * 100
    );

    // Log interaction
    const contextBuilder = createCoachingContextBuilder(this.db, this.settings);
    await contextBuilder.logInteraction({
      chat_id: chatId,
      interaction_date: getTodayInEgypt(),
      timestamp: new Date().toISOString(),
      interaction_type: 'meta_coach',
      bot_response: `Battle urgency: ${bossName} at ${hpPercent}%`,
      outcome: 'pending',
      metadata: { interventionType: 'battle_narrative' },
    });

    return `⚔️ *${bossName}* لسه عند ${hpPercent}% HP!\n\nاليوم بيجري والبوس بيزداد قوة. وقت الهجوم! 🎯`;
  }

  private async generateCombinedIntervention(chatId: string, level: number): Promise<string> {
    const state = await this.analyzeUserState(chatId);

    let message = `🔥 *تنبيه متعدد المستويات*\n\n`;
    message += `الوقت: ${state.timeOfDay === 'evening' ? 'المساء' : state.timeOfDay}\n`;
    message += `المهام المكتملة: ${state.tasksCompletedToday}\n`;
    message += `المهام الفاشلة: ${state.tasksFailed}\n\n`;

    if (state.avoidancePatterns.length > 0) {
      message += `⚠️ مهام بتتأجل كتير:\n`;
      state.avoidancePatterns.slice(0, 3).forEach(task => {
        message += `• ${task}\n`;
      });
      message += '\n';
    }

    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `🎯 /stuck - سبرنت سريع\n`;
    message += `🔥 /roast_me - كلام صريح\n`;
    message += `⚔️ /battle_status - المعركة`;

    // Log interaction
    const contextBuilder = createCoachingContextBuilder(this.db, this.settings);
    await contextBuilder.logInteraction({
      chat_id: chatId,
      interaction_date: getTodayInEgypt(),
      timestamp: new Date().toISOString(),
      interaction_type: 'meta_coach',
      bot_response: 'Combined intervention',
      outcome: 'pending',
      metadata: { interventionType: 'combined', level },
    });

    return message;
  }
}

// ============================================
// Factory Function
// ============================================

export function createMetaCoach(
  db: SupabaseClient,
  settings: SettingsManager,
  aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>
): MetaCoach {
  return new MetaCoach(db, settings, aiCompleteFunc);
}
