/**
 * Coaching Analytics Service
 *
 * Tracks which coaching interventions lead to action, enabling adaptive coaching.
 * Learns from user responses to optimize intervention effectiveness.
 */

import { SupabaseClient, op } from '../database/client';
import { getTodayInEgypt } from '../utils/timezone';
import { InterventionType } from './meta-coach';

// ============================================
// Types
// ============================================

export interface PendingCheckin {
  id: string;
  chatId: string;
  interventionType: InterventionType;
  startedAt: Date;
  expiresAt: Date;
  conversationTurns: number;
  maxTurns: number;
  status: 'active' | 'completed' | 'expired';
  userMood?: 'high' | 'normal' | 'low';
  messagesReceived: number;
}

export interface CoachingEffectiveness {
  interventionType: string;
  totalCount: number;
  ledToAction: number;
  averageResponseTime: number; // seconds
  successRate: number; // 0-1
}

export interface AdaptiveCoachingStyle {
  preferredStyle: 'confrontational' | 'supportive' | 'balanced';
  effectiveInterventions: string[];
  lessEffectiveInterventions: string[];
  bestTimeOfDay: string;
  respondsBetterTo: 'questions' | 'commands' | 'encouragement';
}

// ============================================
// Coaching Analytics Class
// ============================================

export class CoachingAnalytics {
  constructor(private db: SupabaseClient) {}

  // ============================================
  // Pending Check-in Management
  // ============================================

  /**
   * Create a pending check-in after sending a coach message
   */
  async createPendingCheckin(
    chatId: string,
    interventionType: InterventionType,
    windowMinutes: number = 5
  ): Promise<PendingCheckin> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + windowMinutes * 60 * 1000);
    const id = `checkin_${chatId}_${now.getTime()}`;

    const checkin: PendingCheckin = {
      id,
      chatId,
      interventionType,
      startedAt: now,
      expiresAt,
      conversationTurns: 0,
      maxTurns: 3,
      status: 'active',
      messagesReceived: 0,
    };

    await this.db.upsert('pending_checkins', {
      id,
      chat_id: chatId,
      intervention_type: interventionType,
      started_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      conversation_turns: 0,
      max_turns: 3,
      status: 'active',
      messages_received: 0,
      created_at: now.toISOString(),
    }, 'id');

    return checkin;
  }

  /**
   * Get active pending check-in for a chat
   * When the check-in has expired and no reply was received, calls onExpiredNoResponse(chatId) if provided, then expires the check-in.
   */
  async getActiveCheckin(chatId: string, options?: { onExpiredNoResponse?: (chatId: string) => Promise<void> }): Promise<PendingCheckin | null> {
    try {
      const results = await this.db.select('pending_checkins', {
        filter: {
          chat_id: op.eq(chatId),
          status: op.eq('active'),
        },
        order: 'started_at.desc',
        limit: 1,
      });

      if (results.length === 0) return null;

      const r = results[0] as any;
      const now = new Date();
      const expiresAt = new Date(r.expires_at);

      // Check if expired
      if (now > expiresAt) {
        const noReply = (r.messages_received || 0) === 0;
        if (noReply && options?.onExpiredNoResponse) {
          try {
            await options.onExpiredNoResponse(r.chat_id);
          } catch (err) {
            console.error('onExpiredNoResponse error:', err);
          }
        }
        await this.expireCheckin(r.id);
        return null;
      }

      return {
        id: r.id,
        chatId: r.chat_id,
        interventionType: r.intervention_type,
        startedAt: new Date(r.started_at),
        expiresAt,
        conversationTurns: r.conversation_turns || 0,
        maxTurns: r.max_turns || 3,
        status: r.status,
        userMood: r.user_mood,
        messagesReceived: r.messages_received || 0,
      };
    } catch (error) {
      console.error('Error getting active checkin:', error);
      return null;
    }
  }

  /**
   * Record user response to check-in (text message)
   */
  async recordTextResponse(
    checkinId: string,
    extendMinutes: number = 2,
    maxTotalMinutes: number = 10
  ): Promise<PendingCheckin | null> {
    try {
      const results = await this.db.select('pending_checkins', {
        filter: { id: op.eq(checkinId) },
        limit: 1,
      });

      if (results.length === 0) return null;

      const r = results[0] as any;
      const now = new Date();
      const startedAt = new Date(r.started_at);
      const currentExpires = new Date(r.expires_at);

      // Calculate new expiration (extend by extendMinutes, max maxTotalMinutes from start)
      const maxExpires = new Date(startedAt.getTime() + maxTotalMinutes * 60 * 1000);
      let newExpires = new Date(currentExpires.getTime() + extendMinutes * 60 * 1000);
      if (newExpires > maxExpires) {
        newExpires = maxExpires;
      }

      const newTurns = (r.conversation_turns || 0) + 1;
      const newMessages = (r.messages_received || 0) + 1;

      await this.db.update(
        'pending_checkins',
        { id: op.eq(checkinId) },
        {
          expires_at: newExpires.toISOString(),
          conversation_turns: newTurns,
          messages_received: newMessages,
          updated_at: now.toISOString(),
        }
      );

      return {
        id: r.id,
        chatId: r.chat_id,
        interventionType: r.intervention_type,
        startedAt: new Date(r.started_at),
        expiresAt: newExpires,
        conversationTurns: newTurns,
        maxTurns: r.max_turns || 3,
        status: 'active',
        userMood: r.user_mood,
        messagesReceived: newMessages,
      };
    } catch (error) {
      console.error('Error recording text response:', error);
      return null;
    }
  }

  /**
   * Record action taken (starttask, stuck, etc.)
   */
  async recordActionTaken(
    chatId: string,
    action: string
  ): Promise<void> {
    try {
      const checkin = await this.getActiveCheckin(chatId);
      if (!checkin) return;

      const now = new Date();
      const responseTime = Math.round((now.getTime() - checkin.startedAt.getTime()) / 1000);

      // Complete the check-in
      await this.db.update(
        'pending_checkins',
        { id: op.eq(checkin.id) },
        {
          status: 'completed',
          updated_at: now.toISOString(),
        }
      );

      // Log the effectiveness
      await this.logInterventionOutcome(
        chatId,
        checkin.interventionType,
        true, // led to action
        responseTime,
        action,
        checkin.userMood
      );
    } catch (error) {
      console.error('Error recording action:', error);
    }
  }

  /**
   * Set user mood for current check-in
   */
  async setUserMood(chatId: string, mood: 'high' | 'normal' | 'low'): Promise<void> {
    try {
      const checkin = await this.getActiveCheckin(chatId);
      if (!checkin) return;

      await this.db.update(
        'pending_checkins',
        { id: op.eq(checkin.id) },
        {
          user_mood: mood,
          updated_at: new Date().toISOString(),
        }
      );
    } catch (error) {
      console.error('Error setting user mood:', error);
    }
  }

  /**
   * Expire a check-in (no response received)
   */
  async expireCheckin(checkinId: string): Promise<void> {
    try {
      const results = await this.db.select('pending_checkins', {
        filter: { id: op.eq(checkinId) },
        limit: 1,
      });

      if (results.length === 0) return;

      const r = results[0] as any;
      const now = new Date();

      await this.db.update(
        'pending_checkins',
        { id: op.eq(checkinId) },
        {
          status: 'expired',
          updated_at: now.toISOString(),
        }
      );

      // Log as no response (led_to_action = false)
      await this.logInterventionOutcome(
        r.chat_id,
        r.intervention_type,
        false,
        null,
        'no_response',
        r.user_mood
      );
    } catch (error) {
      console.error('Error expiring checkin:', error);
    }
  }

  /**
   * Complete check-in after conversation ends
   */
  async completeCheckin(chatId: string, ledToAction: boolean): Promise<void> {
    try {
      const checkin = await this.getActiveCheckin(chatId);
      if (!checkin) return;

      const now = new Date();
      const responseTime = Math.round((now.getTime() - checkin.startedAt.getTime()) / 1000);

      await this.db.update(
        'pending_checkins',
        { id: op.eq(checkin.id) },
        {
          status: 'completed',
          updated_at: now.toISOString(),
        }
      );

      await this.logInterventionOutcome(
        chatId,
        checkin.interventionType,
        ledToAction,
        responseTime,
        ledToAction ? 'conversation_to_action' : 'conversation_no_action',
        checkin.userMood
      );
    } catch (error) {
      console.error('Error completing checkin:', error);
    }
  }

  // ============================================
  // Analytics and Adaptation
  // ============================================

  /**
   * Log intervention outcome for analytics
   */
  private async logInterventionOutcome(
    chatId: string,
    interventionType: string,
    ledToAction: boolean,
    responseTimeSeconds: number | null,
    outcome: string,
    mood?: string
  ): Promise<void> {
    try {
      const today = getTodayInEgypt();

      await this.db.insert('coaching_effectiveness', {
        chat_id: chatId,
        intervention_type: interventionType,
        led_to_action: ledToAction,
        response_time_seconds: responseTimeSeconds,
        outcome,
        user_mood: mood || null,
        recorded_date: today,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error logging intervention outcome:', error);
    }
  }

  /**
   * Get effectiveness stats for a user
   */
  async getEffectivenessStats(chatId: string, days: number = 30): Promise<CoachingEffectiveness[]> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      const cutoffStr = cutoffDate.toISOString().split('T')[0] || '';

      const results = await this.db.select('coaching_effectiveness', {
        filter: { chat_id: op.eq(chatId) },
      });

      // Filter by date and group by intervention type
      const grouped = new Map<string, {
        total: number;
        ledToAction: number;
        responseTimes: number[];
      }>();

      for (const r of results) {
        const record = r as any;
        if (!cutoffStr || record.recorded_date < cutoffStr) continue;

        const type = record.intervention_type;
        const existing = grouped.get(type) || {
          total: 0,
          ledToAction: 0,
          responseTimes: [],
        };

        existing.total++;
        if (record.led_to_action) existing.ledToAction++;
        if (record.response_time_seconds) {
          existing.responseTimes.push(record.response_time_seconds);
        }

        grouped.set(type, existing);
      }

      // Convert to effectiveness array
      const effectiveness: CoachingEffectiveness[] = [];
      for (const [type, data] of grouped) {
        const avgResponseTime = data.responseTimes.length > 0
          ? data.responseTimes.reduce((a, b) => a + b, 0) / data.responseTimes.length
          : 0;

        effectiveness.push({
          interventionType: type,
          totalCount: data.total,
          ledToAction: data.ledToAction,
          averageResponseTime: Math.round(avgResponseTime),
          successRate: data.total > 0 ? data.ledToAction / data.total : 0,
        });
      }

      return effectiveness.sort((a, b) => b.successRate - a.successRate);
    } catch (error) {
      console.error('Error getting effectiveness stats:', error);
      return [];
    }
  }

  /**
   * Get adaptive coaching style recommendation
   */
  async getAdaptiveStyle(chatId: string): Promise<AdaptiveCoachingStyle> {
    const stats = await this.getEffectivenessStats(chatId);

    // Default style
    const style: AdaptiveCoachingStyle = {
      preferredStyle: 'balanced',
      effectiveInterventions: [],
      lessEffectiveInterventions: [],
      bestTimeOfDay: 'morning',
      respondsBetterTo: 'encouragement',
    };

    if (stats.length === 0) return style;

    // Analyze which interventions work best
    const effective = stats.filter(s => s.successRate >= 0.5);
    const lessEffective = stats.filter(s => s.successRate < 0.3);

    style.effectiveInterventions = effective.map(e => e.interventionType);
    style.lessEffectiveInterventions = lessEffective.map(e => e.interventionType);

    // Determine preferred style based on what works
    const confrontationalWorks = effective.some(e =>
      ['escalation', 'inactivity_nudge'].includes(e.interventionType)
    );
    const supportiveWorks = effective.some(e =>
      ['celebration', 'momentum_check'].includes(e.interventionType)
    );

    if (confrontationalWorks && !supportiveWorks) {
      style.preferredStyle = 'confrontational';
    } else if (supportiveWorks && !confrontationalWorks) {
      style.preferredStyle = 'supportive';
    }

    return style;
  }

  /**
   * Check if we should skip intervention based on effectiveness
   */
  async shouldSkipIntervention(chatId: string, interventionType: InterventionType): Promise<boolean> {
    const stats = await this.getEffectivenessStats(chatId, 14); // Last 2 weeks

    const typeStats = stats.find(s => s.interventionType === interventionType);

    // If this intervention type has very low success rate (< 10%) and we've tried it enough times (5+)
    if (typeStats && typeStats.totalCount >= 5 && typeStats.successRate < 0.1) {
      return true;
    }

    return false;
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Clean up old pending check-ins
   */
  async cleanupOldCheckins(): Promise<void> {
    try {
      const cutoffTime = new Date();
      cutoffTime.setHours(cutoffTime.getHours() - 1); // Delete check-ins older than 1 hour

      // Note: This is a simplified cleanup. In production, you'd want a proper query.
      const results = await this.db.select('pending_checkins', {
        filter: { status: op.eq('active') },
      });

      for (const r of results) {
        const record = r as any;
        const expiresAt = new Date(record.expires_at);
        if (expiresAt < cutoffTime) {
          await this.expireCheckin(record.id);
        }
      }
    } catch (error) {
      console.error('Error cleaning up old checkins:', error);
    }
  }
}

// ============================================
// Factory Function
// ============================================

export function createCoachingAnalytics(db: SupabaseClient): CoachingAnalytics {
  return new CoachingAnalytics(db);
}
