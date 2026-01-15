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
  getOriginalMetadataString,
  extractCleanTaskName, 
} from '../utils/task-parser';
import { 
  getEgyptDateString, 
  getEgyptDayBoundaries,
  formatArabicStreak,
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
    }

    const updatedTasks = await db.select<Task>('tasks', {
      filter: { id: op.eq(existingFailure.id as string) },
      limit: 1
    });

    // ✅ FIX: Trigger background sync to rebuild failed JSON
    console.log('🔄 Triggering background Todoist sync...');
    syncFailuresFromTodoist(egyptDate, db, settings).then(() => {
      console.log(`✅ Background sync complete - failures updated in JSON`);
    }).catch(err => {
      console.error('❌ Background sync failed (non-critical):', err);
    });

    return {
      success: true,
      message: `Task updated from failed to completed: ${event.event_data.content}`,
      task: updatedTasks[0],
    };
  }

  if (!isRecurring) {
    const isDuplicate = await checkDuplicate(db, event.event_data.id, completedAt.toISOString());
    if (isDuplicate) {
      console.log('⚠️ Duplicate task detected');
      return { success: true, message: 'Duplicate task ignored' };
    }
  }

  const metadata = parseTaskMetadata(event.event_data.content);
  console.log('📊 Parsed metadata:', metadata);

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
    completed_at: completedAt, // ✅ Date object
    duration_minutes: metadata.duration_minutes || 0,
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
    }

    if (!savedTask) {
      throw new Error('Failed to save task - no data returned');
    }

    console.log('✅ Task saved successfully');

    console.log('🔄 Triggering background Todoist sync...');
    
    syncFailuresFromTodoist(egyptDate, db, settings).then(() => {
      console.log(`✅ Background sync complete - failures updated in JSON`);
    }).catch(err => {
      console.error('❌ Background sync failed (non-critical):', err);
    });

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
      priorityThreshold
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

    // STEP 2: Get completed subtasks from DATABASE (unchanged)
    if (mainTask) {
      const parentId = task.origin_task || task.task_id;
      const parentBaseId = parentId.split('_')[0];
      
      const allTasks = await db.select<Task>('tasks', {});
      completedSubtasks = allTasks.filter(t => {
        if (!t.origin_task) return false;
        const originBase = t.origin_task.split('_')[0];
        return originBase === parentBaseId;
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

    if (totalSubtasks === 0) {
      // No subtasks - simple task
      const symbol = mainTask.status === 'done' ? '✅' : '❌';
      const cleanName = cleanTaskName(mainTask.content);
      const metadata = getOriginalMetadataString(mainTask.content);
      
      message = `${symbol} ${cleanName}`;
      if (metadata) {
        message += ` ${metadata}`;
      }
    } else {
      // Has subtasks - determine parent symbol
      const allComplete = failedSubtasks.length === 0;
      const allFailed = completedSubtasks.length === 0;
      
      let symbol: string;
      if (allComplete) {
        symbol = '✅';
      } else if (allFailed) {
        symbol = '❌';
      } else {
        symbol = '⚠️';
      }
      
      // Clean parent name but keep metadata separate
      const cleanName = cleanTaskName(mainTask.content);
      const metadata = getOriginalMetadataString(mainTask.content);
      
      message = `${symbol} ${cleanName}`;
      if (metadata) {
        message += ` ${metadata}`;
      }
      message += '\n';
      
      // Add completed subtasks (cleaned)
      for (const sub of completedSubtasks) {
        const subClean = cleanTaskName(sub.content);
        const subMetadata = getOriginalMetadataString(sub.content);
        
        message += `\n✓ ${subClean}`;
        if (subMetadata) {
          message += ` ${subMetadata}`;
        }
      }
      
      // Add failed subtasks (cleaned)
      for (const sub of failedSubtasks) {
        const subClean = cleanTaskName(sub.content);
        message += `\n✕ ${subClean}`;
      }
    }

    // Add task details
    const displayTask = mainTask;
    
    if (displayTask.description) {
      message += `\n\n📝 ${displayTask.description}`;
    }

    if (displayTask.duration_minutes && displayTask.duration_minutes > 0) {
      message += `\n\n⏱ المدة: ${formatArabicTime(displayTask.duration_minutes)}`;
    }

    if (displayTask.quantity && displayTask.quantity_unit) {
      message += `\n📊 الكمية: ${displayTask.quantity} ${displayTask.quantity_unit}`;
    }

    if (displayTask.category) {
      message += `\n🏷 الفئة: ${displayTask.category}`;
    }

    // Add streak info
    const streakName = task.content + (task.origin_task ? ' [subtask]' : '');
    const streaks = await db.select('streaks', { filter: { task_name: op.eq(streakName) } });
    
    if (streaks && streaks.length > 0) {
      const streak = streaks[0];
      if (streak.current_streak > 0) {
        message += '\n\n🔥 السلسلة:\n';
        message += `النوع: ${streak.streak_type === 'daily' ? 'يومية' : 'أسبوعية'}\n`;
        message += `المدة: ${formatArabicStreak(streak.current_streak)}`;
        
        if (streak.current_streak === streak.best_streak && streak.current_streak > 1) {
          message += ' 🎉 (رقم قياسي جديد!)';
        }
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