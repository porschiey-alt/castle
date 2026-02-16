# Responsive App – Research & Implementation Guide

## Problem Statement

Castle is currently a fixed-layout desktop Electron app with no responsive CSS. The layout assumes a wide viewport: a **72px fixed sidebar** on the left and a flex-grow main content area. On a mobile-sized screen (or a narrow window), the sidebar consumes disproportionate space and the content area becomes too cramped to be usable.

**Goal:** Make the app responsive enough for mobile-width screens by collapsing/hiding the sidebar on small viewports and providing a toggle button in the top toolbar to bring it back — similar to how Discord handles its mobile layout.

---

## Current Architecture Analysis

### Layout Structure

```
┌──────────────────────────────────────────┐
│ .app-container  (flex row, 100vw×100vh)  │
│ ┌──────────┬─────────────────────────────┤
│ │ <aside>  │ <main class="main-content"> │
│ │ .agent-  │ ┌─────────────────────────┐ │
│ │ sidebar  │ │ .app-toolbar  (48px)    │ │
│ │ (72px)   │ ├─────────────────────────┤ │
│ │          │ │ .chat-container (flex 1) │ │
│ │          │ │  - chat / tasks / empty  │ │
│ │          │ ├─────────────────────────┤ │
│ │          │ │ <app-status-bar> (24px)  │ │
│ └──────────┴─┴─────────────────────────┘ │
└──────────────────────────────────────────┘
```

### Key Files

| File | Role |
|------|------|
| `src/app/layout/main-layout.component.html` | Root layout template — contains `<aside>` sidebar + `<main>` |
| `src/app/layout/main-layout.component.scss` | Flex layout, toolbar, chat container styles |
| `src/app/layout/main-layout.component.ts` | Layout logic, view switching, window controls |
| `src/app/features/sidebar/sidebar.component.*` | Agent list, tasks button, add-agent button |
| `src/app/features/sidebar/agent-circle/agent-circle.component.*` | Individual 48×48 agent buttons |
| `src/app/shared/components/status-bar/status-bar.component.*` | Bottom 24px status bar |
| `src/app/features/chat/chat-input/chat-input.component.scss` | Chat input area |
| `src/app/features/chat/message-bubble/message-bubble.component.scss` | Message display |
| `src/styles/styles.scss` | Global theme variables, Material overrides |
| `src/index.html` | Already has `<meta name="viewport" ...>` ✅ |

### Current Responsive State

- **Zero `@media` queries** exist anywhere in the codebase.
- The sidebar is a static `<aside>` element — not using Angular Material's `<mat-sidenav>`, despite `MatSidenavModule` being imported.
- All widths are fixed (`72px` sidebar, `48px` agent circles, `900px` max-width messages).
- The toolbar has `-webkit-app-region: drag` for Electron frameless window dragging.
- Window controls (minimize/maximize/close) are Electron-specific and should be hidden or repositioned on mobile.

---

## Proposed Approach

### Strategy: CSS-First with Minimal Component Changes

Use **CSS media queries** as the primary mechanism, with a small amount of component state to control the sidebar overlay toggle. This minimizes code changes and keeps the desktop experience untouched.

### Breakpoint

| Breakpoint | Width | Behavior |
|------------|-------|----------|
| Desktop | ≥ 769px | Current behavior — sidebar always visible |
| Mobile | ≤ 768px | Sidebar hidden; overlay toggle via hamburger button in toolbar |

768px is a standard tablet/mobile breakpoint and matches Discord's approach.

### Design (Discord-Like)

```
DESKTOP (unchanged)                 MOBILE (collapsed)
┌────┬─────────────────┐          ┌─────────────────────┐
│ 🏰 │ 🤖 AgentName    │          │ ☰  🤖 AgentName     │
│────│                 │          │─────────────────────│
│ 🤖 │  Chat messages  │          │  Chat messages      │
│ 🤖 │                 │          │                     │
│────│                 │          │                     │
│ ➕ │  [input bar]    │          │  [input bar]        │
└────┴─────────────────┘          └─────────────────────┘

MOBILE (sidebar open — overlay)
┌────┬─────────────────┐
│ 🏰 │░░░░░░░░░░░░░░░░░│  ← dark overlay behind sidebar
│────│░░░░░░░░░░░░░░░░░│
│ 🤖 │░░░░░░░░░░░░░░░░░│
│ 🤖 │░░░░░░░░░░░░░░░░░│
│────│░░░░░░░░░░░░░░░░░│
│ ➕ │░░░░░░░░░░░░░░░░░│
└────┴─────────────────┘
```

---

## Detailed Implementation Plan

### 1. Add Sidebar Toggle State to `MainLayoutComponent`

**File:** `src/app/layout/main-layout.component.ts`

Add a `sidebarOpen` boolean property (default `false` on mobile). The sidebar overlay should auto-close when the user selects an agent or switches views.

```typescript
sidebarOpen = false;

toggleSidebar(): void {
  this.sidebarOpen = !this.sidebarOpen;
}

closeSidebar(): void {
  this.sidebarOpen = false;
}
```

Update event handlers that navigate away (e.g., `showChat()`, `showTasks()`, `goToAgent()`) to also call `closeSidebar()`.

### 2. Update the Layout Template

**File:** `src/app/layout/main-layout.component.html`

Add a **hamburger menu button** in the toolbar (left side), visible only on mobile. Add a **backdrop overlay** behind the sidebar for mobile. Add CSS class bindings for open/close state.

```html
<div class="app-container">
  <!-- Mobile backdrop overlay -->
  <div class="sidebar-backdrop" 
       [class.visible]="sidebarOpen" 
       (click)="closeSidebar()"></div>

  <!-- Sidebar -->
  <aside class="agent-sidebar" [class.open]="sidebarOpen">
    <app-sidebar 
      (addAgentClicked)="addAgent()" 
      (tasksClicked)="showTasks(); closeSidebar()" 
      (agentSelected)="showChat(); closeSidebar()" />
  </aside>

  <!-- Main content -->
  <main class="main-content">
    <mat-toolbar class="app-toolbar">
      <div class="toolbar-left">
        <!-- Hamburger button (mobile only) -->
        <button mat-icon-button class="sidebar-toggle" (click)="toggleSidebar()">
          <mat-icon>menu</mat-icon>
        </button>
        <!-- ...existing agent name / status... -->
      </div>
      <!-- ...rest of toolbar... -->
    </mat-toolbar>
    <!-- ...rest of main content... -->
  </main>
</div>
```

### 3. Add Responsive CSS

**File:** `src/app/layout/main-layout.component.scss`

This is where the bulk of the work happens.

```scss
// ---- Mobile Responsive ----
.sidebar-toggle {
  display: none;  // Hidden on desktop
}

.sidebar-backdrop {
  display: none;  // Hidden on desktop
}

@media (max-width: 768px) {
  .sidebar-toggle {
    display: inline-flex;
  }

  .agent-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 1000;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    width: 72px;
    min-width: 72px;

    &.open {
      transform: translateX(0);
    }
  }

  .sidebar-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 999;
    background-color: rgba(0, 0, 0, 0.5);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s ease;

    &.visible {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .main-content {
    width: 100vw;
  }

  // Hide window controls on mobile (not an Electron frameless window on mobile)
  .window-controls {
    display: none;
  }
}
```

### 4. Additional Component-Level Responsive Tweaks

These are smaller adjustments for a better mobile experience.

#### Message List — reduce padding and max-width
**File:** `src/app/features/chat/message-list/message-list.component.scss`

```scss
@media (max-width: 768px) {
  .message-list-container {
    padding: 8px;
  }

  .messages-wrapper {
    max-width: 100%;
  }
}
```

#### Message Bubble — reduce horizontal padding
**File:** `src/app/features/chat/message-bubble/message-bubble.component.scss`

```scss
@media (max-width: 768px) {
  .message-bubble {
    padding: 6px 8px;
    gap: 8px;
  }

  .avatar {
    width: 32px;
    height: 32px;
    min-width: 32px;
  }
}
```

#### Chat Input — reduce padding
**File:** `src/app/features/chat/chat-input/chat-input.component.scss`

```scss
@media (max-width: 768px) {
  .chat-input-container {
    padding: 8px;
  }
}
```

#### Status Bar — consider hiding or simplifying
**File:** `src/app/shared/components/status-bar/status-bar.component.scss`

```scss
@media (max-width: 768px) {
  .status-bar {
    padding: 0 8px;
  }
  // Optionally hide the model selector to save space
  .model-selector {
    display: none;
  }
}
```

#### Task List — adjust spacing
**File:** `src/app/features/tasks/task-list/task-list.component.scss`

```scss
@media (max-width: 768px) {
  .tasks-header {
    padding: 12px 12px;
  }

  .filter-bar {
    padding: 8px 12px;
  }

  .task-items {
    padding: 4px 8px;
  }

  .task-card {
    padding: 10px 12px;
  }
}
```

#### Task Detail — stack meta fields vertically
**File:** `src/app/features/tasks/task-detail/task-detail.component.scss`

```scss
@media (max-width: 768px) {
  .detail-header {
    padding: 12px;
  }

  .detail-meta {
    flex-direction: column;
    align-items: flex-start;
    padding: 8px 12px;
    gap: 8px;
  }

  .tab-body,
  .detail-body {
    padding: 12px;
  }
}
```

---

## Considerations

### Angular Material `MatSidenav` vs Custom CSS

The project already imports `MatSidenavModule`, so an alternative approach is to replace the `<aside>` with `<mat-sidenav-container>` / `<mat-sidenav>`. However:

| Factor | Custom CSS (Recommended) | MatSidenav |
|--------|--------------------------|------------|
| Change size | Small — CSS only + 1 property + 1 template element | Medium — restructure template significantly |
| Desktop behavior | Unchanged | Needs `mode="side"` + `opened="true"` toggling |
| Mobile behavior | Overlay with backdrop, easy | Built-in overlay mode works well |
| Animation | CSS transitions (simple) | Built-in animations (heavier) |
| Bundle impact | None | Already imported, no extra cost |

**Recommendation:** Use the custom CSS approach. It's minimal, keeps the desktop layout untouched, and only adds behavior for mobile. The MatSidenav approach would require restructuring the HTML and managing opened/mode state across breakpoints.

### Electron Window Controls

The minimize/maximize/close buttons in the toolbar are Electron-specific frameless window controls. On a true mobile deployment they'd be irrelevant. For now, hiding them at ≤768px is sufficient since a mobile-width Electron window is unlikely to use frameless mode. If Castle is ever served as a web app or PWA, this is already handled.

### Touch Targets

On mobile, interactive elements should be at least 44×44px (Apple HIG) or 48×48dp (Material). The sidebar agent circles are already 48×48px ✅. The toolbar buttons (icon buttons) are 40×40px by default in Angular Material — consider adding a small override to increase to 44px on mobile.

### Swipe Gesture (Optional Enhancement)

A swipe-from-left gesture to open the sidebar would make the mobile experience more natural (like Discord). This can be implemented with:
- A `@HostListener('touchstart')` / `@HostListener('touchmove')` / `@HostListener('touchend')` in the layout component
- Or the [HammerJS](https://hammerjs.github.io/) library (Angular has built-in HammerJS support via `@angular/platform-browser`)

This is a nice-to-have and can be added later.

### Performance

All proposed changes use CSS transforms and opacity for animations, which are GPU-accelerated and won't cause layout thrashing. The `transform: translateX()` approach for sliding the sidebar in/out is the most performant option.

### Testing Considerations

- Test at common mobile widths: 375px (iPhone SE), 390px (iPhone 14), 412px (Pixel), 768px (iPad portrait)
- Test sidebar open/close transitions
- Test that selecting an agent closes the sidebar
- Test that the backdrop click closes the sidebar
- Verify the chat input is usable at narrow widths (textarea should not be clipped)
- Test landscape orientation on mobile (wider but shorter viewport)

---

## Implementation Checklist

1. **`main-layout.component.ts`** — Add `sidebarOpen` state, `toggleSidebar()`, `closeSidebar()` methods; wire close into navigation handlers
2. **`main-layout.component.html`** — Add hamburger button, backdrop div, CSS class bindings
3. **`main-layout.component.scss`** — Add `@media (max-width: 768px)` block with sidebar overlay, backdrop, toggle visibility
4. **`message-list.component.scss`** — Reduce padding and max-width on mobile
5. **`message-bubble.component.scss`** — Reduce padding, shrink avatar
6. **`chat-input.component.scss`** — Reduce padding on mobile
7. **`status-bar.component.scss`** — Simplify on mobile
8. **`task-list.component.scss`** — Reduce spacing on mobile
9. **`task-detail.component.scss`** — Stack meta fields, reduce padding
10. **Smoke test** — Resize window or use DevTools device emulation to verify at 375px, 768px, and 1024px+

---

## Estimated Scope

- **Files modified:** ~9 (1 TS, 1 HTML, 7 SCSS)
- **Lines added:** ~100-130 (mostly CSS media queries)
- **Lines modified:** ~5-10 (template + TS)
- **Risk:** Low — all changes are additive media queries that don't affect the desktop layout
- **No new dependencies required**
