// ============================================
// Todoist Webhook Handler - COMPLETELY FIXED
// ============================================
// CRITICAL FIXES:
// 1. Arabic comma (،) support
// 2. No duplicate metadata in notifications
// 3. Full hierarchy display (main + all subtasks)
// 4. Sync on every completion (not just reports)
// 5. Selective failure detection by priority
// ============================================

import type { SupabaseClient } from '../database/client';
import type { SettingsManager } from '../database/settings';
import type { TodoistWebhookEvent, Task, Streak } from '../types';
import { op } from '../database/client';
import { SETTINGS_KEYS } from '../database/settings';
import { logError } from '../utils/errors';
import { parseTaskMetadata, getOriginalMetadataString } from '../utils/task-parser';
import { 
  getEgyptDateString, 
  formatArabicStreak
} from '../utils/timezone';

/**
 * Todoist task interface
 */
interface TodoistTaskResponse {
  id: string;
  content: string;
  project_id: string;
  parent_id?: string;
  priority: number;
  description?: string;
  labels?: string[];
  due?: {
    date: string;
    is_recurring: boolean;
    string: string;
  };
}

/**
 * Todoist API client for hierarchy sync
 */
class TodoistAPIClient {
  constructor(private apiToken: string) {}

  /**
   * Get task details including parent and children
   */
  async getTaskHierarchy(taskId: string): Promise<{
    task: TodoistTaskResponse | null;
    parent: TodoistTaskResponse | null;
    siblings: TodoistTaskResponse[];
  }> {
    try {
      // Get the task itself
      const taskResponse = await fetch(
        `https://api.todoist.com/rest/v2/tasks/${taskId}`,
        {
          headers: { 'Authorization': `Bearer ${this.apiToken}` }
        }
      );

      if (!taskResponse.ok) {
        throw new Error(`Failed to fetch task: ${taskResponse.status}`);
      }

      const task = await taskResponse.json() as TodoistTaskResponse;

      let parent: TodoistTaskResponse | null = null;
      let siblings: TodoistTaskResponse[] = [];

      // If this is a subtask, get parent and siblings
      if (task.parent_id) {
        // Get parent
        const parentResponse = await fetch(
          `https://api.todoist.com/rest/v2/tasks/${task.parent_id}`,
          {
            headers: { 'Authorization': `Bearer ${this.apiToken}` }
          }
        );

        if (parentResponse.ok) {
          parent = await parentResponse.json() as TodoistTaskResponse;
        }

        // Get all tasks in project to find siblings
        const projectResponse = await fetch(
          `https://api.todoist.com/rest/v2/tasks?project_id=${task.project_id}`,
          {
            headers: { 'Authorization': `Bearer ${this.apiToken}` }
          }
        );

        if (projectResponse.ok) {
          const allTasks = await projectResponse.json() as TodoistTaskResponse[];
          siblings = allTasks.filter((t: TodoistTaskResponse) => 
            t.parent_id === task.parent_id && t.id !== task.id
          );
        }
      } else {
        // If this is a parent, get children
        const projectResponse = await fetch(
          `https://api.todoist.com/rest/v2/tasks?project_id=${task.project_id}`,
          {
            headers: { 'Authorization': `Bearer ${this.apiToken}` }
          }
        );

        if (projectResponse.ok) {
          const allTasks = await projectResponse.json() as TodoistTaskResponse[];
          siblings = allTasks.filter((t: TodoistTaskResponse) => t.parent_id === task.id);
        }
      }

      return { task, parent, siblings };
    } catch (error) {
      console.error('Failed to get task hierarchy:', error);
      return { task: null, parent: null, siblings: [] };
    }
  }
}

export async function handleTodoistWebhook(
  payload: any,
  db: SupabaseClient,
  settings: SettingsManager
): Promise<{ success: boolean; message: string; task?: Task }> {
  const event = payload as TodoistWebhookEvent;

  console.log('🔍 Processing event:', event.event_name);

  if (event.event_name !== 'item:completed') {
    return { success: true, message: `Ignored event: ${event.event_name}` };
  }

  const projectId = await settings.get(SETTINGS_KEYS.TODOIST_PROJECT_ID);
  if (!projectId) {
    throw new Error('Todoist project ID not configured');
  }

  console.log('🎯 Expected project:', projectId);
  console.log('📦 Task project:', event.event_data.project_id);

  if (event.event_data.project_id && event.event_data.project_id !== projectId) {
    return {
      success: true,
      message: `Ignored task from different project: ${event.event_data.project_id}`,
    };
  }

  // CRITICAL FIX: Sync with Todoist FIRST to get hierarchy
  const todoistToken = await settings.get(SETTINGS_KEYS.TODOIST_API_TOKEN);
  let hierarchyInfo: { task: any; parent: any | null; siblings: any[] } | null = null;
  
  if (todoistToken) {
    const todoist = new TodoistAPIClient(todoistToken);
    hierarchyInfo = await todoist.getTaskHierarchy(event.event_data.id);
    console.log('🔗 Hierarchy synced:', {
      hasParent: !!hierarchyInfo.parent,
      siblingsCount: hierarchyInfo.siblings.length
    });
  }

  // Get completion time
  let completedAtString = event.event_data.completed_at || new Date().toISOString();
  
  console.log('⏰ UTC completion timestamp:', completedAtString);
  
  const completedAt = new Date(completedAtString);
  
  const egyptDate = getEgyptDateString(completedAt);
  console.log('📅 Egypt date:', egyptDate);

  const isRecurring = event.event_data.due?.is_recurring || false;
  const isSubtask = !!event.event_data.parent_id;

  console.log('📋 Task info:', {
    isRecurring,
    isSubtask,
    content: event.event_data.content,
  });

  // Check if this task was previously logged as failed TODAY
  const existingFailure = await checkForFailedTask(
    db,
    event.event_data.content,
    egyptDate
  );

  if (existingFailure) {
    console.log('🔄 Found existing failed task - updating to completed');
    
    // FIXED: Parse with original metadata string
    const metadata = parseTaskMetadata(event.event_data.content);
    console.log('📊 Parsed metadata:', metadata);

    // Extract category from labels
    let category = metadata.category;
    if (!category && event.event_data.labels && event.event_data.labels.length > 0) {
      const firstLabel = event.event_data.labels[0];
      if (firstLabel) {
        category = firstLabel
          .replace(/[^\w\s]/gi, '')
          .replace(/\s+/g, '_')
          .trim()
          .toLowerCase();
      }
    }

    // Update the failed task to completed
    await db.update(
      'tasks',
      { id: op.eq(existingFailure.id as string) },
      {
        status: 'done',
        completed_at: completedAt.toISOString(),
        duration_minutes: metadata.duration_minutes || existingFailure.duration_minutes || 0,
        quantity: metadata.quantity,
        quantity_unit: metadata.quantity_unit,
        category: category || existingFailure.category,
        priority: event.event_data.priority,
        description: event.event_data.description || existingFailure.description,
      }
    );

    console.log('✅ Updated failed task to completed');

    // Update streak if recurring
    if (isRecurring) {
      await updateStreakFromDueDate(
        db,
        event.event_data.content,
        completedAt,
        event.event_data.due?.string || '',
        isSubtask
      );
    }

    // Get updated task
    const updatedTasks = await db.select<Task>('tasks', {
      filter: { id: op.eq(existingFailure.id as string) },
      limit: 1
    });

    return {
      success: true,
      message: `Task updated from failed to completed: ${event.event_data.content}`,
      task: updatedTasks[0],
    };
  }

  // Check for duplicates (non-recurring only)
  if (!isRecurring) {
    const isDuplicate = await checkDuplicate(db, event.event_data.id, completedAt.toISOString());
    if (isDuplicate) {
      console.log('⚠️ Duplicate task detected');
      return { success: true, message: 'Duplicate task ignored' };
    }
  }

  // FIXED: Parse metadata (supports Arabic comma)
  const metadata = parseTaskMetadata(event.event_data.content);
  console.log('📊 Parsed metadata:', metadata);

  // Extract category from labels
  let category = metadata.category;
  if (!category && event.event_data.labels && event.event_data.labels.length > 0) {
    const firstLabel = event.event_data.labels[0];
    if (firstLabel) {
      category = firstLabel
        .replace(/[^\w\s]/gi, '')
        .replace(/\s+/g, '_')
        .trim()
        .toLowerCase();
    }
  }

  const task: Task = {
    task_id: event.event_data.id,
    content: event.event_data.content,
    category: category,
    priority: event.event_data.priority,
    description: event.event_data.description || undefined,
    completed_at: completedAt,
    duration_minutes: metadata.duration_minutes || 0,
    quantity: metadata.quantity,
    quantity_unit: metadata.quantity_unit,
    is_origin: isRecurring && !isSubtask,
    origin_task: isSubtask ? event.event_data.parent_id : undefined,
    status: 'done',
  };

  try {
    let savedTask: Task | undefined;

    if (isRecurring) {
      // For recurring tasks, create unique ID with timestamp
      const uniqueTaskId = `${event.event_data.id}_${completedAt.getTime()}`;

      console.log('🔄 Recurring task - unique ID:', uniqueTaskId);

      const inserted = await db.insert<Task>('tasks', {
        ...task,
        task_id: uniqueTaskId,
        created_at: new Date().toISOString(),
      });
      savedTask = inserted[0];

      // Update streak
      await updateStreakFromDueDate(
        db,
        task.content,
        completedAt,
        event.event_data.due?.string || '',
        isSubtask
      );
    } else {
      console.log('📝 Non-recurring task');

      const inserted = await db.insert<Task>('tasks', {
        ...task,
        created_at: new Date().toISOString(),
      });
      savedTask = inserted[0];
    }

    // If this is a subtask, update parent status
    if (isSubtask && event.event_data.parent_id) {
      console.log('🔗 Updating parent task status...');
      await updateParentTaskStatus(db, event.event_data.parent_id);
    }

    if (!savedTask) {
      throw new Error('Failed to save task - no data returned');
    }

    console.log('✅ Task saved successfully');

    return {
      success: true,
      message: `Task completed: ${task.content}`,
      task: savedTask,
    };
  } catch (error) {
    console.error('❌ Failed to save task:', error);
    logError(error as Error, {
      operation: 'handleTodoistWebhook',
      additionalInfo: { 
        taskId: task.task_id, 
        isRecurring,
        completedAt: completedAt.toISOString()
      },
    });
    throw error;
  }
}

/**
 * Check if a task was previously logged as failed today
 */
async function checkForFailedTask(
  db: SupabaseClient,
  content: string,
  egyptDate: string
): Promise<Task | null> {
  try {
    const allTasks = await db.select<Task>('tasks', {});

    for (const task of allTasks) {
      if (task.content !== content) continue;
      if (task.status !== 'failed') continue;

      const taskEgyptDate = getEgyptDateString(new Date(task.completed_at));
      if (taskEgyptDate === egyptDate) {
        console.log('🔍 Found existing failed task:', task.id);
        return task;
      }
    }

    return null;
  } catch (error) {
    console.error('Error checking for failed task:', error);
    return null;
  }
}

/**
 * Update parent task status based on subtasks
 */
async function updateParentTaskStatus(
  db: SupabaseClient,
  parentId: string
): Promise<void> {
  try {
    const subtasks = await db.select<Task>('tasks', {
      filter: { origin_task: op.eq(parentId) },
    });

    if (subtasks.length === 0) {
      console.log('ℹ️ No subtasks found for parent');
      return;
    }

    const doneCount = subtasks.filter(t => t.status === 'done').length;
    const totalCount = subtasks.length;

    let parentStatus: 'done' | 'partial' | 'failed';
    
    if (doneCount === totalCount) {
      parentStatus = 'done';
      console.log(`✅ Parent ${parentId}: All subtasks complete`);
    } else if (doneCount > 0) {
      parentStatus = 'partial';
      console.log(`⚠️ Parent ${parentId}: ${doneCount}/${totalCount} subtasks done`);
    } else {
      parentStatus = 'failed';
      console.log(`❌ Parent ${parentId}: No subtasks completed`);
    }

    await db.update(
      'tasks',
      { task_id: op.eq(parentId) },
      { status: parentStatus }
    );

    console.log(`✅ Updated parent ${parentId}: ${parentStatus}`);

  } catch (error) {
    console.error('❌ Failed to update parent status:', error);
  }
}

/**
 * Update streak with Egypt timezone
 */
async function updateStreakFromDueDate(
  db: SupabaseClient,
  taskName: string,
  completedAt: Date,
  dueString: string,
  isSubtask: boolean = false
): Promise<void> {
  try {
    const streakKey = isSubtask ? `${taskName} [subtask]` : taskName;
    
    const streakType = determineStreakType(dueString);
    const weeklyPattern = extractWeeklyPattern(dueString);

    const completedDateStr = getEgyptDateString(completedAt);

    console.log('🔥 Updating streak:', {
      task: streakKey,
      egyptDate: completedDateStr,
      utcDate: completedAt.toISOString(),
      streakType,
      weeklyPattern,
    });

    const existing = await db.select('streaks', {
      filter: { task_name: op.eq(streakKey) },
      limit: 1,
    });

    if (existing.length === 0) {
      await db.insert('streaks', {
        task_name: streakKey,
        current_streak: 1,
        best_streak: 1,
        last_completed_date: completedDateStr,
        streak_type: streakType,
        weekly_pattern: weeklyPattern,
        updated_at: new Date().toISOString(),
      });
      
      console.log(`🔥 New streak: "${streakKey}" = 1`);
      return;
    }

    const streak = existing[0];
    const lastDate = new Date(streak.last_completed_date + 'T00:00:00Z');
    lastDate.setHours(0, 0, 0, 0);
    
    const currentDate = new Date(completedDateStr + 'T00:00:00Z');
    currentDate.setHours(0, 0, 0, 0);

    if (lastDate.getTime() === currentDate.getTime()) {
      console.log('ℹ️ Same Egypt day - no streak update');
      return;
    }

    let newStreak: number;

    if (streakType === 'daily') {
      const daysDiff = Math.floor((currentDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
      
      if (daysDiff === 1) {
        newStreak = streak.current_streak + 1;
        console.log(`🔥 Streak +1: "${streakKey}" = ${newStreak}`);
      } else {
        newStreak = 1;
        console.log(`💔 Streak reset: "${streakKey}"`);
      }
    } else {
      const dayOfWeek = currentDate.getDay();
      const expectedDays = weeklyPattern ? weeklyPattern.split(',').map(d => parseInt(d)) : [];
      
      if (expectedDays.length === 0 || expectedDays.includes(dayOfWeek)) {
        const daysDiff = Math.floor((currentDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
        
        if (daysDiff <= 7 && daysDiff > 0) {
          newStreak = streak.current_streak + 1;
          console.log(`🔥 Streak +1: "${streakKey}" = ${newStreak}`);
        } else if (daysDiff > 7) {
          newStreak = 1;
          console.log(`💔 Streak reset: "${streakKey}"`);
        } else {
          return;
        }
      } else {
        return;
      }
    }

    const newBestStreak = Math.max(streak.best_streak, newStreak);

    await db.update(
      'streaks',
      { task_name: op.eq(streakKey) },
      {
        current_streak: newStreak,
        best_streak: newBestStreak,
        last_completed_date: completedDateStr,
        streak_type: streakType,
        weekly_pattern: weeklyPattern,
        updated_at: new Date().toISOString(),
      }
    );
    
    console.log('✅ Streak updated in database');
  } catch (error) {
    console.error('❌ Streak update failed:', error);
  }
}

function determineStreakType(dueString: string): 'daily' | 'weekly' {
  const lower = dueString.toLowerCase();
  return (lower.includes('every day') || lower.includes('daily')) ? 'daily' : 'weekly';
}

function extractWeeklyPattern(dueString: string): string | undefined {
  const lower = dueString.toLowerCase();
  
  const dayMap: { [key: string]: number } = {
    'sun': 0, 'sunday': 0,
    'mon': 1, 'monday': 1,
    'tue': 2, 'tuesday': 2,
    'wed': 3, 'wednesday': 3,
    'thu': 4, 'thursday': 4,
    'fri': 5, 'friday': 5,
    'sat': 6, 'saturday': 6,
  };
  
  const days: number[] = [];
  
  for (const [dayName, dayNum] of Object.entries(dayMap)) {
    if (lower.includes(dayName)) {
      days.push(dayNum);
    }
  }
  
  return days.length > 0 ? days.sort().join(',') : undefined;
}

async function checkDuplicate(
  db: SupabaseClient,
  taskId: string,
  completedAt: string
): Promise<boolean> {
  try {
    const completedDate = new Date(completedAt);
    const windowStart = new Date(completedDate.getTime() - 20 * 60 * 1000);
    const windowEnd = new Date(completedDate.getTime() + 20 * 60 * 1000);

    const existing = await db.select('tasks', {
      columns: 'id,completed_at',
      filter: {
        task_id: op.eq(taskId),
        completed_at: op.gte(windowStart.toISOString()),
      },
      limit: 1,
    });

    if (existing.length > 0) {
      const existingDate = new Date(existing[0].completed_at);
      return existingDate <= windowEnd;
    }

    return false;
  } catch (error) {
    console.error('Duplicate check failed:', error);
    return false;
  }
}

/**
 * COMPLETELY FIXED: Send notification with FULL HIERARCHY
 * - Main task + ALL subtasks (completed/failed)
 * - Only original metadata from brackets
 * - No duplicates
 */
export async function sendTaskNotification(
  task: Task,
  chatId: string,
  botToken: string,
  db: SupabaseClient
): Promise<void> {
  try {
    console.log('📤 Preparing hierarchical notification...');
    
    let message = '';

    // CRITICAL: Get hierarchy info
    let mainTask: Task | null = null;
    let subtasks: Task[] = [];

    if (task.is_origin === false && task.origin_task) {
      // This is a subtask - get parent and siblings
      const parentTasks = await db.select<Task>('tasks', {
        filter: { task_id: op.eq(task.origin_task) },
        limit: 1
      });

      if (parentTasks.length > 0) {
        mainTask = parentTasks[0] || null;
      }

      // Get all subtasks
      subtasks = await db.select<Task>('tasks', {
        filter: { origin_task: op.eq(task.origin_task) }
      });

    } else {
      // This is a main task - get children
      mainTask = task;
      subtasks = await db.select<Task>('tasks', {
        filter: { origin_task: op.eq(task.task_id) }
      });
    }

    // Format message with full hierarchy
    if (mainTask) {
      const mainSymbol = getTaskSymbol(mainTask);
      const mainMetadata = getOriginalMetadataString(mainTask.content);
      
      message = `${mainSymbol} ${mainTask.content.replace(/\[([^\]]+)\]/, '').trim()} ${mainMetadata}\n`;

      // Add description if exists
      if (mainTask.description) {
        message += `📝 ${mainTask.description}\n`;
      }

      // Add streak if exists
      const streaks = await db.select<Streak>('streaks', {
        filter: { task_name: op.eq(mainTask.content) },
        limit: 1,
      });
      
      if (streaks.length > 0 && streaks[0] && streaks[0].current_streak > 1) {
        message += `🔥 السلسلة: ${formatArabicStreak(streaks[0].current_streak)}\n`;
      }

      // Add subtasks
      if (subtasks.length > 0) {
        for (const sub of subtasks) {
          const subSymbol = sub.status === 'done' ? '✓' : '✕';
          const subMetadata = getOriginalMetadataString(sub.content);
          message += `${subSymbol} ${sub.content.replace(/\[([^\]]+)\]/, '').trim()} ${subMetadata}\n`;
        }
      }
    }

    console.log('📨 Sending hierarchical notification...');

    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Telegram API error:', error);
    } else {
      console.log('✅ Hierarchical notification sent successfully');
    }
  } catch (error) {
    console.error('❌ Notification failed:', error);
  }
}

/**
 * Get correct symbol for task
 */
function getTaskSymbol(task: Task): string {
  if (task.is_origin === false) {
    return task.status === 'done' ? '✓' : '✕';
  } else {
    if (task.status === 'done') return '✅';
    if (task.status === 'partial') return '⚠️';
    return '❌';
  }
}