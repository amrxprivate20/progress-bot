// ============================================
// On-Demand Failure Detection - UPDATED
// ============================================
// Syncs with Todoist on every /progress command
// Detects missed recurring tasks for the report date

import type { SupabaseClient } from '../database/client';
import type { SettingsManager } from '../database/settings';
import { getTodayInEgypt, getEgyptDayBoundaries, getEgyptDateString } from '../utils/timezone';

/**
 * Todoist API client for fetching tasks
 */
class TodoistAPIClient {
  constructor(private apiToken: string) {}

  /**
   * Fetch all tasks for a specific project
   */
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
  due?: {
    date: string;
    is_recurring: boolean;
    string: string;
  };
}

/**
 * Check which day of week a date is
 * 0 = Sunday, 6 = Saturday
 */
function getDayOfWeek(dateString: string): number {
  const date = new Date(dateString + 'T00:00:00Z');
  return date.getUTCDay();
}

/**
 * Check if a recurring task was due on a specific date
 */
function isTaskDueOnDate(task: TodoistTask, dateString: string): boolean {
  if (!task.due?.is_recurring) return false;
  
  const dueString = task.due.string.toLowerCase();
  
  // Check for "every day" or "daily"
  if (dueString.includes('every day') || dueString.includes('daily')) {
    return true;
  }
  
  // Check for specific days
  const dayOfWeek = getDayOfWeek(dateString);
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayName = dayNames[dayOfWeek];
  
  // Check if the day name appears in the due string
  if (dayName && dueString.includes(dayName)) {
    return true;
  }
  
  // Check for abbreviated day names (mon, tue, wed, etc.)
  const shortDayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const shortDayName = shortDayNames[dayOfWeek];
  
  if (shortDayName && dueString.includes(shortDayName)) {
    return true;
  }
  
  return false;
}

/**
 * Sync with Todoist and detect failed tasks for a specific date
 * Called BEFORE generating report preview
 * 
 * @param db - Supabase client
 * @param settings - Settings manager
 * @param reportDate - Date to check (YYYY-MM-DD) - defaults to today
 * @returns Statistics about detection
 */
export async function syncAndDetectFailuresForDate(
  db: SupabaseClient,
  settings: SettingsManager,
  reportDate?: string
): Promise<{ detected: number; logged: number; skipped: number }> {
  
  const targetDate = reportDate || getTodayInEgypt();
  const { start, end } = getEgyptDayBoundaries(targetDate);

  console.log(`🔍 Syncing with Todoist for date: ${targetDate}`);
  console.log(`⏰ Egypt day boundaries (UTC):`);
  console.log(`   Start: ${start.toISOString()}`);
  console.log(`   End: ${end.toISOString()}`);

  // Get Todoist credentials
  const todoistToken = await settings.get('todoist_api_token');
  const projectId = await settings.get('todoist_project_id');

  if (!todoistToken || !projectId) {
    console.warn('⚠️ Missing Todoist credentials - skipping sync');
    return { detected: 0, logged: 0, skipped: 0 };
  }

  try {
    const todoist = new TodoistAPIClient(todoistToken);

    // Fetch all tasks from Todoist
    const allTasks = await todoist.getAllTasks(projectId);
    console.log(`📋 Found ${allTasks.length} tasks in Todoist project`);

    // Filter for recurring tasks that were due on target date
    const recurringDueOnDate = allTasks.filter(task => 
      isTaskDueOnDate(task, targetDate)
    );

    console.log(`🔄 Found ${recurringDueOnDate.length} recurring tasks due on ${targetDate}`);

    // Get completed tasks from our database for target date
    const completedTasks = await db.select('tasks', {});
    
    // Filter completed tasks for the target date (using Egypt timezone)
    const completedOnDate = completedTasks.filter(task => {
      const completedEgyptDate = getEgyptDateString(new Date(task.completed_at));
      return completedEgyptDate === targetDate;
    });

    // Create sets for quick lookup
    const completedTaskIds = new Set(
      completedOnDate.map(t => t.task_id.split('_')[0]) // Handle recurring ID format
    );
    const completedContents = new Set(
      completedOnDate.map(t => t.content)
    );

    console.log(`✅ Found ${completedOnDate.length} tasks completed on ${targetDate}`);

    // Detect failures: recurring tasks due on date but not completed
    const failedTasks: TodoistTask[] = [];
    
    for (const task of recurringDueOnDate) {
      const isCompleted = 
        completedTaskIds.has(task.id) || 
        completedContents.has(task.content);
      
      if (!isCompleted) {
        failedTasks.push(task);
        console.log(`❌ Detected failure: ${task.content}`);
      }
    }

    console.log(`📊 Detected ${failedTasks.length} failed tasks for ${targetDate}`);

    // Check if we already logged these failures
    let logged = 0;
    let skipped = 0;
    
    for (const task of failedTasks) {
      // Check if already logged as failed for this date
      const existingFailure = completedOnDate.find(
        t => t.content === task.content && t.status === 'failed'
      );
      
      if (existingFailure) {
        console.log(`⏭️ Already logged: ${task.content}`);
        skipped++;
        continue;
      }

      try {
        // Log as failed task
        await db.insert('tasks', {
          task_id: `auto_fail_${task.id}_${Date.now()}`,
          content: task.content,
          completed_at: end.toISOString(), // End of day
          status: 'failed',
          is_origin: true, // Recurring task
          duration_minutes: 0,
          created_at: new Date().toISOString(),
        });
        
        console.log(`✅ Logged failure: ${task.content}`);
        logged++;
      } catch (error) {
        console.error(`❌ Failed to log task: ${task.content}`, error);
      }
    }

    console.log(`✅ Logged ${logged} new failures, skipped ${skipped} existing`);

    return {
      detected: failedTasks.length,
      logged,
      skipped,
    };
    
  } catch (error) {
    console.error('❌ Todoist sync error:', error);
    // Don't throw - allow report to continue even if sync fails
    return { detected: 0, logged: 0, skipped: 0 };
  }
}

/**
 * Handler for scheduled cron trigger (optional - can still run at midnight)
 * Add this to wrangler.toml:
 * 
 * [triggers]
 * crons = ["0 22 * * *"]  # 12:00 AM Egypt = 22:00 UTC previous day
 */
export async function handleScheduledFailureDetection(
  env: any
): Promise<Response> {
  try {
    const { createSupabaseClient } = await import('../database/client');
    const { SettingsManager } = await import('../database/settings');
    
    const db = createSupabaseClient(env);
    const settings = new SettingsManager(db);

    // For scheduled run, always check yesterday (since it runs at midnight)
    const result = await syncAndDetectFailuresForDate(db, settings);

    return new Response(
      JSON.stringify({
        success: true,
        detected: result.detected,
        logged: result.logged,
        skipped: result.skipped,
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