-- ============================================
-- Migration 004: Interactive Coaching Tables
-- ============================================
-- Tables for tracking coach check-in conversations
-- and measuring coaching effectiveness

-- ============================================
-- 1. PENDING CHECK-INS TABLE
-- ============================================
-- Tracks active coach conversations so text responses are handled
CREATE TABLE IF NOT EXISTS pending_checkins (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  intervention_type TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  conversation_turns INTEGER DEFAULT 0,
  max_turns INTEGER DEFAULT 3,
  status TEXT CHECK (status IN ('active', 'completed', 'expired')) DEFAULT 'active',
  user_mood TEXT CHECK (user_mood IN ('high', 'normal', 'low')),
  messages_received INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_checkins_chat_status ON pending_checkins(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_checkins_expires ON pending_checkins(expires_at);

-- ============================================
-- 2. COACHING EFFECTIVENESS TABLE
-- ============================================
-- Tracks which interventions lead to action for adaptive coaching
CREATE TABLE IF NOT EXISTS coaching_effectiveness (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  chat_id TEXT NOT NULL,
  intervention_type TEXT NOT NULL,
  led_to_action BOOLEAN DEFAULT FALSE,
  response_time_seconds INTEGER,
  outcome TEXT,
  user_mood TEXT,
  recorded_date TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coaching_effectiveness_chat ON coaching_effectiveness(chat_id, recorded_date);
CREATE INDEX IF NOT EXISTS idx_coaching_effectiveness_type ON coaching_effectiveness(intervention_type);

-- ============================================
-- RLS Policies
-- ============================================
ALTER TABLE pending_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_effectiveness ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for anon on pending_checkins" ON pending_checkins
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for anon on coaching_effectiveness" ON coaching_effectiveness
  FOR ALL USING (true) WITH CHECK (true);
