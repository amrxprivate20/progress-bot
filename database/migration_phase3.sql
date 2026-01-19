-- ============================================
-- Phase 3 Migration Script
-- ============================================
-- Run this script in Supabase SQL Editor to add Phase 3 features
-- Safe to run multiple times (uses IF NOT EXISTS)

-- ============================================
-- 1. JOURNAL ENTRIES TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS journal_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_date DATE NOT NULL,
  message_text TEXT,
  media_url TEXT,
  media_type TEXT CHECK (media_type IN ('image', 'video', 'document', 'voice')),
  entry_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  is_session_start BOOLEAN DEFAULT false,
  is_session_end BOOLEAN DEFAULT false
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_order ON journal_entries(entry_date, entry_order);

-- Add comments
COMMENT ON TABLE journal_entries IS 'Daily journal entries with text and media support';
COMMENT ON COLUMN journal_entries.entry_date IS 'Egypt date for the entry (YYYY-MM-DD)';
COMMENT ON COLUMN journal_entries.entry_order IS 'Order of entry within the day (1, 2, 3...)';
COMMENT ON COLUMN journal_entries.is_session_start IS 'Marks the start of a journaling session';
COMMENT ON COLUMN journal_entries.is_session_end IS 'Marks the end of a journaling session';
COMMENT ON COLUMN journal_entries.media_url IS 'Telegram file_id for media';
COMMENT ON COLUMN journal_entries.media_type IS 'Type: image, video, or document';

-- ============================================
-- 2. NEW SETTINGS
-- ============================================

-- Add Google Service Account setting
INSERT INTO settings (key, value) VALUES
  ('google_service_account', '{}')
ON CONFLICT (key) DO NOTHING;

-- Ensure strategic_goals setting exists
INSERT INTO settings (key, value) VALUES
  ('strategic_goals', '')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- 3. VERIFY EXISTING TABLES
-- ============================================

-- Make sure weekly_goals table exists (from Phase 2)
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

-- Make sure daily_challenges table exists (from Phase 2)
CREATE TABLE IF NOT EXISTS daily_challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_date DATE UNIQUE NOT NULL,
  challenge_text TEXT NOT NULL,
  result BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_challenges_date ON daily_challenges(challenge_date DESC);

-- ============================================
-- 4. HELPER FUNCTIONS
-- ============================================

-- Function to get journal entries for a date
CREATE OR REPLACE FUNCTION get_journal_entries(target_date DATE)
RETURNS TABLE (
  id UUID,
  message_text TEXT,
  media_url TEXT,
  media_type TEXT,
  entry_order INTEGER,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT j.id, j.message_text, j.media_url, j.media_type, j.entry_order, j.created_at
  FROM journal_entries j
  WHERE j.entry_date = target_date
    AND (j.message_text IS NOT NULL OR j.media_url IS NOT NULL)
  ORDER BY j.entry_order;
END;
$$ LANGUAGE plpgsql;

-- Function to check if journal session is active
CREATE OR REPLACE FUNCTION is_journal_session_active(target_date DATE)
RETURNS BOOLEAN AS $$
DECLARE
  has_start BOOLEAN;
  has_end BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM journal_entries WHERE entry_date = target_date AND is_session_start = true) INTO has_start;
  SELECT EXISTS(SELECT 1 FROM journal_entries WHERE entry_date = target_date AND is_session_end = true) INTO has_end;
  RETURN has_start AND NOT has_end;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 5. VERIFICATION
-- ============================================

-- Show all tables
SELECT table_name,
       (SELECT COUNT(*) FROM information_schema.columns WHERE columns.table_name = tables.table_name) as column_count
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- Show Phase 3 specific settings
SELECT key,
       CASE
         WHEN key = 'google_service_account' THEN LEFT(value, 50) || '...'
         ELSE value
       END as value_preview
FROM settings
WHERE key IN ('google_drive_folder_id', 'google_service_account', 'strategic_goals');

-- ============================================
-- MIGRATION COMPLETE
-- ============================================
-- Phase 3 tables and settings are now ready!
