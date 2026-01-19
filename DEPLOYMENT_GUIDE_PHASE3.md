# Phase 3 Deployment Guide

## Overview

Phase 3 adds the following features:
1. **Journal System** - Daily journaling with text and media support
2. **Weekly Goals Generation** - AI-powered goal creation and tracking
3. **Todoist Task Creation** - Create tasks in Todoist from goals
4. **Google Drive Integration** - Auto-save reports to Google Drive

---

## Step 1: Database Migration

Run the following SQL in your Supabase SQL Editor:

```sql
-- ============================================
-- PHASE 3 DATABASE MIGRATION
-- ============================================

-- 1. Create journal_entries table
CREATE TABLE IF NOT EXISTS journal_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_date DATE NOT NULL,
  message_text TEXT,
  media_url TEXT,
  media_type TEXT CHECK (media_type IN ('image', 'video', 'document')),
  entry_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  is_session_start BOOLEAN DEFAULT false,
  is_session_end BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_order ON journal_entries(entry_date, entry_order);

COMMENT ON TABLE journal_entries IS 'Daily journal entries with text and media support';

-- 2. Add Google Service Account setting
INSERT INTO settings (key, value) VALUES
  ('google_service_account', '{}')
ON CONFLICT (key) DO NOTHING;

-- 3. Verify tables exist
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('journal_entries', 'weekly_goals', 'daily_challenges');
```

---

## Step 2: Configure Settings

### 2.1 Google Drive Setup (Optional)

To enable Google Drive integration:

1. **Create a Google Cloud Project**
   - Go to [Google Cloud Console](https://console.cloud.google.com)
   - Create a new project or select existing
   - Enable the Google Drive API

2. **Create a Service Account**
   - Go to IAM & Admin > Service Accounts
   - Click "Create Service Account"
   - Name it (e.g., "progress-bot-drive")
   - Grant role: "Editor" or custom Drive role
   - Create and download JSON key

3. **Share Drive Folder**
   - Create a folder in Google Drive for reports
   - Right-click > Share
   - Add the service account email (from JSON key)
   - Give "Editor" access

4. **Configure Settings in Supabase**

```sql
-- Update Google Drive settings
UPDATE settings
SET value = 'YOUR_FOLDER_ID_HERE'
WHERE key = 'google_drive_folder_id';

-- Add service account credentials (paste full JSON)
UPDATE settings
SET value = '{
  "type": "service_account",
  "project_id": "your-project-id",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "your-service@your-project.iam.gserviceaccount.com",
  "client_id": "...",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "..."
}'
WHERE key = 'google_service_account';
```

> **Note**: The folder ID is the last part of the Drive folder URL:
> `https://drive.google.com/drive/folders/FOLDER_ID_HERE`

### 2.2 Todoist Setup

Ensure your Todoist API token and project ID are configured:

```sql
-- Verify Todoist settings
SELECT key, value FROM settings
WHERE key IN ('todoist_api_token', 'todoist_project_id');
```

### 2.3 Strategic Goals (Optional)

Set your long-term strategic goals for better AI-generated weekly goals:

```sql
UPDATE settings
SET value = 'أهدافي الاستراتيجية:
1. تحسين الصحة البدنية والنفسية
2. تطوير المهارات المهنية
3. قراءة 20 كتاب هذا العام
4. الحفاظ على العلاقات الاجتماعية'
WHERE key = 'strategic_goals';
```

---

## Step 3: Deploy to Cloudflare

```bash
# Navigate to project
cd progress-bot

# Install dependencies (if needed)
npm install

# Build and deploy
npm run deploy
# or
wrangler deploy
```

---

## Step 4: Verify Deployment

### Test Bot Commands

1. **Journal System**
   ```
   /journal_start  → Should start a new session
   [Send a text message] → Should see 📝 ✓
   [Send a photo] → Should see 📷 ✓
   /journal_end → Should end session with count
   ```

2. **Goals System**
   ```
   /goals → View current week's goals (may be empty)
   /generate_goals → Generate new goals (requires AI)
   ```

3. **Todoist Integration**
   ```
   /createtasks → Create tasks from goals
   ```

4. **Full Report Flow**
   ```
   /progress → View today's summary (includes journal if active)
   /confirm → Start AI analysis (saves to Drive if configured)
   ```

---

## New Bot Commands Reference

| Command | Description | Notes |
|---------|-------------|-------|
| `/journal_start` | Start daily journaling session | Only one session per day |
| `/journal_end` | End and save journal session | Shows entry count |
| `/journal_resume` | Resume a closed session | Reopens ended session |
| `/goals` | View weekly goals & daily challenge | Shows current week |
| `/generate_goals` | Generate new weekly goals | Best on Fridays |
| `/createtasks` | Create Todoist tasks from goals | Requires goals first |

---

## Configuration Reference

### Required Settings

| Key | Description | Example |
|-----|-------------|---------|
| `openrouter_api_key` | OpenRouter API key | `sk-or-v1-...` |
| `telegram_bot_token` | Telegram bot token | `123456:ABC...` |
| `todoist_api_token` | Todoist API token | `abc123...` |
| `todoist_project_id` | Todoist project ID | `2349872384` |

### Optional Settings (Phase 3)

| Key | Description | Default |
|-----|-------------|---------|
| `google_drive_folder_id` | Drive folder for reports | Empty (disabled) |
| `google_service_account` | Service account JSON | `{}` (disabled) |
| `strategic_goals` | Long-term goals text | Empty |

---

## Troubleshooting

### Journal Not Saving

1. Check if session is active: `/journal_start`
2. Verify database table exists
3. Check Cloudflare logs for errors

### Goals Generation Failing

1. Verify OpenRouter API key is valid
2. Check API rate limits
3. Ensure `strategic_goals` setting exists

### Google Drive Not Working

1. Verify folder ID is correct
2. Check service account has access to folder
3. Verify JSON credentials are valid
4. Check Cloudflare logs for auth errors

### Todoist Tasks Not Creating

1. Verify Todoist API token
2. Check project ID is correct
3. Ensure weekly goals exist first
4. Check rate limits (450/15min)

---

## Rollback

If you need to rollback Phase 3:

```sql
-- Remove journal entries table (CAUTION: deletes data)
DROP TABLE IF EXISTS journal_entries;

-- Remove new setting
DELETE FROM settings WHERE key = 'google_service_account';
```

Then redeploy with the previous version of the code.

---

## Next Steps

After successful deployment:

1. Test all new commands
2. Generate first weekly goals with `/generate_goals`
3. Create tasks with `/createtasks`
4. Start journaling with `/journal_start`
5. Run a full report with `/confirm` to test Drive integration

---

## Support

If you encounter issues:
1. Check Cloudflare Workers logs
2. Verify Supabase connection
3. Test each component individually
4. Review error messages in Telegram
