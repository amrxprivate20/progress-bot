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
import {
  getDailyFailures,
  type FailedTask,
  type DailyFailures,
} from './failure-manager';
import { getOriginalMetadataString } from '../utils/task-parser';

// ============================================
// Types
// ============================================

export interface ReportData {
  date: string;
  tasks: Task[];
  failedTasksJson: DailyFailures | null;  // ✅ NEW
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

    // ✅ NEW: Get failed tasks from JSON
    const failedTasksJson = await getDailyFailures(db, date);

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
      failedTasksJson,
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
  private groupByCategory(
  tasks: Task[],
  failedTasksJson: DailyFailures | null
): Record<string, number> {
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
 * FIXED v5: Match subtasks to parents using origin_task field
 * Works even when description is NULL
 */
function formatPreviewText(data: ReportData): string {
  let text = '';

  // Header
  text += `📊 التقرير اليومي - ${formatArabicDate(data.date)}\n\n`;

  // Statistics
  text += `📈 الإحصائيات:\n`;
  text += `- إجمالي المهام: ${data.statistics.total_tasks}\n`;
  text += `- المنجزة: ${data.statistics.completed_tasks}\n`;
  text += `- الفاشلة: ${data.statistics.failed_tasks}\n`;
  text += `- معدل النجاح: ${data.statistics.success_rate}%\n`;
  text += `- وقت الإنجاز: ${formatArabicTime(data.statistics.achievement_time_minutes)}\n\n`;

  // Task breakdown section
  text += `🎯 مهام اليوم:\n`;
  text += `${'ـ'.repeat(20)}\n`;

  // ✅ NEW: Build hierarchical structure using JSON failures
  
  // Step 1: Get all failed tasks from JSON
  const failedTasksMap = new Map<string, FailedTask>();
  const failedSubtasksByParent = new Map<string, FailedTask[]>();
  
  if (data.failedTasksJson) {
    for (const failed of data.failedTasksJson.failed_tasks) {
      failedTasksMap.set(failed.id, failed);
      
      if (failed.is_subtask && failed.parent_id) {
        // Group by base parent ID
        const parentBaseId = failed.parent_id.split('_')[0];
        if (!failedSubtasksByParent.has(parentBaseId)) {
          failedSubtasksByParent.set(parentBaseId, []);
        }
        failedSubtasksByParent.get(parentBaseId)!.push(failed);
      }
    }
  }

  // Step 2: Build parent task lookup from completed tasks
  const taskById = new Map<string, Task>();
  const taskByBaseId = new Map<string, Task>();
  
  for (const task of data.tasks) {
    if (!task.task_id) continue;
    
    taskById.set(task.task_id, task);
    
    const baseId = task.task_id.split('_')[0];
    if (!taskByBaseId.has(baseId)) {
      taskByBaseId.set(baseId, task);
    }
  }

  // Step 3: Group completed subtasks by parent
  const completedSubtasksByParent = new Map<string, Task[]>();
  const processedSubtasks = new Set<string>();

  for (const task of data.tasks) {
    if (!task.origin_task) continue;  // Not a subtask
    
    // Find parent by ID (exact or base match)
    const originBase = task.origin_task.split('_')[0];
    const parent = taskById.get(task.origin_task) || taskByBaseId.get(originBase);
    
    if (parent) {
      const parentBaseId = parent.task_id.split('_')[0];
      
      if (!completedSubtasksByParent.has(parentBaseId)) {
        completedSubtasksByParent.set(parentBaseId, []);
      }
      completedSubtasksByParent.get(parentBaseId)!.push(task);
      processedSubtasks.add(task.task_id);
    }
  }

  // Step 4: Build output - process main tasks
  const processedParents = new Set<string>();
  
  for (const task of data.tasks) {
    if (processedSubtasks.has(task.task_id)) continue;  // Skip subtasks
    
    const taskBaseId = task.task_id.split('_')[0];
    
    // Get subtasks for this parent
    const completedSubs = completedSubtasksByParent.get(taskBaseId) || [];
    const failedSubs = failedSubtasksByParent.get(taskBaseId) || [];
    const totalSubs = completedSubs.length + failedSubs.length;
    
    // Determine status symbol
    let symbol: string;
    if (totalSubs === 0) {
      // No subtasks - use task status
      symbol = task.status === 'done' ? '✅' : '❌';
    } else {
      // Has subtasks - determine by completion
      if (failedSubs.length === 0) {
        symbol = '✅';  // All complete
      } else if (completedSubs.length === 0) {
        symbol = '❌';  // All failed
      } else {
        symbol = '⚠️';  // Partial
      }
    }
    
    // Add main task
    text += `${symbol} ${task.content}\n`;
    
    // Add completed subtasks
    for (const sub of completedSubs) {
      text += `✓ ${sub.content}\n`;
    }
    
    // Add failed subtasks
    for (const sub of failedSubs) {
      text += `✕ ${sub.content}\n`;
    }
    
    processedParents.add(taskBaseId);
  }
  
  // Step 5: Add standalone failed tasks (no parent exists)
  if (data.failedTasksJson) {
    for (const failed of data.failedTasksJson.failed_tasks) {
      if (failed.is_subtask) continue;  // Only main tasks
      
      // Check if already shown (parent was completed)
      const baseId = failed.id.split('_')[0];
      if (processedParents.has(baseId)) continue;
      
      // Check if parent exists in completed tasks
      const parentExists = taskById.has(failed.id) || taskByBaseId.has(baseId);
      if (parentExists) continue;
      
      // Add as standalone failed task
      const failedSubs = failedSubtasksByParent.get(baseId) || [];
      
      text += `❌ ${failed.content}\n`;
      
      // Add its failed subtasks
      for (const sub of failedSubs) {
        text += `✕ ${sub.content}\n`;
      }
      
      processedParents.add(baseId);
    }
  }

  // Active streaks
  if (data.streaks.length > 0) {
    text += `\n🔥 السلاسل النشطة:\n`;
    for (const streak of data.streaks.slice(0, 5)) {
      text += `- ${streak.task_name}: ${formatArabicStreak(streak.current_streak)}`;
      if (streak.current_streak === streak.best_streak && streak.current_streak > 1) {
        text += ' 🎉 (رقم قياسي!)';
      }
      text += '\n';
    }
    text += '\n';
  }

  // Daily challenge
  if (data.challenge) {
    const challengeStatus = data.challengeCompleted ? '✅' : '❌';
    text += `🎯 التحدي اليومي: ${challengeStatus}\n`;
    text += `"${data.challenge.challenge_text}"\n\n`;
  }

  // Weekly goals
  if (data.weeklyGoals) {
    text += `🎯 الأهداف الأسبوعية:\n`;
    text += `${data.weeklyGoals.goals_text}\n\n`;
  } else {
    text += `🎯 الأهداف الأسبوعية: لا توجد أهداف محددة\n\n`;
  }

  // Call to action
  text += `هل تريد إكمال التحليل بالذكاء الاصطناعي؟\n`;
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