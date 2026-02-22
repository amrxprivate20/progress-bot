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
  pending_tasks: number;
  success_rate: number;
  total_time_minutes: number;
  total_quantity: Record<string, number>;
  category_breakdown: Record<string, number>;
  duration_by_category: Record<string, number>; // minutes per category
}

/**
 * Lightweight daily summary for meta-coach intervention context.
 * Built with exactly 4 queries (no streaks, memory, journal, previous reports, or challenge UPDATE).
 */
export interface LightweightDailySummary {
  doneTasks: Task[];
  failedTasks: Task[];
  partialTasks: Task[];
  failures: FailedTask[];
  weeklyGoals: WeeklyGoals | null;
  dailyChallenge: DailyChallenge | null;
}

// ============================================
// Lightweight daily summary (4 queries only)
// ============================================

/**
 * Build a lightweight daily summary with exactly 4 Supabase queries.
 * Used by meta-coach buildInterventionContext to stay under subrequest limit.
 */
export async function buildLightweightDailySummary(
  db: SupabaseClient,
  date: string
): Promise<LightweightDailySummary> {
  const { start, end } = getEgyptDayBoundaries(date);

  // QUERY 1 — Combined tasks for the day (done + failed + partial)
  const tasksForDate = await db.select<Task>('tasks', {
    filter: {
      completed_at: op.gte(start.toISOString()),
    },
    limit: 5000,
  });
  const dayTasks = tasksForDate.filter((t) => {
    const completedAt = new Date(t.completed_at);
    return completedAt <= end;
  });
  const doneTasks = dayTasks.filter((t) => t.status === 'done');
  const failedTasks = dayTasks.filter((t) => t.status === 'failed');
  const partialTasks = dayTasks.filter((t) => t.status === 'partial');

  // QUERY 2 — Daily failures (JSON)
  const dailyFailuresDoc = await getDailyFailures(db, date);
  const failures = dailyFailuresDoc?.failed_tasks ?? [];

  // QUERY 3 — Weekly goals (current week start)
  const dateObj = new Date(date + 'T12:00:00Z');
  const dayOfWeek = dateObj.getUTCDay();
  const daysToSaturday = dayOfWeek === 6 ? 0 : (6 - dayOfWeek + 7) % 7;
  const weekStartDate = new Date(dateObj);
  weekStartDate.setUTCDate(dateObj.getUTCDate() - daysToSaturday);
  const weekStartStr = weekStartDate.toISOString().split('T')[0];
  const weeklyGoalsRows = await db.select<WeeklyGoals>('weekly_goals', {
    filter: { week_start_date: op.eq(weekStartStr) },
    limit: 1,
  });
  const weeklyGoals = weeklyGoalsRows.length > 0 ? weeklyGoalsRows[0]! : null;

  // QUERY 4 — Daily challenge
  const challengeRows = await db.select<DailyChallenge>('daily_challenges', {
    filter: { challenge_date: op.eq(date) },
    limit: 1,
  });
  const dailyChallenge = challengeRows.length > 0 ? challengeRows[0]! : null;

  return {
    doneTasks,
    failedTasks,
    partialTasks,
    failures,
    weeklyGoals,
    dailyChallenge,
  };
}

/**
 * Format lightweight summary as intervention context text (no DB, no challenge UPDATE).
 */
export function formatLightweightSummaryForContext(
  summary: LightweightDailySummary,
  date: string
): string {
  const arabicDate = formatArabicDate(new Date(date + 'T12:00:00Z'));
  const allTasks = [...summary.doneTasks, ...summary.failedTasks, ...summary.partialTasks];
  const mainTasks = allTasks.filter((t) => !t.origin_task);
  const totalMain = mainTasks.length;
  const doneMain = summary.doneTasks.filter((t) => !t.origin_task).length;
  const failedMain = summary.failedTasks.filter((t) => !t.origin_task).length;
  const partialMain = summary.partialTasks.filter((t) => !t.origin_task).length;
  const successRate = totalMain > 0 ? (doneMain / totalMain) * 100 : 0;
  const totalTime = summary.doneTasks.reduce((s, t) => s + (t.duration_minutes || 0), 0);

  let text = `📊 التقرير اليومي - ${arabicDate}\n\n`;
  text += `📈 الإحصائيات:\n`;
  text += `- إجمالي المهام الرئيسية: ${totalMain}\n`;
  text += `- مكتملة بالكامل: ${doneMain}\n`;
  if (partialMain > 0) text += `- مكتملة جزئياً: ${partialMain} ⚠️\n`;
  text += `- فاشلة: ${failedMain}\n`;
  text += `- معدل النجاح: ${successRate.toFixed(1)}%\n`;

  if (totalTime > 0) {
    text += `\n⏱ توزيع الوقت:\n`;
    text += `- الإجمالي: ${formatArabicTime(totalTime)}\n`;
    const byCategory: Record<string, number> = {};
    for (const t of summary.doneTasks) {
      if (t.duration_minutes && t.duration_minutes > 0) {
        const cat = t.category || 'غير مصنف';
        byCategory[cat] = (byCategory[cat] || 0) + t.duration_minutes;
      }
    }
    const sorted = Object.entries(byCategory).sort(([, a], [, b]) => b - a);
    for (const [cat, min] of sorted) {
      const pct = ((min / totalTime) * 100).toFixed(0);
      text += `- ${cat}: ${formatArabicTime(min)} (${pct}%)\n`;
    }
    text += '\n';
  }

  text += `🎯 مهام اليوم:\n`;
  text += `ـــــــــــــــــــــــ\n`;
  const doneNames = summary.doneTasks.filter((t) => !t.origin_task).map((t) => extractCleanTaskName(t.content));
  const failedNames = summary.failedTasks.filter((t) => !t.origin_task).map((t) => extractCleanTaskName(t.content));
  const jsonFailedNames = summary.failures.filter((f) => !f.is_subtask).map((f) => extractCleanTaskName(f.content));
  const allFailedSet = new Set([...failedNames, ...jsonFailedNames]);
  for (const name of doneNames) {
    text += `✅ ${name}\n`;
  }
  for (const name of allFailedSet) {
    if (!doneNames.includes(name)) text += `❌ ${name}\n`;
  }
  if (summary.dailyChallenge) {
    text += `\n🎯 التحدي اليوم: ${summary.dailyChallenge.challenge_text} (لم يُقيّم)\n`;
  } else {
    text += `\n🎯 التحدي اليوم: لا يوجد تحدي\n`;
  }
  return text;
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

    // Check debug mode
    const debugMode = await this.settings.get('debug_mode');
    const isDebug = debugMode === 'true';

    // Format preview with hierarchy
    const formattedText = this.formatPreviewText(data, stats, topCategories, challengeStatus, isDebug);

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
 * FIXED: Now includes manual failures from database AND JSON failures
 */
calculateStatistics(tasks: Task[], failedTasksJson: DailyFailures | null): ReportStatistics {
  // =========================================================================
  // IMPROVED LOGIC: Count BOTH database failures AND JSON failures
  // =========================================================================

  // Step 1: Separate main tasks and subtasks from ALL tasks (completed + failed)
  const allMainTasks = tasks.filter(t => !t.origin_task); // No parent = main task
  const allSubtasks = tasks.filter(t => !!t.origin_task); // Has parent = subtask

  // Step 2: Get failed main tasks and subtasks from JSON
  const jsonFailedMainTasks = failedTasksJson?.failed_tasks.filter(t => !t.is_subtask) || [];
  const jsonFailedSubtasks = failedTasksJson?.failed_tasks.filter(t => t.is_subtask) || [];

  // Step 3: Build a map of all main tasks (completed + failed from DB + failed from JSON)
  const mainTaskMap = new Map<string, {
    name: string;
    isCompleted: boolean;
    isPending: boolean; // true = not yet failed, still open
    completedSubtasks: number;
    failedSubtasks: number;
    pendingSubtasks: number;
    totalSubtasks: number;
    category?: string;
    duration?: number;
  }>();

  // Add completed main tasks from database
  for (const task of allMainTasks.filter(t => t.status === 'done')) {
    const cleanName = extractCleanTaskName(task.content);
    mainTaskMap.set(cleanName, {
      name: cleanName,
      isCompleted: true,
      isPending: false,
      completedSubtasks: 0,
      failedSubtasks: 0,
      pendingSubtasks: 0,
      totalSubtasks: 0,
      category: task.category,
      duration: task.duration_minutes,
    });
  }

  // Add failed main tasks from database
  for (const task of allMainTasks.filter(t => t.status === 'failed')) {
    const cleanName = extractCleanTaskName(task.content);
    if (!mainTaskMap.has(cleanName)) {
      mainTaskMap.set(cleanName, {
        name: cleanName,
        isCompleted: false,
        isPending: false, // DB status 'failed' = confirmed failed
        completedSubtasks: 0,
        failedSubtasks: 0,
        pendingSubtasks: 0,
        totalSubtasks: 0,
        category: task.category,
        duration: task.duration_minutes,
      });
    }
  }

  // Add failed/pending main tasks from JSON (if not already in map)
  for (const task of jsonFailedMainTasks) {
    const cleanName = extractCleanTaskName(task.content);
    if (!mainTaskMap.has(cleanName)) {
      mainTaskMap.set(cleanName, {
        name: cleanName,
        isCompleted: false,
        isPending: task.is_pending !== false, // true or undefined = pending
        completedSubtasks: 0,
        failedSubtasks: 0,
        pendingSubtasks: 0,
        totalSubtasks: 0,
        category: task.category,
        duration: task.duration_minutes,
      });
    }
  }

  // Step 4: Count subtasks for each main task
  // Count completed subtasks - improved name-based matching
  for (const sub of allSubtasks.filter(t => t.status === 'done')) {
    // Try to find parent by clean name matching
    let parentName: string | null = null;

    // Method 1: Check for origin marker in content
    const originMatch = sub.content.match(/\(origin:\s*([^)]+)\)/i);
    if (originMatch && originMatch[1]) {
      parentName = extractCleanTaskName(originMatch[1]);
    }

    // Method 2: Try to find by origin_task ID
    if (!parentName && sub.origin_task) {
      const parentTask = allMainTasks.find(t => {
        const baseId = t.task_id?.split('_')[0];
        const originBase = sub.origin_task?.split('_')[0];
        return baseId === originBase || t.task_id === sub.origin_task;
      });
      if (parentTask) {
        parentName = extractCleanTaskName(parentTask.content);
      }
    }

    if (parentName) {
      const entry = mainTaskMap.get(parentName);
      if (entry) {
        entry.completedSubtasks++;
        entry.totalSubtasks++;
      }
    }
  }

  // ✅ NEW: Count failed subtasks from database
  for (const sub of allSubtasks.filter(t => t.status === 'failed')) {
    let parentName: string | null = null;

    const originMatch = sub.content.match(/\(origin:\s*([^)]+)\)/i);
    if (originMatch && originMatch[1]) {
      parentName = extractCleanTaskName(originMatch[1]);
    }

    if (!parentName && sub.origin_task) {
      const parentTask = allMainTasks.find(t => {
        const baseId = t.task_id?.split('_')[0];
        const originBase = sub.origin_task?.split('_')[0];
        return baseId === originBase || t.task_id === sub.origin_task;
      });
      if (parentTask) {
        parentName = extractCleanTaskName(parentTask.content);
      }
    }

    if (parentName) {
      const entry = mainTaskMap.get(parentName);
      if (entry) {
        entry.failedSubtasks++;
        entry.totalSubtasks++;
      }
    }
  }

  // Count failed/pending subtasks from JSON by parent name
  // Build lookup for parent resolution
  const allFailedById = new Map<string, typeof jsonFailedSubtasks[0]>();
  for (const f of failedTasksJson?.failed_tasks || []) {
    allFailedById.set(f.id, f);
  }

  for (const sub of jsonFailedSubtasks) {
    let parentName: string | null = null;

    // Method 1: Use parent_content
    if (sub.parent_content) {
      parentName = extractCleanTaskName(sub.parent_content);
    }

    // Method 2: Look up parent by parent_id in failed tasks
    if (!parentName && sub.parent_id) {
      const parentFailed = allFailedById.get(sub.parent_id);
      if (parentFailed && !parentFailed.is_subtask) {
        parentName = extractCleanTaskName(parentFailed.content);
      }
    }

    // Method 3: Look up parent by parent_id in completed tasks
    if (!parentName && sub.parent_id) {
      const parentBaseId = sub.parent_id.split('_')[0];
      const parentTask = allMainTasks.find(t => {
        const taskBaseId = t.task_id?.split('_')[0];
        return taskBaseId === parentBaseId || t.task_id === sub.parent_id;
      });
      if (parentTask) {
        parentName = extractCleanTaskName(parentTask.content);
      }
    }

    if (parentName) {
      const entry = mainTaskMap.get(parentName);
      if (entry) {
        if (sub.is_pending !== false) {
          entry.pendingSubtasks++;
        } else {
          entry.failedSubtasks++;
        }
        entry.totalSubtasks++;
      }
    }
  }

  // Step 5: Calculate success percentage for each main task
  let totalSuccessPercent = 0;
  let fullyCompleted = 0;
  let partiallyCompleted = 0;
  let fullyFailed = 0;
  let pendingCount = 0;

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
    } else if (entry.isPending && successPercent === 0) {
      pendingCount++; // Still pending, not failed yet
    } else if (successPercent === 0) {
      fullyFailed++;
    } else {
      partiallyCompleted++;
    }
  }

  // Step 6: Calculate overall success rate
  const totalMainTasks = mainTaskMap.size;
  const overallSuccessRate = totalMainTasks > 0 ? totalSuccessPercent / totalMainTasks : 0;

  // Step 7: Calculate duration from completed tasks only
  const completedTasks = tasks.filter(t => t.status === 'done');
  const totalTime = completedTasks.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);

  // Step 8: Calculate duration by category
  const durationByCategory: Record<string, number> = {};
  for (const task of completedTasks) {
    if (task.duration_minutes && task.duration_minutes > 0) {
      const category = task.category || 'غير مصنف';
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

  console.log(`📊 Statistics calculation (IMPROVED):`);
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
    pending_tasks: pendingCount,
    success_rate: overallSuccessRate,
    total_time_minutes: totalTime,
    total_quantity: quantities,
    category_breakdown: categoryBreakdown,
    duration_by_category: durationByCategory,
  };
}
/**
 * Get the formatted report text (same as what user sees in preview)
 * This is used by AI to ensure consistency
 */
async getFormattedReportForAI(date?: string): Promise<string> {
  const data = await this.collectReportData(date);
  const stats = this.calculateStatistics(data.tasks, data.failedTasksJson);

  // Get top categories
  const categories = this.groupByCategory(data.tasks.filter(t => t.status === 'done'));
  const topCategories = Object.entries(categories)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // Check challenge status
  const challengeStatus = data.dailyChallenge
    ? await this.checkChallengeCompletion(data.dailyChallenge, data.tasks, data.date)
    : 'لا يوجد تحدي';

  // Use the SAME formatting function as preview (no debug for AI)
  return this.formatPreviewText(data, stats, topCategories, challengeStatus, false);
}

  /**
   * Generate summary of past week - uses AI-generated summaries when available
   */
  generatePastWeekSummary(reports: DailyReport[]): string {
    if (reports.length === 0) {
      return 'لا توجد تقارير سابقة';
    }

    let summary = '';
    for (const report of reports) {
      summary += `📅 **${report.report_date}**\n`;
      summary += `   • معدل النجاح: ${report.success_rate}%، منجزة: ${report.completed_tasks}، فاشلة: ${report.failed_tasks}\n`;

      // Add challenge result
      if (report.challenge_evaluation) {
        summary += `   • التحدي: ${report.challenge_evaluation}\n`;
      }

      // ✅ PRIORITY: Use AI-generated day summary if available (stored in obsidian_file_id)
      if (report.obsidian_file_id && report.obsidian_file_id.length > 10) {
        summary += `   • ${report.obsidian_file_id}\n`;
      } else if (report.ai_commentary) {
        // Fallback: Extract first meaningful sentence from AI commentary
        const firstSentence = report.ai_commentary.split(/[.!؟]/)[0]?.trim();
        if (firstSentence && firstSentence.length > 20) {
          const excerpt = firstSentence.length > 120 ? firstSentence.substring(0, 120) + '...' : firstSentence;
          summary += `   • ${excerpt}\n`;
        }
      }

      // Add goals highlights (condensed)
      if (report.weekly_goals_analysis) {
        try {
          const goals = typeof report.weekly_goals_analysis === 'string'
            ? JSON.parse(report.weekly_goals_analysis)
            : report.weekly_goals_analysis;

          const parts: string[] = [];
          if (goals.completed?.length > 0) parts.push(`✅${goals.completed.length}`);
          if (goals.neglected?.length > 0) parts.push(`⚠️${goals.neglected.length}`);
          if (parts.length > 0) {
            summary += `   • أهداف: ${parts.join(' ')}\n`;
          }
        } catch (e) { /* ignore */ }
      }

      summary += '\n';
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

    // Use server-side filtering to get all tasks for this date range
    const tasksForDate = await this.db.select<Task>('tasks', {
      filter: {
        completed_at: `gte.${start.toISOString()}`,
      },
      limit: 5000, // Ensure we get all tasks (default PostgREST limit is 1000)
    });

    // Filter out tasks after end boundary (PostgREST doesn't support multiple filters on same column easily)
    const filtered = tasksForDate.filter(task => {
      const completedAt = new Date(task.completed_at);
      return completedAt <= end;
    });

    console.log(`   Found ${filtered.length} tasks for date ${date}`);
    for (const t of filtered) {
      console.log(`   - [${t.status || 'done'}] ${extractCleanTaskName(t.content)} (origin: ${t.origin_task || 'none'}, priority: ${t.priority || '?'})`);
    }

    return filtered;
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
    challengeStatus: string,
    debugMode: boolean = false
  ): string {
    const date = new Date(data.date);
    const arabicDate = formatArabicDate(date);

    let text = `📊 التقرير اليومي - ${arabicDate}\n\n`;

    // Statistics (main tasks only, subtasks excluded from counts)
    text += `📈 الإحصائيات:\n`;
text += `- إجمالي المهام الرئيسية: ${stats.total_tasks}\n`;
text += `- مكتملة بالكامل: ${stats.completed_tasks}\n`;
if (stats.partial_tasks > 0) {
  text += `- مكتملة جزئياً: ${stats.partial_tasks} ⚠️\n`;
}
if (stats.pending_tasks > 0) {
  text += `- قيد التنفيذ: ${stats.pending_tasks} ⏳\n`;
}
text += `- فاشلة: ${stats.failed_tasks}\n`;
text += `- معدل النجاح: ${stats.success_rate.toFixed(1)}%\n`;

    // Duration breakdown by category (only show if there's tracked time)
    if (stats.total_time_minutes > 0) {
      text += `\n⏱ توزيع الوقت:\n`;
      text += `- الإجمالي: ${formatArabicTime(stats.total_time_minutes)}\n`;

      // Sort categories by duration (descending)
      const sortedCategories = Object.entries(stats.duration_by_category)
        .sort(([, a], [, b]) => b - a)
        .filter(([, minutes]) => minutes > 0); // Only show categories with time

      for (const [category, minutes] of sortedCategories) {
        const percentage = ((minutes / stats.total_time_minutes) * 100).toFixed(0);
        text += `- ${category}: ${formatArabicTime(minutes)} (${percentage}%)\n`;
      }
      text += '\n';
    }

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

      // Build a lookup of all failed tasks by ID for parent resolution
      const failedTasksById = new Map<string, FailedTask>();
      for (const f of data.failedTasksJson.failed_tasks) {
        failedTasksById.set(f.id, f);
      }

      for (const failed of data.failedTasksJson.failed_tasks) {
        const cleanName = extractCleanTaskName(failed.content);

        if (failed.is_subtask) {
          let parentCleanName: string | null = null;

          // Method 1: Use parent_content if available
          if (failed.parent_content) {
            parentCleanName = extractCleanTaskName(failed.parent_content);
          }

          // Method 2: Look up parent by parent_id in other failed tasks
          if (!parentCleanName && failed.parent_id) {
            const parentFailed = failedTasksById.get(failed.parent_id);
            if (parentFailed && !parentFailed.is_subtask) {
              parentCleanName = extractCleanTaskName(parentFailed.content);
            }
          }

          // Method 3: Look up parent by parent_id in completed tasks
          if (!parentCleanName && failed.parent_id) {
            const parentBaseId = failed.parent_id.split('_')[0];
            for (const task of data.tasks) {
              if (task.origin_task) continue; // Skip subtasks
              const taskBaseId = task.task_id?.split('_')[0];
              if (taskBaseId === parentBaseId || task.task_id === failed.parent_id) {
                parentCleanName = extractCleanTaskName(task.content);
                break;
              }
            }
          }

          if (parentCleanName) {
            if (!failedSubtasksByParentName.has(parentCleanName)) {
              failedSubtasksByParentName.set(parentCleanName, []);
            }
            failedSubtasksByParentName.get(parentCleanName)!.push(failed);
            console.log(`  ✕ Failed subtask: "${cleanName}" → parent: "${parentCleanName}"`);
          } else {
            // Could not find parent - treat as standalone
            failedTasksByName.set(cleanName, failed);
            console.log(`  ⚠️ Failed subtask (no parent found): "${cleanName}" → standalone`);
          }
        } else {
          // Main task (not a subtask)
          failedTasksByName.set(cleanName, failed);
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
    console.log(`  ✅ Completed main task: "${cleanName}"`);
  }
}

// ✅ FIX: Add failed main tasks to the map so subtasks can find their parents
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
          duration_minutes: failed.duration_minutes,
        };
        tasksByName.set(cleanName, pseudoParent);
        console.log(`  ❌ Added failed main task to map: "${cleanName}"`);
      }
    }
  }
}

// ===============================================================================
// Step 3: Group completed subtasks by parent NAME - FIXED v3 (NAME-FIRST)
// ===============================================================================
const completedSubtasksByParentName = new Map<string, Task[]>();
const processedSubtasks = new Set<string>();

for (const task of data.tasks) {
  if (!task.origin_task || !task.task_id) continue;
  
  const cleanSubtaskName = extractCleanTaskName(task.content);
  console.log(`🔍 Processing completed subtask: "${cleanSubtaskName}"`);
  
  let parentName: string | null = null;
  
  // ✅ PRIORITY 1: Look in failed JSON for a matching subtask with parent_content
  if (data.failedTasksJson && !parentName) {
    const matchingFailedSub = data.failedTasksJson.failed_tasks.find(ft => 
      ft.is_subtask && 
      extractCleanTaskName(ft.content) === cleanSubtaskName &&
      ft.parent_content
    );
    
    if (matchingFailedSub && matchingFailedSub.parent_content) {
      parentName = extractCleanTaskName(matchingFailedSub.parent_content);
      console.log(`   📌 Found parent via failed JSON sibling: "${parentName}"`);
    }
  }
  
  // ✅ PRIORITY 2: Check for origin marker in content
  if (!parentName) {
    const originMatch = task.content.match(/\(origin:\s*([^)]+)\)/i);
    if (originMatch && originMatch[1]) {
      parentName = extractCleanTaskName(originMatch[1]);
      console.log(`   📌 Origin marker found: "${parentName}"`);
    }
  }
  
  // ✅ PRIORITY 3: Try to find parent by origin_task ID in completed tasks
  if (!parentName) {
    const parentId = task.origin_task;
    const parentBaseId = parentId.split('_')[0];
    
    const parentTask = data.tasks.find(t => {
      if (!t.task_id || t.origin_task) return false;
      const baseId = t.task_id.split('_')[0];
      return baseId === parentBaseId;
    });
    
    if (parentTask) {
      parentName = extractCleanTaskName(parentTask.content);
      console.log(`   📌 Found parent by ID in completed: "${parentName}"`);
    }
  }
  
  // ✅ PRIORITY 4: Try to find parent by origin_task ID in failed JSON
  if (!parentName && data.failedTasksJson) {
    const parentId = task.origin_task;
    const failedParent = data.failedTasksJson.failed_tasks.find(ft => 
      !ft.is_subtask && ft.id === parentId
    );
    
    if (failedParent) {
      parentName = extractCleanTaskName(failedParent.content);
      console.log(`   📌 Found parent by ID in failed JSON: "${parentName}"`);
    }
  }
  
  // Group under parent if found
  if (parentName) {
    if (!completedSubtasksByParentName.has(parentName)) {
      completedSubtasksByParentName.set(parentName, []);
    }
    completedSubtasksByParentName.get(parentName)!.push(task);
    processedSubtasks.add(task.task_id);
    console.log(`   ✓ Grouped under: "${parentName}"`);
  } else {
    console.log(`   ⚠️ Could not match subtask to parent`);
  }
}
    console.log('\n📊 Grouping Summary:');
    console.log(`   Completed main tasks: ${tasksByName.size}`);
    console.log(`   Completed subtasks grouped: ${processedSubtasks.size}`);
    console.log(`   Failed tasks: ${failedTasksByName.size}`);
    console.log(`   Parent names with completed subs: ${completedSubtasksByParentName.size}`);
    console.log(`   Parent names with failed subs: ${failedSubtasksByParentName.size}\n`);

    // ===============================================================================
    // Step 4: Build output - process ALL main tasks (completed AND failed)
    // ===============================================================================
    const processedParentNames = new Set<string>();
    let isFirstTask = true;

    // Collect ALL parent names from all sources
    const allParentNames = new Set<string>();
    
    // Add completed parent task names
    for (const name of tasksByName.keys()) {
      allParentNames.add(name);
    }
    
    // Add parents that have completed subtasks
    for (const name of completedSubtasksByParentName.keys()) {
      allParentNames.add(name);
    }
    
    // Add parents that have failed subtasks
    for (const name of failedSubtasksByParentName.keys()) {
      allParentNames.add(name);
    }
    
    // Add failed main task names
    for (const name of failedTasksByName.keys()) {
      allParentNames.add(name);
    }

    console.log(`📊 Total unique parent names: ${allParentNames.size}`);

    // Process each parent
    for (const parentName of allParentNames) {
      if (processedParentNames.has(parentName)) continue;
      
      // Try to get task from completed tasks OR failed tasks
      let task = tasksByName.get(parentName);
      
      if (!task) {
        // Not in completed tasks, check failed tasks
        const failedTask = failedTasksByName.get(parentName);
        if (failedTask) {
          // Create a pseudo-Task object from FailedTask
          task = {
            task_id: failedTask.id,
            content: failedTask.content,
            completed_at: new Date(),
            status: 'failed',
            category: failedTask.category,
            priority: failedTask.priority,
            duration_minutes: failedTask.duration_minutes,
          } as Task;
          console.log(`🔍 Processing FAILED parent: "${parentName}"`);
        } else {
          console.log(`⚠️ Parent "${parentName}" not found in completed OR failed tasks`);
          continue;
        }
      } else {
        console.log(`🔍 Processing COMPLETED parent: "${parentName}"`);
      }
      
      const cleanName = extractCleanTaskName(task.content);
      
      // Get subtasks for this parent
      const completedSubs = completedSubtasksByParentName.get(cleanName) || [];
      const failedSubs = failedSubtasksByParentName.get(cleanName) || [];

      console.log(`   Completed subs: ${completedSubs.length}`);
      console.log(`   Failed subs: ${failedSubs.length}`);

      const totalSubs = completedSubs.length + failedSubs.length;

      // Determine status symbol - parent complete ONLY when ALL subtasks done in DB (never use task.status from Todoist)
      const allSubsCompleteInDb = totalSubs > 0 && failedSubs.length === 0;
      const mainFailed = failedTasksByName.get(cleanName);

      let symbol: string;
      if (totalSubs === 0) {
        if (task.status === 'done') {
          symbol = '✅';
        } else if (mainFailed && mainFailed.is_pending === false) {
          symbol = '❌';
        } else {
          symbol = '⏳';
        }
      } else {
        const confirmedFailedSubs = failedSubs.filter(s => s.is_pending === false);
        if (allSubsCompleteInDb) {
          symbol = '✅';
        } else if (confirmedFailedSubs.length > 0 && completedSubs.length > 0) {
          symbol = '⚠️';
        } else if (confirmedFailedSubs.length > 0 && completedSubs.length === 0) {
          symbol = '❌';
        } else {
          symbol = '⏳';
        }
      }
      
      // Add line break BEFORE main task (except first)
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
      
      // Add streak info (only for completed recurring tasks)
      const mainCompleted = totalSubs === 0 ? task.status === 'done' : allSubsCompleteInDb;
      if (mainCompleted) {
        const streak = data.streaks.find(s => s.task_name === task.content);
        if (streak && streak.current_streak > 1) {
          text += ` [${formatArabicStreak(streak.current_streak)} بدون إنقطاع]`;
        }
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
      
      // Add failed/pending subtasks
      for (const sub of failedSubs) {
        const subCleanName = extractCleanTaskName(sub.content);
        const subSymbol = sub.is_pending !== false ? '…' : '✕'; // … = pending, ✕ = confirmed failed
        text += `   ${subSymbol} ${subCleanName}\n`;
      }
      
      processedParentNames.add(parentName);
    }

    // ===============================================================================
    // Step 5: Process orphaned subtasks (if any remain)
    // ===============================================================================
    for (const task of data.tasks) {
      if (!task.task_id) continue; // Skip tasks without IDs
      if (processedSubtasks.has(task.task_id)) continue; // Already processed
      if (!task.origin_task) continue; // Not a subtask
      
      const cleanName = extractCleanTaskName(task.content);
      
      // This is an orphaned subtask (couldn't match to parent by name)
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
      text += ` (مهمة فرعية - لم يتم ربطها بمهمة رئيسية)\n`;
      
      processedSubtasks.add(task.task_id);
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

    // DEBUG: Show raw data sources (only when debug_mode setting is 'true')
    if (debugMode) {
      text += `\n\n🔍 DEBUG - بيانات التشخيص:\n`;
      text += `ـــــــــــــــــــــــ\n`;
      text += `📦 مهام من قاعدة البيانات (tasks table): ${data.tasks.length}\n`;
      for (const t of data.tasks) {
        const cn = extractCleanTaskName(t.content);
        const isSub = t.origin_task ? '  ↳ فرعية' : '📌 رئيسية';
        const displayPriority = t.priority ? `P${5 - t.priority}` : 'P?';
        text += `${isSub} | ${t.status || '?'} | ${displayPriority} | ${cn}\n`;
      }
      text += `\n📦 مهام فاشلة (failures JSON): ${data.failedTasksJson?.failed_tasks?.length || 0}\n`;
      if (data.failedTasksJson) {
        for (const f of data.failedTasksJson.failed_tasks) {
          const cn = extractCleanTaskName(f.content);
          const isSub = f.is_subtask ? '  ↳ فرعية' : '📌 رئيسية';
          const displayPriority = f.priority ? `P${5 - f.priority}` : 'P?';
          text += `${isSub} | failed | ${displayPriority} | ${cn}\n`;
        }
      }
      text += `\n📊 ملخص: ${processedParentNames.size} رئيسية معروضة, ${processedSubtasks.size} فرعية معروضة`;
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
