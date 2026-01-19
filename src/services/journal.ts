/**
 * Journal Service
 *
 * Handles daily journaling with support for:
 * - Text messages and media (images, videos, documents)
 * - Session management (start/end/resume)
 * - Chronological ordering within days
 * - Integration with AI report generation
 */

import { SupabaseClient, op } from '../database/client';
import { JournalEntry } from '../types';
import { getTodayInEgypt } from '../utils/timezone';

// ============================================
// Journal Manager
// ============================================

export class JournalManager {
  constructor(private db: SupabaseClient) {}

  /**
   * Start a new journaling session for today
   * Returns true if started successfully, false if session already exists
   */
  async startSession(): Promise<{ success: boolean; message: string }> {
    const today = getTodayInEgypt();

    // Check if there's already an active session
    const existingSession = await this.getActiveSession(today);
    if (existingSession) {
      return {
        success: false,
        message: 'لديك جلسة يوميات نشطة بالفعل. استخدم /journal_resume للاستمرار أو /journal_end لإنهائها.',
      };
    }

    // Check if there's a closed session for today
    const closedSession = await this.hasClosedSession(today);
    if (closedSession) {
      return {
        success: false,
        message: 'لقد أنهيت جلسة اليوم. استخدم /journal_resume لإعادة فتحها.',
      };
    }

    // Get next entry order
    const nextOrder = await this.getNextEntryOrder(today);

    // Create session start entry
    await this.db.insert('journal_entries', {
      entry_date: today,
      message_text: null,
      entry_order: nextOrder,
      is_session_start: true,
      is_session_end: false,
      created_at: new Date().toISOString(),
    });

    return {
      success: true,
      message: '📝 بدأت جلسة اليوميات! أرسل رسائلك، صورك، أو فيديوهاتك وسأحفظها لك.\n\nاستخدم /journal_end لإنهاء الجلسة.',
    };
  }

  /**
   * End the current journaling session
   * Handles midnight boundary by checking yesterday's session if needed
   */
  async endSession(): Promise<{ success: boolean; message: string; entryCount: number }> {
    // First check today's date for active session
    let sessionDate = getTodayInEgypt();
    let hasActiveSession = await this.getActiveSession(sessionDate);

    // If no active session today, check yesterday (for midnight boundary)
    if (!hasActiveSession) {
      const yesterday = this.getYesterdayInEgypt();
      hasActiveSession = await this.getActiveSession(yesterday);
      if (hasActiveSession) {
        sessionDate = yesterday;
      }
    }

    if (!hasActiveSession) {
      return {
        success: false,
        message: 'لا توجد جلسة يوميات نشطة. استخدم /journal_start لبدء جلسة جديدة.',
        entryCount: 0,
      };
    }

    // Get next entry order
    const nextOrder = await this.getNextEntryOrder(sessionDate);

    // Create session end entry with the session's date
    await this.db.insert('journal_entries', {
      entry_date: sessionDate,
      message_text: null,
      entry_order: nextOrder,
      is_session_start: false,
      is_session_end: true,
      created_at: new Date().toISOString(),
    });

    // Get entry count for the session date
    const entries = await this.getEntriesForDate(sessionDate);
    const entryCount = entries.filter(e => e.message_text || e.media_url).length;

    return {
      success: true,
      message: `✅ تم إنهاء جلسة اليوميات! سجلت ${entryCount} إدخال(ات) في ${sessionDate}.\n\nستظهر في تقريرك اليومي.`,
      entryCount,
    };
  }

  /**
   * Resume a closed journaling session for today
   */
  async resumeSession(): Promise<{ success: boolean; message: string }> {
    const today = getTodayInEgypt();

    // Check if there's already an active session
    const activeSession = await this.getActiveSession(today);
    if (activeSession) {
      return {
        success: false,
        message: 'جلسة اليوميات نشطة بالفعل! أرسل رسائلك مباشرة.',
      };
    }

    // Check if there's a closed session to resume
    const closedSession = await this.hasClosedSession(today);
    if (!closedSession) {
      return {
        success: false,
        message: 'لا توجد جلسة يوميات لاستئنافها. استخدم /journal_start لبدء جلسة جديدة.',
      };
    }

    // Remove the end marker to resume session
    await this.db.delete('journal_entries', {
      entry_date: op.eq(today),
      is_session_end: op.eq(true),
    });

    return {
      success: true,
      message: '📝 تم استئناف جلسة اليوميات! أرسل رسائلك، صورك، أو فيديوهاتك.\n\nاستخدم /journal_end لإنهاء الجلسة.',
    };
  }

  /**
   * Add a text entry to the journal
   * Uses the session's start date to handle midnight boundary correctly
   */
  async addTextEntry(text: string): Promise<{ success: boolean; message?: string }> {
    // First check today's date for active session
    let sessionDate = getTodayInEgypt();
    let hasActiveSession = await this.getActiveSession(sessionDate);

    // If no active session today, check yesterday (for midnight boundary)
    if (!hasActiveSession) {
      const yesterday = this.getYesterdayInEgypt();
      hasActiveSession = await this.getActiveSession(yesterday);
      if (hasActiveSession) {
        sessionDate = yesterday; // Use yesterday's date for entries
      }
    }

    if (!hasActiveSession) {
      return {
        success: false,
        message: 'لا توجد جلسة يوميات نشطة. استخدم /journal_start لبدء جلسة.',
      };
    }

    const nextOrder = await this.getNextEntryOrder(sessionDate);

    await this.db.insert('journal_entries', {
      entry_date: sessionDate, // Use session date, not current date
      message_text: text,
      entry_order: nextOrder,
      is_session_start: false,
      is_session_end: false,
      created_at: new Date().toISOString(),
    });

    return { success: true };
  }

  /**
   * Add a media entry to the journal
   * Returns the entry ID so it can be updated with storage URL later
   * Uses the session's start date to handle midnight boundary correctly
   */
  async addMediaEntry(
    mediaUrl: string,
    mediaType: 'image' | 'video' | 'document' | 'voice',
    caption?: string
  ): Promise<{ success: boolean; message?: string; entryId?: string }> {
    // First check today's date for active session
    let sessionDate = getTodayInEgypt();
    let hasActiveSession = await this.getActiveSession(sessionDate);

    // If no active session today, check yesterday (for midnight boundary)
    if (!hasActiveSession) {
      const yesterday = this.getYesterdayInEgypt();
      hasActiveSession = await this.getActiveSession(yesterday);
      if (hasActiveSession) {
        sessionDate = yesterday; // Use yesterday's date for entries
      }
    }

    if (!hasActiveSession) {
      return {
        success: false,
        message: 'لا توجد جلسة يوميات نشطة. استخدم /journal_start لبدء جلسة.',
      };
    }

    const nextOrder = await this.getNextEntryOrder(sessionDate);

    const inserted = await this.db.insert<JournalEntry>('journal_entries', {
      entry_date: sessionDate, // Use session date, not current date
      message_text: caption || null,
      media_url: mediaUrl,
      media_type: mediaType,
      entry_order: nextOrder,
      is_session_start: false,
      is_session_end: false,
      created_at: new Date().toISOString(),
    });

    return {
      success: true,
      entryId: inserted[0]?.id,
    };
  }

  /**
   * Update media URL for an entry (after uploading to storage)
   */
  async updateMediaUrl(entryId: string, newUrl: string): Promise<boolean> {
    try {
      await this.db.update(
        'journal_entries',
        { id: op.eq(entryId) },
        { media_url: newUrl }
      );
      return true;
    } catch (error) {
      console.error('Error updating media URL:', error);
      return false;
    }
  }

  /**
   * Get formatted journal with media URLs for display
   */
  async getFormattedJournalWithMedia(date: string): Promise<string | null> {
    const entries = await this.getEntriesForDate(date);

    if (entries.length === 0) {
      return null;
    }

    // Filter out session markers
    const contentEntries = entries.filter(e => e.message_text || e.media_url);

    if (contentEntries.length === 0) {
      return null;
    }

    let formatted = '📔 **يوميات اليوم:**\n\n';

    contentEntries.forEach((entry, i) => {
      formatted += `**[${i + 1}]** `;

      if (entry.message_text) {
        formatted += `${entry.message_text}\n`;
      }

      if (entry.media_url) {
        const mediaLabel =
          entry.media_type === 'image' ? '📷 صورة' :
          entry.media_type === 'video' ? '🎥 فيديو' :
          entry.media_type === 'voice' ? '🎤 رسالة صوتية' :
          '📄 ملف';

        // Check if it's a Supabase URL (not a Telegram file_id)
        if (entry.media_url.startsWith('http')) {
          formatted += `${mediaLabel}: ${entry.media_url}\n`;
        } else {
          formatted += `${mediaLabel}: (محفوظ في Telegram)\n`;
        }
      }
      formatted += '\n';
    });

    return formatted;
  }

  /**
   * Get all entries for a specific date
   */
  async getEntriesForDate(date: string): Promise<JournalEntry[]> {
    const entries = await this.db.select<JournalEntry>('journal_entries', {
      filter: { entry_date: op.eq(date) },
      order: 'entry_order',
    });

    return entries;
  }

  /**
   * Get formatted journal for AI context
   */
  async getFormattedJournal(date: string): Promise<string | null> {
    const entries = await this.getEntriesForDate(date);

    if (entries.length === 0) {
      return null;
    }

    // Filter out session markers
    const contentEntries = entries.filter(e => e.message_text || e.media_url);

    if (contentEntries.length === 0) {
      return null;
    }

    let formatted = '📔 يوميات اليوم:\n\n';

    for (const entry of contentEntries) {
      if (entry.message_text) {
        formatted += `• ${entry.message_text}\n`;
      }
      if (entry.media_url) {
        const mediaLabel =
          entry.media_type === 'image' ? '📷 صورة' :
          entry.media_type === 'video' ? '🎥 فيديو' :
          entry.media_type === 'voice' ? '🎤 رسالة صوتية' :
          '📄 ملف';
        formatted += `  [${mediaLabel}]\n`;
      }
    }

    return formatted;
  }

  /**
   * Check if today has journal entries (for report preview)
   */
  async hasEntriesForDate(date: string): Promise<boolean> {
    const entries = await this.getEntriesForDate(date);
    return entries.some(e => e.message_text || e.media_url);
  }

  /**
   * Get entry count for a date
   */
  async getEntryCountForDate(date: string): Promise<number> {
    const entries = await this.getEntriesForDate(date);
    return entries.filter(e => e.message_text || e.media_url).length;
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Check if there's an active (open) session for a date
   */
  private async getActiveSession(date: string): Promise<boolean> {
    const entries = await this.db.select<JournalEntry>('journal_entries', {
      filter: { entry_date: op.eq(date) },
      order: 'entry_order.desc',
    });

    if (entries.length === 0) {
      return false;
    }

    // Check if last entry is a session start or regular entry (not end)
    const hasStart = entries.some(e => e.is_session_start);
    const hasEnd = entries.some(e => e.is_session_end);

    return hasStart && !hasEnd;
  }

  /**
   * Check if there's a closed session for a date
   */
  private async hasClosedSession(date: string): Promise<boolean> {
    const entries = await this.db.select<JournalEntry>('journal_entries', {
      filter: { entry_date: op.eq(date) },
    });

    const hasStart = entries.some(e => e.is_session_start);
    const hasEnd = entries.some(e => e.is_session_end);

    return hasStart && hasEnd;
  }

  /**
   * Get the next entry order number for a date
   */
  private async getNextEntryOrder(date: string): Promise<number> {
    const entries = await this.db.select<JournalEntry>('journal_entries', {
      filter: { entry_date: op.eq(date) },
      order: 'entry_order.desc',
      limit: 1,
    });

    if (entries.length === 0 || !entries[0]) {
      return 1;
    }

    return (entries[0].entry_order || 0) + 1;
  }

  /**
   * Get yesterday's date in Egypt timezone (for midnight boundary handling)
   */
  private getYesterdayInEgypt(): string {
    const now = new Date();
    // Subtract 1 day
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    // Convert to Egypt timezone
    const egyptTime = new Date(yesterday.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
    const year = egyptTime.getFullYear();
    const month = String(egyptTime.getMonth() + 1).padStart(2, '0');
    const day = String(egyptTime.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

// ============================================
// Factory Function
// ============================================

export function createJournalManager(db: SupabaseClient): JournalManager {
  return new JournalManager(db);
}
