// ============================================
// Debug Logger Utility
// Sends debug logs to Telegram when enabled
// ============================================

import type { SettingsManager } from '../database/settings';

export class DebugLogger {
  private enabled: boolean = false;
  private botToken: string = '';
  private chatId: string = '';
  private debugThreadId: string = '';

  constructor(
    private settings: SettingsManager
  ) {}

  /**
   * Initialize debug logger - check if debug mode is enabled
   */
  async init(): Promise<void> {
    try {
      const debugMode = await this.settings.get('debugger_mode');
      this.enabled = debugMode === 'true';

      if (this.enabled) {
        this.botToken = await this.settings.get('telegram_bot_token') || '';
        this.chatId = await this.settings.get('telegram_chat_id') || '';
        this.debugThreadId = await this.settings.get('telegram_thread_debug') || '';

        console.log('🐛 Debug mode ENABLED - logs will be sent to Telegram');
        await this.log('🐛 **Debug Mode Started**');
      } else {
        console.log('ℹ️ Debug mode disabled');
      }
    } catch (error) {
      console.error('Failed to initialize debug logger:', error);
      this.enabled = false;
    }
  }

  /**
   * Check if debug mode is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Log a message (both console and Telegram if enabled)
   */
  async log(message: string, prefix: string = '🐛'): Promise<void> {
    // Always log to console
    console.log(message);

    // Send to Telegram if enabled
    if (this.enabled && this.botToken && this.chatId) {
      await this.sendToTelegram(`${prefix} ${message}`);
    }
  }

  /**
   * Log AI request
   */
  async logAIRequest(
  model: string,
  messages: any[],
  temperature?: number,
  maxTokens?: number
): Promise<void> {
  if (!this.enabled) return;

  const timestamp = new Date().toISOString();
  let message = `📤 **AI REQUEST** (${timestamp})\n\n`;
  message += `🤖 **Model:** ${model}\n`;
  message += `🌡️ **Temperature:** ${temperature || 0.7}\n`;
  message += `📊 **Max Tokens:** ${maxTokens || 4000}\n\n`;
  message += `📝 **Messages:**\n`;
  
  // Send messages as JSON without truncation
  const messagesJson = JSON.stringify(messages, null, 2);
  message += '```json\n';
  message += messagesJson;
  message += '\n```';

  await this.sendToTelegram(message);
  console.log('📤 AI REQUEST logged to Telegram');
}

  /**
   * Log AI response
   */
  async logAIResponse(
  model: string,
  response: string,
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
): Promise<void> {
  if (!this.enabled) return;

  const timestamp = new Date().toISOString();
  let message = `📥 **AI RESPONSE** (${timestamp})\n\n`;
  message += `🤖 **Model:** ${model}\n`;
  
  if (usage) {
    message += `📊 **Tokens:**\n`;
    message += `  • Prompt: ${usage.prompt_tokens || 'N/A'}\n`;
    message += `  • Completion: ${usage.completion_tokens || 'N/A'}\n`;
    message += `  • Total: ${usage.total_tokens || 'N/A'}\n\n`;
  }
  
  message += `💬 **Response:**\n`;
  message += '```\n';
  message += response; // ✅ NO TRUNCATION
  message += '\n```';

  await this.sendToTelegram(message);
  console.log('📥 AI RESPONSE logged to Telegram');
}

  /**
   * Log error
   */
  async logError(error: Error, context?: string): Promise<void> {
    const message = `❌ **ERROR**${context ? ` (${context})` : ''}\n\n${error.message}\n\n\`\`\`\n${error.stack}\n\`\`\``;
    await this.log(message, '❌');
  }

  /**
   * Send message to Telegram
   */
  private async sendToTelegram(text: string): Promise<void> {
    if (!this.botToken || !this.chatId) return;

    try {
      // Split long messages into chunks
      const chunks = this.splitMessage(text);
      const totalChunks = chunks.length;

      for (let i = 0; i < chunks.length; i++) {
        let chunk = chunks[i] || '';

        // Add chunk indicator if multiple chunks
        if (totalChunks > 1) {
          chunk = `📄 [${i + 1}/${totalChunks}]\n\n${chunk}`;
        }

        // Try with Markdown first, fallback to plain text if it fails
        const body: any = {
          chat_id: this.chatId,
          text: chunk,
        };

        // Add thread ID if available
        if (this.debugThreadId) {
          body.message_thread_id = this.debugThreadId;
        }

        // First try without parse_mode (plain text - most reliable)
        const response = await fetch(
          `https://api.telegram.org/bot${this.botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        );

        if (!response.ok) {
          const error = await response.text();
          console.error(`Failed to send debug chunk ${i + 1}/${totalChunks}:`, error);
        } else {
          console.log(`✅ Debug chunk ${i + 1}/${totalChunks} sent (${chunk.length} chars)`);
        }

        // Delay between chunks to avoid rate limiting
        if (totalChunks > 1 && i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    } catch (error) {
      console.error('Error sending debug message:', error);
    }
  }

  /**
   * Split message into chunks for Telegram (max 4096 chars)
   * Handles long lines and tries to split at natural boundaries
   */
  private splitMessage(text: string): string[] {
    const MAX_LENGTH = 4000; // Leave some margin for chunk indicators

    if (text.length <= MAX_LENGTH) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_LENGTH) {
        chunks.push(remaining);
        break;
      }

      // Find a good split point
      let splitAt = MAX_LENGTH;

      // Try to split at a newline
      const lastNewline = remaining.lastIndexOf('\n', MAX_LENGTH);
      if (lastNewline > MAX_LENGTH * 0.5) {
        splitAt = lastNewline + 1;
      } else {
        // Try to split at a space
        const lastSpace = remaining.lastIndexOf(' ', MAX_LENGTH);
        if (lastSpace > MAX_LENGTH * 0.5) {
          splitAt = lastSpace + 1;
        }
        // Otherwise just split at MAX_LENGTH
      }

      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt);
    }

    return chunks;
  }
}

/**
 * Factory function
 */
export function createDebugLogger(settings: SettingsManager): DebugLogger {
  return new DebugLogger(settings);
}
