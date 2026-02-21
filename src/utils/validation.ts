// ============================================
// Validation Utilities
// ============================================

import type { ValidationResult } from '../types';

/**
 * Validate environment variables
 */
export function validateEnvironment(env: any): ValidationResult {
  const errors: string[] = [];
  const required = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'TODOIST_API_TOKEN',
  ];

  for (const key of required) {
    if (!env[key] || typeof env[key] !== 'string' || env[key].trim().length === 0) {
      errors.push(`Missing or invalid environment variable: ${key}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
