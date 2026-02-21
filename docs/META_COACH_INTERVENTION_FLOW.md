# Meta-coach intervention flow: decision → send

This document traces the path from **intervention decision** to **Telegram message sent**, and lists every **guard, condition, or early return** that can prevent the message from being sent after the decision is made.

---

## Where the decision is logged

- **Cron (scheduled):** `src/index.ts` — `debugLog(env, settings, \`Meta-coach intervention: ${decision.type} (level ${decision.escalationLevel})\`)`
- **Manual:** `src/bot/grammy.ts` (`/coach_check`) — `console.log(\`🔍 Decision: ${decision.type}...\`)` then `console.log(\`🔍 Executing intervention: ${decision.type}\`)`

If you see the decision in debug logs, the flow has already passed the **pre-decision** guards below.

---

## Flow overview (cron path — `src/index.ts`)

1. **Pre-decision guards** (if any fails → early return, no decision log)
2. `analyzeUserState(chatId)` → `userState`
3. `decideIntervention(userState)` → `decision`
4. **Guard:** `if (decision.type !== 'none')` — else no intervention, debugLog "No intervention needed"
5. `message = await metaCoach.executeIntervention(chatId, decision)`
6. **Guard:** `if (message)` — **if falsy, the entire send block is skipped (no Telegram call, no error log)**
7. Build keyboard, `fetch(Telegram sendMessage)`, retry without Markdown on 400, log success/failure

---

## Pre-decision guards (cron only)

These run **before** `decideIntervention`. If you see the decision in logs, these have already passed.

| # | Location | Condition | Effect |
|---|----------|-----------|--------|
| 1 | `index.ts` L108–111 | `!apiKey \|\| !chatId` | Early return; debugLog "Meta-coach skipped: missing API key or chat ID" |
| 2 | `index.ts` L114–118 | `coach.auto_mode === 'off'` | Early return; debugLog "Meta-coach skipped: auto_mode is off" |
| 3 | `index.ts` L124–137 | Current time in sleep window (`sleep_start`–`sleep_end`) | Early return; debugLog "Meta-coach skipped: sleep period" |
| 4 | **`index.ts` L139–144** | **`await isUserInTaskOrReportFlow(db, chatId)`** | **Early return; debugLog "Meta-coach skipped: user in task or report flow"** |

### Task / report flow guard (recent and critical)

**`isUserInTaskOrReportFlow`** (`src/utils/tasking-state.ts`) returns `true` if **any** of:

- **Task session:** `createTaskSessionManager(db).getActiveSession(chatId)` returns an active session (e.g. `/starttask` with Todoist in progress).
- **Conversation state keys** exist for this chat:
  - `active_task_${chatId}` — quick task / active task flow
  - `pending_duration_${chatId}` — awaiting duration (e.g. "20m")
  - `pending_quantity_${chatId}` — awaiting quantity
  - `task_select_${chatId}` — task selection for `/starttask`
  - `failure_select_${chatId}` / `failure_new_task_${chatId}` — log_failure flow
  - `post_qa_${chatId}` / `pending_report_save_${chatId}` — report analysis flow
  - **`chatId` (raw)** — `qa_report` uses `chat_id = chatId`; if that row exists, user is considered in report flow

If any of these exist, the **entire** meta-coach block is skipped (no decision, no send). So if you see the decision in logs, this guard did **not** fire for that run.

---

## Post-decision guards and failure points (cron)

After the decision is logged, the following can still prevent the message from being sent.

### 1. **`if (message)` in index.ts (L164)**

- **Condition:** `message` is falsy (`''`, `null`, `undefined`).
- **Effect:** The whole block that sends to Telegram (and creates pending check-in) is **skipped**. There is **no** log like "message empty" or "send skipped".
- **When `message` can be falsy:**
  - **`executeIntervention` returns `''`:** In `src/coach/meta-coach.ts`, `executeIntervention` has a `switch (decision.type)` with a `default: return '';`. So if `decision.type` is not one of the handled cases (e.g. typo or new type not added to the switch), the return is empty and the send is skipped.

### 2. **`executeIntervention` throws**

- **Effect:** Exception propagates to the outer `catch` in the scheduled handler; you get `console.error('❌ Scheduled task error:', error)`. No Telegram send is attempted.
- **Possible causes:**
  - **AI call:** `this.aiComplete(...)` in `generateMessage` — OpenRouter error, timeout (25s), empty response (client throws), or network failure.
  - **Context building:** `buildInterventionContext(chatId)` — DB or report-generator errors.
  - **Template / state:** Missing `PROMPTS[type][style]`, or thrown inside placeholder replacement / `getYesterdayTasksCount` / `getAvailableTasksCount` / battle state.
  - **Logging:** `logInteraction(chatId, type, message, escalationLevel)` — DB insert failure.

So if you see the decision log followed by **"Scheduled task error"**, the failure is inside `executeIntervention` (or `generateMessage` / `buildInterventionContext` / `logInteraction`).

### 3. **Telegram send fails (message is truthy)**

- **Condition:** `message` is non-empty but `fetch(sendMessage)` returns `!telegramResponse.ok` and (if status 400) the retry without Markdown also fails.
- **Effect:** User never receives the message; you get `console.error('❌ Failed to send meta-coach message:', ...)`.
- **Causes:** Network error, invalid `chat_id`, bot blocked, message too long, or Markdown that breaks parsing and retry still failing.

---

## Guards inside `decideIntervention` (meta-coach.ts)

These run **before** the decision object is returned. They can only produce `type: 'none'` (so you would **not** see a non-none decision in logs if these fire).

- **Sleep period:** `isInSleepPeriod(state.currentHour, ...)` → `return { type: 'none', ... }`.
- **Active task session:** `state.activeTaskSession` → `return { type: 'none', ... }`.

So if you see a non-none decision (e.g. `momentum_check`), sleep and active-task-session checks have already been passed.

---

## Summary: what can prevent send **after** you see the decision?

| # | Cause | Where | What you see in logs / behavior |
|---|--------|--------|-----------------------------------|
| 1 | **Empty message** (switch default in `executeIntervention`) | `meta-coach.ts` | Decision log; no send; **no** "message empty" log |
| 2 | **Throw inside `executeIntervention`** (AI, context, logInteraction, etc.) | `meta-coach.ts` → `index.ts` catch | Decision log; then **"❌ Scheduled task error"**; no send |
| 3 | **Telegram API failure** (both initial and retry without Markdown fail) | `index.ts` after `if (message)` | Decision log; **"❌ Failed to send meta-coach message"**; no delivery |

---

## Recommended next steps

1. **Confirm which path you see the decision on** — cron (scheduled) vs `/coach_check`. That determines whether pre-decision guards (e.g. `isUserInTaskOrReportFlow`) could have run in a different run than the one where the decision appears.
2. **Check for "Scheduled task error"** right after the decision log — if present, the failure is inside `executeIntervention` (AI, DB, or logging).
3. **If no error is logged:** Likely **`message` is falsy** (switch default). Add a log right after `executeIntervention` in `index.ts`, e.g. `if (!message) await debugLog(env, settings, \`Meta-coach send skipped: executeIntervention returned empty (decision.type=${decision.type})\`);` to confirm.
4. **If Telegram send fails:** Check the response body in "Failed to send meta-coach message" (e.g. Markdown, length, chat_id).

---

## /coach_check path (grammy.ts) — difference

- **No `if (message)` guard:** It always calls `sendTelegramMessageDirect(..., message, ...)` after `executeIntervention`. So empty `message` would still be sent (with the check-in footer).
- **Only way the intervention text is not sent:** `executeIntervention` throws → catch runs → user gets "❌ حدث خطأ" and you get "Coach check background error".
- Pre-decision: **`isUserInTaskOrReportFlow`** (L3707–3710) replies with "انت حالياً في مهمة أو تحليل تقرير..." and returns without running the background task.
