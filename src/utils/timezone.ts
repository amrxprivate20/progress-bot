// ============================================
// Timezone Utilities for Egypt (UTC+2)
// ============================================
// Handles all timezone conversions consistently
// Strategy: Store UTC, Convert at Boundaries

/**
 * Egypt timezone configuration
 */
const EGYPT_TIMEZONE = 'Africa/Cairo';
const EGYPT_OFFSET_HOURS = 2;
const EGYPT_OFFSET_MS = EGYPT_OFFSET_HOURS * 60 * 60 * 1000;

/**
 * Get current time in Egypt timezone
 */
export function getNowInEgypt(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: EGYPT_TIMEZONE }));
}

/**
 * Get today's date string in Egypt (YYYY-MM-DD)
 */
export function getTodayInEgypt(): string {
  const now = getNowInEgypt();
  return now.toISOString().split('T')[0]!;
}

/**
 * Convert UTC Date to Egypt Date
 */
export function utcToEgypt(utcDate: Date): Date {
  return new Date(utcDate.toLocaleString('en-US', { timeZone: EGYPT_TIMEZONE }));
}

/**
 * Convert Egypt Date to UTC Date
 */
export function egyptToUtc(egyptDate: Date): Date {
  return new Date(egyptDate.getTime() - EGYPT_OFFSET_MS);
}

/**
 * Get date string in Egypt timezone from UTC Date
 */
export function getEgyptDateString(utcDate: Date): string {
  const egyptDate = utcToEgypt(utcDate);
  return egyptDate.toISOString().split('T')[0]!;
}

/**
 * Get start and end of day in Egypt timezone (returned as UTC)
 * This is critical for filtering tasks by day
 * 
 * Example: For 2026-01-08 in Egypt
 * - Start: 2026-01-07 22:00:00 UTC (midnight in Egypt)
 * - End:   2026-01-08 21:59:59 UTC (23:59:59 in Egypt)
 */
export function getEgyptDayBoundaries(dateString: string): { start: Date; end: Date } {
  const [year, month, day] = dateString.split('-').map(Number);
  
  if (!year || !month || !day) {
    throw new Error(`Invalid date string: ${dateString}`);
  }
  
  // Create date at Egypt midnight
  const egyptMidnight = new Date(year, month - 1, day, 0, 0, 0, 0);
  
  // Convert to UTC (subtract offset)
  const utcMidnight = new Date(egyptMidnight.getTime() - EGYPT_OFFSET_MS);
  
  // End of day (23:59:59.999 in Egypt)
  const utcEndOfDay = new Date(utcMidnight.getTime() + 24 * 60 * 60 * 1000 - 1);
  
  return {
    start: utcMidnight,
    end: utcEndOfDay,
  };
}

/**
 * Check if two dates are the same day in Egypt timezone
 */
export function isSameDayInEgypt(date1: Date, date2: Date): boolean {
  return getEgyptDateString(date1) === getEgyptDateString(date2);
}

/**
 * Get yesterday's date in Egypt
 */
export function getYesterdayInEgypt(): string {
  const now = getNowInEgypt();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split('T')[0]!;
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

  const dayName = days[egyptDate.getDay()];
  const day = egyptDate.getDate();
  const month = months[egyptDate.getMonth()];
  const year = egyptDate.getFullYear();

  return `${dayName}، ${day} ${month} ${year}`;
}

/**
 * Format time duration in Arabic with proper plural rules
 * 
 * Arabic plural rules:
 * - 1: singular (ساعة / دقيقة)
 * - 2: dual (ساعتان / دقيقتان)
 * - 3-10: plural (ساعات / دقائق)
 * - 11+: singular + number (ساعة / دقيقة)
 */
export function formatArabicTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  const parts: string[] = [];

  if (hours > 0) {
    parts.push(formatArabicNumber(hours, 'ساعة', 'ساعتان', 'ساعات', 'ساعة'));
  }

  if (mins > 0) {
    parts.push(formatArabicNumber(mins, 'دقيقة', 'دقيقتان', 'دقائق', 'دقيقة'));
  }

  if (parts.length === 0) {
    return 'صفر دقيقة';
  }

  return parts.join(' و ');
}

/**
 * Format streak duration in Arabic
 * Example: "5 أيام", "يوم واحد", "يومان"
 */
export function formatArabicStreak(days: number): string {
  return formatArabicNumber(days, 'يوم', 'يومان', 'أيام', 'يوم');
}

/**
 * Helper: Format number with Arabic plural rules
 * 
 * @param num - The number
 * @param singular - Form for 1 (e.g., "يوم")
 * @param dual - Form for 2 (e.g., "يومان")
 * @param plural - Form for 3-10 (e.g., "أيام")
 * @param singularLarge - Form for 11+ (e.g., "يوم")
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

/**
 * Calculate days between two dates in Egypt timezone
 */
export function daysBetweenInEgypt(date1: Date, date2: Date): number {
  const egypt1 = getEgyptDateString(date1);
  const egypt2 = getEgyptDateString(date2);
  
  const d1 = new Date(egypt1);
  const d2 = new Date(egypt2);
  
  const diffMs = d2.getTime() - d1.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}
