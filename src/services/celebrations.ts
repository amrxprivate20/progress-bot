/**
 * Celebrations Service - Micro-celebrations and Streaks
 *
 * Provides positive reinforcement through:
 * - Task completion celebrations based on duration/difficulty
 * - Streak tracking and announcements
 * - Personal records detection
 * - Points system
 */

import { SupabaseClient, op } from '../database/client';
import { getTodayInEgypt } from '../utils/timezone';

// ============================================
// Types
// ============================================

export interface UserStreak {
  chatId: string;
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: string;
  totalPoints: number;
  totalTasksCompleted: number;
  longestSessionMinutes: number;
  lastUpdated: string;
}

export interface CelebrationResult {
  message: string;
  streakUpdate: boolean;
  newRecord: boolean;
  pointsEarned: number;
}

// ============================================
// Celebration Messages
// ============================================

const SHORT_SESSION_CELEBRATIONS = [
  'خطوة صغيرة لقدام! 👣',
  'كل حاجة بتبدأ بخطوة! ✨',
  'بداية حلوة! 🌱',
];

const MEDIUM_SESSION_CELEBRATIONS = [
  'شغل جميل! 💪',
  'ماشي كويس أوي! 🔥',
  'إنتاجية عالية! ⚡',
  'كده الكلام! 🎯',
];

const LONG_SESSION_CELEBRATIONS = [
  'جلسة أسطورية! 🏆',
  'تركيز خرافي! 🧠',
  'إنت وحش! 💪🔥',
  'ده اللي يتقال عليه شغل! 🚀',
];

const STREAK_CELEBRATIONS: Record<number, string> = {
  3: '🔥 3 أيام متتالية! بداية قوية!',
  5: '🔥🔥 5 أيام! السلسلة بتكبر!',
  7: '🔥🔥🔥 أسبوع كامل! إنت بطل!',
  10: '🏆 10 أيام! ده إنجاز حقيقي!',
  14: '💪 أسبوعين! الاستمرارية مفتاح النجاح!',
  21: '🌟 21 يوم! العادة اتكونت!',
  30: '👑 شهر كامل! إنت ملك الاستمرارية!',
};

const RECORD_MESSAGES = {
  longestSession: '🏅 رقم قياسي جديد! أطول جلسة تركيز!',
  longestStreak: '🏆 رقم قياسي جديد! أطول سلسلة!',
  mostTasksInDay: '⚡ رقم قياسي جديد! أكتر مهام في يوم!',
};

// ============================================
// Celebrations Service Class
// ============================================

export class CelebrationsService {
  constructor(private db: SupabaseClient) {}

  /**
   * Generate celebration message for task completion
   */
  async celebrateCompletion(
    chatId: string,
    _taskName: string,
    durationMinutes: number,
    sessionCount: number = 1
  ): Promise<CelebrationResult> {
    const today = getTodayInEgypt();
    let message = '';
    let pointsEarned = 0;
    let newRecord = false;

    // Get or create user streak data
    let streak = await this.getOrCreateStreak(chatId);

    // Calculate points
    pointsEarned = this.calculatePoints(durationMinutes, sessionCount);

    // Choose celebration based on duration
    if (durationMinutes < 15) {
      message = this.getRandomMessage(SHORT_SESSION_CELEBRATIONS);
    } else if (durationMinutes < 45) {
      message = this.getRandomMessage(MEDIUM_SESSION_CELEBRATIONS);
    } else {
      message = this.getRandomMessage(LONG_SESSION_CELEBRATIONS);
    }

    // Check for personal record (longest session)
    if (durationMinutes > streak.longestSessionMinutes) {
      newRecord = true;
      streak.longestSessionMinutes = durationMinutes;
      message += `\n\n${RECORD_MESSAGES.longestSession}`;
    }

    // Update streak
    const streakUpdate = await this.updateStreak(chatId, streak, today, pointsEarned);

    // Add streak info if applicable
    if (streakUpdate && streak.currentStreak > 1) {
      const streakEmoji = '🔥'.repeat(Math.min(streak.currentStreak, 5));
      message += `\n\n${streakEmoji} سلسلة: ${streak.currentStreak} يوم`;

      // Check for milestone celebrations
      const milestone = STREAK_CELEBRATIONS[streak.currentStreak];
      if (milestone) {
        message = milestone + '\n\n' + message;
      }
    }

    // Add points
    message += `\n⭐ +${pointsEarned} نقطة`;

    return {
      message,
      streakUpdate,
      newRecord,
      pointsEarned,
    };
  }

  /**
   * Get streak info for display
   */
  async getStreakInfo(chatId: string): Promise<string> {
    const streak = await this.getOrCreateStreak(chatId);
    const today = getTodayInEgypt();

    // Check if streak is still active
    const isActive = this.isStreakActive(streak.lastActiveDate, today);
    const streakEmoji = isActive ? '🔥'.repeat(Math.min(streak.currentStreak, 5)) : '❄️';

    let message = `📊 **إحصائياتك:**\n\n`;
    message += `${streakEmoji} السلسلة الحالية: ${isActive ? streak.currentStreak : 0} يوم\n`;
    message += `🏆 أطول سلسلة: ${streak.longestStreak} يوم\n`;
    message += `⭐ النقاط: ${streak.totalPoints}\n`;
    message += `✅ إجمالي المهام: ${streak.totalTasksCompleted}\n`;
    message += `⏱️ أطول جلسة: ${streak.longestSessionMinutes} دقيقة\n`;

    if (!isActive && streak.currentStreak > 0) {
      message += `\n⚠️ السلسلة اتكسرت! ابدأ من جديد اليوم.`;
    }

    return message;
  }

  /**
   * Get quick streak summary for messages
   */
  async getQuickStreakSummary(chatId: string): Promise<string> {
    const streak = await this.getOrCreateStreak(chatId);
    const today = getTodayInEgypt();
    const isActive = this.isStreakActive(streak.lastActiveDate, today);

    if (!isActive || streak.currentStreak === 0) {
      return '';
    }

    const streakEmoji = '🔥'.repeat(Math.min(streak.currentStreak, 3));
    return `${streakEmoji} ${streak.currentStreak} يوم`;
  }

  // ============================================
  // Private Helper Methods
  // ============================================

  private async getOrCreateStreak(chatId: string): Promise<UserStreak> {
    try {
      const results = await this.db.select('user_streaks', {
        filter: { chat_id: op.eq(chatId) },
        limit: 1,
      });

      if (results.length > 0) {
        const r = results[0] as any;
        return {
          chatId: r.chat_id,
          currentStreak: r.current_streak || 0,
          longestStreak: r.longest_streak || 0,
          lastActiveDate: r.last_active_date || '',
          totalPoints: r.total_points || 0,
          totalTasksCompleted: r.total_tasks_completed || 0,
          longestSessionMinutes: r.longest_session_minutes || 0,
          lastUpdated: r.updated_at || '',
        };
      }

      // Create new streak record
      const newStreak: UserStreak = {
        chatId,
        currentStreak: 0,
        longestStreak: 0,
        lastActiveDate: '',
        totalPoints: 0,
        totalTasksCompleted: 0,
        longestSessionMinutes: 0,
        lastUpdated: new Date().toISOString(),
      };

      await this.db.insert('user_streaks', {
        chat_id: chatId,
        current_streak: 0,
        longest_streak: 0,
        last_active_date: '',
        total_points: 0,
        total_tasks_completed: 0,
        longest_session_minutes: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      return newStreak;
    } catch (error) {
      console.error('Error getting/creating streak:', error);
      return {
        chatId,
        currentStreak: 0,
        longestStreak: 0,
        lastActiveDate: '',
        totalPoints: 0,
        totalTasksCompleted: 0,
        longestSessionMinutes: 0,
        lastUpdated: '',
      };
    }
  }

  private async updateStreak(
    chatId: string,
    streak: UserStreak,
    today: string,
    pointsEarned: number
  ): Promise<boolean> {
    try {
      const yesterday = this.getYesterday(today);
      let streakUpdated = false;

      // Check streak continuity
      if (streak.lastActiveDate === today) {
        // Already active today, just update points and tasks
        streak.totalPoints += pointsEarned;
        streak.totalTasksCompleted += 1;
      } else if (streak.lastActiveDate === yesterday) {
        // Continuing streak from yesterday
        streak.currentStreak += 1;
        streak.totalPoints += pointsEarned;
        streak.totalTasksCompleted += 1;
        streakUpdated = true;

        // Check for longest streak record
        if (streak.currentStreak > streak.longestStreak) {
          streak.longestStreak = streak.currentStreak;
        }
      } else {
        // Streak broken, start new
        streak.currentStreak = 1;
        streak.totalPoints += pointsEarned;
        streak.totalTasksCompleted += 1;
        streakUpdated = true;
      }

      streak.lastActiveDate = today;
      streak.lastUpdated = new Date().toISOString();

      // Save to database
      await this.db.upsert('user_streaks', {
        chat_id: chatId,
        current_streak: streak.currentStreak,
        longest_streak: streak.longestStreak,
        last_active_date: streak.lastActiveDate,
        total_points: streak.totalPoints,
        total_tasks_completed: streak.totalTasksCompleted,
        longest_session_minutes: streak.longestSessionMinutes,
        updated_at: streak.lastUpdated,
      }, 'chat_id');

      return streakUpdated;
    } catch (error) {
      console.error('Error updating streak:', error);
      return false;
    }
  }

  private calculatePoints(durationMinutes: number, sessionCount: number): number {
    let points = 10; // Base points for completing a task

    // Duration bonus
    if (durationMinutes >= 15) points += 5;
    if (durationMinutes >= 30) points += 10;
    if (durationMinutes >= 60) points += 20;
    if (durationMinutes >= 120) points += 30;

    // Multi-session bonus (persistence)
    if (sessionCount > 1) {
      points += (sessionCount - 1) * 5;
    }

    return points;
  }

  private isStreakActive(lastActiveDate: string, today: string): boolean {
    if (!lastActiveDate) return false;
    if (lastActiveDate === today) return true;

    const yesterday = this.getYesterday(today);
    return lastActiveDate === yesterday;
  }

  private getYesterday(today: string): string {
    const date = new Date(today + 'T12:00:00Z');
    date.setDate(date.getDate() - 1);
    return date.toISOString().split('T')[0] || '';
  }

  private getRandomMessage(messages: string[]): string {
    const idx = Math.floor(Math.random() * messages.length);
    return messages[idx] || messages[0] || '';
  }
}

// ============================================
// Factory Function
// ============================================

export function createCelebrationsService(db: SupabaseClient): CelebrationsService {
  return new CelebrationsService(db);
}
