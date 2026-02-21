/**
 * Coaching Context Service
 *
 * Builds relevant context for coaching prompts by combining:
 * - Long-term memory (coaching patterns, intervention effectiveness)
 * - Short-term memory (today's interactions, current state)
 * - Current context (battle state, streaks, recent tasks)
 *
 * This service ensures every coaching feature has personalized,
 * memory-aware context without bloating prompts with irrelevant info.
 */

import { SupabaseClient, op } from '../database/client';
import { SettingsManager } from '../database/settings';
import { getTodayInEgypt } from '../utils/timezone';

// ============================================
// Types
// ============================================

export interface CoachingInteraction {
  id?: string;
  chat_id: string;
  interaction_date: string;
  timestamp: string;
  interaction_type: 'stuck' | 'battle' | 'dopamine' | 'roast' | 'checkin' | 'auto_probe' | 'meta_coach' | 'coach_talk';
  user_input?: string;
  bot_response?: string;
  outcome?: 'positive' | 'negative' | 'neutral' | 'pending';
  metadata?: Record<string, any>;
}

export interface CoachingContext {
  // Long-term memory (selective)
  coachingPatterns: string;
  interventionEffectiveness: string;
  userTriggers: string;

  // Short-term (today)
  todayInteractions: CoachingInteraction[];
  todaySummary: string;

  // Current state
  currentMood?: string;
  lastInteractionMinutesAgo?: number;
  tasksCompletedToday: number;
  currentStreak?: number;
  battleState?: {
    bossName: string;
    bossHP: number;
    bossMaxHP: number;
    isActive: boolean;
  };

  // User preferences
  coachingStyle: 'confrontational' | 'supportive' | 'balanced';
}

export interface ContextOptions {
  includeAllMemory?: boolean;
  includeBattleState?: boolean;
  includeRecentTasks?: boolean;
  maxInteractions?: number;
}

// ============================================
// Coaching Memory Categories (Extended)
// ============================================

export const COACHING_MEMORY_CATEGORIES = {
  // How to coach this specific user
  COACHING_PATTERNS: 'Coaching Patterns & What Works',
  // What interventions have been effective/ineffective
  INTERVENTION_EFFECTIVENESS: 'Intervention Effectiveness',
  // User's specific triggers and how to counter them
  USER_TRIGGERS: 'User Triggers & Counters',
} as const;

// ============================================
// Coaching Context Builder
// ============================================

export class CoachingContextBuilder {
  constructor(
    private db: SupabaseClient,
    private settings: SettingsManager
  ) {}

  /**
   * Build context for a specific coaching feature
   */
  async buildContext(
    chatId: string,
    feature: 'stuck' | 'battle' | 'dopamine' | 'roast' | 'checkin' | 'auto',
    options: ContextOptions = {}
  ): Promise<CoachingContext> {
    const today = getTodayInEgypt();

    // Get relevant long-term memory
    const [coachingPatterns, interventionEffectiveness, userTriggers] = await Promise.all([
      this.getMemoryCategory(COACHING_MEMORY_CATEGORIES.COACHING_PATTERNS),
      this.getMemoryCategory(COACHING_MEMORY_CATEGORIES.INTERVENTION_EFFECTIVENESS),
      this.getMemoryCategory(COACHING_MEMORY_CATEGORIES.USER_TRIGGERS),
    ]);

    // Get today's interactions
    const todayInteractions = await this.getTodayInteractions(
      chatId,
      options.maxInteractions || 10
    );

    // Build today's summary
    const todaySummary = this.summarizeTodayInteractions(todayInteractions);

    // Get current state
    const tasksCompletedToday = await this.getTasksCompletedToday();
    const lastInteraction = todayInteractions[0];
    const lastInteractionMinutesAgo = lastInteraction
      ? Math.floor((Date.now() - new Date(lastInteraction.timestamp).getTime()) / 60000)
      : undefined;

    // Get battle state if relevant
    let battleState;
    if (options.includeBattleState || feature === 'battle') {
      battleState = await this.getBattleState(chatId, today);
    }

    // Determine coaching style from settings
    const styleStr = await this.settings.get('coach.style');
    const coachingStyle = (styleStr as CoachingContext['coachingStyle']) || 'confrontational';

    return {
      coachingPatterns,
      interventionEffectiveness,
      userTriggers,
      todayInteractions,
      todaySummary,
      lastInteractionMinutesAgo,
      tasksCompletedToday,
      battleState,
      coachingStyle,
    };
  }

  /**
   * Format context for injection into prompts
   */
  formatForPrompt(context: CoachingContext, feature: string): string {
    let prompt = `
=== COACHING CONTEXT FOR ${feature.toUpperCase()} ===

## LONG-TERM KNOWLEDGE (What I know about this user)

### What Works With This User:
${context.coachingPatterns || 'No patterns learned yet - observe and adapt.'}

### Intervention Effectiveness:
${context.interventionEffectiveness || 'No intervention data yet - track outcomes.'}

### User Triggers & Counters:
${context.userTriggers || 'No trigger data yet - identify patterns.'}

## TODAY'S CONTEXT

### Today's Summary:
${context.todaySummary}

### Current State:
- Tasks completed today: ${context.tasksCompletedToday}
- Minutes since last interaction: ${context.lastInteractionMinutesAgo ?? 'N/A'}
- Coaching style: ${context.coachingStyle.toUpperCase()}
`;

    if (context.battleState?.isActive) {
      prompt += `
### Active Battle:
- Boss: ${context.battleState.bossName}
- HP: ${context.battleState.bossHP}/${context.battleState.bossMaxHP}
`;
    }

    if (context.todayInteractions.length > 0) {
      prompt += `
### Recent Interactions Today:
`;
      for (const interaction of context.todayInteractions.slice(0, 5)) {
        const outcomeEmoji =
          interaction.outcome === 'positive' ? '✅' :
          interaction.outcome === 'negative' ? '❌' : '⏳';
        prompt += `- [${interaction.interaction_type}] ${outcomeEmoji} ${interaction.user_input?.substring(0, 50) || 'no input'}...\n`;
      }
    }

    prompt += `
## COACHING DIRECTIVE
Style: ${context.coachingStyle.toUpperCase()}
${context.coachingStyle === 'confrontational' ?
  'Be direct, challenging, slightly provocative. Push hard but never be cruel. Use humor to soften blows.' :
  context.coachingStyle === 'supportive' ?
  'Be encouraging, understanding, but still firm. Validate feelings then redirect to action.' :
  'Balance challenge with support. Adapt based on user response.'}

=== END CONTEXT ===
`;

    return prompt;
  }

  /**
   * Log a coaching interaction (for short-term memory)
   */
  async logInteraction(interaction: CoachingInteraction): Promise<void> {
    try {
      await this.db.insert('coaching_interactions', {
        ...interaction,
        timestamp: interaction.timestamp || new Date().toISOString(),
      });
    } catch (error) {
      console.error('Failed to log coaching interaction:', error);
    }
  }

  /**
   * Update interaction outcome
   */
  async updateInteractionOutcome(
    chatId: string,
    interactionType: string,
    outcome: 'positive' | 'negative' | 'neutral'
  ): Promise<void> {
    try {
      // Get most recent interaction of this type
      const recent = await this.db.select('coaching_interactions', {
        filter: {
          chat_id: op.eq(chatId),
          interaction_type: op.eq(interactionType),
        },
        order: 'timestamp.desc',
        limit: 1,
      });

      if (recent.length > 0 && recent[0]?.id) {
        await this.db.update(
          'coaching_interactions',
          { id: op.eq(recent[0].id as string) },
          { outcome }
        );
      }
    } catch (error) {
      console.error('Failed to update interaction outcome:', error);
    }
  }

  /**
   * Summarize today's interactions and update long-term memory
   * Called at end of day
   */
  async summarizeAndLearn(chatId: string): Promise<string> {
    const today = getTodayInEgypt();
    const interactions = await this.getTodayInteractions(chatId, 50);

    if (interactions.length === 0) {
      return 'No interactions to summarize.';
    }

    // Calculate stats
    const stats = {
      total: interactions.length,
      positive: interactions.filter(i => i.outcome === 'positive').length,
      negative: interactions.filter(i => i.outcome === 'negative').length,
      byType: {} as Record<string, number>,
    };

    for (const i of interactions) {
      stats.byType[i.interaction_type] = (stats.byType[i.interaction_type] || 0) + 1;
    }

    // Build learning summary
    const learnings: string[] = [];

    // Analyze stuck interventions
    const stuckInteractions = interactions.filter(i => i.interaction_type === 'stuck');
    if (stuckInteractions.length > 0) {
      const stuckPositive = stuckInteractions.filter(i => i.outcome === 'positive').length;
      const effectiveness = Math.round((stuckPositive / stuckInteractions.length) * 100);
      learnings.push(`[${today}] Stuck interventions: ${stuckPositive}/${stuckInteractions.length} positive (${effectiveness}%)`);
    }

    // Analyze auto probes
    const autoProbes = interactions.filter(i => i.interaction_type === 'auto_probe');
    if (autoProbes.length > 0) {
      const autoPositive = autoProbes.filter(i => i.outcome === 'positive').length;
      learnings.push(`[${today}] Auto probes: ${autoPositive}/${autoProbes.length} led to action`);
    }

    // Update intervention effectiveness memory
    if (learnings.length > 0) {
      await this.appendToMemory(
        COACHING_MEMORY_CATEGORIES.INTERVENTION_EFFECTIVENESS,
        learnings.join('\n')
      );
    }

    return `Day summary: ${stats.total} interactions, ${stats.positive} positive, ${stats.negative} negative`;
  }

  // ============================================
  // Private Methods
  // ============================================

  private async getMemoryCategory(category: string): Promise<string> {
    try {
      const result = await this.db.select('memory', {
        filter: { category: op.eq(category) },
        limit: 1,
      });
      return (result[0]?.content as string) || '';
    } catch {
      return '';
    }
  }

  private async appendToMemory(category: string, content: string): Promise<void> {
    try {
      const existing = await this.getMemoryCategory(category);
      const updated = existing ? `${existing}\n\n${content}` : content;

      // Trim if too long (keep last 5000 chars)
      const trimmed = updated.length > 5000
        ? '...' + updated.substring(updated.length - 5000)
        : updated;

      const result = await this.db.select('memory', {
        filter: { category: op.eq(category) },
        limit: 1,
      });

      if (result.length > 0) {
        await this.db.update(
          'memory',
          { category: op.eq(category) },
          { content: trimmed, last_updated: new Date().toISOString() }
        );
      } else {
        await this.db.insert('memory', {
          category,
          content: trimmed,
          last_updated: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error('Failed to append to memory:', error);
    }
  }

  private async getTodayInteractions(
    chatId: string,
    limit: number
  ): Promise<CoachingInteraction[]> {
    const today = getTodayInEgypt();

    try {
      const result = await this.db.select('coaching_interactions', {
        filter: {
          chat_id: op.eq(chatId),
          interaction_date: op.eq(today),
        },
        order: 'timestamp.desc',
        limit,
      });

      return result as CoachingInteraction[];
    } catch {
      return [];
    }
  }

  private summarizeTodayInteractions(interactions: CoachingInteraction[]): string {
    if (interactions.length === 0) {
      return 'No coaching interactions yet today.';
    }

    const types = new Set(interactions.map(i => i.interaction_type));
    const outcomes = {
      positive: interactions.filter(i => i.outcome === 'positive').length,
      negative: interactions.filter(i => i.outcome === 'negative').length,
      pending: interactions.filter(i => i.outcome === 'pending' || !i.outcome).length,
    };

    let summary = `Today: ${interactions.length} interactions (${Array.from(types).join(', ')}).`;
    summary += ` Outcomes: ${outcomes.positive} positive, ${outcomes.negative} negative, ${outcomes.pending} pending.`;

    // Add recent context
    const lastInteraction = interactions[0];
    if (lastInteraction) {
      const minutesAgo = Math.floor(
        (Date.now() - new Date(lastInteraction.timestamp).getTime()) / 60000
      );
      summary += ` Last: ${lastInteraction.interaction_type} ${minutesAgo}m ago.`;
    }

    return summary;
  }

  private async getTasksCompletedToday(): Promise<number> {
    const today = getTodayInEgypt();
    try {
      const result = await this.db.select('tasks', {
        filter: {
          status: op.eq('done'),
        },
      });

      // Filter for today in Egypt timezone
      const todayTasks = result.filter(t => {
        const taskDate = new Date(t.completed_at as string).toISOString().split('T')[0];
        return taskDate === today;
      });

      return todayTasks.length;
    } catch {
      return 0;
    }
  }

  private async getBattleState(
    chatId: string,
    date: string
  ): Promise<CoachingContext['battleState'] | undefined> {
    try {
      const result = await this.db.select('battle_states', {
        filter: {
          chat_id: op.eq(chatId),
          battle_date: op.eq(date),
        },
        limit: 1,
      });

      if (result.length === 0) return undefined;

      const state = result[0]?.state as any;
      if (!state) return undefined;

      return {
        bossName: state.boss?.name || 'Unknown',
        bossHP: state.bossCurrentHP || 0,
        bossMaxHP: state.bossMaxHP || 100,
        isActive: !state.isVictory && !state.isDefeat,
      };
    } catch {
      return undefined;
    }
  }
}

// ============================================
// Factory Function
// ============================================

export function createCoachingContextBuilder(
  db: SupabaseClient,
  settings: SettingsManager
): CoachingContextBuilder {
  return new CoachingContextBuilder(db, settings);
}
