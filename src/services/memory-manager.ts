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
const CATEGORY_SIZE_THRESHOLD = 3000; // chars - optimize category if over this
const TOTAL_MEMORY_THRESHOLD = 10000; // chars - optimize all if total over this
const OPTIMIZATION_INTERVAL_DAYS = 7;

// ============================================
// Types
// ============================================

export interface MemoryOptimizationResult {
  needed: boolean;
  categoriesOptimized: string[];
  totalSizeBefore: number;
  totalSizeAfter: number;
  reasons: string[];
}

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
   * Check if optimization is needed (lightweight check, no AI calls)
   */
  async checkOptimizationNeeded(): Promise<{ needed: boolean; reasons: string[]; categories: string[] }> {
    const memories = await this.db.select<Memory>('memory', {});
    const reasons: string[] = [];
    const categories: string[] = [];

    let totalSize = 0;
    for (const mem of memories) {
      const content = mem.content || '';
      totalSize += content.length;

      if (content.length < 200) continue; // Skip near-empty categories

      const lastOptimized = mem.last_optimized
        ? (typeof mem.last_optimized === 'string' ? mem.last_optimized : mem.last_optimized.toISOString())
        : null;

      // Category too large
      if (content.length > CATEGORY_SIZE_THRESHOLD) {
        reasons.push(`${mem.category}: ${content.length} chars (>${CATEGORY_SIZE_THRESHOLD})`);
        categories.push(mem.category);
      }
      // Never optimized but has substantial content
      else if (!lastOptimized && content.length > 1000) {
        reasons.push(`${mem.category}: never optimized, ${content.length} chars`);
        categories.push(mem.category);
      }
      // Scheduled optimization (7+ days since last)
      else if (lastOptimized && this.needsScheduledOptimization(lastOptimized) && content.length > 500) {
        const days = Math.floor((Date.now() - new Date(lastOptimized).getTime()) / (1000 * 60 * 60 * 24));
        reasons.push(`${mem.category}: ${days} days since last optimization`);
        categories.push(mem.category);
      }
    }

    // Total memory too large
    if (totalSize > TOTAL_MEMORY_THRESHOLD && categories.length === 0) {
      reasons.push(`Total memory size: ${totalSize} chars (>${TOTAL_MEMORY_THRESHOLD})`);
      // Add all non-empty categories
      for (const mem of memories) {
        if ((mem.content || '').length > 200) {
          categories.push(mem.category);
        }
      }
    }

    return { needed: categories.length > 0, reasons, categories };
  }

  /**
   * Run memory optimization - standalone function
   * Checks current memory state and optimizes categories that need it.
   * Uses the provided AI client (should be high-tier for best results).
   *
   * @param highTierAiClient - AI client to use (high-tier recommended)
   * @param force - Force optimization of all categories regardless of criteria
   * @returns Optimization result with details
   */
  async runOptimization(
    highTierAiClient?: AIClient,
    force: boolean = false
  ): Promise<MemoryOptimizationResult> {
    const client = highTierAiClient || this.aiClient;
    const result: MemoryOptimizationResult = {
      needed: false,
      categoriesOptimized: [],
      totalSizeBefore: 0,
      totalSizeAfter: 0,
      reasons: [],
    };

    // Step 1: Check what needs optimization
    const check = await this.checkOptimizationNeeded();
    const categoriesToOptimize = force
      ? MEMORY_CATEGORIES.filter(async () => true) as unknown as string[] // all categories
      : check.categories;

    if (!force && !check.needed) {
      console.log('✅ Memory optimization check: not needed');
      result.reasons = ['All categories within limits'];
      return result;
    }

    result.needed = true;
    result.reasons = force ? ['Force optimization requested'] : check.reasons;

    // Get all categories to optimize (force = all with content > 200 chars)
    let targetCategories: string[];
    if (force) {
      const allMemory = await this.getAllMemory();
      targetCategories = MEMORY_CATEGORIES.filter(cat => (allMemory[cat] || '').length > 200);
    } else {
      targetCategories = categoriesToOptimize;
    }

    console.log(`🔄 Memory optimization starting: ${targetCategories.length} categories`);

    // Step 2: Calculate total size before
    const allMemoryBefore = await this.getAllMemory();
    result.totalSizeBefore = Object.values(allMemoryBefore).reduce((sum, c) => sum + c.length, 0);

    // Step 3: Optimize each category
    for (const category of targetCategories) {
      const currentContent = allMemoryBefore[category] || '';
      if (currentContent.length < 200) {
        console.log(`⏭️ Skipping ${category}: too small (${currentContent.length} chars)`);
        continue;
      }

      console.log(`🔄 Optimizing: ${category} (${currentContent.length} chars)`);

      try {
        const recentInsights = await this.getRecentInsights(category);
        const optimizedContent = await client.optimizeMemory(
          category,
          currentContent,
          recentInsights
        );

        // Sanity check: don't save if optimization returned empty or much smaller
        if (optimizedContent && optimizedContent.length > 50) {
          await this.upsertCategory(category, optimizedContent, true);
          result.categoriesOptimized.push(category);
          console.log(`✅ ${category}: ${currentContent.length} → ${optimizedContent.length} chars`);
        } else {
          console.warn(`⚠️ ${category}: optimization returned suspicious result, keeping original`);
        }
      } catch (error) {
        console.error(`❌ Failed to optimize ${category}:`, error);
      }
    }

    // Step 4: Calculate total size after
    const allMemoryAfter = await this.getAllMemory();
    result.totalSizeAfter = Object.values(allMemoryAfter).reduce((sum, c) => sum + c.length, 0);

    console.log(`🎉 Memory optimization complete: ${result.totalSizeBefore} → ${result.totalSizeAfter} chars (${result.categoriesOptimized.length} categories)`);

    return result;
  }

  /**
   * Legacy: Check if optimization is needed and trigger if necessary
   * (called from updateMemory - just logs, actual optimization is now via runOptimization)
   */
  async checkOptimizationTriggers(): Promise<boolean> {
    const check = await this.checkOptimizationNeeded();
    if (check.needed) {
      console.log(`📢 Memory optimization recommended: ${check.reasons.join(', ')}`);
    }
    return check.needed;
  }

  /**
   * Optimize a specific memory category
   */
  async optimizeCategory(category: string, overrideClient?: AIClient): Promise<void> {
    const client = overrideClient || this.aiClient;
    const currentContent = await this.getCategory(category);

    if (!currentContent || currentContent.length < 100) {
      console.log(`Category ${category} too small to optimize`);
      return;
    }

    console.log(`Optimizing memory category: ${category}`);

    const recentInsights = await this.getRecentInsights(category);
    const optimizedContent = await client.optimizeMemory(
      category,
      currentContent,
      recentInsights
    );

    if (optimizedContent && optimizedContent.length > 50) {
      await this.upsertCategory(category, optimizedContent, true);
      console.log(`Optimization complete for: ${category}`);
    }
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
   * Append new content to existing with date prefix
   */
  private appendContent(existing: string, newContent: string): string {
    // Add date prefix to new content
    const today = new Date().toLocaleDateString('ar-EG', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'Africa/Cairo',
    });
    const datedContent = `[${today}] ${newContent}`;

    if (!existing) {
      return datedContent;
    }

    return `${existing}\n\n${datedContent}`;
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