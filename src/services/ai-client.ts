/**
 * AI Client with Anthropic/OpenRouter Support
 *
 * Supports:
 * - Anthropic API (Claude Pro) as primary
 * - OpenRouter API as fallback
 * - Automatic failover when primary fails
 */

import { ExternalAPIError, retryWithBackoff } from '../utils/errors';

// ============================================
// Types
// ============================================

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AICompletionRequest {
  model: string;
  messages: AIMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
}

export interface AICompletionResponse {
  id: string;
  model: string;
  choices: {
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface UnifiedAIResponse {
  questions: string[];
  mainCommentary: string;
  challengeEvaluation: string; // "✅" or "❌"
  reward: string;
  goalsAnalysis: {
    completed: string[];
    inProgress: string[];
    neglected: string[];
  };
  memoryUpdates: Record<string, string>; // category -> new content
  memoryOptimization?: string; // full optimized memory if needed
}

// ============================================
// AI Client
// ============================================

export class AIClient {
  private apiKey: string;
  private baseUrl = 'https://openrouter.ai/api/v1';
  private model: string;

  // NEW
constructor(apiKey: string, model: string = 'anthropic/claude-sonnet-4') {
  // Trim whitespace and validate API key format
  this.apiKey = apiKey.trim();
  
  if (!this.apiKey.startsWith('sk-or-v1-')) {
    throw new Error('Invalid OpenRouter API key format. Key must start with "sk-or-v1-"');
  }
  
  this.model = model;
}

  /**
   * Send a completion request to OpenRouter API
   */
  async complete(
    messages: AIMessage[],
    temperature: number = 0.7,
    maxTokens: number = 4000
  ): Promise<string> {
    const request: AICompletionRequest = {
      model: this.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      top_p: 1,
    };

    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://progress-bot.workers.dev',
            'X-Title': 'Progress Bot',
          },
          body: JSON.stringify(request),
        });

        if (!res.ok) {
          const error = await res.text();
          throw new ExternalAPIError(
            `OpenRouter API error: ${res.status} - ${error}`,
            'openrouter'
          );
        }

        return res.json() as Promise<AICompletionResponse>;
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
      }
    );

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new ExternalAPIError('Empty response from OpenRouter', 'openrouter');
    }

    return content;
  }

  /**
   * Generate daily report analysis with unified prompt
   */
  async generateDailyReport(context: {
    reportDate: string;
    tasks: any[];
    streaks: any[];
    weeklyGoals: string | null;
    dailyChallenge: string | null;
    memory: Record<string, string>;
    pastWeekSummary: string;
    strategicGoals: string;
    userAnswers?: Record<string, string>; // If Q&A was done
  }): Promise<UnifiedAIResponse> {
    const prompt = this.buildUnifiedPrompt(context);

    const messages: AIMessage[] = [
      {
        role: 'system',
        content: 'أنت مساعد ذكي متخصص في تحليل التقدم الشخصي والإنتاجية. تتحدث باللهجة المصرية بشكل طبيعي ومحفز.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    const response = await this.complete(messages, 0.7, 6000);
    return this.parseUnifiedResponse(response);
  }

  /**
   * Optimize memory content
   */
  async optimizeMemory(
    category: string,
    currentContent: string,
    recentInsights: string[]
  ): Promise<string> {
    const prompt = `
# تحسين الذاكرة المنظمة

## الفئة: ${category}

## المحتوى الحالي:
${currentContent}

## رؤى حديثة للدمج:
${recentInsights.map((insight, i) => `${i + 1}. ${insight}`).join('\n')}

## المهمة:
قم بتحسين وتنظيم محتوى هذه الفئة من الذاكرة:
1. ادمج الرؤى الجديدة مع المحتوى الموجود
2. احذف التكرارات والمعلومات المتشابهة جداً
3. رتب المعلومات من الأهم للأقل أهمية
4. اجعل الصياغة موجزة وواضحة
5. احتفظ بالمعلومات القيمة فقط

أعد المحتوى المحسن بدون مقدمات، فقط المحتوى المنظم النهائي.
`;

    const messages: AIMessage[] = [
      {
        role: 'system',
        content: 'أنت خبير في تنظيم وتحسين المعلومات الشخصية.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    return await this.complete(messages, 0.5, 3000);
  }

  /**
   * Generate clarifying questions (if needed)
   */
  async generateQuestions(context: {
    tasks: any[];
    weeklyGoals: string | null;
    dailyChallenge: string | null;
  }): Promise<string[]> {
    const prompt = `
# توليد أسئلة توضيحية

بناءً على المهام التالية لليوم:

## المهام المنجزة:
${context.tasks.map(t => `- ${t.content}`).join('\n')}

## الأهداف الأسبوعية:
${context.weeklyGoals || 'لا توجد أهداف محددة'}

## التحدي اليومي:
${context.dailyChallenge || 'لا يوجد تحدي'}

## المهمة:
اطرح 1-3 أسئلة توضيحية قصيرة ومباشرة لفهم التجربة اليومية بشكل أفضل.
الأسئلة يجب أن تكون:
- قصيرة (سطر واحد لكل سؤال)
- محددة وسهلة الإجابة
- تساعد في فهم السياق والمشاعر والتحديات

اكتب كل سؤال في سطر منفصل يبدأ بـ "Q: "

مثال:
Q: كيف كان شعورك خلال العمل على المشروع الكبير؟
Q: ما التحدي الرئيسي اللي واجهته النهاردة؟
`;

    const messages: AIMessage[] = [
      {
        role: 'system',
        content: 'أنت خبير في طرح أسئلة توضيحية مفيدة.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    const response = await this.complete(messages, 0.8, 500);

    // Parse questions from response
    const questions = response
      .split('\n')
      .filter(line => line.trim().startsWith('Q:'))
      .map(line => line.replace(/^Q:\s*/, '').trim())
      .filter(q => q.length > 0);

    return questions;
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Build the unified prompt for daily report analysis
   */
  private buildUnifiedPrompt(context: {
    reportDate: string;
    tasks: any[];
    streaks: any[];
    weeklyGoals: string | null;
    dailyChallenge: string | null;
    memory: Record<string, string>;
    pastWeekSummary: string;
    strategicGoals: string;
    userAnswers?: Record<string, string>;
  }): string {
    const {
      reportDate,
      tasks,
      streaks,
      weeklyGoals,
      dailyChallenge,
      memory,
      pastWeekSummary,
      strategicGoals,
      userAnswers,
    } = context;

    // Separate completed and failed tasks
    const completedTasks = tasks.filter(t => t.status === 'done');
    const failedTasks = tasks.filter(t => t.status === 'failed');

    // Calculate statistics
    const totalTasks = tasks.length;
    const completedCount = completedTasks.length;
    const successRate = totalTasks > 0 ? (completedCount / totalTasks) * 100 : 0;
    const totalMinutes = completedTasks.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);

    const prompt = `
# تحليل التقدم اليومي - ${reportDate}

${userAnswers ? `## إجابات المستخدم:\n${Object.entries(userAnswers).map(([q, a]) => `**س:** ${q}\n**ج:** ${a}`).join('\n\n')}\n` : ''}

## الإحصائيات:
- إجمالي المهام: ${totalTasks}
- المنجزة: ${completedCount}
- الفاشلة: ${failedTasks.length}
- معدل النجاح: ${successRate.toFixed(1)}%
- الوقت الإجمالي: ${totalMinutes} دقيقة (${(totalMinutes / 60).toFixed(1)} ساعة)

## المهام المنجزة:
${completedTasks.map(t => {
  const streakInfo = streaks.find(s => s.task_name === t.content);
  const streakText = streakInfo ? ` [🔥 ${streakInfo.current_streak} يوم]` : '';
  const durationText = t.duration_minutes ? ` [⏱️ ${t.duration_minutes}د]` : '';
  const quantityText = t.quantity ? ` [📊 ${t.quantity} ${t.quantity_unit || ''}]` : '';
  return `- ${t.content}${streakText}${durationText}${quantityText}`;
}).join('\n')}

${failedTasks.length > 0 ? `## المهام الفاشلة:\n${failedTasks.map(t => `- ${t.content}`).join('\n')}` : ''}

## التحدي اليومي:
${dailyChallenge || 'لا يوجد تحدي محدد لهذا اليوم'}

## الأهداف الأسبوعية:
${weeklyGoals || 'لا توجد أهداف محددة لهذا الأسبوع'}

## ملخص الأسبوع الماضي:
${pastWeekSummary}

## الأهداف الاستراتيجية طويلة المدى:
${strategicGoals}

## الذاكرة المنظمة:
${Object.entries(memory).map(([category, content]) => `### ${category}\n${content || 'لا توجد معلومات'}`).join('\n\n')}

---

# المطلوب منك:

قدم تحليلاً شاملاً ومحفزاً بناءً على كل المعلومات أعلاه. اتبع هذا الهيكل بدقة:

## [QUESTIONS]
(اطرح 1-3 أسئلة توضيحية قصيرة ومباشرة إذا كنت تحتاج معلومات إضافية لفهم السياق بشكل أفضل. كل سؤال في سطر منفصل يبدأ بـ "Q:")
Q: [سؤالك هنا]

## [COMMENTARY]
(تعليق شامل ومحفز باللهجة المصرية، يشمل:
- تحليل الأداء اليوم
- ملاحظات على الأنماط والتحسينات
- تشجيع وتحفيز شخصي
- نصائح عملية للتطوير
- ربط الإنجازات بالأهداف طويلة المدى

اكتب بطريقة طبيعية ودافئة، كأنك صديق مقرب يعرفك جيداً.)

## [CHALLENGE_EVAL]
(تقييم التحدي اليومي:
✅ إذا تم إنجازه
❌ إذا لم يتم إنجازه
فقط رمز واحد بدون تفسير)

## [REWARD]
(اقترح مكافأة مناسبة لإنجازات اليوم - شيء عملي وممتع، جملة واحدة قصيرة)

## [GOALS_ANALYSIS]
تحليل الأهداف الأسبوعية (استخدم هذا الشكل بالضبط):

### منجزة ✅
- [اذكر الأهداف المنجزة أو اكتب "لا يوجد"]

### قيد التنفيذ 🔄
- [اذكر الأهداف قيد التنفيذ أو اكتب "لا يوجد"]

### مهملة ⚠️
- [اذكر الأهداف المهملة أو اكتب "لا يوجد"]

## [MEMORY_UPDATES]
(إذا كانت هناك رؤى جديدة أو معلومات مهمة يجب تحديثها في الذاكرة، اذكرها بهذا الشكل:
CATEGORY: [اسم الفئة بالضبط كما هو أعلاه]
CONTENT: [المعلومة الجديدة]

إذا لم تكن هناك معلومات جديدة، اكتب: "لا توجد تحديثات")

## [MEMORY_OPTIMIZATION]
(إذا كانت الذاكرة بحاجة لتحسين وإعادة تنظيم (كبيرة جداً أو غير منظمة)، اكتب "OPTIMIZE_NEEDED"، وإلا اكتب "NOT_NEEDED")

---

تذكر: كن صادقاً ومحفزاً، واستخدم اللهجة المصرية بطبيعية، وركز على التطوير المستمر.
`;

    return prompt;
  }

  /**
   * Parse the unified AI response
   */
  private parseUnifiedResponse(response: string): UnifiedAIResponse {
    const result: UnifiedAIResponse = {
      questions: [],
      mainCommentary: '',
      challengeEvaluation: '❌',
      reward: '',
      goalsAnalysis: {
        completed: [],
        inProgress: [],
        neglected: [],
      },
      memoryUpdates: {},
    };

    // Extract questions
    const questionsMatch = response.match(/\[QUESTIONS\]([\s\S]*?)(?:\[|$)/i);
    if (questionsMatch && questionsMatch[1]) {
      const questionsText = questionsMatch[1];
      result.questions = questionsText
        .split('\n')
        .filter(line => line.trim().startsWith('Q:'))
        .map(line => line.replace(/^Q:\s*/, '').trim())
        .filter(q => q.length > 0);
    }

    // Extract commentary
    const commentaryMatch = response.match(/\[COMMENTARY\]([\s\S]*?)(?:\[|$)/i);
    if (commentaryMatch && commentaryMatch[1]) {
      result.mainCommentary = commentaryMatch[1].trim();
    }

    // Extract challenge evaluation
    const challengeMatch = response.match(/\[CHALLENGE_EVAL\]([\s\S]*?)(?:\[|$)/i);
    if (challengeMatch && challengeMatch[1]) {
      const evalText = challengeMatch[1].trim();
      result.challengeEvaluation = evalText.includes('✅') ? '✅' : '❌';
    }

    // Extract reward
    const rewardMatch = response.match(/\[REWARD\]([\s\S]*?)(?:\[|$)/i);
    if (rewardMatch && rewardMatch[1]) {
      result.reward = rewardMatch[1].trim();
    }

    // AFTER (CORRECT - more flexible parsing):
// Extract goals analysis
const goalsMatch = response.match(/\[GOALS_ANALYSIS\]([\s\S]*?)(?:\[|$)/i);
if (goalsMatch && goalsMatch[1]) {
  const goalsText = goalsMatch[1];

  console.log('📊 Parsing goals from:', goalsText.substring(0, 200));

  // Parse completed goals - more flexible patterns
  const completedPatterns = [
    /###\s*منجزة\s*✅([\s\S]*?)(?:###|$)/i,
    /###\s*منجزة([\s\S]*?)(?:###|$)/i,
    /منجزة\s*✅([\s\S]*?)(?:###|قيد التنفيذ|مهملة|$)/i,
  ];
  
  for (const pattern of completedPatterns) {
    const match = goalsText.match(pattern);
    if (match && match[1]) {
      result.goalsAnalysis.completed = this.parseListItems(match[1]);
      console.log('✅ Completed goals:', result.goalsAnalysis.completed);
      break;
    }
  }

  // Parse in-progress goals
  const inProgressPatterns = [
    /###\s*قيد التنفيذ\s*🔄([\s\S]*?)(?:###|$)/i,
    /###\s*قيد التنفيذ([\s\S]*?)(?:###|$)/i,
    /قيد التنفيذ\s*🔄([\s\S]*?)(?:###|منجزة|مهملة|$)/i,
  ];
  
  for (const pattern of inProgressPatterns) {
    const match = goalsText.match(pattern);
    if (match && match[1]) {
      result.goalsAnalysis.inProgress = this.parseListItems(match[1]);
      console.log('🔄 In-progress goals:', result.goalsAnalysis.inProgress);
      break;
    }
  }

  // Parse neglected goals
  const neglectedPatterns = [
    /###\s*مهملة\s*⚠️([\s\S]*?)(?:###|$)/i,
    /###\s*مهملة([\s\S]*?)(?:###|$)/i,
    /مهملة\s*⚠️([\s\S]*?)(?:###|منجزة|قيد التنفيذ|$)/i,
  ];
  
  for (const pattern of neglectedPatterns) {
    const match = goalsText.match(pattern);
    if (match && match[1]) {
      result.goalsAnalysis.neglected = this.parseListItems(match[1]);
      console.log('⚠️ Neglected goals:', result.goalsAnalysis.neglected);
      break;
    }
  }
}

    // Extract memory updates
    const memoryUpdatesMatch = response.match(/\[MEMORY_UPDATES\]([\s\S]*?)(?:\[|$)/i);
    if (memoryUpdatesMatch && memoryUpdatesMatch[1]) {
      const memoryText = memoryUpdatesMatch[1];
      if (!memoryText.includes('لا توجد تحديثات')) {
        const categoryMatches = memoryText.matchAll(/CATEGORY:\s*([^\n]+)\s*CONTENT:\s*([^\n]+)/gi);
        for (const match of categoryMatches) {
          if (match[1] && match[2]) {
            const category = match[1].trim();
            const content = match[2].trim();
            result.memoryUpdates[category] = content;
          }
        }
      }
    }

    // Extract memory optimization flag
    const memoryOptMatch = response.match(/\[MEMORY_OPTIMIZATION\]([\s\S]*?)(?:\[|$)/i);
    if (memoryOptMatch && memoryOptMatch[1]) {
      const optText = memoryOptMatch[1].trim();
      if (optText.includes('OPTIMIZE_NEEDED')) {
        result.memoryOptimization = 'OPTIMIZE_NEEDED';
      }
    }

    return result;
  }

  /**
   * Parse list items from text
   */
  private parseListItems(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('-') || line.match(/^\d+\./)) // Accept - or 1. 2. etc
    .map(line => line.replace(/^[-\d.]+\s*/, '').trim()) // Remove markers
    .filter(item => {
      // Remove empty, "لا يوجد", "no", "none", etc.
      const lower = item.toLowerCase();
      return item.length > 0 && 
             !lower.includes('لا يوجد') && 
             !lower.includes('no ') &&
             !lower.includes('none');
    });
}
}

// ============================================
// Anthropic API Client
// ============================================

export class AnthropicClient {
  private apiKey: string;
  private baseUrl = 'https://api.anthropic.com/v1';
  private model: string;

  constructor(apiKey: string, model: string = 'claude-sonnet-4-20250514') {
    this.apiKey = apiKey.trim();

    if (!this.apiKey.startsWith('sk-ant-')) {
      throw new Error('Invalid Anthropic API key format. Key must start with "sk-ant-"');
    }

    this.model = model;
  }

  /**
   * Send a completion request to Anthropic API
   */
  async complete(
    messages: AIMessage[],
    temperature: number = 0.7,
    maxTokens: number = 4000
  ): Promise<string> {
    // Anthropic uses a different message format - extract system message
    const systemMessage = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    const request = {
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      system: systemMessage?.content || '',
      messages: otherMessages.map(m => ({
        role: m.role,
        content: m.content,
      })),
    };

    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(`${this.baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });

        if (!res.ok) {
          const error = await res.text();
          throw new ExternalAPIError(
            `Anthropic API error: ${res.status} - ${error}`,
            'anthropic'
          );
        }

        return res.json() as Promise<{
          content: Array<{ type: string; text: string }>;
          usage: { input_tokens: number; output_tokens: number };
        }>;
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
      }
    );

    const content = response.content[0]?.text;
    if (!content) {
      throw new ExternalAPIError('Empty response from Anthropic', 'anthropic');
    }

    return content;
  }
}

// ============================================
// Unified AI Client (Anthropic + OpenRouter Fallback)
// ============================================

export interface AIClientConfig {
  anthropicApiKey?: string;
  openRouterApiKey?: string;
  anthropicModel?: string;
  openRouterModel?: string;
  useAnthropicPrimary?: boolean; // Default true, set false to use OpenRouter only
}

export class UnifiedAIClient {
  private anthropicClient?: AnthropicClient;
  private openRouterClient?: AIClient;
  private useAnthropicPrimary: boolean;

  constructor(config: AIClientConfig) {
    this.useAnthropicPrimary = config.useAnthropicPrimary !== false;

    // Initialize Anthropic client if key provided
    if (config.anthropicApiKey && config.anthropicApiKey.startsWith('sk-ant-')) {
      try {
        this.anthropicClient = new AnthropicClient(
          config.anthropicApiKey,
          config.anthropicModel
        );
        console.log('Anthropic client initialized');
      } catch (error) {
        console.error('Failed to initialize Anthropic client:', error);
      }
    }

    // Initialize OpenRouter client if key provided
    if (config.openRouterApiKey && config.openRouterApiKey.startsWith('sk-or-')) {
      try {
        this.openRouterClient = new AIClient(
          config.openRouterApiKey,
          config.openRouterModel
        );
        console.log('OpenRouter client initialized');
      } catch (error) {
        console.error('Failed to initialize OpenRouter client:', error);
      }
    }

    // Ensure at least one client is available
    if (!this.anthropicClient && !this.openRouterClient) {
      throw new Error('No valid AI API keys provided. Need either Anthropic or OpenRouter API key.');
    }
  }

  /**
   * Complete a prompt using primary provider with fallback
   */
  async complete(
    messages: AIMessage[],
    temperature: number = 0.7,
    maxTokens: number = 4000
  ): Promise<string> {
    // Determine order based on preference
    const primary = this.useAnthropicPrimary ? this.anthropicClient : this.openRouterClient;
    const fallback = this.useAnthropicPrimary ? this.openRouterClient : this.anthropicClient;
    const primaryName = this.useAnthropicPrimary ? 'Anthropic' : 'OpenRouter';
    const fallbackName = this.useAnthropicPrimary ? 'OpenRouter' : 'Anthropic';

    // Try primary
    if (primary) {
      try {
        console.log(`Trying ${primaryName} API...`);
        const result = await primary.complete(messages, temperature, maxTokens);
        console.log(`${primaryName} API succeeded`);
        return result;
      } catch (error) {
        console.error(`${primaryName} API failed:`, error);
        // Fall through to fallback
      }
    }

    // Try fallback
    if (fallback) {
      try {
        console.log(`Falling back to ${fallbackName} API...`);
        const result = await fallback.complete(messages, temperature, maxTokens);
        console.log(`${fallbackName} API succeeded`);
        return result;
      } catch (error) {
        console.error(`${fallbackName} API also failed:`, error);
        throw error;
      }
    }

    throw new Error('No available AI provider');
  }

  /**
   * Generate daily report analysis with unified prompt
   */
  async generateDailyReport(context: {
    reportDate: string;
    tasks: any[];
    streaks: any[];
    weeklyGoals: string | null;
    dailyChallenge: string | null;
    memory: Record<string, string>;
    pastWeekSummary: string;
    strategicGoals: string;
    userAnswers?: Record<string, string>;
    journalContent?: string;
  }): Promise<UnifiedAIResponse> {
    const prompt = this.buildUnifiedPrompt(context);

    const messages: AIMessage[] = [
      {
        role: 'system',
        content: 'أنت مساعد ذكي متخصص في تحليل التقدم الشخصي والإنتاجية. تتحدث باللهجة المصرية بشكل طبيعي ومحفز.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    const response = await this.complete(messages, 0.7, 6000);
    return this.parseUnifiedResponse(response);
  }

  /**
   * Optimize memory content
   */
  async optimizeMemory(
    category: string,
    currentContent: string,
    recentInsights: string[]
  ): Promise<string> {
    const prompt = `
# تحسين الذاكرة المنظمة

## الفئة: ${category}

## المحتوى الحالي:
${currentContent}

## رؤى حديثة للدمج:
${recentInsights.map((insight, i) => `${i + 1}. ${insight}`).join('\n')}

## المهمة:
قم بتحسين وتنظيم محتوى هذه الفئة من الذاكرة:
1. ادمج الرؤى الجديدة مع المحتوى الموجود
2. احذف التكرارات والمعلومات المتشابهة جداً
3. رتب المعلومات من الأهم للأقل أهمية
4. اجعل الصياغة موجزة وواضحة
5. احتفظ بالمعلومات القيمة فقط

أعد المحتوى المحسن بدون مقدمات، فقط المحتوى المنظم النهائي.
`;

    const messages: AIMessage[] = [
      {
        role: 'system',
        content: 'أنت خبير في تنظيم وتحسين المعلومات الشخصية.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    return await this.complete(messages, 0.5, 3000);
  }

  /**
   * Generate clarifying questions (if needed)
   */
  async generateQuestions(context: {
    tasks: any[];
    weeklyGoals: string | null;
    dailyChallenge: string | null;
  }): Promise<string[]> {
    const prompt = `
# توليد أسئلة توضيحية

بناءً على المهام التالية لليوم:

## المهام المنجزة:
${context.tasks.map(t => `- ${t.content}`).join('\n')}

## الأهداف الأسبوعية:
${context.weeklyGoals || 'لا توجد أهداف محددة'}

## التحدي اليومي:
${context.dailyChallenge || 'لا يوجد تحدي'}

## المهمة:
اطرح 1-3 أسئلة توضيحية قصيرة ومباشرة لفهم التجربة اليومية بشكل أفضل.
الأسئلة يجب أن تكون:
- قصيرة (سطر واحد لكل سؤال)
- محددة وسهلة الإجابة
- تساعد في فهم السياق والمشاعر والتحديات

اكتب كل سؤال في سطر منفصل يبدأ بـ "Q: "

مثال:
Q: كيف كان شعورك خلال العمل على المشروع الكبير؟
Q: ما التحدي الرئيسي اللي واجهته النهاردة؟
`;

    const messages: AIMessage[] = [
      {
        role: 'system',
        content: 'أنت خبير في طرح أسئلة توضيحية مفيدة.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    const response = await this.complete(messages, 0.8, 500);

    // Parse questions from response
    const questions = response
      .split('\n')
      .filter(line => line.trim().startsWith('Q:'))
      .map(line => line.replace(/^Q:\s*/, '').trim())
      .filter(q => q.length > 0);

    return questions;
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Build the unified prompt for daily report analysis
   */
  private buildUnifiedPrompt(context: {
    reportDate: string;
    tasks: any[];
    streaks: any[];
    weeklyGoals: string | null;
    dailyChallenge: string | null;
    memory: Record<string, string>;
    pastWeekSummary: string;
    strategicGoals: string;
    userAnswers?: Record<string, string>;
    journalContent?: string;
  }): string {
    const {
      reportDate,
      tasks,
      streaks,
      weeklyGoals,
      dailyChallenge,
      memory,
      pastWeekSummary,
      strategicGoals,
      userAnswers,
      journalContent,
    } = context;

    // Separate completed and failed tasks
    const completedTasks = tasks.filter(t => t.status === 'done');
    const failedTasks = tasks.filter(t => t.status === 'failed');

    // Calculate statistics
    const totalTasks = tasks.length;
    const completedCount = completedTasks.length;
    const successRate = totalTasks > 0 ? (completedCount / totalTasks) * 100 : 0;
    const totalMinutes = completedTasks.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);

    const prompt = `
# تحليل التقدم اليومي - ${reportDate}

${userAnswers ? `## إجابات المستخدم:\n${Object.entries(userAnswers).map(([q, a]) => `**س:** ${q}\n**ج:** ${a}`).join('\n\n')}\n` : ''}

## الإحصائيات:
- إجمالي المهام: ${totalTasks}
- المنجزة: ${completedCount}
- الفاشلة: ${failedTasks.length}
- معدل النجاح: ${successRate.toFixed(1)}%
- الوقت الإجمالي: ${totalMinutes} دقيقة (${(totalMinutes / 60).toFixed(1)} ساعة)

## المهام المنجزة:
${completedTasks.map(t => {
  const streakInfo = streaks.find(s => s.task_name === t.content);
  const streakText = streakInfo ? ` [🔥 ${streakInfo.current_streak} يوم]` : '';
  const durationText = t.duration_minutes ? ` [⏱️ ${t.duration_minutes}د]` : '';
  const quantityText = t.quantity ? ` [📊 ${t.quantity} ${t.quantity_unit || ''}]` : '';
  return `- ${t.content}${streakText}${durationText}${quantityText}`;
}).join('\n')}

${failedTasks.length > 0 ? `## المهام الفاشلة:\n${failedTasks.map(t => `- ${t.content}`).join('\n')}` : ''}

## التحدي اليومي:
${dailyChallenge || 'لا يوجد تحدي محدد لهذا اليوم'}

## الأهداف الأسبوعية:
${weeklyGoals || 'لا توجد أهداف محددة لهذا الأسبوع'}

${journalContent ? `## يوميات اليوم:\n${journalContent}\n` : ''}

## ملخص الأسبوع الماضي:
${pastWeekSummary}

## الأهداف الاستراتيجية طويلة المدى:
${strategicGoals}

## الذاكرة المنظمة:
${Object.entries(memory).map(([category, content]) => `### ${category}\n${content || 'لا توجد معلومات'}`).join('\n\n')}

---

# المطلوب منك:

قدم تحليلاً شاملاً ومحفزاً بناءً على كل المعلومات أعلاه. اتبع هذا الهيكل بدقة:

## [QUESTIONS]
(اطرح 1-3 أسئلة توضيحية قصيرة ومباشرة إذا كنت تحتاج معلومات إضافية لفهم السياق بشكل أفضل. كل سؤال في سطر منفصل يبدأ بـ "Q:")
Q: [سؤالك هنا]

## [COMMENTARY]
(تعليق شامل ومحفز باللهجة المصرية، يشمل:
- تحليل الأداء اليوم
- ملاحظات على الأنماط والتحسينات
- تشجيع وتحفيز شخصي
- نصائح عملية للتطوير
- ربط الإنجازات بالأهداف طويلة المدى

اكتب بطريقة طبيعية ودافئة، كأنك صديق مقرب يعرفك جيداً.)

## [CHALLENGE_EVAL]
(تقييم التحدي اليومي:
✅ إذا تم إنجازه
❌ إذا لم يتم إنجازه
فقط رمز واحد بدون تفسير)

## [REWARD]
(اقترح مكافأة مناسبة لإنجازات اليوم - شيء عملي وممتع، جملة واحدة قصيرة)

## [GOALS_ANALYSIS]
تحليل الأهداف الأسبوعية (استخدم هذا الشكل بالضبط):

### منجزة ✅
- [اذكر الأهداف المنجزة أو اكتب "لا يوجد"]

### قيد التنفيذ 🔄
- [اذكر الأهداف قيد التنفيذ أو اكتب "لا يوجد"]

### مهملة ⚠️
- [اذكر الأهداف المهملة أو اكتب "لا يوجد"]

## [MEMORY_UPDATES]
(إذا كانت هناك رؤى جديدة أو معلومات مهمة يجب تحديثها في الذاكرة، اذكرها بهذا الشكل:
CATEGORY: [اسم الفئة بالضبط كما هو أعلاه]
CONTENT: [المعلومة الجديدة]

إذا لم تكن هناك معلومات جديدة، اكتب: "لا توجد تحديثات")

## [MEMORY_OPTIMIZATION]
(إذا كانت الذاكرة بحاجة لتحسين وإعادة تنظيم (كبيرة جداً أو غير منظمة)، اكتب "OPTIMIZE_NEEDED"، وإلا اكتب "NOT_NEEDED")

---

تذكر: كن صادقاً ومحفزاً، واستخدم اللهجة المصرية بطبيعية، وركز على التطوير المستمر.
`;

    return prompt;
  }

  /**
   * Parse the unified AI response
   */
  private parseUnifiedResponse(response: string): UnifiedAIResponse {
    const result: UnifiedAIResponse = {
      questions: [],
      mainCommentary: '',
      challengeEvaluation: '❌',
      reward: '',
      goalsAnalysis: {
        completed: [],
        inProgress: [],
        neglected: [],
      },
      memoryUpdates: {},
    };

    // Extract questions
    const questionsMatch = response.match(/\[QUESTIONS\]([\s\S]*?)(?:\[|$)/i);
    if (questionsMatch && questionsMatch[1]) {
      const questionsText = questionsMatch[1];
      result.questions = questionsText
        .split('\n')
        .filter(line => line.trim().startsWith('Q:'))
        .map(line => line.replace(/^Q:\s*/, '').trim())
        .filter(q => q.length > 0);
    }

    // Extract commentary
    const commentaryMatch = response.match(/\[COMMENTARY\]([\s\S]*?)(?:\[|$)/i);
    if (commentaryMatch && commentaryMatch[1]) {
      result.mainCommentary = commentaryMatch[1].trim();
    }

    // Extract challenge evaluation
    const challengeMatch = response.match(/\[CHALLENGE_EVAL\]([\s\S]*?)(?:\[|$)/i);
    if (challengeMatch && challengeMatch[1]) {
      const evalText = challengeMatch[1].trim();
      result.challengeEvaluation = evalText.includes('✅') ? '✅' : '❌';
    }

    // Extract reward
    const rewardMatch = response.match(/\[REWARD\]([\s\S]*?)(?:\[|$)/i);
    if (rewardMatch && rewardMatch[1]) {
      result.reward = rewardMatch[1].trim();
    }

    // AFTER (CORRECT - more flexible parsing):
// Extract goals analysis
const goalsMatch = response.match(/\[GOALS_ANALYSIS\]([\s\S]*?)(?:\[|$)/i);
if (goalsMatch && goalsMatch[1]) {
  const goalsText = goalsMatch[1];

  console.log('📊 Parsing goals from:', goalsText.substring(0, 200));

  // Parse completed goals - more flexible patterns
  const completedPatterns = [
    /###\s*منجزة\s*✅([\s\S]*?)(?:###|$)/i,
    /###\s*منجزة([\s\S]*?)(?:###|$)/i,
    /منجزة\s*✅([\s\S]*?)(?:###|قيد التنفيذ|مهملة|$)/i,
  ];
  
  for (const pattern of completedPatterns) {
    const match = goalsText.match(pattern);
    if (match && match[1]) {
      result.goalsAnalysis.completed = this.parseListItems(match[1]);
      console.log('✅ Completed goals:', result.goalsAnalysis.completed);
      break;
    }
  }

  // Parse in-progress goals
  const inProgressPatterns = [
    /###\s*قيد التنفيذ\s*🔄([\s\S]*?)(?:###|$)/i,
    /###\s*قيد التنفيذ([\s\S]*?)(?:###|$)/i,
    /قيد التنفيذ\s*🔄([\s\S]*?)(?:###|منجزة|مهملة|$)/i,
  ];
  
  for (const pattern of inProgressPatterns) {
    const match = goalsText.match(pattern);
    if (match && match[1]) {
      result.goalsAnalysis.inProgress = this.parseListItems(match[1]);
      console.log('🔄 In-progress goals:', result.goalsAnalysis.inProgress);
      break;
    }
  }

  // Parse neglected goals
  const neglectedPatterns = [
    /###\s*مهملة\s*⚠️([\s\S]*?)(?:###|$)/i,
    /###\s*مهملة([\s\S]*?)(?:###|$)/i,
    /مهملة\s*⚠️([\s\S]*?)(?:###|منجزة|قيد التنفيذ|$)/i,
  ];
  
  for (const pattern of neglectedPatterns) {
    const match = goalsText.match(pattern);
    if (match && match[1]) {
      result.goalsAnalysis.neglected = this.parseListItems(match[1]);
      console.log('⚠️ Neglected goals:', result.goalsAnalysis.neglected);
      break;
    }
  }
}

    // Extract memory updates
    const memoryUpdatesMatch = response.match(/\[MEMORY_UPDATES\]([\s\S]*?)(?:\[|$)/i);
    if (memoryUpdatesMatch && memoryUpdatesMatch[1]) {
      const memoryText = memoryUpdatesMatch[1];
      if (!memoryText.includes('لا توجد تحديثات')) {
        const categoryMatches = memoryText.matchAll(/CATEGORY:\s*([^\n]+)\s*CONTENT:\s*([^\n]+)/gi);
        for (const match of categoryMatches) {
          if (match[1] && match[2]) {
            const category = match[1].trim();
            const content = match[2].trim();
            result.memoryUpdates[category] = content;
          }
        }
      }
    }

    // Extract memory optimization flag
    const memoryOptMatch = response.match(/\[MEMORY_OPTIMIZATION\]([\s\S]*?)(?:\[|$)/i);
    if (memoryOptMatch && memoryOptMatch[1]) {
      const optText = memoryOptMatch[1].trim();
      if (optText.includes('OPTIMIZE_NEEDED')) {
        result.memoryOptimization = 'OPTIMIZE_NEEDED';
      }
    }

    return result;
  }

  /**
   * Parse list items from text
   */
  private parseListItems(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('-') || line.match(/^\d+\./)) // Accept - or 1. 2. etc
    .map(line => line.replace(/^[-\d.]+\s*/, '').trim()) // Remove markers
    .filter(item => {
      // Remove empty, "لا يوجد", "no", "none", etc.
      const lower = item.toLowerCase();
      return item.length > 0 && 
             !lower.includes('لا يوجد') && 
             !lower.includes('no ') &&
             !lower.includes('none');
    });
}
}

// ============================================
// Factory Functions
// ============================================

export function createAIClient(apiKey: string, model?: string): AIClient {
  return new AIClient(apiKey, model);
}

export function createUnifiedAIClient(config: AIClientConfig): UnifiedAIClient {
  return new UnifiedAIClient(config);
}
