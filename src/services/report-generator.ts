/**
 * Report Generator Service
 *
 * Handles daily report generation with Arabic formatting.
 * Collects tasks, streaks, goals, challenges, and memory for AI analysis.
 */

import { SupabaseClient, op } from '../database/client';
import { SettingsManager } from '../database/settings';
import { Task, Streak, DailyReport, WeeklyGoals, DailyChallenge, Memory } from '../types';

// ============================================
// Types
// ============================================

export interface ReportData {
  date: string; // YYYY-MM-DD
  tasks: Task[];
  streaks: Streak[];
  weeklyGoals: WeeklyGoals | null;
  dailyChallenge: DailyChallenge | null;
  memory: Record<string, string>;
  previousReports: DailyReport[];
  strategicGoals: string;
}

export interface ReportPreview {
  date: string;
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  success_rate: number;
  total_time_minutes: number;
  categories: Record<string, number>;
  top_categories: Array<{ name: string; count: number; time?: number }>;
  streak_updates: Array<{ task: string; current: number; best: number }>;
  challenge_status: string;
  formatted_text: string;
}

export interface ReportStatistics {
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  partial_tasks: number;
  success_rate: number;
  total_time_minutes: number;
  total_quantity: Record<string, number>; // unit -> total
  category_breakdown: Record<string, number>;
}

// ============================================
// Report Generator
// ============================================

export class ReportGenerator {
  constructor(
    private db: SupabaseClient,
    private settings: SettingsManager
  ) {}

  /**
   * Collect all data needed for report generation
   */
  async collectReportData(date?: string): Promise<ReportData> {
    const reportDate = date || this.getTodayDateString();

    // Collect tasks for the day
    const tasks = await this.getTasksForDate(reportDate);

    // Get streaks for all recurring tasks
    const streaks = await this.getStreaks();

    // Get current week's goals
    const weeklyGoals = await this.getCurrentWeekGoals(reportDate);

    // Get daily challenge
    const dailyChallenge = await this.getDailyChallenge(reportDate);

    // Get organized memory
    const memory = await this.getMemory();

    // Get previous week's reports for context
    const previousReports = await this.getPreviousReports(reportDate, 7);

    // Get strategic goals from settings
    const strategicGoals = await this.settings.get('strategic_goals') || '';

    return {
      date: reportDate,
      tasks,
      streaks,
      weeklyGoals,
      dailyChallenge,
      memory,
      previousReports,
      strategicGoals,
    };
  }

  /**
   * Generate report preview (without AI)
   */
  async generatePreview(date?: string): Promise<ReportPreview> {
    const data = await this.collectReportData(date);
    const stats = this.calculateStatistics(data.tasks);

    // Get task categories
    const categories = this.groupByCategory(data.tasks.filter(t => t.status === 'done'));

    // Get top 5 categories
    const topCategories = Object.entries(categories)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    // Get active streaks
    const activeStreaks = data.streaks
      .filter(s => s.current_streak > 0)
      .sort((a, b) => b.current_streak - a.current_streak)
      .slice(0, 10);

    const streakUpdates = activeStreaks.map(s => ({
      task: s.task_name,
      current: s.current_streak,
      best: s.best_streak,
    }));

    // Check challenge status
    const challengeStatus = data.dailyChallenge
      ? this.checkChallengeCompletion(data.dailyChallenge, data.tasks)
      : 'لا يوجد تحدي';

    // Format preview text
    const formattedText = this.formatPreviewText(data, stats, topCategories, challengeStatus);

    return {
      date: data.date,
      total_tasks: stats.total_tasks,
      completed_tasks: stats.completed_tasks,
      failed_tasks: stats.failed_tasks,
      success_rate: stats.success_rate,
      total_time_minutes: stats.total_time_minutes,
      categories,
      top_categories: topCategories,
      streak_updates: streakUpdates,
      challenge_status: challengeStatus,
      formatted_text: formattedText,
    };
  }

  /**
   * Calculate statistics from tasks
   */
  calculateStatistics(tasks: Task[]): ReportStatistics {
    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'done').length;
    const failed = tasks.filter(t => t.status === 'failed').length;
    const partial = tasks.filter(t => t.status === 'partial').length;

    const successRate = total > 0 ? (completed / total) * 100 : 0;

    const totalTime = tasks
      .filter(t => t.status === 'done')
      .reduce((sum, t) => sum + (t.duration_minutes || 0), 0);

    // Group quantities by unit
    const quantities: Record<string, number> = {};
    for (const task of tasks.filter(t => t.status === 'done' && t.quantity)) {
      const unit = task.quantity_unit || 'items';
      quantities[unit] = (quantities[unit] || 0) + (task.quantity || 0);
    }

    // Category breakdown
    const categoryBreakdown = this.groupByCategory(tasks.filter(t => t.status === 'done'));

    return {
      total_tasks: total,
      completed_tasks: completed,
      failed_tasks: failed,
      partial_tasks: partial,
      success_rate: successRate,
      total_time_minutes: totalTime,
      total_quantity: quantities,
      category_breakdown: categoryBreakdown,
    };
  }

  /**
   * Format Arabic date
   */
  formatArabicDate(date: Date): string {
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const months = [
      'يناير', 'فبراير', 'مارس', 'إبريل', 'مايو', 'يونيو',
      'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
    ];

    const dayName = days[date.getDay()];
    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();

    return `${dayName}، ${day} ${month} ${year}`;
  }

  /**
   * Format time in Arabic
   */
  formatArabicTime(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;

    const parts: string[] = [];

    if (hours > 0) {
      if (hours === 1) parts.push('ساعة');
      else if (hours === 2) parts.push('ساعتان');
      else if (hours <= 10) parts.push(`${hours} ساعات`);
      else parts.push(`${hours} ساعة`);
    }

    if (mins > 0) {
      if (mins === 1) parts.push('دقيقة');
      else if (mins === 2) parts.push('دقيقتان');
      else if (mins <= 10) parts.push(`${mins} دقائق`);
      else parts.push(`${mins} دقيقة`);
    }

    if (parts.length === 0) {
      return 'صفر دقيقة';
    }

    return parts.join(' و ');
  }

  /**
   * Generate summary of past week
   */
  generatePastWeekSummary(reports: DailyReport[]): string {
    if (reports.length === 0) {
      return 'لا توجد تقارير سابقة';
    }

    const avgSuccess = reports.reduce((sum, r) => sum + (r.success_rate || 0), 0) / reports.length;
    const totalTasks = reports.reduce((sum, r) => sum + (r.total_tasks || 0), 0);
    const completedTasks = reports.reduce((sum, r) => sum + (r.completed_tasks || 0), 0);
    const totalTime = reports.reduce((sum, r) => sum + (r.achievement_time_minutes || 0), 0);

    return `
خلال الأسبوع الماضي (${reports.length} أيام):
- معدل النجاح: ${avgSuccess.toFixed(1)}%
- إجمالي المهام: ${totalTasks}
- المنجزة: ${completedTasks}
- إجمالي الوقت: ${this.formatArabicTime(totalTime)}
`.trim();
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Get today's date as YYYY-MM-DD in Egypt timezone
   */
  private getTodayDateString(): string {
    const now = new Date();
    // Convert to Egypt timezone (GMT+2)
    const egyptDate = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
    return egyptDate.toISOString().split('T')[0]!;
  }

  /**
   * Get tasks for a specific date
   */
  private async getTasksForDate(date: string): Promise<Task[]> {
    const startOfDay = `${date}T00:00:00`;
    const endOfDay = `${date}T23:59:59`;

    // Note: Supabase REST API doesn't support gte/lte directly in our client
    // We'll get all tasks and filter in memory
    const allTasks = await this.db.select<Task>('tasks', {});

    return allTasks.filter(task => {
      const completedAt = new Date(task.completed_at);
      return (
        completedAt >= new Date(startOfDay) &&
        completedAt <= new Date(endOfDay)
      );
    });
  }

  /**
   * Get all streaks
   */
  private async getStreaks(): Promise<Streak[]> {
    return await this.db.select<Streak>('streaks', {});
  }

  /**
   * Get current week's goals
   */
  private async getCurrentWeekGoals(date: string): Promise<WeeklyGoals | null> {
    const allGoals = await this.db.select<WeeklyGoals>('weekly_goals', {});

    for (const goal of allGoals) {
      const weekStart = new Date(goal.week_start_date);
      const weekEnd = new Date(goal.week_end_date);
      const currentDate = new Date(date);

      if (currentDate >= weekStart && currentDate <= weekEnd) {
        return goal;
      }
    }

    return null;
  }

  /**
   * Get daily challenge for date
   */
  private async getDailyChallenge(date: string): Promise<DailyChallenge | null> {
    // FIX: Use op.eq() for the filter
    const challenges = await this.db.select<DailyChallenge>('daily_challenges', {
      filter: { challenge_date: op.eq(date) },
      limit: 1
    });

    return challenges.length > 0 ? (challenges[0] || null) : null;
  }

  /**
   * Get all memory
   */
  private async getMemory(): Promise<Record<string, string>> {
    const memories = await this.db.select<Memory>('memory', {});

    const result: Record<string, string> = {};
    for (const mem of memories) {
      result[mem.category] = mem.content || '';
    }

    return result;
  }

  /**
   * Get previous N reports
   */
  private async getPreviousReports(beforeDate: string, limit: number): Promise<DailyReport[]> {
    const allReports = await this.db.select<DailyReport>(
      'daily_reports',
      {
        order: 'report_date.desc',
        limit: limit + 5,
      }
    );

    const beforeDateObj = new Date(beforeDate);
    return allReports
      .filter(r => new Date(r.report_date) < beforeDateObj)
      .slice(0, limit);
  }

  /**
   * Group tasks by category
   */
  private groupByCategory(tasks: Task[]): Record<string, number> {
    const categories: Record<string, number> = {};

    for (const task of tasks) {
      const category = task.category || 'غير مصنف';
      categories[category] = (categories[category] || 0) + 1;
    }

    return categories;
  }

  /**
   * Check if daily challenge is completed
   */
  private checkChallengeCompletion(challenge: DailyChallenge, tasks: Task[]): string {
    // Simple heuristic: check if challenge text appears in any completed task
    const challengeText = challenge.challenge_text.toLowerCase();
    const completedTasks = tasks.filter(t => t.status === 'done');

    const firstWord = challengeText.split(' ')[0];
    const isCompleted = completedTasks.some(task =>
      firstWord && task.content.toLowerCase().includes(firstWord)
    );

    return isCompleted ? '✅ منجز' : '❌ غير منجز';
  }

  /**
   * Format preview text in Arabic
   */
  private formatPreviewText(
    data: ReportData,
    stats: ReportStatistics,
    topCategories: Array<{ name: string; count: number }>,
    challengeStatus: string
  ): string {
    const date = new Date(data.date);
    const arabicDate = this.formatArabicDate(date);

    let text = `📊 **معاينة التقرير اليومي**\n\n`;
    text += `📅 **التاريخ:** ${arabicDate}\n\n`;

    text += `📈 **الإحصائيات:**\n`;
    text += `- إجمالي المهام: ${stats.total_tasks}\n`;
    text += `- المنجزة: ${stats.completed_tasks}\n`;
    text += `- الفاشلة: ${stats.failed_tasks}\n`;
    text += `- معدل النجاح: ${stats.success_rate.toFixed(1)}%\n`;
    text += `- وقت الإنجاز: ${this.formatArabicTime(stats.total_time_minutes)}\n\n`;

    if (topCategories.length > 0) {
      text += `🏷️ **أهم الفئات:**\n`;
      topCategories.forEach(cat => {
        text += `- ${cat.name}: ${cat.count} مهام\n`;
      });
      text += '\n';
    }

    if (data.dailyChallenge) {
      text += `🎯 **التحدي اليومي:** ${challengeStatus}\n`;
      text += `"${data.dailyChallenge.challenge_text}"\n\n`;
    }

    if (data.weeklyGoals) {
      text += `🎯 **الأهداف الأسبوعية:**\n`;
      text += `${data.weeklyGoals.goals_text}\n\n`;
    }

    text += `\nهل تريد إكمال التحليل بالذكاء الاصطناعي؟\n`;
    text += `استخدم /confirm للمتابعة أو /cancel للإلغاء`;

    return text;
  }
}

// ============================================
// Factory Function
// ============================================

export function createReportGenerator(
  db: SupabaseClient,
  settings: SettingsManager
): ReportGenerator {
  return new ReportGenerator(db, settings);
}