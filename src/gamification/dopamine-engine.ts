/**
 * Dopamine Hit Engine - Immediate Reward System
 *
 * Purpose: Create instant positive reinforcement on task completion.
 *
 * Features:
 * - AI-generated unique celebration messages
 * - Identity-based praise
 * - Occasional surprise rewards
 * - Non-repetitive, emotional, unpredictable
 *
 * NOW WITH: Coaching context for personalized celebrations
 * Trigger: onTaskComplete (Todoist webhook)
 * Setting: gamification.dopamine_hits = ON/OFF
 */

import { SupabaseClient, op } from '../database/client';
import { SettingsManager } from '../database/settings';
import { AIMessage } from '../services/ai-client';
import { createCoachingContextBuilder } from '../coach/coaching-context';

// ============================================
// Types
// ============================================

export interface CompletedTask {
  id: string;
  content: string;
  category?: string;
  duration?: number;
  isRecurring?: boolean;
  streakCount?: number;
}

export interface DopamineHit {
  message: string;
  isSurprise: boolean;
  rewardType: 'celebration' | 'identity' | 'streak' | 'surprise' | 'milestone';
}

interface RecentReward {
  timestamp: number;
  rewardType: string;
  theme: string;
}

// ============================================
// AI Prompts
// ============================================

const CELEBRATION_PROMPT = `You are generating a unique, emotionally impactful celebration message for completing a task.

COMPLETED TASK: "{TASK_NAME}"
TASK CATEGORY: {CATEGORY}
DURATION: {DURATION}
IS RECURRING: {IS_RECURRING}
CURRENT STREAK: {STREAK}

RECENT THEMES USED (DO NOT REPEAT):
{RECENT_THEMES}

Generate a SHORT celebration (2-3 lines max) that:
1. Is specific to THIS task (not generic)
2. Uses emotional language
3. Reinforces the user's IDENTITY as someone who gets things done
4. Can include emojis, ASCII art, or creative formatting
5. Is in Arabic (preferred) or English
6. Has a UNIQUE theme/angle not in the recent list

IDENTITY PHRASES TO OCCASIONALLY WEAVE IN:
- "انت شخص ينجز"
- "هذا أنت - تخلص اللي تبدأه"
- "المنجزين يخلصون، وهذا أنت"
- "إنجاز بعد إنجاز، هذي هويتك"

For streaks > 3: Emphasize the consistency and momentum.
For recurring tasks: Celebrate the discipline and routine.
For first-time tasks: Celebrate the courage to start something new.

FORMAT:
[THEME]
one-word theme for deduplication

[MESSAGE]
your celebration message

[REWARD_TYPE]
celebration/identity/streak (pick one)`;

const SURPRISE_REWARD_PROMPT = `You are generating a SURPRISE reward for exceptional productivity.

Context:
- User just completed: "{TASK_NAME}"
- Tasks completed today: {TASKS_TODAY}
- This is their {NTH_TASK} task of the day

This is a RARE surprise reward. Make it MEMORABLE.

Generate something special:
- A mini "achievement unlocked" moment
- A poetic reflection on their progress
- An ASCII art trophy or celebration
- A meaningful quote about productivity
- A playful challenge for tomorrow

Rules:
- Must feel EARNED, not random
- Arabic preferred
- Make them SMILE
- 3-5 lines max

FORMAT:
[SURPRISE_TYPE]
achievement/poetry/art/quote/challenge

[MESSAGE]
your surprise reward`;

// ============================================
// Dopamine Engine Class
// ============================================

export class DopamineEngine {
  private aiComplete: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>;
  private recentRewardsCache: Map<string, RecentReward[]> = new Map();

  constructor(
    private db: SupabaseClient,
    settings: SettingsManager,
    aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>
  ) {
    this.aiComplete = aiCompleteFunc;
    // Context builder available for future coaching integration
    createCoachingContextBuilder(db, settings);
  }

  /**
   * Generate a dopamine hit for a completed task
   */
  async generateHit(chatId: string, task: CompletedTask): Promise<DopamineHit> {
    // Check for surprise reward eligibility
    const tasksToday = await this.getTasksCompletedToday(chatId);
    const shouldSurprise = this.shouldTriggerSurprise(tasksToday);

    if (shouldSurprise) {
      return this.generateSurpriseReward(chatId, task, tasksToday);
    }

    return this.generateCelebration(chatId, task);
  }

  /**
   * Generate a standard celebration message
   */
  private async generateCelebration(chatId: string, task: CompletedTask): Promise<DopamineHit> {
    const recentThemes = await this.getRecentThemes(chatId);

    const prompt = CELEBRATION_PROMPT
      .replace('{TASK_NAME}', task.content)
      .replace('{CATEGORY}', task.category || 'general')
      .replace('{DURATION}', task.duration ? `${task.duration} minutes` : 'not tracked')
      .replace('{IS_RECURRING}', task.isRecurring ? 'Yes' : 'No')
      .replace('{STREAK}', task.streakCount?.toString() || '0')
      .replace('{RECENT_THEMES}', recentThemes.length > 0 ? recentThemes.join(', ') : 'none');

    const response = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.95, // High temperature for creativity
      300
    );

    // Parse response
    const themeMatch = response.match(/\[THEME\]\s*(.+?)(?:\[|$)/is);
    const messageMatch = response.match(/\[MESSAGE\]\s*([\s\S]+?)(?:\[|$)/i);
    const typeMatch = response.match(/\[REWARD_TYPE\]\s*(celebration|identity|streak)/i);

    const theme = themeMatch?.[1]?.trim() || 'general';
    const message = messageMatch?.[1]?.trim() || '✅ أحسنت! مهمة منجزة!';
    const rewardType = (typeMatch?.[1] || 'celebration') as 'celebration' | 'identity' | 'streak';

    // Cache this theme to avoid repetition
    await this.cacheRecentReward(chatId, rewardType, theme);

    return {
      message: `🎯 *مهمة منجزة!*\n\n${message}`,
      isSurprise: false,
      rewardType,
    };
  }

  /**
   * Generate a surprise reward (rare, special occasions)
   */
  private async generateSurpriseReward(
    chatId: string,
    task: CompletedTask,
    tasksToday: number
  ): Promise<DopamineHit> {
    const prompt = SURPRISE_REWARD_PROMPT
      .replace('{TASK_NAME}', task.content)
      .replace('{TASKS_TODAY}', tasksToday.toString())
      .replace('{NTH_TASK}', this.getOrdinal(tasksToday));

    const response = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.98, // Very high temperature for creativity
      400
    );

    // Parse response
    const messageMatch = response.match(/\[MESSAGE\]\s*([\s\S]+?)$/i);
    const message = messageMatch?.[1]?.trim() || '🌟 مفاجأة! انت رائع اليوم!';

    await this.cacheRecentReward(chatId, 'surprise', 'surprise');

    return {
      message: `🎁 *مكافأة مفاجئة!*\n\n${message}`,
      isSurprise: true,
      rewardType: 'surprise',
    };
  }

  /**
   * Generate milestone celebration (specific tasks count)
   */
  async generateMilestoneHit(_chatId: string, milestone: number): Promise<DopamineHit> {
    const milestonePrompt = `Generate a MILESTONE celebration for completing ${milestone} tasks!

This is a big deal. Create something memorable:
- For 10 tasks: "First milestone"
- For 50 tasks: "Serious momentum"
- For 100 tasks: "Centurion achievement"
- For 500+: "Legendary status"

Include:
- A dramatic announcement
- An ASCII celebration (simple)
- An identity-reinforcing statement

Arabic preferred. 4-6 lines max.`;

    const response = await this.aiComplete(
      [{ role: 'user', content: milestonePrompt }],
      0.9,
      400
    );

    return {
      message: `🏆 *إنجاز تاريخي!*\n\n${response}`,
      isSurprise: true,
      rewardType: 'milestone',
    };
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Determine if we should trigger a surprise reward
   * Uses variable ratio schedule (like slot machines) for engagement
   */
  private shouldTriggerSurprise(tasksToday: number): boolean {
    // Never on first task
    if (tasksToday <= 1) return false;

    // Higher chance at specific "nice" numbers
    if ([5, 10, 15, 20, 25].includes(tasksToday)) {
      return Math.random() < 0.7; // 70% chance at milestones
    }

    // Random chance otherwise (variable ratio)
    // Chance increases slightly with more tasks
    const baseChance = 0.08; // 8% base
    const bonusChance = Math.min(0.12, tasksToday * 0.01); // +1% per task, max +12%
    return Math.random() < (baseChance + bonusChance);
  }

  /**
   * Get recent reward themes to avoid repetition
   */
  private async getRecentThemes(chatId: string): Promise<string[]> {
    // Check cache first
    const cached = this.recentRewardsCache.get(chatId);
    if (cached) {
      // Filter to last 24 hours
      const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
      const recent = cached.filter(r => r.timestamp > dayAgo);
      return recent.map(r => r.theme);
    }

    // Load from DB
    try {
      const result = await this.db.select('dopamine_rewards', {
        filter: { chat_id: op.eq(chatId) },
        order: 'created_at.desc',
        limit: 10,
      });

      return result.map((r: any) => r.theme || 'general');
    } catch {
      return [];
    }
  }

  /**
   * Cache recent reward to prevent repetition
   */
  private async cacheRecentReward(chatId: string, rewardType: string, theme: string): Promise<void> {
    // Update memory cache
    const cached = this.recentRewardsCache.get(chatId) || [];
    cached.push({ timestamp: Date.now(), rewardType, theme });

    // Keep only last 20
    if (cached.length > 20) {
      cached.shift();
    }
    this.recentRewardsCache.set(chatId, cached);

    // Persist to DB
    try {
      await this.db.insert('dopamine_rewards', {
        chat_id: chatId,
        reward_type: rewardType,
        theme: theme,
        created_at: new Date().toISOString(),
      });
    } catch {
      // Table might not exist
      console.log('Could not persist dopamine reward (table may not exist)');
    }
  }

  /**
   * Get count of tasks completed today
   */
  private async getTasksCompletedToday(_chatId: string): Promise<number> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const result = await this.db.select('tasks', {
        filter: {
          completed_at: op.gte(`${today}T00:00:00`),
        },
      });
      return result.length;
    } catch {
      return 0;
    }
  }

  /**
   * Get ordinal string for a number
   */
  private getOrdinal(n: number): string {
    const ordinals: Record<number, string> = {
      1: 'الأولى',
      2: 'الثانية',
      3: 'الثالثة',
      4: 'الرابعة',
      5: 'الخامسة',
      6: 'السادسة',
      7: 'السابعة',
      8: 'الثامنة',
      9: 'التاسعة',
      10: 'العاشرة',
    };
    return ordinals[n] || `رقم ${n}`;
  }
}

// ============================================
// Factory Function
// ============================================

export function createDopamineEngine(
  db: SupabaseClient,
  settings: SettingsManager,
  aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>
): DopamineEngine {
  return new DopamineEngine(db, settings, aiCompleteFunc);
}
