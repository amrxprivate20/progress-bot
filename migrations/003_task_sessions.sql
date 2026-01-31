-- Task Sessions Table for /resumelater feature
-- Allows cumulative time tracking across multiple work sessions on the same task

CREATE TABLE IF NOT EXISTS task_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL,
  task_id TEXT,  -- Todoist ID (nullable for manual tasks)
  task_content TEXT NOT NULL,  -- Task name for matching (CRITICAL: use this, not just task_id)
  total_time_worked INTEGER DEFAULT 0,  -- cumulative minutes
  session_count INTEGER DEFAULT 1,
  first_started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  last_resumed_at TIMESTAMP WITH TIME ZONE,
  last_paused_at TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'abandoned')),
  pause_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for finding sessions by chat and status
CREATE INDEX IF NOT EXISTS idx_task_sessions_chat_status ON task_sessions(chat_id, status);

-- Index for finding sessions by task content (name matching)
CREATE INDEX IF NOT EXISTS idx_task_sessions_task_content ON task_sessions(chat_id, task_content);

-- Index for finding sessions by task_id
CREATE INDEX IF NOT EXISTS idx_task_sessions_task_id ON task_sessions(task_id);

-- Intervention logs table (if not exists) for meta-coach
CREATE TABLE IF NOT EXISTS intervention_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL,
  intervention_type TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intervention_logs_chat ON intervention_logs(chat_id, intervention_type);
