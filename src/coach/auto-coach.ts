/**
 * Auto Coach - Proactive Intervention System
 *
 * Hybrid detection system:
 * 1. Scheduled check-ins at configured times
 * 2. Inactivity-based probes when no task completion
 *
 * Respects sleep periods and user preferences.
 * Confrontational style - pushes hard but never cruel.
 *
 * Settings:
 * - coach.auto_mode: 'off' | 'scheduled' | 'inactivity' | 'hybrid'
 * - coach.inactivity_threshold_hours: number (default: 2)
 * - coach.sleep_start: 'HH:MM' (default: '23:00')
 * - coach.sleep_end: 'HH:MM' (default: '07:00')
 * - coach.scheduled_checkins: 'HH:MM,HH:MM,...' (default: '10:00,14:00,18:00')
 */

import { SupabaseClient, op } from '../database/client';
import { SettingsManager } from '../database/settings';
import { AIMessage } from '../services/ai-client';
import { getTodayInEgypt } from '../utils/timezone';
import {
  CoachingContextBuilder,
  createCoachingContextBuilder,
  type CoachingInteraction,
} from './coaching-context';

// ============================================
// Types
// ============================================

export interface AutoCoachConfig {
  mode: 'off' | 'scheduled' | 'inactivity' | 'hybrid';
  inactivityThresholdHours: number;
  sleepStart: string; // HH:MM
  sleepEnd: string; // HH:MM
  scheduledCheckins: string[]; // ['10:00', '14:00', '18:00']
}

export interface ProbeResult {
  shouldProbe: boolean;
  reason: 'scheduled' | 'inactivity' | 'none';
  message?: string;
  hoursInactive?: number;
}

// ============================================
// AI Prompts
// ============================================

const INACTIVITY_PROBE_PROMPT = `You are a CONFRONTATIONAL productivity coach. The user has been inactive.

COACHING CONTEXT:
{CONTEXT}

SITUATION:
- Hours since last task completion: {HOURS_INACTIVE}
- Current time: {CURRENT_TIME}
- It's NOT sleep time, so they should be working.

Generate a SHORT (2-3 sentences) probing message that:
1. Directly calls out the inactivity
2. Asks what's blocking them (with slight accusation)
3. Demands an immediate response

Style: Direct, slightly aggressive, uses rhetorical questions.
No fluff, no pleasantries. Get to the point.

Arabic preferred. Mix English for impact.

Examples of good tone:
- "٣ ساعات بدون إنجاز واحد. وش السالفة؟ تماطل ولا صار شي؟"
- "الوقت يمشي وانت واقف. ليش؟ ابي جواب الحين."

DO NOT be supportive or understanding. Be challenging.`;

const SCHEDULED_CHECKIN_PROMPT = `You are a CONFRONTATIONAL productivity coach doing a scheduled check-in.

COACHING CONTEXT:
{CONTEXT}

SITUATION:
- Check-in time: {CHECKIN_TIME}
- Tasks completed today so far: {TASKS_TODAY}
- Last interaction: {LAST_INTERACTION}

Generate a SHORT (2-3 sentences) check-in that:
1. Assesses their progress bluntly
2. If tasks < expected: Challenge them aggressively
3. If tasks good: Brief acknowledgment, then push for more
4. Always end with a direct question or demand

Style: Like a drill sergeant doing inspection.
No praise without immediately raising expectations.

Arabic preferred. Mix English for impact.

Examples of good tone:
- "نص اليوم راح. {N} مهام فقط؟ وش خطتك للباقي؟"
- "أشوف تقدم بسيط. بس 'بسيط' ما يكفي. وش المهمة الجاية؟"
- "ممتاز حتى الآن. بس لا تظن إنك خلصت. وش التالي؟"`;

const RESPONSE_ANALYSIS_PROMPT = `Analyze the user's response to a coaching probe.

USER RESPONSE: "{RESPONSE}"

PROBE TYPE: {PROBE_TYPE}

Determine:
1. Are they making excuses or being genuine?
2. Should we escalate pressure or ease off?
3. What's the underlying blocker (fear, overwhelm, boredom, resistance)?

Return JSON:
{
  "isExcuse": boolean,
  "genuineBlocker": "fear" | "overwhelm" | "boredom" | "resistance" | "legitimate" | "unclear",
  "recommendedAction": "escalate" | "investigate" | "supportThenPush" | "acknowledge",
  "escalationLevel": 1-5
}`;

const FOLLOWUP_PROMPT = `Generate a follow-up based on user's response analysis.

ORIGINAL PROBE: {ORIGINAL_PROBE}
USER RESPONSE: "{USER_RESPONSE}"
ANALYSIS: {ANALYSIS}

COACHING CONTEXT:
{CONTEXT}

Generate a follow-up (2-3 sentences) that:
- If excuse detected: Call it out directly, demand action
- If genuine blocker: Briefly acknowledge, then pivot to smallest possible action
- If legitimate reason: Accept briefly, schedule next check-in

Style: CONFRONTATIONAL. Never let them off easy.
Even legitimate reasons get a "fine, but what CAN you do?"

Arabic preferred.`;

// ============================================
// Auto Coach Class
// ============================================

export class AutoCoach {
  private contextBuilder: CoachingContextBuilder;
  private aiComplete: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>;

  constructor(
    private db: SupabaseClient,
    private settings: SettingsManager,
    aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>
  ) {
    this.contextBuilder = createCoachingContextBuilder(db, settings);
    this.aiComplete = aiCompleteFunc;
  }

  /**
   * Get current auto-coach configuration
   */
  async getConfig(): Promise<AutoCoachConfig> {
    const [mode, threshold, sleepStart, sleepEnd, checkins] = await Promise.all([
      this.settings.get('coach.auto_mode'),
      this.settings.get('coach.inactivity_threshold_hours'),
      this.settings.get('coach.sleep_start'),
      this.settings.get('coach.sleep_end'),
      this.settings.get('coach.scheduled_checkins'),
    ]);

    return {
      mode: (mode as AutoCoachConfig['mode']) || 'hybrid',
      inactivityThresholdHours: threshold ? parseFloat(threshold) : 2,
      sleepStart: sleepStart || '23:00',
      sleepEnd: sleepEnd || '07:00',
      scheduledCheckins: checkins ? checkins.split(',').map(t => t.trim()) : ['10:00', '14:00', '18:00'],
    };
  }

  /**
   * Check if we should probe the user right now
   * Called periodically (e.g., every 15-30 minutes)
   */
  async shouldProbe(chatId: string): Promise<ProbeResult> {
    const config = await this.getConfig();

    // Check if auto-mode is enabled
    if (config.mode === 'off') {
      return { shouldProbe: false, reason: 'none' };
    }

    // Check if in sleep period
    if (this.isInSleepPeriod(config.sleepStart, config.sleepEnd)) {
      return { shouldProbe: false, reason: 'none' };
    }

    // Check scheduled check-ins (if enabled)
    if (config.mode === 'scheduled' || config.mode === 'hybrid') {
      const scheduledProbe = await this.checkScheduledProbe(chatId, config.scheduledCheckins);
      if (scheduledProbe.shouldProbe) {
        return scheduledProbe;
      }
    }

    // Check inactivity (if enabled)
    if (config.mode === 'inactivity' || config.mode === 'hybrid') {
      const inactivityProbe = await this.checkInactivityProbe(chatId, config.inactivityThresholdHours);
      if (inactivityProbe.shouldProbe) {
        return inactivityProbe;
      }
    }

    return { shouldProbe: false, reason: 'none' };
  }

  /**
   * Generate a probe message based on reason
   */
  async generateProbe(chatId: string, reason: 'scheduled' | 'inactivity'): Promise<string> {
    const context = await this.contextBuilder.buildContext(chatId, 'auto', {
      includeBattleState: true,
      maxInteractions: 5,
    });

    const contextStr = this.contextBuilder.formatForPrompt(context, 'auto_probe');
    const currentTime = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Africa/Cairo',
    });

    let prompt: string;
    let probeMessage: string;

    if (reason === 'inactivity') {
      const hoursInactive = await this.getHoursInactive();

      prompt = INACTIVITY_PROBE_PROMPT
        .replace('{CONTEXT}', contextStr)
        .replace('{HOURS_INACTIVE}', hoursInactive.toFixed(1))
        .replace('{CURRENT_TIME}', currentTime);

      probeMessage = await this.aiComplete(
        [{ role: 'user', content: prompt }],
        0.9,
        200
      );
    } else {
      prompt = SCHEDULED_CHECKIN_PROMPT
        .replace('{CONTEXT}', contextStr)
        .replace('{CHECKIN_TIME}', currentTime)
        .replace('{TASKS_TODAY}', context.tasksCompletedToday.toString())
        .replace('{LAST_INTERACTION}',
          context.lastInteractionMinutesAgo
            ? `${context.lastInteractionMinutesAgo} minutes ago`
            : 'No interaction today'
        );

      probeMessage = await this.aiComplete(
        [{ role: 'user', content: prompt }],
        0.85,
        200
      );
    }

    // Log the interaction
    await this.contextBuilder.logInteraction({
      chat_id: chatId,
      interaction_date: getTodayInEgypt(),
      timestamp: new Date().toISOString(),
      interaction_type: 'auto_probe',
      bot_response: probeMessage,
      outcome: 'pending',
      metadata: { reason },
    });

    // Mark probe as sent
    await this.markProbeSent(chatId, reason);

    return `🎯 *تنبيه تلقائي*\n\n${probeMessage.trim()}`;
  }

  /**
   * Process user's response to a probe
   */
  async processProbeResponse(chatId: string, userResponse: string): Promise<string> {
    // Get the last probe
    const lastProbe = await this.getLastProbe(chatId);
    if (!lastProbe) {
      return ''; // No recent probe to respond to
    }

    // Analyze the response
    const analysisPrompt = RESPONSE_ANALYSIS_PROMPT
      .replace('{RESPONSE}', userResponse)
      .replace('{PROBE_TYPE}', lastProbe.metadata?.reason || 'unknown');

    const analysisStr = await this.aiComplete(
      [{ role: 'user', content: analysisPrompt }],
      0.3, // Low temperature for analysis
      200
    );

    // Parse analysis
    let analysis: any;
    try {
      const jsonMatch = analysisStr.match(/\{[\s\S]*\}/);
      analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { recommendedAction: 'investigate' };
    } catch {
      analysis = { recommendedAction: 'investigate', escalationLevel: 2 };
    }

    // Generate follow-up
    const context = await this.contextBuilder.buildContext(chatId, 'auto', {
      maxInteractions: 3,
    });

    const followupPrompt = FOLLOWUP_PROMPT
      .replace('{ORIGINAL_PROBE}', lastProbe.bot_response || '')
      .replace('{USER_RESPONSE}', userResponse)
      .replace('{ANALYSIS}', JSON.stringify(analysis))
      .replace('{CONTEXT}', this.contextBuilder.formatForPrompt(context, 'followup'));

    const followup = await this.aiComplete(
      [{ role: 'user', content: followupPrompt }],
      0.85,
      250
    );

    // Update interaction outcome
    const outcome = analysis.isExcuse ? 'negative' : 'neutral';
    await this.contextBuilder.updateInteractionOutcome(chatId, 'auto_probe', outcome);

    // Log user response
    await this.contextBuilder.logInteraction({
      chat_id: chatId,
      interaction_date: getTodayInEgypt(),
      timestamp: new Date().toISOString(),
      interaction_type: 'auto_probe',
      user_input: userResponse,
      bot_response: followup,
      outcome: 'pending',
      metadata: { analysis, isFollowup: true },
    });

    // If blocker detected, maybe trigger stuck intervention
    if (analysis.genuineBlocker && analysis.genuineBlocker !== 'legitimate') {
      return `${followup.trim()}\n\n💡 _يبدو إنك stuck. جرب /stuck لو تبي مساعدة مباشرة._`;
    }

    return followup.trim();
  }

  /**
   * End of day: Summarize and learn from today's coaching
   */
  async endOfDaySummary(chatId: string): Promise<string> {
    return this.contextBuilder.summarizeAndLearn(chatId);
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Check if current time is in sleep period
   */
  private isInSleepPeriod(sleepStart: string, sleepEnd: string): boolean {
    const now = new Date();
    const egyptTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
    const currentMinutes = egyptTime.getHours() * 60 + egyptTime.getMinutes();

    const [startH, startM] = sleepStart.split(':').map(Number);
    const [endH, endM] = sleepEnd.split(':').map(Number);

    const sleepStartMinutes = (startH || 0) * 60 + (startM || 0);
    const sleepEndMinutes = (endH || 0) * 60 + (endM || 0);

    // Handle overnight sleep (e.g., 23:00 to 07:00)
    if (sleepStartMinutes > sleepEndMinutes) {
      // Sleep spans midnight
      return currentMinutes >= sleepStartMinutes || currentMinutes < sleepEndMinutes;
    } else {
      // Sleep is within same day (unusual but handle it)
      return currentMinutes >= sleepStartMinutes && currentMinutes < sleepEndMinutes;
    }
  }

  /**
   * Check if we need a scheduled probe
   */
  private async checkScheduledProbe(
    chatId: string,
    scheduledTimes: string[]
  ): Promise<ProbeResult> {
    const now = new Date();
    const egyptTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
    const currentTime = `${egyptTime.getHours().toString().padStart(2, '0')}:${egyptTime.getMinutes().toString().padStart(2, '0')}`;

    // Check each scheduled time
    for (const scheduledTime of scheduledTimes) {
      // Allow 15-minute window for check-in
      if (this.isWithinWindow(currentTime, scheduledTime, 15)) {
        // Check if we already sent this check-in today
        const alreadySent = await this.wasProbeAlreadySent(chatId, 'scheduled', scheduledTime);
        if (!alreadySent) {
          return {
            shouldProbe: true,
            reason: 'scheduled',
            message: `Scheduled check-in at ${scheduledTime}`,
          };
        }
      }
    }

    return { shouldProbe: false, reason: 'none' };
  }

  /**
   * Check if we need an inactivity probe
   */
  private async checkInactivityProbe(
    chatId: string,
    thresholdHours: number
  ): Promise<ProbeResult> {
    const hoursInactive = await this.getHoursInactive();

    if (hoursInactive >= thresholdHours) {
      // Check if we already probed for this inactivity period
      const lastProbeTime = await this.getLastProbeTime(chatId, 'inactivity');

      // Don't probe again within 1 hour of last inactivity probe
      if (lastProbeTime) {
        const hoursSinceLastProbe =
          (Date.now() - new Date(lastProbeTime).getTime()) / (1000 * 60 * 60);
        if (hoursSinceLastProbe < 1) {
          return { shouldProbe: false, reason: 'none' };
        }
      }

      return {
        shouldProbe: true,
        reason: 'inactivity',
        hoursInactive,
        message: `Inactive for ${hoursInactive.toFixed(1)} hours`,
      };
    }

    return { shouldProbe: false, reason: 'none' };
  }

  /**
   * Get hours since last task completion
   */
  private async getHoursInactive(): Promise<number> {
    try {
      // Get most recent task completion
      const tasks = await this.db.select('tasks', {
        filter: { status: op.eq('done') },
        order: 'completed_at.desc',
        limit: 1,
      });

      if (tasks.length === 0) {
        return 24; // No tasks ever, consider very inactive
      }

      const lastCompletion = new Date(tasks[0]?.completed_at as string);
      const hoursSince = (Date.now() - lastCompletion.getTime()) / (1000 * 60 * 60);

      return hoursSince;
    } catch {
      return 0;
    }
  }

  /**
   * Check if time is within window of target
   */
  private isWithinWindow(current: string, target: string, windowMinutes: number): boolean {
    const [currentH, currentM] = current.split(':').map(Number);
    const [targetH, targetM] = target.split(':').map(Number);

    const currentMinutes = (currentH || 0) * 60 + (currentM || 0);
    const targetMinutes = (targetH || 0) * 60 + (targetM || 0);

    const diff = Math.abs(currentMinutes - targetMinutes);
    return diff <= windowMinutes;
  }

  /**
   * Check if we already sent this specific probe today
   */
  private async wasProbeAlreadySent(
    chatId: string,
    reason: string,
    identifier: string
  ): Promise<boolean> {
    const today = getTodayInEgypt();
    const key = `probe_sent_${chatId}_${reason}_${identifier}_${today}`;

    try {
      const result = await this.db.select('conversation_state', {
        filter: { chat_id: op.eq(key) },
        limit: 1,
      });
      return result.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Mark a probe as sent
   */
  private async markProbeSent(chatId: string, reason: string): Promise<void> {
    const today = getTodayInEgypt();
    const egyptTime = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Africa/Cairo',
    });
    const key = `probe_sent_${chatId}_${reason}_${egyptTime.split(':')[0]}_${today}`;

    try {
      await this.db.upsert('conversation_state', {
        chat_id: key,
        conversation_type: 'probe_marker',
        data: { reason, time: egyptTime },
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h expiry
      }, 'chat_id');
    } catch (error) {
      console.error('Failed to mark probe sent:', error);
    }
  }

  /**
   * Get last probe time for a reason
   */
  private async getLastProbeTime(chatId: string, reason: string): Promise<string | null> {
    const today = getTodayInEgypt();

    try {
      const result = await this.db.select('coaching_interactions', {
        filter: {
          chat_id: op.eq(chatId),
          interaction_date: op.eq(today),
          interaction_type: op.eq('auto_probe'),
        },
        order: 'timestamp.desc',
        limit: 1,
      });

      if (result.length > 0 && (result[0]?.metadata as any)?.reason === reason) {
        return result[0]?.timestamp as string;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get the last probe sent to this user
   */
  private async getLastProbe(chatId: string): Promise<CoachingInteraction | null> {
    const today = getTodayInEgypt();

    try {
      const result = await this.db.select('coaching_interactions', {
        filter: {
          chat_id: op.eq(chatId),
          interaction_date: op.eq(today),
          interaction_type: op.eq('auto_probe'),
        },
        order: 'timestamp.desc',
        limit: 1,
      });

      return result.length > 0 ? (result[0] as CoachingInteraction) : null;
    } catch {
      return null;
    }
  }
}

// ============================================
// Factory Function
// ============================================

export function createAutoCoach(
  db: SupabaseClient,
  settings: SettingsManager,
  aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>
): AutoCoach {
  return new AutoCoach(db, settings, aiCompleteFunc);
}
