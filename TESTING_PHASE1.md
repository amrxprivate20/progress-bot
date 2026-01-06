# Phase 1 Testing Guide

## 🧪 Complete Testing Checklist

This guide will help you verify that every component of Phase 1 is working correctly.

---

## Prerequisites for Testing

Before testing, ensure:
- [ ] Database tables created in Supabase
- [ ] All settings inserted in database
- [ ] Environment variables configured
- [ ] Worker deployed to Cloudflare
- [ ] Dependencies installed (`npm install`)

---

## Test 1: Environment Validation ✅

**Purpose:** Verify all environment variables are set correctly

### Local Testing:
```bash
# 1. Start local development server
npm run dev

# 2. In another terminal, test health endpoint
curl http://localhost:8787/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "2024-01-05T..."
}
```

### Production Testing:
```bash
curl https://your-worker.workers.dev/health
```

**✅ Pass Criteria:**
- Status is "ok"
- Database is "connected"
- No errors in response

**❌ Common Issues:**
- "database": "disconnected" → Check SUPABASE_URL and SUPABASE_ANON_KEY
- 500 error → Check `wrangler tail` for error details

---

## Test 2: Database Connection ✅

**Purpose:** Verify Supabase connection and queries work

### Test Query:
```bash
# Get all settings
curl http://localhost:8787/api/settings
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "telegram_bot_token": "...",
    "todoist_api_token": "...",
    ...
  }
}
```

### Test Insert:
```bash
# Create a test setting
curl -X POST http://localhost:8787/api/settings \
  -H "Content-Type: application/json" \
  -d '{
    "key": "test_key",
    "value": "test_value"
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Setting updated"
}
```

### Verify in Supabase:
1. Go to Supabase Dashboard
2. Click "Table Editor"
3. Open "settings" table
4. Verify "test_key" exists with value "test_value"

**✅ Pass Criteria:**
- Can retrieve all settings
- Can insert new setting
- Can see setting in Supabase dashboard

---

## Test 3: Settings Management ✅

**Purpose:** Test CRUD operations on settings

### Get Specific Setting:
```bash
curl http://localhost:8787/api/settings/telegram_bot_token
```

### Update Setting:
```bash
curl -X POST http://localhost:8787/api/settings \
  -H "Content-Type: application/json" \
  -d '{
    "key": "test_key",
    "value": "updated_value"
  }'
```

### Delete Setting:
```bash
curl -X DELETE http://localhost:8787/api/settings/test_key
```

**✅ Pass Criteria:**
- All CRUD operations work
- Changes persist in database
- Appropriate status codes (200, 404, etc.)

---

## Test 4: Todoist Webhook ✅

**Purpose:** Verify Todoist webhooks are received and processed

### Step 1: Deploy Worker
```bash
npm run deploy
```

Note your worker URL (e.g., `https://progress-bot.your-name.workers.dev`)

### Step 2: Configure Todoist Webhook

1. Go to [Todoist Developer Console](https://developer.todoist.com/)
2. Create a new app (if not exists)
3. Go to Webhooks section
4. Add webhook:
   - URL: `https://your-worker.workers.dev/webhook/todoist`
   - Events: Select "item:completed"

### Step 3: Complete a Task in Todoist

1. Open Todoist
2. Create a test task: "Test task [30m]"
3. Make sure it's in your tracked project
4. Complete the task

### Step 4: Monitor Logs
```bash
npm run tail
```

**Expected Logs:**
```
Task completed: Test task [30m]
```

### Step 5: Verify in Database

Go to Supabase → Table Editor → `tasks` table

**Expected:**
- New row with your task
- `content`: "Test task [30m]"
- `duration_minutes`: 30
- `status`: "done"

**✅ Pass Criteria:**
- Webhook received (check logs)
- Task saved in database
- Duration parsed correctly
- No errors

**❌ Common Issues:**
- Webhook not received → Check webhook URL in Todoist
- Task not saved → Check project ID in settings
- Duration not parsed → Check task format

---

## Test 5: Telegram Bot ✅

**Purpose:** Verify bot responds to commands

### Step 1: Set Telegram Webhook
```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -d "url=https://your-worker.workers.dev/telegram/webhook"
```

**Expected Response:**
```json
{
  "ok": true,
  "result": true,
  "description": "Webhook was set"
}
```

### Step 2: Verify Webhook
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

**Expected:**
- `url` shows your worker URL
- `pending_update_count` is 0
- `last_error_date` is not present

### Step 3: Test Bot Commands

Open Telegram and send these commands to your bot:

#### Test /start
```
/start
```

**Expected Response:**
```
👋 مرحباً! أنا بوت تتبع التقدم الخاص بك.

*الأوامر المتاحة:*
...
```

#### Test /help
```
/help
```

**Expected Response:**
```
*📖 دليل الاستخدام*
...
```

#### Test /memory
```
/memory
```

**Expected Response:**
```
🔄 جاري تحميل الذاكرة...
*🧠 الذاكرة المنظمة*
...
```

**✅ Pass Criteria:**
- All commands respond
- Messages are in Arabic
- No errors in logs
- Bot is responsive (< 1 second)

---

## Test 6: Duplicate Detection ✅

**Purpose:** Verify tasks aren't duplicated within 20-minute window

### Test Procedure:

1. Complete a task in Todoist
2. Immediately complete the same task again (or manually trigger webhook)
3. Check database

**Expected:**
- Only ONE task entry in database
- Second webhook ignored

### Manual Test:
```bash
# Send same webhook twice
curl -X POST http://localhost:8787/webhook/todoist \
  -H "Content-Type: application/json" \
  -d '{
    "event_name": "item:completed",
    "event_data": {
      "id": "test_123",
      "content": "Test task",
      "project_id": "YOUR_PROJECT_ID",
      "priority": 1,
      "checked": true,
      "completed_at": "2024-01-05T12:00:00Z",
      "added_at": "2024-01-05T12:00:00Z"
    }
  }'
```

Run twice, check database - should have only 1 entry.

**✅ Pass Criteria:**
- Second identical webhook within 20 minutes is ignored
- No duplicate entries in database

---

## Test 7: Task Metadata Parsing ✅

**Purpose:** Verify task content is parsed correctly

### Test Cases:

#### Duration (minutes):
Task: `"Write code [45m]"`
Expected: `duration_minutes: 45`

#### Duration (hours):
Task: `"Study [2h]"`
Expected: `duration_minutes: 120`

#### Quantity:
Task: `"Read [5 pages]"`
Expected: `quantity: 5, quantity_unit: "pages"`

#### Category:
Task: `"Exercise #health"`
Expected: `category: "health"`

#### Origin task:
Task: `"Task (origin: Daily Review)"`
Expected: `is_origin: false, origin_task: "Daily Review"`

#### Origin marker:
Task: `"Daily Review❗"`
Expected: `is_origin: true`

### Testing Method:

Complete tasks with these formats in Todoist, then verify in database:

```sql
SELECT 
  content,
  duration_minutes,
  quantity,
  quantity_unit,
  category,
  is_origin,
  origin_task
FROM tasks
ORDER BY completed_at DESC
LIMIT 10;
```

**✅ Pass Criteria:**
- All formats parsed correctly
- Edge cases handled (empty values, invalid formats)

---

## Test 8: Streak Tracking ✅

**Purpose:** Verify streaks are calculated correctly

### Test Procedure:

1. Complete a recurring task today
2. Check `streaks` table in Supabase
3. Complete same task tomorrow
4. Verify streak increased

### SQL Query:
```sql
SELECT * FROM streaks 
WHERE task_name = 'Your Task Name'
ORDER BY updated_at DESC;
```

**Expected for Day 1:**
- `current_streak: 1`
- `best_streak: 1`
- `last_completed_date: today's date`

**Expected for Day 2 (consecutive):**
- `current_streak: 2`
- `best_streak: 2`
- `last_completed_date: tomorrow's date`

**Expected if Day Skipped:**
- `current_streak: 1` (reset)
- `best_streak: 2` (preserved)

**✅ Pass Criteria:**
- Streak created on first completion
- Streak increments on consecutive days
- Streak resets on missed days
- Best streak preserved

---

## Test 9: Error Handling ✅

**Purpose:** Verify system handles errors gracefully

### Test Invalid Webhook:
```bash
curl -X POST http://localhost:8787/webhook/todoist \
  -H "Content-Type: application/json" \
  -d '{"invalid": "data"}'
```

**Expected Response:**
```json
{
  "success": false,
  "error": "Invalid webhook payload",
  "details": [...]
}
```

### Test Wrong Project:
```bash
curl -X POST http://localhost:8787/webhook/todoist \
  -H "Content-Type: application/json" \
  -d '{
    "event_name": "item:completed",
    "event_data": {
      "id": "123",
      "content": "Task",
      "project_id": "WRONG_PROJECT_ID",
      "checked": true,
      "completed_at": "2024-01-05T12:00:00Z"
    }
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "message": "Ignored task from different project: WRONG_PROJECT_ID"
}
```

**✅ Pass Criteria:**
- Appropriate error messages
- Proper HTTP status codes
- System doesn't crash
- Errors logged properly

---

## Test 10: Performance ✅

**Purpose:** Verify system meets performance requirements

### Webhook Response Time:
```bash
time curl -X POST http://localhost:8787/webhook/todoist \
  -H "Content-Type: application/json" \
  -d @test_webhook.json
```

**Requirement:** < 500ms

### Database Query Time:

Monitor in Supabase Dashboard → Logs

**Requirement:** < 100ms per query

### Bot Response Time:

Send command to bot, measure response time

**Requirement:** < 1 second

**✅ Pass Criteria:**
- All operations meet timing requirements
- No timeouts
- Consistent performance

---

## Test 11: End-to-End Flow ✅

**Purpose:** Test complete workflow from task completion to notification

### Procedure:

1. **Complete Task in Todoist:**
   - Task: "Test E2E Flow [15m] #testing"

2. **Monitor Logs:**
   ```bash
   npm run tail
   ```

3. **Verify Database:**
   - Check `tasks` table has new entry
   - Check `streaks` table updated (if recurring)

4. **Check Telegram:**
   - Should receive notification
   - Message should include:
     - Task name
     - Duration (15m)
     - Category (#testing)

**✅ Pass Criteria:**
- Task captured in < 5 seconds
- Database updated correctly
- Telegram notification sent
- All data accurate

---

## Troubleshooting Guide

### Issue: Database connection fails

**Check:**
1. SUPABASE_URL format: `https://xxxxx.supabase.co`
2. SUPABASE_ANON_KEY is correct (from Supabase settings)
3. Supabase project is not paused

**Fix:**
```bash
# Re-set secrets
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY

# Redeploy
npm run deploy
```

### Issue: Telegram bot not responding

**Check:**
1. Bot token is correct
2. Webhook is set (use getWebhookInfo)
3. Chat ID is correct (use getUpdates to find it)

**Fix:**
```bash
# Delete and re-set webhook
curl -X POST "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://your-worker.workers.dev/telegram/webhook"
```

### Issue: Todoist webhook not received

**Check:**
1. Webhook URL is publicly accessible
2. Project ID matches in settings
3. App has webhook permissions

**Fix:**
1. Verify webhook in Todoist Developer Console
2. Check `npm run tail` for any errors
3. Test with manual curl request first

### Issue: Tasks not saved

**Check:**
1. Project ID in settings matches Todoist
2. Task has valid data
3. Database has space (free tier limit)

**Fix:**
```sql
-- Check recent tasks
SELECT * FROM tasks ORDER BY created_at DESC LIMIT 5;

-- Check project ID setting
SELECT * FROM settings WHERE key = 'todoist_project_id';
```

---

## Performance Benchmarks

After all tests pass, run these benchmarks:

### 1. Webhook Processing:
- **Target:** < 500ms
- **Test:** Complete 10 tasks rapidly
- **Check:** All processed within time

### 2. Database Queries:
- **Target:** < 100ms
- **Test:** Run complex query
- **Check:** Execution time in logs

### 3. Bot Commands:
- **Target:** < 1 second response
- **Test:** Send 5 commands rapidly
- **Check:** All respond quickly

### 4. Memory Usage:
- **Target:** < 128MB
- **Check:** Cloudflare Workers dashboard

---

## Final Verification Checklist

Before proceeding to Phase 2, verify:

- [ ] All 11 tests pass
- [ ] No errors in production logs for 1 hour
- [ ] Todoist tasks captured reliably
- [ ] Telegram bot responsive
- [ ] Database queries fast
- [ ] Streaks calculated correctly
- [ ] Duplicate detection works
- [ ] Error handling graceful
- [ ] Settings CRUD works
- [ ] Performance meets requirements

**✅ Phase 1 is complete when all boxes are checked!**

---

## Getting Help

If tests fail:

1. Check `npm run tail` logs
2. Review Supabase logs
3. Verify environment variables
4. Review this testing guide's troubleshooting section
5. Check Cloudflare Workers dashboard for errors

**Common Commands:**
```bash
# View logs
npm run tail

# Restart dev server
npm run dev

# Redeploy
npm run deploy

# Check webhook info
curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo
```
