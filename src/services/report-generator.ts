/**
 * Report Generator Service - FIXED: Name-based task grouping
 *
 * CRITICAL FIXES:
 * 1. Uses task CONTENT/NAME for parent-child matching (not IDs)
 * 2. Adds line break before each main task (except first)
 * 3. Always shows main task with ALL subtasks (completed + failed)
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
import {
  getDailyFailures,
  type FailedTask,
  type DailyFailures,
} from './failure-manager';

// ============================================
// Types
// ============================================

export interface ReportData {
  date: string; // YYYY-MM-DD (Egypt date)
  tasks: Task[];
  failedTasksJson: DailyFailures | null;
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

    // Get failed tasks from JSON
    const failedTasksJson = await getDailyFailures(this.db, reportDate);

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
    const stats = this.calculateStatistics(data.tasks, data.failedTasksJson);

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

    // Format preview with hierarchy
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
   * Calculate statistics from tasks + JSON failures
   */
  calculateStatistics(tasks: Task[], failedTasksJson: DailyFailures | null): ReportStatistics {
    const completed = tasks.filter(t => t.status === 'done').length;
    const failed = failedTasksJson ? failedTasksJson.failed_tasks.length : 0;
    const partial = tasks.filter(t => t.status === 'partial').length;
    const total = completed + failed;

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

    let summary = '';
    for (const report of reports) {
      summary += `📅 ${report.report_date}: `;
      summary += `معدل النجاح ${report.success_rate}%، `;
      summary += `${report.completed_tasks} مهام منجزة، `;
      summary += `${report.failed_tasks} مهام فاشلة\n`;
    }

    return summary;
  }

  /**
   * Get today's date string (Egypt timezone)
   */
  private getTodayDateString(): string {
    return getTodayInEgypt();
  }

  /**
   * Get tasks for a specific date (Egypt timezone)
   */
  private async getTasksForDate(date: string): Promise<Task[]> {
    const { start, end } = getEgyptDayBoundaries(date);

    console.log(`📅 Fetching tasks for Egypt date ${date}:`);
    console.log(`   UTC start: ${start.toISOString()}`);
    console.log(`   UTC end: ${end.toISOString()}`);

    const allTasks = await this.db.select<Task>('tasks', {});

    const tasksForDate = allTasks.filter(task => {
      const completedAt = new Date(task.completed_at);
      return completedAt >= start && completedAt <= end;
    });

    console.log(`   Found ${tasksForDate.length} tasks`);

    return tasksForDate;
  }

  /**
   * Get all streaks
   */
  private async getStreaks(): Promise<Streak[]> {
    return await this.db.select<Streak>('streaks', {
      order: 'current_streak.desc',
    });
  }

  /**
   * Get current week's goals
   */
  private async getCurrentWeekGoals(date: string): Promise<WeeklyGoals | null> {
    const dateObj = new Date(date);
    const dayOfWeek = dateObj.getDay();
    const daysToSaturday = dayOfWeek === 6 ? 0 : (6 - dayOfWeek + 7) % 7;

    const weekStartDate = new Date(dateObj);
    weekStartDate.setDate(dateObj.getDate() - daysToSaturday);
    const weekStartStr = weekStartDate.toISOString().split('T')[0];

    const goals = await this.db.select<WeeklyGoals>('weekly_goals', {
      filter: { week_start_date: op.eq(weekStartStr) },
      limit: 1
    });

    return goals.length > 0 ? (goals[0] || null) : null;
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
   * ✅ FIXED: Format preview using NAME-BASED grouping
   * 
   * CRITICAL CHANGES:
   * 1. Groups by task CONTENT/NAME (not ID)
   * 2. Adds line break before each main task (except first)
   * 3. Shows ALL subtasks (completed + failed)
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

    // ✅ NEW: Build hierarchical structure using NAME-BASED grouping
    text += `🎯 مهام اليوم:\n`;
    text += `ـــــــــــــــــــــــ\n`;

    // Helper function to extract clean task name (remove metadata, origin markers)
    const getCleanTaskName = (content: string): string => {
      return content
        .replace(/\[([^\]]+)\]/g, '') // Remove brackets [30m], [5 pages], etc.
        .replace(/\(origin:[^)]+\)/gi, '') // Remove (origin: ...)
        .replace(/❗/g, '') // Remove origin marker
        .trim();
    };

    // Step 1: Build maps from failed tasks JSON using NAMES
    const failedTasksByName = new Map<string, FailedTask>();
    const failedSubtasksByParentName = new Map<string, FailedTask[]>();
    
    if (data.failedTasksJson) {
      console.log(`📊 Processing ${data.failedTasksJson.failed_tasks.length} failed tasks from JSON`);
      
      for (const failed of data.failedTasksJson.failed_tasks) {
        const cleanName = getCleanTaskName(failed.content);
        failedTasksByName.set(cleanName, failed);
        
        if (failed.is_subtask && failed.parent_content) {
          const parentCleanName = getCleanTaskName(failed.parent_content);
          
          if (!failedSubtasksByParentName.has(parentCleanName)) {
            failedSubtasksByParentName.set(parentCleanName, []);
          }
          failedSubtasksByParentName.get(parentCleanName)!.push(failed);
          
          console.log(`  ✕ Failed subtask: ${cleanName} (parent: ${parentCleanName})`);
        } else {
          console.log(`  ❌ Failed main task: ${cleanName}`);
        }
      }
    }

    // Step 2: Build parent task lookup from completed tasks using NAMES
    const tasksByName = new Map<string, Task>();
    
    for (const task of data.tasks) {
      const cleanName = getCleanTaskName(task.content);
      
      // Only store non-subtasks (main tasks) by name
      if (!task.origin_task) {
        tasksByName.set(cleanName, task);
      }
    }

    // Step 3: Group completed subtasks by parent NAME
    const completedSubtasksByParentName = new Map<string, Task[]>();
    const processedSubtasks = new Set<string>();

    for (const task of data.tasks) {
      if (!task.origin_task) continue;  // Not a subtask
      
      // Get parent by finding task with matching clean name
      const cleanSubtaskName = getCleanTaskName(task.content);
      
      // Find parent task in completed tasks
      for (const [parentCleanName, parentTask] of tasksByName.entries()) {
        const parentTaskIdBase = parentTask.task_id.split('_')[0];
        const originTaskBase = task.origin_task.split('_')[0];
        
        // Match by ID base (for now, to find the parent)
        if (parentTaskIdBase === originTaskBase) {
          if (!completedSubtasksByParentName.has(parentCleanName)) {
            completedSubtasksByParentName.set(parentCleanName, []);
          }
          completedSubtasksByParentName.get(parentCleanName)!.push(task);
          processedSubtasks.add(task.task_id);
          
          console.log(`  ✓ Completed subtask: ${cleanSubtaskName} → parent: ${parentCleanName}`);
          break;
        }
      }
    }

    // Step 4: Build output - process main tasks
    const processedParentNames = new Set<string>();
    let isFirstTask = true; // ✅ Track if this is the first task
    
    for (const task of data.tasks) {
      if (processedSubtasks.has(task.task_id)) continue;
      
      const cleanName = getCleanTaskName(task.content);
      
      console.log(`🔍 Processing parent: ${cleanName}`);
      
      // Get subtasks for this parent using CLEAN NAME
      const completedSubs = completedSubtasksByParentName.get(cleanName) || [];
      const failedSubs = failedSubtasksByParentName.get(cleanName) || [];
      
      console.log(`   Completed subs: ${completedSubs.length}`);
      console.log(`   Failed subs: ${failedSubs.length}`);

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
      
      // ✅ FIX: Add line break BEFORE main task (except first)
      if (!isFirstTask) {
        text += '\n';
      }
      isFirstTask = false;
      
      // Add main task
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
      
      // Add completed subtasks
      for (const sub of completedSubs) {
        const subCleanName = getCleanTaskName(sub.content);
        const subMetadata = getOriginalMetadataString(sub.content);
        
        text += `   ✓ ${subCleanName}`;
        if (subMetadata) {
          text += ` ${subMetadata}`;
        }
        text += '\n';
      }
      
      // Add failed subtasks
      for (const sub of failedSubs) {
        const subCleanName = getCleanTaskName(sub.content);
        text += `   ✕ ${subCleanName}\n`;
      }
      
      processedParentNames.add(cleanName);
    }
    
    // Step 5: Add standalone failed tasks (no parent exists)
    if (data.failedTasksJson) {
      for (const failed of data.failedTasksJson.failed_tasks) {
        if (failed.is_subtask) continue;  // Only main tasks
        
        const cleanName = getCleanTaskName(failed.content);
        
        // Check if already shown (parent was completed)
        if (processedParentNames.has(cleanName)) continue;
        
        // Check if parent exists in completed tasks
        const parentExists = tasksByName.has(cleanName);
        if (parentExists) continue;
        
        // ✅ FIX: Add line break BEFORE failed task (except first)
        if (!isFirstTask) {
          text += '\n';
        }
        isFirstTask = false;
        
        // Add as standalone failed task
        const failedSubs = failedSubtasksByParentName.get(cleanName) || [];
        
        text += `❌ ${failed.content}\n`;
        
        // Add its failed subtasks
        for (const sub of failedSubs) {
          const subCleanName = getCleanTaskName(sub.content);
          text += `   ✕ ${subCleanName}\n`;
        }
        
        processedParentNames.add(cleanName);
      }
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