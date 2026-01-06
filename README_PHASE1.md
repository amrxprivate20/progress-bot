# Progress Bot - Phase 1 Implementation Guide

## 🎯 Phase 1 Overview

Phase 1 establishes the foundation of your progress tracking system:

1. ✅ Complete Supabase database setup
2. ✅ Cloudflare Workers boilerplate with TypeScript
3. ✅ Todoist webhook handler with duplicate detection
4. ✅ Basic Telegram bot with Grammy framework
5. ✅ Settings management system

---

## 📋 Prerequisites

Before starting, you'll need:

- **Node.js** v18 or higher ([Download](https://nodejs.org/))
- **npm** (comes with Node.js)
- **Supabase Account** (free tier) - [Sign up](https://supabase.com/)
- **Cloudflare Account** (free tier) - [Sign up](https://www.cloudflare.com/)
- **Todoist Account** - [Sign up](https://todoist.com/)
- **Telegram Account** for bot creation
- **Code Editor** (VS Code recommended)

---

## 🚀 Step-by-Step Setup

### Step 1: Install Wrangler (Cloudflare CLI)

```bash
npm install -g wrangler

# Login to Cloudflare
wrangler login
```

This will open a browser window to authenticate with Cloudflare.

### Step 2: Set Up Supabase Database

1. Go to [Supabase Dashboard](https://app.supabase.com/)
2. Click "New Project"
3. Fill in:
   - **Name:** progress-bot
   - **Database Password:** (create a strong password - save it!)
   - **Region:** Choose closest to Egypt (e.g., Frankfurt or Dubai)
4. Click "Create new project" and wait ~2 minutes

5. Once ready, go to **Project Settings** → **API**
6. Copy these values (you'll need them):
   - **Project URL** (looks like: `https://xxxxx.supabase.co`)
   - **anon/public key** (starts with `eyJ...`)

7. Go to **SQL Editor** and run the database setup script (provided below)

### Step 3: Create Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot`
3. Follow prompts:
   - **Bot name:** My Progress Bot (or your choice)
   - **Username:** must end with `bot`, e.g., `amrxprivatebot`
4. Copy the **bot token** (looks like: `7237718018:AAEYT...`)
5. Get your **chat ID**:
   - Send a message to your bot
   - Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Find `"chat":{"id":` and copy the number

### Step 4: Get Todoist API Token

1. Go to [Todoist Settings](https://todoist.com/app/settings/integrations)
2. Scroll to **API token**
3. Click "Copy to clipboard"

### Step 5: Initialize Cloudflare Worker Project

```bash
# Navigate to project directory
cd progress-bot

# Initialize wrangler project
wrangler init

# When prompted:
# - Name: progress-bot
# - TypeScript: Yes
# - Git: Yes (if you want version control)
# - Deploy: No (we'll do this manually after setup)
```

### Step 6: Install Dependencies

```bash
npm install grammy
npm install --save-dev @cloudflare/workers-types
```

### Step 7: Configure Environment Variables

Create `.dev.vars` file (for local development):

```env
SUPABASE_URL=your_supabase_url_here
SUPABASE_ANON_KEY=your_supabase_anon_key_here
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_telegram_chat_id_here
TODOIST_API_TOKEN=your_todoist_api_token_here
```

**⚠️ Important:** Never commit `.dev.vars` to version control!

### Step 8: Set Cloudflare Secrets (for production)

```bash
wrangler secret put SUPABASE_URL
# Paste your Supabase URL when prompted

wrangler secret put SUPABASE_ANON_KEY
# Paste your Supabase anon key when prompted

wrangler secret put TELEGRAM_BOT_TOKEN
# Paste your Telegram bot token when prompted

wrangler secret put TELEGRAM_CHAT_ID
# Paste your Telegram chat ID when prompted

wrangler secret put TODOIST_API_TOKEN
# Paste your Todoist API token when prompted
```

---

## 📁 Project Structure

```
progress-bot/
├── src/
│   ├── index.ts              # Main worker entry point
│   ├── database/
│   │   ├── client.ts         # Supabase client setup
│   │   ├── schema.sql        # Database schema
│   │   └── settings.ts       # Settings management
│   ├── handlers/
│   │   ├── todoist.ts        # Todoist webhook handler
│   │   └── telegram.ts       # Telegram bot handlers
│   ├── bot/
│   │   └── grammy.ts         # Grammy bot setup
│   ├── utils/
│   │   ├── validation.ts     # Input validation
│   │   └── errors.ts         # Error handling
│   └── types/
│       └── index.ts          # TypeScript interfaces
├── wrangler.toml             # Cloudflare Worker config
├── package.json
├── tsconfig.json
└── README_PHASE1.md
```

---

## 🗄️ Database Setup

Run this SQL in Supabase SQL Editor:

See `database/schema.sql` file for complete schema.

---

## 🧪 Testing Phase 1

### Test 1: Database Connection

```bash
# Run local worker
wrangler dev

# In another terminal, test the health endpoint
curl http://localhost:8787/health
```

Expected response:
```json
{"status":"ok","database":"connected"}
```

### Test 2: Settings System

```bash
curl -X POST http://localhost:8787/api/settings \
  -H "Content-Type: application/json" \
  -d '{"key":"test_setting","value":"test_value"}'

curl http://localhost:8787/api/settings/test_setting
```

Expected: Settings saved and retrieved successfully.

### Test 3: Todoist Webhook

1. Go to [Todoist Developer Console](https://developer.todoist.com/)
2. Create a new app
3. Set webhook URL: `https://your-worker.workers.dev/webhook/todoist`
4. Complete a task in Todoist
5. Check if webhook is received

### Test 4: Telegram Bot

```bash
# Send test message to your bot
# Type: /start

# Check worker logs
wrangler tail
```

Expected: Bot responds with welcome message.

---

## 🚨 Common Issues & Solutions

### Issue 1: "Cannot find module 'grammy'"
**Solution:** Run `npm install` in project directory

### Issue 2: "Unauthorized" from Supabase
**Solution:** Double-check your SUPABASE_ANON_KEY is correct

### Issue 3: "Bad Request" from Telegram
**Solution:** Verify TELEGRAM_BOT_TOKEN format (should have `:` in middle)

### Issue 4: Webhook not receiving events
**Solution:** 
- Ensure worker is deployed (not just running locally)
- Verify webhook URL is publicly accessible
- Check Todoist webhook settings

### Issue 5: TypeScript errors
**Solution:** Run `npm install --save-dev @cloudflare/workers-types`

---

## 📤 Deployment

### Deploy to Cloudflare Workers

```bash
# Deploy the worker
wrangler deploy

# Note the URL, it will look like:
# https://progress-bot.your-username.workers.dev
```

### Set Up Webhooks

#### Todoist Webhook:
1. Go to Todoist Developer Console
2. Your App → Webhooks
3. Add webhook: `https://your-worker.workers.dev/webhook/todoist`

#### Telegram Webhook:
```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -d "url=https://your-worker.workers.dev/telegram/webhook"
```

---

## 🔍 Monitoring & Debugging

### View Live Logs

```bash
wrangler tail
```

### View Past Logs

Go to Cloudflare Dashboard → Workers & Pages → Your Worker → Logs

### Database Queries

Go to Supabase Dashboard → SQL Editor

Example query to see recent tasks:
```sql
SELECT * FROM tasks ORDER BY completed_at DESC LIMIT 10;
```

---

## ✅ Phase 1 Completion Checklist

- [ ] Supabase project created
- [ ] All database tables created
- [ ] Cloudflare Worker deployed
- [ ] Environment variables configured
- [ ] Todoist webhook receiving events
- [ ] Telegram bot responding to commands
- [ ] Settings system working
- [ ] No errors in logs for 1 hour

---

## 🎯 Next Steps

Once Phase 1 is working:

1. Test with real Todoist task completions
2. Verify data is stored correctly in Supabase
3. Confirm Telegram notifications work
4. Review logs for any errors
5. Proceed to **Phase 2: Core Features**

---

## 📞 Need Help?

If you encounter issues:

1. Check the **Common Issues** section above
2. Review Cloudflare Worker logs: `wrangler tail`
3. Check Supabase logs in dashboard
4. Verify all environment variables are set correctly
5. Ensure all dependencies are installed

---

## 📝 Important Notes

- **Keep your tokens secure** - never commit them to Git
- **Test locally first** with `wrangler dev`
- **Monitor your free tier limits**:
  - Cloudflare: 100,000 requests/day
  - Supabase: 500 MB database, 2 GB bandwidth
- **Time zone is GMT+3** (Egypt/Cairo) - all dates use this

---

**Your Phase 1 implementation is complete! Test everything thoroughly before moving to Phase 2.**
