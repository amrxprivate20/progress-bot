# My Progress Telegram Bot - Complete Rebuild Project (Updated)

## 🎯 Project Overview
Build a modern, fast, and maintainable progress tracking system with AI-powered daily reports, replacing a slow Google Sheets-based system. The bot integrates with Todoist, generates intelligent Arabic reports, manages weekly goals, and maintains an organized memory system about the user.

**CRITICAL: All times use Egypt timezone (UTC+2 / Africa/Cairo)**

---

## 📋 Core Requirements

### 1. **System Architecture**
- **Database:** Supabase (PostgreSQL) - free tier
- **Backend API:** Cloudflare Workers (serverless, Durable Objects for async)
- **Bot Framework:** Grammy (TypeScript) for Telegram
- **AI Provider:** OpenRouter API (Claude Sonnet 4)
- **Language:** TypeScript/JavaScript (Node.js compatible)
- **File Storage:** Google Drive API (for Obsidian markdown files)
- **Timezone:** Egypt (UTC+2 / Africa/Cairo) - ALL dates calculated in this timezone

### 2. **Data Models**

#### **Tasks Table** (`tasks`)
```sql
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  priority INTEGER,
  description TEXT,
  completed_at TIMESTAMPTZ NOT NULL, -- Stored in UTC
  duration_minutes INTEGER DEFAULT 0,
  quantity NUMERIC,
  quantity_unit TEXT,
  is_origin BOOLEAN DEFAULT false,
  origin_task TEXT,
  status TEXT CHECK (status IN ('done', 'failed', 'partial')),
  parent_completion_status TEXT CHECK (parent_completion_status IN ('complete', 'partial', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tasks_completed_at ON tasks(completed_at DESC);
CREATE INDEX idx_tasks_category ON tasks(category);
CREATE INDEX idx_tasks_parent_status ON tasks(parent_completion_status);
```

#### **Streaks Table** (`streaks`)
```sql
CREATE TABLE streaks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_name TEXT UNIQUE NOT NULL,
  current_streak INTEGER DEFAULT 0,
  best_streak INTEGER DEFAULT 0,
  last_completed_date DATE, -- Stored as Egypt date (YYYY-MM-DD)
  streak_type TEXT CHECK (streak_type IN ('daily', 'weekly')),
  weekly_pattern TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### **Daily Reports Table** (`daily_reports`)
```sql
CREATE TABLE daily_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_date DATE UNIQUE NOT NULL, -- Egypt date
  report_markdown TEXT NOT NULL,
  success_rate NUMERIC,
  total_tasks INTEGER,
  completed_tasks INTEGER,
  failed_tasks INTEGER,
  achievement_time_minutes INTEGER,
  challenge_evaluation TEXT,
  ai_commentary TEXT,
  suggested_reward TEXT,
  weekly_goals_analysis TEXT,
  user_comments TEXT,
  obsidian_file_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_daily_reports_date ON daily_reports(report_date DESC);
```

#### **Weekly Goals Table** (`weekly_goals`)
```sql
CREATE TABLE weekly_goals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  week_start_date DATE NOT NULL,
  week_end_date DATE NOT NULL,
  goals_text TEXT NOT NULL,
  evaluation_text TEXT,
  completion_rate NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_weekly_goals_dates ON weekly_goals(week_start_date DESC);
```

#### **Daily Challenges Table** (`daily_challenges`)
```sql
CREATE TABLE daily_challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_date DATE UNIQUE NOT NULL,
  challenge_text TEXT NOT NULL,
  result BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### **Memory Table** (`memory`)
```sql
CREATE TABLE memory (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category TEXT UNIQUE NOT NULL CHECK (category IN (
    'Personal Insights & Patterns',
    'Successful Strategies & What Works',
    'Triggers & Challenges',
    'Important Milestones & Breakthroughs',
    'Recurring Themes & Lessons',
    'Personal Information & Facts'
  )),
  content TEXT,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  last_optimized TIMESTAMPTZ
);
```

#### **Settings Table** (`settings`)
```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### **Journal Entries Table** (`journal_entries`) - NEW
```sql
CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_date DATE NOT NULL, -- Egypt date
  message_text TEXT,
  media_url TEXT,
  media_type TEXT, -- 'image', 'video', 'document'
  entry_order INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  is_session_start BOOLEAN DEFAULT false,
  is_session_end BOOLEAN DEFAULT false
);

CREATE INDEX idx_journal_date ON journal_entries(entry_date DESC);
```

### 3. **Essential Features**

#### **A. Todoist Integration**
- Webhook receiver for task completion events
- Parse task metadata (duration, quantity, origin tasks) - **SUPPORTS ARABIC**
- **Duration formats:**
  - English: `[30m]`, `[2h]`, `[1.5h]`
  - Arabic: `[30د]`, `[3س]`, `[1.5س]`
- **Quantity formats:**
  - English: `[5 pages]`, `[10 reps]`
  - Arabic: `[5 صفحات]`, `[50 ورقة]`, `[10 تكرارات]`
- **Combined format:** `[30م, 5 صفحات]` or `[2h, 10 pages]`
- Calculate streaks automatically (using Egypt timezone)
- Filter by specific project ID
- Duplicate detection (20-minute window)
- **Parent-child task status tracking:**
  - ✅ Complete: All subtasks done
  - ⚠️ Partial: Some subtasks done
  - ❌ Failed: No subtasks done

#### **B. Report Generation**
- Collect all completed tasks for the day (Egypt timezone boundaries)
- Calculate success rate, time spent, task distribution
- Retrieve current weekly goals and daily challenge
- Get organized memory context
- Get analysis of past week's reports
- **Include full task breakdown in preview:**
  - ✅ Completed tasks (with subtasks)
  - ⚠️ Partially completed tasks
  - ❌ Failed tasks
- Send everything to AI for unified analysis

#### **C. AI Analysis System**
- **Single unified prompt** that produces all outputs:
  1. **Dynamic clarifying questions** (1-N questions, not fixed to 3)
  2. Comprehensive commentary (Egyptian dialect)
  3. Daily challenge evaluation (✅/❌)
  4. Suggested reward
  5. Weekly goals analysis (completed/in-progress/neglected)
  6. Memory updates (only if new important info)
  7. Memory optimization (only if needed)

- **Interactive Q&A Flow:**
  - Dynamic question count (based on AI needs)
  - Correct numbering: [1/N], [2/N], ..., [N/N]
  - Stores questions in conversation state
  - Sends one question at a time
  - Waits for user answers (10-minute timeout)
  - **Can skip remaining questions** with `/skip_questions`
  - After all answers collected, continues with full analysis

#### **D. Telegram Bot Commands**
- `/progress` - Show report preview with full task breakdown, ask for confirmation
- `/confirm` - Proceed with full AI analysis (background processing)
- `/cancel` - Cancel report processing
- `/skip_questions` - Skip remaining questions and proceed with analysis
- `/memory` - View current organized memory
- `/clearmemory` - Clear all memory (with confirmation)
- `/log_failure` - **NEW:** Manually log a failed non-recurring task
- `/today` - **NEW:** Show current day report (partial, no AI)
- `/report YYYY-MM-DD` - **NEW:** Get report for specific date
- `/lastupdate` - **NEW:** Show current system status
- `/journal_start` - **NEW:** Start daily journal session
- `/journal_end` - **NEW:** End journal session
- `/journal_resume` - **NEW:** Resume journal for today
- `/help` - **ENHANCED:** Complete system manual (7 sections)
- `/createtasks` - Generate week's tasks in Todoist from goals (Phase 3)

#### **E. Memory Management**
- 6 organized categories
- Automatic updates from daily insights
- Smart deduplication (70% word overlap threshold)
- Auto-optimization triggers:
  - Size exceeds 10,000 characters
  - 7 days since last optimization
- AI-powered consolidation and cleanup

#### **F. Weekly Goals System**
- Generate new goals every Friday using AI
- Evaluation of previous week's goals
- Integration with long-term strategic goals
- Extract 7 daily challenges (Saturday-Friday)
- Store challenges separately

#### **G. Todoist Task Creation**
- Read weekly goals and daily challenges
- Generate 5-8 specific tasks using AI
- Create all tasks with correct due dates
- Assign priorities (1-4)
- Handle rate limiting properly

#### **H. Google Drive Integration**
- Save daily reports as Markdown files
- Folder structure: main folder + "Gallery" subfolder for images
- Filename format: `YYYY-MM-DD.md`
- Support image uploads from Telegram
- Create `_LastUpdate.md` with current status

#### **I. Journal System** - NEW
- Daily journaling with multiple entries
- Support text messages and images
- Session management (start/end/resume)
- Chronological ordering
- **Integrated with AI prompt** - full journal included in report context
- Opt-in feature

### 4. **API Endpoints Structure**
```typescript
// Cloudflare Workers endpoints

POST /webhook/todoist
  - Receive task completion from Todoist
  - Validate project ID
  - Store in database (with parent status update)
  - Update streaks (Egypt timezone)
  - Check for special tasks (Quran memorization)
  - Send Telegram notification

POST /telegram/webhook
  - Receive all bot interactions
  - Route to appropriate handlers
  - Manage conversation state

GET /api/report/preview/:date
  - Generate report preview without AI
  - Include full task breakdown
  - Return formatted text

POST /api/report/generate/:date
  - Gather all context (tasks, goals, memory, journal)
  - Call AI with unified prompt
  - Parse AI response
  - Handle Q&A flow if needed
  - Save to database
  - Send to Telegram
  - Save to Google Drive

POST /api/memory/optimize
  - Get current memory
  - Call AI for optimization
  - Update database

POST /api/goals/generate
  - Evaluate previous week
  - Generate new goals
  - Extract challenges
  - Save to database

POST /api/todoist/create-tasks
  - Read current week's goals and challenges
  - Generate tasks with AI
  - Create in Todoist via API

GET /api/jobs/:jobId
  - Poll Durable Object status
  - Return processing progress
```

### 5. **Configuration Requirements**

Store in Supabase `settings` table:
```typescript
{
  // Telegram
  "telegram_bot_token": "...",
  "telegram_chat_id": "...",
  "telegram_thread_arabic": "149",
  "telegram_thread_english": "155",
  "telegram_thread_quran": "2053",
  
  // Todoist
  "todoist_api_token": "...",
  "todoist_project_id": "...",
  
  // AI
  "openrouter_api_key": "...",
  "ai_model": "anthropic/claude-sonnet-4",
  
  // Google Drive
  "google_drive_folder_id": "...",
  
  // System
  "quran_task_name": "Reviewing a memorized portion from the the Holy Quran❗",
  "quran_spreadsheet_id": "...",
  "timezone": "Africa/Cairo", // CRITICAL
  
  // Long-term goals (stored as JSON text)
  "strategic_goals": "...",
  
  // Master AI Prompt
  "master_prompt": "..." // The complete unified prompt
}
```

### 6. **Critical Business Logic**

#### **Timezone Handling** - CRITICAL
```typescript
// All date operations use Egypt timezone (UTC+2)
import { 
  getTodayInEgypt,           // Get today's date in Egypt
  getEgyptDateString,        // Convert UTC to Egypt date
  getEgyptDayBoundaries,     // Get UTC boundaries for Egypt day
  formatArabicDate,          // Display date in Arabic
  formatArabicTime,          // Display time with Arabic plurals
  formatArabicStreak         // Display streak with Arabic plurals
} from '../utils/timezone';

// Example: Filtering tasks for today
const today = getTodayInEgypt(); // "2026-01-08"
const { start, end } = getEgyptDayBoundaries(today);
// start: 2026-01-07 22:00:00 UTC (midnight in Egypt)
// end: 2026-01-08 21:59:59 UTC (23:59:59 in Egypt)

// A task at 1:00 AM Egypt time (23:00 UTC previous day)
// will correctly fall within today's boundaries
```

#### **Streak Calculation Algorithm**
```typescript
// For daily streaks (every day) - uses Egypt dates
function updateDailyStreak(taskName: string, completedAt: Date) {
  // Convert to Egypt date
  const egyptDate = getEgyptDateString(completedAt);
  
  const streak = getStreak(taskName);
  const yesterday = getYesterdayInEgypt();
  
  if (streak.lastCompletedDate === null) {
    // First time
    streak.currentStreak = 1;
  } else if (streak.lastCompletedDate === egyptDate) {
    // Same day in Egypt, no change
    return;
  } else if (streak.lastCompletedDate === yesterday) {
    // Consecutive day
    streak.currentStreak++;
  } else {
    // Streak broken
    streak.currentStreak = 1;
  }
  
  streak.bestStreak = Math.max(streak.bestStreak, streak.currentStreak);
  streak.lastCompletedDate = egyptDate;
  saveStreak(streak);
}
```

#### **Failed Task Detection**
```typescript
// Hierarchy-based status determination

// For tasks with subtasks:
function updateParentTaskStatus(parentId: string) {
  const subtasks = getSubtasks(parentId);
  const doneCount = subtasks.filter(t => t.status === 'done').length;
  const totalCount = subtasks.length;
  
  if (doneCount === totalCount) {
    parentStatus = '✅ complete';
  } else if (doneCount > 0) {
    parentStatus = '⚠️ partial';
  } else {
    parentStatus = '❌ failed';
  }
}

// For recurring tasks not completed:
function detectMissedRecurringTasks(date: string) {
  // At report time, check if recurring tasks were completed
  // If not, add to failed_tasks array with status: 'failed'
}

// Manual logging:
// User can use /log_failure to manually log failed tasks
```

#### **Task Notification Format**
```typescript
function formatTaskNotification(task: Task, streak?: Streak): string {
  // Symbols:
  // ✅ Completed main task (no subtasks OR all subtasks done)
  // ✓ Completed subtask
  // ⚠️ Partially completed main task (some subtasks done)
  // ❌ Failed main task
  // ✕ Failed subtask
  
  let symbol = determineSymbol(task);
  let message = `${symbol} ${task.content}\n`;
  
  if (task.description) {
    message += `\n📝 ${task.description}\n`;
  }
  
  if (task.duration_minutes) {
    message += `\n⏱ المدة: ${formatArabicTime(task.duration_minutes)}`;
  }
  
  if (task.quantity) {
    message += `\n📊 الكمية: ${task.quantity} ${task.quantity_unit}`;
  }
  
  if (task.category) {
    message += `\n🏷 الفئة: ${task.category}`;
  }
  
  if (streak && streak.current_streak > 0) {
    message += `\n\n🔥 السلسلة:\n`;
    message += `النوع: ${streak.streak_type === 'daily' ? 'يومية' : 'أسبوعية'}\n`;
    message += `المدة: ${formatArabicStreak(streak.current_streak)}`;
    
    if (streak.current_streak === streak.best_streak && streak.current_streak > 1) {
      message += ' 🎉 (رقم قياسي جديد!)';
    }
  }
  
  return message;
}
```

#### **Arabic Plural Rules**
```typescript
// Applied to time, streaks, and quantities
function formatArabicNumber(num: number, singular, dual, plural, singularLarge): string {
  if (num === 1) return singular;          // يوم
  if (num === 2) return dual;              // يومان
  if (num >= 3 && num <= 10) return `${num} ${plural}`;  // 5 أيام
  return `${num} ${singularLarge}`;        // 25 يوم
}

// Examples:
formatArabicStreak(1)   → "يوم"
formatArabicStreak(2)   → "يومان"
formatArabicStreak(5)   → "5 أيام"
formatArabicStreak(25)  → "25 يوم"

formatArabicTime(30)    → "30 دقيقة"
formatArabicTime(60)    → "ساعة"
formatArabicTime(120)   → "ساعتان"
formatArabicTime(180)   → "3 ساعات"
formatArabicTime(600)   → "10 ساعات"
formatArabicTime(660)   → "11 ساعة"
```

#### **Report Arabic Formatting**
```typescript
// Generate full Arabic daily report
function generateArabicReport(data: ReportData): string {
  let report = '';
  
  // Header with Egypt date
  report += `📊 التقرير اليومي - ${formatArabicDate(data.date)}\n\n`;
  
  // Statistics
  report += `📈 الإحصائيات:\n`;
  report += `- إجمالي المهام: ${data.total_tasks}\n`;
  report += `- المنجزة: ${data.completed_tasks}\n`;
  report += `- الفاشلة: ${data.failed_tasks}\n`;
  report += `- معدل النجاح: ${data.success_rate}%\n`;
  report += `- وقت الإنجاز: ${formatArabicTime(data.total_time_minutes)}\n\n`;
  
  // Task breakdown (NEW - required in preview)
  report += `🎯 مهام اليوم\n`;
  report += `----------------\n`;
  for (const task of data.tasks) {
    const symbol = getTaskSymbol(task);
    const streakInfo = getStreakDisplay(task);
    report += `${symbol} ${task.content}${streakInfo}\n`;
    
    // Show subtasks
    for (const subtask of task.subtasks) {
      const subSymbol = subtask.status === 'done' ? '✓' : '✕';
      report += `   ${subSymbol} ${subtask.content}\n`;
    }
  }
  
  // ... rest of report
}
```

#### **AI Response Parsing**
```typescript
interface UnifiedAIResponse {
  questions: string[];              // Dynamic count (1-N)
  mainCommentary: string;
  challengeEvaluation: string;
  reward: string;
  goalsAnalysis: {
    completed: string[];
    inProgress: string[];
    neglected: string[];
  };
  memoryUpdates: Map<string, string>;
  memoryOptimization?: string;
}

function parseUnifiedAIResponse(aiText: string): UnifiedAIResponse {
  // Extract each section using regex patterns
  // Handle dynamic question count
  // Return structured object
}
```

### 7. **Error Handling Requirements**
- All API calls must have retry logic (3 attempts with exponential backoff)
- Database transactions for critical operations
- Graceful degradation (if AI fails, save raw report)
- Detailed logging for debugging
- User-friendly error messages in Arabic
- **No noisy progress messages** (removed: "جاري تحديث الذاكرة", etc.)

### 8. **Performance Requirements**
- Todoist webhook response < 500ms
- Report generation runs in background (Durable Objects - no timeout)
- Database queries < 100ms
- Support 100+ tasks per day

---

## 📦 Deliverables Required

### **Phase 1: Foundation** ✅ COMPLETE
1. Complete Supabase database setup script
2. Cloudflare Workers boilerplate with TypeScript
3. Todoist webhook handler with duplicate detection
4. Basic Telegram bot with Grammy framework
5. Settings management system

### **Phase 2: Core Features** ✅ COMPLETE + FIXES APPLIED
6. Task storage and streak calculation (Egypt timezone)
7. Report generation (Arabic formatting with task breakdown)
8. AI integration with unified prompt (dynamic questions)
9. Q&A conversation flow (correct numbering, skip option)
10. Memory management system
11. **Durable Objects** for background processing
12. **Parent-child task status tracking**
13. **Enhanced task notifications** (description, streak, Arabic)
14. **Manual failure logging** (/log_failure)

### **Phase 3: Advanced Features** (FUTURE)
11. Weekly goals generation
12. Todoist task creation
13. Google Drive integration
14. Journal system (implemented, needs testing)
15. All Telegram commands (/today, /report, /lastupdate)

### **Phase 4: Testing & Deployment** (FUTURE)
15. Unit tests for critical functions
16. Integration testing guide
17. Deployment instructions
18. Migration script
19. Monitoring and logging setup

---

## 📝 Documentation Required

1. **Architecture Diagram** (visual overview)
2. **Setup Guide** (step-by-step)
3. **Environment Variables** (complete .env.example)
4. **API Documentation** (all endpoints)
5. **Database Schema** (with relationships diagram)
6. **Deployment Guide** (Cloudflare Workers + Supabase)
7. **Testing Guide** (how to test each feature)
8. **Troubleshooting Guide** (common issues and solutions)
9. **Timezone Guide** - Egypt UTC+2 handling
10. **Arabic Support Guide** - Duration, units, plurals

---

## 🎨 Code Quality Standards

- **TypeScript strict mode**
- **Functional programming style** where possible
- **Clear naming conventions** (descriptive, not abbreviated)
- **Comprehensive comments** (explain WHY, not WHAT)
- **Error handling everywhere**
- **No magic numbers** (use named constants)
- **Modular design** (small, focused functions)
- **DRY principle** (don't repeat yourself)
- **Timezone-aware** (always use Egypt utilities)
- **Arabic-aware** (support both languages in parsing)

---

## 🚀 Special Implementation Notes

1. **Telegram Message Splitting:** Messages longer than 4096 characters must be split intelligently (at paragraph breaks, not mid-sentence)

2. **Rate Limiting:** 
   - Todoist API: 450 requests per 15 minutes
   - Telegram: 30 messages per second
   - OpenRouter: varies by model

3. **Time Zones:** 
   - **CRITICAL:** All dates/times use Egypt timezone (UTC+2 / Africa/Cairo)
   - Store UTC in database, convert at boundaries
   - Use timezone utility functions consistently

4. **Arabic Text Handling:** 
   - Ensure proper RTL support and Unicode handling
   - Support Arabic in task parsing ([30د], [3س], [50 ورقة])
   - Use Arabic plural rules (يوم، يومان، أيام، يوم)

5. **Conversation State:** Use database-backed state (conversation_state table)

6. **Background Processing:** Use Durable Objects for long-running AI calls

7. **Graceful Shutdown:** Handle cleanup on worker termination

8. **Symbol Consistency:**
   - ✅ Completed main task
   - ✓ Completed subtask
   - ⚠️ Partial main task
   - ❌ Failed main task
   - ✕ Failed subtask

---

## 💡 Implementation Guidance Requested

For each deliverable, provide:
- ✅ **Complete working code** (copy-paste ready)
- ✅ **Inline comments** explaining logic
- ✅ **Setup instructions** for that specific component
- ✅ **Testing examples** showing how to verify it works
- ✅ **Common pitfalls** to avoid
- ✅ **Next steps** to integrate with other components

Assume the developer has:
- Basic JavaScript/TypeScript knowledge
- Familiarity with terminal/command line
- No prior experience with Cloudflare Workers or Supabase
- Needs clear, step-by-step instructions

---

## 🎯 Success Criteria

The system is complete when:
1. ✅ Todoist tasks are captured automatically (Egypt timezone)
2. ✅ Daily reports generate with AI analysis (background processing)
3. ✅ Interactive Q&A works smoothly (dynamic questions, skip option)
4. ✅ Memory system updates and optimizes
5. ✅ Subtask completion updates parent status
6. ✅ Task notifications show full details (description, streak in Arabic)
7. ✅ Manual failure logging works
8. ✅ Arabic parsing works ([30د], [50 ورقة])
9. ✅ Timezone handling is correct (1 AM = today)
10. ⏳ Weekly goals generate and evaluate (Phase 3)
11. ⏳ Tasks are created in Todoist from goals (Phase 3)
12. ⏳ All Telegram commands work (Phase 3)
13. ⏳ Reports save to Google Drive (Phase 3)
14. ⏳ System is fast (reports in background, no wait)
15. ⏳ System is stable (no crashes for 7 days)

---

## 🔧 Recent Critical Fixes Applied

1. ✅ **TypeScript Error:** Removed unused `escapeMarkdown` function
2. ✅ **Timezone Handling:** Complete Egypt UTC+2 support with utilities
3. ✅ **Conversation Numbering:** Fixed off-by-one error ([1/N] not [0/N])
4. ✅ **Failed Tasks Logic:** Parent-child status tracking + manual logging
5. ✅ **Task Notifications:** Enhanced with description, streak, Arabic
6. ✅ **Noisy Messages:** Removed progress spam
7. ✅ **Arabic Duration:** Support [30د], [3س] formats
8. ✅ **Arabic Units:** Support [50 ورقة], [10 صفحات] formats
9. ✅ **Arabic Plurals:** Proper يوم/يومان/أيام/يوم rules

---

**Start with Phase 1 (COMPLETE), verify Phase 2 fixes are applied, then proceed to Phase 3. Provide complete implementation with all code, setup instructions, and testing guidance.**
