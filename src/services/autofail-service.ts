/**
 * Unified Auto-Fail Service
 *
 * Consolidates auto-fail logic from 3 triggers:
 * 1. Scheduled trigger (GitHub Actions workflow)
 * 2. Command trigger (/autofail command)
 * 3. Report-triggered (after report analysis)
 *
 * Configuration via settings table:
 * - autofail_enabled: 'true'/'false' to enable/disable
 * - autofail_time: Time in Egypt (HH:MM format, default: "23:00" = 11 PM)
 * - failure_priority_threshold: Priority threshold for tracking (2 = high priority)
 */

import { SupabaseClient } from '../database/client';
import { SettingsManager } from '../database/settings';
import { getTodayInEgypt } from '../utils/timezone';

// Types
export interface TodoistTask {
  id: string;
  content: string;
  priority: number;
  due?: { date: string; is_recurring?: boolean } | null;
  parent_id?: string | null;
  description?: string;
}

export interface AutoFailConfig {
  enabled: boolean;
  triggerHour: number; // Egypt time hour (0-23)
  triggerMinute: number; // Egypt time minute (0-59)
  priorityThreshold: number;
  todoistToken: string;
  todoistProjectId?: string;
  botToken: string;
  chatId: string;
}

export interface AutoFailResult {
  triggered: boolean;
  reason: string;
  taskCount?: number;
  highPriorityCount?: number;
  lowPriorityCount?: number;
}

export interface PreparedAutofailData {
  today: string;
  allTasks: TodoistTask[];
  highPriorityTasks: TodoistTask[];
  lowPriorityTasks: TodoistTask[];
  config: AutoFailConfig;
}

/**
 * Create the auto-fail service
 */
export function createAutofailService(db: SupabaseClient, settings: SettingsManager) {
  return new AutofailService(db, settings);
}

export class AutofailService {
  constructor(
    _db: SupabaseClient, // Reserved for future use (e.g., storing autofail history)
    private settings: SettingsManager
  ) {}

  /**
   * Get auto-fail configuration from settings
   */
  async getConfig(botToken: string, chatId: string): Promise<AutoFailConfig | null> {
    const [
      enabled,
      triggerTime,
      priorityThreshold,
      todoistToken,
      todoistProjectId,
    ] = await Promise.all([
      this.settings.get('autofail_enabled'),
      this.settings.get('autofail_hour'), // Format: "HH:MM" e.g. "23:30"
      this.settings.get('failure_priority_threshold'),
      this.settings.get('todoist_api_token'),
      this.settings.get('todoist_project_id'),
    ]);

    if (!todoistToken) {
      return null;
    }

    // Parse trigger time (format: "HH:MM", default "23:00" = 11 PM)
    let triggerHour = 23;
    let triggerMinute = 0;
    if (triggerTime) {
      const parts = triggerTime.split(':');
      triggerHour = parseInt(parts[0] || '23', 10);
      triggerMinute = parseInt(parts[1] || '0', 10);
    }

    return {
      enabled: enabled !== 'false', // Default to true if not set
      triggerHour,
      triggerMinute,
      priorityThreshold: priorityThreshold ? parseInt(priorityThreshold, 10) : 2,
      todoistToken: todoistToken.trim(),
      todoistProjectId: todoistProjectId?.trim(),
      botToken,
      chatId,
    };
  }

  /**
   * Check if auto-fail should trigger based on time
   */
  shouldTrigger(config: AutoFailConfig, forceRun: boolean = false): { should: boolean; reason: string } {
    if (!config.enabled && !forceRun) {
      return { should: false, reason: 'Auto-fail is disabled in settings' };
    }

    if (forceRun) {
      return { should: true, reason: 'Forced run via command' };
    }

    // Get Egypt time
    const egyptNow = new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' });
    const egyptDate = new Date(egyptNow);
    const egyptHour = egyptDate.getHours();
    const egyptMinute = egyptDate.getMinutes();

    // Compare current time with trigger time
    const currentTimeMinutes = egyptHour * 60 + egyptMinute;
    const triggerTimeMinutes = config.triggerHour * 60 + config.triggerMinute;

    const formatTime = (h: number, m: number) => `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    const currentTime = formatTime(egyptHour, egyptMinute);
    const triggerTime = formatTime(config.triggerHour, config.triggerMinute);

    // IMPORTANT: Do NOT trigger after midnight! That would fail tasks from the NEW day.
    // Only trigger on the same day as the scheduled time.
    if (egyptHour >= 0 && egyptHour < config.triggerHour && config.triggerHour >= 20) {
      // We're past midnight but before trigger hour (e.g., 00:24 when trigger is 23:30)
      // This means we're on the NEXT day - do not trigger!
      return { should: false, reason: `Current time (${currentTime}) is on next day, skipping to avoid failing new day's tasks` };
    }

    // Pre-trigger window: Allow triggering up to 30 minutes BEFORE the trigger time
    // This handles cron schedule variations (e.g., 23:24 is close enough to 23:30)
    const PRE_TRIGGER_WINDOW_MINUTES = 30;
    const timeDifference = triggerTimeMinutes - currentTimeMinutes;

    if (timeDifference > 0 && timeDifference <= PRE_TRIGGER_WINDOW_MINUTES) {
      return { should: true, reason: `Current time (${currentTime}) within ${timeDifference}min of trigger time (${triggerTime})` };
    }

    // Normal comparison (at or after trigger time)
    if (currentTimeMinutes >= triggerTimeMinutes) {
      return { should: true, reason: `Current time (${currentTime}) >= trigger time (${triggerTime})` };
    }

    return { should: false, reason: `Current time (${currentTime}) < trigger time (${triggerTime})` };
  }

  /**
   * Fetch tasks from Todoist
   */
  async fetchTodoistTasks(config: AutoFailConfig): Promise<TodoistTask[]> {
    let url = 'https://api.todoist.com/rest/v3/tasks';
    if (config.todoistProjectId) {
      url += `?project_id=${config.todoistProjectId}`;
    }

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${config.todoistToken}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch tasks from Todoist: ${response.status}`);
    }

    return await response.json() as TodoistTask[];
  }

  /**
   * Filter and categorize tasks for auto-fail
   */
  filterTasksForAutofail(
    allTasks: TodoistTask[],
    today: string,
    priorityThreshold: number
  ): { highPriority: TodoistTask[]; lowPriority: TodoistTask[] } {
    // Filter tasks due today or earlier (overdue)
    const tasksDueToday = allTasks.filter(task => {
      if (!task.due?.date) return false;
      const dueDate = task.due.date.split('T')[0];
      return dueDate && dueDate <= today;
    });

    // Split by priority
    // Todoist priority: 4 = highest, 1 = lowest
    // Our priority: 1 = highest (P1), 4 = lowest (P4)
    // Conversion: ourPriority = 5 - todoistPriority
    const highPriority = tasksDueToday.filter(task => {
      const ourPriority = 5 - (task.priority || 1);
      return ourPriority <= priorityThreshold;
    });

    const lowPriority = tasksDueToday.filter(task => {
      const ourPriority = 5 - (task.priority || 1);
      return ourPriority > priorityThreshold;
    });

    return { highPriority, lowPriority };
  }

  /**
   * Prepare auto-fail data (fetch and filter tasks)
   * This is the main entry point for all triggers
   */
  async prepareAutofail(
    botToken: string,
    chatId: string,
    forceRun: boolean = false
  ): Promise<PreparedAutofailData | AutoFailResult> {
    // Get config
    const config = await this.getConfig(botToken, chatId);
    if (!config) {
      return { triggered: false, reason: 'Todoist API token not configured' };
    }

    // Check if should trigger
    const triggerCheck = this.shouldTrigger(config, forceRun);
    if (!triggerCheck.should) {
      return { triggered: false, reason: triggerCheck.reason };
    }

    // Fetch tasks
    const allTasks = await this.fetchTodoistTasks(config);
    const today = getTodayInEgypt();

    // Filter tasks
    const { highPriority, lowPriority } = this.filterTasksForAutofail(
      allTasks,
      today,
      config.priorityThreshold
    );

    const allTasksToProcess = [...highPriority, ...lowPriority];

    if (allTasksToProcess.length === 0) {
      return {
        triggered: true,
        reason: 'No tasks to auto-fail',
        taskCount: 0,
        highPriorityCount: 0,
        lowPriorityCount: 0,
      };
    }

    return {
      today,
      allTasks: allTasksToProcess,
      highPriorityTasks: highPriority,
      lowPriorityTasks: lowPriority,
      config,
    };
  }

  /**
   * Build the init-queue payload for Durable Object
   */
  buildQueuePayload(data: PreparedAutofailData): object {
    return {
      today: data.today,
      taskIds: data.allTasks.map(t => t.id),
      tasks: data.allTasks,
      metadata: {
        chatId: data.config.chatId,
        todoistToken: data.config.todoistToken,
        botToken: data.config.botToken,
        totalTasks: data.allTasks.length,
        priorityThreshold: data.config.priorityThreshold,
        highPriorityIds: data.highPriorityTasks.map(t => t.id),
      },
    };
  }

  /**
   * Get the Durable Object job ID for today
   */
  getJobId(today?: string): string {
    return `autofail_${today || getTodayInEgypt()}`;
  }

  /**
   * Check if auto-fail is already running for today
   */
  async isAlreadyRunning(
    stub: { fetch: (request: Request) => Promise<Response> },
    today: string
  ): Promise<boolean> {
    const response = await stub.fetch(new Request('https://fake-host/autofail/check-queue', {
      method: 'POST',
      body: JSON.stringify({ today }),
    }));
    const data = await response.json() as { exists: boolean };
    return data.exists;
  }

  /**
   * Initialize the auto-fail queue in Durable Object
   */
  async initializeQueue(
    stub: { fetch: (request: Request) => Promise<Response> },
    data: PreparedAutofailData
  ): Promise<void> {
    const payload = this.buildQueuePayload(data);
    await stub.fetch(new Request('https://fake-host/autofail/init-queue', {
      method: 'POST',
      body: JSON.stringify(payload),
    }));
  }

  /**
   * Process auto-fail batches until complete
   * @deprecated Use startAlarmProcessing instead - this can timeout on large task counts
   */
  async processUntilComplete(
    stub: { fetch: (request: Request) => Promise<Response> }
  ): Promise<void> {
    while (true) {
      const result = await stub.fetch(new Request('https://fake-host/autofail/process-batch', {
        method: 'POST',
      }));
      const data = await result.json() as { complete: boolean };
      if (data.complete) break;
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  /**
   * Start alarm-based processing (recommended)
   * Uses Durable Object alarms for reliable processing without timeout limits
   */
  async startAlarmProcessing(
    stub: { fetch: (request: Request) => Promise<Response> },
    today: string
  ): Promise<void> {
    await stub.fetch(new Request('https://fake-host/autofail/start-alarm', {
      method: 'POST',
      body: JSON.stringify({ today }),
    }));
  }

  /**
   * Full auto-fail execution (used by command and report triggers)
   * Returns result message for user notification
   */
  async executeAutofail(
    stub: { fetch: (request: Request) => Promise<Response> },
    botToken: string,
    chatId: string,
    forceRun: boolean = false
  ): Promise<{ success: boolean; message: string }> {
    // Prepare data
    const result = await this.prepareAutofail(botToken, chatId, forceRun);

    // Check if it's a result (not triggered or no tasks)
    if ('triggered' in result) {
      if (!result.triggered) {
        return { success: false, message: `⏭️ ${result.reason}` };
      }
      if (result.taskCount === 0) {
        return { success: true, message: '✅ No tasks to auto-fail!' };
      }
    }

    const data = result as PreparedAutofailData;

    // Check if already running
    const alreadyRunning = await this.isAlreadyRunning(stub, data.today);
    if (alreadyRunning) {
      return { success: false, message: '⏭️ Auto-fail already running for today' };
    }

    // Initialize queue
    await this.initializeQueue(stub, data);

    return {
      success: true,
      message: `✅ Processing started!\n\n📋 ${data.allTasks.length} tasks (${data.highPriorityTasks.length} tracked)\n\nProgress updates every 20 tasks.`,
    };
  }
}
