/**
 * Report Generator Service - FIXED v3
 *
 * FIXES APPLIED v3:
 * - Simple task list format (no "achievements" or "losses" sections)
 * - Full hierarchy shown (parent + all subtasks)
 * - Clean symbols: ✅/⚠️/❌ for main, ✓/✕ for subtasks
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
import { getOriginalMetadataString } from '../utils/task-parser';

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

    // FIXED v3: Format preview with simple task list (no sections)
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
   * Get today's date as YYYY-MM-DD in Egypt timezone
   */
  private getTodayDateString(): string {
    return getTodayInEgypt();
  }

  /**
   * Get tasks for a specific date using Egypt timezone boundaries
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
 * FIXED v4: Format preview text with CONTENT-BASED subtask matching
 */
private formatPreviewText(
  data: ReportData,
  stats: ReportStatistics,
  _topCategories: Array<{ name: string; count: number }>,
  challengeStatus: string
): string {
  const date = new Date(data.date);
  const arabicDate = formatArabicDate(date);

  let text = `📊 التقرير اليومي - ${arabicDate}\n\n`;

  // Statistics
  text += `📈 الإحصائيات:\n`;
  text += `- إجمالي المهام: ${stats.total_tasks}\n`;
  text += `- المنجزة: ${stats.completed_tasks}\n`;
  text += `- الفاشلة: ${stats.failed_tasks}\n`;
  text += `- معدل النجاح: ${stats.success_rate.toFixed(1)}%\n`;
  text += `- وقت الإنجاز: ${formatArabicTime(stats.total_time_minutes)}\n\n`;

  // ✅ FIXED v4: Group tasks using CONTENT-BASED matching for subtasks
  text += `🎯 مهام اليوم:\n`;
  text += `ـــــــــــــــــــــــ\n`;

  // Identify main tasks (no Origin: in description, OR no description)
  const mainTasks = data.tasks.filter(t => {
    if (!t.description) return true;  // No description = main task
    return !t.description.includes('Origin:');  // Has description but no Origin: = main task
  });

  // Group subtasks by parent CONTENT (not ID!)
  const subtasksByParentContent = new Map<string, Task[]>();

  for (const task of data.tasks) {
    // Skip if not a subtask
    if (!task.description?.includes('Origin:')) continue;
    
    // Extract parent name from description
    const originMatch = task.description.match(/Origin:([^\nDuration]+)/);
    if (!originMatch) {
      console.warn(`Could not parse Origin from: ${task.description}`);
      continue;
    }
    
    const parentName = originMatch[1].trim().replace(/❗/g, '').trim();
    
    // Store subtask grouped by parent name
    if (!subtasksByParentContent.has(parentName)) {
      subtasksByParentContent.set(parentName, []);
    }
    subtasksByParentContent.get(parentName)!.push(task);
  }

  console.log(`📊 Main tasks: ${mainTasks.length}`);
  console.log(`📊 Subtasks grouped: ${subtasksByParentContent.size} parents`);

  // Display each main task with its subtasks
  for (const task of mainTasks) {
    const symbol = this.getTaskSymbol(task);
    const cleanName = task.content.replace(/\[([^\]]+)\]/g, '').trim();
    const metadata = getOriginalMetadataString(task.content);
    
    text += `${symbol} ${cleanName}`;
    if (metadata) {
      text += ` ${metadata}`;
    }
    
    // Add streak info
    const streak = data.streaks.find(s => s.task_name === task.content);
    if (streak && streak.current_streak > 1) {
      text += ` [${formatArabicStreak(streak.current_streak)} بدون إنقطاع]`;
    }
    
    text += '\n';
    
    // ✅ FIX: Find subtasks by CONTENT matching (try both with and without ❗)
    const cleanTaskName = task.content.replace(/❗/g, '').trim();
    const subtasks = subtasksByParentContent.get(cleanTaskName) || 
                     subtasksByParentContent.get(task.content) || [];
    
    if (subtasks.length > 0) {
      console.log(`📋 Found ${subtasks.length} subtasks for "${cleanTaskName}"`);
    }
    
    // Display subtasks
    for (const subtask of subtasks) {
      const subSymbol = subtask.status === 'done' ? '✓' : '✕';
      const subCleanName = subtask.content.replace(/\[([^\]]+)\]/g, '').trim();
      const subMetadata = getOriginalMetadataString(subtask.content);
      
      text += `${subSymbol} ${subCleanName}`;
      if (subMetadata) {
        text += ` ${subMetadata}`;
      }
      text += '\n';
    }
    
    text += '\n'; // Space between task groups
  }

  // Challenge
  if (data.dailyChallenge) {
    text += `\n🎯 التحدي اليومي: ${challengeStatus}\n`;
    text += `"${data.dailyChallenge.challenge_text}"\n\n`;
  }

  // Weekly goals
  if (data.weeklyGoals) {
    text += `🎯 الأهداف الأسبوعية:\n`;
    text += `${data.weeklyGoals.goals_text}\n\n`;
  }

  text += `\nهل تريد إكمال التحليل بالذكاء الاصطناعي؟\n`;
  text += `استخدم /confirm للمتابعة أو /cancel للإلغاء`;

  return text;
}

  /**
   * Get task symbol based on status
   */
  private getTaskSymbol(task: Task): string {
    if (task.origin_task) {
      // Subtask
      return task.status === 'done' ? '✓' : '✕';
    } else {
      // Main task
      if (task.status === 'done') return '✅';
      if (task.status === 'partial') return '⚠️';
      return '❌';
    }
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