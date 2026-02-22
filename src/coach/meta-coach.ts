/**
 * Meta-Coach Orchestrator - "Always Present Coach"
 *
 * Purpose: Proactive engagement throughout the day, not just when failing.
 * The coach should feel present, interactive, and engaged all day long.
 *
 * Intervention Types:
 * - morning_kickoff: Start day with energy (first check after sleep_end)
 * - midday_push: Afternoon energy boost (12-14)
 * - evening_check: Day progress review (18-21)
 * - momentum_check: Regular "still with you" presence
 * - night_wrapup: End of day reflection (21-22)
 * - celebration: After task completion
 * - inactivity_nudge: When inactive too long (escalating)
 * - escalation: When ignoring interventions
 */

import { SupabaseClient, op } from '../database/client';
import { SettingsManager } from '../database/settings';
import { AIMessage } from '../services/ai-client';
import { getTodayInEgypt } from '../utils/timezone';
import { createCoachingContextBuilder } from './coaching-context';
import { createTaskSessionManager, TaskSession } from '../services/task-session-manager';
import {
  buildLightweightDailySummary,
  formatLightweightSummaryForContext,
} from '../services/report-generator';
import { extractCleanTaskName } from '../utils/task-parser';
import { splitMessage } from '../utils/split-message';

// ============================================
// Types
// ============================================

export interface UserState {
  hoursInactive: number;
  tasksCompletedToday: number;
  tasksFailed: number;
  currentBattleState: any | null;
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  currentHour: number;
  lastInterventionType: string | null;
  lastInterventionOutcome: 'positive' | 'negative' | 'pending' | null;
  minutesSinceLastIntervention: number;
  coachingStyle: 'confrontational' | 'supportive' | 'balanced';
  deferralsToday: number;
  avoidancePatterns: string[];
  activeTaskSession: TaskSession | null;
  interventionsToday: number;
  lastInterventionHour: number | null;
  /** Pre-formatted memory section for intervention prompt (avoids extra query in buildInterventionContext) */
  memoryForPrompt?: string;
}

export type InterventionType =
  | 'morning_kickoff'
  | 'midday_push'
  | 'evening_check'
  | 'momentum_check'
  | 'night_wrapup'
  | 'celebration'
  | 'inactivity_nudge'
  | 'escalation'
  | 'battle_narrative'
  | 'none';

export interface InterventionDecision {
  type: InterventionType;
  message: string;
  escalationLevel: number; // 1-5
  followUpDelay?: number; // Minutes until next check
}

// ============================================
// AI Prompts (All in Egyptian Arabic)
// ============================================

const PROMPTS = {
  morning_kickoff: {
    confrontational: `أنت كوتش إنتاجية مواجه. الصبح بدأ والمعركة لسه قدامنا.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة امبارح: {YESTERDAY_TASKS}
المهام المتاحة اليوم: {AVAILABLE_TASKS}

اكتب رسالة صباحية قوية (2-3 جمل):
- حفزه يبدأ فوراً
- ذكّره إن الوقت بيجري
- اسأله: "إيه أول مهمة هتضربها؟"

ممنوع تكون لطيف. خليك مباشر ومحفز.`,

    supportive: `أنت كوتش إنتاجية داعم. صباح جديد وفرصة جديدة.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة امبارح: {YESTERDAY_TASKS}
المهام المتاحة اليوم: {AVAILABLE_TASKS}

اكتب رسالة صباحية إيجابية (2-3 جمل):
- ابدأ بتحية دافئة
- شجعه على يوم منتج
- اسأله عن خطته

خليها خفيفة ومحفزة.`,

    balanced: `أنت كوتش إنتاجية متوازن. يوم جديد يبدأ.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة امبارح: {YESTERDAY_TASKS}
المهام المتاحة اليوم: {AVAILABLE_TASKS}

اكتب رسالة صباحية (2-3 جمل):
- حفزه بدون ضغط زيادة
- اسأله عن أول مهمة

متوسط بين الحماس والهدوء.`,
  },

  midday_push: {
    confrontational: `أنت كوتش إنتاجية مواجه. نص اليوم ولسه فيه وقت.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة اليوم: {TASKS_COMPLETED}
ساعات بدون إنجاز: {HOURS_INACTIVE}
البوس الحالي: {BOSS_STATUS}

اكتب رسالة نص اليوم (2-3 جمل):
- راجع الإنجاز لحد دلوقتي
- لو قليل: واجهه بالحقيقة
- لو كويس: ادفعه يكمل
- اسأل: "إيه التالي؟"

كن مباشر وصريح.`,

    supportive: `أنت كوتش إنتاجية داعم. check-in نص اليوم.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة اليوم: {TASKS_COMPLETED}

اكتب رسالة نص اليوم (2-3 جمل):
- احتفل بأي إنجاز
- شجعه يكمل
- اسأل لو محتاج مساعدة`,

    balanced: `أنت كوتش إنتاجية متوازن. وقت check-in.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة اليوم: {TASKS_COMPLETED}
ساعات بدون إنجاز: {HOURS_INACTIVE}

اكتب رسالة نص اليوم (2-3 جمل):
- راجع الإنجاز
- شجع أو ادفع حسب الحالة`,
  },

  evening_check: {
    confrontational: `أنت كوتش إنتاجية مواجه. المساء بدأ واليوم قرب يخلص.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة: {TASKS_COMPLETED}
المهام الفاشلة: {TASKS_FAILED}
البوس HP: {BOSS_HP}%

اكتب رسالة مسائية (2-3 جمل):
- لو الإنجاز قليل: مواجهة حادة
- لو كويس: اعترف بس اطلب المزيد
- ذكّره إن الوقت بيخلص

لازم يحس بالضغط.`,

    supportive: `أنت كوتش إنتاجية داعم. مراجعة المساء.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة: {TASKS_COMPLETED}

اكتب رسالة مسائية (2-3 جمل):
- احتفل بالإنجازات
- شجعه يختم يومه صح
- كن إيجابي`,

    balanced: `أنت كوتش إنتاجية متوازن. مراجعة المساء.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة: {TASKS_COMPLETED}
المهام الفاشلة: {TASKS_FAILED}

اكتب رسالة مسائية (2-3 جمل):
- راجع اليوم
- شجع أو ادفع حسب الحالة`,
  },

  momentum_check: {
    confrontational: `أنت كوتش إنتاجية مواجه. بتتابع التقدم.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة: {TASKS_COMPLETED}
آخر إنجاز: {HOURS_INACTIVE} ساعة
الوقت: {TIME_OF_DAY}

اكتب رسالة متابعة قصيرة (1-2 جمل):
- لو شغال: "كمّل، ماتوقفش"
- لو واقف: "هو انت فين؟"

خليها قصيرة ومباشرة.`,

    supportive: `أنت كوتش إنتاجية داعم. متابعة سريعة.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة: {TASKS_COMPLETED}

اكتب رسالة متابعة قصيرة (1-2 جمل):
- check-in ودود
- شجعه يكمل`,

    balanced: `أنت كوتش إنتاجية متوازن. متابعة.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة: {TASKS_COMPLETED}
آخر إنجاز: {HOURS_INACTIVE} ساعة

اكتب رسالة متابعة قصيرة (1-2 جمل).`,
  },

  night_wrapup: {
    confrontational: `أنت كوتش إنتاجية مواجه. اليوم خلص.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة: {TASKS_COMPLETED}
المهام الفاشلة: {TASKS_FAILED}

اكتب رسالة ختام اليوم (2-3 جمل):
- راجع الإنجاز بصراحة
- لو قليل: "بكرة لازم أحسن"
- لو كويس: اعترف بس اطلب استمرارية

خليها صادقة ومباشرة.`,

    supportive: `أنت كوتش إنتاجية داعم. نهاية اليوم.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة: {TASKS_COMPLETED}

اكتب رسالة ختام اليوم (2-3 جمل):
- احتفل بالإنجازات
- شجعه على الراحة
- تمنّى له يوم أحسن بكرة`,

    balanced: `أنت كوتش إنتاجية متوازن. نهاية اليوم.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهام المكتملة: {TASKS_COMPLETED}
المهام الفاشلة: {TASKS_FAILED}

اكتب رسالة ختام اليوم (2-3 جمل):
- ملخص متوازن
- تشجيع لبكرة`,
  },

  celebration: {
    confrontational: `أنت كوتش إنتاجية مواجه. تم إكمال مهمة.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهمة المكتملة: {TASK_NAME}
المدة: {DURATION} دقيقة
إجمالي اليوم: {TASKS_COMPLETED}

اكتب رسالة احتفال قصيرة (1-2 جمل):
- اعترف بالإنجاز بسرعة
- بس اطلب المزيد فوراً
- "حلو، إيه التالي؟"

مفيش مدح زيادة. خليها قصيرة.`,

    supportive: `أنت كوتش إنتاجية داعم. مبروك على الإنجاز!

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهمة المكتملة: {TASK_NAME}
المدة: {DURATION} دقيقة
إجمالي اليوم: {TASKS_COMPLETED}

اكتب رسالة احتفال (1-2 جمل):
- احتفل بحماس
- شجعه يكمل`,

    balanced: `أنت كوتش إنتاجية متوازن. تم إكمال مهمة.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

المهمة المكتملة: {TASK_NAME}
المدة: {DURATION} دقيقة
إجمالي اليوم: {TASKS_COMPLETED}

اكتب رسالة احتفال قصيرة (1-2 جمل):
- اعترف بالإنجاز
- شجع على التالي`,
  },

  inactivity_nudge: {
    confrontational: `أنت كوتش إنتاجية مواجه. الشخص مش بيشتغل.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

ساعات بدون إنجاز: {HOURS_INACTIVE}
المهام المكتملة اليوم: {TASKS_COMPLETED}
الوقت: {TIME_OF_DAY}
مستوى التصعيد: {ESCALATION_LEVEL}/5

اكتب رسالة تنبيه (2-3 جمل):
- مستوى 1-2: سؤال مباشر "هو انت فين؟"
- مستوى 3: تحدي "الوقت بيجري وانت واقف"
- مستوى 4-5: مواجهة حادة "كفاية تأجيل"

اختم بطلب فعل: "قولي إيه المهمة الجاية"`,

    supportive: `أنت كوتش إنتاجية داعم. الشخص محتاج دفعة.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

ساعات بدون إنجاز: {HOURS_INACTIVE}
المهام المكتملة اليوم: {TASKS_COMPLETED}

اكتب رسالة تشجيعية (2-3 جمل):
- check-in لطيف
- اسأل لو محتاج مساعدة
- اقترح يبدأ بحاجة صغيرة`,

    balanced: `أنت كوتش إنتاجية متوازن. وقت التنبيه.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

ساعات بدون إنجاز: {HOURS_INACTIVE}
المهام المكتملة اليوم: {TASKS_COMPLETED}
مستوى التصعيد: {ESCALATION_LEVEL}/5

اكتب رسالة تنبيه (2-3 جمل):
- حسب المستوى: من لطيف لمباشر
- اطلب فعل`,
  },

  escalation: {
    confrontational: `أنت كوتش إنتاجية مواجه. الشخص تجاهل التنبيهات.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

ساعات بدون إنجاز: {HOURS_INACTIVE}
المهام المكتملة اليوم: {TASKS_COMPLETED}
آخر تدخل: {LAST_INTERVENTION}
مستوى التصعيد: {ESCALATION_LEVEL}/5

اكتب رسالة تصعيدية قوية (2-3 جمل):
- مستوى 3: "انت بتتجاهلني ليه؟"
- مستوى 4: "كفاية كلام، فين الفعل؟"
- مستوى 5: "آخر تحذير. اشتغل أو اعترف إنك مش عايز"

لازم يحس إنك جاد.`,

    supportive: `أنت كوتش إنتاجية داعم. الشخص محتاج دعم أكتر.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

ساعات بدون إنجاز: {HOURS_INACTIVE}
المهام المكتملة اليوم: {TASKS_COMPLETED}

اكتب رسالة دعم (2-3 جمل):
- اسأل لو فيه مشكلة
- اقترح مساعدة
- شجعه يبدأ بأي حاجة`,

    balanced: `أنت كوتش إنتاجية متوازن. محتاج متابعة أقوى.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

ساعات بدون إنجاز: {HOURS_INACTIVE}
المهام المكتملة اليوم: {TASKS_COMPLETED}
مستوى التصعيد: {ESCALATION_LEVEL}/5

اكتب رسالة متابعة (2-3 جمل):
- راجع الموقف
- اطلب فعل`,
  },

  battle_narrative: {
    confrontational: `أنت كوتش إنتاجية مواجه. فيه معركة شغالة والبوس لسه قوي.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

اسم البوس: {BOSS_NAME}
HP البوس: {BOSS_HP}%
المهام المكتملة: {TASKS_COMPLETED}

اكتب رسالة حماسية قتالية (2-3 جمل):
- استخدم لغة المعركة
- "البوس بيضحك عليك"
- "هتسيبه يكسب؟"

خليها حماسية وتحفيزية.`,

    supportive: `أنت كوتش إنتاجية داعم. معركة شغالة!

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

اسم البوس: {BOSS_NAME}
HP البوس: {BOSS_HP}%

اكتب رسالة تشجيعية (2-3 جمل):
- شجعه على المعركة
- "انت قدها!"`,

    balanced: `أنت كوتش إنتاجية متوازن. تحديث المعركة.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

اسم البوس: {BOSS_NAME}
HP البوس: {BOSS_HP}%
المهام المكتملة: {TASKS_COMPLETED}

اكتب رسالة عن المعركة (2-3 جمل).`,
  },
};

// ============================================
// Meta Coach Class
// ============================================

export class MetaCoach {
  private aiComplete: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>;
  private settings: SettingsManager;
  private botToken: string | null;

  constructor(
    private db: SupabaseClient,
    settings: SettingsManager,
    aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>,
    botToken?: string
  ) {
    this.settings = settings;
    this.aiComplete = aiCompleteFunc;
    this.botToken = botToken || null;
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

    // Get current hour in Egypt
    const egyptHour = new Date().toLocaleString('en-US', {
      timeZone: 'Africa/Cairo',
      hour: 'numeric',
      hour12: false,
    });
    const currentHour = parseInt(egyptHour, 10);

    // Determine time of day
    let timeOfDay: UserState['timeOfDay'] = 'morning';
    if (currentHour >= 6 && currentHour < 12) timeOfDay = 'morning';
    else if (currentHour >= 12 && currentHour < 17) timeOfDay = 'afternoon';
    else if (currentHour >= 17 && currentHour < 21) timeOfDay = 'evening';
    else timeOfDay = 'night';

    // Get last intervention
    const lastInteraction = await this.getLastIntervention(chatId);
    const lastInterventionType = lastInteraction?.metadata?.interventionType || lastInteraction?.interaction_type || null;
    const lastInterventionOutcome = lastInteraction?.outcome as UserState['lastInterventionOutcome'] || null;
    const minutesSinceLastIntervention = lastInteraction
      ? (Date.now() - new Date(lastInteraction.timestamp).getTime()) / 60000
      : 9999;

    // Get last intervention hour
    let lastInterventionHour: number | null = null;
    if (lastInteraction?.timestamp) {
      const lastTime = new Date(lastInteraction.timestamp);
      lastInterventionHour = parseInt(
        lastTime.toLocaleString('en-US', { timeZone: 'Africa/Cairo', hour: 'numeric', hour12: false }),
        10
      );
    }

    // Count interventions today
    const interventionsToday = await this.getInterventionsToday(chatId);

    // Deferrals and avoidance patterns (skipped to reduce subrequests)
    const deferralsToday = 0;
    const avoidancePatterns: string[] = [];

    // Get active session
    const activeSession = await sessionMgr.getActiveSession(chatId);

    // Get coaching style from settings
    const styleValue = await this.settings.get('coach.style');
    const coachingStyle = (styleValue as UserState['coachingStyle']) || 'confrontational';

    // Get failed tasks count
    const failedTasks = await this.db.select('daily_failures', {
      filter: { failure_date: op.eq(today) },
      limit: 1,
    });
    const failuresJson = failedTasks[0]?.failures_json;
    const parsedFailures = typeof failuresJson === 'string' ? JSON.parse(failuresJson) : failuresJson;
    const tasksFailed = parsedFailures?.failed_tasks?.length || 0;

    // Pre-format memory for intervention prompt (avoids 1 extra query in buildInterventionContext)
    let memoryForPrompt: string | undefined;
    if (context.coachingPatterns || context.interventionEffectiveness || context.userTriggers) {
      const parts: string[] = [];
      if (context.coachingPatterns) parts.push(`ما ينجح مع المستخدم:\n${context.coachingPatterns}`);
      if (context.interventionEffectiveness) parts.push(`فعالية التدخلات:\n${context.interventionEffectiveness}`);
      if (context.userTriggers) parts.push(`محفزات المستخدم وردود الكوتش:\n${context.userTriggers}`);
      memoryForPrompt = parts.join('\n\n');
    }

    return {
      hoursInactive,
      tasksCompletedToday: context.tasksCompletedToday,
      tasksFailed,
      currentBattleState: context.battleState,
      timeOfDay,
      currentHour,
      lastInterventionType,
      lastInterventionOutcome,
      minutesSinceLastIntervention,
      coachingStyle,
      deferralsToday,
      avoidancePatterns,
      activeTaskSession: activeSession,
      interventionsToday,
      lastInterventionHour,
      memoryForPrompt,
    };
  }

  /**
   * Decide which intervention to use based on state
   * NEW FLOW: Proactive engagement throughout the day
   */
  async decideIntervention(state: UserState): Promise<InterventionDecision> {
    // Get settings
    const thresholdStr = await this.settings.get('coach.inactivity_threshold_hours');
    const inactivityThreshold = thresholdStr ? parseFloat(thresholdStr) : 1.5;

    const sleepStartStr = await this.settings.get('coach.sleep_start') || '23:00';
    const sleepEndStr = await this.settings.get('coach.sleep_end') || '07:00';

    const sleepStartH = parseInt(sleepStartStr.split(':')[0] || '23', 10);
    const sleepEndH = parseInt(sleepEndStr.split(':')[0] || '7', 10);

    // Calculate dynamic boundaries
    const morningEndH = (sleepEndH + 3) % 24; // Morning kickoff window: sleepEnd to sleepEnd+3h
    // Night wrapup: 1 hour before sleep_start
    const nightWrapupStartH = sleepStartH > 0 ? sleepStartH - 1 : 23;

    // ============================================
    // 1. Sleep time? → No intervention
    // ============================================
    if (this.isInSleepPeriod(state.currentHour, sleepStartH, sleepEndH)) {
      return { type: 'none', message: '', escalationLevel: 0 };
    }

    // ============================================
    // 2. Active task session? → No intervention
    // ============================================
    if (state.activeTaskSession) {
      return { type: 'none', message: '', escalationLevel: 0 };
    }

    const escalationLevel = this.calculateEscalationLevel(state);

    // ============================================
    // 3. Ignored previous intervention? → ESCALATION
    // ============================================
    if (
      state.lastInterventionOutcome === 'pending' &&
      state.minutesSinceLastIntervention >= 30 &&
      state.hoursInactive >= inactivityThreshold
    ) {
      return {
        type: 'escalation',
        message: '',
        escalationLevel: Math.min(5, escalationLevel + 1),
        followUpDelay: 30,
      };
    }

    // ============================================
    // 4. Morning kickoff (sleepEnd to sleepEnd+3h)
    // ============================================
    if (
      this.isInHourRange(state.currentHour, sleepEndH, morningEndH) &&
      !this.hadInterventionInHourRange(state.lastInterventionHour, sleepEndH, morningEndH)
    ) {
      return {
        type: 'morning_kickoff',
        message: '',
        escalationLevel: 1,
        followUpDelay: 90,
      };
    }

    // ============================================
    // 5. Night wrap-up (1h before sleepStart)
    // ============================================
    if (
      this.isInHourRange(state.currentHour, nightWrapupStartH, sleepStartH) &&
      !this.hadInterventionInHourRange(state.lastInterventionHour, nightWrapupStartH, sleepStartH)
    ) {
      return {
        type: 'night_wrapup',
        message: '',
        escalationLevel: 1,
        followUpDelay: 120,
      };
    }

    // ============================================
    // 6. Battle active with high boss HP? → BATTLE NARRATIVE
    // ============================================
    if (state.currentBattleState) {
      const bossHP = state.currentBattleState.bossCurrentHP || 0;
      const maxHP = state.currentBattleState.bossMaxHP || 100;
      const hpPercent = (bossHP / maxHP) * 100;

      if (hpPercent > 60 && state.hoursInactive >= inactivityThreshold) {
        return {
          type: 'battle_narrative',
          message: '',
          escalationLevel,
          followUpDelay: 60,
        };
      }
    }

    // ============================================
    // 7. Inactive >= threshold? → Time-appropriate nudge
    //    Covers ALL waking hours dynamically
    // ============================================
    if (state.hoursInactive >= inactivityThreshold) {
      // Pick prompt type based on current time of day
      const nudgeType = (state.timeOfDay === 'morning' || state.timeOfDay === 'afternoon')
        ? 'midday_push' as const
        : 'evening_check' as const;

      return {
        type: nudgeType,
        message: '',
        escalationLevel,
        followUpDelay: 45,
      };
    }

    // ============================================
    // 8. Active but threshold passed since last check? → MOMENTUM CHECK
    //    Covers ALL waking hours dynamically
    // ============================================
    const checkIntervalMinutes = inactivityThreshold * 60;
    if (state.minutesSinceLastIntervention >= checkIntervalMinutes) {
      return {
        type: 'momentum_check',
        message: '',
        escalationLevel: 1,
        followUpDelay: 90,
      };
    }

    // ============================================
    // No intervention needed
    // ============================================
    return { type: 'none', message: '', escalationLevel: 0 };
  }

  /**
   * Execute the decided intervention.
   * Pass optional state to avoid re-calling analyzeUserState (saves ~15 subrequests when called from coach_check).
   */
  async executeIntervention(
    chatId: string,
    decision: InterventionDecision,
    state?: UserState
  ): Promise<string> {
    const resolvedState = state ?? (await this.analyzeUserState(chatId));
    const style = resolvedState.coachingStyle;

    switch (decision.type) {
      case 'morning_kickoff':
        return this.generateMessage(chatId, 'morning_kickoff', style, resolvedState, decision.escalationLevel);

      case 'midday_push':
        return this.generateMessage(chatId, 'midday_push', style, resolvedState, decision.escalationLevel);

      case 'evening_check':
        return this.generateMessage(chatId, 'evening_check', style, resolvedState, decision.escalationLevel);

      case 'momentum_check':
        return this.generateMessage(chatId, 'momentum_check', style, resolvedState, decision.escalationLevel);

      case 'night_wrapup':
        return this.generateMessage(chatId, 'night_wrapup', style, resolvedState, decision.escalationLevel);

      case 'inactivity_nudge':
        return this.generateMessage(chatId, 'inactivity_nudge', style, resolvedState, decision.escalationLevel);

      case 'escalation':
        return this.generateMessage(chatId, 'escalation', style, resolvedState, decision.escalationLevel);

      case 'battle_narrative':
        return this.generateMessage(chatId, 'battle_narrative', style, resolvedState, decision.escalationLevel);

      default:
        return '';
    }
  }

  /**
   * Generate celebration message (called from task completion)
   */
  async generateCelebration(chatId: string, taskName: string, durationMinutes: number): Promise<string> {
    const state = await this.analyzeUserState(chatId);
    const style = state.coachingStyle;

    const promptTemplate = PROMPTS.celebration[style];
    const prompt = promptTemplate
      .replace('{TASK_NAME}', taskName)
      .replace('{DURATION}', durationMinutes.toString())
      .replace('{TASKS_COMPLETED}', (state.tasksCompletedToday + 1).toString());

    const message = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.85,
      100
    );

    // Log interaction
    await this.logInteraction(chatId, 'celebration', message);

    const emoji = style === 'confrontational' ? '💪' : style === 'supportive' ? '🎉' : '✅';
    return `${emoji} ${message.trim()}`;
  }

  // ============================================
  // Private Helper Methods
  // ============================================

  private isInSleepPeriod(currentHour: number, sleepStartH: number, sleepEndH: number): boolean {
    // Handle overnight sleep (e.g., 23:00 to 07:00)
    if (sleepStartH > sleepEndH) {
      return currentHour >= sleepStartH || currentHour < sleepEndH;
    }
    return currentHour >= sleepStartH && currentHour < sleepEndH;
  }

  private isInHourRange(currentHour: number, startH: number, endH: number): boolean {
    if (startH <= endH) {
      return currentHour >= startH && currentHour < endH;
    }
    // Wraps overnight (e.g., 23 to 2)
    return currentHour >= startH || currentHour < endH;
  }

  private hadInterventionInHourRange(lastHour: number | null, startH: number, endH: number): boolean {
    if (lastHour === null) return false;
    if (startH <= endH) {
      return lastHour >= startH && lastHour < endH;
    }
    // Wraps overnight
    return lastHour >= startH || lastHour < endH;
  }

  private calculateEscalationLevel(state: UserState): number {
    let level = 1;

    // Increase based on inactivity
    if (state.hoursInactive >= 1.5) level++;
    if (state.hoursInactive >= 3) level++;
    if (state.hoursInactive >= 5) level++;

    // Increase based on failed tasks
    if (state.tasksFailed >= 3) level++;

    // Increase based on ignored interventions
    if (state.lastInterventionOutcome === 'pending' && state.minutesSinceLastIntervention >= 30) {
      level++;
    }

    // Cap at 5
    return Math.min(5, level);
  }

  private async generateMessage(
    chatId: string,
    type: keyof typeof PROMPTS,
    style: 'confrontational' | 'supportive' | 'balanced',
    state: UserState,
    escalationLevel: number
  ): Promise<string> {
    const promptTemplate = PROMPTS[type][style];

    // Skip yesterday/available task queries to stay under subrequest limit (use placeholders)
    const yesterdayTasks = 0;
    const availableTasks = 0;

    // Get boss info
    let bossName = 'لا يوجد';
    let bossHP = 0;
    if (state.currentBattleState) {
      bossName = state.currentBattleState.boss?.name || 'العدو';
      bossHP = Math.round(
        (state.currentBattleState.bossCurrentHP / state.currentBattleState.bossMaxHP) * 100
      );
    }

    // Replace placeholders in template
    let prompt = promptTemplate
      .replace('{HOURS_INACTIVE}', state.hoursInactive.toFixed(1))
      .replace('{TASKS_COMPLETED}', state.tasksCompletedToday.toString())
      .replace('{TASKS_FAILED}', state.tasksFailed.toString())
      .replace('{TIME_OF_DAY}', this.getArabicTimeOfDay(state.timeOfDay))
      .replace('{ESCALATION_LEVEL}', escalationLevel.toString())
      .replace('{LAST_INTERVENTION}', state.lastInterventionType || 'لا يوجد')
      .replace('{YESTERDAY_TASKS}', yesterdayTasks.toString())
      .replace('{AVAILABLE_TASKS}', availableTasks.toString())
      .replace('{BOSS_NAME}', bossName)
      .replace('{BOSS_HP}', bossHP.toString())
      .replace('{BOSS_STATUS}', state.currentBattleState ? `${bossName} - ${bossHP}% HP` : 'لا توجد معركة');

    // Append lean intervention context (report preview, activity, interventions history, interactive session)
    const currentTime = this.getCurrentEgyptTime();
    const interventionContext = await this.buildInterventionContext(chatId, { memorySection: state.memoryForPrompt });
    prompt += `\n\nالوقت الحالي: ${currentTime}\n\n${interventionContext}`;

    // Debug mode: send full prompt to Telegram for observation
    const debugMode = await this.settings.get('debug_mode');
    console.log(`🔍 Debug mode check: debug_mode="${debugMode}", chatId="${chatId}"`);
    if (debugMode === 'true') {
      console.log('🔍 Debug mode ON - sending prompt to Telegram');
      await this.sendDebugMessage(chatId, `Coach Prompt (${type})`, prompt);
    }

    const message = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.9,
      200
    );

    // Log interaction
    await this.logInteraction(chatId, type, message, escalationLevel);

    // Add emoji based on type
    const emojis: Record<string, string> = {
      morning_kickoff: '☀️',
      midday_push: '⚡',
      evening_check: '🌆',
      momentum_check: '👀',
      night_wrapup: '🌙',
      inactivity_nudge: escalationLevel >= 3 ? '🚨' : '📢',
      escalation: '🔥',
      battle_narrative: '⚔️',
    };

    return `${emojis[type] || '📌'} ${message.trim()}`;
  }

  private getArabicTimeOfDay(timeOfDay: string): string {
    const map: Record<string, string> = {
      morning: 'الصبح',
      afternoon: 'الضهر',
      evening: 'المساء',
      night: 'الليل',
    };
    return map[timeOfDay] || timeOfDay;
  }

  private getCurrentEgyptTime(): string {
    return new Date().toLocaleString('ar-EG', {
      timeZone: 'Africa/Cairo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  }

  private getDayPeriodContext(currentHour: number): string {
    if (currentHour >= 5 && currentHour < 9) return 'لسه الصبح بدري - وقت البداية الذهبية';
    if (currentHour >= 9 && currentHour < 12) return 'الصبح - وقت الإنتاجية العالية';
    if (currentHour >= 12 && currentHour < 14) return 'نص النهار - وقت check-in';
    if (currentHour >= 14 && currentHour < 17) return 'بعد الضهر - لسه فيه وقت كتير';
    if (currentHour >= 17 && currentHour < 20) return 'المغرب قرب - اليوم بيخلص';
    if (currentHour >= 20 && currentHour < 22) return 'بالليل - آخر فرصة للإنجاز';
    if (currentHour >= 22) return 'متأخر - وقت ختام اليوم';
    return 'فجر';
  }

  /**
   * Send debug message to Telegram (when debug_mode is on)
   * Splits long messages via splitMessage to stay under Telegram's 4096 char limit
   */
  async sendDebugMessage(chatId: string, label: string, content: string): Promise<void> {
    try {
      const botToken = this.botToken || await this.settings.get('telegram_bot_token');
      if (!botToken) {
        console.error('Debug: telegram_bot_token not found (neither in constructor nor settings)');
        return;
      }

      const fullText = `🔍 DEBUG - ${label}:\n\n${content}`;
      const chunks = splitMessage(fullText);
      const totalChunks = chunks.length;

      for (let i = 0; i < chunks.length; i++) {
        let chunk = chunks[i] || '';
        if (totalChunks > 1) {
          chunk = `📄 [${i + 1}/${totalChunks}]\n\n${chunk}`;
        }
        const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk }),
        });
        if (!resp.ok) {
          console.error(`Debug send failed (chunk ${i + 1}/${totalChunks}):`, await resp.text());
        }
        if (totalChunks > 1 && i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    } catch (e) {
      console.error('Debug message send error:', e);
    }
  }

  /**
   * Build lean intervention context: report preview, activity since last intervention,
   * today's interventions history (short), and interactive session script if any.
   * Uses buildLightweightDailySummary (4 queries) instead of generatePreview (~11) to stay under subrequest limit.
   * When memorySection is passed (from analyzeUserState), skips the memory query to save 1 subrequest.
   */
  private async buildInterventionContext(
    chatId: string,
    options?: { memorySection?: string }
  ): Promise<string> {
    const today = getTodayInEgypt();
    const sections: string[] = [];

    try {
      // 0. MEMORY — same as /memory: load all rows from memory table and include every category that has content
      if (options?.memorySection?.trim()) {
        sections.push('## ذاكرة الكوتش\n' + options.memorySection.trim());
      } else {
        const memoryRows = await this.db.select<{ category: string; content: string | null }>('memory', { limit: 20 });
        const parts: string[] = [];
        for (const row of memoryRows) {
          if (row.category && row.content && row.content.trim()) {
            parts.push(`${row.category}:\n${row.content.trim()}`);
          }
        }
        if (parts.length > 0) {
          sections.push('## ذاكرة الكوتش\n' + parts.join('\n\n'));
        }
      }

      // 1. REPORT PREVIEW — lightweight summary (4 queries only)
      const summary = await buildLightweightDailySummary(this.db, today);
      const formattedPreview = formatLightweightSummaryForContext(summary, today);
      sections.push('## تقرير اليوم (معاينة)\n' + formattedPreview);

      // 2 & 3 — One query for meta_coach interventions: last = first row, history = same rows in asc order
      const metaInterventionsDesc = await this.db.select('coaching_interactions', {
        filter: {
          chat_id: op.eq(chatId),
          interaction_date: op.eq(today),
          interaction_type: op.eq('meta_coach'),
        },
        order: 'timestamp.desc',
        limit: 20,
      });
      const lastInterventionTime = metaInterventionsDesc[0]?.timestamp as string | undefined;
      const allMeta = [...metaInterventionsDesc].reverse();

      const todayTasks = summary.doneTasks;

      const doneMain = summary.doneTasks.filter((t: any) => !t.origin_task).length;
      const failedMain = summary.failedTasks.filter((t: any) => !t.origin_task).length;
      const partialMain = summary.partialTasks.filter((t: any) => !t.origin_task).length;
      const reportStateLine = `حالة التقرير الحالية: ${doneMain} مكتملة، ${failedMain} فاشلة، ${partialMain} جزئية.`;

      let activityLines: string[] = [reportStateLine];
      if (lastInterventionTime) {
        const since = todayTasks.filter((t: any) => (t.completed_at as string) > lastInterventionTime);
        if (since.length > 0) {
          const names = since.map((t: any) => extractCleanTaskName(t.content)).join('، ');
          const totalMin = since.reduce((sum: number, t: any) => sum + (t.duration_minutes || 0), 0);
          activityLines.push(`مهام مكتملة منذ آخر تدخل: ${since.length} (${names.slice(0, 300)}${names.length > 300 ? '...' : ''})`);
          if (totalMin > 0) activityLines.push(`وقت مضاف: ${totalMin} دقيقة`);
        } else {
          activityLines.push('لا إنجاز جديد منذ آخر تدخل.');
        }
      } else {
        if (todayTasks.length > 0) {
          const names = todayTasks.map((t: any) => extractCleanTaskName(t.content)).join('، ');
          const totalMin = todayTasks.reduce((sum: number, t: any) => sum + (t.duration_minutes || 0), 0);
          activityLines.push(`مهام مكتملة اليوم: ${todayTasks.length} (${names.slice(0, 300)}${names.length > 300 ? '...' : ''})`);
          if (totalMin > 0) activityLines.push(`إجمالي الوقت: ${totalMin} دقيقة`);
        } else {
          activityLines.push('لا مهام مكتملة اليوم بعد.');
        }
      }

      const sessionMgr = createTaskSessionManager(this.db);
      const activeSession = await sessionMgr.getActiveSession(chatId);
      if (activeSession) {
        activityLines.push(`جلسة مهمة نشطة: ${extractCleanTaskName(activeSession.taskContent)} (${activeSession.totalTimeWorked} دقيقة)`);
      }

      sections.push('## سجل النشاط منذ آخر تدخل\n' + activityLines.join('\n'));

      // INTERVENTIONS HISTORY — from same meta_coach query above (allMeta)
      if (allMeta.length > 0) {
        const historyLines: string[] = [];
        for (const i of allMeta) {
          const r = i as any;
          const coachShort = (r.bot_response || '').replace(/\n/g, ' ').trim().slice(0, 120);
          const userPart = r.user_input ? `المستخدم: ${(r.user_input as string).slice(0, 150)}` : 'لم يرد المستخدم';
          historyLines.push(`الكوتش: ${coachShort}\n${userPart}`);
        }
        sections.push('## سجل تدخلات اليوم\n' + historyLines.join('\n---\n'));
      } else {
        sections.push('## سجل تدخلات اليوم\nلا تدخلات سابقة اليوم.');
      }

      // 4. INTERACTIVE SESSION — احكيلي: ended (coaching_interactions) + in-progress (conversation_state)
      const talkSessions = await this.db.select('coaching_interactions', {
        filter: {
          chat_id: op.eq(chatId),
          interaction_date: op.eq(today),
          interaction_type: op.eq('coach_talk'),
        },
        order: 'timestamp.desc',
        limit: 1,
      });

      const talkSessionKey = `talk_session_${chatId}`;
      const activeTalkRows = await this.db.select<{ data?: unknown }>('conversation_state', {
        filter: { chat_id: op.eq(talkSessionKey) },
        limit: 1,
      });

      const parseHistory = (raw: unknown): Array<{ role: string; content: string }> => {
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
          try {
            const parsed = JSON.parse(raw) as unknown;
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        }
        return [];
      };

      let scriptText = '';
      if (talkSessions.length > 0) {
        const row = talkSessions[0] as any;
        let meta = row?.metadata;
        if (typeof meta === 'string') {
          try {
            meta = JSON.parse(meta) as Record<string, unknown>;
          } catch {
            meta = null;
          }
        }
        const raw = meta?.script ?? meta;
        const script = parseHistory(raw);
        if (script.length > 0) {
          scriptText = script
            .map((m: { role: string; content: string }) => (m.role === 'user' ? `المستخدم: ${m.content}` : `الكوتش: ${m.content}`))
            .join('\n');
        }
      }
      if (!scriptText && activeTalkRows.length > 0) {
        const row = activeTalkRows[0];
        const data = row?.data;
        const dataObj = typeof data === 'string'
          ? (() => { try { return JSON.parse(data) as Record<string, unknown>; } catch { return null; } })()
          : (data as Record<string, unknown> | null);
        const history = parseHistory(dataObj?.history);
        if (history.length > 0) {
          scriptText = history
            .map((m: { role: string; content: string }) => (m.role === 'user' ? `المستخدم: ${m.content}` : `الكوتش: ${m.content}`))
            .join('\n');
          scriptText = `(جلسة جارية)\n${scriptText}`;
        }
      }
      if (scriptText) {
        sections.push('## جلسة احكيلي اليوم\n' + scriptText);
      } else {
        sections.push('## جلسة احكيلي اليوم\nلا توجد جلسة احكيلي مسجلة اليوم.');
      }

    } catch (e) {
      console.error('Error building intervention context:', e);
    }

    return sections.length > 0 ? sections.join('\n\n') : '';
  }

  /** @deprecated Use buildInterventionContext for interventions. Kept for generateConversationResponse / generateTalkResponse. Uses lightweight summary to avoid subrequest limit. */
  private async buildExtraContext(_chatId: string): Promise<string> {
    const today = getTodayInEgypt();
    try {
      const summary = await buildLightweightDailySummary(this.db, today);
      const doneMain = summary.doneTasks.filter((t: any) => !t.origin_task).length;
      const failedMain = summary.failedTasks.filter((t: any) => !t.origin_task).length;
      const total = doneMain + failedMain;
      const rate = total > 0 ? Math.round((doneMain / total) * 100) : 0;
      return `تقرير اليوم: ${doneMain} مكتملة، ${failedMain} فاشلة، نسبة النجاح ${rate}%`;
    } catch (e) {
      console.error('Error building extra context:', e);
      return '';
    }
  }

  private async logInteraction(
    chatId: string,
    type: string,
    message: string,
    escalationLevel?: number
  ): Promise<void> {
    const contextBuilder = createCoachingContextBuilder(this.db, this.settings);
    await contextBuilder.logInteraction({
      chat_id: chatId,
      interaction_date: getTodayInEgypt(),
      timestamp: new Date().toISOString(),
      interaction_type: 'meta_coach',
      bot_response: message.slice(0, 500),
      outcome: 'pending',
      metadata: { interventionType: type, escalationLevel },
    });
  }

  private async getHoursInactive(): Promise<number> {
    try {
      const tasks = await this.db.select('tasks', {
        filter: { status: op.eq('done') },
        order: 'completed_at.desc',
        limit: 1,
      });

      if (tasks.length === 0) {
        console.log('⏱️ Inactivity: no completed tasks found → 24h');
        return 24;
      }

      const lastCompletion = new Date(tasks[0]?.completed_at as string);
      const now = new Date();

      // Sleep-aware: exclude sleep period from inactivity count
      const sleepStartStr = await this.settings.get('coach.sleep_start') || '23:00';
      const sleepEndStr = await this.settings.get('coach.sleep_end') || '07:00';
      const sleepStartH = parseInt(sleepStartStr.split(':')[0] || '23', 10);
      const sleepEndH = parseInt(sleepEndStr.split(':')[0] || '7', 10);

      // Get current hour in Egypt
      const egyptNow = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
      const currentHour = egyptNow.getHours();

      // Get today's sleep_end as a Date in Egypt time
      const todayStr = getTodayInEgypt();
      const sleepEndToday = new Date(`${todayStr}T${sleepEndStr.padStart(5, '0')}:00+02:00`);

      // If last completion was before today's sleep_end, count from sleep_end instead
      // If last completion is in the future (bad data), also fall back to sleep_end
      const effectiveStart = (lastCompletion < sleepEndToday || lastCompletion > now)
        ? sleepEndToday
        : lastCompletion;

      // If we're currently in sleep period, return 0 (sleep time, not inactive)
      if (this.isInSleepPeriod(currentHour, sleepStartH, sleepEndH)) {
        console.log(`⏱️ Inactivity: in sleep period (hour=${currentHour}, sleep=${sleepStartH}-${sleepEndH}) → 0h`);
        return 0;
      }

      const hours = Math.max(0, (now.getTime() - effectiveStart.getTime()) / (1000 * 60 * 60));
      console.log(`⏱️ Inactivity: lastCompletion=${(tasks[0]?.completed_at as string)}, sleepEnd=${sleepEndStr}, effectiveStart=${effectiveStart.toISOString()}, now=${now.toISOString()}, hours=${hours.toFixed(2)}`);
      return hours;
    } catch (e) {
      console.error('⏱️ Inactivity error:', e);
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

  private async getInterventionsToday(chatId: string): Promise<number> {
    try {
      const today = getTodayInEgypt();
      const result = await this.db.select('coaching_interactions', {
        filter: {
          chat_id: op.eq(chatId),
          interaction_date: op.eq(today),
        },
      });
      return result.length;
    } catch {
      return 0;
    }
  }


  // ============================================
  // Interactive Conversation Methods
  // ============================================

  /**
   * Generate a conversational response when user replies to check-in
   * Goal: Motivate user to start a task
   */
  async generateConversationResponse(
    chatId: string,
    userMessage: string,
    conversationTurn: number,
    userMood?: 'high' | 'normal' | 'low'
  ): Promise<string> {
    const state = await this.analyzeUserState(chatId);
    const style = state.coachingStyle;
    const extraContext = await this.buildExtraContext(chatId);
    const currentTime = this.getCurrentEgyptTime();

    const moodContext = userMood
      ? `المستخدم حالته النفسية: ${userMood === 'high' ? 'طاقة عالية' : userMood === 'low' ? 'تعبان' : 'عادي'}`
      : '';

    const turnContext = conversationTurn === 1
      ? 'أول رد من المستخدم'
      : conversationTurn === 2
      ? 'ثاني رد - حاول تقنعه يبدأ شغل'
      : 'آخر رد - اقترح مهمة محددة وشجعه يبدأ';

    const prompt = `أنت كوتش إنتاجية ${style === 'confrontational' ? 'مواجه' : style === 'supportive' ? 'داعم' : 'متوازن'}.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

الوقت الحالي: ${currentTime}
${moodContext}
${turnContext}

رسالة المستخدم: "${userMessage}"

المهام المكتملة اليوم: ${state.tasksCompletedToday}
ساعات بدون إنجاز: ${state.hoursInactive.toFixed(1)}

${extraContext ? `--- سياق إضافي ---\n${extraContext}` : ''}

اكتب رد قصير (2-3 جمل):
- تفاعل مع كلامه
- حفزه يبدأ مهمة
- ${conversationTurn >= 2 ? 'اقترح يبدأ مهمة' : 'اسأله عن أول مهمة'}

خليها طبيعية ومحفزة.`;

    const response = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.9,
      200
    );

    return `💬 ${response.trim()}`;
  }

  /**
   * Generate response for an extended talk session (احكيلي button)
   * Supports multi-turn conversation with history
   */
  async generateTalkResponse(
    chatId: string,
    userMessage: string,
    conversationHistory: Array<{ role: 'user' | 'coach'; content: string }>,
    currentTurn: number,
    totalTurns: number,
    userMood?: 'high' | 'normal' | 'low'
  ): Promise<string> {
    const state = await this.analyzeUserState(chatId);
    const style = state.coachingStyle;
    const extraContext = await this.buildExtraContext(chatId);
    const currentTime = this.getCurrentEgyptTime();
    const dayPeriod = this.getDayPeriodContext(state.currentHour);

    const turnsLeft = totalTurns - currentTurn;
    const isWrappingUp = turnsLeft <= 2;

    // Build conversation history for AI
    const historyText = conversationHistory.length > 0
      ? conversationHistory.map(h =>
          h.role === 'user' ? `المستخدم: "${h.content}"` : `الكوتش: "${h.content}"`
        ).join('\n')
      : '';

    const moodText = userMood
      ? `حالة المستخدم: ${userMood === 'high' ? 'طاقة عالية' : userMood === 'low' ? 'تعبان/محبط' : 'عادي'}`
      : '';

    const phaseInstructions = isWrappingUp
      ? `أنت في آخر الجلسة. لازم:
- لخّص النقاط المهمة اللي اتكلمتوا فيها
- اقترح خطوة عملية واحدة يبدأ بيها دلوقتي
- شجعه يبدأ فوراً`
      : currentTurn <= 2
      ? `أنت في بداية الجلسة. لازم:
- ابني علاقة وثقة
- افهم إيه اللي مانعه يشتغل
- اسمع أكتر ما تتكلم`
      : `أنت في نص الجلسة. لازم:
- تفاعل مع اللي قاله
- ساعده يشوف المشكلة من زاوية تانية
- اقترح حلول عملية صغيرة`;

    const prompt = `أنت كوتش إنتاجية ${style === 'confrontational' ? 'مواجه بس محترم' : style === 'supportive' ? 'داعم وحنون' : 'متوازن'}.
أنت في جلسة محادثة مع المستخدم (الدور ${currentTurn} من ${totalTurns}).

⚠️ مهم جداً: الرد بالعامية المصرية فقط! كأنك صاحبه بتتكلم معاه.

الوقت: ${currentTime} - ${dayPeriod}
${moodText}

--- حالة اليوم ---
المهام المكتملة: ${state.tasksCompletedToday}
ساعات بدون إنجاز: ${state.hoursInactive.toFixed(1)}
${extraContext}

${historyText ? `--- المحادثة السابقة ---\n${historyText}` : ''}

--- الرسالة الحالية ---
المستخدم: "${userMessage}"

--- تعليمات ---
${phaseInstructions}

اكتب رد طبيعي (2-4 جمل). خليك إنسان مش روبوت. تفاعل مع مشاعره وكلامه.`;

    const response = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.85,
      250
    );

    return `💬 ${response.trim()}`;
  }

  /**
   * Generate opening message for a talk session
   */
  async generateTalkOpener(chatId: string, durationMinutes: number): Promise<string> {
    const state = await this.analyzeUserState(chatId);
    const style = state.coachingStyle;
    const currentTime = this.getCurrentEgyptTime();

    const prompt = `أنت كوتش إنتاجية ${style === 'confrontational' ? 'مواجه' : style === 'supportive' ? 'داعم' : 'متوازن'}.
المستخدم اختار يتكلم معاك ${durationMinutes} دقيقة.

⚠️ مهم جداً: الرد بالعامية المصرية فقط!

الوقت: ${currentTime}
المهام المكتملة اليوم: ${state.tasksCompletedToday}
ساعات بدون إنجاز: ${state.hoursInactive.toFixed(1)}

ابدأ محادثة ودية (2-3 جمل):
- رحب بيه
- اسأله عن حاله وإيه اللي شاغله
- خليها طبيعية كأنك صاحبه

ممنوع تذكر المدة أو عدد الرسائل.`;

    const response = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.9,
      150
    );

    return `💬 ${response.trim()}`;
  }

  /**
   * Generate response when user doesn't reply within window
   */
  async generateNoResponseFollowUp(chatId: string): Promise<string> {
    const state = await this.analyzeUserState(chatId);
    const style = state.coachingStyle;

    let message = '';
    if (style === 'confrontational') {
      message = '👀 طيب... مفيش رد. لما تكون جاهز، أنا هنا.';
    } else if (style === 'supportive') {
      message = '💙 مفيش مشكلة لو مشغول. فكرني لما تكون جاهز!';
    } else {
      message = '📌 تمام، لما تكون جاهز تبدأ، قولي.';
    }

    return message;
  }

  /**
   * Generate response when user takes action after check-in
   */
  async generateActionAcknowledgment(_chatId: string, action: string): Promise<string> {
    const actionMessages: Record<string, string> = {
      starttask: '🎯 كده الكلام! يلا بينا!',
      stuck: '🆘 تمام، هنحلها سوا!',
      roast: '😏 أوكي، جاي أحرقك!',
      battle: '⚔️ يلا نحارب!',
    };

    return actionMessages[action] || '👍 تمام!';
  }
}

// ============================================
// Factory Function
// ============================================

export function createMetaCoach(
  db: SupabaseClient,
  settings: SettingsManager,
  aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>,
  botToken?: string
): MetaCoach {
  return new MetaCoach(db, settings, aiCompleteFunc, botToken);
}
