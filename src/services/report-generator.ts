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
import { createJournalManager } from './journal';

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
  journal: string | null; // Formatted journal entries for the day
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
  duration_by_category: Record<string, number>; // minutes per category
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

    // Get journal entries for the day (with media URLs for clickable links)
    const journalMgr = createJournalManager(this.db);
    const journal = await journalMgr.getFormattedJournalWithMedia(reportDate);

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
      journal,
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
  ? await this.checkChallengeCompletion(data.dailyChallenge, data.tasks, data.date)
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
    // =========================================================================
    // NEW LOGIC: Only count MAIN tasks, calculate success based on subtasks
    // =========================================================================

    // Step 1: Separate main tasks and subtasks from completed tasks
    const completedMainTasks = tasks.filter(t => !t.origin_task); // No parent = main task
    const completedSubtasks = tasks.filter(t => !!t.origin_task); // Has parent = subtask

    // Step 2: Get failed main tasks and subtasks from JSON
    const failedMainTasks = failedTasksJson?.failed_tasks.filter(t => !t.is_subtask) || [];
    const failedSubtasks = failedTasksJson?.failed_tasks.filter(t => t.is_subtask) || [];

    // Step 3: Build a map of all main tasks (completed + failed)
    const mainTaskMap = new Map<string, {
      name: string;
      isCompleted: boolean;
      completedSubtasks: number;
      failedSubtasks: number;
      totalSubtasks: number;
      category?: string;
      duration?: number;
    }>();

    // Add completed main tasks
    for (const task of completedMainTasks) {
      const cleanName = extractCleanTaskName(task.content);
      mainTaskMap.set(cleanName, {
        name: cleanName,
        isCompleted: true,
        completedSubtasks: 0,
        failedSubtasks: 0,
        totalSubtasks: 0,
        category: task.category,
        duration: task.duration_minutes,
      });
    }

    // Add failed main tasks (if not already in map)
    for (const task of failedMainTasks) {
      const cleanName = extractCleanTaskName(task.content);
      if (!mainTaskMap.has(cleanName)) {
        mainTaskMap.set(cleanName, {
          name: cleanName,
          isCompleted: false,
          completedSubtasks: 0,
          failedSubtasks: 0,
          totalSubtasks: 0,
          category: task.category,
          duration: task.duration_minutes,
        });
      }
    }

    // Step 4: Count subtasks for each main task
    // Count completed subtasks
    for (const sub of completedSubtasks) {
      // Find parent by origin_task ID
      const parentTask = completedMainTasks.find(t => {
        const baseId = t.task_id?.split('_')[0];
        const originBase = sub.origin_task?.split('_')[0];
        return baseId === originBase || t.task_id === sub.origin_task;
      });

      if (parentTask) {
        const parentName = extractCleanTaskName(parentTask.content);
        const entry = mainTaskMap.get(parentName);
        if (entry) {
          entry.completedSubtasks++;
          entry.totalSubtasks++;
        }
      }
    }

    // Count failed subtasks by parent name
    for (const sub of failedSubtasks) {
      if (sub.parent_content) {
        const parentName = extractCleanTaskName(sub.parent_content);
        const entry = mainTaskMap.get(parentName);
        if (entry) {
          entry.failedSubtasks++;
          entry.totalSubtasks++;
        }
      }
    }

    // Step 5: Calculate success percentage for each main task
    let totalSuccessPercent = 0;
    let fullyCompleted = 0;
    let partiallyCompleted = 0;
    let fullyFailed = 0;

    for (const [, entry] of mainTaskMap) {
      let successPercent: number;

      if (entry.totalSubtasks === 0) {
        // No subtasks - binary: 100% if completed, 0% if not
        successPercent = entry.isCompleted ? 100 : 0;
      } else {
        // Has subtasks - calculate based on subtask completion
        successPercent = (entry.completedSubtasks / entry.totalSubtasks) * 100;
      }

      totalSuccessPercent += successPercent;

      // Categorize
      if (successPercent === 100) {
        fullyCompleted++;
      } else if (successPercent === 0) {
        fullyFailed++;
      } else {
        partiallyCompleted++;
      }
    }

    // Step 6: Calculate overall success rate (average of all main task percentages)
    const totalMainTasks = mainTaskMap.size;
    const overallSuccessRate = totalMainTasks > 0 ? totalSuccessPercent / totalMainTasks : 0;

    // Step 7: Calculate duration from completed tasks only
    const completedTasks = tasks.filter(t => t.status === 'done');
    const totalTime = completedTasks.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);

    // Step 8: Calculate duration by category
    const durationByCategory: Record<string, number> = {};
    for (const task of completedTasks) {
      if (task.duration_minutes && task.duration_minutes > 0) {
        const category = task.category || 'غير مصنف'; // "Uncategorized"
        durationByCategory[category] = (durationByCategory[category] || 0) + task.duration_minutes;
      }
    }

    // Group quantities by unit
    const quantities: Record<string, number> = {};
    for (const task of completedTasks.filter(t => t.quantity)) {
      const unit = task.quantity_unit || 'items';
      quantities[unit] = (quantities[unit] || 0) + (task.quantity || 0);
    }

    // Category breakdown (completed tasks only)
    const categoryBreakdown = this.groupByCategory(completedTasks);

    console.log(`📊 Statistics calculation:`);
    console.log(`   Total main tasks: ${totalMainTasks}`);
    console.log(`   Fully completed: ${fullyCompleted}`);
    console.log(`   Partially completed: ${partiallyCompleted}`);
    console.log(`   Failed: ${fullyFailed}`);
    console.log(`   Overall success rate: ${overallSuccessRate.toFixed(1)}%`);

    return {
      total_tasks: totalMainTasks,
      completed_tasks: fullyCompleted,
      failed_tasks: fullyFailed,
      partial_tasks: partiallyCompleted,
      success_rate: overallSuccessRate,
      total_time_minutes: totalTime,
      total_quantity: quantities,
      category_breakdown: categoryBreakdown,
      duration_by_category: durationByCategory,
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
 * Also updates the challenge result in database
 */
private async checkChallengeCompletion(
  challenge: DailyChallenge, 
  tasks: Task[],
  challengeDate: string
): Promise<string> {
  // Simple heuristic: check if challenge text appears in any completed task
  const challengeText = challenge.challenge_text.toLowerCase();
  const completedTasks = tasks.filter(t => t.status === 'done');

  const firstWord = challengeText.split(' ')[0];
  const isCompleted = completedTasks.some(task =>
    firstWord && task.content.toLowerCase().includes(firstWord)
  );

  // ✅ NEW: Update challenge result in database
  try {
    await this.db.update(
      'daily_challenges',
      { challenge_date: op.eq(challengeDate) },
      { result: isCompleted }
    );
    console.log(`✅ Updated challenge result for ${challengeDate}: ${isCompleted}`);
  } catch (error) {
    console.error('❌ Failed to update challenge result:', error);
  }

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

    // Statistics (main tasks only, subtasks excluded from counts)
    text += `📈 الإحصائيات:\n`;
    text += `- إجمالي المهام الرئيسية: ${stats.total_tasks}\n`;
    text += `- مكتملة بالكامل: ${stats.completed_tasks}\n`;
    if (stats.partial_tasks > 0) {
      text += `- مكتملة جزئياً: ${stats.partial_tasks}\n`;
    }
    text += `- فاشلة: ${stats.failed_tasks}\n`;
    text += `- معدل النجاح: ${stats.success_rate.toFixed(1)}%\n`;

    // Duration breakdown by category
    if (stats.total_time_minutes > 0) {
      text += `\n⏱ توزيع الوقت:\n`;
      text += `- الإجمالي: ${formatArabicTime(stats.total_time_minutes)}\n`;

      // Sort categories by duration (descending)
      const sortedCategories = Object.entries(stats.duration_by_category)
        .sort(([, a], [, b]) => b - a);

      for (const [category, minutes] of sortedCategories) {
        const percentage = ((minutes / stats.total_time_minutes) * 100).toFixed(0);
        text += `- ${category}: ${formatArabicTime(minutes)} (${percentage}%)\n`;
      }
    } else {
      text += `- وقت الإنجاز: ${formatArabicTime(stats.total_time_minutes)}\n`;
    }
    text += '\n';

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

    // Step 2: Build parent task lookup from completed tasks using NAMES
const tasksByName = new Map<string, Task>();

for (const task of data.tasks) {
  const cleanName = extractCleanTaskName(task.content);
  
  // Only store non-subtasks (main tasks) by name
  if (!task.origin_task) {
    tasksByName.set(cleanName, task);
    console.log(`  ✅ Completed main task: "${cleanName}" (ID: ${task.task_id})`);
  }
}

// ✅ NEW: Add failed main tasks to the map so subtasks can find their parents
if (data.failedTasksJson) {
  for (const failed of data.failedTasksJson.failed_tasks) {
    if (!failed.is_subtask) {
      const cleanName = extractCleanTaskName(failed.content);
      if (!tasksByName.has(cleanName)) {
        // Create a pseudo-task entry for the failed parent
        const pseudoParent: Task = {
          task_id: failed.id,
          content: failed.content,
          completed_at: new Date(), // Dummy date
          status: 'failed',
          category: failed.category,
          priority: failed.priority,
        };
        tasksByName.set(cleanName, pseudoParent);
        console.log(`  ❌ Added failed main task to map: "${cleanName}"`);
      }
    }
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

// ✅ NEW: First, process all parent tasks (both completed and failed)
const allParentNames = new Set([
  ...Array.from(tasksByName.keys()),
  ...Array.from(completedSubtasksByParentName.keys()),
  ...Array.from(failedSubtasksByParentName.keys())
]);

for (const parentName of allParentNames) {
  if (processedParentNames.has(parentName)) continue;
  
  const task = tasksByName.get(parentName);
  if (!task) {
    console.log(`⚠️ Parent "${parentName}" has subtasks but no parent task found`);
    continue;
  }
      
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
      
      processedParentNames.add(parentName);
}

// ✅ NEW: Process orphaned subtasks (subtasks without a parent in the list)
for (const task of data.tasks) {
  if (processedSubtasks.has(task.task_id)) continue;
  if (!task.origin_task) continue; // Not a subtask
  
  const cleanName = extractCleanTaskName(task.content);
  
  // Check if this subtask's parent was already processed
  const parentTask = tasksById.get(task.origin_task);
  if (parentTask) {
    const parentCleanName = extractCleanTaskName(parentTask.content);
    if (processedParentNames.has(parentCleanName)) {
      continue; // Already processed under parent
    }
  }
  
  // This is an orphaned subtask - show it with a note
  console.log(`⚠️ Orphaned subtask: "${cleanName}"`);
  
  if (!isFirstTask) {
    text += '\n';
  }
  isFirstTask = false;
  
  const metadata = getOriginalMetadataString(task.content);
  text += `⚠️ ${cleanName}`;
  if (metadata) {
    text += ` ${metadata}`;
  }
  text += ` (مهمة فرعية - المهمة الرئيسية غير مكتملة)\n`;
  
  processedSubtasks.add(task.task_id);
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

    // Challenge (show both the challenge text AND the result)
    if (data.dailyChallenge && data.dailyChallenge.challenge_text) {
      text += `\n🎯 التحدي اليومي:\n`;
      text += `   "${data.dailyChallenge.challenge_text}"\n`;
      text += `   النتيجة: ${challengeStatus}`;
    } else if (challengeStatus !== 'لا يوجد تحدي') {
      text += `\n🎯 التحدي اليومي: ${challengeStatus}`;
    }

    // Journal entries
    if (data.journal) {
      text += `\n\n${data.journal}`;
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
