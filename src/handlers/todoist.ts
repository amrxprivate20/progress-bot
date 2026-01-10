// ============================================
// Todoist Webhook Handler - UPDATED VERSION
// ============================================
// FIXES APPLIED:
// - Egypt timezone (UTC+2) for streak calculation
// - Arabic duration/unit parsing ([30د], [3س], [50 ورقة])
// - Parent-child status tracking (complete/partial/failed)
// - Enhanced notifications with description and Arabic streaks
// - Proper Arabic plural rules
// - NEW: Updates failed tasks instead of creating duplicates
// ============================================

import type { SupabaseClient } from '../database/client';
import type { SettingsManager } from '../database/settings';
import type { TodoistWebhookEvent, Task, Streak } from '../types';
import { op } from '../database/client';
import { SETTINGS_KEYS } from '../database/settings';
import { logError } from '../utils/errors';
import { parseTaskMetadata } from '../utils/task-parser';
import { 
  getEgyptDateString, 
  formatArabicStreak
} from '../utils/timezone';

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

  // Get completion time - use completed_at or fallback to now
  let completedAtString = event.event_data.completed_at || new Date().toISOString();
  
  console.log('⏰ UTC completion timestamp:', completedAtString);
  
  const completedAt = new Date(completedAtString);
  
  // FIXED: Log Egypt date for debugging
  const egyptDate = getEgyptDateString(completedAt);
  console.log('📅 Egypt date:', egyptDate);

  const isRecurring = event.event_data.due?.is_recurring || false;
  const isSubtask = !!event.event_data.parent_id;

  console.log('📋 Task info:', {
    isRecurring,
    isSubtask,
    content: event.event_data.content,
  });

  // NEW: Check if this task was previously logged as failed TODAY
  const existingFailure = await checkForFailedTask(
    db,
    event.event_data.content,
    egyptDate
  );

  if (existingFailure) {
    console.log('🔄 Found existing failed task - updating to completed');
    
    // FIXED: Parse task metadata with Arabic support
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

  // FIXED: Parse task metadata with Arabic support
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

      // FIXED: Update streak (uses Egypt timezone internally)
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

    // NEW: If this is a subtask, update parent status
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
 * NEW: Check if a task was previously logged as failed today
 */
async function checkForFailedTask(
  db: SupabaseClient,
  content: string,
  egyptDate: string
): Promise<Task | null> {
  try {
    // Get all tasks
    const allTasks = await db.select<Task>('tasks', {});

    // Filter for tasks with matching content, status=failed, and same Egypt date
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
 * NEW: Update parent task status based on subtasks
 */
async function updateParentTaskStatus(
  db: SupabaseClient,
  parentId: string
): Promise<void> {
  try {
    // Get all subtasks for this parent
    const subtasks = await db.select<Task>('tasks', {
      filter: { origin_task: op.eq(parentId) },
    });

    if (subtasks.length === 0) {
      console.log('ℹ️ No subtasks found for parent');
      return;
    }

    // Count statuses
    const doneCount = subtasks.filter(t => t.status === 'done').length;
    const totalCount = subtasks.length;

    // Determine parent status
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

    // Update parent task
    await db.update(
      'tasks',
      { task_id: op.eq(parentId) },
      { status: parentStatus }
    );

    console.log(`✅ Updated parent ${parentId}: ${parentStatus}`);

  } catch (error) {
    console.error('❌ Failed to update parent status:', error);
    // Don't throw - this is not critical
  }
}

/**
 * FIXED: Update streak with Egypt timezone (UTC+2)
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

    // FIXED: Convert to Egypt time for date calculation
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

    // Same day in Egypt - no update
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
 * ENHANCED: Send Telegram notification with full details and Arabic streak
 */
export async function sendTaskNotification(
  task: Task,
  chatId: string,
  botToken: string,
  db: SupabaseClient
): Promise<void> {
  try {
    console.log('📤 Preparing notification for chat:', chatId);
    
    // Get streak info
    const streaks = await db.select<Streak>('streaks', {
      filter: { task_name: op.eq(task.content) },
      limit: 1,
    });
    
    const streak = streaks.length > 0 ? streaks[0] : undefined;
    
    const message = formatTaskNotification(task, streak);
    
    const payload = {
      chat_id: chatId,
      text: message,
    };

    console.log('📨 Sending to Telegram API...');

    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Telegram API error:', error);
    } else {
      console.log('✅ Notification sent successfully');
    }
  } catch (error) {
    console.error('❌ Notification failed:', error);
  }
}

/**
 * ENHANCED: Format notification message with all details
 * Uses 3-line format: task name + duration/quantity, description, streak
 */
function formatTaskNotification(task: Task, streak?: Streak): string {
  // Line 1: Task name with duration and quantity
  let line1 = `${getTaskSymbol(task)} ${task.content}`;
  
  if (task.duration_minutes) {
    line1 += ` [${task.duration_minutes}m]`;
  }
  
  if (task.quantity) {
    line1 += ` [${task.quantity} ${task.quantity_unit || ''}]`;
  }
  
  let message = line1;
  
  // Line 2: Description (if exists)
  if (task.description && task.description.trim().length > 0) {
    message += `\n📝 ${task.description}`;
  }
  
  // Line 3: Streak (if exists and active and streak > 1)
  if (streak && streak.current_streak > 1) {
    message += `\n🔥 السلسلة: ${formatArabicStreak(streak.current_streak)}`;
  }
  
  return message;
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