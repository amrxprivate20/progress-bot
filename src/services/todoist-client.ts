/**
 * Todoist API Client Service
 *
 * Handles:
 * - Creating tasks in Todoist
 * - Setting priorities and due dates
 * - Rate limiting (450 requests per 15 minutes)
 * - AI-powered task generation from goals
 */

import { SupabaseClient } from '../database/client';
import { SettingsManager } from '../database/settings';
import { AIClient, AIMessage } from './ai-client';
import { createGoalsManager } from './goals-manager';
import { retryWithBackoff, ExternalAPIError } from '../utils/errors';

// ============================================
// Types
// ============================================

export interface TodoistTask {
  content: string;
  description?: string;
  due_string?: string;  // e.g., "tomorrow", "every day", "2026-01-20"
  due_date?: string;    // YYYY-MM-DD format
  priority?: number;    // 1 (lowest) to 4 (highest) - Todoist's priority
  project_id?: string;
  labels?: string[];
}

export interface TodoistTaskResponse {
  id: string;
  content: string;
  description: string;
  is_completed: boolean;
  priority: number;
  due?: {
    date: string;
    is_recurring: boolean;
    string: string;
  };
  project_id: string;
  created_at: string;
}

export interface TaskCreationResult {
  success: boolean;
  createdTasks?: TodoistTaskResponse[];
  error?: string;
}

export interface GeneratedTask {
  content: string;
  description?: string;
  dueDate: string;
  priority: number;
  category?: string;
}

// ============================================
// Todoist Client
// ============================================

export class TodoistClient {
  private baseUrl = 'https://api.todoist.com/rest/v3';
  private rateLimitRemaining = 450;
  private rateLimitReset: Date | null = null;

  constructor(
    private apiToken: string,
    private projectId: string,
    private useInbox: boolean = false  // If true, tasks go to Inbox (no project_id)
  ) {}

  /**
   * Create a single task in Todoist
   */
  async createTask(task: TodoistTask): Promise<TodoistTaskResponse> {
    await this.checkRateLimit();

    return retryWithBackoff(
      async () => {
        const response = await fetch(`${this.baseUrl}/tasks`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...task,
            // If useInbox is true, don't set project_id (goes to Inbox)
            project_id: this.useInbox ? undefined : (task.project_id || this.projectId),
          }),
        });

        // Update rate limit info
        this.updateRateLimitFromResponse(response);

        const responseText = await response.text();

        if (!response.ok) {
          throw new ExternalAPIError(
            `Todoist API error: ${response.status} ${responseText}`,
            'todoist'
          );
        }

        return JSON.parse(responseText);
      },
      { maxAttempts: 3, initialDelayMs: 500 }
    );
  }

  /**
   * Create multiple tasks in Todoist
   */
  async createTasks(tasks: TodoistTask[]): Promise<TodoistTaskResponse[]> {
    const results: TodoistTaskResponse[] = [];

    for (const task of tasks) {
      try {
        const result = await this.createTask(task);
        results.push(result);
        // Small delay between tasks to be nice to the API
        await this.delay(200);
      } catch (error) {
        console.error('Error creating task:', task.content, error);
        // Continue with other tasks even if one fails
      }
    }

    return results;
  }

  /**
   * Check and wait for rate limit if needed
   */
  private async checkRateLimit(): Promise<void> {
    if (this.rateLimitRemaining <= 5) {
      if (this.rateLimitReset && this.rateLimitReset > new Date()) {
        const waitTime = this.rateLimitReset.getTime() - Date.now();
        console.log(`Rate limit approaching, waiting ${waitTime}ms`);
        await this.delay(waitTime);
      }
    }
  }

  /**
   * Update rate limit info from response headers
   */
  private updateRateLimitFromResponse(response: Response): void {
    const remaining = response.headers.get('X-Ratelimit-Remaining');
    const reset = response.headers.get('X-Ratelimit-Reset');

    if (remaining) {
      this.rateLimitRemaining = parseInt(remaining, 10);
    }
    if (reset) {
      this.rateLimitReset = new Date(parseInt(reset, 10) * 1000);
    }
  }

  /**
   * Helper delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================
// Task Generator Service
// ============================================

export class TaskGeneratorService {
  constructor(
    private db: SupabaseClient,
    private settings: SettingsManager,
    private aiClient: AIClient
  ) {}

  /**
   * Generate and create tasks from current week's goals
   */
  async generateAndCreateTasks(): Promise<TaskCreationResult> {
    try {
      // Get Todoist credentials
      const apiToken = await this.settings.get('todoist_api_token');
      const projectId = await this.settings.get('todoist_project_id');

      if (!apiToken || !projectId) {
        return {
          success: false,
          error: 'Todoist credentials not configured',
        };
      }

      // Get current week's goals
      const goalsMgr = createGoalsManager(this.db, this.settings, this.aiClient);
      const weeklyGoals = await goalsMgr.getCurrentWeekGoals();
      const todayChallenge = await goalsMgr.getTodayChallenge();

      if (!weeklyGoals) {
        return {
          success: false,
          error: 'لا توجد أهداف أسبوعية. استخدم /generate_goals أولاً',
        };
      }

      // Generate tasks using AI
      const generatedTasks = await this.generateTasksWithAI(
        weeklyGoals.goals_text,
        todayChallenge?.challenge_text
      );

      if (generatedTasks.length === 0) {
        return {
          success: false,
          error: 'لم يتم توليد أي مهام',
        };
      }

      // Create tasks in Todoist (use Inbox for reminder-style tasks)
      const todoistClient = new TodoistClient(apiToken.trim(), projectId.trim(), true);

      const todoistTasks: TodoistTask[] = generatedTasks.map(task => ({
        content: task.content,
        description: task.description,
        due_date: task.dueDate,
        priority: task.priority,
        labels: task.category ? [task.category] : undefined,
      }));

      const createdTasks = await todoistClient.createTasks(todoistTasks);

      return {
        success: true,
        createdTasks,
      };
    } catch (error) {
      console.error('Error in generateAndCreateTasks:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Generate tasks using AI based on goals
   */
  private async generateTasksWithAI(
    goalsText: string,
    dailyChallenge?: string
  ): Promise<GeneratedTask[]> {
    // Get remaining days of current week (Sat-Fri week)
    const remainingDays = this.getRemainingWeekDays();
    const today = remainingDays[0]?.date || new Date().toISOString().split('T')[0];

    // Build the days list for AI
    const daysListArabic = remainingDays.map(d => `- ${d.dayName}: ${d.date}`).join('\n');

    // Calculate minimum tasks (at least 2 per day)
    const minTasks = Math.max(8, remainingDays.length * 2);

    // Build explicit date list for clarity
    const validDates = remainingDays.map(d => d.date);
    const datesList = validDates.join(', ');

    const prompt = `
# توليد مهام من الأهداف الأسبوعية

## الأهداف الأسبوعية:
${goalsText}

## تحدي اليوم:
${dailyChallenge || 'لا يوجد'}

## تاريخ اليوم: ${today}

## ⚠️ الأيام المتاحة للمهام (هام جداً):

التواريخ المسموح بها فقط:
${daysListArabic}

📅 **التواريخ بصيغة YYYY-MM-DD المسموحة:**
${datesList}

❌ **لا تستخدم أي تاريخ خارج هذه القائمة!**

---

# المطلوب:

قم بتحويل الأهداف الأسبوعية إلى مهام محددة وقابلة للتنفيذ.
اكتب ${minTasks} مهمة على الأقل (${remainingDays.length} أيام × 2 مهمة لكل يوم كحد أدنى).

**قواعد إلزامية:**
1. يجب أن يكون حقل DUE أحد التواريخ التالية فقط: ${datesList}
2. وزع المهام بالتساوي على الأيام المتاحة
3. لا تستخدم "tomorrow" أو "today" - استخدم التاريخ الفعلي

اكتب كل مهمة بهذا الشكل بالضبط:

TASK: [اسم المهمة بالعربي]
DESCRIPTION: [وصف قصير للمهمة - اختياري]
DUE: [تاريخ من القائمة: ${datesList}]
PRIORITY: [1-4، حيث 4 أعلى أولوية]
CATEGORY: [فئة المهمة: عمل، صحة، تعلم، شخصي]

---

TASK: [المهمة التالية]
...

ملاحظات:
- اجعل المهام محددة وقابلة للقياس
- وزع المهام على الأيام المتبقية بشكل متوازن
- ضع الأولوية الأعلى (4) للمهام الأكثر أهمية
- إذا كان هناك تحدي يومي، أضف مهمة له بتاريخ اليوم (${today})
`;

    const messages: AIMessage[] = [
      {
        role: 'system',
        content: 'أنت خبير في تحويل الأهداف إلى مهام عملية قابلة للتنفيذ.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    const response = await this.aiClient.complete(messages, 0.6, 2000);

    return this.parseGeneratedTasks(response);
  }

  /**
   * Parse AI response to extract tasks
   */
  private parseGeneratedTasks(response: string): GeneratedTask[] {
    const tasks: GeneratedTask[] = [];

    // Reset distribution index for even spreading of tasks with invalid dates
    this.taskDistributionIndex = 0;

    // Split by TASK: marker
    const taskBlocks = response.split(/(?=TASK:)/i).filter(block => block.trim());

    for (const block of taskBlocks) {
      const task = this.parseTaskBlock(block);
      if (task) {
        tasks.push(task);
      }
    }

    return tasks;
  }

  /**
   * Get remaining days of current week (Saturday-Friday)
   * Returns array of { date: YYYY-MM-DD, dayName: Arabic day name }
   */
  private getRemainingWeekDays(): Array<{ date: string; dayName: string }> {
    const arabicDays = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    // Get today in Egypt timezone (UTC+2)
    const now = new Date();
    const egyptOffset = 2 * 60; // UTC+2 in minutes
    const localOffset = now.getTimezoneOffset();
    const egyptTime = new Date(now.getTime() + (egyptOffset + localOffset) * 60000);

    const today = new Date(egyptTime);
    today.setHours(0, 0, 0, 0);

    const dayOfWeek = today.getDay(); // 0 = Sunday, 6 = Saturday

    // Calculate days until Friday (end of week)
    // If today is Saturday (6), we have 7 days (Sat to Fri)
    // If today is Sunday (0), we have 6 days (Sun to Fri)
    // If today is Friday (5), we have 1 day (just Fri)
    const daysUntilFriday = dayOfWeek === 6 ? 6 : (5 - dayOfWeek + 7) % 7;

    const remainingDays: Array<{ date: string; dayName: string }> = [];

    for (let i = 0; i <= daysUntilFriday; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);

      const dateStr = date.toISOString().split('T')[0] || '';
      const dayName = arabicDays[date.getDay()] || '';

      remainingDays.push({ date: dateStr, dayName });
    }

    return remainingDays;
  }

  // Track task distribution for even spreading
  private taskDistributionIndex = 0;

  /**
   * Parse a single task block
   */
  private parseTaskBlock(block: string): GeneratedTask | null {
    const lines = block.split('\n');

    let content = '';
    let description = '';
    let dueDate = '';
    let priority = 2;
    let category = '';

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine.startsWith('TASK:')) {
        content = trimmedLine.replace('TASK:', '').trim();
      } else if (trimmedLine.startsWith('DESCRIPTION:')) {
        description = trimmedLine.replace('DESCRIPTION:', '').trim();
      } else if (trimmedLine.startsWith('DUE:')) {
        dueDate = trimmedLine.replace('DUE:', '').trim();
      } else if (trimmedLine.startsWith('PRIORITY:')) {
        const p = parseInt(trimmedLine.replace('PRIORITY:', '').trim(), 10);
        if (p >= 1 && p <= 4) {
          priority = p;
        }
      } else if (trimmedLine.startsWith('CATEGORY:')) {
        category = trimmedLine.replace('CATEGORY:', '').trim();
      }
    }

    if (!content) {
      return null;
    }

    // Get valid dates for this week
    const remainingDays = this.getRemainingWeekDays();
    const validDates = remainingDays.map(d => d.date);

    // Validate and format due date - must be within current week
    if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !validDates.includes(dueDate)) {
      // Use round-robin distribution instead of random for even spreading
      const distributionIndex = this.taskDistributionIndex % validDates.length;
      dueDate = validDates[distributionIndex] || validDates[0] || '';
      this.taskDistributionIndex++;
      console.log(`⚠️ Task "${content}" had invalid date, assigned to ${dueDate}`);
    }

    return {
      content,
      description: description || undefined,
      dueDate,
      priority,
      category: category || undefined,
    };
  }

  /**
   * Reset distribution index (call before generating new batch)
   */
  resetDistributionIndex(): void {
    this.taskDistributionIndex = 0;
  }
}

// ============================================
// Factory Functions
// ============================================

export function createTaskGeneratorService(
  db: SupabaseClient,
  settings: SettingsManager,
  aiClient: AIClient
): TaskGeneratorService {
  return new TaskGeneratorService(db, settings, aiClient);
}
