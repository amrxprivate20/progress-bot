-- Phase 1 Coach Features Migration
-- =================================
-- Tables for: Stuck Button, Battle Mode, Dopamine Engine, Roast Mode
-- Run this migration in Supabase SQL editor

-- 1. Intervention Logs (for Stuck Button and general tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS intervention_logs (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  chat_id TEXT NOT NULL,
  intervention_type TEXT NOT NULL, -- 'stuck', 'battle', 'roast', etc.
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intervention_logs_chat ON intervention_logs(chat_id);
CREATE INDEX IF NOT EXISTS idx_intervention_logs_type ON intervention_logs(intervention_type);
CREATE INDEX IF NOT EXISTS idx_intervention_logs_created ON intervention_logs(created_at DESC);

-- 2. Battle States (for Battle Mode)
-- ==================================
CREATE TABLE IF NOT EXISTS battle_states (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  chat_id TEXT NOT NULL,
  battle_date DATE NOT NULL,
  state JSONB NOT NULL, -- Full BattleState object
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(chat_id, battle_date)
);

CREATE INDEX IF NOT EXISTS idx_battle_states_lookup ON battle_states(chat_id, battle_date);

-- 3. Dopamine Rewards (for Dopamine Engine deduplication)
-- =======================================================
CREATE TABLE IF NOT EXISTS dopamine_rewards (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  chat_id TEXT NOT NULL,
  reward_type TEXT NOT NULL, -- 'celebration', 'identity', 'streak', 'surprise', 'milestone'
  theme TEXT, -- For deduplication
  task_id TEXT, -- Optional: link to task
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dopamine_rewards_chat ON dopamine_rewards(chat_id);
CREATE INDEX IF NOT EXISTS idx_dopamine_rewards_created ON dopamine_rewards(created_at DESC);

-- 4. Daily Failures (enhanced for roast mode)
-- ===========================================
CREATE TABLE IF NOT EXISTS daily_failures (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  failure_date DATE NOT NULL UNIQUE,
  last_sync TIMESTAMPTZ DEFAULT NOW(),
  failed_tasks JSONB DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_daily_failures_lookup ON daily_failures(failure_date DESC);

-- 5. Coach Settings (Phase 1 feature toggles)
-- ===========================================
INSERT INTO settings (key, value, updated_at)
VALUES
  ('interventions.stuck_button', 'true', NOW()),
  ('gamification.battle_mode', 'true', NOW()),
  ('gamification.dopamine_hits', 'true', NOW()),
  ('coach.roast_mode', 'true', NOW())
ON CONFLICT (key) DO NOTHING;

-- Success message
SELECT 'Phase 1 Coach Features migration completed successfully!' as status;
