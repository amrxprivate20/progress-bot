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
  private debugLogger?: any; // Will be set externally

  constructor(apiKey: string, model: string = 'anthropic/claude-sonnet-4') {
  // Trim whitespace and validate API key format
  this.apiKey = apiKey.trim();
  
  if (!this.apiKey.startsWith('sk-or-v1-')) {
    throw new Error('Invalid OpenRouter API key format. Key must start with "sk-or-v1-"');
  }
  
  this.model = model;
}

/**
 * Set debug logger
 */
setDebugLogger(logger: any): void {
  this.debugLogger = logger;
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

    // ✅ NEW: Log AI request if debug mode enabled
    if (this.debugLogger?.isEnabled()) {
      await this.debugLogger.logAIRequest(this.model, messages, temperature, maxTokens);
    }

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

  // ✅ NEW: Log AI response if debug mode enabled
  if (this.debugLogger?.isEnabled()) {
    await this.debugLogger.logAIResponse(this.model, content, response.usage);
  }

  return content;
}

  /**
   * Generate daily report analysis with unified prompt
   */
  async generateDailyReport(context: {
  reportDate: string;
  tasks: any[];
  failedTasksJson?: any; // ✅ ADD THIS
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

  // ✅ NEW: Log the unified prompt if debug enabled
const logger = this.debugLogger;
if (logger?.isEnabled()) {
  await logger.log(
    `📋 **UNIFIED PROMPT** (${context.reportDate})\n\n` +
    '```\n' + prompt.substring(0, 3500) + '\n```',
    '📋'
  );
}

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
  const parsed = this.parseUnifiedResponse(response);

  // ✅ NEW: Log the parsed response structure if debug enabled
if (logger?.isEnabled()) {
  await logger.log(
      `📊 **PARSED AI RESPONSE**\n\n` +
      `**Questions:** ${parsed.questions.length}\n` +
      `**Challenge:** ${parsed.challengeEvaluation}\n` +
      `**Reward:** ${parsed.reward ? 'Yes' : 'No'}\n` +
      `**Goals Analysis:**\n` +
      `  • Completed: ${parsed.goalsAnalysis.completed.length}\n` +
      `  • In Progress: ${parsed.goalsAnalysis.inProgress.length}\n` +
      `  • Neglected: ${parsed.goalsAnalysis.neglected.length}\n` +
      `**Memory Updates:** ${Object.keys(parsed.memoryUpdates).length} categories\n` +
      `**Memory Optimization:** ${parsed.memoryOptimization || 'NOT_NEEDED'}`,
      '📊'
    );

    // Log memory updates details
    if (Object.keys(parsed.memoryUpdates).length > 0) {
      let memoryLog = '🧠 **MEMORY UPDATES DETAILS**\n\n';
      for (const [category, content] of Object.entries(parsed.memoryUpdates)) {
        memoryLog += `**${category}:**\n${content.substring(0, 200)}...\n\n`;
      }
      await logger.log(memoryLog, '🧠');
    }
  }

  return parsed;
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
  failedTasksJson?: any;
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
    failedTasksJson,
    streaks,
    weeklyGoals,
    dailyChallenge,
    memory,
    pastWeekSummary,
    strategicGoals,
    userAnswers,
    journalContent,
  } = context;

  // ✅ Calculate proper statistics
  const completedTasks = tasks.filter(t => t.status === 'done');
  const completedMainTasks = completedTasks.filter(t => !t.origin_task);

  // Get failed tasks from JSON
  const failedMainTasks = failedTasksJson?.failed_tasks?.filter((t: any) => !t.is_subtask) || [];
  const failedSubtasks = failedTasksJson?.failed_tasks?.filter((t: any) => t.is_subtask) || [];

  // Calculate totals
  const totalMainTasks = completedMainTasks.length + failedMainTasks.length;

  // Count fully completed main tasks (no failed subtasks)
  const fullyCompletedCount = completedMainTasks.filter((main: any) => {
    const mainName = main.content.replace(/\s*\[[^\]]+\]/g, '').trim();
    const hasFailedSubs = failedSubtasks.some((sub: any) => {
      const parentName = sub.parent_content?.replace(/\s*\[[^\]]+\]/g, '').trim();
      return parentName === mainName;
    });
    return !hasFailedSubs;
  }).length;

  const successRate = totalMainTasks > 0 ? (fullyCompletedCount / totalMainTasks) * 100 : 0;
  const totalMinutes = completedTasks.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);

  const prompt = `
# تحليل التقدم اليومي - ${reportDate}

${userAnswers ? `## إجابات المستخدم:\n${Object.entries(userAnswers).map(([q, a]) => `**س:** ${q}\n**ج:** ${a}`).join('\n\n')}\n` : ''}

## الإحصائيات:
- إجمالي المهام الرئيسية: ${totalMainTasks}
- المكتملة بالكامل: ${fullyCompletedCount}
- الفاشلة: ${failedMainTasks.length}
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

${failedMainTasks.length > 0 ? `## المهام الفاشلة:\n${failedMainTasks.map((t: any) => `- ${t.content}`).join('\n')}` : ''}

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
(⚠️ IMPORTANT: إذا كانت هناك أي رؤى جديدة، أنماط، أو معلومات مهمة من تجربة اليوم، يجب تحديث الذاكرة.

أمثلة على ما يستحق التحديث:
- أنماط جديدة في الإنتاجية أو المشاعر
- استراتيجيات ناجحة تم اكتشافها
- تحديات متكررة
- معلومات شخصية جديدة
- إنجازات مهمة

استخدم هذا الشكل بالضبط:
CATEGORY: [اسم الفئة بالضبط كما هو أعلاه]
CONTENT: [المعلومة الجديدة - جملة أو جملتين]

⚠️ حتى لو كانت رؤية صغيرة، اكتبها! 

مثال:
CATEGORY: Personal Insights & Patterns
CONTENT: يعمل بشكل أفضل في الصباح الباكر، تركيزه يقل بعد الظهر

إذا لم تكن هناك معلومات جديدة على الإطلاق، اكتب: "لا توجد تحديثات")
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
console.log('🔍 Memory updates section found:', !!memoryUpdatesMatch);
if (memoryUpdatesMatch && memoryUpdatesMatch[1]) {
  const memoryText = memoryUpdatesMatch[1];
  console.log('📝 Memory text:', memoryText.substring(0, 500)); // Show more for debugging
  
  if (!memoryText.includes('لا توجد تحديثات') && !memoryText.toLowerCase().includes('no updates')) {
    // ✅ NEW: More robust parsing that handles multiple formats
    
    // Split by CATEGORY: markers to get individual updates
    const categoryBlocks = memoryText.split(/(?=CATEGORY:)/i).filter(block => block.trim());
    console.log(`🔍 Found ${categoryBlocks.length} category blocks`);
    
    let matchCount = 0;
    
    for (const block of categoryBlocks) {
      // Extract category name
      const categoryMatch = block.match(/CATEGORY:\s*([^\n]+)/i);
      if (!categoryMatch || !categoryMatch[1]) continue;
      
      const category = categoryMatch[1].trim();
      
      // Extract content - try multiple patterns
      let content = '';
      
      // Pattern 1: CONTENT: on same line
      const contentMatch1 = block.match(/CONTENT:\s*([^\n]+)/i);
      if (contentMatch1 && contentMatch1[1]) {
        content = contentMatch1[1].trim();
      }
      
      // Pattern 2: CONTENT: on next line(s) - multiline
      if (!content) {
        const contentMatch2 = block.match(/CONTENT:\s*\n\s*(.+?)(?:\n\s*CATEGORY:|\n\s*\[|$)/is);
        if (contentMatch2 && contentMatch2[1]) {
          content = contentMatch2[1].trim();
        }
      }
      
      // Pattern 3: Just text after CATEGORY line (no CONTENT: label)
      if (!content) {
        const lines = block.split('\n').slice(1); // Skip CATEGORY line
        content = lines.join(' ').trim();
        // Stop at next CATEGORY or section marker
        const stopIndex = content.search(/CATEGORY:|^\[/i);
        if (stopIndex > 0) {
          content = content.substring(0, stopIndex).trim();
        }
      }
      
      if (content && content.length > 0) {
  matchCount++;
  console.log(`  ✅ [${matchCount}] Category: "${category}"`);
  console.log(`     Content preview: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
  
  // ✅ APPEND instead of overwrite
  if (result.memoryUpdates[category]) {
    result.memoryUpdates[category] += '\n\n' + content;
  } else {
    result.memoryUpdates[category] = content;
  }
} else {
        console.log(`  ⚠️ Category found but no content: "${category}"`);
      }
    }
    
    console.log(`📊 Total memory updates parsed: ${matchCount}`);
    
    if (matchCount === 0) {
      console.warn('⚠️ No memory updates parsed! Raw text:');
      console.warn(memoryText);
    }
  } else {
    console.log('ℹ️ AI said no updates needed');
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
  private debugLogger?: any;

  constructor(apiKey: string, model: string = 'claude-sonnet-4-20250514') {
    this.apiKey = apiKey.trim();

    if (!this.apiKey.startsWith('sk-ant-')) {
      throw new Error('Invalid Anthropic API key format. Key must start with "sk-ant-"');
    }

    this.model = model;
  }

/**
 * Set debug logger
 */
setDebugLogger(logger: any): void {
  this.debugLogger = logger;
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

    // ✅ NEW: Log AI request if debug mode enabled
  if (this.debugLogger?.isEnabled()) {
    await this.debugLogger.logAIRequest(this.model, messages, temperature, maxTokens);
  }

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

    // ✅ NEW: Log AI response if debug mode enabled
  if (this.debugLogger?.isEnabled()) {
    await this.debugLogger.logAIResponse(this.model, content, response.usage);
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
  private debugLogger?: any;

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
setDebugLogger(logger: any): void {
  this.debugLogger = logger; // Store for unified logging
  // Set logger on both child clients
  if (this.anthropicClient) {
    this.anthropicClient.setDebugLogger(logger);
  }
  if (this.openRouterClient) {
    this.openRouterClient.setDebugLogger(logger);
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
  failedTasksJson?: any; // ✅ ADD THIS
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

  // ✅ Store logger reference to satisfy TypeScript
  const logger = this.debugLogger;

  // ✅ Log the unified prompt if debug enabled
  if (logger?.isEnabled()) {
    await logger.log(
      `📋 **UNIFIED PROMPT** (${context.reportDate})\n\n` +
      '```\n' + prompt.substring(0, 3500) + '\n```',
      '📋'
    );
  }

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
  const parsed = this.parseUnifiedResponse(response);

  // ✅ Log the parsed response structure if debug enabled
  if (logger?.isEnabled()) {
    await logger.log(
      `📊 **PARSED AI RESPONSE**\n\n` +
      `**Questions:** ${parsed.questions.length}\n` +
      `**Challenge:** ${parsed.challengeEvaluation}\n` +
      `**Reward:** ${parsed.reward ? 'Yes' : 'No'}\n` +
      `**Goals Analysis:**\n` +
      `  • Completed: ${parsed.goalsAnalysis.completed.length}\n` +
      `  • In Progress: ${parsed.goalsAnalysis.inProgress.length}\n` +
      `  • Neglected: ${parsed.goalsAnalysis.neglected.length}\n` +
      `**Memory Updates:** ${Object.keys(parsed.memoryUpdates).length} categories\n` +
      `**Memory Optimization:** ${parsed.memoryOptimization || 'NOT_NEEDED'}`,
      '📊'
    );

    // Log memory updates details
    if (Object.keys(parsed.memoryUpdates).length > 0) {
      let memoryLog = '🧠 **MEMORY UPDATES DETAILS**\n\n';
      for (const [category, content] of Object.entries(parsed.memoryUpdates)) {
        memoryLog += `**${category}:**\n${content.substring(0, 200)}...\n\n`;
      }
      await logger.log(memoryLog, '🧠');
    }
  }

  return parsed;
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
  failedTasksJson?: any;
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
    failedTasksJson,
    streaks,
    weeklyGoals,
    dailyChallenge,
    memory,
    pastWeekSummary,
    strategicGoals,
    userAnswers,
    journalContent,
  } = context;

  // ✅ Calculate proper statistics
  const completedTasks = tasks.filter(t => t.status === 'done');
  const completedMainTasks = completedTasks.filter(t => !t.origin_task);

  // Get failed tasks from JSON
  const failedMainTasks = failedTasksJson?.failed_tasks?.filter((t: any) => !t.is_subtask) || [];
  const failedSubtasks = failedTasksJson?.failed_tasks?.filter((t: any) => t.is_subtask) || [];

  // Calculate totals
  const totalMainTasks = completedMainTasks.length + failedMainTasks.length;

  // Count fully completed main tasks (no failed subtasks)
  const fullyCompletedCount = completedMainTasks.filter((main: any) => {
    const mainName = main.content.replace(/\s*\[[^\]]+\]/g, '').trim();
    const hasFailedSubs = failedSubtasks.some((sub: any) => {
      const parentName = sub.parent_content?.replace(/\s*\[[^\]]+\]/g, '').trim();
      return parentName === mainName;
    });
    return !hasFailedSubs;
  }).length;

  const successRate = totalMainTasks > 0 ? (fullyCompletedCount / totalMainTasks) * 100 : 0;
  const totalMinutes = completedTasks.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);

  const prompt = `
# تحليل التقدم اليومي - ${reportDate}

${userAnswers ? `## إجابات المستخدم:\n${Object.entries(userAnswers).map(([q, a]) => `**س:** ${q}\n**ج:** ${a}`).join('\n\n')}\n` : ''}

## الإحصائيات:
- إجمالي المهام الرئيسية: ${totalMainTasks}
- المكتملة بالكامل: ${fullyCompletedCount}
- الفاشلة: ${failedMainTasks.length}
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

${failedMainTasks.length > 0 ? `## المهام الفاشلة:\n${failedMainTasks.map((t: any) => `- ${t.content}`).join('\n')}` : ''}

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
(⚠️ IMPORTANT: إذا كانت هناك أي رؤى جديدة، أنماط، أو معلومات مهمة من تجربة اليوم، يجب تحديث الذاكرة.

أمثلة على ما يستحق التحديث:
- أنماط جديدة في الإنتاجية أو المشاعر
- استراتيجيات ناجحة تم اكتشافها
- تحديات متكررة
- معلومات شخصية جديدة
- إنجازات مهمة

استخدم هذا الشكل بالضبط:
CATEGORY: [اسم الفئة بالضبط كما هو أعلاه]
CONTENT: [المعلومة الجديدة - جملة أو جملتين]

⚠️ حتى لو كانت رؤية صغيرة، اكتبها! 

مثال:
CATEGORY: Personal Insights & Patterns
CONTENT: يعمل بشكل أفضل في الصباح الباكر، تركيزه يقل بعد الظهر

إذا لم تكن هناك معلومات جديدة على الإطلاق، اكتب: "لا توجد تحديثات")
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
console.log('🔍 Memory updates section found:', !!memoryUpdatesMatch);
if (memoryUpdatesMatch && memoryUpdatesMatch[1]) {
  const memoryText = memoryUpdatesMatch[1];
  console.log('📝 Memory text:', memoryText.substring(0, 500)); // Show more for debugging
  
  if (!memoryText.includes('لا توجد تحديثات') && !memoryText.toLowerCase().includes('no updates')) {
    // ✅ NEW: More robust parsing that handles multiple formats
    
    // Split by CATEGORY: markers to get individual updates
    const categoryBlocks = memoryText.split(/(?=CATEGORY:)/i).filter(block => block.trim());
    console.log(`🔍 Found ${categoryBlocks.length} category blocks`);
    
    let matchCount = 0;
    
    for (const block of categoryBlocks) {
      // Extract category name
      const categoryMatch = block.match(/CATEGORY:\s*([^\n]+)/i);
      if (!categoryMatch || !categoryMatch[1]) continue;
      
      const category = categoryMatch[1].trim();
      
      // Extract content - try multiple patterns
      let content = '';
      
      // Pattern 1: CONTENT: on same line
      const contentMatch1 = block.match(/CONTENT:\s*([^\n]+)/i);
      if (contentMatch1 && contentMatch1[1]) {
        content = contentMatch1[1].trim();
      }
      
      // Pattern 2: CONTENT: on next line(s) - multiline
      if (!content) {
        const contentMatch2 = block.match(/CONTENT:\s*\n\s*(.+?)(?:\n\s*CATEGORY:|\n\s*\[|$)/is);
        if (contentMatch2 && contentMatch2[1]) {
          content = contentMatch2[1].trim();
        }
      }
      
      // Pattern 3: Just text after CATEGORY line (no CONTENT: label)
      if (!content) {
        const lines = block.split('\n').slice(1); // Skip CATEGORY line
        content = lines.join(' ').trim();
        // Stop at next CATEGORY or section marker
        const stopIndex = content.search(/CATEGORY:|^\[/i);
        if (stopIndex > 0) {
          content = content.substring(0, stopIndex).trim();
        }
      }
      
      if (content && content.length > 0) {
  matchCount++;
  console.log(`  ✅ [${matchCount}] Category: "${category}"`);
  console.log(`     Content preview: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
  
  // ✅ APPEND instead of overwrite
  if (result.memoryUpdates[category]) {
    result.memoryUpdates[category] += '\n\n' + content;
  } else {
    result.memoryUpdates[category] = content;
  }
} else {
        console.log(`  ⚠️ Category found but no content: "${category}"`);
      }
    }
    
    console.log(`📊 Total memory updates parsed: ${matchCount}`);
    
    if (matchCount === 0) {
      console.warn('⚠️ No memory updates parsed! Raw text:');
      console.warn(memoryText);
    }
  } else {
    console.log('ℹ️ AI said no updates needed');
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
