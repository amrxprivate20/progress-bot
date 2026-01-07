// ============================================
// Todoist Webhook Handler - FIXED VERSION
// Features:
// - Egypt timezone (GMT+2) for streak calculation
// - Comma-separated format: [30m, 5 pages]
// - Direct user notifications (no groups)
// - Better timestamp handling and logging
// ============================================

import type { SupabaseClient } from '../database/client';
import type { SettingsManager } from '../database/settings';
import type { TodoistWebhookEvent, Task, ParsedTaskMetadata } from '../types';
import { op } from '../database/client';
import { SETTINGS_KEYS } from '../database/settings';
import { logError } from '../utils/errors';

// Egypt timezone offset (GMT+2)
const EGYPT_OFFSET_MS = 2 * 60 * 60 * 1000;

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

  // Get completion time - try multiple fields in order of preference
  let completedAtString = event.event_data.completed_at || 
                         event.event_data.checked_at ||
                         new Date().toISOString(); // Fallback to now
  
  console.log('⏰ Completion timestamp:', completedAtString);
  
  const completedAt = new Date(completedAtString);

  const isRecurring = event.event_data.due?.is_recurring || false;
  const isSubtask = !!event.event_data.parent_id;

  console.log('📋 Task info:', {
    isRecurring,
    isSubtask,
    content: event.event_data.content,
  });

  // Check for duplicates (non-recurring only)
  if (!isRecurring) {
    const isDuplicate = await checkDuplicate(db, event.event_data.id, completedAt.toISOString());
    if (isDuplicate) {
      console.log('⚠️ Duplicate task detected');
      return { success: true, message: 'Duplicate task ignored' };
    }
  }

  // Parse task metadata
  const metadata = parseTaskMetadata(event.event_data.content);
  console.log('📊 Parsed metadata:', metadata);

  // Extract category from labels
  let category = metadata.category;
  if (!category && event.event_data.labels && event.event_data.labels.length > 0) {
    category = event.event_data.labels[0]
      .replace(/[^\w\s]/gi, '')
      .replace(/\s+/g, '_')
      .trim()
      .toLowerCase();
  }

  const task: Task = {
    task_id: event.event_data.id,
    content: event.event_data.content,
    category: category,
    priority: event.event_data.priority,
    description: event.event_data.description || undefined,
    completed_at: completedAt, // Store UTC time
    duration_minutes: metadata.duration_minutes || 0,
    quantity: metadata.quantity,
    quantity_unit: metadata.quantity_unit,
    is_origin: isRecurring && !isSubtask,
    origin_task: isSubtask ? event.event_data.parent_id : undefined,
    status: 'done',
  };

  try {
    let savedTask: Task;
    
    if (isRecurring) {
      // For recurring tasks, create unique ID with timestamp
      const uniqueTaskId = `${event.event_data.id}_${completedAt.getTime()}`;
      
      console.log('🔄 Recurring task - unique ID:', uniqueTaskId);
      
      savedTask = (await db.insert<Task>('tasks', {
        ...task,
        task_id: uniqueTaskId,
        created_at: new Date().toISOString(),
      }))[0];
      
      // Update streak (uses Egypt timezone internally)
      await updateStreakFromDueDate(
        db,
        task.content,
        completedAt,
        event.event_data.due?.string || '',
        isSubtask
      );
    } else {
      console.log('📝 Non-recurring task');
      
      savedTask = (await db.insert<Task>('tasks', {
        ...task,
        created_at: new Date().toISOString(),
      }))[0];
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
 * Parse task metadata from content
 * Supports:
 * - [30m] or [2h] → duration
 * - [5 pages] → quantity
 * - [30m, 5 pages] → both (comma-separated)
 * - @category → category
 */
export function parseTaskMetadata(content: string): ParsedTaskMetadata {
  const metadata: ParsedTaskMetadata = {};

  // Check for comma-separated format: [30m, 5 pages]
  const comboMatch = content.match(/\[([^\]]+),\s*([^\]]+)\]/);
  if (comboMatch) {
    const part1 = comboMatch[1].trim();
    const part2 = comboMatch[2].trim();
    
    // Parse first part (usually duration)
    const durationMatch1 = part1.match(/^(\d+(?:\.\d+)?)(m|h|min|mins|hour|hours)$/i);
    if (durationMatch1) {
      const value = parseFloat(durationMatch1[1]);
      const unit = durationMatch1[2].toLowerCase();
      
      if (unit === 'h' || unit === 'hour' || unit === 'hours') {
        metadata.duration_minutes = Math.round(value * 60);
      } else {
        metadata.duration_minutes = Math.round(value);
      }
    }
    
    // Parse second part (usually quantity)
    const quantityMatch2 = part2.match(/^(\d+(?:\.\d+)?)\s+([a-z]+)$/i);
    if (quantityMatch2) {
      metadata.quantity = parseFloat(quantityMatch2[1]);
      metadata.quantity_unit = quantityMatch2[2];
    }
    
    return metadata;
  }

  // Single bracket formats
  // Try duration: [30m] or [2h]
  const durationMatch = content.match(/\[(\d+(?:\.\d+)?)(m|h|min|mins|hour|hours)\]/i);
  if (durationMatch) {
    const value = parseFloat(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    
    if (unit === 'h' || unit === 'hour' || unit === 'hours') {
      metadata.duration_minutes = Math.round(value * 60);
    } else {
      metadata.duration_minutes = Math.round(value);
    }
  }

  // Try quantity: [5 pages] or [25 reps]
  const quantityMatch = content.match(/\[(\d+(?:\.\d+)?)\s+([a-z]+)\]/i);
  if (quantityMatch && !durationMatch) {
    metadata.quantity = parseFloat(quantityMatch[1]);
    metadata.quantity_unit = quantityMatch[2];
  }

  // Category with @
  const categoryMatch = content.match(/@([a-z0-9_]+)/i);
  if (categoryMatch) {
    metadata.category = categoryMatch[1];
  }

  return metadata;
}

/**
 * Update streak with Egypt timezone (GMT+2)
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

    // Convert to Egypt time for date calculation
    const egyptTime = new Date(completedAt.getTime() + EGYPT_OFFSET_MS);
    egyptTime.setHours(0, 0, 0, 0);
    const completedDateStr = egyptTime.toISOString().split('T')[0];

    console.log('🔥 Updating streak:', {
      task: streakKey,
      egyptDate: completedDateStr,
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

    // Same day - no update
    if (lastDate.getTime() === egyptTime.getTime()) {
      console.log('ℹ️ Same day - no streak update');
      return;
    }

    let newStreak: number;

    if (streakType === 'daily') {
      const daysDiff = Math.floor((egyptTime.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
      
      if (daysDiff === 1) {
        newStreak = streak.current_streak + 1;
        console.log(`🔥 Streak +1: "${streakKey}" = ${newStreak}`);
      } else {
        newStreak = 1;
        console.log(`💔 Streak reset: "${streakKey}"`);
      }
    } else {
      const dayOfWeek = egyptTime.getDay();
      const expectedDays = weeklyPattern ? weeklyPattern.split(',').map(d => parseInt(d)) : [];
      
      if (expectedDays.length === 0 || expectedDays.includes(dayOfWeek)) {
        const daysDiff = Math.floor((egyptTime.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
        
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
 * Send Telegram notification directly to user
 * NO groups, NO threads
 */
export async function sendTaskNotification(
  task: Task,
  chatId: string,
  botToken: string
): Promise<void> {
  try {
    console.log('📤 Preparing notification for chat:', chatId);
    
    const message = formatTaskNotification(task);
    
    const payload = {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
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
 * Format notification message
 */
function formatTaskNotification(task: Task): string {
  let message = `✅ <b>مهمة مكتملة</b>\n\n${escapeHtml(task.content)}`;

  if (task.duration_minutes && task.duration_minutes > 0) {
    const hours = Math.floor(task.duration_minutes / 60);
    const minutes = task.duration_minutes % 60;
    
    let timeStr = '';
    if (hours > 0) timeStr += `${hours} ساعة `;
    if (minutes > 0) timeStr += `${minutes} دقيقة`;
    
    message += `\n⏱ <i>المدة:</i> ${timeStr.trim()}`;
  }

  if (task.quantity) {
    message += `\n📊 <i>الكمية:</i> ${task.quantity} ${task.quantity_unit || 'وحدات'}`;
  }

  if (task.category) {
    message += `\n🏷 <i>الفئة:</i> ${escapeHtml(task.category)}`;
  }

  return message;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}