/**
 * Tasking State Helper
 *
 * Determines whether to block coach interventions: only when the user has an
 * ACTIVE task session (starttask in progress) or a report Q&A conversation in progress.
 * All other states (inactive, leftover conversation_state from past flows) allow coach.
 */

import type { SupabaseClient } from '../database/client';
import { op } from '../database/client';
import { createTaskSessionManager } from '../services/task-session-manager';

export type CoachBlockResult = { blocked: boolean; reason?: string };

/**
 * Keys that indicate report Q&A is actively in progress (conversation_state).
 * Only these + active task_sessions block coach; other keys (pending_duration,
 * task_select, failure_*, etc.) do NOT block so inactive users still get interventions.
 */
const REPORT_FLOW_KEYS = (chatId: string) => [
  `post_qa_${chatId}`,
  `pending_report_save_${chatId}`,
  chatId, // qa_report uses chat_id = chatId
];

/**
 * Returns whether to block a coach intervention and why.
 * Reads current state from DB only (no in-memory cache).
 *
 * BLOCK only when:
 * - User has an ACTIVE task session (starttask pressed, not ended/paused), or
 * - A report Q&A conversation is actively in progress.
 *
 * ALLOW when:
 * - User is inactive (no active session, no report flow).
 * - Stale conversation_state from past flows (e.g. pending_duration, task_select) does NOT block.
 */
export async function isUserInTaskOrReportFlow(
  db: SupabaseClient,
  chatId: string
): Promise<CoachBlockResult> {
  if (!chatId) return { blocked: false };

  try {
    // 1. Active task session from DB (task_sessions where status = 'active')
    const sessionMgr = createTaskSessionManager(db);
    const activeSession = await sessionMgr.getActiveSession(chatId);
    if (activeSession) {
      return { blocked: true, reason: 'active task session' };
    }

    // 2. Report Q&A in progress (conversation_state, fresh read)
    const keys = REPORT_FLOW_KEYS(chatId);
    const results = await Promise.all(
      keys.map((key) =>
        db.select('conversation_state', {
          filter: { chat_id: op.eq(key) },
          limit: 1,
        })
      )
    );
    const reportInProgress = results.some((r) => r && r.length > 0);
    if (reportInProgress) {
      return { blocked: true, reason: 'report Q&A in progress' };
    }

    return { blocked: false };
  } catch (err) {
    console.error('isUserInTaskOrReportFlow error:', err);
    return { blocked: false }; // Fail open - allow coach if we can't determine state
  }
}
