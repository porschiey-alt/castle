# Research: Conversation Width Is Too Narrow

## Executive Summary

The conversation (chat) view in Castle is artificially constrained to a **maximum width of 900px** via the `.messages-wrapper` class in `message-list.component.scss`. This causes the message content area to appear narrow—especially on wide monitors or maximized windows—leaving large empty gutters on both sides. The goal is to make the conversation view expand to fill the full width of its container.

## Technical Analysis

### Component Hierarchy

The layout flows as follows:

```
.app-container (100vw)
  └─ .agent-sidebar (72px fixed)
  └─ .main-content (flex: 1)
       └─ .app-toolbar (48px height)
       └─ .content-wrapper (flex row)
            ├─ .conversation-panel (240px side panel, collapsible)
            └─ .chat-container (flex: 1)
                 └─ <app-chat>
                      └─ .chat-wrapper (flex column, flex: 1)
                           ├─ <app-message-list>
                           │    └─ .message-list-container (flex: 1, overflow-y: auto)
                           │         └─ .messages-wrapper ← **max-width: 900px; margin: 0 auto**
                           │              └─ <app-message-bubble> (each message)
                           └─ <app-chat-input>
                                └─ .chat-input-container (width: 100%)
```

### Width Constraints Identified

| File | Selector | Current Value | Purpose |
|------|----------|---------------|---------|
| `src/app/features/chat/message-list/message-list.component.scss:33` | `.messages-wrapper` | `max-width: 900px` | **Primary constraint** — caps the message column |
| `src/app/features/chat/message-list/message-list.component.scss:34` | `.messages-wrapper` | `margin: 0 auto` | Centers the capped column (creates side gutters) |
| `src/app/features/chat/message-list/message-list.component.scss:51` | `@media ≤768px .messages-wrapper` | `max-width: 100%` | Already full-width on mobile |

**No other container in the hierarchy restricts width.** The `chat-container`, `chat-wrapper`, `message-list-container` all use `flex: 1` or `width: 100%`, so they already fill available space. The `chat-input-container` also has `width: 100%` and no `max-width`.

### Why 900px Exists

The `900px` cap is a common UX pattern to maintain readable line lengths for text-heavy content (similar to GitHub issues, ChatGPT, etc.). Removing it will make messages span the full window width. This is a deliberate design trade-off the user is requesting.

## Proposed Approach

### Option A: Remove `max-width` entirely (simplest)

**1 line change** — remove or change the `max-width` on `.messages-wrapper`.

**File:** `src/app/features/chat/message-list/message-list.component.scss`

```scss
// BEFORE (lines 29-35)
.messages-wrapper {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 900px;
  margin: 0 auto;
}

// AFTER
.messages-wrapper {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
```

Changes:
- **Remove** `max-width: 900px` (line 33)
- **Remove** `margin: 0 auto` (line 34) — no longer needed since centering is irrelevant at full width

The `@media (max-width: 768px)` override on line 50-52 that sets `max-width: 100%` becomes a no-op and can optionally be removed for cleanliness.

### Option B: Increase `max-width` to a larger value

If full-width feels too wide on ultra-wide monitors, an alternative is:

```scss
.messages-wrapper {
  max-width: 1400px;  // or 1600px, or any preferred value
  margin: 0 auto;
}
```

This preserves some readability guardrails on very wide screens.

### Option C: Use a percentage instead of a fixed value

```scss
.messages-wrapper {
  max-width: 95%;  // or 100%
  margin: 0 auto;
}
```

## Recommended Implementation (Option A)

Based on the user's request ("increase it to the size of the window it's contained in"), **Option A** is the correct choice.

### Step-by-Step

1. **Edit** `src/app/features/chat/message-list/message-list.component.scss`:
   - Line 33: Remove `max-width: 900px;`
   - Line 34: Remove `margin: 0 auto;`
2. **Optionally clean up** the now-unnecessary mobile media query override (lines 50-52) that sets `max-width: 100%` on `.messages-wrapper`.
3. **Verify** the chat input (`chat-input.component.scss`) — already `width: 100%` with no `max-width`, so it will naturally match. ✅
4. **Build & test** to confirm no layout regressions.

### Files to Modify

| File | Change |
|------|--------|
| `src/app/features/chat/message-list/message-list.component.scss` | Remove `max-width: 900px` and `margin: 0 auto` from `.messages-wrapper` |

### Files That Need No Changes

- `chat.component.scss` — no width constraints
- `chat-input.component.scss` — already full-width
- `main-layout.component.scss` — flex layout already fills available space
- `message-bubble.component.scss` — no width cap on bubble container
- `styles.scss` — no relevant constraints

## Key Considerations

### Risks
- **Readability on ultra-wide monitors**: Messages will span very wide, which can reduce readability. Users on 2560px+ monitors may find text lines uncomfortably long. This is a UX trade-off the user explicitly requested.
- **Message bubble styling**: The `.message-bubble` has no `max-width`, so bubbles will also expand. The `message-body` inside uses natural content sizing, so this should be fine.

### Edge Cases
- **Code blocks**: Wide code blocks will have more horizontal room, which is actually a benefit.
- **Images/media**: Any future inline media would also expand. Currently no embedded images in messages, so not a concern.
- **Mobile**: The `@media (max-width: 768px)` block already sets `max-width: 100%`, so mobile is unaffected by this change (it was already full-width).

## Estimated Complexity

**Trivial** — 1 file, 2 lines removed. No logic changes, no TypeScript changes, no dependency changes.

## Dependencies

None. This is a pure CSS change with no impact on component logic, data flow, or build configuration.
