// ============================================
// Todoist Webhook Handler
// ============================================
// Handles task completion events from Todoist

import type { SupabaseClient } from '../database/client';
import type { SettingsManager } from '../database/settings';
import type { TodoistWebhookEvent, Task, ParsedTaskMetadata } from '../types';
import { op } from '../database/client';
import { SETTINGS_KEYS } from '../database/settings';
import { validateTodoistWebhook, validateProjectId } from '../utils/validation';
import { ValidationError, ExternalAPIError, logError } from '../utils/errors';

/**
 * Handle Todoist webhook event
 */
export async function handleTodoistWebhook(
  payload: any,
  db: SupabaseClient,
  settings: SettingsManager
): Promise<{ success: boolean; message: string; task?: Task }> {
  // Validate webhook payload structure
  const validation = validateTodoistWebhook(payload);
  if (!validation.valid) {
    throw new ValidationError('Invalid webhook payload', validation.errors);
  }

  const event = payload as TodoistWebhookEvent;

  // Only process completed tasks
  if (event.event_name !== 'item:completed') {
    return {
      success: true,
      message: `Ignored event: ${event.event_name}`,
    };
  }

  // Get expected project ID from settings
  const projectId = await settings.get(SETTINGS_KEYS.TODOIST_PROJECT_ID);
  if (!projectId) {
    throw new Error('Todoist project ID not configured');
  }

  // Validate project ID
  if (!validateProjectId(event.event_data.project_id, projectId)) {
    return {
      success: true,
      message: `Ignored task from different project: ${event.event_data.project_id}`,
    };
  }

  // Check for duplicate (within 20-minute window)
  const isDuplicate = await checkDuplicate(
    db,
    event.event_data.id,
    event.event_data.completed_at || event.event_data.added_at
  );

  if (isDuplicate) {
    return {
      success: true,
      message: 'Duplicate task ignored',
    };
  }

  // Parse task metadata from content
  const metadata = parseTaskMetadata(event.event_data.content);

  // Create task object
  const task: Task = {
    task_id: event.event_data.id,
    content: event.event_data.content,
    category: metadata.category,
    priority: event.event_data.priority,
    description: event.event_data.description || undefined,
    completed_at: new Date(event.event_data.completed_at || event.event_data.added_at),
    duration_minutes: metadata.duration_minutes || 0,
    quantity: metadata.quantity,
    quantity_unit: metadata.quantity_unit,
    is_origin: metadata.is_origin || false,
    origin_task: metadata.origin_task,
    status: 'done',
  };

  // Insert task into database
  try {
    const [insertedTask] = await db.insert<Task>('tasks', task);
    
    // Update streak if this is a recurring task
    if (metadata.is_origin || event.event_data.due?.is_recurring) {
      await updateStreak(db, task.content, task.completed_at);
    }

    // Check if this is a Quran task (for special handling later)
    const quranTaskName = await settings.get(SETTINGS_KEYS.QURAN_TASK_NAME);
    const isQuranTask = quranTaskName && task.content.includes(quranTaskName);

    return {
      success: true,
      message: `Task completed: ${task.content}`,
      task: insertedTask,
    };
  } catch (error) {
    logError(error as Error, {
      operation: 'handleTodoistWebhook',
      additionalInfo: { taskId: task.task_id },
    });
    throw error;
  }
}

/**
 * Check if task was already processed (duplicate detection)
 * Checks within 20-minute window
 */
async function checkDuplicate(
  db: SupabaseClient,
  taskId: string,
  completedAt: string
): Promise<boolean> {
  try {
    const completedDate = new Date(completedAt);
    const windowStart = new Date(completedDate.getTime() - 20 * 60 * 1000); // 20 minutes before
    const windowEnd = new Date(completedDate.getTime() + 20 * 60 * 1000); // 20 minutes after

    const existing = await db.select('tasks', {
      columns: 'id',
      filter: {
        task_id: op.eq(taskId),
        completed_at: op.gte(windowStart.toISOString()),
        // Using two filters for range
      },
      limit: 1,
    });

    // Additional check for upper bound
    if (existing.length > 0) {
      const existingDate = new Date(existing[0].completed_at);
      return existingDate <= windowEnd;
    }

    return false;
  } catch (error) {
    // If check fails, assume not duplicate (better to have duplicate than miss task)
    console.error('Duplicate check failed:', error);
    return false;
  }
}

/**
 * Parse task metadata from task content
 * Supports formats like:
 * - "Task name [30m]" -> 30 minutes
 * - "Task name [2h]" -> 120 minutes
 * - "Task name [5 pages]" -> quantity: 5, unit: pages
 * - "Task name #category" -> category
 * - "Task name (origin: parent_task)" -> origin tracking
 */
export function parseTaskMetadata(content: string): ParsedTaskMetadata {
  const metadata: ParsedTaskMetadata = {};

  // Parse duration [30m] or [2h]
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

  // Parse quantity [5 pages], [3 chapters], etc.
  const quantityMatch = content.match(/\[(\d+(?:\.\d+)?)\s+([a-z]+)\]/i);
  if (quantityMatch && !durationMatch) { // Don't match if already matched duration
    metadata.quantity = parseFloat(quantityMatch[1]);
    metadata.quantity_unit = quantityMatch[2];
  }

  // Parse category #hashtag
  const categoryMatch = content.match(/#([a-z0-9_]+)/i);
  if (categoryMatch) {
    metadata.category = categoryMatch[1];
  }

  // Parse origin task (origin: task_name)
  const originMatch = content.match(/\(origin:\s*([^)]+)\)/i);
  if (originMatch) {
    metadata.is_origin = false;
    metadata.origin_task = originMatch[1].trim();
  }

  // Check if this is an origin task (❗ marker)
  if (content.includes('❗')) {
    metadata.is_origin = true;
  }

  return metadata;
}

/**
 * Update streak for recurring tasks
 */
async function updateStreak(
  db: SupabaseClient,
  taskName: string,
  completedAt: Date
): Promise<void> {
  try {
    // Get or create streak record
    const existing = await db.select('streaks', {
      filter: { task_name: op.eq(taskName) },
      limit: 1,
    });

    const completedDate = new Date(completedAt);
    completedDate.setHours(0, 0, 0, 0); // Normalize to start of day

    if (existing.length === 0) {
      // Create new streak
      await db.insert('streaks', {
        task_name: taskName,
        current_streak: 1,
        best_streak: 1,
        last_completed_date: completedDate.toISOString().split('T')[0],
        streak_type: 'daily',
        updated_at: new Date().toISOString(),
      });
    } else {
      // Update existing streak
      const streak = existing[0];
      const lastDate = new Date(streak.last_completed_date);
      lastDate.setHours(0, 0, 0, 0);

      // Check if same day (don't update)
      if (lastDate.getTime() === completedDate.getTime()) {
        return;
      }

      // Check if consecutive day
      const yesterday = new Date(completedDate);
      yesterday.setDate(yesterday.getDate() - 1);

      let newStreak: number;
      if (lastDate.getTime() === yesterday.getTime()) {
        // Consecutive day - increment streak
        newStreak = streak.current_streak + 1;
      } else {
        // Streak broken - reset to 1
        newStreak = 1;
      }

      const newBestStreak = Math.max(streak.best_streak, newStreak);

      await db.update(
        'streaks',
        { task_name: op.eq(taskName) },
        {
          current_streak: newStreak,
          best_streak: newBestStreak,
          last_completed_date: completedDate.toISOString().split('T')[0],
          updated_at: new Date().toISOString(),
        }
      );
    }
  } catch (error) {
    // Log error but don't throw - streak update is not critical
    console.error('Failed to update streak:', error);
  }
}

/**
 * Send notification to Telegram about completed task
 */
export async function sendTaskNotification(
  task: Task,
  chatId: string,
  botToken: string,
  threadId?: string
): Promise<void> {
  try {
    const message = formatTaskNotification(task);
    
    const payload: any = {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
    };

    if (threadId) {
      payload.message_thread_id = threadId;
    }

    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new ExternalAPIError(
        `Telegram API error: ${errorData.description}`,
        'Telegram'
      );
    }
  } catch (error) {
    // Log but don't throw - notification failure shouldn't break webhook
    console.error('Failed to send Telegram notification:', error);
  }
}

/**
 * Format task notification message
 */
function formatTaskNotification(task: Task): string {
  let message = `✅ *Task Completed*\n\n${task.content}`;

  if (task.duration_minutes && task.duration_minutes > 0) {
    const hours = Math.floor(task.duration_minutes / 60);
    const minutes = task.duration_minutes % 60;
    
    let timeStr = '';
    if (hours > 0) timeStr += `${hours}h `;
    if (minutes > 0) timeStr += `${minutes}m`;
    
    message += `\n⏱ Duration: ${timeStr.trim()}`;
  }

  if (task.quantity) {
    message += `\n📊 Quantity: ${task.quantity} ${task.quantity_unit || 'units'}`;
  }

  if (task.category) {
    message += `\n🏷 Category: #${task.category}`;
  }

  return message;
}
