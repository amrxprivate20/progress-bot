/**
 * Conversation State Manager
 *
 * Manages multi-step conversations for Q&A flow during report generation.
 * Stores conversation state in database with 10-minute expiry.
 */

import { SupabaseClient, op } from '../database/client';
import { ConversationState } from '../types';

// ============================================
// Constants
// ============================================

const CONVERSATION_TIMEOUT_MINUTES = 10;

// ============================================
// Conversation Manager
// ============================================

export class ConversationManager {
  constructor(private db: SupabaseClient) {}

  /**
   * Start a new Q&A conversation
   */
  async startQAConversation(
    chatId: string,
    questions: string[],
    reportContext: any
  ): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + CONVERSATION_TIMEOUT_MINUTES);

    const state: Omit<ConversationState, 'id' | 'created_at'> = {
      chat_id: chatId,
      conversation_type: 'qa_report',
      current_step: 0,
      total_steps: questions.length,
      data: {
        questions,
        answers: {},
        reportContext,
      },
      expires_at: expiresAt,
    };

    // Delete any existing conversation for this chat
    await this.db.delete('conversation_state', { 
      chat_id: op.eq(chatId) 
    });

    // Create new conversation
    await this.db.insert('conversation_state', state);
  }

  /**
   * Get active conversation for a chat
   */
  async getConversation(chatId: string): Promise<ConversationState | null> {
    const result = await this.db.select<ConversationState>(
      'conversation_state',
      { 
        filter: { 
          chat_id: op.eq(chatId) 
        },
        limit: 1
      }
    );

    if (result.length === 0) {
      return null;
    }

    const conversation = result[0];
    if (!conversation) {
      return null;
    }

    // Check if expired
    const expiresAt = typeof conversation.expires_at === 'string'
      ? new Date(conversation.expires_at)
      : conversation.expires_at;

    if (expiresAt < new Date()) {
      await this.clearConversation(chatId);
      return null;
    }

    return conversation;
  }

  /**
   * Get current question in conversation
   */
  async getCurrentQuestion(chatId: string): Promise<string | null> {
    const conversation = await this.getConversation(chatId);
    if (!conversation) {
      return null;
    }

    const questions = conversation.data.questions || [];
    const currentStep = conversation.current_step;

    if (currentStep >= questions.length) {
      return null; // All questions answered
    }

    return questions[currentStep] || null;
  }

  /**
   * Save user answer and move to next question
   */
  async saveAnswer(chatId: string, answer: string): Promise<boolean> {
    const conversation = await this.getConversation(chatId);
    if (!conversation) {
      return false;
    }

    const questions = conversation.data.questions || [];
    const currentStep = conversation.current_step;
    const currentQuestion = questions[currentStep];

    if (!currentQuestion) {
      return false;
    }

    // Save answer
    const answers = conversation.data.answers || {};
    answers[currentQuestion] = answer;

    // Update conversation - FIX: Use op.eq() for the filter
    await this.db.update(
      'conversation_state',
      { 
        id: op.eq(conversation.id as string)
      },
      {
        current_step: currentStep + 1,
        data: {
          ...conversation.data,
          answers,
        },
      }
    );

    return true;
  }

  /**
   * Check if all questions are answered
   */
  async isComplete(chatId: string): Promise<boolean> {
    const conversation = await this.getConversation(chatId);
    if (!conversation) {
      return false;
    }

    return conversation.current_step >= conversation.total_steps;
  }

  /**
   * Get all answers from conversation
   */
  async getAnswers(chatId: string): Promise<Record<string, string> | null> {
    const conversation = await this.getConversation(chatId);
    if (!conversation) {
      return null;
    }

    return conversation.data.answers || {};
  }

  /**
   * Get report context from conversation
   */
  async getReportContext(chatId: string): Promise<any | null> {
    const conversation = await this.getConversation(chatId);
    if (!conversation) {
      return null;
    }

    return conversation.data.reportContext;
  }

  /**
   * Clear conversation state
   */
  async clearConversation(chatId: string): Promise<void> {
    await this.db.delete('conversation_state', { 
      chat_id: op.eq(chatId) 
    });
  }

  /**
   * Clear all expired conversations
   */
  async cleanupExpired(): Promise<void> {
    // This would be better as a SQL query, but using the REST API:
    const allConversations = await this.db.select<ConversationState>(
      'conversation_state',
      {}
    );

    const now = new Date();
    const expiredIds = allConversations
      .filter(c => {
        const expiresAt = typeof c.expires_at === 'string'
          ? new Date(c.expires_at)
          : c.expires_at;
        return expiresAt < now;
      })
      .map(c => c.id)
      .filter((id): id is string => id !== undefined);

    for (const id of expiredIds) {
      await this.db.delete('conversation_state', { 
        id: op.eq(id) 
      });
    }
  }

  /**
   * Check if user is in any active conversation
   */
  async hasActiveConversation(chatId: string): Promise<boolean> {
    const conversation = await this.getConversation(chatId);
    return conversation !== null;
  }

  /**
   * Get conversation progress (e.g., "2/5")
   */
  async getProgress(chatId: string): Promise<string | null> {
    const conversation = await this.getConversation(chatId);
    if (!conversation) {
      return null;
    }

    return `${conversation.current_step}/${conversation.total_steps}`;
  }
}

// ============================================
// Factory Function
// ============================================

export function createConversationManager(db: SupabaseClient): ConversationManager {
  return new ConversationManager(db);
}