# Show Task Name in Conversation as Secondary Accent Color

## Diagnosis and Suggested Fix

### Symptoms

In the chat view, when a conversation is linked to a task, a banner at the top displays the task title as a clickable link. This link uses the **primary theme color** (`--theme-primary`, blue `#58a6ff` by default), which can be hard to read against the chat background depending on the theme.

### Root Cause Analysis

**File:** `src/app/features/chat/chat.component.scss`, line 34

```scss
.task-link {
    color: var(--theme-primary, #58a6ff);
```

The `.task-link` class explicitly uses `--theme-primary`. The user expects it to use the accent/secondary color (`--theme-accent`) which is more readable and consistent with other interactive elements in the app (sidebar active state, resume indicator, todo checkmarks, status bar, etc.).

### Suggested Fix (Applied)

**File:** `src/app/features/chat/chat.component.scss`, line 34

Changed `--theme-primary` to `--theme-accent`:

```scss
.task-link {
    color: var(--theme-accent, #22c55e);
```

### Verification Steps

1. Open a conversation linked to a task — the task title in the banner should now use the accent color (green by default).
2. Switch themes — confirm the link color follows `--theme-accent` across all themes.
3. Hover on the link — underline still appears on hover.
4. Click the link — still navigates to the task detail view.
