// ============================================
// Debug Logger Utility
// Sends debug logs to Telegram main chat when enabled
// Supports logging AI prompts for: Coach, Planning, Analysis
// ============================================

import type { SettingsManager } from '../database/settings';
import { splitMessage } from './split-message';

export type AIPromptType = 'coach' | 'planning' | 'analysis' | 'celebration' | 'general';

export class DebugLogger {
  private enabled: boolean = false;
  private botToken: string = '';
  private chatId: string = '';

  constructor(
    private settings: SettingsManager
  ) {}

  /**
   * Initialize debug logger - check if debug mode is enabled
   */
  async init(): Promise<void> {
    try {
      const debugMode = await this.settings.get('debug_mode');
      this.enabled = debugMode === 'true';

      if (this.enabled) {
        this.botToken = await this.settings.get('telegram_bot_token') || '';
        this.chatId = await this.settings.get('telegram_chat_id') || '';

        console.log('🐛 Debug mode ENABLED - logs will be sent to main Telegram chat');
        await this.log('🐛 Debug Mode Started - AI prompts will be shown here');
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
   * Log AI request with type categorization
   */
  async logAIRequest(
    model: string,
    messages: any[],
    temperature?: number,
    maxTokens?: number,
    promptType: AIPromptType = 'general'
  ): Promise<void> {
    if (!this.enabled) return;

    const typeEmoji = this.getTypeEmoji(promptType);
    const typeName = this.getTypeName(promptType);
    const timestamp = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

    let message = `${typeEmoji} **[DEBUG] ${typeName} - طلب AI**\n`;
    message += `⏰ ${timestamp}\n\n`;
    message += `🤖 Model: ${model}\n`;
    message += `🌡️ Temp: ${temperature || 0.7} | 📊 Tokens: ${maxTokens || 4000}\n\n`;
    message += `📝 **Prompt:**\n`;

    // Extract the user message content for display
    const userMessage = messages.find(m => m.role === 'user');
    if (userMessage) {
      const content = typeof userMessage.content === 'string'
        ? userMessage.content
        : JSON.stringify(userMessage.content);
      message += content;
    } else {
      message += JSON.stringify(messages, null, 2);
    }

    await this.sendToTelegram(message);
    console.log(`📤 AI REQUEST (${promptType}) logged to Telegram`);
  }

  /**
   * Log AI response with type categorization
   */
  async logAIResponse(
    _model: string,
    response: string,
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
    promptType: AIPromptType = 'general'
  ): Promise<void> {
    if (!this.enabled) return;

    const typeEmoji = this.getTypeEmoji(promptType);
    const typeName = this.getTypeName(promptType);
    const timestamp = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

    let message = `${typeEmoji} **[DEBUG] ${typeName} - رد AI**\n`;
    message += `⏰ ${timestamp}\n\n`;

    if (usage) {
      message += `📊 Tokens: ${usage.total_tokens || 'N/A'}\n\n`;
    }

    message += `💬 **Response:**\n`;
    message += response;

    await this.sendToTelegram(message);
    console.log(`📥 AI RESPONSE (${promptType}) logged to Telegram`);
  }

  /**
   * Log coach intervention prompt/response
   */
  async logCoachAI(prompt: string, response: string, interventionType: string): Promise<void> {
    if (!this.enabled) return;

    const timestamp = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

    let message = `🎯 **[DEBUG] Coach - ${interventionType}**\n`;
    message += `⏰ ${timestamp}\n\n`;
    message += `📤 **Prompt:**\n${prompt}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📥 **Response:**\n${response}`;

    await this.sendToTelegram(message);
    console.log(`🎯 Coach AI (${interventionType}) logged to Telegram`);
  }

  /**
   * Log planning AI prompt/response
   */
  async logPlanningAI(prompt: string, response: string, planType: string): Promise<void> {
    if (!this.enabled) return;

    const timestamp = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

    let message = `📅 **[DEBUG] Planning - ${planType}**\n`;
    message += `⏰ ${timestamp}\n\n`;
    message += `📤 **Prompt:**\n${prompt}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📥 **Response:**\n${response}`;

    await this.sendToTelegram(message);
    console.log(`📅 Planning AI (${planType}) logged to Telegram`);
  }

  /**
   * Log progress analysis AI prompt/response
   */
  async logAnalysisAI(prompt: string, response: string): Promise<void> {
    if (!this.enabled) return;

    const timestamp = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

    let message = `📊 **[DEBUG] Progress Analysis**\n`;
    message += `⏰ ${timestamp}\n\n`;
    message += `📤 **Prompt:**\n${prompt}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━\n\n`;
    message += `📥 **Response:**\n${response}`;

    await this.sendToTelegram(message);
    console.log(`📊 Analysis AI logged to Telegram`);
  }

  private getTypeEmoji(type: AIPromptType): string {
    const emojis: Record<AIPromptType, string> = {
      coach: '🎯',
      planning: '📅',
      analysis: '📊',
      celebration: '🎉',
      general: '🤖',
    };
    return emojis[type] || '🤖';
  }

  private getTypeName(type: AIPromptType): string {
    const names: Record<AIPromptType, string> = {
      coach: 'Coach',
      planning: 'Planning',
      analysis: 'Analysis',
      celebration: 'Celebration',
      general: 'General',
    };
    return names[type] || 'General';
  }

  /**
   * Log error
   */
  async logError(error: Error, context?: string): Promise<void> {
    const message = `❌ **ERROR**${context ? ` (${context})` : ''}\n\n${error.message}\n\n\`\`\`\n${error.stack}\n\`\`\``;
    await this.log(message, '❌');
  }

  /**
   * Send message to Telegram main chat (no thread)
   */
  private async sendToTelegram(text: string): Promise<void> {
    if (!this.botToken || !this.chatId) return;

    try {
      // Split long messages into chunks
      const chunks = splitMessage(text);
      const totalChunks = chunks.length;

      for (let i = 0; i < chunks.length; i++) {
        let chunk = chunks[i] || '';

        // Add chunk indicator if multiple chunks
        if (totalChunks > 1) {
          chunk = `📄 [${i + 1}/${totalChunks}]\n\n${chunk}`;
        }

        // Send to main chat (no thread ID - user requested main chat)
        const body = {
          chat_id: this.chatId,
          text: chunk,
        };

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

}

/**
 * Factory function
 */
export function createDebugLogger(settings: SettingsManager): DebugLogger {
  return new DebugLogger(settings);
}
