// ============================================
// Todoist Webhook Handler - COMPLETE FIX v5
// ============================================
// CRITICAL FIXES v5:
// 1. Sync parent task from Todoist API BEFORE saving subtask
// 2. Create parent as "failed" if it doesn't exist
// 3. Update parent to "partial" when first subtask completes
// 4. Update parent to "done" when all subtasks complete
// 5. Show complete hierarchy in notifications
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
 * This ensures parent exists before we save the subtask
 */
async function syncParentTaskFromTodoist(
  db: SupabaseClient,
  settings: SettingsManager,
  parentId: string,
  egyptDate: string
): Promise<void> {
  try {
    console.log(`🔍 Checking if parent ${parentId} exists in DB...`);
    
    // Check if parent already exists in DB for today
    const existingParent = await db.select<Task>('tasks', {
      filter: { task_id: op.eq(parentId) }
    });

    // Filter for today's Egypt date
    const todayParent = existingParent.filter(task => {
      const taskEgyptDate = getEgyptDateString(new Date(task.completed_at));
      return taskEgyptDate === egyptDate;
    });

    if (todayParent.length > 0) {
      console.log(`✅ Parent already exists in DB for today`);
      return;
    }

    console.log(`🌐 Fetching parent task from Todoist API...`);
    
    // Fetch parent from Todoist API
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

    const parentTask = await response.json() as TodoistTask;
    console.log(`✅ Fetched parent from Todoist: ${parentTask.content}`);

    // Parse metadata
    const metadata = parseTaskMetadata(parentTask.content);
    
    // Extract category from labels
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

    // Create parent task as FAILED (will update to partial/done as subtasks complete)
    // CRITICAL: Use ORIGINAL task_id (without timestamp) so subtasks can find it
    const isRecurring = parentTask.due?.is_recurring || false;

    await db.insert<Task>('tasks', {
      task_id: parentId, // ✅ CORRECT - uses webhook parent_id
      content: parentTask.content,
      category: category,
      priority: parentTask.priority,
      description: parentTask.description,
      completed_at: new Date().toISOString(), // Use current time as placeholder
      duration_minutes: metadata.duration_minutes || 0,
      quantity: metadata.quantity,
      quantity_unit: metadata.quantity_unit,
      is_origin: isRecurring,
      status: 'failed', // Start as failed, will update based on subtasks
      created_at: new Date().toISOString(),
    });

    console.log(`✅ Created parent task in DB as FAILED with ID: ${parentId}`);

  } catch (error) {
    console.error('❌ Failed to sync parent from Todoist:', error);
  }
}

// ============================================
// Main Webhook Handler
// ============================================

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
    parent_id: event.event_data.parent_id || 'none'
  });

  // CRITICAL: If this is a subtask, sync parent from Todoist FIRST
  if (isSubtask && event.event_data.parent_id) {
    console.log('🔄 Subtask detected - syncing parent from Todoist API...');
    await syncParentTaskFromTodoist(db, settings, event.event_data.parent_id, egyptDate);
  }

  // Check if this task was previously logged as failed TODAY
const existingFailure = await checkForFailedTask(
  db,
  event.event_data.content,
  egyptDate
);

if (existingFailure) {
  console.log('🔄 Found existing failed task - updating to completed');
  
  // Parse metadata
  const metadata = parseTaskMetadata(event.event_data.content);
  
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
      // ✅ FIX: Update origin_task if this is a subtask!
      origin_task: isSubtask && event.event_data.parent_id 
        ? event.event_data.parent_id 
        : existingFailure.origin_task,
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

  // If this is a subtask, update parent status
  if (isSubtask && event.event_data.parent_id) {
    console.log('🔗 Updating parent task status...');
    await updateParentTaskStatus(db, event.event_data.parent_id);
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

  // Parse metadata
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

    if (isRecurring && !isSubtask) {
      // Main recurring task - use timestamped ID
      const uniqueTaskId = `${event.event_data.id}_${completedAt.getTime()}`;

      console.log('🔄 Recurring main task - unique ID:', uniqueTaskId);

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
    } else if (isRecurring && isSubtask) {
      // Recurring SUBTASK - UPSERT with original ID to match parent
      console.log('🔄 Recurring subtask - upserting with original ID:', event.event_data.id);

      const upserted = await db.upsert<Task>(
        'tasks',
        {
          ...task,
          task_id: event.event_data.id, // Original ID to match parent!
          created_at: new Date().toISOString(),
        },
        'task_id' // Upsert on task_id to avoid duplicates
      );
      savedTask = upserted[0];

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

    // Fire-and-forget Todoist sync after each completion
    console.log('🔄 Triggering background Todoist sync...');
    
    import('../services/failure-detection').then(module => {
      module.syncAndDetectFailuresForDate(db, settings, undefined).then(result => {
        console.log(`✅ Background sync complete: ${result.logged} failures logged, ${result.ignoredByPriority} ignored by priority`);
      }).catch(err => {
        console.error('❌ Background sync failed:', err);
      });
    }).catch(err => {
      console.error('❌ Failed to import failure-detection:', err);
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
 * Uses the ACTUAL parent_id from the subtask's task_id (before the underscore)
 */
async function updateParentTaskStatus(
  db: SupabaseClient,
  parentId: string
): Promise<void> {
  try {
    console.log(`🔍 Updating status for parent: ${parentId}`);
    
    // Get ALL subtasks with this origin_task
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

    // Find parent task (could have timestamp suffix for recurring tasks)
    const allTasks = await db.select<Task>('tasks', {});
    const parentTasks = allTasks.filter(t => 
      t.task_id === parentId || t.task_id.startsWith(parentId + '_')
    );

    if (parentTasks.length === 0) {
      console.warn(`⚠️ Parent task ${parentId} not found in database`);
      return;
    }

    // Update the most recent parent task
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
 * Send notification with COMPLETE hierarchy INCLUDING FAILED SUBTASKS from Todoist
 */
export async function sendTaskNotification(
  task: Task,
  chatId: string,
  botToken: string,
  db: SupabaseClient,
  settings: SettingsManager
): Promise<void> {
  try {
    console.log('📤 Building complete hierarchy notification from DATABASE + TODOIST...');
    
    let message = '';
    let mainTask: Task | null = null;
    let completedSubtasks: Task[] = [];
    let failedSubtasks: { id: string; content: string; priority: number }[] = [];

    // Get Todoist API token
    const todoistToken = await settings.get('todoist_api_token');
    const priorityThresholdStr = await settings.get('failure_priority_threshold');
    const priorityThreshold = priorityThresholdStr ? parseInt(priorityThresholdStr) : 2;

    // STEP 1: Determine parent task
    if (task.origin_task) {
      // This completed task is a subtask - find parent in DB
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
      } else {
        console.warn(`⚠️ Parent ${task.origin_task} not found in DB`);
      }
    } else {
      // This is a parent task
      console.log(`📌 Main task completed: ${task.content}`);
      mainTask = task;
    }

    // STEP 2: Get completed subtasks from DATABASE
    if (mainTask) {
      const parentId = task.origin_task || task.task_id;
      
      completedSubtasks = await db.select<Task>('tasks', {
        filter: { origin_task: op.eq(parentId) }
      });
      
      console.log(`📋 Found ${completedSubtasks.length} completed subtasks in DB`);
    }

    // STEP 3: Fetch ALL subtasks from Todoist API (including failed ones)
    if (mainTask && todoistToken) {
      const parentIdForTodoist = task.origin_task || task.task_id;
      
      try {
        console.log(`🌐 Fetching ALL subtasks from Todoist for parent: ${parentIdForTodoist}`);
        
        const response = await fetch(
          `https://api.todoist.com/rest/v2/tasks?project_id=${await settings.get('todoist_project_id')}`,
          {
            headers: {
              'Authorization': `Bearer ${todoistToken}`,
            },
          }
        );

        if (response.ok) {
          const allTodoistTasks = await response.json() as any[];
          
          // Filter for subtasks of this parent
          const todoistSubtasks = allTodoistTasks.filter(t => 
            t.parent_id === parentIdForTodoist
          );
          
          console.log(`🌐 Found ${todoistSubtasks.length} total subtasks in Todoist`);
          
          // Identify which ones are NOT completed (failed)
          const completedIds = new Set(completedSubtasks.map(t => t.task_id.split('_')[0]));
          const completedContents = new Set(completedSubtasks.map(t => t.content));
          
          for (const todoistSub of todoistSubtasks) {
            const isCompleted = 
              completedIds.has(todoistSub.id) || 
              completedContents.has(todoistSub.content);
            
            if (!isCompleted) {
              // Check priority threshold (same logic as failure detection)
              const todoistPriorityLevel = 5 - todoistSub.priority; // 4→P1, 3→P2, 2→P3, 1→P4
              
              if (todoistPriorityLevel <= priorityThreshold) {
                failedSubtasks.push({
                  id: todoistSub.id,
                  content: todoistSub.content,
                  priority: todoistSub.priority,
                });
                console.log(`✕ Failed subtask: ${todoistSub.content} (P${todoistPriorityLevel})`);
              } else {
                console.log(`⏭️ Ignored subtask by priority: ${todoistSub.content} (P${todoistPriorityLevel} > P${priorityThreshold})`);
              }
            }
          }
          
          console.log(`📊 Summary: ${completedSubtasks.length} completed, ${failedSubtasks.length} failed`);
          
        } else {
          console.error('❌ Failed to fetch Todoist tasks');
        }
      } catch (error) {
        console.error('❌ Error fetching Todoist subtasks:', error);
      }
    }

    // STEP 4: Build notification message
    if (mainTask) {
      const totalSubtasks = completedSubtasks.length + failedSubtasks.length;
      const completedCount = completedSubtasks.length;
      
      // Determine parent symbol based on completion
      let mainSymbol: string;
      if (totalSubtasks === 0) {
        // No subtasks - main task itself
        mainSymbol = mainTask.status === 'done' ? '✅' : '❌';
      } else if (completedCount === totalSubtasks) {
        // All subtasks done
        mainSymbol = '✅';
      } else if (completedCount > 0) {
        // Some subtasks done
        mainSymbol = '⚠️';
      } else {
        // No subtasks done
        mainSymbol = '❌';
      }
      
      const cleanName = mainTask.content.replace(/\[([^\]]+)\]/g, '').trim();
      const mainMetadata = getOriginalMetadataString(mainTask.content);
      
      message = `${mainSymbol} ${cleanName}`;
      
      if (mainMetadata) {
        message += ` ${mainMetadata}`;
      }
      message += '\n';

      // Add streak for parent (if exists and > 1)
      if (!mainTask.origin_task) {
        const streaks = await db.select<Streak>('streaks', {
          filter: { task_name: op.eq(mainTask.content) },
          limit: 1,
        });
        
        if (streaks.length > 0 && streaks[0] && streaks[0].current_streak > 1) {
          message += `🔥 السلسلة: ${formatArabicStreak(streaks[0].current_streak)}`;
          
          if (streaks[0].current_streak === streaks[0].best_streak) {
            message += ' 🎉 (رقم قياسي جديد!)';
          }
          
          message += '\n';
        }
      }

      // Add ALL subtasks (completed first, then failed)
      if (totalSubtasks > 0) {
        message += '\n';
        
        // Completed subtasks
        for (const sub of completedSubtasks) {
          const subCleanName = sub.content.replace(/\[([^\]]+)\]/g, '').trim();
          const subMetadata = getOriginalMetadataString(sub.content);
          
          message += `✓ ${subCleanName}`;
          
          if (subMetadata) {
            message += ` ${subMetadata}`;
          }
          
          message += '\n';
        }
        
        // Failed subtasks
        for (const sub of failedSubtasks) {
          const subCleanName = sub.content.replace(/\[([^\]]+)\]/g, '').trim();
          const subMetadata = getOriginalMetadataString(sub.content);
          
          message += `✕ ${subCleanName}`;
          
          if (subMetadata) {
            message += ` ${subMetadata}`;
          }
          
          message += '\n';
        }
      }
    } else {
      // Fallback: show just the subtask if parent not found
      console.warn('⚠️ Parent not found - showing subtask only');
      const subSymbol = task.status === 'done' ? '✓' : '✕';
      const cleanName = task.content.replace(/\[([^\]]+)\]/g, '').trim();
      const metadata = getOriginalMetadataString(task.content);
      
      message = `${subSymbol} ${cleanName}`;
      if (metadata) {
        message += ` ${metadata}`;
      }
    }

    console.log('📨 Sending notification:');
    console.log(message);

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
      console.log('✅ Notification sent successfully');
    }
  } catch (error) {
    console.error('❌ Notification failed:', error);
  }
}

/**
 * Get correct symbol for task
 */
function getTaskSymbol(task: Task): string {
  if (task.origin_task) {
    // Subtask
    return task.status === 'done' ? '✓' : '✕';
  } else {
    // Main task
    if (task.status === 'done') return '✅';
    if (task.status === 'partial') return '⚠️';
    return '❌';
  }
}