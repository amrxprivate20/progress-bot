// ============================================
// Todoist Webhook Handler - COMPLETELY FIXED
// ============================================
// CRITICAL FIXES APPLIED:
// 1. Streak update: Convert completedAt to Date explicitly
// 2. Failed subtasks: Better parent matching logic
// 3. Notification: Show ALL subtasks (completed + failed)
// 4. Report integration: Complete JSON failure integration
// ============================================

import type { SupabaseClient } from '../database/client';
import { SETTINGS_KEYS, SettingsManager } from '../database/settings';
import type { TodoistWebhookEvent, Task, Streak } from '../types';
import { op } from '../database/client';
import { logError } from '../utils/errors';
import {
  syncFailuresForDate,
  getDailyFailures,
  wasTaskFailedToday,
  removeFromFailedTasks,
  type FailedTask,
} from '../services/failure-manager';
import {
  parseTaskMetadata,
  extractCleanTaskName,
} from '../utils/task-parser';
import {
  getEgyptDateString,
  getEgyptDayBoundaries,
  formatArabicTime
} from '../utils/timezone';

// ============================================
// Todoist API Types
// ============================================

interface TodoistTask {
  id: string;
  content: string;
  description?: string;
  project_id: string;
  parent_id?: string;
  priority: number;
  labels?: string[];
  due?: {
    date: string;
    is_recurring: boolean;
    string: string;
  };
}

/**
 * Sync parent task from Todoist API and save to database
 */
async function syncParentTaskFromTodoist(
  db: SupabaseClient,
  settings: SettingsManager,
  parentId: string,
  egyptDate: string
): Promise<void> {
  try {
    console.log(`🔍 Checking if parent ${parentId} exists in DB...`);
    
    const existingParent = await db.select<Task>('tasks', {
      filter: { task_id: op.eq(parentId) }
    });

    const recentParent = existingParent.filter(task => {
      const taskEgyptDate = getEgyptDateString(new Date(task.completed_at));
      const dateDiff = Math.abs(
        new Date(egyptDate).getTime() - new Date(taskEgyptDate).getTime()
      ) / (1000 * 60 * 60 * 24);
      return dateDiff <= 2;
    });

    if (recentParent.length > 0) {
      console.log(`✅ Parent already exists in DB (recent)`);
      return;
    }

    console.log(`🌐 Fetching parent task from Todoist API...`);
    
    const todoistToken = await settings.get(SETTINGS_KEYS.TODOIST_API_TOKEN);
    if (!todoistToken) {
      console.error('❌ No Todoist API token - cannot sync parent');
      return;
    }

    const response = await fetch(
      `https://api.todoist.com/rest/v2/tasks/${parentId}`,
      {
        headers: {
          'Authorization': `Bearer ${todoistToken}`,
        },
      }
    );

    if (!response.ok) {
      console.error(`❌ Failed to fetch parent from Todoist: ${response.status}`);
      return;
    }

    const parentTask: TodoistTask = await response.json();
    console.log(`✅ Fetched parent from Todoist: ${parentTask.content}`);

    const metadata = parseTaskMetadata(parentTask.content);

    let category = metadata.category;
    if (!category && parentTask.labels && parentTask.labels.length > 0) {
      const firstLabel = parentTask.labels[0];
      if (firstLabel) {
        category = firstLabel
          .replace(/[^\w\s]/gi, '')
          .replace(/\s+/g, '_')
          .trim()
          .toLowerCase();
      }
    }

    const parentTaskData: Task = {
      task_id: parentId,
      content: parentTask.content,
      category: category,
      priority: parentTask.priority,
      description: parentTask.description || undefined,
      completed_at: new Date(egyptDate + 'T21:59:59Z'),
      duration_minutes: metadata.duration_minutes || 0,
      quantity: metadata.quantity,
      quantity_unit: metadata.quantity_unit,
      is_origin: true,
      origin_task: undefined,
      status: 'failed',
      created_at: new Date(),
    };

    await db.insert<Task>('tasks', parentTaskData);
    console.log(`✅ Created parent task in DB as FAILED with ID: ${parentId}`);

  } catch (error) {
    console.error('❌ Error syncing parent from Todoist:', error);
  }
}

/**
 * Complete parent task in Todoist if all subtasks are done
 */
async function completeParentInTodoistIfAllDone(
  db: SupabaseClient,
  settings: SettingsManager,
  parentId: string,
  egyptDate: string
): Promise<void> {
  try {
    console.log(`🔍 Checking if parent ${parentId} should be completed in Todoist...`);
    
    // Get all subtasks from database
    const subtasks = await db.select<Task>('tasks', {
      filter: { origin_task: op.eq(parentId) },
    });

    // Also check for failed subtasks in JSON
    const dailyFailures = await getDailyFailures(db, egyptDate);
    const failedSubtasks = dailyFailures?.failed_tasks.filter(
      f => f.is_subtask && f.parent_id === parentId
    ) || [];

    console.log(`📊 Parent ${parentId}: ${subtasks.length} DB subtasks, ${failedSubtasks.length} failed subtasks`);

    // If there are ANY failed subtasks, don't complete parent
    if (failedSubtasks.length > 0) {
      console.log(`⚠️ Parent ${parentId} has ${failedSubtasks.length} failed subtasks - not completing in Todoist`);
      return;
    }

    // If all subtasks are done (and none failed), complete parent in Todoist
    const allDone = subtasks.every(t => t.status === 'done');
    
    if (allDone && subtasks.length > 0) {
      console.log(`✅ All subtasks done for parent ${parentId} - completing in Todoist`);
      
      const todoistToken = await settings.get('todoist_api_token');
      if (!todoistToken) {
        console.error('❌ No Todoist token - cannot complete parent');
        return;
      }

      // Complete the parent task in Todoist
      const response = await fetch(
        `https://api.todoist.com/rest/v2/tasks/${parentId}/close`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${todoistToken.trim()}`,
          },
        }
      );

      if (response.ok) {
        console.log(`🎉 Parent task ${parentId} completed in Todoist!`);
      } else {
        const errorText = await response.text();
        console.error(`❌ Failed to complete parent in Todoist: ${response.status} ${errorText}`);
      }
    } else {
      console.log(`ℹ️ Parent ${parentId}: ${subtasks.filter(t => t.status === 'done').length}/${subtasks.length} subtasks done - not completing yet`);
    }
  } catch (error) {
    console.error('❌ Error completing parent in Todoist:', error);
  }
}

/**
 * Main webhook handler
 */
export async function handleTodoistWebhook(
  event: TodoistWebhookEvent,
  db: SupabaseClient,
  settings: SettingsManager
): Promise<{ success: boolean; message: string; task?: Task }> {
  const eventName = event.event_name;
  console.log('🔍 Processing event:', eventName);

  if (eventName !== 'item:completed') {
    return {
      success: true,
      message: `Ignored event: ${eventName}`,
    };
  }

  const expectedProjectId = await settings.get(SETTINGS_KEYS.TODOIST_PROJECT_ID);
  console.log('🎯 Expected project:', expectedProjectId);
  console.log('📦 Task project:', event.event_data.project_id);

  if (event.event_data.project_id !== expectedProjectId) {
    return {
      success: true,
      message: `Ignored task from different project: ${event.event_data.project_id}`,
    };
  }

  // ✅ FIX 1: Ensure completedAt is always a Date object
  const completedAt = new Date();
  const egyptDate = getEgyptDateString(completedAt);

  console.log('⏰ UTC completion timestamp:', completedAt.toISOString());
  console.log('📅 Egypt date:', egyptDate);

  const isRecurring = event.event_data.due?.is_recurring || false;
  const isSubtask = !!event.event_data.parent_id;

  console.log('📋 Task info:', {
    isRecurring,
    isSubtask,
    content: event.event_data.content,
    parent_id: event.event_data.parent_id || 'none',
  });

  if (isSubtask && event.event_data.parent_id) {
    console.log('🔄 Subtask detected - syncing parent from Todoist API...');
    await syncParentTaskFromTodoist(db, settings, event.event_data.parent_id, egyptDate);
  }

  const wasFailedBefore = await wasTaskFailedToday(db, egyptDate, event.event_data.id);
  
  if (wasFailedBefore) {
    console.log('🔄 Task was in failed JSON - removing it');
    await removeFromFailedTasks(db, egyptDate, event.event_data.id);
  }

  const existingFailure = await checkForFailedTask(
    db,
    event.event_data.content,
    egyptDate
  );

  if (existingFailure) {
    console.log('🔄 Found existing failed task - updating to completed');
    
    const metadata = parseTaskMetadata(event.event_data.content);
    
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
        origin_task: isSubtask && event.event_data.parent_id 
          ? event.event_data.parent_id 
          : existingFailure.origin_task,
      }
    );

    console.log('✅ Updated failed task to completed');

    if (isRecurring) {
      await updateStreakFromDueDate(
        db,
        event.event_data.content,
        completedAt, // ✅ Already a Date object
        event.event_data.due?.string || '',
        isSubtask
      );
    }

    if (isSubtask && event.event_data.parent_id) {
  console.log('🔗 Updating parent task status...');
  await updateParentTaskStatus(db, event.event_data.parent_id);
  
  // ✅ NEW: Auto-complete parent in Todoist if all subtasks are done
  await completeParentInTodoistIfAllDone(db, settings, event.event_data.parent_id, egyptDate);
}

    const updatedTasks = await db.select<Task>('tasks', {
      filter: { id: op.eq(existingFailure.id as string) },
      limit: 1
    });

    // ✅ FIX: Await sync so notification has updated failure data
    console.log('🔄 Syncing failures from Todoist...');
    try {
      await syncFailuresFromTodoist(egyptDate, db, settings);
      console.log(`✅ Sync complete - failures updated in JSON`);
    } catch (err) {
      console.error('❌ Sync failed (non-critical):', err);
    }

    return {
      success: true,
      message: `Task updated from failed to completed: ${event.event_data.content}`,
      task: updatedTasks[0],
    };
  }

  // Check for pending timer update FIRST (from /starttask -> /completetask flow)
  // This must happen before duplicate check so we match on correct content
  let taskContent = event.event_data.content;
  let timerDuration = 0;
  const pendingUpdateKey = `pending_update_${event.event_data.id}`;

  console.log('🔍 Looking for pending update with key:', pendingUpdateKey);
  console.log('🔍 Original task content from webhook:', taskContent);

  try {
    // Small delay to ensure pending update record is saved (race condition prevention)
    await new Promise(resolve => setTimeout(resolve, 200));

    const pendingUpdates = await db.select('conversation_state', {
      filter: { chat_id: op.eq(pendingUpdateKey) },
    });

    console.log('📊 Found pending updates:', pendingUpdates.length);

    if (pendingUpdates.length > 0) {
      const pendingData = (pendingUpdates[0] as any).data || {};
      console.log('📦 Pending update data:', JSON.stringify(pendingData));

      if (pendingData.updatedContent) {
        console.log('🔄 Using updated content from timer:', pendingData.updatedContent);
        taskContent = pendingData.updatedContent;
        timerDuration = pendingData.durationMinutes || 0;
      }
      // Clean up the pending update
      await db.delete('conversation_state', { chat_id: op.eq(pendingUpdateKey) });
      console.log('🗑️ Cleaned up pending update record');
    } else {
      console.log('ℹ️ No pending timer update found for this task');
    }
  } catch (err) {
    console.error('❌ Error checking pending update:', err);
  }

  // NOW check for duplicates using the final task content (with updated duration/quantity)
  if (!isRecurring) {
    const isDuplicate = await checkDuplicate(db, event.event_data.id, taskContent, completedAt.toISOString());
    if (isDuplicate) {
      console.log('⚠️ Duplicate task detected - skipping save');
      return { success: true, message: 'Duplicate task ignored' };
    }
  }

  const metadata = parseTaskMetadata(taskContent);
  console.log('📊 Parsed metadata:', metadata);

  let category = metadata.category;
  if (!category && event.event_data.labels && event.event_data.labels.length > 0) {
    const firstLabel = event.event_data.labels[0];
    if (firstLabel) {
      // Remove emojis but keep Arabic/Unicode letters
      // \p{Emoji} matches emojis, keep everything else
      category = firstLabel
        .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '') // Remove emojis
        .replace(/\s+/g, '_')
        .trim();

      // If category is empty or just underscores, use the original label
      if (!category || category === '_' || /^_+$/.test(category)) {
        category = firstLabel.trim();
      }

      console.log('🏷️ Label category:', firstLabel, '->', category);
    }
  }

  const task: Task = {
    task_id: event.event_data.id,
    content: taskContent, // Use updated content if timer was used
    category: category,
    priority: event.event_data.priority,
    description: event.event_data.description || undefined,
    completed_at: completedAt, // ✅ Date object
    duration_minutes: timerDuration || metadata.duration_minutes || 0, // Prefer timer duration
    quantity: metadata.quantity,
    quantity_unit: metadata.quantity_unit,
    is_origin: isRecurring && !isSubtask,
    origin_task: isSubtask ? event.event_data.parent_id : undefined,
    status: 'done',
  };

  try {
    let savedTask: Task | undefined;

    if (isRecurring && !isSubtask) {
      const uniqueTaskId = `${event.event_data.id}_${completedAt.getTime()}`;

      console.log('🔄 Recurring main task - unique ID:', uniqueTaskId);

      const inserted = await db.insert<Task>('tasks', {
        ...task,
        task_id: uniqueTaskId,
        created_at: new Date(),
      });
      savedTask = inserted[0];

      await updateStreakFromDueDate(
        db,
        task.content,
        completedAt, // ✅ Date object
        event.event_data.due?.string || '',
        isSubtask
      );
    } else if (isRecurring && isSubtask) {
      console.log('🔄 Recurring subtask - upserting with original ID:', event.event_data.id);

      const upserted = await db.upsert<Task>(
        'tasks',
        {
          ...task,
          task_id: event.event_data.id,
          created_at: new Date(),
        },
        'task_id'
      );
      savedTask = upserted[0];

      await updateStreakFromDueDate(
        db,
        task.content,
        completedAt, // ✅ Date object
        event.event_data.due?.string || '',
        isSubtask
      );
    } else {
      console.log('📝 Non-recurring task');

      const inserted = await db.insert<Task>('tasks', {
        ...task,
        created_at: new Date(),
      });
      savedTask = inserted[0];
    }

    if (isSubtask && event.event_data.parent_id) {
  console.log('🔗 Updating parent task status...');
  await updateParentTaskStatus(db, event.event_data.parent_id);
  
  // ✅ NEW: Auto-complete parent in Todoist if all subtasks are done
  await completeParentInTodoistIfAllDone(db, settings, event.event_data.parent_id, egyptDate);
}

    if (!savedTask) {
      throw new Error('Failed to save task - no data returned');
    }

    console.log('✅ Task saved successfully');

    // ✅ FIX: Await sync so notification has updated failure data
    console.log('🔄 Syncing failures from Todoist...');
    try {
      await syncFailuresFromTodoist(egyptDate, db, settings);
      console.log(`✅ Sync complete - failures updated in JSON`);
    } catch (err) {
      console.error('❌ Sync failed (non-critical):', err);
    }

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
 * Update parent task status based on ALL subtasks
 */
async function updateParentTaskStatus(
  db: SupabaseClient,
  parentId: string
): Promise<void> {
  try {
    console.log(`🔍 Updating status for parent: ${parentId}`);
    
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
      console.log(`✅ Parent ${parentId}: All ${totalCount} subtasks complete`);
    } else if (doneCount > 0) {
      parentStatus = 'partial';
      console.log(`⚠️ Parent ${parentId}: ${doneCount}/${totalCount} subtasks done`);
    } else {
      parentStatus = 'failed';
      console.log(`❌ Parent ${parentId}: No subtasks completed`);
    }

    const allTasks = await db.select<Task>('tasks', {});
    const parentTasks = allTasks.filter(t => 
      t.task_id === parentId || t.task_id.startsWith(parentId + '_')
    );

    if (parentTasks.length === 0) {
      console.warn(`⚠️ Parent task ${parentId} not found in database`);
      return;
    }

    const latestParent = parentTasks.sort((a, b) => 
      new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime()
    )[0];

    if (!latestParent) {
      console.warn(`⚠️ No valid parent task found`);
      return;
    }

    await db.update(
      'tasks',
      { id: op.eq(latestParent.id as string) },
      { status: parentStatus }
    );

    console.log(`✅ Updated parent ${latestParent.task_id}: ${parentStatus}`);

  } catch (error) {
    console.error('❌ Failed to update parent status:', error);
  }
}

/**
 * ✅ FIX 2: Update streak with proper Date handling
 */
async function updateStreakFromDueDate(
  db: SupabaseClient,
  taskName: string,
  completedAt: Date,
  dueString: string,
  isSubtask: boolean = false
): Promise<void> {
  try {
    // ✅ CRITICAL FIX: Ensure completedAt is a Date
    let completedDate: Date;
    if (completedAt instanceof Date) {
      completedDate = completedAt;
    } else {
      console.warn('⚠️ completedAt was not a Date, converting:', typeof completedAt);
      completedDate = new Date(completedAt);
    }
    
    const streakKey = isSubtask ? `${taskName} [subtask]` : taskName;    
    const streakType = determineStreakType(dueString);
    const weeklyPattern = extractWeeklyPattern(dueString);

    const completedDateStr = getEgyptDateString(completedDate);

    console.log('🔥 Updating streak:', {
      task: streakKey,
      egyptDate: completedDateStr,
      utcDate: completedDate.toISOString(),
      streakType,
      weeklyPattern,
    });

    const existingStreaks = await db.select<Streak>('streaks', {
      filter: { task_name: op.eq(streakKey) }
    });

    if (existingStreaks.length === 0) {
      const newStreak: Streak = {
        task_name: streakKey,
        current_streak: 1,
        best_streak: 1,
        last_completed_date: new Date(completedDateStr),
        streak_type: streakType,
        weekly_pattern: weeklyPattern,
      };

      await db.insert<Streak>('streaks', newStreak);
      console.log(`🔥 New streak: "${streakKey}" = 1`);
      return;
    }

    const existingStreak = existingStreaks[0];
    if (!existingStreak) {
      console.error('❌ No streak found in array');
      return;
    }

    if (!existingStreak.last_completed_date) {
      existingStreak.current_streak = 1;
      existingStreak.best_streak = 1;
      existingStreak.last_completed_date = new Date(completedDateStr);
    } else {
      const lastDate = new Date(existingStreak.last_completed_date);
      const currentDate = new Date(completedDateStr + 'T12:00:00Z');

      const lastDateStr = getEgyptDateString(lastDate);
      if (lastDateStr === completedDateStr) {
        console.log(`Same day completion - no streak change`);
        return;
      }

      if (streakType === 'daily') {
        const diffDays = Math.floor((currentDate.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000));

        if (diffDays === 1) {
          existingStreak.current_streak += 1;
        } else {
          existingStreak.current_streak = 1;
        }
      } else if (streakType === 'weekly' && weeklyPattern) {
        const currentDayOfWeek = currentDate.getDay();
        const patternDays = weeklyPattern.split(',').map(Number);

        if (patternDays.includes(currentDayOfWeek)) {
          const diffWeeks = Math.floor((currentDate.getTime() - lastDate.getTime()) / (7 * 24 * 60 * 60 * 1000));
          
          if (diffWeeks <= 1) {
            existingStreak.current_streak += 1;
          } else {
            existingStreak.current_streak = 1;
          }
        }
      }

      if (existingStreak.current_streak > existingStreak.best_streak) {
        existingStreak.best_streak = existingStreak.current_streak;
      }

      existingStreak.last_completed_date = new Date(completedDateStr);
    }

    await db.update<Streak>(
      'streaks',
      { task_name: op.eq(streakKey) },
      {
        current_streak: existingStreak.current_streak,
        best_streak: existingStreak.best_streak,
        last_completed_date: existingStreak.last_completed_date,
        streak_type: streakType,
        weekly_pattern: weeklyPattern,
        updated_at: new Date().toISOString()
      }
    );

    console.log(`🔥 Updated streak: "${streakKey}" = ${existingStreak.current_streak}`);
  } catch (error) {
    console.error('Failed to update streak:', error);
  }
}

function determineStreakType(dueString: string): 'daily' | 'weekly' {
  const lower = dueString.toLowerCase();
  
  if (lower.includes('every day') || lower.includes('daily')) {
    return 'daily';
  }
  
  if (lower.includes('ev')) {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    for (const day of days) {
      if (lower.includes(day)) {
        return 'weekly';
      }
    }
  }
  
  return 'daily';
}

function extractWeeklyPattern(dueString: string): string | undefined {
  const lower = dueString.toLowerCase();
  
  const dayMap: Record<string, number> = {
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
  taskContent: string,
  completedAt: string
): Promise<boolean> {
  try {
    const completedDate = new Date(completedAt);
    const windowStart = new Date(completedDate.getTime() - 20 * 60 * 1000);
    const windowEnd = new Date(completedDate.getTime() + 20 * 60 * 1000);

    // Get clean task name for matching (remove all [...] parameters)
    const cleanName = extractCleanTaskName(taskContent);
    console.log('🔍 Checking duplicate for clean name:', cleanName);

    // Get all tasks in the time window
    const recentTasks = await db.select<{ id: number; task_id: string; content: string; completed_at: string }>('tasks', {
      columns: 'id,task_id,content,completed_at',
      filter: {
        completed_at: op.gte(windowStart.toISOString()),
      },
      limit: 50,
    });

    // Check for duplicates by CLEAN NAME (not task ID)
    for (const existing of recentTasks) {
      const existingCleanName = extractCleanTaskName(existing.content);
      const existingDate = new Date(existing.completed_at);

      if (existingCleanName === cleanName && existingDate <= windowEnd) {
        console.log('⚠️ Found duplicate by clean name:', existingCleanName, 'existing task_id:', existing.task_id);
        return true;
      }
    }

    // Also check by task ID (original logic)
    const existingById = recentTasks.find(t => t.task_id === taskId);
    if (existingById) {
      const existingDate = new Date(existingById.completed_at);
      if (existingDate <= windowEnd) {
        console.log('⚠️ Found duplicate by task ID:', taskId);
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error('Duplicate check failed:', error);
    return false;
  }
}

/**
 * Sync failures from Todoist
 */
export async function syncFailuresFromTodoist(
  egyptDate: string,
  db: SupabaseClient,
  settings: SettingsManager
): Promise<void> {
  console.log('🔍 Syncing with Todoist for date:', egyptDate);

  try {
    const todoistToken = await settings.get(SETTINGS_KEYS.TODOIST_API_TOKEN);
    const projectId = await settings.get(SETTINGS_KEYS.TODOIST_PROJECT_ID);
    const priorityThresholdStr = await settings.get('failure_priority_threshold');
    const priorityThreshold = priorityThresholdStr ? parseInt(priorityThresholdStr) : 2;

    if (!todoistToken || !projectId) {
      throw new Error('Missing Todoist credentials');
    }

    const { start, end } = getEgyptDayBoundaries(egyptDate);

    console.log('⏰ Egypt day boundaries (UTC):');
    console.log('   Start:', start.toISOString());
    console.log('   End:', end.toISOString());
    console.log('🎯 Priority threshold: P1-P' + priorityThreshold);

    const response = await fetch(
      `https://api.todoist.com/rest/v2/tasks?project_id=${projectId}`,
      {
        headers: {
          Authorization: `Bearer ${todoistToken}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Todoist API error: ${response.status}`);
    }

    const allTasks: TodoistTask[] = await response.json();
    console.log(`📋 Found ${allTasks.length} tasks in Todoist project`);

    const recurringTasks = allTasks.filter((task: any) => {
      if (!task.due?.is_recurring) return false;
      const dueDate = new Date(task.due.date);
      return dueDate >= start && dueDate <= end;
    });

    console.log(`🔄 Found ${recurringTasks.length} recurring tasks due on ${egyptDate}`);

    const completedTasks = await db.select<Task>('tasks', {});
    const completedTaskIds = new Set(
      completedTasks
        .filter(t => {
          const taskDate = getEgyptDateString(new Date(t.completed_at));
          return taskDate === egyptDate && t.status === 'done' && t.task_id;
        })
        .map(t => t.task_id.split('_')[0])
        .filter((id): id is string => id !== undefined)
    );

    console.log(`✅ Found ${completedTaskIds.size} tasks completed on ${egyptDate}`);

    await syncFailuresForDate(
      db,
      egyptDate,
      recurringTasks,
      completedTaskIds,
      priorityThreshold,
      allTasks  // Pass all tasks for parent lookup
    );

  } catch (error) {
    console.error('❌ Error syncing failures from Todoist:', error);
    throw error;
  }
}

/**
 * ✅ FIX 3: FIXED - NAME-BASED notification with ALL subtasks
 * 
 * WHAT CHANGED:
 * - Old: Matched failed subtasks by parent_id (IDs change daily!)
 * - New: Matches by parent_content (names are stable!)
 * 
 * HOW IT WORKS:
 * 1. Get main task (completed or parent)
 * 2. Get completed subtasks from DB (by origin_task relationship)
 * 3. Get failed subtasks from JSON BY MATCHING CLEAN NAMES ✅ NEW!
 * 4. Build notification with ALL subtasks
 */
export async function sendTaskNotification(
  task: Task,
  chatId: string,
  botToken: string,
  db: SupabaseClient
): Promise<void> {
  try {
    console.log('📤 Sending notification to:', chatId);
    console.log('📤 Building complete hierarchy...');
    
    let message = '';
    let mainTask: Task | null = null;
    let completedSubtasks: Task[] = [];
    const failedSubtasks: FailedTask[] = [];

    // ✅ FIX: Ensure we use Date object for Egypt date
    const completedAtDate = task.completed_at instanceof Date 
      ? task.completed_at 
      : new Date(task.completed_at);
    const egyptDate = getEgyptDateString(completedAtDate);

    // STEP 1: Determine parent task
    if (task.origin_task) {
      console.log(`🔍 Subtask completed, finding parent: ${task.origin_task}`);
      
      const allTasks = await db.select<Task>('tasks', {});
      const parentTasks = allTasks.filter(t => 
        t.task_id === task.origin_task || t.task_id?.startsWith(task.origin_task + '_')
      );

      if (parentTasks.length > 0) {
        mainTask = parentTasks.sort((a, b) => 
          new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime()
        )[0] || null;
        
        console.log(`✅ Found parent in DB: ${mainTask?.content}`);
      }
    } else {
      console.log(`📌 Main task completed: ${task.content}`);
      mainTask = task;
    }

    if (!mainTask) {
      mainTask = task;
    }

    // STEP 2: Get completed subtasks from DATABASE - FILTERED BY DATE
if (mainTask) {
  const parentId = task.origin_task || task.task_id;
  const parentBaseId = parentId.split('_')[0];
  
  const allTasks = await db.select<Task>('tasks', {});
  completedSubtasks = allTasks.filter(t => {
    if (!t.origin_task) return false;
    const originBase = t.origin_task.split('_')[0];
    
    // ✅ NEW: Only include subtasks from the same Egypt date
    const subtaskDate = getEgyptDateString(new Date(t.completed_at));
    const mainTaskDate = getEgyptDateString(completedAtDate);
    
    return originBase === parentBaseId && subtaskDate === mainTaskDate;
  });
      
      console.log(`📋 Found ${completedSubtasks.length} completed subtasks in DB`);
    }

   // ✅ STEP 3: Get failed subtasks from JSON - NAME-BASED MATCHING
    if (mainTask) {
      const parentId = mainTask.task_id;
      const parentBaseId = parentId.split('_')[0];
      
      // ✅ NEW: Extract clean name for matching
      const mainTaskCleanName = extractCleanTaskName(mainTask.content);
      
      console.log(`📊 Fetching failed subtasks for parent: "${mainTaskCleanName}"`);
      console.log(`   (ID: ${parentId}, base: ${parentBaseId})`);
      
      try {
        const dailyFailures = await getDailyFailures(db, egyptDate);
        
        if (dailyFailures) {
          // ✅ NEW: Match by CLEAN NAME instead of ID
          for (const failed of dailyFailures.failed_tasks) {
            if (!failed.is_subtask || !failed.parent_content) continue;
            
            // Clean the parent name from JSON
            const failedParentCleanName = extractCleanTaskName(failed.parent_content);
            
            // ✅ CRITICAL: Match by NAME, not ID!
            if (failedParentCleanName === mainTaskCleanName) {
              failedSubtasks.push(failed);
              console.log(`  ✕ Matched failed subtask: ${failed.content}`);
              console.log(`     (parent name: "${failedParentCleanName}" === "${mainTaskCleanName}" ✅)`);
            }
          }
        }
        
        console.log(`📊 Found ${failedSubtasks.length} failed subtasks`);
        
      } catch (error) {
        console.error('❌ Error fetching failed subtasks:', error);
      }
    }

    console.log(`📊 Summary: ${completedSubtasks.length} completed, ${failedSubtasks.length} failed`);

    // STEP 4: Build notification message (unchanged)
    const totalSubtasks = completedSubtasks.length + failedSubtasks.length;

    // Helper to clean task name (remove all metadata)
    const cleanTaskName = (content: string): string => {
      return content
        .replace(/\[([^\]]+)\]/g, '') // Remove brackets
        .replace(/❗/g, '') // Remove origin marker
        .replace(/\(origin:[^)]+\)/gi, '') // Remove origin reference
        .trim();
    };

    // === SIMPLIFIED NOTIFICATION FORMAT ===
    // Line 1: symbol + task name [duration] [quantity] [streak]
    // Line 2: description (if any)
    // Then: subtasks (if any)

    const displayTask = mainTask;
    const symbol = totalSubtasks === 0
      ? (mainTask.status === 'done' ? '✅' : '❌')
      : (failedSubtasks.length === 0 ? '✅' : (completedSubtasks.length === 0 ? '❌' : '⚠️'));

    const cleanName = cleanTaskName(mainTask.content);

    // Build first line: name + metadata inline
    let firstLine = `${symbol} ${cleanName}`;

    // Add duration if present
    if (displayTask.duration_minutes && displayTask.duration_minutes > 0) {
      firstLine += ` [${formatArabicTime(displayTask.duration_minutes)}]`;
    }

    // Add quantity if present
    if (displayTask.quantity && displayTask.quantity_unit) {
      firstLine += ` [${displayTask.quantity} ${displayTask.quantity_unit}]`;
    }

    // Add streak if present
    const streakName = task.content + (task.origin_task ? ' [subtask]' : '');
    const streaks = await db.select('streaks', { filter: { task_name: op.eq(streakName) } });

    if (streaks && streaks.length > 0) {
      const streak = streaks[0];
      if (streak.current_streak > 1) {
        const isRecord = streak.current_streak === streak.best_streak;
        firstLine += ` [🔥${streak.current_streak}${isRecord ? '🎉' : ''}]`;
      }
    }

    message = firstLine;

    // Line 2: description (if any)
    if (displayTask.description) {
      message += `\n📝 ${displayTask.description}`;
    }

    // Subtasks (if any)
    if (totalSubtasks > 0) {
      // Completed subtasks
      for (const sub of completedSubtasks) {
        const subClean = cleanTaskName(sub.content);
        message += `\n  ✓ ${subClean}`;
      }

      // Failed subtasks
      for (const sub of failedSubtasks) {
        const subClean = cleanTaskName(sub.content);
        message += `\n  ✗ ${subClean}`;
      }
    }

    // Send notification
    console.log('📨 Sending notification:');
    console.log(message);

    await sendTelegramMessage(botToken, chatId, message);
    console.log('✅ Notification sent successfully');
  } catch (error) {
    console.error('❌ Error sending notification:', error);
    throw error;
  }
}
async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string
): Promise<void> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Telegram API error:', error);
    }
  } catch (error) {
    console.error('💥 Failed to send Telegram message:', error);
    throw error;
  }
}
