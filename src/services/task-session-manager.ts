/**
 * Task Session Manager - Cumulative Time Tracking
 *
 * Purpose: Track work sessions across multiple sittings on the same task.
 * Supports pause/resume functionality with /resumelater and /resumetask commands.
 *
 * Key Features:
 * - Pause active tasks and save progress
 * - Resume paused tasks with cumulative time
 * - Auto-pause stale sessions (4+ hours)
 * - Match tasks by NAME, not just ID (IDs can change)
 */

import { SupabaseClient, op } from '../database/client';
import { extractCleanTaskName } from '../utils/task-parser';

// ============================================
// Types
// ============================================

export interface TaskSession {
  id: string;
  chatId: string;
  taskId: string | null;
  taskContent: string;
  totalTimeWorked: number; // minutes
  sessionCount: number;
  firstStartedAt: Date;
  lastResumedAt: Date | null;
  lastPausedAt: Date | null;
  status: 'active' | 'paused' | 'completed' | 'abandoned';
  pauseReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PauseResult {
  session: TaskSession;
  timeWorkedThisSession: number; // minutes
}

export interface CompleteResult {
  session: TaskSession;
  totalTime: number; // minutes
}

// ============================================
// Task Session Manager Class
// ============================================

export class TaskSessionManager {
  constructor(private db: SupabaseClient) {}

  /**
   * Get paused session by task ID
   */
  async getPausedSession(chatId: string, taskId: string): Promise<TaskSession | null> {
    const results = await this.db.select('task_sessions', {
      filter: {
        chat_id: op.eq(chatId),
        task_id: op.eq(taskId),
        status: op.eq('paused'),
      },
      limit: 1,
    });

    return results.length > 0 ? this.mapToTaskSession(results[0]) : null;
  }

  /**
   * Get paused session by task name (CRITICAL: Use this for matching)
   */
  async getPausedSessionByName(chatId: string, taskName: string): Promise<TaskSession | null> {
    const cleanName = extractCleanTaskName(taskName);

    // Get all paused sessions and filter by clean name
    const results = await this.db.select('task_sessions', {
      filter: {
        chat_id: op.eq(chatId),
        status: op.eq('paused'),
      },
    });

    // Find matching session by clean name
    for (const result of results) {
      const sessionCleanName = extractCleanTaskName(result.task_content as string);
      if (sessionCleanName === cleanName) {
        return this.mapToTaskSession(result);
      }
    }

    return null;
  }

  /**
   * Get active session for a chat (should only be one at a time)
   */
  async getActiveSession(chatId: string): Promise<TaskSession | null> {
    const results = await this.db.select('task_sessions', {
      filter: {
        chat_id: op.eq(chatId),
        status: op.eq('active'),
      },
      limit: 1,
    });

    return results.length > 0 ? this.mapToTaskSession(results[0]) : null;
  }

  /**
   * Start a new session or resume existing paused session
   */
  async startSession(
    chatId: string,
    taskId: string | null,
    taskContent: string
  ): Promise<TaskSession> {
    const now = new Date();

    // Check for existing paused session by name first, then by ID
    let existingSession = await this.getPausedSessionByName(chatId, taskContent);
    if (!existingSession && taskId) {
      existingSession = await this.getPausedSession(chatId, taskId);
    }

    if (existingSession) {
      // Resume existing session
      return this.resumeSession(existingSession.id);
    }

    // Create new session
    const sessionData = {
      chat_id: chatId,
      task_id: taskId,
      task_content: extractCleanTaskName(taskContent),
      total_time_worked: 0,
      session_count: 1,
      first_started_at: now.toISOString(),
      last_resumed_at: now.toISOString(),
      status: 'active',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };

    await this.db.insert('task_sessions', sessionData);

    // Fetch the created session
    const results = await this.db.select('task_sessions', {
      filter: {
        chat_id: op.eq(chatId),
        status: op.eq('active'),
      },
      order: 'created_at.desc',
      limit: 1,
    });

    return this.mapToTaskSession(results[0]);
  }

  /**
   * Resume a paused session
   */
  async resumeSession(sessionId: string): Promise<TaskSession> {
    const now = new Date();

    // Get the session
    const results = await this.db.select('task_sessions', {
      filter: { id: op.eq(sessionId) },
      limit: 1,
    });

    if (results.length === 0) {
      throw new Error('Session not found');
    }

    const session = results[0];

    // Update session to active
    await this.db.update(
      'task_sessions',
      { id: op.eq(sessionId) },
      {
        status: 'active',
        last_resumed_at: now.toISOString(),
        session_count: (session.session_count as number) + 1,
        updated_at: now.toISOString(),
      }
    );

    // Return updated session
    const updated = await this.db.select('task_sessions', {
      filter: { id: op.eq(sessionId) },
      limit: 1,
    });

    return this.mapToTaskSession(updated[0]);
  }

  /**
   * Pause the current session (for /resumelater)
   */
  async pauseSession(chatId: string, reason?: string): Promise<PauseResult> {
    const now = new Date();

    // Get active session
    const activeSession = await this.getActiveSession(chatId);
    if (!activeSession) {
      throw new Error('No active session to pause');
    }

    // Calculate time worked this session
    const sessionStart = activeSession.lastResumedAt || activeSession.firstStartedAt;
    const timeWorkedMs = now.getTime() - sessionStart.getTime();
    const timeWorkedMinutes = Math.max(0, Math.round(timeWorkedMs / 60000));

    // Update total time and status
    const newTotalTime = activeSession.totalTimeWorked + timeWorkedMinutes;

    await this.db.update(
      'task_sessions',
      { id: op.eq(activeSession.id) },
      {
        status: 'paused',
        total_time_worked: newTotalTime,
        last_paused_at: now.toISOString(),
        pause_reason: reason || null,
        updated_at: now.toISOString(),
      }
    );

    // Return updated session
    const updated = await this.db.select('task_sessions', {
      filter: { id: op.eq(activeSession.id) },
      limit: 1,
    });

    return {
      session: this.mapToTaskSession(updated[0]),
      timeWorkedThisSession: timeWorkedMinutes,
    };
  }

  /**
   * Complete the session (for /completetask)
   */
  async completeSession(chatId: string): Promise<CompleteResult> {
    const now = new Date();

    // Get active session
    const activeSession = await this.getActiveSession(chatId);
    if (!activeSession) {
      throw new Error('No active session to complete');
    }

    // Calculate final time worked
    const sessionStart = activeSession.lastResumedAt || activeSession.firstStartedAt;
    const timeWorkedMs = now.getTime() - sessionStart.getTime();
    const timeWorkedMinutes = Math.max(0, Math.round(timeWorkedMs / 60000));

    // Update total time and status
    const totalTime = activeSession.totalTimeWorked + timeWorkedMinutes;

    await this.db.update(
      'task_sessions',
      { id: op.eq(activeSession.id) },
      {
        status: 'completed',
        total_time_worked: totalTime,
        updated_at: now.toISOString(),
      }
    );

    // Return updated session
    const updated = await this.db.select('task_sessions', {
      filter: { id: op.eq(activeSession.id) },
      limit: 1,
    });

    return {
      session: this.mapToTaskSession(updated[0]),
      totalTime,
    };
  }

  /**
   * Abandon session without saving (for /abandonsession)
   */
  async abandonSession(chatId: string): Promise<void> {
    const activeSession = await this.getActiveSession(chatId);
    if (!activeSession) {
      throw new Error('No active session to abandon');
    }

    await this.db.update(
      'task_sessions',
      { id: op.eq(activeSession.id) },
      {
        status: 'abandoned',
        updated_at: new Date().toISOString(),
      }
    );
  }

  /**
   * Get all paused sessions for a user
   */
  async getAllPausedSessions(chatId: string): Promise<TaskSession[]> {
    const results = await this.db.select('task_sessions', {
      filter: {
        chat_id: op.eq(chatId),
        status: op.eq('paused'),
      },
      order: 'last_paused_at.desc',
    });

    return results.map((r) => this.mapToTaskSession(r));
  }

  /**
   * Auto-pause stale sessions (4+ hours old)
   */
  async autoPauseStaleSession(chatId: string): Promise<TaskSession | null> {
    const activeSession = await this.getActiveSession(chatId);
    if (!activeSession) {
      return null;
    }

    const sessionStart = activeSession.lastResumedAt || activeSession.firstStartedAt;
    const hoursActive = (Date.now() - sessionStart.getTime()) / (1000 * 60 * 60);

    if (hoursActive >= 4) {
      const result = await this.pauseSession(chatId, 'auto-paused after 4+ hours');
      return result.session;
    }

    return null;
  }

  /**
   * Get multi-session tasks (tasks with more than one session)
   */
  async getMultiSessionTasks(chatId: string, days: number = 7): Promise<TaskSession[]> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const results = await this.db.select('task_sessions', {
      filter: {
        chat_id: op.eq(chatId),
      },
      order: 'updated_at.desc',
    });

    // Filter to sessions with multiple counts and within date range
    return results
      .filter((r) => {
        const updatedAt = new Date(r.updated_at as string);
        return updatedAt >= cutoffDate && (r.session_count as number) > 1;
      })
      .map((r) => this.mapToTaskSession(r));
  }

  /**
   * Check if there's a paused session for a task (by name or ID)
   */
  async hasPausedSession(chatId: string, taskName: string, taskId?: string): Promise<TaskSession | null> {
    // First try by name
    const byName = await this.getPausedSessionByName(chatId, taskName);
    if (byName) return byName;

    // Then try by ID
    if (taskId) {
      const byId = await this.getPausedSession(chatId, taskId);
      if (byId) return byId;
    }

    return null;
  }

  /**
   * Delete all sessions for a chat (cleanup)
   */
  async clearAllSessions(chatId: string): Promise<void> {
    await this.db.delete('task_sessions', {
      chat_id: op.eq(chatId),
    });
  }

  // ============================================
  // Private Helper Methods
  // ============================================

  private mapToTaskSession(record: any): TaskSession {
    return {
      id: record.id,
      chatId: record.chat_id,
      taskId: record.task_id,
      taskContent: record.task_content,
      totalTimeWorked: record.total_time_worked || 0,
      sessionCount: record.session_count || 1,
      firstStartedAt: new Date(record.first_started_at),
      lastResumedAt: record.last_resumed_at ? new Date(record.last_resumed_at) : null,
      lastPausedAt: record.last_paused_at ? new Date(record.last_paused_at) : null,
      status: record.status,
      pauseReason: record.pause_reason,
      createdAt: new Date(record.created_at),
      updatedAt: new Date(record.updated_at),
    };
  }
}

// ============================================
// Factory Function
// ============================================

export function createTaskSessionManager(db: SupabaseClient): TaskSessionManager {
  return new TaskSessionManager(db);
}
