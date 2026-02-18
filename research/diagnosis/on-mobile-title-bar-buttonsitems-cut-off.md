# On Mobile Title Bar Buttons/Items Cut Off

## Diagnosis and Suggested Fix

### Symptoms

On mobile viewports (≤768px), the toolbar right-side action buttons — settings cog, "Open Directory" button — and the left-side status badge ("Not Ready", "Busy", "Ready") are cut off or pushed out of view. This happens when the agent name or conversation title text is long, because the `.toolbar-left` div grows unconstrained and squeezes `.toolbar-right` off-screen.

### Root Cause Analysis

**File:** `src/app/layout/main-layout.component.scss`  
**Lines:** 26–47 (`.app-toolbar`, `.toolbar-left`, `.toolbar-right`)

The toolbar uses `display: flex; justify-content: space-between` (line 34), which correctly places `.toolbar-left` and `.toolbar-right` at opposite ends. However:

1. **`.toolbar-left` (line 43) has no width constraint.** It uses `display: flex; gap: 8px` but has no `overflow: hidden`, `min-width: 0`, or `flex-shrink` rule. On mobile, where horizontal space is very limited, the combined width of the agent icon + agent name + conversation title badge + session status badge can exceed the available space.

2. **`.agent-name` (line 53) has no overflow handling.** It renders at `font-size: 16px; font-weight: 500` with no `max-width`, `overflow: hidden`, or `text-overflow: ellipsis`. A long agent name alone can consume the entire toolbar width.

3. **`.conversation-title-badge` (line 146) has `max-width: 200px` with ellipsis**, which helps but is still too wide for mobile. 200px on a 320px–375px screen is already >50% of the viewport.

4. **`.toolbar-right` (line 90) has no `flex-shrink: 0`.** When `.toolbar-left` overflows, the browser may shrink `.toolbar-right` to accommodate, pushing buttons partially or fully off-screen.

The net effect: on narrow screens, the left section's content pushes the right section's buttons out of the visible area. The left section itself may also have internal items (like the session status badge) clipped without any visible indication.

### Suggested Fix

**File:** `src/app/layout/main-layout.component.scss`

Apply the following changes:

#### 1. Constrain `.toolbar-left` and allow it to shrink (line 43)

```scss
.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;        /* allow flex item to shrink below content size */
  overflow: hidden;     /* clip overflowing children */
}
```

#### 2. Prevent `.toolbar-right` from shrinking (line 90)

```scss
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;      /* never shrink — buttons must always be visible */
}
```

#### 3. Add ellipsis truncation to `.agent-name` (line 53)

```scss
.agent-name {
  font-weight: 500;
  font-size: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

#### 4. Reduce `.conversation-title-badge` max-width on mobile (inside the `@media` block at line 327)

Add to the existing `@media (max-width: 768px)` block:

```scss
@media (max-width: 768px) {
  // ... existing rules ...

  .conversation-title-badge {
    max-width: 100px;
  }

  .agent-name {
    max-width: 120px;
  }
}
```

#### Summary of all changes

| Selector | Property Added | Purpose |
|---|---|---|
| `.toolbar-left` | `min-width: 0; overflow: hidden` | Allow left section to shrink, clip overflow |
| `.toolbar-right` | `flex-shrink: 0` | Prevent right-side buttons from being squeezed |
| `.agent-name` | `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` | Truncate long agent names with ellipsis |
| `.conversation-title-badge` (mobile) | `max-width: 100px` | Reduce conversation title width on small screens |
| `.agent-name` (mobile) | `max-width: 120px` | Cap agent name width on small screens |

### Verification Steps

1. **Resize browser** to ≤768px (or use DevTools mobile emulation at 375px width).
2. **Set a long agent name** (e.g., "My Very Long Agent Name For Testing Purposes") and verify it truncates with an ellipsis.
3. **Start a conversation with a long title** and verify the conversation title badge also truncates.
4. **Confirm all right-side buttons remain visible**: settings cog, folder icon, and any other toolbar-right items.
5. **Confirm the session status badge** ("Ready", "Busy", etc.) remains visible when present.
6. **Test on desktop** (>768px) to ensure no regression — text should still display normally with only the existing `conversation-title-badge` ellipsis at 200px.
7. **Test edge case**: agent with no session status and short name — verify no unnecessary truncation occurs.
8. **Test the landing toolbar** — it uses a separate `.landing-toolbar-left` class and is likely unaffected, but spot-check for consistency.
