# Deployment Guide - Phase 1

## 🎯 Complete Step-by-Step Deployment

This guide walks you through deploying your Progress Bot from scratch.

---

## ⏱ Estimated Time
- **First-time setup:** 30-45 minutes
- **Subsequent deployments:** 2-5 minutes

---

## 📋 Prerequisites Checklist

Before starting, have these ready:

- [ ] Node.js v18+ installed
- [ ] npm installed
- [ ] Git installed (optional but recommended)
- [ ] Supabase account created
- [ ] Cloudflare account created
- [ ] Todoist account with API access
- [ ] Telegram account
- [ ] Code editor (VS Code recommended)

---

## Part 1: Supabase Setup (10-15 minutes)

### Step 1: Create Supabase Project

1. Go to https://app.supabase.com/
2. Click "New Project"
3. Fill in details:
   - **Name:** `progress-bot`
   - **Database Password:** Create a strong password (maro23419810)
   - **Region:** Choose closest to you (Frankfurt or Dubai for Egypt)
4. Click "Create new project"
5. Wait ~2 minutes for setup

### Step 2: Get API Credentials

1. Once ready, go to **Settings** (gear icon)
2. Click **API**
3. Copy these values (save them):
   - **Project URL:** `https://yucungsttnauqwrdwvcu.supabase.co`
   - **anon public key:** starts with `sb_publishable_sdPnn6QsdcTMB8yfOabedg_YE0NIhMG`

### Step 3: Create Database Tables

1. Click **SQL Editor** in left sidebar
2. Click **New Query**
3. Copy entire contents of `database/schema.sql` from this project
4. Paste into SQL Editor
5. Click **Run** (or press Cmd/Ctrl + Enter)
6. Wait for "Success" message

### Step 4: Update Settings

1. Go to **Table Editor**
2. Open **settings** table
3. Click on each row and update the `value` with your actual credentials:
   - `telegram_bot_token` → (get from BotFather - see Part 2)
   - `telegram_chat_id` → (get from Part 3)
   - `todoist_api_token` → (get from Part 4)
   - `todoist_project_id` → (get from Part 4)
4. Leave other settings as defaults for now

✅ **Supabase Setup Complete!**

---

## Part 2: Telegram Bot Setup (5 minutes)

### Step 1: Create Bot

1. Open Telegram
2. Search for `@BotFather`
3. Send `/newbot`
4. Follow prompts:
   - **Bot name:** `My Progress Bot` (or your choice)
   - **Username:** `yourname_progress_bot` (must end with `bot`)
5. Copy the **bot token** (looks like `123456789:ABCdef...`)
6. Save it for later

### Step 2: Get Chat ID

**Method 1: Using Your Bot**
1. Send any message to your bot
2. Visit this URL in browser (replace `<YOUR_BOT_TOKEN>`):
   ```
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
   ```
3. Look for `"chat":{"id":` and copy the number (e.g., `-1002194965669`)

**Method 2: Using Bot**
1. Add your bot to a group/channel
2. Send a message
3. Use getUpdates URL above
4. Copy the chat ID

### Step 3: Update Settings in Supabase

1. Go back to Supabase Table Editor
2. Update `telegram_bot_token` with your bot token
3. Update `telegram_chat_id` with your chat ID

✅ **Telegram Bot Setup Complete!**

---

## Part 3: Todoist Setup (5 minutes)

### Step 1: Get API Token

1. Go to https://todoist.com/app/settings/integrations
2. Scroll to **Developer** section
3. Find **API token**
4. Click "Copy to clipboard"

### Step 2: Get Project ID

1. Open Todoist
2. Go to the project you want to track
3. Look at the URL:
   ```
   https://todoist.com/app/project/2XXXXXXX
   ```
4. Copy the project ID (the number/code after `/project/`)

**Alternative method:**
1. Go to https://developer.todoist.com/rest/v2/#overview
2. Click "Try the API"
3. Use the `/rest/v2/projects` endpoint
4. Find your project in the response and copy its `id`

### Step 3: Update Settings in Supabase

1. Go back to Supabase Table Editor
2. Update `todoist_api_token` with your API token
3. Update `todoist_project_id` with your project ID

✅ **Todoist Setup Complete!**

---

## Part 4: Local Development (10 minutes)

### Step 1: Clone/Download Project

If using Git:
```bash
git clone https://github.com/amrxprivate20/progress-bot
cd progress-bot
```

Or extract the project files to a folder.

### Step 2: Install Dependencies

```bash
npm install
```

This will install:
- Grammy (Telegram bot framework)
- Wrangler (Cloudflare Workers CLI)
- TypeScript and dependencies

### Step 3: Configure Environment

1. Copy the example env file:
   ```bash
   cp .dev.vars.example .dev.vars
   ```

2. Edit `.dev.vars`:
   ```env
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_ANON_KEY=eyJhbGc...
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_CHAT_ID=-1002194965669
   TODOIST_API_TOKEN=your_token_here
   ```

3. Save the file

### Step 4: Test Locally

```bash
npm run dev
```

In another terminal:
```bash
curl http://localhost:8787/health
```

**Expected response:**
```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "..."
}
```

If you see this, local setup is working! ✅

---

## Part 5: Cloudflare Workers Deployment (10-15 minutes)

### Step 1: Install Wrangler (if not installed)

```bash
npm install -g wrangler
```

### Step 2: Login to Cloudflare

```bash
wrangler login
```

This will open a browser window. Authorize the connection.

### Step 3: Configure Wrangler

1. Open `wrangler.toml`
2. If needed, update the `name` (default: `progress-bot`)
3. Optionally add your `account_id` (found in Cloudflare Dashboard)

### Step 4: Set Production Secrets

**Important:** Don't put secrets in wrangler.toml!

```bash
# Set each secret
wrangler secret put SUPABASE_URL
# Paste your Supabase URL when prompted

wrangler secret put SUPABASE_ANON_KEY
# Paste your Supabase anon key

wrangler secret put TELEGRAM_BOT_TOKEN
# Paste your bot token

wrangler secret put TELEGRAM_CHAT_ID
# Paste your chat ID

wrangler secret put TODOIST_API_TOKEN
# Paste your Todoist token
```

### Step 5: Deploy

```bash
npm run deploy
```

**Expected output:**
```
Published progress-bot
  https://progress-bot.progressbot.workers.dev
```

**Copy this URL!** You'll need it for webhooks.

### Step 6: Verify Deployment

```bash
curl https://progress-bot.progressbot.workers.dev/health
```

**Expected response:**
```json
{
  "status": "ok",
  "database": "connected"
}
```

✅ **Deployment Complete!**

---

## Part 6: Configure Webhooks (5 minutes)

### Step 1: Set Telegram Webhook

```bash
curl -X POST "https://api.telegram.org/bot7237718018:AAEYT7PatDELEbKjE3U4AnVlhUSrWCSNWKY/setWebhook" \
  -d "url=https://progress-bot.progressbot.workers.dev/telegram/webhook"
```

**Expected response:**
```json
{
  "ok": true,
  "result": true,
  "description": "Webhook was set"
}
```

### Step 2: Verify Telegram Webhook

```bash
curl "https://api.telegram.org/bot7237718018:AAEYT7PatDELEbKjE3U4AnVlhUSrWCSNWKY/getWebhookInfo"
```

**Should show:**
- `url`: Your worker URL
- `pending_update_count`: 0
- No `last_error_date`

### Step 3: Set Todoist Webhook

1. Go to https://developer.todoist.com/
2. Create a new app (or use existing)
3. Go to **Webhooks** section
4. Click "Add webhook"
5. Fill in:
   - **Callback URL:** `https://progress-bot.progressbot.workers.dev/webhook/todoist`
   - **Events:** Select "item:completed"
6. Click "Add webhook"

✅ **All Webhooks Configured!**

---

## Part 7: Testing (10 minutes)

### Test 1: Health Check ✅
```bash
curl https://progress-bot.progressbot.workers.dev/health
```
Should return: `{"status":"ok","database":"connected"}`

### Test 2: Telegram Bot ✅
1. Open Telegram
2. Find your bot
3. Send `/start`
4. Should receive welcome message in Arabic

### Test 3: Todoist Integration ✅
1. Open Todoist
2. Create a task: `"Test task [30m]"`
3. Complete the task
4. Check Supabase → Table Editor → `tasks` table
5. Should see your task there

### Test 4: View Logs ✅
```bash
npm run tail
```

Leave this running and:
1. Complete a task in Todoist
2. Send a command to bot
3. Watch logs appear in real-time

✅ **All Tests Passed!**

---

## Part 8: Final Verification

Run through the complete **TESTING_PHASE1.md** guide to ensure everything works.

**Minimum tests to pass:**
- [ ] Health endpoint returns OK
- [ ] Can create/read settings via API
- [ ] Todoist tasks are captured
- [ ] Tasks appear in database
- [ ] Telegram bot responds to commands
- [ ] No errors in logs

---

## 🎉 Deployment Complete!

Your Progress Bot is now live and running!

### What's Working:
✅ Todoist webhook receiving task completions
✅ Tasks being saved to database
✅ Streak tracking
✅ Telegram bot responding to commands
✅ Settings management API

### Next Steps:
1. Monitor logs for a few hours: `npm run tail`
2. Complete some tasks in Todoist to test
3. Verify data in Supabase
4. Once stable, proceed to **Phase 2**

---

## 🔄 Updating After Changes

After modifying code:

```bash
# 1. Test locally
npm run dev

# 2. Deploy
npm run deploy

# 3. Monitor
npm run tail
```

No need to reconfigure webhooks unless URLs change.

---

## 🆘 Troubleshooting

### Issue: "Invalid credentials"
**Fix:** Double-check secrets are set correctly
```bash
wrangler secret list  # See what's set
wrangler secret put SUPABASE_URL  # Re-set if needed
```

### Issue: Telegram webhook fails
**Fix:** Verify bot token and worker URL
```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

### Issue: Todoist webhook not working
**Fix:** 
1. Check webhook in Todoist Developer Console
2. Verify project ID matches in settings
3. Test with manual curl request

### Issue: Database errors
**Fix:**
1. Verify Supabase project is active
2. Check credentials
3. Run schema.sql again if tables missing

---

## 📊 Monitoring

### View Live Logs
```bash
npm run tail
```

### Check Worker Status
- Go to Cloudflare Dashboard
- Workers & Pages → progress-bot
- View metrics and logs

### Check Database
- Go to Supabase Dashboard
- Table Editor to view data
- Logs to see queries

### Monitor Bot
- Send test commands
- Check response times
- Review error messages

---

## 🎯 Success Criteria

Your deployment is successful when:

1. ✅ Health check returns 200 OK
2. ✅ Telegram bot responds instantly
3. ✅ Todoist tasks appear in database within 5 seconds
4. ✅ No errors in logs for 1 hour
5. ✅ All commands work correctly
6. ✅ Streaks calculate properly

---

## 📝 Important URLs to Bookmark

- **Worker:** `https://progress-bot.your-name.workers.dev`
- **Health Check:** `https://progress-bot.your-name.workers.dev/health`
- **Cloudflare Dashboard:** https://dash.cloudflare.com/
- **Supabase Dashboard:** https://app.supabase.com/
- **Todoist Developer:** https://developer.todoist.com/

---

**Congratulations! Your Progress Bot is deployed and ready for Phase 2! 🚀**
