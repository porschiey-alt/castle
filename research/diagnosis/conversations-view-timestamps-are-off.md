## Diagnosis and Suggested Fix

### Symptoms

Conversations created via the Research or Implement tab show a timestamp of "-1 days ago" (i.e., in the future) in the conversation list. Manually created conversations display correctly.

The "-1 days ago" text comes from the `formatTime()` function in `conversation-list.component.ts` when `diffDays` is negative — meaning the stored `updatedAt` timestamp is being interpreted as a time in the future.

### Root Cause Analysis

The database has an **inconsistent timestamp format** between INSERT and UPDATE operations. This causes JavaScript's `new Date()` to interpret the same UTC instant differently depending on which operation wrote it last.

**Two conflicting patterns in `database.service.ts`:**

| Operation | Code | Produces | JS `new Date()` interprets as |
|-----------|------|----------|-------------------------------|
| `createConversation` (line 538) | `new Date().toISOString()` | `"2026-02-17T04:56:29.014Z"` | **UTC** ✅ |
| `saveMessage` → update conversation (line 440) | `datetime('now')` | `"2026-02-17 04:56:29"` | **Local time** ❌ |
| `updateConversation` (line 630) | `datetime('now')` | `"2026-02-17 04:56:29"` | **Local time** ❌ |
| `updateTask` (line 882) | `datetime('now')` | `"2026-02-17 04:56:29"` | **Local time** ❌ |

SQLite's `datetime('now')` returns UTC, but in the format `"YYYY-MM-DD HH:MM:SS"` — **without** a timezone indicator. Per the ECMAScript spec, `new Date("2026-02-17 04:56:29")` (no `T`, no `Z`) is parsed as **local time**, not UTC. So a UTC value of 04:56 in a UTC-7 timezone is interpreted as 04:56 local, which equals 11:56 UTC — **7 hours into the future**.

**Why it only affects research/implement conversations:**

1. `createConversation` writes `created_at` and `updated_at` with `new Date().toISOString()` → correct `Z`-suffixed format.
2. When research/implement runs, it immediately sends a message via `saveMessage`, which triggers `UPDATE conversations SET updated_at = datetime('now')` — overwriting `updated_at` with the `Z`-less format.
3. The conversation list sorts by and displays `updatedAt`, which is now the incorrectly-formatted value.
4. Manually created conversations that haven't yet received a message still have the original ISO `updated_at` and display correctly.

**The same bug also affects task timestamps** (`updateTask` at line 882 uses `datetime('now')`), though the task list may not display relative timestamps so it's less visible.

**Files involved:**

| File | Lines | Issue |
|------|-------|-------|
| `src/main/services/database.service.ts` | 440, 630, 882 + 12 others | `datetime('now')` produces timestamps without `Z` suffix |
| `src/app/features/chat/conversation-list/conversation-list.component.ts` | 86–101 | `formatTime()` doesn't guard against negative `diffDays` |

### Suggested Fix

**Primary fix: Normalize all `datetime('now')` calls to include UTC suffix.**

Replace every use of `datetime('now')` with a JavaScript-generated ISO string, or append `'Z'` to the SQLite output. The simplest approach is to replace `datetime('now')` with a parameter bound to `new Date().toISOString()` in every write location.

In `src/main/services/database.service.ts`, for each occurrence:

```typescript
// BEFORE (13 occurrences across the file)
sets.push("updated_at = datetime('now')");

// AFTER
sets.push("updated_at = ?");
params.unshift(new Date().toISOString());  // or push, depending on param order
```

Specifically, the conversation-relevant locations:

**Line 440** — `saveMessage` updates conversation `updated_at`:
```typescript
// BEFORE
this.db.run(
  `UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`,
  [message.conversationId]
);

// AFTER
this.db.run(
  `UPDATE conversations SET updated_at = ? WHERE id = ?`,
  [new Date().toISOString(), message.conversationId]
);
```

**Line 630** — `updateConversation`:
```typescript
// BEFORE
sets.push("updated_at = datetime('now')");

// AFTER
sets.push("updated_at = ?");
params.push(new Date().toISOString());
```

**Line 882** — `updateTask`:
```typescript
// BEFORE
sets.push("updated_at = datetime('now')");

// AFTER
sets.push("updated_at = ?");
params.push(new Date().toISOString());
```

Apply the same pattern to all other `datetime('now')` occurrences (lines 333, 334, 396, 397, 721, 723, 803, 804, 1066, 1078).

**Secondary fix: Make `formatTime()` defensive against negative values.**

In `src/app/features/chat/conversation-list/conversation-list.component.ts`:

```typescript
formatTime(date: Date | string): string {
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    // Future date — treat as "just now" (defensive fallback)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}
```

### Verification Steps

1. **Create a conversation via Research tab.** Verify its timestamp in the conversation list shows today's time (e.g., "2:07 AM"), not "-1 days ago".
2. **Create a conversation via Implement tab.** Same check.
3. **Send a manual message in a conversation.** Verify the conversation's timestamp updates to the current time without jumping to the future.
4. **Check across timezones.** The fix ensures all stored values are ISO 8601 with `Z`, so `new Date()` always parses them as UTC regardless of local timezone.
5. **Verify task timestamps.** Update a task's state or content. Confirm `updatedAt` is correct (this was also affected by the same `datetime('now')` bug).
6. **Check existing data.** Old rows with `datetime('now')` format will still parse incorrectly until they are next updated. Consider a one-time migration that appends `Z` to all `updated_at`/`created_at` values that lack it:
   ```sql
   UPDATE conversations SET updated_at = updated_at || 'Z' WHERE updated_at NOT LIKE '%Z';
   UPDATE conversations SET created_at = created_at || 'Z' WHERE created_at NOT LIKE '%Z';
   UPDATE tasks SET updated_at = updated_at || 'Z' WHERE updated_at NOT LIKE '%Z';
   UPDATE tasks SET created_at = created_at || 'Z' WHERE created_at NOT LIKE '%Z';
   ```
