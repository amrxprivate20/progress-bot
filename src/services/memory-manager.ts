/**
 * Memory Management Service
 *
 * Handles organized memory system with 6 categories:
 * - Personal Insights & Patterns
 * - Successful Strategies & What Works
 * - Triggers & Challenges
 * - Important Milestones & Breakthroughs
 * - Recurring Themes & Lessons
 * - Personal Information & Facts
 *
 * Features:
 * - Automatic updates from AI insights
 * - Smart deduplication (70% word overlap threshold)
 * - Auto-optimization triggers
 */

import { SupabaseClient, op } from '../database/client';
import { Memory } from '../types';
import { AIClient } from './ai-client';

// ============================================
// Constants
// ============================================

const MEMORY_CATEGORIES = [
  'Personal Insights & Patterns',
  'Successful Strategies & What Works',
  'Triggers & Challenges',
  'Important Milestones & Breakthroughs',
  'Recurring Themes & Lessons',
  'Personal Information & Facts',
] as const;

const DEDUPLICATION_THRESHOLD = 0.7; // 70% word overlap
const MAX_MEMORY_SIZE = 10000; // characters
const OPTIMIZATION_INTERVAL_DAYS = 7;

// ============================================
// Memory Manager
// ============================================

export class MemoryManager {
  constructor(
    private db: SupabaseClient,
    private aiClient: AIClient
  ) {}

  /**
   * Get all memory categories
   */
  async getAllMemory(): Promise<Record<string, string>> {
    const memories = await this.db.select<Memory>('memory', {});

    const result: Record<string, string> = {};
    for (const mem of memories) {
      result[mem.category] = mem.content || '';
    }

    // Ensure all categories exist
    for (const category of MEMORY_CATEGORIES) {
      if (!(category in result)) {
        result[category] = '';
      }
    }

    return result;
  }

  /**
   * Get memory for a specific category
   * FIXED: Use op.eq() to properly encode the filter
   */
  async getCategory(category: string): Promise<string> {
    const result = await this.db.select<Memory>('memory', { 
      filter: { category: op.eq(category) } 
    });

    if (result.length === 0) {
      return '';
    }

    return result[0]?.content || '';
  }

  /**
   * Update memory with new insights
   */
  async updateMemory(updates: Record<string, string>): Promise<void> {
    for (const [category, newContent] of Object.entries(updates)) {
      if (!MEMORY_CATEGORIES.includes(category as any)) {
        console.warn(`Invalid memory category: ${category}`);
        continue;
      }

      const currentContent = await this.getCategory(category);

      // Check for duplication
      if (this.isDuplicate(currentContent, newContent)) {
        console.log(`Skipping duplicate content in ${category}`);
        continue;
      }

      // Append new content
      const updatedContent = this.appendContent(currentContent, newContent);

      // Upsert to database
      await this.upsertCategory(category, updatedContent);

      console.log(`Updated memory category: ${category}`);
    }

    // Check if optimization is needed
    await this.checkOptimizationTriggers();
  }

  /**
   * Update a single memory category (for use with delays between categories)
   */
  async updateSingleCategory(category: string, newContent: string): Promise<void> {
    if (!MEMORY_CATEGORIES.includes(category as any)) {
      console.warn(`Invalid memory category: ${category}`);
      return;
    }

    const currentContent = await this.getCategory(category);

    // Check for duplication
    if (this.isDuplicate(currentContent, newContent)) {
      console.log(`Skipping duplicate content in ${category}`);
      return;
    }

    // Append new content
    const updatedContent = this.appendContent(currentContent, newContent);

    // Upsert to database
    await this.upsertCategory(category, updatedContent);
    console.log(`Updated single memory category: ${category}`);
  }

  /**
   * Clear all memory
   */
  async clearAll(): Promise<void> {
    for (const category of MEMORY_CATEGORIES) {
      await this.upsertCategory(category, '');
    }
  }

  /**
   * Clear specific category
   */
  async clearCategory(category: string): Promise<void> {
    await this.upsertCategory(category, '');
  }

  /**
   * Check if optimization is needed and trigger if necessary
   */
  async checkOptimizationTriggers(): Promise<boolean> {
    const memories = await this.db.select<Memory>('memory', {});

    for (const mem of memories) {
      const lastOptimized = mem.last_optimized
        ? (typeof mem.last_optimized === 'string' ? mem.last_optimized : mem.last_optimized.toISOString())
        : null;

      const needsOptimization =
        this.isTooLarge(mem.content || '') ||
        this.needsScheduledOptimization(lastOptimized);

      if (needsOptimization) {
        console.log(`Optimization needed for: ${mem.category}`);
        await this.optimizeCategory(mem.category);
        return true;
      }
    }

    return false;
  }

  /**
   * Optimize a specific memory category
   */
  async optimizeCategory(category: string): Promise<void> {
    const currentContent = await this.getCategory(category);

    if (!currentContent || currentContent.length < 100) {
      console.log(`Category ${category} too small to optimize`);
      return;
    }

    console.log(`Optimizing memory category: ${category}`);

    // Get recent insights from last 7 daily reports
    const recentInsights = await this.getRecentInsights(category);

    // Use AI to optimize
    const optimizedContent = await this.aiClient.optimizeMemory(
      category,
      currentContent,
      recentInsights
    );

    // Update with optimized content
    await this.upsertCategory(category, optimizedContent, true);

    console.log(`Optimization complete for: ${category}`);
  }

  /**
   * Get formatted memory for display
   */
  async getFormattedMemory(): Promise<string> {
    const memory = await this.getAllMemory();

    let formatted = '📚 **الذاكرة المنظمة**\n\n';

    for (const category of MEMORY_CATEGORIES) {
      const content = memory[category];
      formatted += `**${category}**\n`;
      formatted += content ? `${content}\n\n` : '_لا توجد معلومات بعد_\n\n';
    }

    return formatted;
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Check if new content is duplicate
   */
  private isDuplicate(existingContent: string, newContent: string): boolean {
    if (!existingContent) {
      return false;
    }

    const overlap = this.calculateWordOverlap(existingContent, newContent);
    return overlap >= DEDUPLICATION_THRESHOLD;
  }

  /**
   * Calculate word overlap between two texts
   */
  private calculateWordOverlap(text1: string, text2: string): number {
    const words1 = new Set(
      text1
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2)
    );
    const words2 = new Set(
      text2
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2)
    );

    let commonWords = 0;
    for (const word of words2) {
      if (words1.has(word)) {
        commonWords++;
      }
    }

    return words2.size > 0 ? commonWords / words2.size : 0;
  }

  /**
   * Append new content to existing
   */
  private appendContent(existing: string, newContent: string): string {
    if (!existing) {
      return newContent;
    }

    return `${existing}\n\n${newContent}`;
  }

  /**
   * Check if memory is too large
   */
  private isTooLarge(content: string): boolean {
    return content.length > MAX_MEMORY_SIZE;
  }

  /**
   * Check if scheduled optimization is needed
   */
  private needsScheduledOptimization(lastOptimized: string | null): boolean {
    if (!lastOptimized) {
      return false; // Never optimized, no need yet
    }

    const lastOptDate = new Date(lastOptimized);
    const daysSince = (Date.now() - lastOptDate.getTime()) / (1000 * 60 * 60 * 24);

    return daysSince >= OPTIMIZATION_INTERVAL_DAYS;
  }

  /**
   * Get recent insights for a category from daily reports
   */
  private async getRecentInsights(_category: string): Promise<string[]> {
    // Get last 7 daily reports
    const reports = await this.db.select(
      'daily_reports',
      {
        order: 'report_date:desc',
        limit: 7,
      }
    );

    const insights: string[] = [];

    for (const report of reports) {
      // Extract relevant insights from AI commentary
      // This is a simple heuristic - in practice, you might want more sophisticated extraction
      if (report.ai_commentary) {
        const commentary = report.ai_commentary as string;
        // Look for insight markers or just take key sentences
        const sentences = commentary.split(/[.!?]\s+/);
        const relevantSentences = sentences.filter(s => s.length > 20 && s.length < 200);
        insights.push(...relevantSentences.slice(0, 2)); // Max 2 per report
      }
    }

    return insights.slice(0, 10); // Max 10 total insights
  }

  /**
   * Upsert memory category
   * FIXED: Use op.eq() for proper filter encoding
   */
  private async upsertCategory(
    category: string,
    content: string,
    isOptimization: boolean = false
  ): Promise<void> {
    const existing = await this.db.select<Memory>('memory', { 
      filter: { category: op.eq(category) } 
    });

    const now = new Date().toISOString();

    if (existing.length > 0) {
      await this.db.update(
        'memory',
        { category: op.eq(category) },
        {
          content,
          last_updated: now,
          ...(isOptimization && { last_optimized: now }),
        }
      );
    } else {
      await this.db.insert('memory', {
        category,
        content,
        last_updated: now,
        ...(isOptimization && { last_optimized: now }),
      });
    }
  }
}

// ============================================
// Factory Function
// ============================================

export function createMemoryManager(
  db: SupabaseClient,
  aiClient: AIClient
): MemoryManager {
  return new MemoryManager(db, aiClient);
}