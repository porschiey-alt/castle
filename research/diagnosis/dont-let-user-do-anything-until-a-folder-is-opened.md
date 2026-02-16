# Bug: Don't Let User Do Anything Until a Folder Is Opened

## Diagnosis and Suggested Fix

### Symptoms

When the app launches without a previously-saved directory (`currentDirectory` is `null`), the user can still:

1. **Click sidebar agent circles** — `SidebarComponent.selectAgent()` fires `agentService.selectAgent()` even though no workspace is loaded. This puts the app in a broken state because `agentService.workspacePath` is `null`, so no session can start, but the UI switches to the chat view anyway.
2. **Click the Tasks (castle logo) button** — `showTasks()` navigates to the task list and calls `taskService.loadTasks()`, which fires an IPC call without a scoped project directory. Tasks are project-scoped data, so this is meaningless without a folder.
3. **Click "Add Agent"** — The add-agent dialog opens, but saving a new agent config and calling `discoverAgents` requires a `workspacePath` (which is `null`).
4. **Sidebar, toolbar, and all navigation controls are fully interactive** — There is no gating or disabled state on any UI element when no folder is open.
5. **Settings page shows folder-scoped settings** — The full settings page renders regardless of folder state; it could show repository-scoped settings prematurely.

The only existing guard is in the **template's content area**: the `@else` branch at line 88 of `main-layout.component.html` shows a "Welcome" screen when no agent is selected. But this guard is insufficient — it doesn't prevent the sidebar, toolbar actions, or navigating to tasks/settings.

### Root Cause Analysis

The root cause is the absence of a **top-level "no folder open" gate** in the `MainLayoutComponent`. The layout unconditionally renders the full sidebar, toolbar, and content area. The `currentDirectory` field exists and is checked in `ngOnInit` to decide whether to discover agents, but it is **never used to conditionally disable or hide interactive elements**.

Specifically:

1. **`main-layout.component.html`** — The sidebar (`<aside class="agent-sidebar">`) and toolbar are always rendered. No `@if (currentDirectory)` gate wraps the interactive portions.
2. **`main-layout.component.ts`** — Methods like `showTasks()`, `showChat()`, `addAgent()`, `editAgent()`, and `goToAgent()` perform actions unconditionally, never checking `currentDirectory`.
3. **`sidebar.component.html`** — The agent list, tasks button, and add-agent button are always enabled.
4. **`task-list.component.ts`** — `ngOnInit` calls `loadTasks()` / `loadLabels()` without checking if a project is open.

There is no route guard, service-level guard, or UI-level guard that prevents interaction before a folder is opened.

### Suggested Fix

Introduce a **full-screen "Open a Project" overlay** that blocks all interaction until `currentDirectory` is set. This is the smallest change that provides the correct UX.

#### 1. Gate the layout in `main-layout.component.html`

Wrap the main interactive content in a conditional block and add a full-screen welcome/project-picker when no directory is set:

```html
<!-- main-layout.component.html -->
@if (!currentDirectory) {
  <!-- Full-screen project picker overlay — blocks all other interaction -->
  <div class="no-project-overlay">
    <div class="no-project-content">
      <span class="castle-logo-large">🏰</span>
      <h1>Welcome to Castle</h1>
      <p>Open a project folder to get started.</p>

      @if (recentDirectories.length > 0) {
        <div class="recent-projects">
          <h3>Recent Projects</h3>
          <div class="recent-list">
            @for (dir of recentDirectories; track dir) {
              <button class="recent-item" (click)="openRecentDirectory(dir)">
                <mat-icon>folder</mat-icon>
                <div class="recent-item-text">
                  <span class="recent-name">{{ getDirectoryName(dir) }}</span>
                  <span class="recent-path">{{ dir }}</span>
                </div>
              </button>
            }
          </div>
        </div>
      }

      <button mat-raised-button color="primary" (click)="openDirectory()">
        <mat-icon>folder_open</mat-icon>
        Open a Project
      </button>

      <!-- Settings is the one action allowed without a folder -->
      <button mat-button class="settings-link" (click)="showSettings()">
        <mat-icon>settings</mat-icon>
        Settings
      </button>
    </div>
  </div>
} @else {
  <!-- Existing full layout (sidebar + main content) goes here — unchanged -->
  <div class="app-container">
    ...existing layout...
  </div>
}
```

This replaces the current `<div class="app-container">` as the top-level element. When `currentDirectory` is `null`, the sidebar, agents, toolbar, chat, and tasks are **not rendered at all**.

#### 2. Handle the "Settings without a folder" exception

When the user clicks "Settings" from the overlay, render _only_ the settings page (no sidebar, no agents):

```html
@if (!currentDirectory) {
  @if (activeView === 'settings') {
    <div class="settings-only-container">
      <mat-toolbar class="app-toolbar">
        <div class="toolbar-left">
          <button mat-icon-button (click)="activeView = 'chat'">
            <mat-icon>arrow_back</mat-icon>
          </button>
          <mat-icon>settings</mat-icon>
          <span class="agent-name">Settings</span>
        </div>
        <div class="toolbar-right">
          <div class="window-controls">
            <button mat-icon-button (click)="minimizeWindow()"><mat-icon>remove</mat-icon></button>
            <button mat-icon-button (click)="maximizeWindow()"><mat-icon>crop_square</mat-icon></button>
            <button mat-icon-button class="close-btn" (click)="closeWindow()"><mat-icon>close</mat-icon></button>
          </div>
        </div>
      </mat-toolbar>
      <app-settings-page />
    </div>
  } @else {
    <div class="no-project-overlay">
      ...project picker as above...
    </div>
  }
} @else {
  <div class="app-container">
    ...existing layout...
  </div>
}
```

#### 3. Scope settings that require a folder

In `settings-page.component.html`, guard any repository-scoped settings sections with a check. Inject the `currentDirectory` state (e.g., via a service or input) and wrap folder-scoped sections:

```html
@if (currentDirectory) {
  <!-- Folder-scoped settings here -->
}
```

Currently, the settings page only has global settings (theme, remote access, about), so this is a future-proofing measure.

#### 4. Add defensive checks in service methods

As a defense-in-depth measure, guard key methods in the component:

```typescript
// main-layout.component.ts
showTasks(): void {
  if (!this.currentDirectory) return;   // ← guard
  this.activeView = 'tasks';
  this.closeSidebar();
  this.taskService.loadTasks();
}

showChat(): void {
  if (!this.currentDirectory) return;   // ← guard
  this.activeView = 'chat';
  this.closeSidebar();
  ...
}

addAgent(): void {
  if (!this.currentDirectory) return;   // ← guard
  ...
}
```

#### 5. Add the overlay styles in `main-layout.component.scss`

```scss
.no-project-overlay {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100dvh;
  width: 100vw;
  background-color: var(--bg-primary);
  color: var(--text-primary);
}

.no-project-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  max-width: 480px;
  text-align: center;
}

.castle-logo-large {
  font-size: 72px;
}

.settings-link {
  margin-top: 8px;
  color: var(--text-muted);
}

.settings-only-container {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  width: 100vw;
  background-color: var(--bg-primary);
}
```

### Verification Steps

1. **Fresh launch (no saved directory):**
   - App should show the full-screen project picker overlay.
   - No sidebar, no agent circles, no toolbar actions visible.
   - "Recent Projects" list displays if any exist.
   - "Open a Project" button triggers folder picker dialog.
   - "Settings" link opens settings without sidebar.

2. **Open a project:**
   - After selecting a directory, the full layout (sidebar + agents + chat) should appear.
   - Agents are discovered and first agent is auto-selected.

3. **Settings from overlay:**
   - Clicking "Settings" from the no-project overlay shows only the settings page with a back button.
   - Only global settings (theme, remote access) are visible — no folder-scoped settings.
   - Clicking back returns to the project picker.

4. **Switching directories:**
   - After opening one project, clicking "Open Directory" in the toolbar should work as before.

5. **Mobile behavior:**
   - The project picker should be responsive and usable on small screens.
   - After opening a project, the existing mobile sidebar behavior should be unchanged.

6. **Service-level guards:**
   - Calling `showTasks()`, `addAgent()`, or `showChat()` when `currentDirectory` is `null` should no-op.
