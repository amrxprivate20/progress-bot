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
import { SETTINGS_KEYS, SettingsManager, getAIModelByTier } from '../database/settings';
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

// Phase 1 Coach Features
import { createDopamineEngine, type CompletedTask } from '../gamification/dopamine-engine';
import { createBattleMode } from '../gamification/battle-mode';
import { createAIClient } from '../services/ai-client';

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
      `https://api.todoist.com/rest/v3/tasks/${parentId}`,
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
 * ✅ FIXED: Uses clean name matching for reliability
 * ✅ FIXED: Now accepts optional parentId parameter to avoid DB lookup timing issues
 */
export async function completeParentInTodoistIfAllDone(
  db: SupabaseClient,
  settings: SettingsManager,
  subtaskId: string,
  egyptDate: string,
  parentIdHint?: string | null  // ✅ Optional parent ID hint from webhook
): Promise<void> {
  try {
    console.log(`🔍 Checking parent autocomplete after subtask ${subtaskId}...`);

    // Get Todoist token for API calls
    const todoistToken = await settings.get('todoist_api_token');
    if (!todoistToken) {
      console.error('❌ No Todoist token for autocomplete');
      return;
    }

    // Get all tasks for today (Egypt timezone)
    const { start, end } = getEgyptDayBoundaries(egyptDate);
    const allTasks = await db.select<Task>('tasks', {});
    const todayTasks = allTasks.filter(t => {
      const taskDate = new Date(t.completed_at);
      return taskDate >= start && taskDate <= end;
    });

    // Get the parent's Todoist ID - prefer hint, fallback to DB lookup
    let parentTodoistId: string | null = parentIdHint?.split('_')[0] || null;

    if (parentTodoistId) {
      console.log(`📌 Parent Todoist ID from hint: ${parentTodoistId}`);
    } else {
      // Fallback: Find the completed subtask in our DB
      const subtask = todayTasks.find(t =>
        t.task_id === subtaskId || t.task_id?.startsWith(subtaskId + '_')
      );

      if (subtask?.origin_task) {
        parentTodoistId = subtask.origin_task.split('_')[0] || null;
        console.log(`📌 Parent Todoist ID from subtask DB: ${parentTodoistId}`);
      }
    }

    if (!parentTodoistId) {
      console.log('⚠️ No parent ID found, skipping autocomplete');
      return;
    }

    // ✅ KEY FIX: Query Todoist API to check if all subtasks are completed for TODAY
    // Note: Recurring subtasks don't disappear when completed - they get rescheduled
    // So we check if any subtasks are still due today or earlier
    // Also respects priority threshold - only counts subtasks at or above threshold
    console.log(`🔍 Checking Todoist for subtasks of parent ${parentTodoistId}...`);

    // Get priority threshold from settings
    const priorityThresholdStr = await settings.get('failure_priority_threshold');
    const priorityThreshold = priorityThresholdStr ? parseInt(priorityThresholdStr, 10) : 2;
    console.log(`📊 Priority threshold: P${priorityThreshold}`);

    try {
      // Get all subtasks of this parent from Todoist
      const subtasksResponse = await fetch(
        `https://api.todoist.com/rest/v3/tasks?parent_id=${parentTodoistId}`,
        { headers: { 'Authorization': `Bearer ${todoistToken.trim()}` } }
      );

      if (!subtasksResponse.ok) {
        console.log(`⚠️ Todoist API error: ${subtasksResponse.status}`);
        return;
      }

      const todoistSubtasks = await subtasksResponse.json() as Array<{
        id: string;
        content: string;
        is_completed: boolean;
        priority: number; // Todoist: 1=lowest, 4=highest
        due?: { date: string; is_recurring?: boolean } | null;
      }>;
      console.log(`📋 Found ${todoistSubtasks.length} total subtasks in Todoist`);

      // For recurring subtasks: check if due date is today or earlier (not yet completed for today)
      // For non-recurring subtasks: they shouldn't exist if completed
      // Also filter by priority threshold
      const todayDateStr = egyptDate; // Format: YYYY-MM-DD

      const subtasksDueToday = todoistSubtasks.filter(t => {
        if (t.is_completed) return false; // Already completed (non-recurring)

        // Check priority threshold (Todoist: 1=lowest, 4=highest → Our: P4=lowest, P1=highest)
        const ourPriority = 5 - (t.priority || 1); // Convert: Todoist 4 → Our P1
        if (ourPriority > priorityThreshold) {
          console.log(`  ⏭️ Subtask "${extractCleanTaskName(t.content)}" ignored (P${ourPriority} > P${priorityThreshold})`);
          return false; // Below threshold, don't count
        }

        // Check due date
        if (t.due?.date) {
          // due.date can be "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS"
          const dueDate = t.due.date.split('T')[0] || t.due.date;
          // If due today or earlier, it's still pending
          if (dueDate <= todayDateStr) {
            console.log(`  📌 Subtask "${extractCleanTaskName(t.content)}" (P${ourPriority}) due ${dueDate} (today or earlier)`);
            return true;
          }
          console.log(`  ✅ Subtask "${extractCleanTaskName(t.content)}" (P${ourPriority}) due ${dueDate} (future - already done for today)`);
          return false;
        }

        // No due date = always pending
        console.log(`  📌 Subtask "${extractCleanTaskName(t.content)}" (P${ourPriority}) has no due date`);
        return true;
      });

      if (subtasksDueToday.length > 0) {
        console.log(`⏳ Still ${subtasksDueToday.length} priority subtasks due today, not autocompleting`);
        return;
      }

      console.log(`✅ All priority subtasks completed for today!`);

      // All subtasks in Todoist are completed - check for failed subtasks in our JSON
      const dailyFailures = await getDailyFailures(db, egyptDate);
      const failedSubtasksForParent = dailyFailures?.failed_tasks.filter(f => {
        if (!f.is_subtask) return false;
        // Match by parent ID
        const failedParentId = f.parent_id?.split('_')[0];
        return failedParentId === parentTodoistId;
      }) || [];

      if (failedSubtasksForParent.length > 0) {
        console.log(`⚠️ ${failedSubtasksForParent.length} failed subtasks found, not autocompleting`);
        return;
      }

      // ✅ All subtasks completed, no failures - check if parent already done before autocompleting!
      console.log(`✅ All subtasks completed! Checking parent ${parentTodoistId}...`);

      // Check if parent is already completed in database
      const parentInDb = todayTasks.find(t => {
        const baseId = t.task_id?.split('_')[0];
        return baseId === parentTodoistId || t.task_id === parentTodoistId;
      });

      if (parentInDb?.status === 'done') {
        console.log(`⏭️ Parent ${parentTodoistId} already completed in database - skipping Todoist completion`);
        return;
      }

      // Parent not done in DB, complete in Todoist
      console.log(`🎯 Autocompleting parent ${parentTodoistId} in Todoist...`);

      const completeResponse = await fetch(
        `https://api.todoist.com/rest/v3/tasks/${parentTodoistId}/close`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${todoistToken.trim()}` },
        }
      );

      if (completeResponse.ok) {
        console.log(`🎉 Parent ${parentTodoistId} autocompleted in Todoist!`);

        // Update status in DB if parent exists there
        if (parentInDb?.id) {
          await db.update(
            'tasks',
            { id: op.eq(parentInDb.id as string) },
            { status: 'done' }
          );
          console.log(`✅ Updated parent status to 'done' in database`);
        }
      } else {
        const errorText = await completeResponse.text();
        console.error(`❌ Autocomplete failed: ${completeResponse.status} ${errorText}`);
      }
    } catch (apiError) {
      console.error('❌ Error checking Todoist subtasks:', apiError);
    }

  } catch (error) {
    console.error('❌ Error in completeParentInTodoistIfAllDone:', error);
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

  const taskId = event.event_data.id;

  // ✅ Check if this is a failure completion (logged via /log_failure) - should be ignored
  // Method 1: Check for explicit marker
  const failureCompletionKey = `failure_completion_${taskId}`;
  console.log(`🔍 Checking for failure completion marker: ${failureCompletionKey}`);

  try {
    const failureCompletion = await db.select('conversation_state', {
      filter: { chat_id: op.eq(failureCompletionKey) },
      limit: 1
    });

    console.log(`📊 Marker search result: found ${failureCompletion.length} records`);

    if (failureCompletion.length > 0) {
      // This completion was triggered by manual failure logging - ignore it
      console.log(`⏭️ FAILURE COMPLETION (marker): Task ${taskId} was completed as part of failure logging - ignoring webhook`);

      // Clean up the marker
      await db.delete('conversation_state', { chat_id: op.eq(failureCompletionKey) }).catch(() => {});

      return {
        success: true,
        message: `Ignored failure completion (marker found): ${taskId}`,
      };
    }
  } catch (e) {
    console.error('❌ Error checking failure completion marker:', e);
  }


  // ✅ DEDUPLICATION: Prevent same task from being completed twice within 20 minutes
  // But only if the task was actually recorded in the database
  const recentCompletionKey = `recent_completion_${taskId}`;
  const egyptDateForDedup = getEgyptDateString(new Date());
  const { start: dedupStart, end: dedupEnd } = getEgyptDayBoundaries(egyptDateForDedup);

  try {
    const recentCompletion = await db.select<{ data: any; created_at: string }>('conversation_state', {
      filter: { chat_id: op.eq(recentCompletionKey) },
      limit: 1
    });

    if (recentCompletion.length > 0 && recentCompletion[0]) {
      const completedTime = new Date(recentCompletion[0].created_at);
      const minutesSinceCompletion = (Date.now() - completedTime.getTime()) / 1000 / 60;

      if (minutesSinceCompletion < 20) {
        // Before blocking, verify the task was actually recorded in the database
        const cleanName = extractCleanTaskName(event.event_data.content);

        const allTasks = await db.select<Task>('tasks', {});
        const todayTasks = allTasks.filter(t => {
          const taskDate = new Date(t.completed_at);
          return taskDate >= dedupStart && taskDate <= dedupEnd;
        });

        const wasActuallyRecorded = todayTasks.some(t => {
          const existingCleanName = extractCleanTaskName(t.content);
          return existingCleanName === cleanName;
        });

        if (wasActuallyRecorded) {
          console.log(`⏭️ DUPLICATE: Task ${taskId} was completed ${minutesSinceCompletion.toFixed(1)} minutes ago AND recorded - ignoring`);
          return {
            success: true,
            message: `Ignored duplicate completion (within 20 minutes): ${taskId}`,
          };
        } else {
          console.log(`⚠️ RETRY: Task ${taskId} has marker from ${minutesSinceCompletion.toFixed(1)} minutes ago but NOT recorded - processing`);
          // Continue processing - the previous attempt failed
        }
      }
    }
  } catch (e) {
    console.error('❌ Error in dedup check:', e);
    // Continue processing on error
  }

  // Mark this task as recently completed (will be cleaned up naturally by expires_at)
  // NOTE: This marker is created before processing, so we check if task was recorded above
  try {
    await db.delete('conversation_state', { chat_id: op.eq(recentCompletionKey) }).catch(() => {});
    await db.insert('conversation_state', {
      chat_id: recentCompletionKey,
      conversation_type: 'recent_task_completion',
      data: { task_id: taskId, content: event.event_data.content },
      expires_at: new Date(Date.now() + 25 * 60 * 1000).toISOString(), // 25 minutes
    });
  } catch (e) {
    // Ignore errors in marking completion
  }

  // ✅ FIX 1: Check for pending update FIRST to get startDate (for midnight boundary)
  // Default to now, but override if pending update has startDate
  let completedAt = new Date();
  let egyptDate = getEgyptDateString(completedAt);
  let timerStartDate: string | null = null;

  // Check for pending timer update early to capture startDate
  const pendingUpdateKey = `pending_update_${event.event_data.id}`;
  try {
    const pendingUpdates = await db.select('conversation_state', {
      filter: { chat_id: op.eq(pendingUpdateKey) },
    });

    if (pendingUpdates.length > 0) {
      const pendingData = (pendingUpdates[0] as any).data || {};
      // ✅ Use startDate from pending update if available (midnight boundary fix)
      if (pendingData.startDate) {
        timerStartDate = pendingData.startDate as string;
        egyptDate = timerStartDate;
        // Set completedAt to end of start day in Egypt timezone
        completedAt = new Date(`${timerStartDate}T23:59:59+02:00`);
        console.log('📅 Using startDate from timer for Egypt date:', egyptDate);
      }
    }
  } catch (e) {
    console.error('❌ Error reading startDate from pending update:', e);
  }

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

  // Check and remove from failures - both today AND yesterday if task started yesterday
  const todayDate = getEgyptDateString(new Date());
  const wasFailedBefore = await wasTaskFailedToday(db, egyptDate, event.event_data.id);

  if (wasFailedBefore) {
    console.log('🔄 Task was in failed JSON - removing it from', egyptDate);
    await removeFromFailedTasks(db, egyptDate, event.event_data.id);
  }

  // ✅ Also check yesterday's failures if task started yesterday but we're completing today
  if (egyptDate !== todayDate) {
    const wasFailedYesterday = await wasTaskFailedToday(db, egyptDate, event.event_data.id);
    if (wasFailedYesterday) {
      console.log('🔄 Task was in yesterday failed JSON - removing it from', egyptDate);
      await removeFromFailedTasks(db, egyptDate, event.event_data.id);
    }
    // Also check today's failures in case it was added there too
    const wasFailedToday = await wasTaskFailedToday(db, todayDate, event.event_data.id);
    if (wasFailedToday) {
      console.log('🔄 Task was also in today failed JSON - removing it from', todayDate);
      await removeFromFailedTasks(db, todayDate, event.event_data.id);
    }
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

      const { withLock } = await import('../utils/locks');
      const lockKey = `parent_update_${event.event_data.parent_id}`;

      await withLock(db, lockKey, async () => {
        await updateParentTaskStatus(db, event.event_data.parent_id!);
        // Pass the subtask ID and parent ID hint for reliable autocomplete
        await completeParentInTodoistIfAllDone(db, settings, event.event_data.id, egyptDate, event.event_data.parent_id);
      });
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

  // Check for pending timer update (from /starttask -> /completetask flow)
  // This processes content and duration; startDate was already processed above
  let taskContent = event.event_data.content;
  let timerDuration = 0;

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

  // ✅ FIX: If this is a subtask, find parent's clean name FIRST
  // This is needed for grouping and autocomplete to work
  let parentCleanNameForSubtask: string | null = null;

  if (isSubtask && event.event_data.parent_id) {
    // Method 1: Find parent in database
    const allTasks = await db.select<Task>('tasks', {});
    const parentTasks = allTasks.filter(t =>
      t.task_id === event.event_data.parent_id ||
      t.task_id?.startsWith(event.event_data.parent_id + '_')
    );

    if (parentTasks.length > 0) {
      const parentTask = parentTasks.sort((a, b) =>
        new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime()
      )[0];

      if (parentTask) {
        parentCleanNameForSubtask = extractCleanTaskName(parentTask.content);
        console.log(`✅ Found parent in DB: "${parentCleanNameForSubtask}"`);
      }
    }

    // Method 2: If not in DB, fetch from Todoist API
    if (!parentCleanNameForSubtask) {
      const todoistToken = await settings.get('todoist_api_token');
      if (todoistToken) {
        try {
          const parentResponse = await fetch(
            `https://api.todoist.com/rest/v3/tasks/${event.event_data.parent_id}`,
            { headers: { 'Authorization': `Bearer ${todoistToken.trim()}` } }
          );

          if (parentResponse.ok) {
            const parentData = await parentResponse.json() as { content: string };
            parentCleanNameForSubtask = extractCleanTaskName(parentData.content);
            console.log(`✅ Found parent via Todoist API: "${parentCleanNameForSubtask}"`);
          }
        } catch (apiError) {
          console.error('Failed to fetch parent from Todoist:', apiError);
        }
      }
    }
  }

  // Build task content - ADD (origin: parent_name) marker to CONTENT for subtasks
  const finalTaskContent = (isSubtask && parentCleanNameForSubtask)
    ? `${taskContent} (origin: ${parentCleanNameForSubtask})`
    : taskContent;

  const task: Task = {
    task_id: event.event_data.id,
    content: finalTaskContent, // ✅ Now includes (origin: parent_name) for subtasks
    category: category,
    priority: event.event_data.priority,
    description: event.event_data.description || undefined,
    completed_at: completedAt,
    duration_minutes: timerDuration || metadata.duration_minutes || 0,
    quantity: metadata.quantity,
    quantity_unit: metadata.quantity_unit,
    is_origin: isRecurring && !isSubtask,
    origin_task: isSubtask ? event.event_data.parent_id : undefined,
    status: 'done',
  };

  try {
  let savedTask: Task | undefined;

  // ✅ NEW: Check if we should replace an existing task instead of inserting
  const shouldReplace = await replaceDuplicateIfExists(
    db,
    event.event_data.id,
    finalTaskContent, // ✅ Use content with origin marker
    completedAt,
    {
      duration_minutes: timerDuration || metadata.duration_minutes || 0,
      quantity: metadata.quantity,
      quantity_unit: metadata.quantity_unit,
      category: category,
      priority: event.event_data.priority,
      description: event.event_data.description,
      status: 'done',
    }
  );

  if (shouldReplace) {
    console.log('✅ Task replaced instead of duplicated');
    
    // Get the updated task
    const updatedTasks = await db.select<Task>('tasks', {});
    savedTask = updatedTasks.find(t => {
      const taskCleanName = extractCleanTaskName(t.content);
      const searchCleanName = extractCleanTaskName(taskContent);
      return taskCleanName === searchCleanName;
    });

    if (!savedTask) {
      throw new Error('Could not find replaced task');
    }
    
    // Update streak for recurring tasks
    if (isRecurring) {
      await updateStreakFromDueDate(
        db,
        task.content,
        completedAt,
        event.event_data.due?.string || '',
        isSubtask
      );
    }
  } else {
    // No duplicate found - insert as new task
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
        completedAt,
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
        completedAt,
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
  }

  // Update parent status if this is a subtask
  if (isSubtask && event.event_data.parent_id) {
    console.log('🔗 Updating parent task status...');

    const { withLock } = await import('../utils/locks');
    const lockKey = `parent_update_${event.event_data.parent_id}`;

    await withLock(db, lockKey, async () => {
      await updateParentTaskStatus(db, event.event_data.parent_id!);
      // Pass the subtask ID and parent ID hint for reliable autocomplete
      await completeParentInTodoistIfAllDone(db, settings, event.event_data.id, egyptDate, event.event_data.parent_id);
    });
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
  completedAt: Date,  // ✅ This parameter is correct
  dueString: string,
  isSubtask: boolean = false
): Promise<void> {
  try {
    // ✅ FIX: Ensure completedAt is a Date (rename for clarity)
    let completedDate: Date;  // ✅ CHANGED: Use completedDate instead of completedAt
    if (completedAt instanceof Date) {
      completedDate = completedAt;
    } else {
      console.warn('⚠️ completedAt was not a Date, converting:', typeof completedAt);
      completedDate = new Date(completedAt);
    }
    
    // ✅ NEW: Clean the task name before using it as streak key
    const cleanName = extractCleanTaskName(taskName);
    const streakKey = isSubtask ? `${cleanName} [subtask]` : cleanName;
    
    const streakType = determineStreakType(dueString);
    const weeklyPattern = extractWeeklyPattern(dueString);

    const completedDateStr = getEgyptDateString(completedDate);

    console.log('🔥 Updating streak:', {
      task: streakKey,
      originalName: taskName,
      cleanName: cleanName,
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

export async function checkDuplicate(
  db: SupabaseClient,
  taskContent: string,
  completedAt: string
): Promise<boolean> {
  try {
    const completedDate = new Date(completedAt);
    const egyptDate = getEgyptDateString(completedDate);
    const { start, end } = getEgyptDayBoundaries(egyptDate);

    // ✅ Use clean name for matching
    const cleanName = extractCleanTaskName(taskContent);
    console.log('🔍 Duplicate check for:', cleanName, 'on', egyptDate);

    // Get all tasks for this Egypt day
    const allTasks = await db.select<Task>('tasks', {});
    const todayTasks = allTasks.filter(t => {
      const taskDate = new Date(t.completed_at);
      return taskDate >= start && taskDate <= end;
    });

    // Check by clean name
    const duplicate = todayTasks.find(t => {
      const existingCleanName = extractCleanTaskName(t.content);
      return existingCleanName === cleanName;
    });

    if (duplicate) {
      console.log(`⚠️ Duplicate found (will be replaced):`, duplicate.id);
      // Note: We return false here because we'll handle replacement separately
      // This prevents the INSERT attempt, and replaceDuplicateIfExists will UPDATE instead
      return false; // Allow the replacement logic to run
    }

    return false;
  } catch (error) {
    console.error('Duplicate check failed:', error);
    return false;
  }
}

/**
 * Replace duplicate task if same name completed on same day
 * Returns true if a duplicate was found and replaced
 */
async function replaceDuplicateIfExists(
  db: SupabaseClient,
  taskId: string,
  taskContent: string,
  completedAt: Date,
  newTaskData: Partial<Task>
): Promise<boolean> {
  try {
    const egyptDate = getEgyptDateString(completedAt);
    const { start, end } = getEgyptDayBoundaries(egyptDate);
    
    const cleanName = extractCleanTaskName(taskContent);
    console.log('🔍 Checking for same-day duplicate to replace:', cleanName);

    // Get all tasks for this day
    const allTasks = await db.select<Task>('tasks', {});
    const todayTasks = allTasks.filter(t => {
      const taskDate = new Date(t.completed_at);
      return taskDate >= start && taskDate <= end;
    });

    // Find existing task with same clean name
    const existingTask = todayTasks.find(t => {
      const existingCleanName = extractCleanTaskName(t.content);
      return existingCleanName === cleanName;
    });

    if (!existingTask || !existingTask.id) {
      console.log('No duplicate found - can insert as new');
      return false;
    }

    console.log(`🔄 Found duplicate task from today: ${existingTask.id}`);
    console.log(`   Old content: "${existingTask.content}"`);
    console.log(`   New content: "${taskContent}"`);

    // Replace the existing task with new data
    await db.update(
      'tasks',
      { id: op.eq(existingTask.id) },
      {
        task_id: taskId, // Update with new task ID
        content: taskContent, // Update content (may have new metadata)
        completed_at: completedAt.toISOString(),
        duration_minutes: newTaskData.duration_minutes || existingTask.duration_minutes,
        quantity: newTaskData.quantity || existingTask.quantity,
        quantity_unit: newTaskData.quantity_unit || existingTask.quantity_unit,
        category: newTaskData.category || existingTask.category,
        priority: newTaskData.priority || existingTask.priority,
        description: newTaskData.description || existingTask.description,
        status: newTaskData.status || existingTask.status,
      }
    );

    console.log('✅ Replaced duplicate task with updated data');
    return true;

  } catch (error) {
    console.error('Error checking/replacing duplicate:', error);
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
      `https://api.todoist.com/rest/v3/tasks?project_id=${projectId}`,
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
 * Send task completion notification with proper hierarchy
 * ✅ FIXED: Uses clean name matching for reliable parent-child grouping
 */
export async function sendTaskNotification(
  task: Task,
  chatId: string,
  botToken: string,
  db: SupabaseClient
): Promise<void> {
  try {
    console.log('📤 Sending notification for task:', task.content);
    
    const completedAtDate = task.completed_at instanceof Date 
      ? task.completed_at 
      : new Date(task.completed_at);
    const egyptDate = getEgyptDateString(completedAtDate);
    
    // Get day boundaries to filter tasks
    const { start, end } = getEgyptDayBoundaries(egyptDate);
    
    // Get all tasks for today
    const allTasks = await db.select<Task>('tasks', {});
    const todayTasks = allTasks.filter(t => {
      const taskDate = new Date(t.completed_at);
      return taskDate >= start && taskDate <= end;
    });
    
    let mainTask: Task;
    let mainTaskCleanName: string;
    let completedSubtasks: Task[] = [];
    let failedSubtasks: FailedTask[] = [];

    // ✅ STEP 1: Determine the main (parent) task
    if (task.origin_task) {
      // This is a subtask - find its parent by NAME
      console.log(`🔍 Subtask completed, finding parent...`);
      
      let parentCleanName: string | null = null;
      
      // Method 1: Extract from origin marker
      const originMatch = task.content.match(/\(origin:\s*([^)]+)\)/i);
      if (originMatch && originMatch[1]) {
        parentCleanName = extractCleanTaskName(originMatch[1]);
        console.log(`  📌 Parent name from origin: "${parentCleanName}"`);
      }
      
      // Method 2: Check failed JSON for sibling subtasks with parent info
      if (!parentCleanName) {
        const dailyFailures = await getDailyFailures(db, egyptDate);
        if (dailyFailures) {
          const taskCleanName = extractCleanTaskName(task.content);
          const sibling = dailyFailures.failed_tasks.find(f =>
            f.is_subtask &&
            extractCleanTaskName(f.content) === taskCleanName &&
            f.parent_content
          );

          if (sibling && sibling.parent_content) {
            parentCleanName = extractCleanTaskName(sibling.parent_content);
            console.log(`  📌 Parent name from sibling: "${parentCleanName}"`);
          }
        }
      }

      // Method 3: Find parent by origin_task ID in database
      if (!parentCleanName && task.origin_task) {
        const parentId = task.origin_task;
        const parentBaseId = parentId.split('_')[0];

        const parentInDb = todayTasks.find(t => {
          if (t.origin_task) return false; // Skip subtasks
          const baseId = t.task_id?.split('_')[0];
          return baseId === parentBaseId || t.task_id === parentId;
        });

        if (parentInDb) {
          parentCleanName = extractCleanTaskName(parentInDb.content);
          console.log(`  📌 Parent name from DB by ID: "${parentCleanName}"`);
        }
      }

      // Find parent in today's tasks OR use parent name for grouping
      if (parentCleanName) {
        const parentTask = todayTasks.find(t => {
          if (t.origin_task) return false; // Skip subtasks
          const cleanName = extractCleanTaskName(t.content);
          return cleanName === parentCleanName;
        });

        if (parentTask) {
          mainTask = parentTask;
          mainTaskCleanName = parentCleanName;
          console.log(`  ✅ Found completed parent: "${mainTaskCleanName}"`);
        } else {
          // Parent not completed yet - use parent name for grouping anyway
          // Create a virtual parent task with the parent name
          console.log(`  📌 Parent not completed yet, grouping under: "${parentCleanName}"`);
          mainTask = {
            ...task,
            content: parentCleanName, // Use parent name
            origin_task: undefined, // Mark as main task
            status: undefined, // Parent is pending (undefined = not completed)
          };
          mainTaskCleanName = parentCleanName;
        }
      } else {
        // Couldn't determine parent - use subtask as main
        console.log(`  ⚠️ Couldn't determine parent, using subtask as main`);
        mainTask = task;
        mainTaskCleanName = extractCleanTaskName(task.content);
      }
    } else {
      // This is already a main task
      console.log(`📌 Main task completed: ${task.content}`);
      mainTask = task;
      mainTaskCleanName = extractCleanTaskName(task.content);
    }

    // ✅ STEP 2: Get ALL completed subtasks for this parent (by CLEAN NAME or ID)
    // Get parent's Todoist ID for fallback matching
    const parentTodoistId = mainTask.task_id?.split('_')[0] || task.origin_task;

    completedSubtasks = todayTasks.filter(t => {
      if (!t.origin_task) return false;

      // Method 1: Check origin marker in content
      const originMatch = t.content.match(/\(origin:\s*([^)]+)\)/i);
      if (originMatch && originMatch[1]) {
        const originParentName = extractCleanTaskName(originMatch[1]);
        if (originParentName === mainTaskCleanName) return true;
      }

      // Method 2: Fallback - match by origin_task ID
      if (parentTodoistId) {
        const subtaskOriginBase = t.origin_task.split('_')[0];
        if (subtaskOriginBase === parentTodoistId) return true;
      }

      return false;
    });

    console.log(`📋 Found ${completedSubtasks.length} completed subtasks`);

    // ✅ STEP 3: Get failed subtasks from JSON (by PARENT NAME)
    try {
      const dailyFailures = await getDailyFailures(db, egyptDate);
      
      if (dailyFailures) {
        failedSubtasks = dailyFailures.failed_tasks.filter(f => {
          if (!f.is_subtask || !f.parent_content) return false;
          
          const failedParentCleanName = extractCleanTaskName(f.parent_content);
          return failedParentCleanName === mainTaskCleanName;
        });
        
        console.log(`📊 Found ${failedSubtasks.length} failed subtasks`);
      }
      
    } catch (error) {
      console.error('❌ Error fetching failed subtasks:', error);
    }

    // ✅ STEP 4: Build notification message
    const totalSubtasks = completedSubtasks.length + failedSubtasks.length;
    const isParentCompleted = mainTask.status === 'done';
    const isParentPending = !mainTask.status; // undefined = parent not completed yet

    // Determine symbol:
    // - ✅ = all done (parent + all subtasks)
    // - ⏳ = parent pending, some subtasks done
    // - ⚠️ = mixed (some done, some failed)
    // - ❌ = all failed
    let symbol: string;
    if (isParentPending) {
      // Parent not completed yet - show progress
      symbol = failedSubtasks.length > 0 ? '⚠️' : '⏳';
    } else if (totalSubtasks === 0) {
      symbol = isParentCompleted ? '✅' : '❌';
    } else {
      symbol = failedSubtasks.length === 0 ? '✅' : (completedSubtasks.length === 0 ? '❌' : '⚠️');
    }

    let message = `${symbol} ${mainTaskCleanName}`;

    // Add progress indicator if parent is pending
    if (isParentPending && totalSubtasks > 0) {
      message += ` (${completedSubtasks.length}/${totalSubtasks})`;
    }

    // Add duration if present
    if (mainTask.duration_minutes && mainTask.duration_minutes > 0) {
      message += ` [${formatArabicTime(mainTask.duration_minutes)}]`;
    }

    // Add quantity if present
    if (mainTask.quantity && mainTask.quantity_unit) {
      message += ` [${mainTask.quantity} ${mainTask.quantity_unit}]`;
    }

    // Add streak if present
    const streakName = mainTaskCleanName + (task.origin_task ? ' [subtask]' : '');
    const streaks = await db.select('streaks', { 
      filter: { task_name: op.eq(streakName) } 
    });

    if (streaks && streaks.length > 0) {
      const streak = streaks[0];
      if (streak.current_streak > 1) {
        const isRecord = streak.current_streak === streak.best_streak;
        message += ` [🔥${streak.current_streak}${isRecord ? '🎉' : ''}]`;
      }
    }

    // Add description if present (exclude parent marker)
    if (mainTask.description && !mainTask.description.includes('(parent:')) {
      message += `\n📝 ${mainTask.description}`;
    }

    // ✅ STEP 5: Add ALL subtasks (completed + failed)
    if (totalSubtasks > 0) {
      // Sort: completed first, then failed
      completedSubtasks.forEach(sub => {
        const subClean = extractCleanTaskName(sub.content);
        message += `\n  ✓ ${subClean}`;
      });

      failedSubtasks.forEach(sub => {
        const subClean = extractCleanTaskName(sub.content);
        message += `\n  ✗ ${subClean}`;
      });
    }

    // ✅ STEP 6: Send notification
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

// ============================================
// PHASE 1: COACH FEATURES - ON TASK COMPLETE
// ============================================

/**
 * Trigger Phase 1 coach features when a task is completed
 * - Dopamine Hit Engine: Generate celebration message
 * - Battle Mode: Deal damage to today's boss
 */
export async function triggerOnTaskComplete(
  task: Task,
  chatId: string,
  botToken: string,
  db: SupabaseClient,
  settings: SettingsManager
): Promise<void> {
  try {
    // Get AI client for coach features - use LOW-TIER model for dopamine/battle
    const apiKey = await settings.get('openrouter_api_key');
    if (!apiKey) {
      console.log('⚠️ No AI key configured, skipping coach features');
      return;
    }

    const aiModel = await getAIModelByTier(settings, 'low');
    const aiClient = createAIClient(apiKey, aiModel);
    const aiComplete = (msgs: any[], temp?: number, max?: number) => aiClient.complete(msgs, temp, max);

    // Get streak info for the task
    const cleanTaskName = extractCleanTaskName(task.content);
    const streakKey = task.origin_task ? `${cleanTaskName} [subtask]` : cleanTaskName;
    const streaks = await db.select('streaks', {
      filter: { task_name: op.eq(streakKey) }
    });
    const streakCount = streaks?.[0]?.current_streak || 0;

    // Build completed task info
    const completedTask: CompletedTask = {
      id: task.task_id,
      content: task.content,
      category: task.category,
      duration: task.duration_minutes,
      isRecurring: task.is_origin || false,
      streakCount: streakCount as number,
    };

    // 1. DOPAMINE HIT ENGINE
    const dopamineEnabled = await settings.get('gamification.dopamine_hits');
    if (dopamineEnabled !== 'false') {
      try {
        const dopamineEngine = createDopamineEngine(db, settings, aiComplete);
        const hit = await dopamineEngine.generateHit(chatId, completedTask);

        // Send dopamine hit message
        await sendTelegramMessage(botToken, chatId, hit.message);
        console.log(`🎯 Dopamine hit sent (${hit.rewardType})`);
      } catch (error) {
        console.error('❌ Dopamine engine error:', error);
      }
    }

    // 2. BATTLE MODE - Deal damage
    const battleEnabled = await settings.get('gamification.battle_mode');
    if (battleEnabled !== 'false') {
      try {
        const battleMode = createBattleMode(db, settings, aiComplete);

        // Calculate difficulty based on task properties
        const difficulty = calculateTaskDifficulty(task);
        const action = await battleMode.dealDamage(chatId, cleanTaskName, difficulty);

        if (action) {
          // Send battle narrative
          await sendTelegramMessage(botToken, chatId, action.narrative);
          if (action.bossResponse) {
            await sendTelegramMessage(botToken, chatId, action.bossResponse);
          }
          console.log(`⚔️ Battle damage dealt: ${action.amount}`);
        }
      } catch (error) {
        console.error('❌ Battle mode error:', error);
      }
    }

  } catch (error) {
    console.error('❌ Error in triggerOnTaskComplete:', error);
  }
}

/**
 * Trigger boss healing when a task is failed/deferred
 */
export async function triggerOnTaskFailed(
  taskName: string,
  chatId: string,
  botToken: string,
  db: SupabaseClient,
  settings: SettingsManager,
  severity: number = 1
): Promise<void> {
  try {
    const battleEnabled = await settings.get('gamification.battle_mode');
    if (battleEnabled === 'false') return;

    const apiKey = await settings.get('openrouter_api_key');
    if (!apiKey) return;

    // Use LOW-TIER model for battle mode
    const aiModel = await getAIModelByTier(settings, 'low');
    const aiClient = createAIClient(apiKey, aiModel);
    const battleMode = createBattleMode(db, settings, (msgs, temp, max) => aiClient.complete(msgs, temp, max));

    const action = await battleMode.bossHeals(chatId, taskName, severity);

    if (action) {
      await sendTelegramMessage(botToken, chatId, action.narrative);
      console.log(`😈 Boss healed: ${action.amount}`);
    }

  } catch (error) {
    console.error('❌ Error in triggerOnTaskFailed:', error);
  }
}

/**
 * Calculate task difficulty for battle damage
 * Higher difficulty = more damage
 */
function calculateTaskDifficulty(task: Task): number {
  let difficulty = 1;

  // Priority boost (P1 = highest priority = most damage)
  // Todoist: priority 4 = P1 (highest), priority 1 = P4 (lowest)
  if (task.priority) {
    const priorityBoost = (5 - task.priority) * 0.25; // P1 = +1.0, P2 = +0.75, etc.
    difficulty += priorityBoost;
  }

  // Duration boost
  if (task.duration_minutes) {
    if (task.duration_minutes >= 60) difficulty += 0.5;
    else if (task.duration_minutes >= 30) difficulty += 0.25;
  }

  // Quantity boost
  if (task.quantity && task.quantity > 1) {
    difficulty += Math.min(0.5, task.quantity * 0.1);
  }

  return Math.min(3, difficulty); // Cap at 3x
}
