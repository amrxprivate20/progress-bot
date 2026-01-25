// ============================================
// Settings Management Module
// ============================================
// Handles reading and updating system settings from Supabase

import type { SupabaseClient } from './client';
import { op } from './client';

/**
 * Settings Manager
 * Provides easy access to system configuration stored in Supabase
 */
export class SettingsManager {
  private client: SupabaseClient;
  private cache: Map<string, string> = new Map();
  private cacheExpiry: Map<string, number> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  /**
   * Get a setting value
   * @param key - Setting key
   * @param useCache - Whether to use cached value (default: true)
   * @returns Setting value or null if not found
   */
  async get(key: string, useCache: boolean = true): Promise<string | null> {
    // Check cache first
    if (useCache && this.isCacheValid(key)) {
      return this.cache.get(key) || null;
    }

    try {
      const results = await this.client.select('settings', {
        columns: 'value',
        filter: { key: op.eq(key) },
        limit: 1,
      });

      if (results.length === 0) {
        return null;
      }

      const value = results[0].value;
      
      // Update cache
      this.cache.set(key, value);
      this.cacheExpiry.set(key, Date.now() + this.CACHE_TTL);

      return value;
    } catch (error) {
      console.error(`Failed to get setting '${key}':`, error);
      throw error;
    }
  }

  /**
   * Get multiple settings at once
   * @param keys - Array of setting keys
   * @returns Object with key-value pairs
   */
  async getMultiple(keys: string[]): Promise<Record<string, string>> {
    try {
      const results = await this.client.select('settings', {
        columns: 'key,value',
        filter: { key: op.in(keys) },
      });

      const settings: Record<string, string> = {};
      
      for (const row of results) {
        settings[row.key] = row.value;
        
        // Update cache
        this.cache.set(row.key, row.value);
        this.cacheExpiry.set(row.key, Date.now() + this.CACHE_TTL);
      }

      return settings;
    } catch (error) {
      console.error('Failed to get multiple settings:', error);
      throw error;
    }
  }

  /**
   * Get all settings
   * @returns Object with all key-value pairs
   */
  async getAll(): Promise<Record<string, string>> {
    try {
      const results = await this.client.select('settings', {
        columns: 'key,value',
      });

      const settings: Record<string, string> = {};
      
      for (const row of results) {
        settings[row.key] = row.value;
        
        // Update cache
        this.cache.set(row.key, row.value);
        this.cacheExpiry.set(row.key, Date.now() + this.CACHE_TTL);
      }

      return settings;
    } catch (error) {
      console.error('Failed to get all settings:', error);
      throw error;
    }
  }

  /**
   * Set a setting value
   * @param key - Setting key
   * @param value - Setting value
   */
  async set(key: string, value: string): Promise<void> {
    try {
      await this.client.upsert(
        'settings',
        {
          key,
          value,
          updated_at: new Date().toISOString(),
        },
        'key'
      );

      // Update cache
      this.cache.set(key, value);
      this.cacheExpiry.set(key, Date.now() + this.CACHE_TTL);
    } catch (error) {
      console.error(`Failed to set setting '${key}':`, error);
      throw error;
    }
  }

  /**
   * Set multiple settings at once
   * @param settings - Object with key-value pairs
   */
  async setMultiple(settings: Record<string, string>): Promise<void> {
    try {
      const timestamp = new Date().toISOString();
      const data = Object.entries(settings).map(([key, value]) => ({
        key,
        value,
        updated_at: timestamp,
      }));

      await this.client.upsert('settings', data, 'key');

      // Update cache
      for (const [key, value] of Object.entries(settings)) {
        this.cache.set(key, value);
        this.cacheExpiry.set(key, Date.now() + this.CACHE_TTL);
      }
    } catch (error) {
      console.error('Failed to set multiple settings:', error);
      throw error;
    }
  }

  /**
   * Delete a setting
   * @param key - Setting key
   */
  async delete(key: string): Promise<void> {
    try {
      await this.client.delete('settings', {
        key: op.eq(key),
      });

      // Remove from cache
      this.cache.delete(key);
      this.cacheExpiry.delete(key);
    } catch (error) {
      console.error(`Failed to delete setting '${key}':`, error);
      throw error;
    }
  }

  /**
   * Check if cached value is still valid
   */
  private isCacheValid(key: string): boolean {
    const expiry = this.cacheExpiry.get(key);
    if (!expiry) return false;
    
    return Date.now() < expiry;
  }

  /**
   * Clear the settings cache
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheExpiry.clear();
  }

  /**
   * Get setting as number
   */
  async getNumber(key: string): Promise<number | null> {
    const value = await this.get(key);
    if (value === null) return null;
    
    const num = Number(value);
    return isNaN(num) ? null : num;
  }

  /**
   * Get setting as boolean
   */
  async getBoolean(key: string): Promise<boolean | null> {
    const value = await this.get(key);
    if (value === null) return null;
    
    return value.toLowerCase() === 'true' || value === '1';
  }

  /**
   * Get setting as JSON
   */
  async getJSON<T = any>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (value === null) return null;
    
    try {
      return JSON.parse(value);
    } catch (error) {
      console.error(`Failed to parse setting '${key}' as JSON:`, error);
      return null;
    }
  }

  /**
   * Set setting as JSON
   */
  async setJSON(key: string, value: any): Promise<void> {
    await this.set(key, JSON.stringify(value));
  }
}

/**
 * Predefined setting keys for type safety and autocomplete
 */
export const SETTINGS_KEYS = {
  // Telegram
  TELEGRAM_BOT_TOKEN: 'telegram_bot_token',
  TELEGRAM_CHAT_ID: 'telegram_chat_id',
  TELEGRAM_THREAD_ARABIC: 'telegram_thread_arabic',
  TELEGRAM_THREAD_ENGLISH: 'telegram_thread_english',
  TELEGRAM_THREAD_QURAN: 'telegram_thread_quran',
  
  // Todoist
  TODOIST_API_TOKEN: 'todoist_api_token',
  TODOIST_PROJECT_ID: 'todoist_project_id',
  
  // AI
  OPENROUTER_API_KEY: 'openrouter_api_key',
  AI_MODEL: 'ai_model', // Deprecated - use HIGH_TIER/LOW_TIER instead
  HIGH_TIER_AI_MODEL: 'high_tier_ai_model', // For unified analysis & memory optimization
  LOW_TIER_AI_MODEL: 'low_tier_ai_model',   // For everything else (plans, coaching, etc.)
  
  // Google Drive
  GOOGLE_DRIVE_FOLDER_ID: 'google_drive_folder_id',
  
  // System
  QURAN_TASK_NAME: 'quran_task_name',
  QURAN_SPREADSHEET_ID: 'quran_spreadsheet_id',
  TIMEZONE: 'timezone',
  STRATEGIC_GOALS: 'strategic_goals',
  MASTER_PROMPT: 'master_prompt',
} as const;

/**
 * Helper function to get commonly used settings in one call
 */
export async function getCommonSettings(manager: SettingsManager) {
  const keys = [
    SETTINGS_KEYS.TELEGRAM_BOT_TOKEN,
    SETTINGS_KEYS.TELEGRAM_CHAT_ID,
    SETTINGS_KEYS.TODOIST_API_TOKEN,
    SETTINGS_KEYS.TODOIST_PROJECT_ID,
    SETTINGS_KEYS.AI_MODEL,
    SETTINGS_KEYS.TIMEZONE,
  ];

  return await manager.getMultiple(keys);
}

/**
 * Validate that all required settings are present
 */
export async function validateRequiredSettings(
  manager: SettingsManager
): Promise<{ valid: boolean; missing: string[] }> {
  const required = [
    SETTINGS_KEYS.TELEGRAM_BOT_TOKEN,
    SETTINGS_KEYS.TELEGRAM_CHAT_ID,
    SETTINGS_KEYS.TODOIST_API_TOKEN,
    SETTINGS_KEYS.TODOIST_PROJECT_ID,
  ];

  const settings = await manager.getMultiple(required);
  const missing = required.filter(key => !settings[key] || settings[key] === 'YOUR_TOKEN_HERE');

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * AI Model Tiers
 * - high: For critical analysis tasks (unified report analysis, memory optimization)
 * - low: For simpler tasks (planning, coaching, battle mode, etc.)
 */
export type AIModelTier = 'high' | 'low';

// Default models for each tier
const DEFAULT_HIGH_TIER_MODEL = 'anthropic/claude-sonnet-4';
const DEFAULT_LOW_TIER_MODEL = 'anthropic/claude-haiku';

/**
 * Get AI model for a specific tier
 * Falls back to legacy ai_model setting, then to defaults
 */
export async function getAIModelByTier(
  manager: SettingsManager,
  tier: AIModelTier
): Promise<string> {
  if (tier === 'high') {
    const model = await manager.get(SETTINGS_KEYS.HIGH_TIER_AI_MODEL);
    if (model) return model;

    // Fallback to legacy ai_model setting
    const legacyModel = await manager.get(SETTINGS_KEYS.AI_MODEL);
    return legacyModel || DEFAULT_HIGH_TIER_MODEL;
  } else {
    const model = await manager.get(SETTINGS_KEYS.LOW_TIER_AI_MODEL);
    if (model) return model;

    // Fallback to default low-tier model
    return DEFAULT_LOW_TIER_MODEL;
  }
}
