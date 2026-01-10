/**
 * Report Generator Service - FIXED VERSION
 *
 * FIXES APPLIED:
 * - Egypt timezone (UTC+2) for all date operations
 * - Task breakdown in preview (✅/⚠️/❌ with subtasks)
 * - Arabic formatting with proper plural rules
 * - Hierarchy-aware task grouping
 */

import { SupabaseClient, op } from '../database/client';
import { SettingsManager } from '../database/settings';
import { Task, Streak, DailyReport, WeeklyGoals, DailyChallenge, Memory } from '../types';
import { 
  getTodayInEgypt, 
  getEgyptDayBoundaries, 
  formatArabicTime, 
  formatArabicStreak, 
  formatArabicDate 
} from '../utils/timezone';

// ============================================
// Types
// ============================================

export interface ReportData {
  date: string; // YYYY-MM-DD (Egypt date)
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
  total_quantity: Record<string, number>;
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

    // Collect tasks for the day (using Egypt timezone)
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

    // FIXED: Format preview text with full task breakdown
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
- إجمالي الوقت: ${formatArabicTime(totalTime)}
`.trim();
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * FIXED: Get today's date as YYYY-MM-DD in Egypt timezone
   */
  private getTodayDateString(): string {
    return getTodayInEgypt();
  }

  /**
   * FIXED: Get tasks for a specific date using Egypt timezone boundaries
   */
  private async getTasksForDate(date: string): Promise<Task[]> {
    const { start, end } = getEgyptDayBoundaries(date);
    
    console.log(`📅 Fetching tasks for Egypt date ${date}:`);
    console.log(`   UTC start: ${start.toISOString()}`);
    console.log(`   UTC end: ${end.toISOString()}`);

    // Get all tasks
    const allTasks = await this.db.select<Task>('tasks', {});

    // Filter by Egypt day boundaries
    const tasksInRange = allTasks.filter(task => {
      const completedAt = new Date(task.completed_at);
      return completedAt >= start && completedAt <= end;
    });

    console.log(`   Found ${tasksInRange.length} tasks`);

    return tasksInRange;
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
 * UPDATED: Format preview text with detailed Arabic formatting
 * Matches the desired output format with categories, hierarchies, and streaks
 */
private formatPreviewText(
  data: ReportData,
  stats: ReportStatistics,
  _topCategories: Array<{ name: string; count: number }>,
  challengeStatus: string
): string {
  const date = new Date(data.date);
  const arabicDate = formatArabicDate(date);

  let text = `# 📝 تقرير الإنجاز اليومي - ${data.date}\n\n`;
  text += `تقرير الإنجاز اليومي\n`;
  text += `${arabicDate}\n\n`;

  // Rating based on success rate
  const rating = this.getPerformanceRating(stats.success_rate);
  text += `التقدير: ${rating}\n`;
  text += `معدل النجاح: ${stats.success_rate.toFixed(1)} %\n\n`;

  text += `وقت الإنجاز اليوم: ${formatArabicTime(stats.total_time_minutes)}\n\n`;

  text += `عدد مهام اليوم: ${stats.total_tasks}\n\n`;

  // Completed tasks by category
  if (stats.completed_tasks > 0) {
    const completedByCategory = this.groupTasksByCategory(
      data.tasks.filter(t => t.status === 'done')
    );
    
    text += `عدد المهام المكتملة اليوم: ${stats.completed_tasks}\n`;
    for (const [category, info] of Object.entries(completedByCategory)) {
      const emoji = this.getCategoryEmoji(category);
      const timeStr = info.time > 0 ? ` - ${formatArabicTime(info.time)}` : '';
      text += `${category}${emoji} ${info.count} ${this.getTaskWord(info.count)}${timeStr}\n`;
    }
    text += '\n';
  }

  // Partial tasks by category
  if (stats.partial_tasks > 0) {
    const partialByCategory = this.groupTasksByCategory(
      data.tasks.filter(t => t.status === 'partial')
    );
    
    text += `عدد المهام المكتملة جزئيا اليوم: ${stats.partial_tasks}\n`;
    for (const [category, info] of Object.entries(partialByCategory)) {
      const emoji = this.getCategoryEmoji(category);
      const timeStr = info.time > 0 ? ` - ${formatArabicTime(info.time)}` : '';
      text += `${category}${emoji} ${info.count} ${this.getTaskWord(info.count)}${timeStr}\n`;
    }
    text += '\n';
  }

  // Failed tasks
  if (stats.failed_tasks > 0) {
    text += `عدد المهام المتروكة اليوم: ${stats.failed_tasks}\n\n`;
  }

  // Achievements section
  text += `ـــــــــــــــــــــــــــــــــــــــــــــــــــ\n`;
  text += `🎯 الإنجاز:\n`;
  text += `ـــــــــــــــــــــــ\n`;
  text += this.formatTasksWithHierarchy(
    data.tasks.filter(t => t.status === 'done'),
    data.streaks,
    '✅'
  );

  // Partial tasks section
  if (stats.partial_tasks > 0) {
    text += `⚠️ مكتملة جزئيا:\n`;
    text += `ـــــــــــــــــــــــ\n`;
    text += this.formatTasksWithHierarchy(
      data.tasks.filter(t => t.status === 'partial'),
      data.streaks,
      '⚠️'
    );
  }

  // Losses section
  if (stats.failed_tasks > 0) {
    text += `ـــــــــــــــــــــــــــــــــــــــــــــــــــ\n`;
    text += `🏳 خسائر:\n`;
    text += `ـــــــــــــــــــــــ\n`;
    text += this.formatTasksWithHierarchy(
      data.tasks.filter(t => t.status === 'failed'),
      data.streaks,
      '❌'
    );
  }

  // Challenge
  if (data.dailyChallenge) {
    text += `\n🎯 **التحدي اليومي:** ${challengeStatus}\n`;
    text += `"${data.dailyChallenge.challenge_text}"\n\n`;
  }

  // Weekly goals
  if (data.weeklyGoals) {
    text += `🎯 **الأهداف الأسبوعية:**\n`;
    text += `${data.weeklyGoals.goals_text}\n\n`;
  }

  text += `\nهل تريد إكمال التحليل بالذكاء الاصطناعي؟\n`;
  text += `استخدم /confirm للمتابعة أو /cancel للإلغاء`;

  return text;
}

/**
 * Format tasks with full hierarchy (parent + subtasks)
 */
private formatTasksWithHierarchy(
  tasks: Task[],
  streaks: Streak[],
  mainSymbol: string
): string {
  if (tasks.length === 0) return '';

  let output = '';
  
  // Separate main tasks and subtasks
  const mainTasks = tasks.filter(t => !t.origin_task);
  const subtasksByParent = new Map<string, Task[]>();
  
  // Group subtasks by parent task_id
  tasks.filter(t => t.origin_task).forEach(subtask => {
    if (!subtask.origin_task) return;
    if (!subtasksByParent.has(subtask.origin_task)) {
      subtasksByParent.set(subtask.origin_task, []);
    }
    subtasksByParent.get(subtask.origin_task)!.push(subtask);
  });

  for (const task of mainTasks) {
    // Main task line
    output += `${mainSymbol} ${task.content}`;
    
    // Add streak info if exists
    const streak = streaks.find(s => s.task_name === task.content);
    if (streak && streak.current_streak > 1) {
      // Show streak start date if available
      if (streak.last_completed_date) {
        const streakStartDate = this.calculateStreakStartDate(
          streak.last_completed_date?.toString() || '',
          streak.current_streak
        );
        output += ` -  منذ ${streakStartDate}`;
      }
      output += ` [${formatArabicStreak(streak.current_streak)} بدون إنقطاع]`;
    }
    
    // Add duration if exists
    if (task.duration_minutes && task.duration_minutes > 0) {
      output += ` [${formatArabicTime(task.duration_minutes)}]`;
    }
    
    // Add quantity if exists
    if (task.quantity) {
      output += ` [${task.quantity} ${task.quantity_unit || ''}]`;
    }
    
    output += '\n';
    
    // Add subtasks
    const subtasks = subtasksByParent.get(task.task_id) || [];
    for (const subtask of subtasks) {
      const subSymbol = subtask.status === 'done' ? '✓' : '✕';
      output += `${subSymbol} ${subtask.content}`;
      
      if (subtask.duration_minutes && subtask.duration_minutes > 0) {
        output += ` [${formatArabicTime(subtask.duration_minutes)}]`;
      }
      
      if (subtask.quantity) {
        output += ` [${subtask.quantity} ${subtask.quantity_unit || ''}]`;
      }
      
      output += '\n';
    }
    
    // Add spacing between main tasks
    output += ' \n';
  }

  return output;
}

/**
 * Group tasks by category with counts and time
 */
private groupTasksByCategory(tasks: Task[]): Record<string, { count: number; time: number }> {
  const grouped: Record<string, { count: number; time: number }> = {};

  for (const task of tasks) {
    const category = task.category || 'غير_مصنف';
    
    if (!grouped[category]) {
      grouped[category] = { count: 0, time: 0 };
    }
    
    grouped[category].count++;
    grouped[category].time += task.duration_minutes || 0;
  }

  return grouped;
}

/**
 * Get emoji for category
 */
private getCategoryEmoji(category: string): string {
  const emojiMap: Record<string, string> = {
    'religion': '🕋',
    'الدين': '🕋',
    'self_care': '🫶🏻',
    'العناية_بالذات': '🫶🏻',
    'recovery': '🏞️',
    'التعافي': '🏞️',
    'work': '💼',
    'العمل': '💼',
    'health': '🏃',
    'الصحة': '🏃',
    'learning': '📚',
    'التعلم': '📚',
  };
  
  return emojiMap[category] || '';
}

/**
 * Get correct Arabic word for task count
 */
private getTaskWord(count: number): string {
  if (count === 1) return 'مهمة';
  if (count === 2) return 'مهمتان';
  if (count >= 3 && count <= 10) return 'مهمات';
  return 'مهمة';
}

/**
 * Get performance rating based on success rate
 */
private getPerformanceRating(successRate: number): string {
  if (successRate >= 90) return '(م) ممتاز';
  if (successRate >= 75) return '(ج) جيد جدا';
  if (successRate >= 60) return '(ج) جيد';
  if (successRate >= 50) return '(م) مقبول';
  return '(ض) ضعيف';
}

/**
 * Calculate streak start date from last completed date and streak count
 */
private calculateStreakStartDate(lastCompletedDate: string, streakCount: number): string {
  const lastDate = new Date(lastCompletedDate + 'T00:00:00Z');
  const startDate = new Date(lastDate);
  startDate.setDate(startDate.getDate() - (streakCount - 1));
  
  const day = startDate.getDate();
  const month = startDate.getMonth() + 1;
  const year = startDate.getFullYear();
  
  const months = [
    'يناير', 'فبراير', 'مارس', 'إبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
  ];
  
  return `${day} ${months[month - 1]} ${year}`;
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
