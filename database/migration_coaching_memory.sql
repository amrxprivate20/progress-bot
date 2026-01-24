-- Coaching Memory & Auto-Detection Migration
-- ==========================================
-- Adds: coaching interactions table, memory categories, auto-coach settings
-- Run this migration in Supabase SQL editor

-- 1. Coaching Interactions Table (Short-term Daily Memory)
-- ========================================================
CREATE TABLE IF NOT EXISTS coaching_interactions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  chat_id TEXT NOT NULL,
  interaction_date DATE NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  interaction_type TEXT NOT NULL, -- 'stuck', 'battle', 'dopamine', 'roast', 'checkin', 'auto_probe'
  user_input TEXT,
  bot_response TEXT,
  outcome TEXT, -- 'positive', 'negative', 'neutral', 'pending'
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_coaching_interactions_chat_date
  ON coaching_interactions(chat_id, interaction_date);
CREATE INDEX IF NOT EXISTS idx_coaching_interactions_type
  ON coaching_interactions(interaction_type);
CREATE INDEX IF NOT EXISTS idx_coaching_interactions_timestamp
  ON coaching_interactions(timestamp DESC);

-- 2. Extend Memory Table CHECK Constraint
-- =======================================
-- First, drop the existing constraint
ALTER TABLE memory DROP CONSTRAINT IF EXISTS memory_category_check;

-- Add new constraint with extended categories
ALTER TABLE memory ADD CONSTRAINT memory_category_check CHECK (category IN (
  -- Original categories
  'Personal Insights & Patterns',
  'Successful Strategies & What Works',
  'Triggers & Challenges',
  'Important Milestones & Breakthroughs',
  'Recurring Themes & Lessons',
  'Personal Information & Facts',
  -- New coaching categories
  'Coaching Patterns & What Works',
  'Intervention Effectiveness',
  'User Triggers & Counters'
));

-- 3. Add Coaching Memory Categories
-- =================================
-- Coaching Patterns & What Works
INSERT INTO memory (category, content, last_updated)
VALUES ('Coaching Patterns & What Works', '', NOW())
ON CONFLICT (category) DO NOTHING;

-- Intervention Effectiveness
INSERT INTO memory (category, content, last_updated)
VALUES ('Intervention Effectiveness', '', NOW())
ON CONFLICT (category) DO NOTHING;

-- User Triggers & Counters
INSERT INTO memory (category, content, last_updated)
VALUES ('User Triggers & Counters', '', NOW())
ON CONFLICT (category) DO NOTHING;

-- 4. Auto-Coach Settings
-- ======================
-- Auto mode: hybrid (both scheduled and inactivity)
INSERT INTO settings (key, value, updated_at)
VALUES ('coach.auto_mode', 'hybrid', NOW())
ON CONFLICT (key) DO NOTHING;

-- Inactivity threshold: 2 hours
INSERT INTO settings (key, value, updated_at)
VALUES ('coach.inactivity_threshold_hours', '2', NOW())
ON CONFLICT (key) DO NOTHING;

-- Sleep period start: 11 PM (23:00)
INSERT INTO settings (key, value, updated_at)
VALUES ('coach.sleep_start', '23:00', NOW())
ON CONFLICT (key) DO NOTHING;

-- Sleep period end: 7 AM (07:00)
INSERT INTO settings (key, value, updated_at)
VALUES ('coach.sleep_end', '07:00', NOW())
ON CONFLICT (key) DO NOTHING;

-- Scheduled check-ins: 10 AM, 2 PM, 6 PM
INSERT INTO settings (key, value, updated_at)
VALUES ('coach.scheduled_checkins', '10:00,14:00,18:00', NOW())
ON CONFLICT (key) DO NOTHING;

-- Coaching style: confrontational
INSERT INTO settings (key, value, updated_at)
VALUES ('coach.style', 'confrontational', NOW())
ON CONFLICT (key) DO NOTHING;

-- 5. Daily Cleanup Function (Optional)
-- ====================================
CREATE OR REPLACE FUNCTION cleanup_old_coaching_interactions()
RETURNS void AS $$
BEGIN
  DELETE FROM coaching_interactions
  WHERE interaction_date < CURRENT_DATE - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- 6. Success message
SELECT 'Coaching Memory & Auto-Detection migration completed!' as status;

-- ==============================================
-- SETTINGS REFERENCE
-- ==============================================
--
-- coach.auto_mode:
--   'off'        - No automatic coaching
--   'scheduled'  - Only check-ins at scheduled times
--   'inactivity' - Only probe when inactive
--   'hybrid'     - Both scheduled and inactivity (recommended)
--
-- coach.inactivity_threshold_hours:
--   Number of hours without task completion before probing
--   Recommended: 2 (default)
--
-- coach.sleep_start / coach.sleep_end:
--   Format: 'HH:MM' (24-hour)
--   Bot will NOT probe during this period
--
-- coach.scheduled_checkins:
--   Comma-separated times in 'HH:MM' format
--   Default: '10:00,14:00,18:00'
--
-- coach.style:
--   'confrontational' - Direct, challenging, pushes hard
--   'supportive'      - Encouraging but firm
--   'balanced'        - Adapts based on response
-- ==============================================
