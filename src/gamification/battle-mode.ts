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
import { createReportGenerator } from '../services/report-generator';

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

const GENERATE_BOSS_PROMPT = `أنت بتخلق البوس بتاع اليوم - عدو يجسّد التسويف والمقاومة.

تاريخ اليوم: {DATE}
يوم الأسبوع: {DAY_OF_WEEK}

⚠️ مهم جداً: كل الكلام لازم يكون بالعامية المصرية فقط! مفيش إنجليزي خالص.

اعمل بوس فريد بالعناصر دي:
1. الاسم: اسم درامي ومميز بالعربي
2. اللقب: لقب مرعب بالعربي
3. الوصف: 2-3 جمل تصف شكله وطبيعته
4. الشخصية: إزاي بيستهزأ ويتحدى اللاعب
5. نقطة الضعف: إيه اللي بيهزمه (مرتبط بالإنتاجية)
6. التحدي: صيحته في بداية المعركة

أفكار حسب اليوم:
- السبت: "سيد البدايات الثقيلة"
- الأحد: "وحش التشتت"
- الإثنين: "شيطان الشك"
- الثلاثاء: "حارس الكسل"
- الأربعاء: "أمير المماطلة"
- الخميس: "إغواء نهاية الأسبوع"
- الجمعة: "فخ الراحة"

كن مبدع! خلي محاربته ممتعة!

الصيغة:
[الاسم]
اسم البوس بالعربي

[اللقب]
لقبه بالعربي

[الوصف]
2-3 جمل بالعربي

[الشخصية]
إزاي بيتصرف

[نقطة_الضعف]
إيه اللي بيهزمه

[التحدي]
جملته الافتتاحية`;

const DAMAGE_NARRATIVE_PROMPT = `أنت بتروي معركة بين محارب الإنتاجية وبوس اليوم.

البوس: {BOSS_NAME}، {BOSS_TITLE}
طاقة البوس: {BOSS_HP}/{BOSS_MAX_HP}
اللاعب أنجز للتو: "{TASK_NAME}"
الضرر: {DAMAGE} نقطة
ضربة حاسمة؟: {IS_CRITICAL}
المهام المنجزة اليوم: {TASKS_TODAY}

⚠️ مهم جداً: الرد لازم يكون بالعامية المصرية فقط! مفيش إنجليزي.

اكتب رواية قصيرة (2-3 جمل) درامية:
- وصف الهجوم بشكل ملحمي
- إظهار رد فعل البوس (ألم، إحباط، خوف)
- لو ضربة حاسمة: خليها ملحمية جداً!
- لو طاقة البوس قليلة: أظهر يأسه

خلي الطاقة عالية! خلي إكمال المهام حاسة بالقوة!`;

const BOSS_HEAL_PROMPT = `البوس بيتعافى لأن اللاعب فشل أو أجّل مهمة!

البوس: {BOSS_NAME}، {BOSS_TITLE}
طاقة البوس: {BOSS_HP}/{BOSS_MAX_HP}
المهمة الفاشلة/المؤجلة: "{TASK_NAME}"
الشفاء: {HEAL_AMOUNT} نقطة

⚠️ مهم جداً: الرد لازم يكون بالعامية المصرية فقط! مفيش إنجليزي.

اكتب رواية قصيرة (2-3 جمل):
- البوس بيتباهى بضعف اللاعب
- بيستخدم شخصيته للسخرية
- بيخلق إلحاح - بيحفز اللاعب يرد
- متكونش قاسي، بس خلي التقاعس يحسس بالخسارة`;

const VICTORY_NARRATIVE_PROMPT = `اللاعب هزم بوس اليوم!

البوس: {BOSS_NAME}، {BOSS_TITLE}
الإحصائيات النهائية:
- الضرر الكلي: {TOTAL_DAMAGE}
- المهام المنجزة: {TASKS_COMPLETED}
- الضربات الحاسمة: {CRITICAL_HITS}
- شفاء البوس: {BOSS_HEALING}

⚠️ مهم جداً: الرد لازم يكون بالعامية المصرية فقط! مفيش إنجليزي.

اكتب احتفال بالنصر (4-6 سطور):
1. وصف درامي للهزيمة
2. كلمات البوس الأخيرة
3. لقب اللاعب لليوم
4. تشويق لبكرة (تحدي جديد في الانتظار)

خلي اللحظة دي مذهلة! هو يستاهل!`;

const DEFEAT_NARRATIVE_PROMPT = `البوس نجا! اللاعب مهزمهوش النهارده.

البوس: {BOSS_NAME}، {BOSS_TITLE}
طاقة البوس المتبقية: {BOSS_HP}/{BOSS_MAX_HP}
الإحصائيات:
- الضرر الكلي: {TOTAL_DAMAGE}
- المهام المنجزة: {TASKS_COMPLETED}
- شفاء البوس: {BOSS_HEALING}

⚠️ مهم جداً: الرد لازم يكون بالعامية المصرية فقط! مفيش إنجليزي.

اكتب رسالة الهزيمة (3-4 سطور):
- البوس بيتباهى بالفوز (كوميدي، مش قاسي)
- إيه اللي كان ممكن يبقى مختلف
- تحفيز لبكرة (الموضوع لسه مخلصش)

كن حاد بس مش محطم. خليه متحمس للانتقام.`;

// ============================================
// Battle Mode Class
// ============================================

export class BattleMode {
  private aiComplete: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>;
  private settings: SettingsManager;

  constructor(
    private db: SupabaseClient,
    settings: SettingsManager,
    aiCompleteFunc: (messages: AIMessage[], temp?: number, maxTokens?: number) => Promise<string>
  ) {
    this.aiComplete = aiCompleteFunc;
    this.settings = settings;
    // Context builder available for future coaching integration
    createCoachingContextBuilder(db, settings);
  }

  /**
   * Sync battle stats with accurate report preview data
   * This ensures task counts are accurate from the report generator
   */
  private async syncStatsFromReport(state: BattleState): Promise<BattleState> {
    try {
      const reportGen = createReportGenerator(this.db, this.settings);
      const preview = await reportGen.generatePreview(state.date);

      // Update state with accurate counts from report
      state.tasksCompleted = preview.completed_tasks;
      state.tasksFailed = preview.failed_tasks;

      // Recalculate damage based on actual completed tasks
      // Use success rate to determine effective damage
      const totalDamageFromTasks = state.tasksCompleted * 10; // Base damage per task
      state.playerDamageDealt = totalDamageFromTasks + state.criticalHits * 5; // Add crit bonus

      // Recalculate boss HP based on actual progress
      const effectiveHP = state.bossMaxHP - state.playerDamageDealt + state.bossHealingReceived;
      state.bossCurrentHP = Math.max(0, Math.min(state.bossMaxHP, effectiveHP));

      // Check for victory/defeat
      if (state.bossCurrentHP <= 0) {
        state.isVictory = true;
      }

      console.log(`📊 Battle stats synced: Completed=${state.tasksCompleted}, Failed=${state.tasksFailed}, HP=${state.bossCurrentHP}`);

      return state;
    } catch (error) {
      console.error('❌ Error syncing battle stats:', error);
      return state; // Return original state on error
    }
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
   * Syncs with accurate report data before showing status
   */
  async getStatus(chatId: string): Promise<string> {
    const today = getTodayInEgypt();
    let state = await this.getBattleState(chatId, today);

    if (!state) {
      return '⚔️ لا توجد معركة نشطة اليوم.\n\nاستخدم /battle_mode لبدء معركة جديدة!';
    }

    // Sync stats with accurate report data
    state = await this.syncStatsFromReport(state);
    await this.saveBattleState(chatId, state);

    return this.generateStatusMessage(state);
  }

  /**
   * End the day's battle (called at end of day)
   * Syncs with accurate report data before ending
   */
  async endBattle(chatId: string): Promise<string> {
    const today = getTodayInEgypt();
    let state = await this.getBattleState(chatId, today);

    if (!state) {
      return 'لا توجد معركة لإنهائها.';
    }

    // Sync stats with accurate report data before ending
    state = await this.syncStatsFromReport(state);

    if (state.isVictory) {
      await this.saveBattleState(chatId, state);
      return this.generateVictoryNarrative(state);
    }

    // Mark as defeat if boss still has HP
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

    // Parse response - support both English and Arabic headers for backwards compatibility
    const nameMatch = response.match(/\[(?:NAME|الاسم)\]\s*(.+?)(?:\[|$)/is);
    const titleMatch = response.match(/\[(?:TITLE|اللقب)\]\s*(.+?)(?:\[|$)/is);
    const descMatch = response.match(/\[(?:DESCRIPTION|الوصف)\]\s*([\s\S]+?)(?:\[|$)/i);
    const personalityMatch = response.match(/\[(?:PERSONALITY|الشخصية)\]\s*([\s\S]+?)(?:\[|$)/i);
    const weaknessMatch = response.match(/\[(?:WEAKNESS|نقطة_الضعف)\]\s*([\s\S]+?)(?:\[|$)/i);
    const tauntMatch = response.match(/\[(?:TAUNT|التحدي)\]\s*([\s\S]+?)$/i);

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
      // Delete existing state first (upsert may not work without proper unique constraint)
      await this.db.delete('battle_states', {
        chat_id: op.eq(chatId),
        battle_date: op.eq(state.date),
      }).catch(() => {});

      // Insert new state
      await this.db.insert('battle_states', {
        chat_id: chatId,
        battle_date: state.date,
        state: state,
        updated_at: new Date().toISOString(),
      });

      console.log(`✅ Battle state saved: HP ${state.bossCurrentHP}/${state.bossMaxHP}, Tasks: ${state.tasksCompleted}`);
    } catch (error) {
      console.error('❌ Could not save battle state:', error);
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
