/**
 * Weekly Goals Manager Service
 *
 * Handles:
 * - Evaluating previous week's goals
 * - Generating new weekly goals using AI
 * - Extracting 7 daily challenges (Saturday-Friday)
 * - Storing goals and challenges in database
 */

import { SupabaseClient, op } from '../database/client';
import { SettingsManager } from '../database/settings';
import { WeeklyGoals, DailyChallenge, DailyReport } from '../types';
import { AIClient, AIMessage } from './ai-client';
import { getTodayInEgypt } from '../utils/timezone';

// ============================================
// Types
// ============================================

export interface GoalsGenerationResult {
  success: boolean;
  weeklyGoals?: WeeklyGoals;
  dailyChallenges?: DailyChallenge[];
  evaluationText?: string;
  error?: string;
}

export interface WeekDateRange {
  weekStartDate: string; // Saturday YYYY-MM-DD
  weekEndDate: string;   // Friday YYYY-MM-DD
}

// ============================================
// Goals Manager
// ============================================

export class GoalsManager {
  constructor(
    private db: SupabaseClient,
    private settings: SettingsManager,
    private aiClient: AIClient
  ) {}

  /**
   * Generate new weekly goals and daily challenges for CURRENT week
   * Challenges are generated for remaining days (from today to Friday)
   */
  async generateWeeklyGoals(): Promise<GoalsGenerationResult> {
    try {
      // Get the date range for current week (Saturday to Friday)
      const currentWeek = this.getCurrentWeekRange();

      // Check if goals already exist for current week - delete them to regenerate
      const existingGoals = await this.getGoalsForWeek(currentWeek.weekStartDate);
      if (existingGoals) {
        // Delete existing goals so we can regenerate
        await this.db.delete('weekly_goals', { week_start_date: op.eq(currentWeek.weekStartDate) });
      }

      // Get context for AI (use any previous week's goals for context)
      const previousWeek = this.getPreviousWeekRange();
      const previousGoals = await this.getGoalsForWeek(previousWeek.weekStartDate);
      const evaluationText = await this.evaluatePreviousWeek(previousGoals);

      // Get context for AI
      const context = await this.buildGoalsContext(previousGoals, evaluationText);

      // Generate new goals using AI
      const remainingDays = this.getRemainingDaysInWeek();
      const aiResponse = await this.generateGoalsWithAI(context, remainingDays);

      // Parse AI response - challenges start from TODAY, not Saturday
      const { goalsText, challenges } = this.parseGoalsResponseForCurrentWeek(aiResponse, remainingDays);

      // Save weekly goals
      const weeklyGoals = await this.saveWeeklyGoals({
        week_start_date: new Date(currentWeek.weekStartDate),
        week_end_date: new Date(currentWeek.weekEndDate),
        goals_text: goalsText,
        evaluation_text: evaluationText,
      });

      // Save daily challenges (for remaining days only)
      const savedChallenges = await this.saveDailyChallenges(challenges);

      return {
        success: true,
        weeklyGoals,
        dailyChallenges: savedChallenges,
        evaluationText,
      };
    } catch (error) {
      console.error('Error generating weekly goals:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get current week's goals (or next week's if current is empty)
   */
  async getCurrentWeekGoals(): Promise<WeeklyGoals | null> {
    // First try current week
    const currentWeek = this.getCurrentWeekRange();
    const currentGoals = await this.getGoalsForWeek(currentWeek.weekStartDate);

    if (currentGoals) {
      return currentGoals;
    }

    // If no current week goals, try next week (in case goals were just generated)
    const nextWeek = this.getNextWeekRange();
    return this.getGoalsForWeek(nextWeek.weekStartDate);
  }

  /**
   * Get today's challenge
   */
  async getTodayChallenge(): Promise<DailyChallenge | null> {
    const today = getTodayInEgypt();
    const challenges = await this.db.select<DailyChallenge>('daily_challenges', {
      filter: { challenge_date: op.eq(today) },
      limit: 1,
    });
    return challenges.length > 0 ? (challenges[0] || null) : null;
  }

  /**
   * Update challenge result
   */
  async updateChallengeResult(date: string, result: boolean): Promise<void> {
    await this.db.update(
      'daily_challenges',
      { challenge_date: op.eq(date) },
      { result }
    );
  }

  /**
   * Get formatted goals summary for Telegram
   */
  async getFormattedGoalsSummary(): Promise<string> {
    const goals = await this.getCurrentWeekGoals();
    const currentWeek = this.getCurrentWeekRange();
    const today = getTodayInEgypt();

    // Get ALL challenges for current week
    const weekChallenges = await this.getWeekChallenges(currentWeek.weekStartDate, currentWeek.weekEndDate);

    let summary = '🎯 الأهداف الأسبوعية\n';
    summary += `📅 ${currentWeek.weekStartDate} → ${currentWeek.weekEndDate}\n`;
    summary += `ـــــــــــــــــــــــ\n\n`;

    if (goals) {
      summary += goals.goals_text + '\n\n';
    } else {
      summary += 'لا توجد أهداف محددة لهذا الأسبوع.\nاستخدم /generategoals لتوليد أهداف جديدة.\n\n';
    }

    // Show ALL daily challenges for the week
    summary += `ـــــــــــــــــــــــ\n`;
    summary += `⚡ التحديات اليومية:\n\n`;

    if (weekChallenges.length > 0) {
      const arabicDays: Record<number, string> = {
        0: 'الأحد', 1: 'الإثنين', 2: 'الثلاثاء',
        3: 'الأربعاء', 4: 'الخميس', 5: 'الجمعة', 6: 'السبت'
      };

      for (const challenge of weekChallenges) {
        const dateStr = typeof challenge.challenge_date === 'string'
          ? challenge.challenge_date
          : new Date(challenge.challenge_date).toISOString().split('T')[0];

        const date = new Date(dateStr + 'T12:00:00Z');
        const dayName = arabicDays[date.getDay()] || '';
        const isToday = dateStr === today;

        // Status emoji
        const status = challenge.result === true ? '✅' :
                       challenge.result === false ? '❌' : '⏳';

        // Highlight today
        const todayMarker = isToday ? ' ← اليوم' : '';

        summary += `${status} ${dayName} (${dateStr})${todayMarker}\n`;
        summary += `   "${challenge.challenge_text}"\n\n`;
      }

      // Add weekly progress summary
      const completed = weekChallenges.filter(c => c.result === true).length;
      const failed = weekChallenges.filter(c => c.result === false).length;
      const pending = weekChallenges.filter(c => c.result === undefined || c.result === null).length;

      summary += `ـــــــــــــــــــــــ\n`;
      summary += `📊 **ملخص الأسبوع:**\n`;
      summary += `✅ مكتمل: ${completed}\n`;
      summary += `❌ فاشل: ${failed}\n`;
      summary += `⏳ قيد الانتظار: ${pending}\n`;

      if (completed > 0 || failed > 0) {
        const rate = Math.round((completed / (completed + failed)) * 100);
        summary += `📈 نسبة النجاح: ${rate}%\n`;
      }
    } else {
      summary += 'لا توجد تحديات لهذا الأسبوع';
    }

    return summary;
  }

  /**
   * Update weekly goals text
   */
  async updateWeeklyGoals(weekStartDate: string, newGoalsText: string): Promise<boolean> {
    try {
      await this.db.update(
        'weekly_goals',
        { week_start_date: op.eq(weekStartDate) },
        { goals_text: newGoalsText }
      );
      return true;
    } catch (error) {
      console.error('Error updating weekly goals:', error);
      return false;
    }
  }

  /**
   * Update a single challenge
   */
  async updateChallenge(date: string, newText: string): Promise<boolean> {
    try {
      await this.db.update(
        'daily_challenges',
        { challenge_date: op.eq(date) },
        { challenge_text: newText }
      );
      return true;
    } catch (error) {
      console.error('Error updating challenge:', error);
      return false;
    }
  }

  /**
   * Get all challenges for a week
   */
  async getWeekChallenges(startDate: string, endDate: string): Promise<DailyChallenge[]> {
    const allChallenges = await this.db.select<DailyChallenge>('daily_challenges', {
      order: 'challenge_date',
    });

    return allChallenges.filter(c => {
      const dateStr = typeof c.challenge_date === 'string'
        ? c.challenge_date
        : new Date(c.challenge_date).toISOString().split('T')[0];
      return dateStr && dateStr >= startDate && dateStr <= endDate;
    });
  }

  // ============================================
  // Public Helper Methods
  // ============================================

  /**
   * Get current week range (Saturday to Friday)
   */
  getCurrentWeekRange(): WeekDateRange {
    const today = new Date(getTodayInEgypt());
    const dayOfWeek = today.getDay(); // 0 = Sunday, 6 = Saturday

    // Calculate days since last Saturday
    // If today is Saturday (6), days since Saturday = 0
    // If today is Sunday (0), days since Saturday = 1
    // etc.
    const daysSinceSaturday = dayOfWeek === 6 ? 0 : (dayOfWeek + 1);

    const weekStartDate = new Date(today);
    weekStartDate.setDate(today.getDate() - daysSinceSaturday);

    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekStartDate.getDate() + 6);

    return {
      weekStartDate: this.formatDate(weekStartDate),
      weekEndDate: this.formatDate(weekEndDate),
    };
  }

  /**
   * Get next week range (Saturday to Friday)
   */
  private getNextWeekRange(): WeekDateRange {
    const current = this.getCurrentWeekRange();
    const nextStart = new Date(current.weekStartDate);
    nextStart.setDate(nextStart.getDate() + 7);

    const nextEnd = new Date(nextStart);
    nextEnd.setDate(nextStart.getDate() + 6);

    return {
      weekStartDate: this.formatDate(nextStart),
      weekEndDate: this.formatDate(nextEnd),
    };
  }

  /**
   * Get previous week range (Saturday to Friday)
   */
  private getPreviousWeekRange(): WeekDateRange {
    const current = this.getCurrentWeekRange();
    const prevStart = new Date(current.weekStartDate);
    prevStart.setDate(prevStart.getDate() - 7);

    const prevEnd = new Date(prevStart);
    prevEnd.setDate(prevStart.getDate() + 6);

    return {
      weekStartDate: this.formatDate(prevStart),
      weekEndDate: this.formatDate(prevEnd),
    };
  }

  /**
   * Get remaining days in current week (from today to Friday)
   */
  private getRemainingDaysInWeek(): Array<{ date: string; dayName: string }> {
    const arabicDays = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    const today = new Date(getTodayInEgypt());
    const dayOfWeek = today.getDay(); // 0 = Sunday, 6 = Saturday

    // Calculate days until Friday (end of week)
    const daysUntilFriday = dayOfWeek === 6 ? 6 : (5 - dayOfWeek + 7) % 7;

    const remainingDays: Array<{ date: string; dayName: string }> = [];

    for (let i = 0; i <= daysUntilFriday; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);

      const dateStr = this.formatDate(date);
      const dayName = arabicDays[date.getDay()] || '';

      remainingDays.push({ date: dateStr, dayName });
    }

    return remainingDays;
  }

  /**
   * Format date as YYYY-MM-DD
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0] || '';
  }

  /**
   * Get goals for a specific week
   */
  private async getGoalsForWeek(weekStartDate: string): Promise<WeeklyGoals | null> {
    const goals = await this.db.select<WeeklyGoals>('weekly_goals', {
      filter: { week_start_date: op.eq(weekStartDate) },
      limit: 1,
    });
    return goals.length > 0 ? (goals[0] || null) : null;
  }

  /**
   * Evaluate previous week's goals performance
   */
  private async evaluatePreviousWeek(previousGoals: WeeklyGoals | null): Promise<string> {
    if (!previousGoals) {
      return 'لا توجد أهداف سابقة للتقييم';
    }

    // Get last 7 daily reports
    const reports = await this.db.select<DailyReport>('daily_reports', {
      order: 'report_date.desc',
      limit: 7,
    });

    // Calculate overall statistics
    const totalTasks = reports.reduce((sum, r) => sum + (r.total_tasks || 0), 0);
    const completedTasks = reports.reduce((sum, r) => sum + (r.completed_tasks || 0), 0);
    const avgSuccessRate = reports.length > 0
      ? reports.reduce((sum, r) => sum + (r.success_rate || 0), 0) / reports.length
      : 0;

    // Build evaluation text
    let evaluation = `📊 تقييم الأسبوع الماضي:\n`;
    evaluation += `- إجمالي المهام: ${totalTasks}\n`;
    evaluation += `- المنجزة: ${completedTasks}\n`;
    evaluation += `- معدل النجاح: ${avgSuccessRate.toFixed(1)}%\n`;

    // Get challenge completion rate
    const currentWeek = this.getCurrentWeekRange();
    const challenges = await this.db.select<DailyChallenge>('daily_challenges', {});
    const weekChallenges = challenges.filter(c => {
      const date = typeof c.challenge_date === 'string'
        ? c.challenge_date
        : new Date(c.challenge_date).toISOString().split('T')[0] || '';
      return date && date >= currentWeek.weekStartDate && date <= currentWeek.weekEndDate;
    });

    const completedChallenges = weekChallenges.filter(c => c.result === true).length;
    evaluation += `- التحديات المنجزة: ${completedChallenges}/${weekChallenges.length}\n`;

    return evaluation;
  }

  /**
   * Build context for AI goals generation
   */
  private async buildGoalsContext(
    previousGoals: WeeklyGoals | null,
    evaluationText: string
  ): Promise<string> {
    // Get strategic goals
    const strategicGoals = await this.settings.get('strategic_goals') || '';

    // Get memory for patterns
    const memories = await this.db.select('memory', {});
    const memoryContext = memories
      .map((m: any) => `${m.category}: ${m.content || 'فارغ'}`)
      .join('\n');

    return `
## الأهداف الاستراتيجية طويلة المدى:
${strategicGoals || 'لا توجد أهداف استراتيجية محددة'}

## أهداف الأسبوع السابق:
${previousGoals?.goals_text || 'لا توجد أهداف سابقة'}

## تقييم الأسبوع السابق:
${evaluationText}

## الذاكرة والأنماط المعروفة:
${memoryContext}
`;
  }

  /**
   * Generate goals using AI
   */
  private async generateGoalsWithAI(
    context: string,
    remainingDays?: Array<{ date: string; dayName: string }>
  ): Promise<string> {
    // Build the days list for challenges
    let daysSection = '';
    if (remainingDays && remainingDays.length > 0) {
      daysSection = remainingDays.map(d => `${d.dayName} (${d.date}): [تحدي ${d.dayName}]`).join('\n');
    } else {
      daysSection = `يوم السبت: [تحدي السبت]
يوم الأحد: [تحدي الأحد]
يوم الإثنين: [تحدي الإثنين]
يوم الثلاثاء: [تحدي الثلاثاء]
يوم الأربعاء: [تحدي الأربعاء]
يوم الخميس: [تحدي الخميس]
يوم الجمعة: [تحدي الجمعة]`;
    }

    const numDays = remainingDays?.length || 7;

    const prompt = `
# توليد أهداف أسبوعية جديدة

${context}

---

# المطلوب:

قم بإنشاء أهداف أسبوعية جديدة وتحديات يومية. اتبع هذا الهيكل بدقة:

## [WEEKLY_GOALS]
(اكتب 5-7 أهداف أسبوعية واضحة وقابلة للقياس. كل هدف في سطر منفصل يبدأ بـ "-")
- [الهدف الأول]
- [الهدف الثاني]
...

## [DAILY_CHALLENGES]
(اكتب ${numDays} تحديات يومية، واحد لكل يوم من الأيام التالية. كل تحدي في سطر منفصل)

${daysSection}

## [MOTIVATION]
(كلمة تحفيزية قصيرة للأسبوع - جملتين كحد أقصى)

---

ملاحظات:
- الأهداف يجب أن تكون محددة وقابلة للقياس
- التحديات يجب أن تكون بسيطة ويمكن إنجازها في يوم واحد
- راعي التوازن بين العمل والراحة
- استفد من الأنماط المعروفة في الذاكرة
`;

    const messages: AIMessage[] = [
      {
        role: 'system',
        content: 'أنت خبير في التخطيط الأسبوعي والأهداف الشخصية. تكتب باللغة العربية الفصحى البسيطة.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    return await this.aiClient.complete(messages, 0.7, 2000);
  }

  /**
   * Parse AI response for current week (challenges for remaining days only)
   */
  private parseGoalsResponseForCurrentWeek(
    response: string,
    remainingDays: Array<{ date: string; dayName: string }>
  ): { goalsText: string; challenges: DailyChallenge[] } {
    // Extract weekly goals
    let goalsText = '';
    const goalsMatch = response.match(/\[WEEKLY_GOALS\]([\s\S]*?)(?:\[|$)/i);
    if (goalsMatch && goalsMatch[1]) {
      goalsText = goalsMatch[1].trim();
    }

    // Add motivation if found
    const motivationMatch = response.match(/\[MOTIVATION\]([\s\S]*?)(?:\[|$)/i);
    if (motivationMatch && motivationMatch[1]) {
      goalsText += '\n\n💪 ' + motivationMatch[1].trim();
    }

    // Extract daily challenges based on remaining days
    const challenges: DailyChallenge[] = [];
    const challengesMatch = response.match(/\[DAILY_CHALLENGES\]([\s\S]*?)(?:\[|$)/i);

    if (challengesMatch && challengesMatch[1]) {
      const challengesText = challengesMatch[1];

      // Build patterns for each remaining day
      for (const day of remainingDays) {
        // Try to match by day name (with or without "يوم")
        const patterns = [
          new RegExp(`يوم\\s*${day.dayName}[^:]*:[\\s]*(.+)`, 'i'),
          new RegExp(`${day.dayName}[^:]*:[\\s]*(.+)`, 'i'),
          new RegExp(`${day.date}[^:]*:[\\s]*(.+)`, 'i'),
        ];

        let challengeText = '';
        for (const pattern of patterns) {
          const match = challengesText.match(pattern);
          if (match && match[1]) {
            challengeText = match[1].trim();
            // Clean up the text - remove any trailing patterns
            challengeText = challengeText.split('\n')[0] || challengeText;
            break;
          }
        }

        if (challengeText) {
          challenges.push({
            challenge_date: new Date(day.date),
            challenge_text: challengeText,
            result: undefined,
          });
        }
      }
    }

    return { goalsText, challenges };
  }

  /**
   * Save weekly goals to database
   */
  private async saveWeeklyGoals(goals: Omit<WeeklyGoals, 'id' | 'created_at'>): Promise<WeeklyGoals> {
    const inserted = await this.db.insert<WeeklyGoals>('weekly_goals', {
      week_start_date: this.formatDate(goals.week_start_date as unknown as Date),
      week_end_date: this.formatDate(goals.week_end_date as unknown as Date),
      goals_text: goals.goals_text,
      evaluation_text: goals.evaluation_text,
    });

    if (!inserted[0]) {
      throw new Error('Failed to save weekly goals');
    }

    return inserted[0];
  }

  /**
   * Save daily challenges to database
   */
  private async saveDailyChallenges(challenges: DailyChallenge[]): Promise<DailyChallenge[]> {
    const saved: DailyChallenge[] = [];

    for (const challenge of challenges) {
      try {
        const challengeDate = challenge.challenge_date instanceof Date
          ? this.formatDate(challenge.challenge_date)
          : challenge.challenge_date;

        // Upsert to handle existing challenges
        const inserted = await this.db.upsert<DailyChallenge>(
          'daily_challenges',
          {
            challenge_date: challengeDate,
            challenge_text: challenge.challenge_text,
            result: null,
          },
          'challenge_date'
        );

        if (inserted[0]) {
          saved.push(inserted[0]);
        }
      } catch (error) {
        console.error('Error saving challenge:', error);
      }
    }

    return saved;
  }
}

// ============================================
// Factory Function
// ============================================

export function createGoalsManager(
  db: SupabaseClient,
  settings: SettingsManager,
  aiClient: AIClient
): GoalsManager {
  return new GoalsManager(db, settings, aiClient);
}
