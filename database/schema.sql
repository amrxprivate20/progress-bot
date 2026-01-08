-- ============================================
-- Progress Bot - Complete Database Schema
-- ============================================
-- Run this entire script in Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 1. TASKS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  priority INTEGER CHECK (priority BETWEEN 1 AND 4),
  description TEXT,
  completed_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER DEFAULT 0,
  quantity NUMERIC,
  quantity_unit TEXT,
  is_origin BOOLEAN DEFAULT false,
  origin_task TEXT,
  status TEXT CHECK (status IN ('done', 'failed', 'partial')) DEFAULT 'done',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
CREATE INDEX IF NOT EXISTS idx_tasks_task_id ON tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- Comment on table
COMMENT ON TABLE tasks IS 'Stores all completed tasks from Todoist';
COMMENT ON COLUMN tasks.task_id IS 'Unique identifier from Todoist';
COMMENT ON COLUMN tasks.duration_minutes IS 'Time spent on task (from task content parsing)';
COMMENT ON COLUMN tasks.is_origin IS 'If true, this is a recurring/origin task';
COMMENT ON COLUMN tasks.origin_task IS 'Reference to parent task for tracking';

-- ============================================
-- 2. STREAKS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS streaks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_name TEXT UNIQUE NOT NULL,
  current_streak INTEGER DEFAULT 0,
  best_streak INTEGER DEFAULT 0,
  last_completed_date DATE,
  streak_type TEXT CHECK (streak_type IN ('daily', 'weekly')) DEFAULT 'daily',
  weekly_pattern TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_streaks_task_name ON streaks(task_name);
CREATE INDEX IF NOT EXISTS idx_streaks_type ON streaks(streak_type);

COMMENT ON TABLE streaks IS 'Tracks consecutive completion streaks for recurring tasks';
COMMENT ON COLUMN streaks.weekly_pattern IS 'Comma-separated day numbers (1=Mon, 7=Sun) for weekly streaks';

-- ============================================
-- 3. DAILY REPORTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS daily_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_date DATE UNIQUE NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_daily_reports_date ON daily_reports(report_date DESC);

COMMENT ON TABLE daily_reports IS 'Generated daily progress reports with AI analysis';
COMMENT ON COLUMN daily_reports.report_markdown IS 'Full formatted Arabic report';
COMMENT ON COLUMN daily_reports.achievement_time_minutes IS 'Total productive time for the day';

-- ============================================
-- 4. WEEKLY GOALS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS weekly_goals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  week_start_date DATE NOT NULL,
  week_end_date DATE NOT NULL,
  goals_text TEXT NOT NULL,
  evaluation_text TEXT,
  completion_rate NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT valid_week_dates CHECK (week_end_date > week_start_date)
);

CREATE INDEX IF NOT EXISTS idx_weekly_goals_dates ON weekly_goals(week_start_date DESC);

COMMENT ON TABLE weekly_goals IS 'Weekly goals generated every Friday';
COMMENT ON COLUMN weekly_goals.goals_text IS 'AI-generated goals for the week';
COMMENT ON COLUMN weekly_goals.evaluation_text IS 'Evaluation of previous week goals';

-- ============================================
-- 5. DAILY CHALLENGES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS daily_challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_date DATE UNIQUE NOT NULL,
  challenge_text TEXT NOT NULL,
  result BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_challenges_date ON daily_challenges(challenge_date DESC);

COMMENT ON TABLE daily_challenges IS 'Daily challenges extracted from weekly goals';
COMMENT ON COLUMN daily_challenges.result IS 'True if challenge was met, False if failed, NULL if not evaluated yet';

-- ============================================
-- 6. MEMORY TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS memory (
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

COMMENT ON TABLE memory IS 'Organized memory categories for AI context';
COMMENT ON COLUMN memory.last_optimized IS 'Last time AI optimized/consolidated this category';

-- ============================================
-- 7. SETTINGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE settings IS 'System configuration and API keys';

-- ============================================
-- 8. CONVERSATION STATE TABLE (for Q&A flow)
-- ============================================
CREATE TABLE IF NOT EXISTS conversation_state (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  chat_id TEXT NOT NULL,
  conversation_type TEXT NOT NULL,
  current_step INTEGER DEFAULT 0,
  total_steps INTEGER DEFAULT 0,
  data JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_chat_id ON conversation_state(chat_id);
CREATE INDEX IF NOT EXISTS idx_conversation_expires ON conversation_state(expires_at);

COMMENT ON TABLE conversation_state IS 'Temporary storage for multi-step conversations';
COMMENT ON COLUMN conversation_state.conversation_type IS 'Type of conversation: qa_flow, report_confirmation, etc.';

-- ============================================
-- 9. INSERT DEFAULT SETTINGS
-- ============================================

-- Insert memory categories with empty content
INSERT INTO memory (category, content) VALUES
  ('Personal Insights & Patterns', ''),
  ('Successful Strategies & What Works', ''),
  ('Triggers & Challenges', ''),
  ('Important Milestones & Breakthroughs', ''),
  ('Recurring Themes & Lessons', ''),
  ('Personal Information & Facts', '')
ON CONFLICT (category) DO NOTHING;

-- Insert default settings (replace with your actual values during setup)
INSERT INTO settings (key, value) VALUES
  ('telegram_bot_token', 'YOUR_TOKEN_HERE'),
  ('telegram_chat_id', 'YOUR_CHAT_ID_HERE'),
  ('telegram_thread_arabic', '149'),
  ('telegram_thread_english', '155'),
  ('telegram_thread_quran', '2053'),
  ('todoist_api_token', 'YOUR_TOKEN_HERE'),
  ('todoist_project_id', '6G5w8P3227Gxp9vw'),
  ('openrouter_api_key', 'YOUR_KEY_HERE'),
  ('ai_model', 'anthropic/claude-sonnet-4'),
  ('google_drive_folder_id', 'YOUR_FOLDER_ID_HERE'),
  ('quran_task_name', 'Reviewing a memorized portion from the the Holy Quran❗'),
  ('quran_spreadsheet_id', '1MHFaNWUyzDaGYRWEJOs8BV_g4JOmoagjnr4ZY0wxg0g'),
  ('timezone', 'Africa/Cairo'),
  ('strategic_goals', '{}')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- 10. HELPER FUNCTIONS
-- ============================================

-- Function to clean up expired conversation states
CREATE OR REPLACE FUNCTION cleanup_expired_states()
RETURNS void AS $$
BEGIN
  DELETE FROM conversation_state WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to get current week's goals
CREATE OR REPLACE FUNCTION get_current_week_goals()
RETURNS TABLE (
  id UUID,
  goals_text TEXT,
  week_start_date DATE,
  week_end_date DATE
) AS $$
BEGIN
  RETURN QUERY
  SELECT wg.id, wg.goals_text, wg.week_start_date, wg.week_end_date
  FROM weekly_goals wg
  WHERE CURRENT_DATE BETWEEN wg.week_start_date AND wg.week_end_date
  ORDER BY wg.week_start_date DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Function to get today's challenge
CREATE OR REPLACE FUNCTION get_today_challenge()
RETURNS TABLE (
  challenge_text TEXT,
  result BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT dc.challenge_text, dc.result
  FROM daily_challenges dc
  WHERE dc.challenge_date = CURRENT_DATE
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 11. ROW LEVEL SECURITY (Optional but recommended)
-- ============================================
-- Uncomment if you want to enable RLS for additional security

-- ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE streaks ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE daily_reports ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE weekly_goals ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE daily_challenges ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE memory ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE conversation_state ENABLE ROW LEVEL SECURITY;

-- Create policies (allow all operations with service role key)
-- CREATE POLICY "Allow all operations" ON tasks FOR ALL USING (true);
-- CREATE POLICY "Allow all operations" ON streaks FOR ALL USING (true);
-- ... repeat for other tables

-- ============================================
-- SCHEMA CREATION COMPLETE
-- ============================================

-- Verify tables were created
SELECT table_name, table_type 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- Show table sizes
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables 
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
