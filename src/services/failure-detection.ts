// ============================================
// Failure Detection - FIXED v3
// ============================================
// CRITICAL FIXES v3:
// 1. Priority filtering ONLY applies to uncompleted tasks ✅
// 2. Completed tasks are NEVER filtered by priority ✅
// 3. Auto-logged failures now include parent_id/origin_task ✅ NEW!

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
  description?: string;  // ✅ ADD THIS
  parent_id?: string;  // ✅ Important for subtask relationship
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
 * FIXED v3: Auto-logged failures now include parent_id relationship
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

  // Get priority threshold from settings
  const thresholdStr = await settings.get('failure_priority_threshold');
  const priorityThreshold = thresholdStr ? parseInt(thresholdStr) : 2; // Default: P1 and P2 only
  
  console.log(`🎯 Priority threshold: P1-P${priorityThreshold}`);
  console.log(`   (Only failures from these priorities will be logged)`);

  try {
    const todoist = new TodoistAPIClient(todoistToken);
    const allTasks = await todoist.getAllTasks(projectId);
    
    console.log(`📋 Found ${allTasks.length} tasks in Todoist project`);

    // Filter for recurring tasks due on target date
    const recurringDueOnDate = allTasks.filter(task => 
      isTaskDueOnDate(task, targetDate)
    );

    console.log(`🔄 Found ${recurringDueOnDate.length} recurring tasks due on ${targetDate}`);

    // Get ALL completed tasks for target date (NO priority filter)
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

    console.log(`✅ Found ${completedOnDate.length} tasks completed on ${targetDate} (all priorities)`);

    // Detect failures with priority filter ONLY for uncompleted tasks
    const failedTasks: TodoistTask[] = [];
    let ignoredByPriority = 0;
    
    for (const task of recurringDueOnDate) {
      const isCompleted = 
        completedTaskIds.has(task.id) || 
        completedContents.has(task.content);
      
      if (!isCompleted) {
        // Check priority threshold ONLY for failed tasks
        const todoistPriorityLevel = 5 - task.priority; // Convert: 4→1(P1), 3→2(P2), 2→3(P3), 1→4(P4)
        
        if (todoistPriorityLevel <= priorityThreshold) {
          failedTasks.push(task);
          console.log(`❌ Detected failure: ${task.content} (P${todoistPriorityLevel})${task.parent_id ? ' [subtask]' : ''}`);
        } else {
          ignoredByPriority++;
          console.log(`⏭️ Ignored by priority: ${task.content} (P${todoistPriorityLevel} > P${priorityThreshold})`);
        }
      }
    }

    console.log(`📊 Summary:`);
    console.log(`   - Failed tasks (meeting threshold): ${failedTasks.length}`);
    console.log(`   - Ignored by priority threshold: ${ignoredByPriority}`);

    let logged = 0;
    let skipped = 0;
    
for (const task of failedTasks) {
  try {
    const parentId = task.parent_id || null;
    const isOrigin = !parentId;
    
    await db.insert('tasks', {
      task_id: `auto_fail_${task.id}_${Date.now()}`,
      content: task.content,
      description: task.description,
      completed_at: end.toISOString(),
      status: 'failed',
      is_origin: isOrigin,
      origin_task: parentId,
      duration_minutes: 0,
      priority: task.priority,
      created_at: new Date().toISOString(),
    });
    
    console.log(`✅ Logged failure: ${task.content} (P${5 - task.priority})${parentId ? ' [subtask of ' + parentId + ']' : ''}`);
    logged++;
  } catch (error) {
    console.error(`❌ Failed to log task: ${task.content}`, error);
    skipped++;
  }
}

    return {
      detected: failedTasks.length,
      logged,
      skipped,
      ignoredByPriority,
    };
  } catch (error) {
    console.error('Error in syncAndDetectFailuresForDate:', error);
    throw error;
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