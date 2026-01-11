// ============================================
// Enhanced Task Metadata Parser - FIXED v2
// ============================================
// CRITICAL FIXES:
// 1. Support Arabic comma (،) in addition to English comma (,)
// 2. Support FULL Arabic time words (دقيقة, ساعة, دقائق, ساعات)
// 3. Parse ONLY from brackets - ignore system-added metadata
// 4. No duplicate duration/quantity in notifications

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
 * FIXED v2: Enhanced to handle full Arabic formats:
 * - [15 دقيقة، 5 مرات] ✅ (full words with Arabic comma)
 * - [30د, 4 مرات] ✅
 * - [30د، 4 مرات] ✅ (Arabic comma)
 * - [2 ساعة، 10 صفحات] ✅
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
 * - [15 دقيقة] → 15 دقيقة (full word)
 * - [2 ساعة] → 2 ساعات (full word)
 * 
 * Quantity (English):
 * - [5 pages] → 5 pages
 * - [10 reps] → 10 reps
 * 
 * Quantity (Arabic):
 * - [5 صفحات] → 5 صفحات
 * - [50 ورقة] → 50 ورقة
 * - [10 تكرارات] → 10 تكرارات
 * - [4 مرات] → 4 مرات
 * 
 * Combined (comma-separated - BOTH commas supported):
 * - [30m, 5 pages] → duration + quantity
 * - [30m، 5 pages] → duration + quantity (Arabic comma)
 * - [2س, 10 صفحات] → Arabic duration + quantity
 * - [2س، 10 صفحات] → Arabic duration + quantity (Arabic comma)
 * - [15 دقيقة، 5 مرات] → Arabic duration + quantity (full words)
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

  // FIXED v2: Normalize Arabic comma (،) to English comma (,) before parsing
  const normalizedContent = content.replace(/،/g, ',');

  // Check for comma-separated format: [30m, 5 pages] or [2س, 10 صفحات] or [15 دقيقة, 5 مرات]
  const comboMatch = normalizedContent.match(/\[([^\]]+),\s*([^\]]+)\]/);
  if (comboMatch && comboMatch[1] && comboMatch[2]) {
    const part1 = comboMatch[1].trim();
    const part2 = comboMatch[2].trim();

    // Parse first part (usually duration)
    const duration1 = parseDuration(part1);
    if (duration1 !== null) {
      metadata.duration_minutes = duration1;
    } else {
      // Maybe it's quantity first, try parsing as quantity
      const quantity1 = parseQuantity(part1);
      if (quantity1) {
        metadata.quantity = quantity1.value;
        metadata.quantity_unit = quantity1.unit;
      }
    }

    // Parse second part (usually quantity)
    const quantity2 = parseQuantity(part2);
    if (quantity2) {
      metadata.quantity = quantity2.value;
      metadata.quantity_unit = quantity2.unit;
    } else {
      // Maybe it's duration second, try parsing as duration
      const duration2 = parseDuration(part2);
      if (duration2 !== null) {
        metadata.duration_minutes = duration2;
      }
    }
    
    return metadata;
  }

  // Single bracket formats
  // Try duration: [30m], [2h], [30د], [3س], [15 دقيقة]
  const durationMatch = normalizedContent.match(/\[([^\]]+)\]/);
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
 * Supports both English and Arabic (short and full forms)
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

  // FIXED v2: Arabic patterns including FULL WORDS
  // Short: 30د, 3س, 1.5س
  // Full: 15 دقيقة, 2 ساعة, 10 دقائق, 3 ساعات
  const arabicMatch = text.match(/^(\d+(?:\.\d+)?)\s*(د|س|دقيقة|دقائق|دقيقتان|ساعة|ساعات|ساعتان)$/);
  if (arabicMatch && arabicMatch[1] && arabicMatch[2]) {
    const value = parseFloat(arabicMatch[1]);
    const unit = arabicMatch[2];
    
    // Hour indicators
    if (unit === 'س' || unit === 'ساعة' || unit === 'ساعات' || unit === 'ساعتان') {
      return Math.round(value * 60);
    }
    // Minute indicators  
    else if (unit === 'د' || unit === 'دقيقة' || unit === 'دقائق' || unit === 'دقيقتان') {
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
  // Arabic: "5 صفحات", "50 ورقة", "4 مرات"
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

/**
 * Get display-friendly metadata string from raw task content
 * This preserves the user's original format from brackets ONLY
 * 
 * Example:
 * Input: "الاستيقاظ قبل شروق الشمس [30د، 4 مرات]"
 * Output: "[30د، 4 مرات]"
 * 
 * Input: "قراءة المسبعات مساءا [15 دقيقة، 5 مرات]"
 * Output: "[15 دقيقة، 5 مرات]"
 * 
 * Input: "Task [2h, 5 pages]"
 * Output: "[2h, 5 pages]"
 */
export function getOriginalMetadataString(content: string): string {
  const match = content.match(/\[([^\]]+)\]/);
  return match ? `[${match[1]}]` : '';
}
