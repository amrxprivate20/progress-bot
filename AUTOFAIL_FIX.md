# 🔧 Auto-Fail Not Working - FIX REQUIRED

## 🎯 ROOT CAUSE IDENTIFIED

The scheduled auto-fail is **NOT working** because the **GitHub Actions workflow is missing required secrets**.

The `/autofail` Telegram command works because it bypasses the scheduled trigger and forces execution directly.

---

## ✅ VERIFIED WORKING

I've confirmed these are all configured correctly:

1. ✅ **Supabase Settings:**
   - `autofail_enabled`: `"true"`
   - `autofail_hour`: `"23:30"` (11:30 PM Egypt time)
   - `todoist_api_token`: Configured
   - `telegram_chat_id`: 6542663539

2. ✅ **Cloudflare Worker:**
   - Deployed and running
   - Endpoint `/api/autofail/init` exists
   - Auth secret in wrangler.toml

3. ✅ **GitHub Workflow File:**
   - `.github/workflows/autofail.yml` exists
   - Cron schedule correct (every 15min from 9 PM-midnight Egypt)

4. ✅ **Time Logic:**
   - Current Egypt time: 19:34 (7:34 PM)
   - Trigger time: 23:30 (11:30 PM)
   - Will trigger in ~4 hours

---

## ❌ WHAT'S MISSING

### GitHub Repository Secrets Not Configured

The workflow file (`.github/workflows/autofail.yml`) requires two secrets on lines 28 and 30:

```yaml
-H "Authorization: Bearer ${{ secrets.AUTOFAIL_SECRET }}"
"${{ secrets.WORKER_URL }}/api/autofail/init"
```

**These secrets are NOT SET in your GitHub repository!**

---

## 🚀 FIX (5 MINUTES)

### Step 1: Get Your Worker URL

**Option A - Cloudflare Dashboard (Easiest):**
1. Go to: https://dash.cloudflare.com/064f0f079a1847bc56e1b2f6e021e00b
2. Click **"Workers & Pages"**
3. Click **"progress-bot"**
4. Copy the URL shown (format: `https://progress-bot.XXXXX.workers.dev`)

**Option B - Command Line:**
```bash
npx wrangler deployments list
```
Look for the worker URL in the output.

### Step 2: Add GitHub Secrets

Go to: **https://github.com/amrxprivate20/progress-bot/settings/secrets/actions**

Click **"New repository secret"** and add both:

#### Secret 1: AUTOFAIL_SECRET
```
Name: AUTOFAIL_SECRET
Value: R3mTq7kV8P1YwFJxZC2H9N0eKQbU6L4aS5oD+MciXg=
```

#### Secret 2: WORKER_URL
```
Name: WORKER_URL
Value: <YOUR WORKER URL FROM STEP 1>
Example: https://progress-bot.amr-xprivate.workers.dev
```

### Step 3: Enable Workflow (if needed)

1. Go to: https://github.com/amrxprivate20/progress-bot/actions
2. If you see a yellow banner or disabled status, click to **enable the workflow**

### Step 4: Test It (Optional)

**Manual Test (immediate):**
1. Go to: https://github.com/amrxprivate20/progress-bot/actions
2. Click **"Auto-Fail Tasks"** workflow
3. Click **"Run workflow"** button
4. Select **"main"** branch
5. Click green **"Run workflow"** button

This will run it immediately. Check the logs to verify it works.

**Automatic Test (wait for schedule):**
- Just wait until 11:30 PM Egypt time tonight
- The workflow will run automatically every 15 minutes from 9 PM-midnight
- It will check if current time >= 23:30, then process tasks

---

## 🧪 TESTING

### Test the endpoint manually (advanced):

```bash
# Replace <WORKER_URL> with your actual URL
curl -X POST \
  -H "Authorization: Bearer R3mTq7kV8P1YwFJxZC2H9N0eKQbU6L4aS5oD+MciXg=" \
  -H "Content-Type: application/json" \
  "<WORKER_URL>/api/autofail/init"
```

**Expected responses:**

Before 23:30 Egypt time:
```json
{
  "success": false,
  "error": "Current time (19:34) < trigger time (23:30)"
}
```

After 23:30 Egypt time:
```json
{
  "success": true,
  "totalTasks": 5,
  "jobId": "autofail_2026-02-11"
}
```

---

## 📊 HOW IT WILL WORK

Once secrets are configured:

1. **21:00-00:59 Egypt time** (9 PM - 12:59 AM)
   - GitHub Actions runs every 15 minutes

2. **Before 23:30:**
   - Worker checks time
   - Returns: "Current time < trigger time"
   - GitHub workflow skips processing

3. **At/After 23:30:**
   - Worker checks time ✅
   - Fetches tasks from Todoist
   - Processes them in batches
   - Sends updates to Telegram every 20 tasks
   - Marks incomplete tasks as failed

---

## 🔍 VERIFICATION

Run the diagnostic script to verify setup:
```bash
./check-autofail.sh
```

Check GitHub Actions runs:
```
https://github.com/amrxprivate20/progress-bot/actions/workflows/autofail.yml
```

Watch Worker logs live:
```bash
npx wrangler tail --format pretty
```

---

## ⚡ QUICK CHECKLIST

- [ ] **Add GitHub secret:** AUTOFAIL_SECRET
- [ ] **Add GitHub secret:** WORKER_URL
- [ ] **Enable workflow** in GitHub Actions
- [ ] **Test manually** (optional)
- [ ] **Wait for 23:30 PM Egypt time** to see it run automatically

---

## 📞 SUPPORT

If it still doesn't work after adding secrets:

1. Check workflow runs: https://github.com/amrxprivate20/progress-bot/actions
2. Look for error messages in the logs
3. Verify secrets are named exactly: `AUTOFAIL_SECRET` and `WORKER_URL` (case-sensitive)
4. Make sure Worker URL has no trailing slash

---

**Once you add those two secrets, auto-fail will start working automatically every night at 11:30 PM! 🎉**
