## Diagnosis and Suggested Fix

### Symptoms

1. **Conversation panel toggle button not visible on mobile.** The toolbar button that toggles the conversation list panel is pushed off-screen or obscured on narrow viewports. Users cannot open the conversation panel at all.
2. **When the sidebar (agent-nav) slides out via the hamburger menu, content behind it is still visible and interactive through the semi-transparent backdrop.** This creates visual clutter and potential mis-taps.
3. **The conversation panel, when opened, also shows content behind it through its semi-transparent backdrop**, making it hard to read the conversation list.

### Root Cause Analysis

**Issue 1 — Toggle button pushed off-screen**

The toolbar layout in `main-layout.component.scss` (lines 26–47) uses:

```scss
.app-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 16px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
```

`.toolbar-left` has **no `overflow: hidden`**, **no `min-width: 0`**, and **no `flex-shrink`**. It contains the menu button, agent icon, agent name, conversation title badge, and session status pill — all rendered inline. On a 375px mobile screen this content alone can easily exceed the available width, causing `.toolbar-right` (which holds the conversation toggle, folder, and settings buttons) to be pushed off the right edge of the viewport.

The toolbar itself has no `overflow: hidden`, so the overflow simply extends beyond the screen boundary. The conversation toggle button exists in the DOM but is not visible or tappable.

**Issue 2 — User's design preference: permanently expand panels on mobile**

The current design treats both the sidebar and conversation panel as slide-out overlays on mobile, toggled independently. The user requests that when the hamburger menu is pressed, **both** the sidebar (agent nav) and the conversation list should appear together as a single combined panel, eliminating the need for the separate conversation toggle button entirely.

**Issue 3 — Content visible behind overlays**

Both the sidebar backdrop (`.sidebar-backdrop`) and conversation backdrop (`.conversation-backdrop`) use `rgba(0, 0, 0, 0.5)` — a 50% transparent overlay. The chat messages and input area behind them are still partially visible, creating:
- Visual noise that makes the overlay content hard to read
- A sense that the background content is still interactive (confusing UX)

**Files involved:**

| File | Role |
|------|------|
| `src/app/layout/main-layout.component.html` | Template structure: sidebar, toolbar, conversation panel layout |
| `src/app/layout/main-layout.component.scss` | All layout styles including mobile `@media` block |
| `src/app/layout/main-layout.component.ts` | State management: `sidebarOpen`, `conversationPanelOpen`, toggle methods |

### Suggested Fix

The user wants a single combined panel on mobile that shows both agent-nav and conversation list together when the menu button is pressed. This eliminates the separate conversation toggle button problem entirely.

**1. On mobile, make the sidebar slide-out include the conversation list** (`main-layout.component.html`):

Restructure the mobile layout so that the sidebar overlay contains both the agent circles and the conversation list:

```html
<!-- Mobile backdrop overlay -->
<div class="sidebar-backdrop" [class.visible]="sidebarOpen" (click)="closeSidebar()"></div>

<!-- Sidebar — on mobile this is a combined agent-nav + conversation panel -->
<aside class="agent-sidebar" [class.open]="sidebarOpen">
  <app-sidebar ... />
  <!-- Conversation list shown inside sidebar on mobile -->
  <div class="mobile-conversations">
    @if (activeView === 'chat' && selectedAgent()) {
      <app-conversation-list (conversationSelected)="onConversationSelected($event)" />
    }
  </div>
</aside>
```

**2. Widen the sidebar on mobile to accommodate conversations** (`main-layout.component.scss`):

```scss
@media (max-width: 768px) {
  .agent-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 1000;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    width: 300px;       /* wider to fit conversations */
    min-width: 300px;
    display: flex;
    flex-direction: row; /* agent icons on left, conversations on right */

    &.open {
      transform: translateX(0);
    }

    app-sidebar {
      width: 72px;
      min-width: 72px;
      border-right: 1px solid var(--border-color);
    }

    .mobile-conversations {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background-color: var(--bg-secondary);
    }
  }

  /* Hide the standalone conversation panel on mobile — it's now inside the sidebar */
  .conversation-panel {
    display: none;
  }

  .conversation-backdrop {
    display: none;
  }

  /* Hide conversation toggle button on mobile since panel is in sidebar now */
  .conversation-toggle-mobile-hide {
    display: none;
  }
}
```

**3. Hide the `.mobile-conversations` div on desktop** (same SCSS file, outside the media query):

```scss
.mobile-conversations {
  display: none;
}
```

**4. Make the backdrop fully opaque on mobile** to hide content behind the panels:

```scss
@media (max-width: 768px) {
  .sidebar-backdrop {
    // ... existing styles ...
    background-color: rgba(0, 0, 0, 0.85); /* much more opaque */
    /* OR use a solid color matching the app background: */
    /* background-color: var(--bg-primary); */
  }
}
```

**5. Fix the toolbar overflow as a safety measure** — even though the conversation toggle button will be hidden on mobile, the toolbar should not overflow:

```scss
.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;      /* allow flex shrinking */
  overflow: hidden;   /* clip long content */
}

.agent-name {
  font-weight: 500;
  font-size: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conversation-title-badge {
  // ... existing styles ...
}

@media (max-width: 768px) {
  .conversation-title-badge {
    display: none;  /* hide on mobile to save toolbar space */
  }
}
```

**6. Close the sidebar when a conversation is selected on mobile** (`main-layout.component.ts`):

```typescript
async onConversationSelected(conversationId: string): Promise<void> {
  const agentId = this.agentService.selectedAgentId();
  if (agentId) {
    await this.chatService.loadHistory(agentId);
  }
  // Close sidebar on mobile after selection
  if (window.innerWidth <= 768) {
    this.sidebarOpen = false;
  }
}
```

This is already partially implemented for the conversation panel (`conversationPanelOpen = false`) but needs to also close the sidebar since the conversation list is now inside it.

### Verification Steps

1. **Mobile (≤768px):** Tap the hamburger menu. Verify a combined panel slides in from the left showing agent icons on the left rail and the conversation list on the right side.
2. **Backdrop:** Verify the content behind the panel is not visible — the backdrop should be nearly or fully opaque.
3. **Conversation selection:** Tap a conversation in the panel. Verify the panel closes and the selected conversation loads in the chat area.
4. **Agent selection:** Tap a different agent icon. Verify the conversation list updates to show that agent's conversations, and the panel stays open for the user to pick a conversation.
5. **Desktop (>768px):** Verify the sidebar still appears as a fixed 72px column on the left. The conversation panel should still be the separate collapsible side panel controlled by its own toggle button in the toolbar.
6. **Toolbar overflow:** On mobile, verify the toolbar does not overflow. The agent name should truncate with ellipsis if too long. The settings and folder buttons should remain visible and tappable.
7. **Tap outside to close:** Tap the backdrop area. Verify the combined panel closes.
