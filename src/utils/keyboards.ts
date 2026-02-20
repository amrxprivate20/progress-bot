/**
 * Inline Keyboard Utilities
 *
 * Reusable inline keyboard builders for common bot interactions.
 * All keyboards use callback_data for handling responses.
 */

import { InlineKeyboard } from 'grammy';

// ============================================
// Types
// ============================================

export interface TaskInfo {
  id: string;
  content: string;
}

// ============================================
// Coach Check-in Keyboards
// ============================================

/**
 * Keyboard shown after coach check-in message
 */
export function createCoachCheckInKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('▶️ ابدأ مهمة', 'coach:start_task')
    .text('📅 خطة اليوم', 'cmd:plan')
    .row()
    .text('💬 احكيلي', 'coach:talk')
    .text('😴 تعبان', 'coach:tired')
    .text('⏸️ مشغول', 'coach:busy')
    .row()
    .text('🔥 احرقني', 'cmd:roast')
    .text('⚔️ معركة', 'cmd:battle');
}

/**
 * Keyboard for mood check
 */
export function createMoodKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('⚡ طاقة عالية', 'mood:high')
    .text('😐 عادي', 'mood:normal')
    .text('😴 تعبان', 'mood:low');
}

/**
 * Keyboard with all available commands (shown in coach messages)
 */
export function createCommandsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🎯 ابدأ مهمة', 'cmd:starttask')
    .text('🆘 محتاج مساعدة', 'cmd:stuck')
    .row()
    .text('😏 احرقني', 'cmd:roast')
    .text('⚔️ معركة', 'cmd:battle')
    .row()
    .text('📋 المهام', 'cmd:tasks')
    .text('📅 الخطة', 'cmd:plan');
}

/**
 * Quick task start keyboard with top tasks
 */
export function createQuickTasksKeyboard(tasks: TaskInfo[], limit: number = 3): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  const displayTasks = tasks.slice(0, limit);
  for (const task of displayTasks) {
    // Truncate long task names
    const displayName = task.content.length > 30
      ? task.content.substring(0, 27) + '...'
      : task.content;
    keyboard.text(`▶️ ${displayName}`, `task:start:${task.id}`).row();
  }

  keyboard.text('📋 عرض الكل', 'cmd:starttask');

  return keyboard;
}

// ============================================
// Task Session Keyboards
// ============================================

/**
 * Keyboard for active task session
 */
export function createActiveSessionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ خلصت', 'session:complete')
    .text('⏸️ وقف مؤقت', 'session:pause')
    .row()
    .text('❌ إلغاء', 'session:abandon');
}

/**
 * Keyboard for paused session
 */
export function createPausedSessionKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('▶️ استئناف', `session:resume:${sessionId}`)
    .text('❌ إلغاء', `session:abandon:${sessionId}`)
    .row()
    .text('🎯 مهمة جديدة', 'cmd:starttask');
}

/**
 * Keyboard after task completion
 */
export function createPostCompletionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🎯 مهمة تانية', 'cmd:starttask')
    .text('☕ استراحة 10د', 'break:10')
    .row()
    .text('📊 تقدمي', 'cmd:progress')
    .text('🏆 إنجازاتي', 'cmd:streak');
}

/**
 * Keyboard for resume decision (existing paused session found)
 */
export function createResumeDecisionKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('1️⃣ استئناف السابقة', `resume:yes:${sessionId}`)
    .row()
    .text('2️⃣ جلسة جديدة', 'resume:new');
}

// ============================================
// Interactive Coach Keyboards
// ============================================

/**
 * Keyboard for coach conversation continuation
 */
export function createCoachConversationKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🎯 ابدأ الشغل', 'coach:start_task')
    .text('📅 خطة اليوم', 'cmd:plan')
    .row()
    .text('💪 حفزني أكتر', 'coach:motivate')
    .text('🔚 كفاية', 'coach:end');
}

/**
 * Keyboard for no-response follow-up
 */
export function createNoResponseKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('👋 أنا هنا', 'coach:here')
    .text('⏰ فكرني بعدين', 'coach:remind_later')
    .row()
    .text('🎯 ابدأ دلوقتي', 'coach:start_task');
}

// ============================================
// Quick Mode Keyboards
// ============================================

/**
 * Keyboard for quick 5-minute mode
 */
export function createQuickModeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('⏱️ 5 دقايق بس', 'quick:5')
    .text('⏱️ 10 دقايق', 'quick:10')
    .row()
    .text('⏱️ 15 دقيقة', 'quick:15')
    .text('🎯 جلسة كاملة', 'cmd:starttask');
}

/**
 * Keyboard after quick mode ends
 */
export function createQuickModeEndKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔥 كمّل شوية', 'quick:extend')
    .text('✅ خلصت', 'session:complete')
    .row()
    .text('⏸️ استراحة', 'break:5');
}

// ============================================
// Streak and Progress Keyboards
// ============================================

/**
 * Keyboard for streak display
 */
export function createStreakKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🎯 كمّل السلسلة', 'cmd:starttask')
    .text('📊 تفاصيل أكتر', 'streak:details');
}

// ============================================
// Command Menu Helpers
// ============================================

/**
 * Get contextual command suggestions based on user state
 */
export function getContextualCommands(state: {
  hasActiveSession: boolean;
  hasPausedSession: boolean;
  hasActiveBattle: boolean;
}): string {
  const commands: string[] = [];

  if (state.hasActiveSession) {
    commands.push('/completetask', '/pause', '/abandon');
  } else if (state.hasPausedSession) {
    commands.push('/resumetask', '/starttask', '/abandon');
  } else {
    commands.push('/starttask', '/quick', '/plan');
  }

  if (state.hasActiveBattle) {
    commands.push('/battle_status');
  } else {
    commands.push('/battle_mode');
  }

  commands.push('/stuck', '/roast_me');

  return commands.join(' • ');
}

/**
 * Format command menu for message footer
 */
export function formatCommandMenu(commands: string[]): string {
  return `\n\n━━━━━━━━━━━━━━━━━━\n🎮 ${commands.join(' • ')}`;
}


// ============================================
// Task Selection Keyboards
// ============================================

/**
 * Keyboard for selecting a task from a list (used in /starttask and /log_failure)
 * Supports pagination for large task lists (PAGE_SIZE tasks per page)
 */
const TASK_PAGE_SIZE = 8;

export function createTaskSelectionKeyboard(
  tasks: TaskInfo[],
  mode: 'start' | 'failure',
  page: number = 0
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const prefix = mode === 'start' ? 'tasksel' : 'failsel';
  const totalPages = Math.ceil(tasks.length / TASK_PAGE_SIZE);
  const start = page * TASK_PAGE_SIZE;
  const end = Math.min(start + TASK_PAGE_SIZE, tasks.length);

  const displayTasks = tasks.slice(start, end);
  for (const task of displayTasks) {
    // Truncate long task names
    const displayName = task.content.length > 35
      ? task.content.substring(0, 32) + '...'
      : task.content;
    keyboard.text(`📌 ${displayName}`, `${prefix}:${task.id}`).row();
  }

  // Pagination buttons
  if (totalPages > 1) {
    if (page > 0) {
      keyboard.text(`⬅️ السابق`, `${prefix}:page:${page - 1}`);
    }
    keyboard.text(`${page + 1}/${totalPages}`, `${prefix}:noop`);
    if (page < totalPages - 1) {
      keyboard.text(`التالي ➡️`, `${prefix}:page:${page + 1}`);
    }
    keyboard.row();
  }

  // Add "New task" option
  keyboard.text('➕ مهمة جديدة', `${prefix}:new`);

  return keyboard;
}

/**
 * Keyboard shown when task starts - includes all session commands
 */
export function createTaskStartedKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ خلصت', 'session:complete')
    .text('⏸️ إيقاف مؤقت', 'session:pause')
    .row()
    .text('⏱️ إضافة مدة', 'session:addduration')
    .text('🔢 إضافة كمية', 'session:addquantity')
    .row()
    .text('❌ إلغاء المهمة', 'session:cancel');
}

/**
 * Keyboard for duration/quantity input prompts
 */
export function createDurationInputKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('15 دقيقة', 'duration:15')
    .text('30 دقيقة', 'duration:30')
    .text('45 دقيقة', 'duration:45')
    .row()
    .text('1 ساعة', 'duration:60')
    .text('1.5 ساعة', 'duration:90')
    .text('2 ساعة', 'duration:120')
    .row()
    .text('❌ إلغاء', 'duration:cancel');
}

/**
 * Keyboard for quantity input prompts
 */
export function createQuantityInputKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('1', 'quantity:1')
    .text('2', 'quantity:2')
    .text('3', 'quantity:3')
    .text('5', 'quantity:5')
    .row()
    .text('10', 'quantity:10')
    .text('15', 'quantity:15')
    .text('20', 'quantity:20')
    .row()
    .text('❌ إلغاء', 'quantity:cancel');
}

/**
 * Keyboard for resume decision with inline buttons
 */
export function createResumeChoiceKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('1️⃣ استئناف السابقة', `resumechoice:yes:${sessionId}`)
    .row()
    .text('2️⃣ جلسة جديدة', `resumechoice:new:${sessionId}`);
}

// ============================================
// Talk Session Keyboards
// ============================================

/**
 * Keyboard for choosing talk session duration
 */
export function createTalkDurationKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('5 دقايق', 'talk_dur:5')
    .text('10 دقايق', 'talk_dur:10')
    .row()
    .text('15 دقيقة', 'talk_dur:15')
    .text('20 دقيقة', 'talk_dur:20');
}

/**
 * Keyboard shown during an active talk session — only end button
 */
export function createTalkConversationKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔚 إنهاء المحادثة', 'coach:end');
}

/**
 * Get task session command footer (shown after task starts)
 */
export function getTaskSessionFooter(): string {
  return '\n\n━━━━━━━━━━━━━━━━━━\n' +
    '🎮 الأوامر المتاحة:\n' +
    '• /completetask - إنهاء المهمة\n' +
    '• /pause - إيقاف مؤقت\n' +
    '• /resumetask - استئناف\n' +
    '• /addduration - إضافة مدة\n' +
    '• /addquantity - إضافة كمية\n' +
    '• /canceltask - إلغاء المهمة';
}
