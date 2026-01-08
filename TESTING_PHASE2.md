# Testing Guide - Phase 2

## 🎯 Complete Phase 2 Test Suite

This guide provides comprehensive tests for all Phase 2 features: AI-powered reports, Q&A flow, and memory management.

---

## 📋 Pre-Test Checklist

Before starting tests, ensure:

- [ ] Phase 1 is fully working
- [ ] OpenRouter API key is configured in Supabase
- [ ] OpenRouter account has credits ($5+ recommended)
- [ ] Cloudflare Worker is deployed
- [ ] Telegram bot is responding
- [ ] At least 1 task completed today in Todoist

---

## Test 1: Report Preview (No AI)

### Purpose
Verify report data collection and preview generation without using AI.

### Steps

```bash
# 1. Open Telegram and find your bot
# 2. Send command:
/progress
```

### Expected Behavior

**Immediate response:**
```
🔄 جاري إعداد ملخص اليوم...
```

**Within 2-3 seconds:**
```
📊 **معاينة التقرير اليومي**

📅 **التاريخ:** [Arabic date]

📈 **الإحصائيات:**
- إجمالي المهام: X
- المنجزة: X
- الفاشلة: X
- معدل النجاح: X.X%
- وقت الإنجاز: [Arabic time]

🏷️ **أهم الفئات:**
- [Category 1]: X مهام
- [Category 2]: X مهام

🎯 **التحدي اليومي:** ✅/❌
"[Challenge text]"

🎯 **الأهداف الأسبوعية:**
[Weekly goals or "لا توجد أهداف محددة"]

هل تريد إكمال التحليل بالذكاء الاصطناعي؟
استخدم /confirm للمتابعة أو /cancel للإلغاء
```

### Success Criteria

- ✅ Response received within 3 seconds
- ✅ Statistics are correct (match tasks in database)
- ✅ Arabic date format is correct
- ✅ Arabic time format is grammatically correct
- ✅ Categories match task categories
- ✅ Challenge status is accurate
- ✅ Message ends with confirmation prompt

### Troubleshooting

**Issue: "لا توجد مهام لهذا اليوم"**
- **Fix:** Complete at least one task in Todoist
- Verify task captured in database: `SELECT * FROM tasks WHERE DATE(completed_at) = CURRENT_DATE`

**Issue: Wrong statistics**
- **Fix:** Check database for duplicate/missing tasks
- Run: `SELECT COUNT(*) FROM tasks WHERE DATE(completed_at) = CURRENT_DATE`

**Issue: Categories not showing**
- **Fix:** Ensure tasks have categories (labels in Todoist or @category in task name)

---

## Test 2: AI Question Generation

### Purpose
Verify AI generates relevant clarifying questions.

### Steps

```bash
# 1. After receiving preview from Test 1
# 2. Send command:
/confirm
```

### Expected Behavior

**Immediate responses:**
```
🔄 جاري بدء التحليل الكامل...
📊 جاري جمع البيانات...
💭 جاري تحضير بعض الأسئلة التوضيحية...
```

**After 5-10 seconds:**
```
📝 لدي [1-3] أسئلة توضيحية لفهم تجربتك اليوم بشكل أفضل.

سأرسل سؤال واحد في كل مرة. أجب بحرية!

❓ [First question]
```

### Success Criteria

- ✅ 1-3 questions generated (at least 1)
- ✅ Questions in Arabic
- ✅ Questions relevant to tasks/goals/challenges
- ✅ Questions are clear and specific
- ✅ Questions encourage thoughtful answers

### Example Good Questions

```
❓ كيف كان شعورك خلال العمل على [specific task]؟
❓ ما التحدي الرئيسي اللي واجهته النهاردة؟
❓ إيه اللي ساعدك تخلص [task] بنجاح؟
```

### Troubleshooting

**Issue: "OpenRouter API key غير مضبوط"**
- **Fix:** Go to Supabase → settings table
- Add row: key=`openrouter_api_key`, value=`sk-or-v1-...`

**Issue: No response after 30 seconds**
- **Fix:** Check OpenRouter credits: https://openrouter.ai/credits
- Check Cloudflare logs: `npm run tail`
- Verify model name in settings: `anthropic/claude-sonnet-4`

**Issue: Questions in English instead of Arabic**
- **Fix:** Check AI client system message includes Arabic instruction
- Try again - sometimes model behavior varies

**Issue: Too many/few questions**
- **Expected:** 1-3 questions is normal range
- If 0 questions: AI decided no clarification needed (rare but possible)

---

## Test 3: Q&A Conversation Flow

### Purpose
Verify conversation state management and question progression.

### Steps

```bash
# 1. After receiving first question from Test 2
# 2. Send any text answer:
كان يوم جيد، عملت على مشروع مهم وأنجزته.

# 3. Should receive next question
# 4. Answer again:
التحدي الأساسي كان تنظيم الوقت.

# 5. Continue until all questions answered
```

### Expected Behavior

**After first answer:**
```
✅ تمام!

[1/2] ❓ [Second question]
```

**After second answer:**
```
✅ تمام!

[2/2] ❓ [Third question]
```

**After final answer:**
```
✅ شكراً على إجاباتك! جاري التحليل الكامل الآن...
```

### Success Criteria

- ✅ Progress indicator shows correctly (1/2, 2/2, etc.)
- ✅ Each answer acknowledged with "✅ تمام!"
- ✅ Next question appears immediately
- ✅ After final answer, analysis begins
- ✅ No duplicate questions
- ✅ Conversation flows naturally

### Troubleshooting

**Issue: Bot not responding to answers**
- **Fix:** Check conversation_state table in Supabase
- Verify row exists for your chat_id
- Try `/cancel` and start over

**Issue: Same question repeated**
- **Fix:** Database update issue - check logs
- Use `/cancel` and restart

**Issue: Conversation stuck**
- **Fix:** Send `/cancel` to clear state
- Check timeout (10 minutes) - may have expired

---

## Test 4: Full AI Analysis

### Purpose
Verify complete AI report generation with all sections.

### Steps

```bash
# 1. Complete Test 3 (answer all questions)
# 2. Wait for AI analysis to complete
# 3. Observe all sections being sent
```

### Expected Behavior

**Processing messages:**
```
🤖 جاري التحليل بالذكاء الاصطناعي...
```

**Commentary section:**
```
💬 *التحليل والتعليق:*

[Comprehensive analysis in Egyptian Arabic dialect]
[Multiple paragraphs discussing:]
- Performance today
- Patterns observed
- Encouragement and motivation
- Practical advice
- Connection to long-term goals
```

**Challenge evaluation:**
```
🎯 *تقييم التحدي اليومي:* ✅
"[Challenge text]"
```

**Reward suggestion:**
```
🎁 *المكافأة المقترحة:* [Specific, practical reward]
```

**Goals analysis:**
```
🎯 *تحليل الأهداف الأسبوعية:*

✅ *منجزة:*
- [Goal 1]
- [Goal 2]

🔄 *قيد التنفيذ:*
- [Goal 3]

⚠️ *مهملة:*
- [Goal 4]
```

**Memory update:**
```
🧠 جاري تحديث الذاكرة...
✅ تم تحديث الذاكرة
```

**Final confirmation:**
```
💾 جاري حفظ التقرير...
✅ تم حفظ التقرير بنجاح!
```

### Success Criteria

- ✅ All sections appear
- ✅ Commentary is in Egyptian Arabic dialect
- ✅ Commentary is personalized (mentions user's tasks/answers)
- ✅ Challenge evaluation is accurate (✅ if completed, ❌ if not)
- ✅ Reward is practical and relevant
- ✅ Goals analysis correctly categorizes goals
- ✅ Memory update confirmed
- ✅ Report saved to database

### Quality Checks

**Commentary should:**
- Be natural and conversational (Egyptian dialect)
- Reference specific tasks and achievements
- Incorporate user's answers to questions
- Provide encouragement and motivation
- Offer practical advice
- Be 3-5 paragraphs minimum

**Goals analysis should:**
- Accurately reflect progress
- Be based on tasks completed
- Align with weekly goals
- Categorize reasonably (not all in one category)

**Reward should:**
- Be specific and actionable
- Match effort level
- Be culturally appropriate
- Be enjoyable and motivating

### Troubleshooting

**Issue: Commentary too short/generic**
- **Check:** Are user answers being passed to AI?
- **Check:** Is memory populated with context?
- **Fix:** May need to adjust AI prompt or provide more context

**Issue: Wrong challenge evaluation**
- **Check:** Challenge text vs completed tasks
- **Fix:** Improve challenge completion detection logic
- Acceptable: AI might make judgment calls based on context

**Issue: Goals analysis empty**
- **Check:** Do weekly goals exist in database?
- **Query:** `SELECT * FROM weekly_goals ORDER BY week_start_date DESC LIMIT 1`
- **Fix:** Add weekly goals manually or skip this test

**Issue: No memory update**
- **Expected:** If AI finds no new insights, update may be skipped
- **Check:** Verify memory categories exist in database

---

## Test 5: Memory System

### Purpose
Verify memory storage, retrieval, and deduplication.

### Steps

```bash
# 1. After completing Test 4
# 2. Send command:
/memory
```

### Expected Behavior

**Immediate response:**
```
🔄 جاري تحميل الذاكرة...
```

**Within 1-2 seconds:**
```
📚 **الذاكرة المنظمة**

**Personal Insights & Patterns**
[Content or "لا توجد معلومات بعد"]

**Successful Strategies & What Works**
[Content or "لا توجد معلومات بعد"]

**Triggers & Challenges**
[Content or "لا توجد معلومات بعد"]

**Important Milestones & Breakthroughs**
[Content or "لا توجد معلومات بعد"]

**Recurring Themes & Lessons**
[Content or "لا توجد معلومات بعد"]

**Personal Information & Facts**
[Content or "لا توجد معلومات بعد"]
```

### Success Criteria

- ✅ All 6 categories shown
- ✅ Categories in correct order
- ✅ Updated content from recent report
- ✅ No duplicate information within categories
- ✅ Content is relevant and valuable
- ✅ Message properly formatted

### Deduplication Test

**To test deduplication:**

1. Generate 2 reports on same day with similar insights
2. Check memory after each
3. Verify duplicate insights not added twice

**Expected:** 70% word overlap → insight skipped

### Troubleshooting

**Issue: All categories empty**
- **Check:** Did memory update complete in Test 4?
- **Query:** `SELECT * FROM memory`
- **Fix:** Generate another report to populate memory

**Issue: Content truncated**
- **Expected:** Long content may be abbreviated in display
- **Check:** Full content in database: `SELECT content FROM memory WHERE category = '...'`

**Issue: Duplicate information**
- **Check:** Deduplication threshold (70% in code)
- **Fix:** May need to adjust threshold or algorithm

---

## Test 6: Conversation Cancel

### Purpose
Verify ability to cancel Q&A flow at any point.

### Steps

```bash
# 1. Start new report:
/progress

# 2. Confirm:
/confirm

# 3. When you receive a question, cancel:
/cancel
```

### Expected Behavior

**Immediate response:**
```
✅ تم إلغاء المحادثة
```

### Success Criteria

- ✅ Conversation cleared immediately
- ✅ No more questions sent
- ✅ Can start new `/progress` without issues
- ✅ conversation_state cleared in database

### Database Verification

```sql
-- Should be empty (or no row for your chat_id)
SELECT * FROM conversation_state WHERE chat_id = 'YOUR_CHAT_ID';
```

### Troubleshooting

**Issue: Bot still sends questions after cancel**
- **Check:** Conversation state in database
- **Fix:** Manually delete row: `DELETE FROM conversation_state WHERE chat_id = 'YOUR_CHAT_ID'`

---

## Test 7: Conversation Timeout

### Purpose
Verify 10-minute timeout handling.

### Steps

```bash
# 1. Start conversation:
/progress
/confirm

# 2. Answer first question
# 3. Wait 11 minutes
# 4. Try to answer next question
```

### Expected Behavior

- Bot should not respond to late answer
- Conversation should be expired
- User can start fresh with `/progress`

### Verification

```sql
-- After 10 minutes, expires_at should be in past
SELECT *,
  CASE WHEN expires_at < NOW() THEN 'EXPIRED' ELSE 'ACTIVE' END as status
FROM conversation_state
WHERE chat_id = 'YOUR_CHAT_ID';
```

### Troubleshooting

**Issue: Conversation still active after 10 minutes**
- **Check:** expires_at timestamp in database
- **Check:** Timezone handling (should be UTC in database)
- **Fix:** Adjust timeout in conversation-manager.ts

---

## Test 8: Memory Optimization

### Purpose
Verify automatic memory optimization triggers.

### Test A: Size Trigger

**Setup:**
```sql
-- Manually insert large content (>10,000 chars)
UPDATE memory
SET content = REPEAT('test content. ', 800)
WHERE category = 'Personal Insights & Patterns';
```

**Test:**
```bash
# Generate report
/progress
/confirm
# Answer questions
# Wait for completion
```

**Expected:**
```
🔄 جاري تحسين الذاكرة...
✅ تم تحسين الذاكرة
```

**Verification:**
```sql
-- Content should be shorter and optimized
SELECT LENGTH(content), last_optimized
FROM memory
WHERE category = 'Personal Insights & Patterns';
```

### Test B: Time Trigger

**Setup:**
```sql
-- Set last_optimized to 8 days ago
UPDATE memory
SET last_optimized = NOW() - INTERVAL '8 days'
WHERE category = 'Personal Insights & Patterns';
```

**Test:**
```bash
# Generate report (same as Test A)
```

**Expected:** Same optimization behavior

### Troubleshooting

**Issue: Optimization not triggering**
- **Check:** Content size: `SELECT LENGTH(content) FROM memory`
- **Check:** Last optimized date
- **Check:** AI response includes optimization flag
- **Fix:** Manually trigger via database update

---

## Test 9: Database Persistence

### Purpose
Verify reports are saved correctly to database.

### Steps

```bash
# 1. Complete full report generation (Tests 1-4)
# 2. Query database
```

### Verification Queries

```sql
-- Get today's report
SELECT *
FROM daily_reports
WHERE report_date = CURRENT_DATE
ORDER BY created_at DESC
LIMIT 1;

-- Verify all fields populated
SELECT
  report_date,
  success_rate,
  total_tasks,
  completed_tasks,
  failed_tasks,
  achievement_time_minutes,
  challenge_evaluation,
  suggested_reward,
  LENGTH(ai_commentary) as commentary_length,
  LENGTH(report_markdown) as markdown_length,
  weekly_goals_analysis
FROM daily_reports
WHERE report_date = CURRENT_DATE;
```

### Success Criteria

- ✅ Report exists for today
- ✅ All statistics match actual data
- ✅ `ai_commentary` contains full commentary
- ✅ `challenge_evaluation` is ✅ or ❌
- ✅ `suggested_reward` is populated
- ✅ `weekly_goals_analysis` is valid JSON
- ✅ Timestamps are correct

### Troubleshooting

**Issue: Report not saved**
- **Check:** Logs for database errors
- **Check:** Supabase connection
- **Fix:** Verify database permissions

**Issue: Missing fields**
- **Check:** AI response parsing
- **Fix:** Verify response format matches expected structure

---

## Test 10: Error Handling

### Purpose
Verify graceful handling of common errors.

### Test A: No OpenRouter Credits

**Setup:**
- Exhaust OpenRouter credits (or use invalid API key)

**Test:**
```bash
/progress
/confirm
```

**Expected:**
```
❌ [Error message from OpenRouter]
```

**Recovery:**
- Add credits to OpenRouter
- Try again

### Test B: No Tasks Today

**Setup:**
- Ensure no tasks completed today

**Test:**
```bash
/progress
```

**Expected:**
```
⚠️ لا توجد مهام لهذا اليوم
```

### Test C: Invalid AI Response

**Setup:**
- May occur randomly due to AI

**Expected:**
- Bot should handle gracefully
- May save partial report
- User notified of issue

### Test D: Database Connection Lost

**Setup:**
- Difficult to test without breaking Supabase

**Expected:**
- Error message to user
- Retry logic attempts reconnection
- Logs show connection errors

---

## 🎯 Complete Test Checklist

Run through all tests in order:

- [ ] **Test 1:** Report Preview ✅
- [ ] **Test 2:** AI Question Generation ✅
- [ ] **Test 3:** Q&A Conversation Flow ✅
- [ ] **Test 4:** Full AI Analysis ✅
- [ ] **Test 5:** Memory System ✅
- [ ] **Test 6:** Conversation Cancel ✅
- [ ] **Test 7:** Conversation Timeout ✅
- [ ] **Test 8:** Memory Optimization ✅
- [ ] **Test 9:** Database Persistence ✅
- [ ] **Test 10:** Error Handling ✅

---

## 📊 Performance Benchmarks

### Expected Response Times

| Action | Expected Time | Acceptable Max |
|--------|---------------|----------------|
| Report Preview | 1-3 sec | 5 sec |
| AI Questions | 3-7 sec | 15 sec |
| Full AI Analysis | 10-20 sec | 45 sec |
| Memory Display | 1-2 sec | 5 sec |
| Cancel Command | < 1 sec | 2 sec |

### Token Usage Expectations

| Operation | Input Tokens | Output Tokens | Cost |
|-----------|--------------|---------------|------|
| Question Generation | 500-1,000 | 100-300 | $0.002-$0.005 |
| Full Analysis | 2,000-4,000 | 1,000-2,000 | $0.010-$0.020 |
| Memory Optimization | 1,000-3,000 | 500-1,500 | $0.005-$0.015 |

---

## 🔍 Monitoring & Logging

### View Live Logs

```bash
# Terminal 1: Watch Cloudflare Worker logs
npm run tail

# Terminal 2: Test bot commands
# Send /progress, /confirm, etc.

# Observe in Terminal 1:
# - Request received
# - Data collection
# - AI API calls
# - Response parsing
# - Database operations
# - Errors (if any)
```

### Check OpenRouter Activity

```bash
# Visit: https://openrouter.ai/activity
# Review:
# - Recent requests
# - Token usage
# - Costs
# - Errors
# - Response times
```

### Check Supabase Logs

```bash
# In Supabase Dashboard:
# 1. Go to Logs section
# 2. Filter by table: daily_reports, memory, conversation_state
# 3. Look for:
#    - Insert operations
#    - Update operations
#    - Errors
```

---

## 🚨 Common Issues & Solutions

### Issue: Bot not responding at all

**Diagnosis:**
```bash
# Check if bot is online
curl https://progress-bot.your-account.workers.dev/health

# Check Telegram webhook
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

**Solutions:**
1. Redeploy worker: `npm run deploy`
2. Reset webhook (see DEPLOYMENT_GUIDE_PHASE2.md)
3. Check Cloudflare dashboard for errors

### Issue: AI responses are poor quality

**Possible Causes:**
- Not enough context (empty memory, no goals)
- Questions not answered thoughtfully
- Model choice (try claude-opus-4-5)

**Solutions:**
1. Add strategic goals in settings
2. Populate memory with initial context
3. Answer questions in detail
4. Try different AI model

### Issue: Memory growing too large

**Check:**
```sql
SELECT category, LENGTH(content) FROM memory ORDER BY LENGTH(content) DESC;
```

**Solutions:**
1. Wait for auto-optimization (7 days or 10k chars)
2. Manually trigger optimization
3. Adjust optimization thresholds in code

### Issue: High OpenRouter costs

**Check Usage:**
```
Visit: https://openrouter.ai/activity
Review: Daily spending pattern
```

**Solutions:**
1. Switch to cheaper model: `anthropic/claude-haiku`
2. Reduce number of questions (modify code)
3. Optimize prompts to be more concise
4. Generate reports less frequently

---

## ✅ Testing Complete!

If all tests pass, your Phase 2 implementation is working correctly!

**Next Steps:**
1. Use bot daily for 1 week
2. Monitor AI quality and costs
3. Adjust prompts if needed
4. Prepare for Phase 3

**Phase 2 is ready for production use!** 🎉

---

## 📞 Need Help?

If tests fail:

1. Review test-specific troubleshooting sections
2. Check Cloudflare logs: `npm run tail`
3. Verify OpenRouter API status
4. Check Supabase database health
5. Confirm Phase 1 still working
6. Try with simpler AI model (Claude Haiku)

**Most common test failures:**
- Missing OpenRouter API key
- No credits in OpenRouter account
- Wrong model name in settings
- Database permission issues
- Webhook not configured correctly

---

**Happy Testing! Your Phase 2 implementation should pass all tests! 🚀**
