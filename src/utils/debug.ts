// ============================================
// Debug logging - sends to Telegram when debug_mode is on
// ============================================

import type { SettingsManager } from '../database/settings';
import { splitMessage } from './split-message';

/** Env must have Telegram credentials; chatId can come from env or settings. */
export interface DebugEnv {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID?: string;
}

/**
 * Send a plain text message to Telegram (used by debugLog).
 * Splits long messages into chunks to avoid truncation.
 */
async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string
): Promise<void> {
  const chunks = splitMessage(text);
  const totalChunks = chunks.length;

  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i] || '';
    if (totalChunks > 1) {
      chunk = `📄 [${i + 1}/${totalChunks}]\n\n${chunk}`;
    }

    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      }
    );
    if (!response.ok) {
      const err = await response.text();
      console.error('debugLog Telegram send failed:', err);
    }

    if (totalChunks > 1 && i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

/**
 * If debug_mode setting is 'true', send a Telegram message with 🐛 prefix.
 * Otherwise do nothing. Never throws (logs errors to console.error).
 * chatId is read from env.TELEGRAM_CHAT_ID or settings.telegram_chat_id.
 */
export async function debugLog(
  env: DebugEnv,
  settings: SettingsManager,
  message: string,
  data?: unknown
): Promise<void> {
  try {
    const debugMode = await settings.get('debug_mode');
    if (debugMode !== 'true') return;

    const chatId = env.TELEGRAM_CHAT_ID || (await settings.get('telegram_chat_id'));
    if (!chatId) return;

    const text =
      '🐛 ' + message + (data !== undefined ? '\n' + JSON.stringify(data, null, 2) : '');
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, text);
  } catch (error) {
    console.error('debugLog failed:', error);
  }
}
