# Phase 3 Testing Guide

## Overview

This guide covers testing procedures for all Phase 3 features:
1. Journal System
2. Weekly Goals Generation
3. Todoist Task Creation
4. Google Drive Integration

---

## Prerequisites

Before testing, ensure:
- [ ] Phase 3 migration script has been run
- [ ] Bot is deployed to Cloudflare Workers
- [ ] OpenRouter API key is configured
- [ ] Todoist credentials are configured (for task creation tests)
- [ ] Google Drive credentials are configured (for Drive tests, optional)

---

## Test 1: Journal System

### 1.1 Start Session

**Command:** `/journal_start`

**Expected Result:**
```
📝 بدأت جلسة اليوميات! أرسل رسائلك، صورك، أو فيديوهاتك وسأحفظها لك.

استخدم /journal_end لإنهاء الجلسة.
```

**Verify:**
- [ ] Message received successfully
- [ ] Database entry created with `is_session_start = true`

### 1.2 Add Text Entry

**Action:** Send any text message (e.g., "اليوم كان يوم جيد")

**Expected Result:**
```
📝 ✓
```

**Verify:**
- [ ] Checkmark received
- [ ] Entry saved in `journal_entries` table with `message_text`

### 1.3 Add Photo Entry

**Action:** Send a photo with or without caption

**Expected Result:**
```
📷 ✓
```

**Verify:**
- [ ] Checkmark received
- [ ] Entry saved with `media_type = 'image'` and `media_url` (file_id)

### 1.4 Add Video Entry

**Action:** Send a video

**Expected Result:**
```
🎥 ✓
```

**Verify:**
- [ ] Entry saved with `media_type = 'video'`

### 1.5 End Session

**Command:** `/journal_end`

**Expected Result:**
```
✅ تم إنهاء جلسة اليوميات! سجلت X إدخال(ات) اليوم.

ستظهر في تقريرك اليومي.
```

**Verify:**
- [ ] Entry count is correct
- [ ] Database entry created with `is_session_end = true`

### 1.6 Resume Session

**Command:** `/journal_resume`

**Expected Result:**
```
📝 تم استئناف جلسة اليوميات! أرسل رسائلك، صورك، أو فيديوهاتك.

استخدم /journal_end لإنهاء الجلسة.
```

**Verify:**
- [ ] Can add new entries after resuming
- [ ] `is_session_end` entry removed from database

### 1.7 Error Cases

| Test | Command | Expected |
|------|---------|----------|
| Start when active | `/journal_start` (twice) | "لديك جلسة يوميات نشطة بالفعل" |
| End when none | `/journal_end` (no session) | "لا توجد جلسة يوميات نشطة" |
| Resume when active | `/journal_resume` (session open) | "جلسة اليوميات نشطة بالفعل" |
| Resume when none | `/journal_resume` (no session) | "لا توجد جلسة يوميات لاستئنافها" |

### 1.8 Journal in Report

**Action:**
1. Start journal session
2. Add some entries
3. End session
4. Run `/progress`

**Expected Result:**
- Report preview includes "📔 يوميات اليوم:" section
- Journal entries are listed

---

## Test 2: Weekly Goals Generation

### 2.1 View Goals (Empty)

**Command:** `/goals`

**Expected Result:**
```
🎯 **الأهداف الأسبوعية**

لا توجد أهداف محددة لهذا الأسبوع

⚡ **تحدي اليوم:**
لا يوجد تحدي لليوم
```

### 2.2 Generate New Goals

**Command:** `/generate_goals`

**Expected Results (in sequence):**
1. `🔄 جاري توليد أهداف الأسبوع القادم...`
2. Final message with:
   - Previous week evaluation
   - New goals (5-7 items)
   - Daily challenges (7 days)
   - Motivational message

**Verify:**
- [ ] Goals saved in `weekly_goals` table
- [ ] 7 challenges saved in `daily_challenges` table
- [ ] Each challenge has correct date (Saturday to Friday)

### 2.3 View Generated Goals

**Command:** `/goals`

**Expected Result:**
- Shows the generated goals text
- Shows today's challenge with status (⏳ pending)

### 2.4 Generate Goals Again

**Command:** `/generate_goals` (same week)

**Expected Result:**
```
❌ أهداف الأسبوع القادم موجودة بالفعل (YYYY-MM-DD - YYYY-MM-DD)
```

### 2.5 Database Verification

```sql
-- Check weekly goals
SELECT * FROM weekly_goals ORDER BY created_at DESC LIMIT 1;

-- Check daily challenges
SELECT * FROM daily_challenges ORDER BY challenge_date DESC LIMIT 7;
```

---

## Test 3: Todoist Task Creation

### 3.1 Create Tasks Without Goals

**Command:** `/createtasks` (before generating goals)

**Expected Result:**
```
❌ لا توجد أهداف أسبوعية. استخدم /generate_goals أولاً
```

### 3.2 Create Tasks With Goals

**Prerequisites:** Run `/generate_goals` first

**Command:** `/createtasks`

**Expected Results:**
1. `🔄 جاري إنشاء المهام في Todoist...`
2. Success message listing created tasks:
```
✅ **تم إنشاء X مهمة في Todoist!**

• [Task name]
  📅 YYYY-MM-DD ⭐⭐⭐

• [Task name]
  📅 YYYY-MM-DD ⭐⭐
...
```

**Verify:**
- [ ] Tasks appear in Todoist app
- [ ] Tasks have correct due dates
- [ ] Tasks have correct priorities (star count)
- [ ] Tasks are in the correct project

### 3.3 Todoist Verification

Check in Todoist:
- [ ] Tasks created in specified project
- [ ] Due dates are reasonable (within next week)
- [ ] Priorities are set (1-4)

---

## Test 4: Google Drive Integration

> **Note:** This test requires Google Drive to be configured. Skip if not using Drive.

### 4.1 Automatic Save After Report

**Prerequisites:**
- Configure `google_drive_folder_id`
- Configure `google_service_account` with valid JSON

**Action:**
1. Complete some tasks in Todoist
2. Run `/progress`
3. Run `/confirm`
4. Wait for AI analysis to complete

**Expected Result:**
- Report saved to Google Drive folder as `YYYY-MM-DD.md`
- `_LastUpdate.md` file updated with timestamp

**Verify in Google Drive:**
- [ ] Markdown file exists with today's date
- [ ] File contains the AI commentary
- [ ] `_LastUpdate.md` shows correct date/time

### 4.2 Check _LastUpdate.md Content

**Expected Content:**
```markdown
# آخر تحديث

📅 التاريخ: [Arabic date]
🕐 الوقت: [Time]

## آخر تقرير
- التاريخ: YYYY-MM-DD
- معدل النجاح: XX%
- المهام المكتملة: X

## السلاسل النشطة (X)
- [Task name]: X يوم
...

---
_تم التحديث تلقائياً بواسطة Progress Bot_
```

### 4.3 Error Handling

**Test:** Temporarily break Drive config

```sql
UPDATE settings SET value = 'invalid_folder_id' WHERE key = 'google_drive_folder_id';
```

**Run:** `/confirm`

**Expected:**
- Report still saves to database
- Warning logged in Cloudflare (non-fatal)
- User still receives report in Telegram

**Restore:**
```sql
UPDATE settings SET value = 'YOUR_CORRECT_FOLDER_ID' WHERE key = 'google_drive_folder_id';
```

---

## Test 5: Integration Tests

### 5.1 Full Daily Workflow

**Morning:**
1. `/journal_start` - Start journaling
2. Send morning reflection text
3. `/goals` - Check today's challenge

**Throughout Day:**
- Complete tasks in Todoist
- Send journal entries (text, photos)

**Evening:**
1. `/journal_end` - End journal session
2. `/progress` - Review day summary
3. `/confirm` - Generate full AI report

**Verify:**
- [ ] Journal entries appear in preview
- [ ] Tasks from Todoist are listed
- [ ] AI analysis includes journal context
- [ ] Report saved to database
- [ ] Report saved to Google Drive (if configured)

### 5.2 Weekly Planning Workflow

**Friday Evening:**
1. `/goals` - Review current week's progress
2. `/generate_goals` - Generate next week's goals
3. `/createtasks` - Create Todoist tasks

**Saturday Morning:**
1. `/goals` - See new week's goals
2. Check Todoist for new tasks
3. Start working!

---

## Test 6: Error Scenarios

### 6.1 API Key Issues

**Test:** Invalid OpenRouter key

```sql
UPDATE settings SET value = 'invalid-key' WHERE key = 'openrouter_api_key';
```

**Commands to test:**
- `/generate_goals` - Should show API error
- `/createtasks` - Should show API error
- `/confirm` - Should show API error

**Restore:** Put back valid key

### 6.2 Database Connection

**Monitor Cloudflare Logs for:**
- Connection errors
- Retry attempts
- Successful reconnections

### 6.3 Rate Limiting

**Todoist Test:**
- Create many tasks quickly
- Should see appropriate delays
- No 429 errors

---

## Test Checklist Summary

### Journal System
- [ ] Start session works
- [ ] Text entries save
- [ ] Photo entries save
- [ ] Video entries save
- [ ] Document entries save
- [ ] End session works
- [ ] Resume session works
- [ ] Journal appears in report

### Goals System
- [ ] View empty goals
- [ ] Generate goals (AI)
- [ ] View generated goals
- [ ] Challenges created correctly
- [ ] Duplicate generation prevented

### Todoist Integration
- [ ] Error without goals
- [ ] Tasks created successfully
- [ ] Tasks appear in Todoist
- [ ] Priorities correct
- [ ] Due dates correct

### Google Drive (if configured)
- [ ] Report saved as markdown
- [ ] _LastUpdate.md updated
- [ ] Error handling works

### Integration
- [ ] Full daily workflow
- [ ] Full weekly workflow
- [ ] Error recovery

---

## Troubleshooting Common Issues

### "مفتاح API غير مكون"
- Check `openrouter_api_key` in settings
- Ensure key starts with `sk-or-v1-`

### Goals not generating
- Check API key validity
- Check OpenRouter balance/limits
- Review Cloudflare logs

### Tasks not creating in Todoist
- Verify `todoist_api_token`
- Verify `todoist_project_id`
- Check Todoist API status

### Google Drive not saving
- Verify folder ID
- Check service account has access
- Validate JSON credentials format
- Check Cloudflare logs for auth errors

---

## Performance Benchmarks

| Operation | Expected Time |
|-----------|---------------|
| Journal entry save | < 500ms |
| Goals generation | 15-30s (AI) |
| Task creation (5-8 tasks) | 2-5s |
| Google Drive save | 1-3s |
| Full report generation | 30-90s |

---

## Sign-Off

After completing all tests:

- [ ] All journal tests pass
- [ ] All goals tests pass
- [ ] All Todoist tests pass
- [ ] All Drive tests pass (or N/A)
- [ ] Integration tests pass
- [ ] Error handling verified

**Tested By:** ________________
**Date:** ________________
**Version:** Phase 3
