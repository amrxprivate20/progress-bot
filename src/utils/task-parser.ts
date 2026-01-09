// ============================================
// Enhanced Task Metadata Parser
// ============================================
// ADDED: Arabic support for duration ([30د], [3س]) and units ([50 ورقة])
// Supports both English and Arabic formats

export interface ParsedTaskMetadata {
  duration_minutes?: number;
  quantity?: number;
  quantity_unit?: string;
  category?: string;
  is_origin?: boolean;
  origin_task?: string;
}

/**
 * Parse task metadata from content
 * 
 * Supported formats:
 * 
 * Duration (English):
 * - [30m] → 30 minutes
 * - [2h] → 120 minutes
 * - [1.5h] → 90 minutes
 * 
 * Duration (Arabic):
 * - [30د] → 30 دقيقة
 * - [3س] → 3 ساعات
 * - [1.5س] → 1.5 ساعة
 * 
 * Quantity (English):
 * - [5 pages] → 5 pages
 * - [10 reps] → 10 reps
 * 
 * Quantity (Arabic):
 * - [5 صفحات] → 5 صفحات
 * - [50 ورقة] → 50 ورقة
 * - [10 تكرارات] → 10 تكرارات
 * 
 * Combined (comma-separated):
 * - [30m, 5 pages] → duration + quantity
 * - [2س, 10 صفحات] → Arabic duration + quantity
 * 
 * Category:
 * - @work → category
 * - #health → category
 * 
 * Origin marker:
 * - Task❗ → is_origin: true
 */
export function parseTaskMetadata(content: string): ParsedTaskMetadata {
  const metadata: ParsedTaskMetadata = {};

  // Check for comma-separated format: [30m, 5 pages] or [2س, 10 صفحات]
  const comboMatch = content.match(/\[([^\]]+),\s*([^\]]+)\]/);
  if (comboMatch && comboMatch[1] && comboMatch[2]) {
    const part1 = comboMatch[1].trim();
    const part2 = comboMatch[2].trim();

    // Parse first part (usually duration)
    const duration1 = parseDuration(part1);
    if (duration1 !== null) {
      metadata.duration_minutes = duration1;
    }

    // Parse second part (usually quantity)
    const quantity2 = parseQuantity(part2);
    if (quantity2) {
      metadata.quantity = quantity2.value;
      metadata.quantity_unit = quantity2.unit;
    }
    
    return metadata;
  }

  // Single bracket formats
  // Try duration: [30m], [2h], [30د], [3س]
  const durationMatch = content.match(/\[([^\]]+)\]/);
  if (durationMatch && durationMatch[1]) {
    const duration = parseDuration(durationMatch[1].trim());
    if (duration !== null) {
      metadata.duration_minutes = duration;
    } else {
      // Try quantity if not duration
      const quantity = parseQuantity(durationMatch[1].trim());
      if (quantity) {
        metadata.quantity = quantity.value;
        metadata.quantity_unit = quantity.unit;
      }
    }
  }

  // Category with @ or #
  const categoryMatch = content.match(/[@#]([a-z0-9_]+)/i);
  if (categoryMatch && categoryMatch[1]) {
    metadata.category = categoryMatch[1];
  }

  // Origin marker (❗)
  if (content.includes('❗')) {
    metadata.is_origin = true;
  }

  return metadata;
}

/**
 * Parse duration from text
 * Supports both English and Arabic
 * 
 * Returns minutes, or null if not a duration
 */
function parseDuration(text: string): number | null {
  // English patterns: 30m, 2h, 1.5h, etc.
  const englishMatch = text.match(/^(\d+(?:\.\d+)?)(m|h|min|mins|hour|hours)$/i);
  if (englishMatch && englishMatch[1] && englishMatch[2]) {
    const value = parseFloat(englishMatch[1]);
    const unit = englishMatch[2].toLowerCase();
    
    if (unit === 'h' || unit === 'hour' || unit === 'hours') {
      return Math.round(value * 60);
    } else {
      return Math.round(value);
    }
  }

  // Arabic patterns: 30د, 3س, 1.5س
  // د = دقيقة (minute)
  // س = ساعة (hour)
  const arabicMatch = text.match(/^(\d+(?:\.\d+)?)(د|س|دقيقة|دقائق|ساعة|ساعات)$/);
  if (arabicMatch && arabicMatch[1] && arabicMatch[2]) {
    const value = parseFloat(arabicMatch[1]);
    const unit = arabicMatch[2];
    
    if (unit === 'س' || unit === 'ساعة' || unit === 'ساعات') {
      return Math.round(value * 60);
    } else if (unit === 'د' || unit === 'دقيقة' || unit === 'دقائق') {
      return Math.round(value);
    }
  }

  return null;
}

/**
 * Parse quantity from text
 * Supports both English and Arabic
 * 
 * Returns {value, unit} or null if not a quantity
 */
function parseQuantity(text: string): { value: number; unit: string } | null {
  // Pattern: number + space + unit
  // English: "5 pages", "10 reps"
  // Arabic: "5 صفحات", "50 ورقة"
  const match = text.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (match && match[1] && match[2]) {
    const value = parseFloat(match[1]);
    const unit = match[2].trim();
    
    // Only return if unit is non-numeric (to distinguish from duration)
    if (isNaN(parseFloat(unit))) {
      return { value, unit };
    }
  }

  return null;
}

/**
 * Parse origin task from content
 * Format: "Subtask (origin: Main Task)"
 */
export function parseOriginTask(content: string): string | undefined {
  const match = content.match(/\(origin:\s*([^)]+)\)/i);
  return match && match[1] ? match[1].trim() : undefined;
}

/**
 * Extract task name without metadata
 * Removes brackets, origin markers, and categories
 */
export function extractCleanTaskName(content: string): string {
  return content
    .replace(/\[([^\]]+)\]/g, '') // Remove brackets
    .replace(/[@#][a-z0-9_]+/gi, '') // Remove categories
    .replace(/❗/g, '') // Remove origin marker
    .replace(/\(origin:[^)]+\)/gi, '') // Remove origin reference
    .trim();
}
