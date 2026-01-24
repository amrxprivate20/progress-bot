/**
 * Battle Mode - Urgency Through Narrative
 *
 * Purpose: Turn the day into a game with emotional stakes.
 *
 * Mechanics:
 * - AI generates a daily "boss" representing resistance
 * - Boss has dynamic HP
 * - Task completion = damage
 * - Avoidance / deferral = boss heals
 * - AI narrates progress dramatically throughout the day
 * - End of day: Victory = meaningful reward, Defeat = sharp but humorous feedback
 *
 * NOW WITH: Coaching context for personalized boss generation and narratives
 * Rule: No numbers without narrative. No XP without meaning.
 * Setting: gamification.battle_mode = ON/OFF
 */

import { SupabaseClient, op } from '../database/client';
import { SettingsManager } from '../database/settings';
import { AIMessage } from '../services/ai-client';
import { getTodayInEgypt } from '../utils/timezone';
import { createCoachingContextBuilder } from '../coach/coaching-context';

// ============================================
// Types
// ============================================

export interface Boss {
  name: string;
  title: string;
  description: string;
  personality: string;
  weakness: string;
  taunt: string;
}

export interface BattleState {
  date: string;
  boss: Boss;
  bossMaxHP: number;
  bossCurrentHP: number;
  playerDamageDealt: number;
  bossHealingReceived: number;
  tasksCompleted: number;
  tasksFailed: number;
  criticalHits: number;
  lastNarrativeTime?: number;
  isVictory?: boolean;
  isDefeat?: boolean;
}

export interface BattleAction {
  type: 'damage' | 'heal' | 'critical' | 'taunt';
  amount: number;
  narrative: string;
  bossResponse?: string;
}

// ============================================
// AI Prompts
// ============================================

const GENERATE_BOSS_PROMPT = `You are creating today's BOSS - a personified enemy representing procrastination and resistance.

Today's date: {DATE}
Day of week: {DAY_OF_WEEK}

Create a unique boss with:
1. NAME: A dramatic, memorable Arabic/English name
2. TITLE: Their intimidating title
3. DESCRIPTION: 2-3 sentences describing their appearance/nature
4. PERSONALITY: How they mock and challenge the player
5. WEAKNESS: What defeats them (tied to productivity)
6. TAUNT: Their opening battle cry

Theme ideas based on day:
- Monday: "Lord of Slow Starts"
- Tuesday: "The Distraction Hydra"
- Wednesday: "Midweek Doubt Demon"
- Thursday: "Almost-Friday Laziness"
- Friday: "Weekend Temptation"
- Saturday/Sunday: "The Relaxation Trap"

Be creative! Make it FUN to fight them.

FORMAT:
[NAME]
boss name

[TITLE]
their title

[DESCRIPTION]
2-3 sentences

[PERSONALITY]
how they act

[WEAKNESS]
what defeats them

[TAUNT]
their opening line`;

const DAMAGE_NARRATIVE_PROMPT = `You are narrating a battle between a productivity warrior and today's boss.

BOSS: {BOSS_NAME}, {BOSS_TITLE}
Boss HP: {BOSS_HP}/{BOSS_MAX_HP}
Player just completed: "{TASK_NAME}"
Damage dealt: {DAMAGE} HP
Is critical hit: {IS_CRITICAL}
Tasks completed today: {TASKS_TODAY}

Generate a SHORT (2-3 sentences) dramatic battle narrative:
- Describe the attack in epic terms
- Show the boss's reaction (pain, frustration, fear)
- If critical: Make it EPIC
- If boss HP low: Show their desperation
- Use Arabic preferred

Keep the energy HIGH. Make completing tasks feel POWERFUL.`;

const BOSS_HEAL_PROMPT = `The boss is HEALING because the player failed or deferred a task!

BOSS: {BOSS_NAME}, {BOSS_TITLE}
Boss HP: {BOSS_HP}/{BOSS_MAX_HP}
Failed/deferred task: "{TASK_NAME}"
HP healed: {HEAL_AMOUNT}

Generate a SHORT (2-3 sentences) narrative:
- Boss gloats about the player's weakness
- Uses their personality to mock
- Creates URGENCY - motivates player to fight back
- Arabic preferred

Don't be cruel, but make inaction feel COSTLY.`;

const VICTORY_NARRATIVE_PROMPT = `THE PLAYER HAS DEFEATED TODAY'S BOSS!

BOSS: {BOSS_NAME}, {BOSS_TITLE}
Final stats:
- Damage dealt: {TOTAL_DAMAGE}
- Tasks completed: {TASKS_COMPLETED}
- Critical hits: {CRITICAL_HITS}
- Boss healing: {BOSS_HEALING}

Generate a VICTORY celebration (4-6 lines):
1. Dramatic defeat description
2. Boss's final words
3. Player's earned title for the day
4. Tomorrow's preview (new challenge awaits)

Make this feel AMAZING. They earned it!
Arabic preferred with some English flair.`;

const DEFEAT_NARRATIVE_PROMPT = `The boss has SURVIVED! The player didn't defeat them today.

BOSS: {BOSS_NAME}, {BOSS_TITLE}
Boss remaining HP: {BOSS_HP}/{BOSS_MAX_HP}
Stats:
- Damage dealt: {TOTAL_DAMAGE}
- Tasks completed: {TASKS_COMPLETED}
- Boss healing: {BOSS_HEALING}

Generate a DEFEAT message (3-4 lines):
- Boss victory taunt (humorous, not cruel)
- What could have been different
- Motivation for tomorrow (this isn't over)

Be sharp but not crushing. Leave them hungry for revenge.
Arabic preferred.`;

// ============================================
// Battle Mode Class
// ============================================

export class BattleMode {
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
   * Start or get today's battle
   */
  async startBattle(chatId: string): Promise<{ isNew: boolean; message: string; state: BattleState }> {
    const today = getTodayInEgypt();
    const existing = await this.getBattleState(chatId, today);

    if (existing) {
      const statusMessage = this.generateStatusMessage(existing);
      return { isNew: false, message: statusMessage, state: existing };
    }

    // Generate new boss
    const boss = await this.generateBoss(today);

    // Calculate boss HP based on expected tasks (base 100, scale with weekday)
    const dayOfWeek = new Date().getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const bossMaxHP = isWeekend ? 80 : 120; // Easier on weekends

    const state: BattleState = {
      date: today,
      boss,
      bossMaxHP,
      bossCurrentHP: bossMaxHP,
      playerDamageDealt: 0,
      bossHealingReceived: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      criticalHits: 0,
    };

    await this.saveBattleState(chatId, state);

    const battleStartMessage = `⚔️ *معركة اليوم بدأت!*

🔥 *${boss.name}*
_${boss.title}_

${boss.description}

💬 "${boss.taunt}"

━━━━━━━━━━━━━━━━
❤️ HP: ${'█'.repeat(10)} ${bossMaxHP}/${bossMaxHP}
━━━━━━━━━━━━━━━━

نقطة ضعفه: ${boss.weakness}

_أكمل المهام لتوجيه الضربات!_
/battle_status - حالة المعركة`;

    return { isNew: true, message: battleStartMessage, state };
  }

  /**
   * Deal damage when task is completed
   */
  async dealDamage(chatId: string, taskName: string, taskDifficulty: number = 1): Promise<BattleAction | null> {
    const today = getTodayInEgypt();
    const state = await this.getBattleState(chatId, today);

    if (!state || state.isVictory || state.isDefeat) {
      return null;
    }

    // Calculate damage (base 10-15, modified by difficulty)
    const baseDamage = 8 + Math.floor(Math.random() * 8);
    const difficultyMultiplier = 0.5 + (taskDifficulty * 0.5); // 0.5x to 2.5x
    const isCritical = Math.random() < 0.15; // 15% crit chance
    const critMultiplier = isCritical ? 2 : 1;

    const damage = Math.floor(baseDamage * difficultyMultiplier * critMultiplier);
    const newHP = Math.max(0, state.bossCurrentHP - damage);

    // Update state
    state.bossCurrentHP = newHP;
    state.playerDamageDealt += damage;
    state.tasksCompleted += 1;
    if (isCritical) state.criticalHits += 1;

    // Check for victory
    if (newHP <= 0) {
      state.isVictory = true;
    }

    await this.saveBattleState(chatId, state);

    // Generate narrative
    const narrative = await this.generateDamageNarrative(state, taskName, damage, isCritical);

    // If victory, generate special message
    if (state.isVictory) {
      const victoryMessage = await this.generateVictoryNarrative(state);
      return {
        type: isCritical ? 'critical' : 'damage',
        amount: damage,
        narrative: `${narrative}\n\n${victoryMessage}`,
      };
    }

    return {
      type: isCritical ? 'critical' : 'damage',
      amount: damage,
      narrative,
      bossResponse: this.generateQuickBossResponse(state.boss, newHP, state.bossMaxHP),
    };
  }

  /**
   * Boss heals when task is failed/deferred
   */
  async bossHeals(chatId: string, taskName: string, severity: number = 1): Promise<BattleAction | null> {
    const today = getTodayInEgypt();
    const state = await this.getBattleState(chatId, today);

    if (!state || state.isVictory || state.isDefeat) {
      return null;
    }

    // Calculate healing (less than damage to keep game winnable)
    const healAmount = Math.floor(5 + (severity * 5) + Math.random() * 5);
    const newHP = Math.min(state.bossMaxHP, state.bossCurrentHP + healAmount);

    // Update state
    state.bossCurrentHP = newHP;
    state.bossHealingReceived += healAmount;
    state.tasksFailed += 1;

    await this.saveBattleState(chatId, state);

    // Generate taunt
    const narrative = await this.generateHealNarrative(state, taskName, healAmount);

    return {
      type: 'heal',
      amount: healAmount,
      narrative,
    };
  }

  /**
   * Get current battle status
   */
  async getStatus(chatId: string): Promise<string> {
    const today = getTodayInEgypt();
    const state = await this.getBattleState(chatId, today);

    if (!state) {
      return '⚔️ لا توجد معركة نشطة اليوم.\n\nاستخدم /battle_mode لبدء معركة جديدة!';
    }

    return this.generateStatusMessage(state);
  }

  /**
   * End the day's battle (called at end of day)
   */
  async endBattle(chatId: string): Promise<string> {
    const today = getTodayInEgypt();
    const state = await this.getBattleState(chatId, today);

    if (!state) {
      return 'لا توجد معركة لإنهائها.';
    }

    if (state.isVictory) {
      return 'المعركة انتهت بالنصر! 🎉';
    }

    // Mark as defeat
    state.isDefeat = true;
    await this.saveBattleState(chatId, state);

    return this.generateDefeatNarrative(state);
  }

  // ============================================
  // Private Methods
  // ============================================

  private async generateBoss(date: string): Promise<Boss> {
    const dayOfWeek = new Date(date).toLocaleDateString('en-US', { weekday: 'long' });

    const prompt = GENERATE_BOSS_PROMPT
      .replace('{DATE}', date)
      .replace('{DAY_OF_WEEK}', dayOfWeek);

    const response = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.95,
      500
    );

    // Parse response
    const nameMatch = response.match(/\[NAME\]\s*(.+?)(?:\[|$)/is);
    const titleMatch = response.match(/\[TITLE\]\s*(.+?)(?:\[|$)/is);
    const descMatch = response.match(/\[DESCRIPTION\]\s*([\s\S]+?)(?:\[|$)/i);
    const personalityMatch = response.match(/\[PERSONALITY\]\s*([\s\S]+?)(?:\[|$)/i);
    const weaknessMatch = response.match(/\[WEAKNESS\]\s*([\s\S]+?)(?:\[|$)/i);
    const tauntMatch = response.match(/\[TAUNT\]\s*([\s\S]+?)$/i);

    return {
      name: nameMatch?.[1]?.trim() || 'سيد التسويف',
      title: titleMatch?.[1]?.trim() || 'حارس الكسل',
      description: descMatch?.[1]?.trim() || 'وحش قديم يتغذى على المماطلة.',
      personality: personalityMatch?.[1]?.trim() || 'ساخر ومتعجرف',
      weakness: weaknessMatch?.[1]?.trim() || 'الإنجاز المستمر',
      taunt: tauntMatch?.[1]?.trim() || 'لن تنجز شيئاً اليوم!',
    };
  }

  private async generateDamageNarrative(
    state: BattleState,
    taskName: string,
    damage: number,
    isCritical: boolean
  ): Promise<string> {
    const prompt = DAMAGE_NARRATIVE_PROMPT
      .replace('{BOSS_NAME}', state.boss.name)
      .replace('{BOSS_TITLE}', state.boss.title)
      .replace('{BOSS_HP}', state.bossCurrentHP.toString())
      .replace('{BOSS_MAX_HP}', state.bossMaxHP.toString())
      .replace('{TASK_NAME}', taskName)
      .replace('{DAMAGE}', damage.toString())
      .replace('{IS_CRITICAL}', isCritical ? 'YES - CRITICAL HIT!' : 'No')
      .replace('{TASKS_TODAY}', state.tasksCompleted.toString());

    const narrative = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.9,
      200
    );

    const prefix = isCritical ? '💥 *ضربة حاسمة!*\n\n' : '⚔️ ';
    const hpBar = this.generateHPBar(state.bossCurrentHP, state.bossMaxHP);

    return `${prefix}${narrative.trim()}\n\n${hpBar}`;
  }

  private async generateHealNarrative(
    state: BattleState,
    taskName: string,
    healAmount: number
  ): Promise<string> {
    const prompt = BOSS_HEAL_PROMPT
      .replace('{BOSS_NAME}', state.boss.name)
      .replace('{BOSS_TITLE}', state.boss.title)
      .replace('{BOSS_HP}', state.bossCurrentHP.toString())
      .replace('{BOSS_MAX_HP}', state.bossMaxHP.toString())
      .replace('{TASK_NAME}', taskName)
      .replace('{HEAL_AMOUNT}', healAmount.toString());

    const narrative = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.85,
      200
    );

    const hpBar = this.generateHPBar(state.bossCurrentHP, state.bossMaxHP);

    return `😈 *${state.boss.name} يستعيد قوته!*\n\n${narrative.trim()}\n\n${hpBar}`;
  }

  private async generateVictoryNarrative(state: BattleState): Promise<string> {
    const prompt = VICTORY_NARRATIVE_PROMPT
      .replace('{BOSS_NAME}', state.boss.name)
      .replace('{BOSS_TITLE}', state.boss.title)
      .replace('{TOTAL_DAMAGE}', state.playerDamageDealt.toString())
      .replace('{TASKS_COMPLETED}', state.tasksCompleted.toString())
      .replace('{CRITICAL_HITS}', state.criticalHits.toString())
      .replace('{BOSS_HEALING}', state.bossHealingReceived.toString());

    const narrative = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.9,
      400
    );

    return `\n🏆 *النصر!*\n\n${narrative.trim()}`;
  }

  private async generateDefeatNarrative(state: BattleState): Promise<string> {
    const prompt = DEFEAT_NARRATIVE_PROMPT
      .replace('{BOSS_NAME}', state.boss.name)
      .replace('{BOSS_TITLE}', state.boss.title)
      .replace('{BOSS_HP}', state.bossCurrentHP.toString())
      .replace('{BOSS_MAX_HP}', state.bossMaxHP.toString())
      .replace('{TOTAL_DAMAGE}', state.playerDamageDealt.toString())
      .replace('{TASKS_COMPLETED}', state.tasksCompleted.toString())
      .replace('{BOSS_HEALING}', state.bossHealingReceived.toString());

    const narrative = await this.aiComplete(
      [{ role: 'user', content: prompt }],
      0.85,
      300
    );

    return `💀 *الهزيمة*\n\n${narrative.trim()}`;
  }

  private generateQuickBossResponse(boss: Boss, currentHP: number, maxHP: number): string {
    const hpPercent = currentHP / maxHP;

    if (hpPercent > 0.7) {
      return `💬 "${boss.name}: هذا كل ما عندك؟"`;
    } else if (hpPercent > 0.4) {
      return `💬 "${boss.name}: بدأت أشعر بالألم... لكن لن أسقط!"`;
    } else if (hpPercent > 0.15) {
      return `💬 "${boss.name}: أنت... قوي. لكن اليوم لم ينته بعد!"`;
    } else {
      return `💬 "${boss.name}: لا... لا! كيف يمكن هذا؟!"`;
    }
  }

  private generateHPBar(current: number, max: number): string {
    const percent = current / max;
    const filled = Math.round(percent * 10);
    const empty = 10 - filled;

    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const emoji = percent > 0.5 ? '❤️' : percent > 0.2 ? '🧡' : '💔';

    return `${emoji} HP: [${bar}] ${current}/${max}`;
  }

  private generateStatusMessage(state: BattleState): string {
    const hpBar = this.generateHPBar(state.bossCurrentHP, state.bossMaxHP);
    const status = state.isVictory ? '🏆 *نصر!*' : state.isDefeat ? '💀 *هزيمة*' : '⚔️ *معركة جارية*';

    return `${status}

*${state.boss.name}*
_${state.boss.title}_

${hpBar}

📊 إحصائيات المعركة:
✅ مهام منجزة: ${state.tasksCompleted}
💥 ضربات حاسمة: ${state.criticalHits}
⚔️ ضرر كلي: ${state.playerDamageDealt}
${state.bossHealingReceived > 0 ? `😈 شفاء العدو: ${state.bossHealingReceived}` : ''}

_نقطة ضعفه: ${state.boss.weakness}_`;
  }

  private async getBattleState(chatId: string, date: string): Promise<BattleState | null> {
    try {
      const result = await this.db.select('battle_states', {
        filter: {
          chat_id: op.eq(chatId),
          battle_date: op.eq(date),
        },
        limit: 1,
      });

      if (result.length === 0) return null;
      return result[0]?.state as BattleState;
    } catch {
      return null;
    }
  }

  private async saveBattleState(chatId: string, state: BattleState): Promise<void> {
    try {
      await this.db.upsert('battle_states', {
        chat_id: chatId,
        battle_date: state.date,
        state: state,
        updated_at: new Date().toISOString(),
      }, 'chat_id,battle_date');
    } catch (error) {
      console.log('Could not save battle state (table may not exist):', error);
    }
  }
}

// ============================================
// Factory Function
// ============================================

export function createBattleMode(
  db: SupabaseClient,
  settings: SettingsManager,
  aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>
): BattleMode {
  return new BattleMode(db, settings, aiCompleteFunc);
}
