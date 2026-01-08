// ============================================
// Type Definitions for Progress Bot
// ============================================

// Environment variables (from Cloudflare Workers)
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TODOIST_API_TOKEN: string;
}

// ============================================
// Database Models
// ============================================

export interface Task {
  id?: string;
  task_id: string;
  content: string;
  category?: string;
  priority?: number; // 1-4 (1 is highest in Todoist)
  description?: string;
  completed_at: Date;
  duration_minutes?: number;
  quantity?: number;
  quantity_unit?: string;
  is_origin?: boolean;
  origin_task?: string;
  status?: 'done' | 'failed' | 'partial';
  created_at?: Date;
}

export interface Streak {
  id?: string;
  task_name: string;
  current_streak: number;
  best_streak: number;
  last_completed_date?: Date;
  streak_type: 'daily' | 'weekly';
  weekly_pattern?: string; // e.g., "1,2,3,4,5" for Mon-Fri
  updated_at?: Date;
}

export interface DailyReport {
  id?: string;
  report_date: Date;
  report_markdown: string;
  success_rate?: number;
  total_tasks?: number;
  completed_tasks?: number;
  failed_tasks?: number;
  achievement_time_minutes?: number;
  challenge_evaluation?: string;
  ai_commentary?: string;
  suggested_reward?: string;
  weekly_goals_analysis?: string;
  user_comments?: string;
  obsidian_file_id?: string;
  created_at?: Date;
}

export interface WeeklyGoals {
  id?: string;
  week_start_date: Date;
  week_end_date: Date;
  goals_text: string;
  evaluation_text?: string;
  completion_rate?: number;
  created_at?: Date;
}

export interface DailyChallenge {
  id?: string;
  challenge_date: Date;
  challenge_text: string;
  result?: boolean; // null = not evaluated, true = success, false = failed
  created_at?: Date;
}

export interface Memory {
  id?: string;
  category: MemoryCategory;
  content?: string;
  last_updated?: Date;
  last_optimized?: Date;
}

export type MemoryCategory =
  | 'Personal Insights & Patterns'
  | 'Successful Strategies & What Works'
  | 'Triggers & Challenges'
  | 'Important Milestones & Breakthroughs'
  | 'Recurring Themes & Lessons'
  | 'Personal Information & Facts';

export interface Setting {
  key: string;
  value: string;
  updated_at?: Date;
}

export interface ConversationState {
  id?: string;
  chat_id: string;
  conversation_type: string;
  current_step: number;
  total_steps: number;
  data: {
    questions?: string[];
    answers?: Record<string, string>;
    reportContext?: any;
  };
  expires_at: Date | string;
  created_at?: Date | string;
}

// ============================================
// Todoist Webhook Types
// ============================================

export interface TodoistWebhookEvent {
  event_name: string; // e.g., "item:completed"
  event_data: TodoistEventData;
  user_id: number;
  initiator: {
    id: string;
    is_premium: boolean;
    image_id?: string;
    email: string;
    full_name: string;
  };
}

export interface TodoistEventData {
  id: string;
  user_id: number;
  project_id: string;
  content: string;
  description?: string;
  priority: number;
  due?: {
    date: string;
    is_recurring: boolean;
    string: string; // e.g., "every day", "every Mon, Wed, Fri"
  };
  labels?: string[];
  checked: boolean;
  parent_id?: string; // For subtasks
  completed_at?: string;
  added_at: string;
}

// ============================================
// Parsed Task Metadata
// ============================================

export interface ParsedTaskMetadata {
  duration_minutes?: number;
  quantity?: number;
  quantity_unit?: string;
  category?: string;
  is_origin?: boolean;
  origin_task?: string;
}

// ============================================
// Report Generation Types
// ============================================

export interface ReportData {
  date: string;
  tasks: Task[];
  streaks: Streak[];
  weeklyGoals: WeeklyGoals | null;
  dailyChallenge: DailyChallenge | null;
  memory: Record<string, string>;
  previousReports: DailyReport[];
  strategicGoals: string;
}

export interface ReportPreview {
  date: string;
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  total_time_minutes: number;
  success_rate: number;
  categories: { [key: string]: number };
  top_categories: Array<{ name: string; count: number; time?: number }>;
  streak_updates: Array<{ task: string; current: number; best: number }>;
  formatted_text: string;
}

// ============================================
// AI Response Types
// ============================================

export interface UnifiedAIResponse {
  questions: string[];
  main_commentary: string;
  challenge_evaluation: string; // ✅ or ❌
  reward: string;
  goals_analysis: {
    completed: string[];
    in_progress: string[];
    neglected: string[];
  };
  memory_updates: Map<MemoryCategory, string>;
  memory_optimization?: string; // Full optimized memory if needed
}

// ============================================
// Telegram Bot Types
// ============================================

export interface TelegramMessage {
  message_id: number;
  from: {
    id: number;
    first_name: string;
    username?: string;
  };
  chat: {
    id: number;
    type: string;
  };
  text?: string;
  date: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: any;
    message: TelegramMessage;
    data: string;
  };
}

// ============================================
// API Response Types
// ============================================

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface ErrorResponse {
  success: false;
  error: string;
  details?: any;
}

// ============================================
// Utility Types
// ============================================

export interface DateRange {
  start: Date;
  end: Date;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface RetryConfig {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier: number;
}

// ============================================
// Constants
// ============================================

export const TASK_STATUS = {
  DONE: 'done',
  FAILED: 'failed',
  PARTIAL: 'partial',
} as const;

export const STREAK_TYPE = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
} as const;

export const CONVERSATION_STATE_TYPE = {
  QA_FLOW: 'qa_flow',
  REPORT_CONFIRMATION: 'report_confirmation',
  MEMORY_CLEAR_CONFIRMATION: 'memory_clear_confirmation',
} as const;

export const TELEGRAM_THREAD = {
  ARABIC: '149',
  ENGLISH: '155',
  QURAN: '2053',
} as const;

// ============================================
// Type Guards
// ============================================

export function isTask(obj: any): obj is Task {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'task_id' in obj &&
    'content' in obj &&
    'completed_at' in obj
  );
}

export function isTodoistWebhookEvent(obj: any): obj is TodoistWebhookEvent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'event_name' in obj &&
    'event_data' in obj
  );
}

// ============================================
// Helper Type for Partial Updates
// ============================================

export type PartialTask = Partial<Task> & Pick<Task, 'task_id'>;
export type PartialStreak = Partial<Streak> & Pick<Streak, 'task_name'>;
