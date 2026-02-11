# Auto-Fail Setup Guide

## Issue
The scheduled auto-fail is not working. It only works when using the `/autofail` Telegram command.

## Root Cause
The GitHub Actions workflow requires two secrets that may not be configured:
1. `AUTOFAIL_SECRET`
2. `WORKER_URL`

## Solution

### Step 1: Get your Worker URL
Your Cloudflare Worker URL should be in the format:
```
https://progress-bot.<your-subdomain>.workers.dev
```

To find it:
1. Go to https://dash.cloudflare.com/
2. Click on "Workers & Pages"
3. Click on "progress-bot"
4. Copy the URL shown (should end with `.workers.dev`)

**OR** run this command:
```bash
npx wrangler deployments list
```
The URL will be shown in the output.

### Step 2: Configure GitHub Secrets
Go to your GitHub repository:
https://github.com/amrxprivate20/progress-bot/settings/secrets/actions

Add two secrets:

#### Secret 1: AUTOFAIL_SECRET
- Name: `AUTOFAIL_SECRET`
- Value: `R3mTq7kV8P1YwFJxZC2H9N0eKQbU6L4aS5oD+MciXg=`
  (This matches the value in wrangler.toml)

#### Secret 2: WORKER_URL
- Name: `WORKER_URL`
- Value: Your Worker URL from Step 1 (e.g., `https://progress-bot.amr-xprivate.workers.dev`)

### Step 3: Verify the Workflow is Enabled
1. Go to https://github.com/amrxprivate20/progress-bot/actions
2. Check if "Auto-Fail Tasks" workflow appears in the list
3. If it shows a yellow warning or is disabled, click to enable it

### Step 4: Test Manually
To test if it works without waiting for the schedule:
1. Go to https://github.com/amrxprivate20/progress-bot/actions
2. Click on "Auto-Fail Tasks" workflow
3. Click "Run workflow" button
4. Select the branch (main)
5. Click "Run workflow"

This will trigger the workflow immediately and you can see the logs.

## How It Works

1. **GitHub Actions runs every 15 minutes** from 9 PM - midnight Egypt time
2. It calls `/api/autofail/init` on your Worker
3. The Worker checks if current Egypt time >= `autofail_hour` setting (23:30)
4. If yes, it fetches tasks from Todoist and processes them
5. Progress updates are sent to Telegram every 20 tasks

## Verification Checklist

- [ ] Worker URL is correct and accessible
- [ ] GitHub secrets `AUTOFAIL_SECRET` and `WORKER_URL` are set
- [ ] GitHub Actions workflow is enabled
- [ ] Supabase setting `autofail_enabled` = "true"
- [ ] Supabase setting `autofail_hour` = "23:30" (or your preferred time)
- [ ] Todoist API token is configured
- [ ] Telegram bot token and chat ID are configured

## Debugging

### Check if workflow is running:
Go to: https://github.com/amrxprivate20/progress-bot/actions

### Check Worker logs:
```bash
npx wrangler tail --format pretty
```

### Test the endpoint directly:
```bash
curl -X POST \
  -H "Authorization: Bearer R3mTq7kV8P1YwFJxZC2H9N0eKQbU6L4aS5oD+MciXg=" \
  -H "Content-Type: application/json" \
  "https://YOUR-WORKER-URL.workers.dev/api/autofail/init"
```

Expected response if it's not time yet:
```json
{"success": false, "error": "Current time (XX:XX) < trigger time (23:30)"}
```

Expected response after 23:30 Egypt time:
```json
{"success": true, "totalTasks": N, "jobId": "autofail_2026-02-11"}
```

## Current Settings (from Supabase)
- `autofail_enabled`: "true" ✅
- `autofail_hour`: "23:30" ✅
- `todoist_api_token`: configured ✅
- `telegram_chat_id`: configured ✅

## Time Information
- Current Egypt time: ~19:26 (7:26 PM)
- Current UTC time: ~17:26 (5:26 PM)
- Egypt offset: UTC+2 (winter) / UTC+3 (summer)
- Trigger time: 23:30 Egypt time
- GitHub cron runs at: 19:00-22:59 UTC = 21:00-00:59 Egypt ✅
