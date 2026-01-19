// ============================================
// Reports Handler
// ============================================
// Handles report generation requests and preview

import type { SupabaseClient } from '../database/client';
import type { SettingsManager } from '../database/settings';
import type { ReportData, ReportPreview } from '../types';
import { createReportGenerator } from '../services/report-generator';
import { ValidationError } from '../utils/errors';

/**
 * Generate a report preview (without AI analysis)
 */
export async function generateReportPreview(
  date: Date | undefined,
  db: SupabaseClient,
  settings: SettingsManager
): Promise<{ preview: ReportPreview; message: string }> {
  try {
    const generator = createReportGenerator(db, settings);
    const dateString = date ? date.toISOString().split('T')[0] : undefined;
    const preview = await generator.generatePreview(dateString);

    // Format preview message in Arabic
    const message = formatPreviewMessage(preview);

    return {
      preview,
      message,
    };
  } catch (error) {
    console.error('Failed to generate report preview:', error);
    throw new ValidationError('Failed to generate report preview');
  }
}

/**
 * Collect complete report data for AI analysis
 */
export async function collectFullReportData(
  date: Date | undefined,
  db: SupabaseClient,
  settings: SettingsManager
): Promise<ReportData> {
  try {
    const generator = createReportGenerator(db, settings);
    const dateString = date ? date.toISOString().split('T')[0] : undefined;
    return await generator.collectReportData(dateString);
  } catch (error) {
    console.error('Failed to collect report data:', error);
    throw new ValidationError('Failed to collect report data');
  }
}

/**
 * Format preview message in Arabic
 */
function formatPreviewMessage(preview: ReportPreview): string {
  let message = `📊 *ملخص اليوم - ${preview.date}*\n\n`;

  // Overall statistics
  message += `📈 *الإحصائيات العامة:*\n`;
  message += `• المهام المكتملة: ${preview.completed_tasks} من ${preview.total_tasks}\n`;
  message += `• معدل النجاح: ${preview.success_rate}%\n`;
  message += `• الوقت المنتج: ${formatArabicTime(preview.total_time_minutes)}\n`;

  if (preview.failed_tasks > 0) {
    message += `• المهام الفاشلة: ${preview.failed_tasks}\n`;
  }

  // Top categories
  if (preview.top_categories && preview.top_categories.length > 0) {
    message += `\n🏷 *أهم الفئات:*\n`;
    preview.top_categories.forEach((cat, i) => {
      const timeStr = cat.time ? ` (${formatArabicTime(cat.time)})` : '';
      message += `${i + 1}. ${cat.name}: ${cat.count} مهام${timeStr}\n`;
    });
  }

  // Streak updates
  if (preview.streak_updates && preview.streak_updates.length > 0) {
    message += `\n🔥 *تحديثات السلاسل:*\n`;
    preview.streak_updates.forEach((streak) => {
      const emoji = streak.current >= 7 ? '🔥' : '✅';
      message += `${emoji} ${streak.task}: ${streak.current} يوم`;
      if (streak.current === streak.best) {
        message += ' (رقم قياسي جديد!)';
      }
      message += '\n';
    });
  }

  message += `\n💡 *هل تريد التحليل الكامل بالذكاء الاصطناعي؟*\n`;
  message += `استخدم /confirm للمتابعة أو /cancel للإلغاء`;

  return message;
}

/**
 * Format time in Arabic (helper function)
 */
function formatArabicTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  
  const parts: string[] = [];
  
  if (hours > 0) {
    if (hours === 1) parts.push('ساعة');
    else if (hours === 2) parts.push('ساعتان');
    else if (hours <= 10) parts.push(`${hours} ساعات`);
    else parts.push(`${hours} ساعة`);
  }
  
  if (mins > 0) {
    if (mins === 1) parts.push('دقيقة');
    else if (mins === 2) parts.push('دقيقتان');
    else if (mins <= 10) parts.push(`${mins} دقائق`);
    else parts.push(`${mins} دقيقة`);
  }
  
  return parts.join(' و') || '0 دقائق';
}

/**
 * Save report to database
 */
export async function saveReport(
  reportDate: Date,
  reportMarkdown: string,
  stats: {
    success_rate?: number;
    total_tasks?: number;
    completed_tasks?: number;
    failed_tasks?: number;
    achievement_time_minutes?: number;
  },
  db: SupabaseClient
): Promise<void> {
  try {
    const dateStr = reportDate.toISOString().split('T')[0];

    await db.upsert(
      'daily_reports',
      {
        report_date: dateStr,
        report_markdown: reportMarkdown,
        success_rate: stats.success_rate,
        total_tasks: stats.total_tasks,
        completed_tasks: stats.completed_tasks,
        failed_tasks: stats.failed_tasks,
        achievement_time_minutes: stats.achievement_time_minutes,
        created_at: new Date().toISOString(),
      },
      'report_date'
    );
  } catch (error) {
    console.error('Failed to save report:', error);
    throw error;
  }
}