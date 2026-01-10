// ============================================
// Failure Detection - COMPLETELY FIXED
// ============================================
// CRITICAL FIXES:
// 1. Selective failure detection by priority
// 2. Configurable via settings: failure_priority_threshold
// 3. Only priorities <= threshold are considered failures

import type { SupabaseClient } from '../database/client';
import type { SettingsManager } from '../database/settings';
import { getTodayInEgypt, getEgyptDayBoundaries, getEgyptDateString } from '../utils/timezone';

class TodoistAPIClient {
  constructor(private apiToken: string) {}

  async getAllTasks(projectId: string): Promise<TodoistTask[]> {
    const response = await fetch(
      `https://api.todoist.com/rest/v2/tasks?project_id=${projectId}`,
      {
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Todoist API error: ${response.status}`);
    }

    return await response.json();
  }
}

interface TodoistTask {
  id: string;
  content: string;
  project_id: string;
  priority: number; // 1 (lowest) to 4 (highest)
  due?: {
    date: string;
    is_recurring: boolean;
    string: string;
  };
}

function getDayOfWeek(dateString: string): number {
  const date = new Date(dateString + 'T00:00:00Z');
  return date.getUTCDay();
}

function isTaskDueOnDate(task: TodoistTask, dateString: string): boolean {
  if (!task.due?.is_recurring) return false;
  
  const dueString = task.due.string.toLowerCase();
  
  if (dueString.includes('every day') || dueString.includes('daily')) {
    return true;
  }
  
  const dayOfWeek = getDayOfWeek(dateString);
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayName = dayNames[dayOfWeek];
  
  if (dayName && dueString.includes(dayName)) {
    return true;
  }
  
  const shortDayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const shortDayName = shortDayNames[dayOfWeek];
  
  if (shortDayName && dueString.includes(shortDayName)) {
    return true;
  }
  
  return false;
}

/**
 * FIXED: Sync and detect failures with priority filtering
 * 
 * NEW SETTING: failure_priority_threshold
 * - Default: 2 (only P1 and P2 tasks)
 * - Set to 4 to include all priorities
 * - Set to 1 to only include P1 (highest priority)
 * 
 * Examples:
 * - threshold = 2: P1 (priority 4), P2 (priority 3) → failures
 *                  P3 (priority 2), P4 (priority 1) → ignored
 * - threshold = 3: P1, P2, P3 → failures; P4 → ignored
 * - threshold = 4: All priorities → failures
 */
export async function syncAndDetectFailuresForDate(
  db: SupabaseClient,
  settings: SettingsManager,
  reportDate?: string
): Promise<{ detected: number; logged: number; skipped: number; ignoredByPriority: number }> {
  
  const targetDate = reportDate || getTodayInEgypt();
  const { start, end } = getEgyptDayBoundaries(targetDate);

  console.log(`🔍 Syncing with Todoist for date: ${targetDate}`);
  console.log(`⏰ Egypt day boundaries (UTC):`);
  console.log(`   Start: ${start.toISOString()}`);
  console.log(`   End: ${end.toISOString()}`);

  const todoistToken = await settings.get('todoist_api_token');
  const projectId = await settings.get('todoist_project_id');

  if (!todoistToken || !projectId) {
    console.warn('⚠️ Missing Todoist credentials - skipping sync');
    return { detected: 0, logged: 0, skipped: 0, ignoredByPriority: 0 };
  }

  // CRITICAL: Get priority threshold from settings
  const thresholdStr = await settings.get('failure_priority_threshold');
  const priorityThreshold = thresholdStr ? parseInt(thresholdStr) : 2; // Default: P1 and P2 only
  
  console.log(`🎯 Priority threshold: ${priorityThreshold}`);
  console.log(`   Only tasks with Todoist priority >= ${5 - priorityThreshold} will be considered failures`);

  try {
    const todoist = new TodoistAPIClient(todoistToken);
    const allTasks = await todoist.getAllTasks(projectId);
    
    console.log(`📋 Found ${allTasks.length} tasks in Todoist project`);

    // Filter for recurring tasks due on target date
    const recurringDueOnDate = allTasks.filter(task => 
      isTaskDueOnDate(task, targetDate)
    );

    console.log(`🔄 Found ${recurringDueOnDate.length} recurring tasks due on ${targetDate}`);

    // Get completed tasks from database for target date
    const completedTasks = await db.select('tasks', {});
    
    const completedOnDate = completedTasks.filter(task => {
      const completedEgyptDate = getEgyptDateString(new Date(task.completed_at));
      return completedEgyptDate === targetDate;
    });

    const completedTaskIds = new Set(
      completedOnDate.map(t => t.task_id.split('_')[0])
    );
    const completedContents = new Set(
      completedOnDate.map(t => t.content)
    );

    console.log(`✅ Found ${completedOnDate.length} tasks completed on ${targetDate}`);

    // Detect failures with priority filter
    const failedTasks: TodoistTask[] = [];
    let ignoredByPriority = 0;
    
    for (const task of recurringDueOnDate) {
      const isCompleted = 
        completedTaskIds.has(task.id) || 
        completedContents.has(task.content);
      
      if (!isCompleted) {
        // CRITICAL: Check priority threshold
        // Todoist: 1 (lowest) to 4 (highest)
        // threshold=2 means: only priority 3,4 (P2, P1)
        const todoistPriorityLevel = 5 - task.priority; // Convert: 1→4, 2→3, 3→2, 4→1
        
        if (todoistPriorityLevel <= priorityThreshold) {
          failedTasks.push(task);
          console.log(`❌ Detected failure: ${task.content} (Priority ${todoistPriorityLevel})`);
        } else {
          ignoredByPriority++;
          console.log(`⏭️ Ignored by priority: ${task.content} (Priority ${todoistPriorityLevel})`);
        }
      }
    }

    console.log(`📊 Detected ${failedTasks.length} failed tasks (${ignoredByPriority} ignored by priority)`);

    let logged = 0;
    let skipped = 0;
    
    for (const task of failedTasks) {
      const existingFailure = completedOnDate.find(
        t => t.content === task.content && t.status === 'failed'
      );
      
      if (existingFailure) {
        console.log(`⏭️ Already logged: ${task.content}`);
        skipped++;
        continue;
      }

      try {
        await db.insert('tasks', {
          task_id: `auto_fail_${task.id}_${Date.now()}`,
          content: task.content,
          completed_at: end.toISOString(),
          status: 'failed',
          is_origin: true,
          duration_minutes: 0,
          priority: task.priority,
          created_at: new Date().toISOString(),
        });
        
        console.log(`✅ Logged failure: ${task.content} (Priority ${5 - task.priority})`);
        logged++;
      } catch (error) {
        console.error(`❌ Failed to log task: ${task.content}`, error);
      }
    }

    console.log(`✅ Logged ${logged} new failures, skipped ${skipped} existing, ignored ${ignoredByPriority} by priority`);

    return {
      detected: failedTasks.length,
      logged,
      skipped,
      ignoredByPriority,
    };
    
  } catch (error) {
    console.error('❌ Todoist sync error:', error);
    return { detected: 0, logged: 0, skipped: 0, ignoredByPriority: 0 };
  }
}

/**
 * Scheduled handler (optional - runs at midnight)
 */
export async function handleScheduledFailureDetection(
  env: any
): Promise<Response> {
  try {
    const { createSupabaseClient } = await import('../database/client');
    const { SettingsManager } = await import('../database/settings');
    
    const db = createSupabaseClient(env);
    const settings = new SettingsManager(db);

    const result = await syncAndDetectFailuresForDate(db, settings);

    return new Response(
      JSON.stringify({
        success: true,
        detected: result.detected,
        logged: result.logged,
        skipped: result.skipped,
        ignoredByPriority: result.ignoredByPriority,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Scheduled failure detection error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: (error as Error).message,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
