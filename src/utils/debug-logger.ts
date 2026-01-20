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
      // Split long messages
      const chunks = this.splitMessage(text);

      for (const chunk of chunks) {
        const body: any = {
          chat_id: this.chatId,
          text: chunk,
          parse_mode: 'Markdown',
        };

        // Add thread ID if available
        if (this.debugThreadId) {
          body.message_thread_id = this.debugThreadId;
        }

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
          console.error('Failed to send debug message to Telegram:', error);
        }

        // Small delay between chunks
        if (chunks.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } catch (error) {
      console.error('Error sending debug message:', error);
    }
  }

  /**
   * Split message into chunks for Telegram
   */
  private splitMessage(text: string): string[] {
    const MAX_LENGTH = 4096;
    
    if (text.length <= MAX_LENGTH) {
      return [text];
    }

    const chunks: string[] = [];
    let currentChunk = '';
    const lines = text.split('\n');

    for (const line of lines) {
      if (currentChunk.length + line.length + 1 > MAX_LENGTH) {
        chunks.push(currentChunk);
        currentChunk = line + '\n';
      } else {
        currentChunk += line + '\n';
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
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
