// src/services/failure-manager.ts
// ============================================
// Daily Failures Manager (JSON-based)
// ============================================
// CLEAN VERSION - No duplicates

import { SupabaseClient, op } from '../database/client';
import { getEgyptDayBoundaries } from '../utils/timezone';

/**
 * Failed task structure in JSON
 */
export interface FailedTask {
  id: string;                    // Todoist task ID
  content: string;               // Task name
  parent_id: string | null;      // Parent task ID (if subtask)
  parent_content: string | null; // Parent task name (for display)
  priority: number;              // 1-4 (4 is highest)
  is_subtask: boolean;           // Whether this is a subtask
  description?: string;          // Task description
  category?: string;             // Task category/label
  duration_minutes?: number;     // Expected duration
}

/**
 * Daily failures document structure
 */
export interface DailyFailures {
  date: string;                  // Egypt date (YYYY-MM-DD)
  last_sync: string;             // ISO timestamp
  failed_tasks: FailedTask[];    // Array of failed tasks
}

/**
 * Sync failures from Todoist and store as JSON
 */
export async function syncFailuresForDate(
  db: SupabaseClient,
  date: string,
  todoistTasks: any[],
  completedTaskIds: Set<string>,
  priorityThreshold: number = 2,
  allTasks?: any[]  // All tasks for parent lookup (not just filtered)
): Promise<DailyFailures> {
  console.log(`🔄 Syncing failures for date: ${date}`);

  // Use allTasks for parent lookup if provided, otherwise fall back to todoistTasks
  const tasksForParentLookup = allTasks || todoistTasks;

  const failedTasks: FailedTask[] = [];

  // Filter for failed recurring tasks
  const { start, end } = getEgyptDayBoundaries(date);

  for (const task of todoistTasks) {
    // Skip if not recurring or already completed
    if (!task.due?.is_recurring) continue;
    if (completedTaskIds.has(task.id)) continue;

    // Check due date falls on this day
    const dueDate = new Date(task.due.date);
    if (dueDate < start || dueDate > end) continue;

    // Check priority threshold (Todoist: 1=lowest, 4=highest)
    // Our threshold: 2 means P1-P2 only (priority 3-4 in Todoist)
    const todoistPriority = task.priority || 1;
    const ourPriority = 5 - todoistPriority; // Convert: Todoist 4 → Our P1

    if (ourPriority > priorityThreshold) {
      console.log(`⏭️ Ignored by priority: ${task.content} (P${ourPriority} > P${priorityThreshold})`);
      continue;
    }

    // Determine if subtask
    const isSubtask = !!task.parent_id;

    // Get parent info if subtask - search in ALL tasks, not just filtered
    let parentContent: string | null = null;
    if (isSubtask && task.parent_id) {
      const parentTask = tasksForParentLookup.find(t => t.id === task.parent_id);
      if (parentTask) {
        parentContent = parentTask.content;
      }
    }
    
    // Add to failed tasks
    const failedTask: FailedTask = {
      id: task.id,
      content: task.content,
      parent_id: task.parent_id || null,
      parent_content: parentContent,
      priority: todoistPriority,
      is_subtask: isSubtask,
      description: task.description || undefined,
      category: task.labels?.[0] || undefined,
    };
    
    failedTasks.push(failedTask);
    
    console.log(
      `❌ Detected failure: ${task.content} (P${ourPriority})${isSubtask ? ' [subtask]' : ''}`
    );
  }
  
  // Create daily failures document
  const dailyFailures: DailyFailures = {
    date,
    last_sync: new Date().toISOString(),
    failed_tasks: failedTasks,
  };
  
  // Upsert to database
  await upsertDailyFailures(db, dailyFailures);
  
  console.log(`📊 Summary:`);
  console.log(`   - Failed tasks: ${failedTasks.length}`);
  console.log(`   - Main tasks: ${failedTasks.filter(t => !t.is_subtask).length}`);
  console.log(`   - Subtasks: ${failedTasks.filter(t => t.is_subtask).length}`);
  
  return dailyFailures;
}

/**
 * Upsert daily failures to database
 */
export async function upsertDailyFailures(
  db: SupabaseClient,
  dailyFailures: DailyFailures
): Promise<void> {
  try {
    const existing = await db.select('daily_failures', {
      filter: { failure_date: op.eq(dailyFailures.date) },
    });
    
    const failuresJson = JSON.stringify(dailyFailures);
    
    if (existing && existing.length > 0) {
      // Update existing
      await db.update(
        'daily_failures',
        { failure_date: op.eq(dailyFailures.date) },
        {
          failures_json: failuresJson,
          last_synced_at: new Date().toISOString(),
        }
      );
      console.log(`✅ Updated failures for ${dailyFailures.date}`);
    } else {
      // Insert new
      await db.insert('daily_failures', {
        failure_date: dailyFailures.date,
        failures_json: failuresJson,
        last_synced_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
      console.log(`✅ Created failures for ${dailyFailures.date}`);
    }
  } catch (error) {
    console.error('❌ Error upserting daily failures:', error);
    throw error;
  }
}

/**
 * Get daily failures for a specific date
 */
export async function getDailyFailures(
  db: SupabaseClient,
  date: string
): Promise<DailyFailures | null> {
  try {
    const result = await db.select('daily_failures', {
      filter: { failure_date: op.eq(date) }, 
    });
    
    if (!result || result.length === 0) {
      return null;
    }
    
    const row = result[0];
    const failuresJson = typeof row.failures_json === 'string'
      ? JSON.parse(row.failures_json)
      : row.failures_json;
    
    return failuresJson as DailyFailures;
  } catch (error) {
    console.error('❌ Error getting daily failures:', error);
    return null;
  }
}

/**
 * Get failed subtasks for a specific parent
 * ✅ FIXED: Now supports BOTH ID-based and NAME-based matching
 */
export async function getFailedSubtasksForParent(
  db: SupabaseClient,
  date: string,
  parentIdentifier: string  // Can be ID or name
): Promise<FailedTask[]> {
  const dailyFailures = await getDailyFailures(db, date);
  
  if (!dailyFailures) {
    return [];
  }
  
  // Try to match by parent_id first (for ID-based calls)
  const parentBaseId = parentIdentifier.split('_')[0];
  
  return dailyFailures.failed_tasks.filter(task => {
    if (!task.parent_id) return false;
    
    const taskParentBase = task.parent_id.split('_')[0];
    
    // Match by full ID, base ID, or parent name
    return (
      task.parent_id === parentIdentifier ||
      task.parent_id === parentBaseId ||
      taskParentBase === parentBaseId ||
      task.parent_content === parentIdentifier
    );
  });
}
/**
 * Get failed subtasks by parent NAME (recommended for recurring tasks)
 * This is the ONLY definition of this function - no duplicates!
 */
export async function getFailedSubtasksByParentName(
  db: SupabaseClient,
  date: string,
  parentName: string
): Promise<FailedTask[]> {
  const dailyFailures = await getDailyFailures(db, date);
  
  if (!dailyFailures) {
    return [];
  }
  
  // Helper to extract clean name
  const getCleanTaskName = (content: string): string => {
    return content
      .replace(/\[([^\]]+)\]/g, '') // Remove brackets
      .replace(/\(origin:[^)]+\)/gi, '') // Remove origin reference
      .replace(/❗/g, '') // Remove origin marker
      .trim();
  };
  
  const cleanParentName = getCleanTaskName(parentName);
  
  return dailyFailures.failed_tasks.filter(task => {
    if (!task.is_subtask || !task.parent_content) return false;
    
    const taskParentName = getCleanTaskName(task.parent_content);
    
    return taskParentName === cleanParentName;
  });
}

/**
 * Check if a task failed today (to update status on completion)
 */
export async function wasTaskFailedToday(
  db: SupabaseClient,
  date: string,
  taskId: string
): Promise<boolean> {
  const dailyFailures = await getDailyFailures(db, date);
  
  if (!dailyFailures) {
    return false;
  }
  
  return dailyFailures.failed_tasks.some(t => t.id === taskId);
}

/**
 * Remove a task from failed list (when it gets completed)
 */
export async function removeFromFailedTasks(
  db: SupabaseClient,
  date: string,
  taskId: string
): Promise<void> {
  const dailyFailures = await getDailyFailures(db, date);
  
  if (!dailyFailures) {
    console.log(`⚠️ No failures found for date ${date}`);
    return;
  }
  
  // Filter out the completed task
  const updatedTasks = dailyFailures.failed_tasks.filter(t => t.id !== taskId);
  
  if (updatedTasks.length === dailyFailures.failed_tasks.length) {
    // Task wasn't in failed list
    console.log(`ℹ️ Task ${taskId} was not in failed list`);
    return;
  }
  
  // Update the document
  dailyFailures.failed_tasks = updatedTasks;
  dailyFailures.last_sync = new Date().toISOString();
  
  await upsertDailyFailures(db, dailyFailures);
  
  console.log(`✅ Removed ${taskId} from failed tasks for ${date}`);
}

/**
 * Get all failures grouped by parent
 */
export async function getFailuresGroupedByParent(
  db: SupabaseClient,
  date: string
): Promise<Map<string, FailedTask[]>> {
  const dailyFailures = await getDailyFailures(db, date);
  
  if (!dailyFailures) {
    return new Map();
  }
  
  const grouped = new Map<string, FailedTask[]>();
  
  for (const task of dailyFailures.failed_tasks) {
    if (task.is_subtask && task.parent_id) {
      // Group subtasks by parent
      if (!grouped.has(task.parent_id)) {
        grouped.set(task.parent_id, []);
      }
      grouped.get(task.parent_id)!.push(task);
    } else {
      // Main tasks are their own group
      grouped.set(task.id, []);
    }
  }
  
  return grouped;
}

/**
 * Get statistics from daily failures
 */
export async function getFailureStats(
  db: SupabaseClient,
  date: string
): Promise<{
  total: number;
  mainTasks: number;
  subtasks: number;
  byPriority: Record<number, number>;
}> {
  const dailyFailures = await getDailyFailures(db, date);
  
  if (!dailyFailures) {
    return {
      total: 0,
      mainTasks: 0,
      subtasks: 0,
      byPriority: {},
    };
  }
  
  const byPriority: Record<number, number> = {};
  let mainTasks = 0;
  let subtasks = 0;
  
  for (const task of dailyFailures.failed_tasks) {
    if (task.is_subtask) {
      subtasks++;
    } else {
      mainTasks++;
    }
    
    const priority = 5 - task.priority; // Convert to our P1-P4
    byPriority[priority] = (byPriority[priority] || 0) + 1;
  }
  
  return {
    total: dailyFailures.failed_tasks.length,
    mainTasks,
    subtasks,
    byPriority,
  };
}