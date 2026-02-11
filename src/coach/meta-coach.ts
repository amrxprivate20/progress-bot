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
import { getCoachCommandFooter } from '../utils/keyboards';

// ============================================
// Constants
// ============================================

const COMMAND_FOOTER = getCoachCommandFooter();

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
      filter: { failure_date: op.eq(today) },
      limit: 1,
    });
    const failuresJson = failedTasks[0]?.failures_json;
    const parsedFailures = typeof failuresJson === 'string' ? JSON.parse(failuresJson) : failuresJson;
    const tasksFailed = parsedFailures?.failed_tasks?.length || 0;

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
    // 4. Morning first check? → MORNING KICKOFF
    // ============================================
    if (
      state.currentHour >= sleepEndH &&
      state.currentHour < 10 &&
      !this.hadInterventionInHourRange(state.lastInterventionHour, sleepEndH, 10)
    ) {
      return {
        type: 'morning_kickoff',
        message: '',
        escalationLevel: 1,
        followUpDelay: 90,
      };
    }

    // ============================================
    // 5. Midday (12-14)? → MIDDAY PUSH
    // ============================================
    if (
      state.currentHour >= 12 &&
      state.currentHour < 14 &&
      !this.hadInterventionInHourRange(state.lastInterventionHour, 12, 14)
    ) {
      return {
        type: 'midday_push',
        message: '',
        escalationLevel: state.tasksCompletedToday < 3 ? 2 : 1,
        followUpDelay: 90,
      };
    }

    // ============================================
    // 6. Evening (18-20)? → EVENING CHECK
    // ============================================
    if (
      state.currentHour >= 18 &&
      state.currentHour < 20 &&
      !this.hadInterventionInHourRange(state.lastInterventionHour, 18, 20)
    ) {
      return {
        type: 'evening_check',
        message: '',
        escalationLevel: state.tasksCompletedToday < 5 ? 3 : 1,
        followUpDelay: 60,
      };
    }

    // ============================================
    // 7. Night wrap-up (21-22)? → NIGHT WRAPUP
    // ============================================
    if (
      state.currentHour >= 21 &&
      state.currentHour < sleepStartH &&
      !this.hadInterventionInHourRange(state.lastInterventionHour, 21, sleepStartH)
    ) {
      return {
        type: 'night_wrapup',
        message: '',
        escalationLevel: 1,
        followUpDelay: 120,
      };
    }

    // ============================================
    // 8. Battle active with high boss HP? → BATTLE NARRATIVE
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
    // 9. Inactive >= threshold? → INACTIVITY NUDGE
    // ============================================
    if (state.hoursInactive >= inactivityThreshold) {
      return {
        type: 'inactivity_nudge',
        message: '',
        escalationLevel,
        followUpDelay: 45,
      };
    }

    // ============================================
    // 10. Active but threshold passed since last check? → MOMENTUM CHECK
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
   * Execute the decided intervention
   */
  async executeIntervention(chatId: string, decision: InterventionDecision): Promise<string> {
    const state = await this.analyzeUserState(chatId);
    const style = state.coachingStyle;

    switch (decision.type) {
      case 'morning_kickoff':
        return this.generateMessage(chatId, 'morning_kickoff', style, state, decision.escalationLevel);

      case 'midday_push':
        return this.generateMessage(chatId, 'midday_push', style, state, decision.escalationLevel);

      case 'evening_check':
        return this.generateMessage(chatId, 'evening_check', style, state, decision.escalationLevel);

      case 'momentum_check':
        return this.generateMessage(chatId, 'momentum_check', style, state, decision.escalationLevel);

      case 'night_wrapup':
        return this.generateMessage(chatId, 'night_wrapup', style, state, decision.escalationLevel);

      case 'inactivity_nudge':
        return this.generateMessage(chatId, 'inactivity_nudge', style, state, decision.escalationLevel);

      case 'escalation':
        return this.generateMessage(chatId, 'escalation', style, state, decision.escalationLevel);

      case 'battle_narrative':
        return this.generateMessage(chatId, 'battle_narrative', style, state, decision.escalationLevel);

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

  private hadInterventionInHourRange(lastHour: number | null, startH: number, endH: number): boolean {
    if (lastHour === null) return false;
    return lastHour >= startH && lastHour < endH;
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

    // Get yesterday's tasks
    const yesterdayTasks = await this.getYesterdayTasksCount();

    // Get available tasks today
    const availableTasks = await this.getAvailableTasksCount();

    // Get boss info
    let bossName = 'لا يوجد';
    let bossHP = 0;
    if (state.currentBattleState) {
      bossName = state.currentBattleState.boss?.name || 'العدو';
      bossHP = Math.round(
        (state.currentBattleState.bossCurrentHP / state.currentBattleState.bossMaxHP) * 100
      );
    }

    // Replace placeholders
    const prompt = promptTemplate
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

    const message = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.9,
      150
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

    // Include command footer for all coach messages
    return `${emojis[type] || '📌'} ${message.trim()}${COMMAND_FOOTER}`;
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

  private async getYesterdayTasksCount(): Promise<number> {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const tasks = await this.db.select('tasks', {
        filter: { status: op.eq('done') },
      });

      return tasks.filter((t: any) => {
        const completedAt = t.completed_at?.split('T')[0];
        return completedAt === yesterdayStr;
      }).length;
    } catch {
      return 0;
    }
  }

  private async getAvailableTasksCount(): Promise<number> {
    try {
      // This would ideally fetch from Todoist, but for now return a placeholder
      return 10;
    } catch {
      return 0;
    }
  }

  private async getDeferralsToday(chatId: string): Promise<number> {
    try {
      const today = getTodayInEgypt();
      const logs = await this.db.select('intervention_logs', {
        filter: { chat_id: op.eq(chatId) },
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

      return Array.from(taskCounts.entries())
        .filter(([_, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([task]) => task);
    } catch {
      return [];
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

${moodContext}
${turnContext}

رسالة المستخدم: "${userMessage}"

المهام المكتملة اليوم: ${state.tasksCompletedToday}
ساعات بدون إنجاز: ${state.hoursInactive.toFixed(1)}

اكتب رد قصير (1-2 جمل):
- تفاعل مع كلامه
- حفزه يبدأ مهمة
- ${conversationTurn >= 2 ? 'اقترح يستخدم /starttask' : 'اسأله عن أول مهمة'}

خليها طبيعية ومحفزة.`;

    const response = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.9,
      100
    );

    // On last turn, add command suggestions
    if (conversationTurn >= 3) {
      return `💬 ${response.trim()}${COMMAND_FOOTER}`;
    }

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

    return `${message}${COMMAND_FOOTER}`;
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
  aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>
): MetaCoach {
  return new MetaCoach(db, settings, aiCompleteFunc);
}
