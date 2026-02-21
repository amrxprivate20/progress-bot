/**
 * Inline Keyboard Utilities
 *
 * Reusable inline keyboard builders for common bot interactions.
 * All keyboards use callback_data for handling responses.
 */

import { InlineKeyboard } from 'grammy';
import { extractCleanTaskName } from './task-parser';

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

// ============================================
// Task Session Keyboards
// ============================================

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
    // Clean display name: strip [30m], [5 pages], etc. Raw content stays in DB
    const cleaned = extractCleanTaskName(task.content).trim();
    const displayName = cleaned.length > 35
      ? cleaned.substring(0, 32) + '...'
      : cleaned;
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
