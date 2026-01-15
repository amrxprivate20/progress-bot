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
import { getOriginalMetadataString, extractCleanTaskName } from '../utils/task-parser';
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
   * ✅ FIXED v3.0: Format preview using COMPREHENSIVE NAME-BASED grouping
   * 
   * WHAT CHANGED:
   * ==============
   * 
   * OLD APPROACH (Lines 449-454):
   * ```typescript
   * const parentTaskIdBase = parentTask.task_id.split('_')[0];
   * const originTaskBase = task.origin_task.split('_')[0];
   * if (parentTaskIdBase === originTaskBase) { ... }
   * ```
   * ❌ Problem: IDs don't always match!
   * 
   * NEW APPROACH:
   * ```typescript
   * const parentCleanName = extractCleanTaskName(parentTask.content);
   * const subtaskOriginCleanName = extractCleanTaskName(originTaskContent);
   * if (subtaskOriginCleanName === parentCleanName) { ... }
   * ```
   * ✅ Solution: Names always match!
   * 
   * HOW IT WORKS:
   * =============
   * 
   * Step 1: Build failed tasks maps BY NAME
   *   - Map failed main tasks: cleanName → FailedTask
   *   - Map failed subtasks: parentCleanName → FailedTask[]
   * 
   * Step 2: Build completed tasks map BY NAME
   *   - Map completed main tasks: cleanName → Task
   * 
   * Step 3: Build completed subtasks map BY NAME ✅ NEW!
   *   - For each completed subtask:
   *     1. Get the origin_task (parent reference)
   *     2. Find parent in DB by ID (this works because same-day completions use same timestamped ID)
   *     3. Extract parent's clean name
   *     4. Map: parentCleanName → Task[]
   * 
   * Step 4: Display tasks
   *   - For each parent task:
   *     1. Get parent clean name
   *     2. Look up completed subtasks BY PARENT NAME ✅
   *     3. Look up failed subtasks BY PARENT NAME ✅
   *     4. Display with proper symbols (✅/❌/⚠️)
   * 
   * Step 5: Display standalone failed tasks
   *   - Show failed tasks that don't have completed parents
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

    // ✅ Build hierarchical structure using NAME-BASED grouping
    text += `🎯 مهام اليوم:\n`;
    text += `ـــــــــــــــــــــــ\n`;

    // ===============================================================================
    // Step 1: Build maps from failed tasks JSON using NAMES
    // ===============================================================================
    const failedTasksByName = new Map<string, FailedTask>();
    const failedSubtasksByParentName = new Map<string, FailedTask[]>();
    
    if (data.failedTasksJson) {
      console.log(`📊 Processing ${data.failedTasksJson.failed_tasks.length} failed tasks from JSON`);
      
      for (const failed of data.failedTasksJson.failed_tasks) {
        const cleanName = extractCleanTaskName(failed.content);
        failedTasksByName.set(cleanName, failed);
        
        if (failed.is_subtask && failed.parent_content) {
          const parentCleanName = extractCleanTaskName(failed.parent_content);
          
          if (!failedSubtasksByParentName.has(parentCleanName)) {
            failedSubtasksByParentName.set(parentCleanName, []);
          }
          failedSubtasksByParentName.get(parentCleanName)!.push(failed);
          
          console.log(`  ✕ Failed subtask: "${cleanName}" → parent: "${parentCleanName}"`);
        } else {
          console.log(`  ❌ Failed main task: "${cleanName}"`);
        }
      }
    }

    // ===============================================================================
    // Step 2: Build parent task lookup from completed tasks using NAMES
    // ===============================================================================
    const tasksByName = new Map<string, Task>();
    
    for (const task of data.tasks) {
      const cleanName = extractCleanTaskName(task.content);
      
      // Only store non-subtasks (main tasks) by name
      if (!task.origin_task) {
        tasksByName.set(cleanName, task);
        console.log(`  ✅ Completed main task: "${cleanName}" (ID: ${task.task_id})`);
      }
    }

    // Step 3: Group completed subtasks by parent NAME
    const completedSubtasksByParentName = new Map<string, Task[]>();
    const processedSubtasks = new Set<string>();

    // Create a quick ID → Task lookup for finding parents
    const tasksById = new Map<string, Task>();
    for (const task of data.tasks) {
      if (!task.task_id) continue; // Skip tasks without IDs
      
      tasksById.set(task.task_id, task);
      // Also add base ID version for timestamped IDs
      const baseId = task.task_id.split('_')[0];
      if (baseId && !tasksById.has(baseId)) {
        tasksById.set(baseId, task);
      }
    }

    for (const task of data.tasks) {
      if (!task.origin_task || !task.task_id) continue;  // Not a subtask or missing ID
      
      const cleanSubtaskName = extractCleanTaskName(task.content);
      
      console.log(`🔍 Processing completed subtask: "${cleanSubtaskName}"`);
      console.log(`   origin_task: ${task.origin_task}`);
      
      // ✅ NEW: Find parent task by ID FIRST, then use its NAME for grouping
      const originBase = task.origin_task.split('_')[0];
      
      // Try to find parent: check exact ID first, then base ID
      let parentTask = tasksById.get(task.origin_task);
      if (!parentTask && originBase) {
        parentTask = tasksById.get(originBase);
      }
      
      if (parentTask) {
        // ✅ CRITICAL: Group by parent's CLEAN NAME, not ID!
        const parentCleanName = extractCleanTaskName(parentTask.content);
        
        console.log(`   ✅ Found parent: "${parentCleanName}" (ID: ${parentTask.task_id})`);
        
        if (!completedSubtasksByParentName.has(parentCleanName)) {
          completedSubtasksByParentName.set(parentCleanName, []);
        }
        completedSubtasksByParentName.get(parentCleanName)!.push(task);
        processedSubtasks.add(task.task_id);
        
        console.log(`   ✓ Grouped under parent name: "${parentCleanName}"`);
      } else {
        console.log(`   ⚠️ Parent not found for origin_task: ${task.origin_task}`);
      }
    }

    console.log('\n📊 Grouping Summary:');
    console.log(`   Completed main tasks: ${tasksByName.size}`);
    console.log(`   Completed subtasks grouped: ${processedSubtasks.size}`);
    console.log(`   Failed tasks: ${failedTasksByName.size}`);
    console.log(`   Parent names with completed subs: ${completedSubtasksByParentName.size}`);
    console.log(`   Parent names with failed subs: ${failedSubtasksByParentName.size}\n`);

    // Step 4: Build output - process main tasks
    const processedParentNames = new Set<string>();
    let isFirstTask = true; // Track if this is the first task
    
    for (const task of data.tasks) {
      if (processedSubtasks.has(task.task_id)) continue;
      
      const cleanName = extractCleanTaskName(task.content);
      
      // ✅ FIX 1: Skip duplicate parents (same clean name already displayed)
      if (processedParentNames.has(cleanName)) {
        console.log(`🔍 Skipping duplicate parent: "${cleanName}"`);
        continue;
      }
      
      console.log(`🔍 Displaying parent: "${cleanName}"`);
      
      // ✅ NEW: Get subtasks for this parent using CLEAN NAME (not ID!)
      const completedSubs = completedSubtasksByParentName.get(cleanName) || [];
      const failedSubs = failedSubtasksByParentName.get(cleanName) || [];

      console.log(`   Completed subs: ${completedSubs.length}`);
      console.log(`   Failed subs: ${failedSubs.length}`);

      const totalSubs = completedSubs.length + failedSubs.length;

      // Determine status symbol
      let symbol: string;
      const mainCompleted = task.status === 'done';

      if (totalSubs === 0) {
        // No subtasks - use task status
        symbol = mainCompleted ? '✅' : '❌';
      } else {
        // Has subtasks - determine by subtask completion
        const allSubsComplete = failedSubs.length === 0;
        const allSubsFailed = completedSubs.length === 0;

        if (allSubsComplete) {
          symbol = '✅';  // All subtasks complete
        } else if (allSubsFailed) {
          symbol = '❌';  // All subtasks failed (even if main completed)
        } else {
          symbol = '⚠️';  // Partial (some subs complete, some failed)
        }
      }
      
      // ✅ Add line break BEFORE main task (except first)
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
        const subCleanName = extractCleanTaskName(sub.content);
        const subMetadata = getOriginalMetadataString(sub.content);
        
        text += `   ✓ ${subCleanName}`;
        if (subMetadata) {
          text += ` ${subMetadata}`;
        }
        text += '\n';
      }
      
      // Add failed subtasks
      for (const sub of failedSubs) {
        const subCleanName = extractCleanTaskName(sub.content);
        text += `   ✕ ${subCleanName}\n`;
      }
      
      processedParentNames.add(cleanName);
    }
    
    // ===============================================================================
    // Step 5: Add standalone failed tasks (with their failed subtasks)
    // ===============================================================================
    if (data.failedTasksJson) {
      console.log(`📊 Checking for standalone failed tasks...`);

      for (const failed of data.failedTasksJson.failed_tasks) {
        if (failed.is_subtask) continue; // Skip subtasks, they're handled with their parents

        const cleanName = extractCleanTaskName(failed.content);

        // Only show if not already processed as completed
        if (!processedParentNames.has(cleanName)) {
          console.log(`   ❌ Standalone failed: "${cleanName}"`);

          text += '\n';
          text += `❌ ${cleanName}\n`;

          // Also show failed subtasks for this failed main task
          const failedSubs = failedSubtasksByParentName.get(cleanName) || [];
          for (const sub of failedSubs) {
            const subCleanName = extractCleanTaskName(sub.content);
            text += `   ✕ ${subCleanName}\n`;
            console.log(`      ✕ Failed subtask: "${subCleanName}"`);
          }

          processedParentNames.add(cleanName);
        }
      }
    }

    // Challenge
    if (challengeStatus !== 'لا يوجد تحدي') {
      text += `\n🎯 التحدي اليومي: ${challengeStatus}`;
    }

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