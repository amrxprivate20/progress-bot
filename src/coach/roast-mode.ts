/**
 * AI Roast Mode - Humor + Accountability
 *
 * Purpose: Make avoidance socially and emotionally uncomfortable.
 *
 * Features:
 * - AI analyzes broken commitments, repeated failures, excuse patterns
 * - Generates PERSONALIZED roasts: funny, honest, slightly painful
 * - Uses memory for callbacks to past behavior
 * - Never abusive, never generic
 *
 * NOW WITH: Full coaching context for deeply personalized roasts
 * Command: /roast_me
 * Setting: coach.roast_mode = ON/OFF
 */

import { SupabaseClient, op } from '../database/client';
import { SettingsManager } from '../database/settings';
import { AIMessage } from '../services/ai-client';
import { getTodayInEgypt } from '../utils/timezone';
import { createCoachingContextBuilder } from './coaching-context';

// ============================================
// Types
// ============================================

export interface RoastContext {
  recentFailures: FailureRecord[];
  brokenCommitments: string[];
  excusePatterns: string[];
  streakBreaks: string[];
  memory: Record<string, string>;
  daysAnalyzed: number;
  successRate?: number;
}

export interface FailureRecord {
  date: string;
  task: string;
  reason?: string;
}

export interface RoastResult {
  roast: string;
  severity: 'gentle' | 'medium' | 'spicy' | 'scorched';
  callbacks: string[];
  encouragement: string;
}

// ============================================
// AI Prompts
// ============================================

const ROAST_PROMPT = `You are a brutally honest but caring coach doing a ROAST.

The user asked to be roasted. This is consensual tough love.

ROAST CONTEXT:
==============
Days analyzed: {DAYS_ANALYZED}
Success rate: {SUCCESS_RATE}%

Recent failures (last 7 days):
{RECENT_FAILURES}

Broken commitments:
{BROKEN_COMMITMENTS}

Excuse patterns detected:
{EXCUSE_PATTERNS}

Streak breaks:
{STREAK_BREAKS}

User's memory (for callbacks):
{MEMORY}

ROAST RULES:
============
1. Be SPECIFIC - reference actual tasks and patterns
2. Use callbacks to past behavior (from memory)
3. Be FUNNY - this is comedy, not abuse
4. Be HONEST - don't sugarcoat the truth
5. Show you KNOW them - personalize based on memory
6. End with a twist of encouragement (small)
7. Arabic preferred, mix in English for effect
8. 4-6 lines max for the roast

SEVERITY GUIDE:
- GENTLE: They're doing okay, light teasing
- MEDIUM: Notable failures, pointed humor
- SPICY: Repeated patterns, honest pain points
- SCORCHED: Serial avoidance, gloves off (still funny, not cruel)

FORMAT:
[SEVERITY]
gentle/medium/spicy/scorched

[ROAST]
Your roast here

[CALLBACKS]
List of specific past behaviors you referenced (for tracking)

[ENCOURAGEMENT]
One sentence of genuine encouragement at the end`;

const ANALYZE_PATTERNS_PROMPT = `Analyze these task failures and identify excuse patterns.

FAILURES:
{FAILURES}

STREAKS BROKEN:
{STREAKS}

Identify:
1. Common excuses or reasons
2. Recurring failure types
3. Time-based patterns (certain days/times)
4. Task categories most failed

Return as JSON:
{
  "excusePatterns": ["pattern1", "pattern2"],
  "recurringTypes": ["type1", "type2"],
  "timePatterns": ["pattern1"],
  "worstCategories": ["category1"]
}`;

// ============================================
// Roast Mode Class
// ============================================

export class RoastMode {
  private aiComplete: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>;

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
   * Generate a personalized roast
   */
  async generateRoast(chatId: string): Promise<RoastResult> {
    // Gather roast context
    const context = await this.gatherRoastContext(chatId);

    // If no data, return gentle default
    if (context.recentFailures.length === 0 && context.brokenCommitments.length === 0) {
      return {
        roast: `🤔 حاولت أدور على شي أحرقك فيه... بس ما لقيت شي!

إما إنك فعلاً منتج هالفترة، أو إنك شاطر تخفي فشلك من النظام.

في كلا الحالتين... مشبوه. 🧐`,
        severity: 'gentle',
        callbacks: [],
        encouragement: 'كمّل على هالمستوى (لو فعلاً صادق).',
      };
    }

    // Generate the roast
    const prompt = this.buildRoastPrompt(context);
    const response = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.95, // High temperature for creativity
      600
    );

    // Parse response
    return this.parseRoastResponse(response);
  }

  /**
   * Get a quick roast for when someone defers a task
   */
  async quickRoast(_chatId: string, taskName: string): Promise<string> {
    const quickPrompt = `Generate a QUICK one-liner roast (max 2 sentences) for someone who just deferred this task:

Task: "${taskName}"

Be witty, not mean. Arabic preferred. Reference procrastination humorously.`;

    const response = await this.aiComplete(
      [{ role: 'user', content: quickPrompt }],
      0.9,
      100
    );

    return `😏 ${response.trim()}`;
  }

  /**
   * Generate a roast based on weekly patterns
   */
  async weeklyRoast(chatId: string): Promise<RoastResult> {
    const context = await this.gatherRoastContext(chatId, 7);

    // Add weekly-specific analysis
    const weeklyPrompt = `You're generating a WEEKLY ROAST - a review of the entire week's patterns.

${this.buildRoastPrompt(context)}

Make it a "weekly review roast" - summarize the week's avoidance patterns comedically.
Include:
- A "highlight reel" of failures
- Pattern recognition ("I notice you always...")
- A week score out of 10 (be harsh but fair)
- "Goals for next week" section (sarcastic but actionable)`;

    const response = await this.aiComplete(
      [{ role: 'user', content: weeklyPrompt }],
      0.9,
      800
    );

    return this.parseRoastResponse(response);
  }

  // ============================================
  // Private Methods
  // ============================================

  private async gatherRoastContext(chatId: string, days: number = 7): Promise<RoastContext> {
    const context: RoastContext = {
      recentFailures: [],
      brokenCommitments: [],
      excusePatterns: [],
      streakBreaks: [],
      memory: {},
      daysAnalyzed: days,
    };

    // Get recent failures
    context.recentFailures = await this.getRecentFailures(chatId, days);

    // Get broken streaks
    context.streakBreaks = await this.getBrokenStreaks(chatId);

    // Get memory for callbacks
    context.memory = await this.getMemory(chatId);

    // Calculate success rate
    context.successRate = await this.calculateSuccessRate(chatId, days);

    // Analyze patterns using AI
    if (context.recentFailures.length > 0) {
      context.excusePatterns = await this.analyzePatterns(context);
    }

    // Get broken commitments from goals/challenges
    context.brokenCommitments = await this.getBrokenCommitments(chatId);

    return context;
  }

  private async getRecentFailures(_chatId: string, days: number): Promise<FailureRecord[]> {
    const failures: FailureRecord[] = [];

    // Get from intervention logs (stuck deferrals)
    try {
      const interventions = await this.db.select('intervention_logs', {
        filter: { intervention_type: op.eq('stuck') },
        order: 'created_at.desc',
        limit: 20,
      });

      for (const log of interventions) {
        if ((log.data as any)?.type === 'stuck_deferred') {
          const createdAt = log.created_at as string;
          const dateStr = createdAt ? (createdAt.split('T')[0] || getTodayInEgypt()) : getTodayInEgypt();
          failures.push({
            date: dateStr,
            task: (log.data as any)?.taskDescription || 'unknown task',
            reason: (log.data as any)?.reason,
          });
        }
      }
    } catch {
      // Table might not exist
    }

    // Get from daily failures
    try {
      const today = getTodayInEgypt();
      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - days);

      const dailyFailures = await this.db.select('daily_failures', {
        filter: { date: op.gte(startDate.toISOString().split('T')[0]) },
      });

      for (const day of dailyFailures) {
        const dayFailures = (day.failed_tasks as any[]) || [];
        for (const task of dayFailures) {
          failures.push({
            date: day.date as string,
            task: task.content || task.name || 'unknown',
          });
        }
      }
    } catch {
      // Table might not exist
    }

    return failures.slice(0, 15); // Limit to 15 most recent
  }

  private async getBrokenStreaks(_chatId: string): Promise<string[]> {
    const brokenStreaks: string[] = [];

    try {
      const streaks = await this.db.select('streaks', {});

      for (const streak of streaks) {
        // Check if streak was broken recently (had a streak > 2 but current is 0-1)
        if ((streak.best_streak as number) > 2 && (streak.current_streak as number) <= 1) {
          brokenStreaks.push(
            `${streak.task_name}: كان ${streak.best_streak} أيام، الآن ${streak.current_streak}`
          );
        }
      }
    } catch {
      // Table might not exist
    }

    return brokenStreaks;
  }

  private async getMemory(_chatId: string): Promise<Record<string, string>> {
    try {
      const memories = await this.db.select('memory', {});

      const result: Record<string, string> = {};
      for (const mem of memories) {
        const content = mem.content as string;
        if (content && content.length > 0) {
          // Truncate for prompt efficiency
          result[mem.category as string] = content.substring(0, 500);
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  private async calculateSuccessRate(_chatId: string, days: number): Promise<number> {
    try {
      const today = getTodayInEgypt();
      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - days);

      const reports = await this.db.select('daily_reports', {
        filter: { report_date: op.gte(startDate.toISOString().split('T')[0]) },
      });

      if (reports.length === 0) return 50; // Default

      const rates = reports
        .map(r => r.success_rate as number)
        .filter(r => r != null);

      if (rates.length === 0) return 50;

      return Math.round(rates.reduce((a, b) => a + b, 0) / rates.length);
    } catch {
      return 50;
    }
  }

  private async getBrokenCommitments(_chatId: string): Promise<string[]> {
    const broken: string[] = [];

    try {
      // Check failed challenges
      const challenges = await this.db.select('daily_challenges', {
        filter: { result: op.eq(false) },
        order: 'challenge_date.desc',
        limit: 5,
      });

      for (const challenge of challenges) {
        broken.push(`تحدي ${challenge.challenge_date}: ${(challenge.challenge_text as string)?.substring(0, 50)}...`);
      }
    } catch {
      // Table might not exist
    }

    return broken;
  }

  private async analyzePatterns(context: RoastContext): Promise<string[]> {
    if (context.recentFailures.length < 3) {
      return [];
    }

    const failures = context.recentFailures
      .map(f => `${f.date}: ${f.task}${f.reason ? ` (السبب: ${f.reason})` : ''}`)
      .join('\n');

    const streaks = context.streakBreaks.join('\n');

    const prompt = ANALYZE_PATTERNS_PROMPT
      .replace('{FAILURES}', failures)
      .replace('{STREAKS}', streaks || 'none');

    try {
      const response = await this.aiComplete(
        [{ role: 'user', content: prompt }],
        0.3, // Low temperature for analysis
        300
      );

      // Try to parse JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return [
          ...(parsed.excusePatterns || []),
          ...(parsed.recurringTypes || []),
          ...(parsed.timePatterns || []),
        ];
      }
    } catch {
      // Analysis failed, return empty
    }

    return [];
  }

  private buildRoastPrompt(context: RoastContext): string {
    const failuresText = context.recentFailures.length > 0
      ? context.recentFailures.map(f =>
          `- ${f.date}: ${f.task}${f.reason ? ` (قال: "${f.reason}")` : ''}`
        ).join('\n')
      : 'لا يوجد فشل مسجل';

    const commitmentsText = context.brokenCommitments.length > 0
      ? context.brokenCommitments.join('\n')
      : 'لا يوجد';

    const patternsText = context.excusePatterns.length > 0
      ? context.excusePatterns.join('\n')
      : 'لم يتم اكتشاف أنماط';

    const streaksText = context.streakBreaks.length > 0
      ? context.streakBreaks.join('\n')
      : 'لا يوجد';

    const memoryText = Object.entries(context.memory)
      .map(([cat, content]) => `${cat}: ${content}`)
      .join('\n\n') || 'لا توجد ذاكرة';

    return ROAST_PROMPT
      .replace('{DAYS_ANALYZED}', context.daysAnalyzed.toString())
      .replace('{SUCCESS_RATE}', (context.successRate || 50).toString())
      .replace('{RECENT_FAILURES}', failuresText)
      .replace('{BROKEN_COMMITMENTS}', commitmentsText)
      .replace('{EXCUSE_PATTERNS}', patternsText)
      .replace('{STREAK_BREAKS}', streaksText)
      .replace('{MEMORY}', memoryText);
  }

  private parseRoastResponse(response: string): RoastResult {
    const severityMatch = response.match(/\[SEVERITY\]\s*(gentle|medium|spicy|scorched)/i);
    const roastMatch = response.match(/\[ROAST\]\s*([\s\S]+?)(?:\[|$)/i);
    const callbacksMatch = response.match(/\[CALLBACKS\]\s*([\s\S]+?)(?:\[|$)/i);
    const encouragementMatch = response.match(/\[ENCOURAGEMENT\]\s*([\s\S]+?)$/i);

    const severity = (severityMatch?.[1]?.toLowerCase() || 'medium') as RoastResult['severity'];
    const roast = roastMatch?.[1]?.trim() || response;
    const callbacks = callbacksMatch?.[1]?.trim().split('\n').filter(c => c.trim()) || [];
    const encouragement = encouragementMatch?.[1]?.trim() || 'بس برضو، انت تقدر.';

    // Add severity emoji
    const severityEmoji: Record<string, string> = {
      gentle: '🙂',
      medium: '😏',
      spicy: '🔥',
      scorched: '💀',
    };

    return {
      roast: `${severityEmoji[severity]} *وضع الإحراق: ${severity.toUpperCase()}*\n\n${roast}`,
      severity,
      callbacks,
      encouragement: `\n_${encouragement}_`,
    };
  }
}

// ============================================
// Factory Function
// ============================================

export function createRoastMode(
  db: SupabaseClient,
  settings: SettingsManager,
  aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>
): RoastMode {
  return new RoastMode(db, settings, aiCompleteFunc);
}
