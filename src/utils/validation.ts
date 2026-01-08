// ============================================
// Validation Utilities
// ============================================

import type { Task, ValidationResult } from '../types';

/**
 * Validate Todoist webhook event structure
 */
export function validateTodoistWebhook(payload: any): ValidationResult {
  const errors: string[] = [];

  if (!payload || typeof payload !== 'object') {
    errors.push('Payload must be an object');
    return { valid: false, errors };
  }

  if (!payload.event_name || typeof payload.event_name !== 'string') {
    errors.push('Missing or invalid event_name');
  }

  if (!payload.event_data || typeof payload.event_data !== 'object') {
    errors.push('Missing or invalid event_data');
  } else {
    // Validate event_data structure
    const data = payload.event_data;
    
    if (!data.id) errors.push('Missing event_data.id');
    if (!data.content) errors.push('Missing event_data.content');
    // project_id and checked are optional - Todoist doesn't always send them
    // We'll validate project_id separately if it exists
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate task data before insertion
 */
export function validateTask(task: Partial<Task>): ValidationResult {
  const errors: string[] = [];

  if (!task.task_id) {
    errors.push('task_id is required');
  }

  if (!task.content || task.content.trim().length === 0) {
    errors.push('content is required and cannot be empty');
  }

  if (!task.completed_at) {
    errors.push('completed_at is required');
  }

  if (task.priority !== undefined) {
    if (typeof task.priority !== 'number' || task.priority < 1 || task.priority > 4) {
      errors.push('priority must be a number between 1 and 4');
    }
  }

  if (task.status !== undefined) {
    if (!['done', 'failed', 'partial'].includes(task.status)) {
      errors.push('status must be one of: done, failed, partial');
    }
  }

  if (task.duration_minutes !== undefined) {
    if (typeof task.duration_minutes !== 'number' || task.duration_minutes < 0) {
      errors.push('duration_minutes must be a non-negative number');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate date string (ISO 8601 format)
 */
export function validateDateString(dateString: string): ValidationResult {
  const errors: string[] = [];

  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      errors.push('Invalid date format');
    }
  } catch (error) {
    errors.push('Failed to parse date');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate project ID matches expected project
 */
export function validateProjectId(
  projectId: string,
  expectedProjectId: string
): boolean {
  return projectId === expectedProjectId;
}

/**
 * Sanitize user input (remove potentially dangerous content)
 */
export function sanitizeInput(input: string): string {
  // Remove null bytes
  let sanitized = input.replace(/\0/g, '');
  
  // Trim whitespace
  sanitized = sanitized.trim();
  
  // Limit length
  const MAX_LENGTH = 10000;
  if (sanitized.length > MAX_LENGTH) {
    sanitized = sanitized.substring(0, MAX_LENGTH);
  }

  return sanitized;
}

/**
 * Validate setting key (alphanumeric with underscores only)
 */
export function validateSettingKey(key: string): ValidationResult {
  const errors: string[] = [];

  if (!key || key.trim().length === 0) {
    errors.push('Setting key cannot be empty');
  }

  if (!/^[a-z0-9_]+$/i.test(key)) {
    errors.push('Setting key must contain only letters, numbers, and underscores');
  }

  if (key.length > 100) {
    errors.push('Setting key must be 100 characters or less');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate Telegram chat ID
 */
export function validateTelegramChatId(chatId: string | number): ValidationResult {
  const errors: string[] = [];

  const id = typeof chatId === 'number' ? chatId.toString() : chatId;

  if (!id || id.trim().length === 0) {
    errors.push('Chat ID cannot be empty');
  }

  // Telegram chat IDs can be positive or negative (for groups)
  if (!/^-?\d+$/.test(id)) {
    errors.push('Chat ID must be a number');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

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

/**
 * Check if a value is a valid URL
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a string is valid JSON
 */
export function isValidJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}
