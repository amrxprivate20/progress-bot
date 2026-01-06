# Quick Reference Guide - Phase 1

## 🚀 Common Commands

### Development
```bash
# Start local development server
npm run dev

# View live logs
npm run tail

# Type check without running
npm run type-check
```

### Deployment
```bash
# Deploy to Cloudflare Workers
npm run deploy

# View production logs
wrangler tail --env production
```

### Secrets Management
```bash
# Set a secret
wrangler secret put SECRET_NAME

# List secrets (names only)
wrangler secret list

# Delete a secret
wrangler secret delete SECRET_NAME
```

---

## 🔗 Important URLs

### Supabase
- Dashboard: https://app.supabase.com/
- SQL Editor: Dashboard → SQL Editor
- Table Editor: Dashboard → Table Editor
- API Settings: Dashboard → Settings → API

### Cloudflare
- Workers Dashboard: https://dash.cloudflare.com/
- Your Worker: Dashboard → Workers & Pages → progress-bot
- Logs: Your Worker → Logs

### Todoist
- Developer Console: https://developer.todoist.com/
- API Documentation: https://developer.todoist.com/rest/v2/

### Telegram
- Bot API Docs: https://core.telegram.org/bots/api
- Get Updates: https://api.telegram.org/bot<TOKEN>/getUpdates
- Webhook Info: https://api.telegram.org/bot<TOKEN>/getWebhookInfo

---

## 📊 Database Quick Queries

### View Recent Tasks
```sql
SELECT 
  content,
  completed_at,
  duration_minutes,
  category,
  status
FROM tasks
ORDER BY completed_at DESC
LIMIT 10;
```

### Check Streaks
```sql
SELECT 
  task_name,
  current_streak,
  best_streak,
  last_completed_date
FROM streaks
ORDER BY current_streak DESC;
```

### View All Settings
```sql
SELECT key, value 
FROM settings 
ORDER BY key;
```

### Today's Tasks Count
```sql
SELECT COUNT(*) as total_tasks
FROM tasks
WHERE DATE(completed_at) = CURRENT_DATE;
```

### Tasks by Category
```sql
SELECT 
  category,
  COUNT(*) as count,
  SUM(duration_minutes) as total_minutes
FROM tasks
WHERE category IS NOT NULL
GROUP BY category
ORDER BY count DESC;
```

---

## 🔧 API Endpoints Reference

### Health Check
```bash
GET /health
```

### Todoist Webhook
```bash
POST /webhook/todoist
Content-Type: application/json

{
  "event_name": "item:completed",
  "event_data": { ... }
}
```

### Telegram Webhook
```bash
POST /telegram/webhook
Content-Type: application/json

{ ... telegram update ... }
```

### Settings API

**Get all settings:**
```bash
GET /api/settings
```

**Get specific setting:**
```bash
GET /api/settings/:key
```

**Set setting:**
```bash
POST /api/settings
Content-Type: application/json

{
  "key": "setting_key",
  "value": "setting_value"
}
```

**Delete setting:**
```bash
DELETE /api/settings/:key
```

---

## 🤖 Bot Commands

| Command | Description | Status |
|---------|-------------|--------|
| `/start` | Show welcome message | ✅ Working |
| `/help` | Show help guide | ✅ Working |
| `/progress` | Generate daily report | ⏳ Phase 2 |
| `/confirm` | Confirm report generation | ⏳ Phase 2 |
| `/cancel` | Cancel operation | ✅ Working |
| `/memory` | View organized memory | ✅ Working |
| `/clearmemory` | Clear all memory | ⏳ Phase 2 |
| `/createtasks` | Create tasks from goals | ⏳ Phase 3 |
| `/lastupdate` | Generate status file | ⏳ Phase 3 |

---

## 🔍 Debugging Checklist

### Webhook Not Working?
1. ✅ Check webhook URL is publicly accessible
2. ✅ Verify webhook is set (getWebhookInfo)
3. ✅ Check project ID matches
4. ✅ View logs: `npm run tail`
5. ✅ Test with curl manually

### Database Issues?
1. ✅ Check Supabase project is active
2. ✅ Verify credentials are correct
3. ✅ Test with SQL Editor directly
4. ✅ Check free tier limits
5. ✅ View Supabase logs

### Bot Not Responding?
1. ✅ Verify bot token is correct
2. ✅ Check webhook is set
3. ✅ Test /start command
4. ✅ View Cloudflare logs
5. ✅ Check chat ID is correct

---

## 📝 Task Content Format Examples

### Duration Tracking
- `Task name [30m]` → 30 minutes
- `Task name [2h]` → 120 minutes
- `Task name [1.5h]` → 90 minutes

### Quantity Tracking
- `Read book [5 pages]` → quantity: 5, unit: pages
- `Exercise [3 sets]` → quantity: 3, unit: sets
- `Study [2 chapters]` → quantity: 2, unit: chapters

### Category
- `Task name #work` → category: work
- `Task name #health` → category: health

### Origin Tracking
- `Review❗` → is_origin: true
- `Sub-task (origin: Review)` → origin_task: Review

### Combined
- `Write code [2h] #work` → duration: 120, category: work
- `Exercise [30m] #health` → duration: 30, category: health

---

## 🎯 Environment Variables

### Required
```env
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=-1002194965669
TODOIST_API_TOKEN=your_token_here
```

### Setting Them

**Local Development (.dev.vars):**
```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your values
```

**Production (Cloudflare):**
```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put TODOIST_API_TOKEN
```

---

## 📈 Performance Targets

| Operation | Target | Measured |
|-----------|--------|----------|
| Webhook processing | < 500ms | ___ |
| Database query | < 100ms | ___ |
| Bot response | < 1s | ___ |
| Task notification | < 2s | ___ |

---

## 🆘 Emergency Procedures

### Bot Completely Broken?
```bash
# 1. Delete webhook
curl -X POST "https://api.telegram.org/bot<TOKEN>/deleteWebhook"

# 2. Fix code and redeploy
npm run deploy

# 3. Re-set webhook
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://your-worker.workers.dev/telegram/webhook"
```

### Database Connection Lost?
```bash
# 1. Check Supabase status
# Go to app.supabase.com

# 2. Verify credentials
wrangler secret list

# 3. Re-set credentials
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY

# 4. Redeploy
npm run deploy
```

### Worker Not Responding?
```bash
# 1. Check worker status
# Go to Cloudflare Dashboard

# 2. View logs
npm run tail

# 3. Redeploy
npm run deploy

# 4. Wait 30 seconds and test
curl https://your-worker.workers.dev/health
```

---

## 📞 Getting Help

### Check These First:
1. Cloudflare Worker logs: `npm run tail`
2. Supabase logs: Dashboard → Logs
3. This troubleshooting guide
4. Testing guide: TESTING_PHASE1.md

### Useful Test Commands:
```bash
# Test health
curl https://your-worker.workers.dev/health

# Test settings API
curl https://your-worker.workers.dev/api/settings

# Get bot info
curl https://api.telegram.org/bot<TOKEN>/getMe

# Check webhook status
curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo
```

---

## ✅ Pre-Phase 2 Checklist

Before moving to Phase 2, ensure:

- [ ] Worker deployed and accessible
- [ ] Database tables created
- [ ] All settings configured
- [ ] Todoist webhook receiving events
- [ ] Tasks being saved to database
- [ ] Streaks calculated correctly
- [ ] Telegram bot responding
- [ ] No errors in logs for 1+ hour
- [ ] All 11 tests passing
- [ ] Performance meets targets

**Ready for Phase 2?** Proceed to report generation and AI integration!
