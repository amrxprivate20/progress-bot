# Deployment Guide - Phase 2

## 🎯 Phase 2 Overview

Phase 2 adds AI-powered daily reports with:
- Report generation with Arabic formatting
- OpenRouter AI integration (Claude Sonnet 4)
- Interactive Q&A conversation flow
- Automatic memory management
- Enhanced Telegram bot commands

---

## ⏱ Estimated Time
- **First-time setup:** 15-20 minutes
- **Subsequent deployments:** 2-3 minutes

---

## 📋 Prerequisites

Before starting, ensure:

- [ ] Phase 1 is fully deployed and working
- [ ] OpenRouter account created
- [ ] API key obtained from OpenRouter
- [ ] Cloudflare Worker is accessible
- [ ] Supabase database is running

---

## Part 1: OpenRouter API Setup (5 minutes)

### Step 1: Create OpenRouter Account

1. Go to https://openrouter.ai/
2. Click "Sign Up" or "Sign In"
3. Create account or log in with Google/GitHub

### Step 2: Get API Key

1. Go to https://openrouter.ai/keys
2. Click "Create Key"
3. Give it a name: `Progress Bot`
4. Copy the API key (starts with `sk-or-v1-...`)
5. **Save it securely** - you won't see it again!

### Step 3: Add Credits (Optional but Recommended)

1. Go to https://openrouter.ai/credits
2. Add at least $5-$10 for testing
3. Claude Sonnet 4 costs approximately $3 per million input tokens

**Cost Estimate:**
- Average daily report: ~2,000 tokens input, ~1,000 tokens output
- Cost per report: ~$0.01-$0.02
- Monthly cost (30 reports): ~$0.30-$0.60

---

## Part 2: Update Supabase Settings (5 minutes)

### Step 1: Add OpenRouter API Key

1. Go to Supabase Dashboard → **Table Editor**
2. Open **settings** table
3. Find or create row with key: `openrouter_api_key`
4. Update value with your OpenRouter API key
5. Click "Save"

### Step 2: Configure AI Model (Optional)

1. In **settings** table
2. Find or create row with key: `ai_model`
3. Set value to: `anthropic/claude-sonnet-4` (default)
   - Or use: `anthropic/claude-opus-4-5` (more powerful, higher cost)
4. Click "Save"

### Step 3: Add Strategic Goals (Optional)

1. In **settings** table
2. Find or create row with key: `strategic_goals`
3. Add your long-term goals (in Arabic or English)
4. Example:
   ```
   - تحسين الإنتاجية الشخصية
   - تعلم مهارات جديدة في البرمجة
   - الحفاظ على صحة جيدة
   ```
5. Click "Save"

---

## Part 3: Deploy Updated Code (5 minutes)

### Step 1: Verify Local Changes

```bash
# Navigate to project directory
cd progress-bot

# Check TypeScript compilation
npm run type-check

# Should show no errors
```

### Step 2: Test Locally (Optional)

```bash
# Start local development server
npm run dev

# In another terminal, test health endpoint
curl http://localhost:8787/health
```

### Step 3: Deploy to Cloudflare

```bash
# Deploy to production
npm run deploy

# Should see:
# ✨ Success! Published progress-bot
#    https://progress-bot.your-account.workers.dev
```

### Step 4: Verify Deployment

```bash
# Test production health endpoint
curl https://progress-bot.progressbot.workers.dev/health

# Should return:
# {"status":"ok","database":"connected","timestamp":"..."}
```

---

## Part 4: Test Phase 2 Features (5 minutes)

### Test 1: Report Preview

1. Open Telegram and go to your bot
2. Send `/progress`
3. Should receive:
   - Loading message
   - Report preview with statistics
   - Instructions to use `/confirm` or `/cancel`

**Expected Output:**
```
📊 **معاينة التقرير اليومي**

📅 **التاريخ:** الأحد، 8 يناير 2026

📈 **الإحصائيات:**
- إجمالي المهام: X
- المنجزة: X
- الفاشلة: X
- معدل النجاح: X%
- وقت الإنجاز: X ساعة و X دقيقة

...

هل تريد إكمال التحليل بالذكاء الاصطناعي؟
استخدم /confirm للمتابعة أو /cancel للإلغاء
```

### Test 2: Full AI Analysis

1. After receiving preview, send `/confirm`
2. Should receive:
   - "جاري بدء التحليل الكامل..."
   - "جاري تحضير بعض الأسئلة التوضيحية..."
   - First clarifying question

3. Answer the question (any text)
4. Should receive next question
5. After all questions, receive:
   - "جاري التحليل بالذكاء الاصطناعي..."
   - AI commentary in Egyptian dialect
   - Challenge evaluation
   - Reward suggestion
   - Goals analysis
   - "تم حفظ التقرير بنجاح!"

### Test 3: Memory System

1. After generating a report, send `/memory`
2. Should receive organized memory in 6 categories
3. Check if memory was updated from report

### Test 4: Cancel Flow

1. Send `/progress`
2. Send `/confirm`
3. When you receive a question, send `/cancel`
4. Should receive: "تم إلغاء المحادثة"
5. Q&A flow should stop

---

## Part 5: Monitor and Verify (5 minutes)

### Check Cloudflare Logs

```bash
# View live logs
npm run tail

# Watch for:
# - Report generation requests
# - AI API calls
# - Memory updates
# - Any errors
```

### Check Supabase Database

1. Go to Supabase Dashboard → **Table Editor**
2. Check **daily_reports** table:
   - Should see new reports with AI commentary
   - Success rate, task counts
   - Goals analysis
3. Check **memory** table:
   - Should see updated content
   - Last updated timestamps
4. Check **conversation_state** table:
   - Should be empty (or have expired entries)

### Verify AI Costs

1. Go to https://openrouter.ai/activity
2. Check recent requests
3. Verify costs are reasonable
4. Monitor token usage

---

## 🚨 Common Issues & Solutions

### Issue 1: "OpenRouter API key غير مضبوط في الإعدادات"

**Solution:**
1. Check Supabase **settings** table
2. Verify `openrouter_api_key` exists and has correct value
3. Key should start with `sk-or-v1-`
4. Redeploy worker if needed

### Issue 2: AI not responding / timeout

**Solution:**
1. Check OpenRouter credits: https://openrouter.ai/credits
2. Verify model name in settings: `anthropic/claude-sonnet-4`
3. Check Cloudflare logs for API errors
4. Try simpler model: `anthropic/claude-haiku` (faster, cheaper)

### Issue 3: Q&A conversation not working

**Solution:**
1. Check **conversation_state** table in Supabase
2. Verify timeout (should be 10 minutes)
3. Use `/cancel` to reset conversation
4. Check bot logs for errors

### Issue 4: Memory not updating

**Solution:**
1. Verify AI response includes memory updates
2. Check **memory** table for `last_updated` timestamps
3. Ensure memory categories match exactly:
   - Personal Insights & Patterns
   - Successful Strategies & What Works
   - Triggers & Challenges
   - Important Milestones & Breakthroughs
   - Recurring Themes & Lessons
   - Personal Information & Facts

### Issue 5: Reports in English instead of Arabic

**Solution:**
1. Check AI prompt in `src/services/ai-client.ts`
2. Verify system message includes: "تتحدث باللهجة المصرية"
3. Check that prompts include Arabic context
4. Model should be Claude Sonnet 4 (better multilingual support)

### Issue 6: High API costs

**Solution:**
1. Review token usage at https://openrouter.ai/activity
2. Switch to cheaper model: `anthropic/claude-haiku`
3. Reduce number of clarifying questions (max 1-2)
4. Optimize memory size (auto-optimization helps)

---

## 📊 Monitoring

### Daily Checks

1. **Bot Responsiveness:**
   ```bash
   # Send /progress command
   # Should respond within 5-10 seconds
   ```

2. **AI Analysis Quality:**
   - Check if commentary is relevant
   - Verify challenge evaluation is accurate
   - Ensure memory updates make sense

3. **Database Growth:**
   ```sql
   -- Check report count
   SELECT COUNT(*) FROM daily_reports;

   -- Check latest reports
   SELECT report_date, success_rate, total_tasks
   FROM daily_reports
   ORDER BY report_date DESC
   LIMIT 7;
   ```

### Weekly Checks

1. **OpenRouter Costs:**
   - Review spending at https://openrouter.ai/activity
   - Should be ~$0.50-$2.00 per week (depending on usage)

2. **Memory Size:**
   ```sql
   -- Check memory size
   SELECT category, LENGTH(content) as size
   FROM memory
   ORDER BY size DESC;
   ```
   - If any category > 10,000 chars, optimization will trigger

3. **Worker Performance:**
   - Go to Cloudflare Dashboard → Workers → progress-bot
   - Check metrics:
     - Requests per day
     - Success rate (should be > 95%)
     - Average response time

---

## 🔄 Updating After Code Changes

### Update Workflow

```bash
# 1. Make code changes
# 2. Type check
npm run type-check

# 3. Test locally (optional)
npm run dev

# 4. Deploy
npm run deploy

# 5. Monitor
npm run tail
```

### Configuration Changes

**Changing AI Model:**
```bash
# No code changes needed - update in Supabase:
# 1. Open settings table
# 2. Update ai_model value
# 3. Options:
#    - anthropic/claude-sonnet-4 (default, balanced)
#    - anthropic/claude-opus-4-5 (most powerful, expensive)
#    - anthropic/claude-haiku (fast, cheap)
```

**Changing Strategic Goals:**
```bash
# Update in Supabase settings table
# Key: strategic_goals
# Value: Your goals in Arabic/English
```

---

## ✅ Phase 2 Deployment Checklist

- [ ] OpenRouter account created
- [ ] API key obtained and added to Supabase
- [ ] Credits added to OpenRouter account
- [ ] Strategic goals configured (optional)
- [ ] Code deployed to Cloudflare Workers
- [ ] `/progress` command works
- [ ] `/confirm` starts Q&A flow
- [ ] Questions appear one by one
- [ ] AI analysis generates successfully
- [ ] Memory updates after reports
- [ ] `/memory` shows organized categories
- [ ] No errors in logs for 30 minutes
- [ ] First AI report costs verified

---

## 🎯 Next Steps

Once Phase 2 is stable:

1. **Use Daily:**
   - Generate report every evening
   - Answer questions thoughtfully
   - Review AI insights
   - Check memory updates

2. **Monitor:**
   - Track AI costs weekly
   - Review report quality
   - Adjust strategic goals as needed

3. **Optimize:**
   - Fine-tune clarifying questions
   - Adjust memory optimization triggers
   - Customize AI prompts if needed

4. **Ready for Phase 3:**
   - Weekly goals generation
   - Todoist task creation
   - Google Drive integration
   - More advanced features

---

## 📞 Need Help?

If you encounter issues:

1. Check **Common Issues** section above
2. Review Cloudflare Worker logs: `npm run tail`
3. Check Supabase logs in dashboard
4. Verify OpenRouter API status: https://openrouter.ai/status
5. Test with simpler model (Claude Haiku) to isolate issues
6. Ensure Phase 1 is still working correctly

**Most common Phase 2 issues:**
- Missing OpenRouter API key → Add to settings
- No credits → Add credits at https://openrouter.ai/credits
- Wrong model name → Use `anthropic/claude-sonnet-4`
- Conversation timeout → Use `/cancel` and try again
- Memory not updating → Check AI response format

---

**Your Progress Bot Phase 2 is deployed! Start generating AI-powered daily reports! 🎉**
