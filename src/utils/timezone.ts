// ============================================
// Timezone Utilities for Egypt (UTC+2) - COMPLETELY FIXED
// ============================================
// CRITICAL FIX: Uses proper timezone conversion
// 1:16 AM Egypt = 23:16 UTC previous day = SHOULD BE TODAY

/**
 * Egypt timezone offset in milliseconds
 * Egypt is UTC+2 (no DST)
 */
const EGYPT_OFFSET_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Get current time in Egypt timezone
 * FIXED: Properly adds offset to UTC time
 */
export function getNowInEgypt(): Date {
  const utcNow = new Date();
  return new Date(utcNow.getTime() + EGYPT_OFFSET_MS);
}

/**
 * Get today's date string in Egypt (YYYY-MM-DD)
 * FIXED: Correctly determines Egypt date even at 1 AM
 */
export function getTodayInEgypt(): string {
  const egyptNow = getNowInEgypt();
  
  const year = egyptNow.getUTCFullYear();
  const month = String(egyptNow.getUTCMonth() + 1).padStart(2, '0');
  const day = String(egyptNow.getUTCDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

/**
 * Convert UTC Date to Egypt Date
 * FIXED: Adds 2 hours to UTC
 */
export function utcToEgypt(utcDate: Date): Date {
  return new Date(utcDate.getTime() + EGYPT_OFFSET_MS);
}

/**
 * Get date string in Egypt timezone from UTC Date
 * FIXED: Properly converts to Egypt date
 */
export function getEgyptDateString(utcDate: Date): string {
  const egyptDate = utcToEgypt(utcDate);
  
  const year = egyptDate.getUTCFullYear();
  const month = String(egyptDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(egyptDate.getUTCDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

/**
 * Get start and end of day in Egypt timezone (returned as UTC)
 * FIXED: Correctly calculates midnight in Egypt as UTC
 * 
 * Example: For 2026-01-08 in Egypt (at 1:16 AM)
 * - Egypt midnight: 2026-01-08 00:00:00 Egypt = 2026-01-07 22:00:00 UTC
 * - Egypt end of day: 2026-01-08 23:59:59 Egypt = 2026-01-08 21:59:59 UTC
 * 
 * So task at 1:16 AM Egypt (23:16 UTC Jan 7) falls AFTER midnight Egypt
 */
export function getEgyptDayBoundaries(dateString: string): { start: Date; end: Date } {
  const [year, month, day] = dateString.split('-').map(Number);
  
  if (!year || !month || !day) {
    throw new Error(`Invalid date string: ${dateString}`);
  }
  
  // Create midnight in Egypt (as UTC date object)
  // Egypt midnight = UTC minus 2 hours
  const egyptMidnightUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const startUTC = new Date(egyptMidnightUTC.getTime() - EGYPT_OFFSET_MS);
  
  // End of day in Egypt (23:59:59.999 Egypt) = UTC minus 2 hours
  const egyptEndOfDayUTC = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  const endUTC = new Date(egyptEndOfDayUTC.getTime() - EGYPT_OFFSET_MS);
  
  return {
    start: startUTC,
    end: endUTC,
  };
}

/**
 * Get yesterday's date in Egypt
 */
export function getYesterdayInEgypt(): string {
  const egyptNow = getNowInEgypt();
  const yesterday = new Date(egyptNow);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  
  const year = yesterday.getUTCFullYear();
  const month = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
  const day = String(yesterday.getUTCDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

/**
 * Format date in Arabic
 * Example: "الأحد، 8 يناير 2026"
 */
export function formatArabicDate(date: Date): string {
  const egyptDate = utcToEgypt(date);
  
  const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const months = [
    'يناير', 'فبراير', 'مارس', 'إبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
  ];

  const dayName = days[egyptDate.getUTCDay()];
  const day = egyptDate.getUTCDate();
  const month = months[egyptDate.getUTCMonth()];
  const year = egyptDate.getUTCFullYear();

  return `${dayName}، ${day} ${month} ${year}`;
}

/**
 * Format time duration in Arabic with proper plural rules
 * Returns empty string for zero duration (caller should handle/skip)
 */
export function formatArabicTime(minutes: number): string {
  if (minutes <= 0) {
    return ''; // Return empty for zero - caller should skip display
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  const parts: string[] = [];

  if (hours > 0) {
    parts.push(formatArabicNumber(hours, 'ساعة', 'ساعتان', 'ساعات', 'ساعة'));
  }

  if (mins > 0) {
    parts.push(formatArabicNumber(mins, 'دقيقة', 'دقيقتان', 'دقائق', 'دقيقة'));
  }

  return parts.join(' و ');
}

/**
 * Format streak duration in Arabic
 */
export function formatArabicStreak(days: number): string {
  return formatArabicNumber(days, 'يوم', 'يومان', 'أيام', 'يوم');
}

/**
 * Helper: Format number with Arabic plural rules
 */
function formatArabicNumber(
  num: number,
  singular: string,
  dual: string,
  plural: string,
  singularLarge: string
): string {
  if (num === 1) {
    return singular;
  } else if (num === 2) {
    return dual;
  } else if (num >= 3 && num <= 10) {
    return `${num} ${plural}`;
  } else {
    return `${num} ${singularLarge}`;
  }
}
