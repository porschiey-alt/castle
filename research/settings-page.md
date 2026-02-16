# Settings Page — Research & Technical Analysis

## 1. Problem Statement

Currently, the settings experience in Castle is delivered via a dropdown menu (`mat-menu`) triggered by the gear icon in the toolbar (`main-layout.component.html`, lines 37-64). This menu bundles three unrelated concerns into a single flyout:

1. **Theme selection** — nested sub-menu of available themes
2. **Open Directory** — folder picker to set the project workspace
3. **About Castle** — opens a dialog with app info

The task requests:

- **Replace the settings dropdown** with navigation to a dedicated **Settings page**.
- The Settings page should contain **theme selection** and **About Castle** information.
- **Folder selection** ("Open Directory") should be extracted out of settings and placed as a **standalone button** in the toolbar, next to where the settings button is.

---

## 2. Current Architecture

### 2.1 Routing

| File | Details |
|---|---|
| `src/app/app.routes.ts` | Single route: `''` → lazy-loads `MainLayoutComponent` |
| `src/app/app.component.ts` | Root component; renders `<router-outlet />` |
| `src/app/app.config.ts` | Provides `provideRouter(routes)` |

There is currently **only one route** in the entire app. All views (chat, tasks) are toggled via the `activeView` property on `MainLayoutComponent`, not via routing. The Angular router is set up but barely used.

### 2.2 Settings Dropdown (Toolbar)

**File:** `src/app/layout/main-layout.component.html` (lines 37-64)

```html
<button mat-icon-button matTooltip="Settings" [matMenuTriggerFor]="settingsMenu">
  <mat-icon>settings</mat-icon>
</button>

<mat-menu #settingsMenu="matMenu">
  <button mat-menu-item [matMenuTriggerFor]="themeMenu">Theme</button>
  <button mat-menu-item (click)="openDirectory()">Open Directory</button>
  <mat-divider></mat-divider>
  <button mat-menu-item (click)="openAboutDialog()">About Castle</button>
</mat-menu>

<mat-menu #themeMenu="matMenu">
  @for (theme of availableThemes; track theme.id) { ... }
</mat-menu>
```

**Component:** `src/app/layout/main-layout.component.ts`
- `setTheme(themeId)` — delegates to `ThemeService.setTheme()`
- `openDirectory()` — calls `ElectronService.selectDirectory()`, then `agentService.discoverAgents()`
- `openAboutDialog()` — opens `AboutDialogComponent` via `MatDialog`

### 2.3 Theme Service

**File:** `src/app/core/services/theme.service.ts`

- 4 built-in themes: `castle-dark`, `castle-light`, `midnight`, `amoled`
- `currentTheme` is a signal (`signal<CastleTheme>`)
- `availableThemes` is a readonly array exposed publicly
- `setTheme(themeId)` updates the signal and persists to `electron-store` via `ElectronService.updateSettings()`
- `applyTheme()` sets CSS custom properties on `document.documentElement`

### 2.4 About Dialog

**Files:** `src/app/shared/components/about-dialog/`
- Standalone component displayed via `MatDialog`
- Shows `APP_NAME`, `APP_VERSION`, description, and feature list
- Uses constants from `src/shared/constants.ts`

### 2.5 App Settings Type

**File:** `src/shared/types/settings.types.ts`

```typescript
export interface AppSettings {
  theme: string;
  defaultModel: string;
  autoStartAgents: boolean;
  showToolCalls: boolean;
  fontSize: number;
  recentDirectories: string[];
  windowBounds?: WindowBounds;
}
```

There are several settings fields (`defaultModel`, `autoStartAgents`, `showToolCalls`, `fontSize`) that are defined in the type but **have no UI** today. A dedicated settings page would be the natural home for these.

### 2.6 Status Bar

**File:** `src/app/shared/components/status-bar/`
- Shows connection status, model selector, and current directory name
- Model selector exists here but `onModelChange` has a TODO for persisting

---

## 3. Proposed Approach

### 3.1 Strategy: View-based (not route-based)

The app currently uses `activeView` toggling rather than Angular routes for its main content area (chat vs tasks). To stay consistent and minimize architectural disruption:

**Add `'settings'` as a new `activeView` value**, rendering a `<app-settings>` component inside the existing `chat-container` div, alongside the existing chat and tasks views.

> **Alternative considered:** Adding a new route (`/settings`). This would be cleaner architecturally but would break the current pattern where `MainLayoutComponent` manages all state (selected agent, directory, sidebar). It would require refactoring shared state into services or a store. **Not recommended for this change** — use this approach in a future routing refactor.

### 3.2 New Component: `SettingsComponent`

**Location:** `src/app/features/settings/settings.component.{ts,html,scss}`

This component will contain two sections:

#### Section A: Themes
- Display all available themes as visual cards/swatches (improve over the current text-only menu)
- Show the current theme with a checkmark or highlight
- Clicking a theme card applies it immediately via `ThemeService.setTheme()`
- Each card should show: theme name, mode (light/dark label), and a color preview strip of the theme's primary/accent/warn colors

#### Section B: About Castle
- Inline the content currently shown in `AboutDialogComponent`
- Show: app logo, name, version, description, feature list
- This replaces the need to open a modal dialog

#### Section C (Optional/Future): General Settings
- Expose the existing `AppSettings` fields that have no UI:
  - `defaultModel` (dropdown)
  - `autoStartAgents` (toggle)
  - `showToolCalls` (toggle)  
  - `fontSize` (slider or input)
- This is optional for the initial implementation but the section structure should accommodate it

### 3.3 Toolbar Changes

**Current toolbar-right section:**
```
[Settings ⚙️] [Minimize] [Maximize] [Close]
```

**Proposed toolbar-right section:**
```
[Open Folder 📁] [Settings ⚙️] [Minimize] [Maximize] [Close]
```

Changes to `main-layout.component.html`:

1. **Remove** the `mat-menu` (`#settingsMenu`) and nested `#themeMenu` entirely
2. **Add** a new `folder_open` icon button before the settings button:
   ```html
   <button mat-icon-button matTooltip="Open Directory" (click)="openDirectory()">
     <mat-icon>folder_open</mat-icon>
   </button>
   ```
3. **Change** the settings button from `[matMenuTriggerFor]` to a click handler:
   ```html
   <button mat-icon-button matTooltip="Settings" (click)="showSettings()">
     <mat-icon>settings</mat-icon>
   </button>
   ```

### 3.4 MainLayoutComponent Changes

**File:** `src/app/layout/main-layout.component.ts`

1. Update `activeView` type: `'chat' | 'tasks' | 'settings'`
2. Add `showSettings()` method:
   ```typescript
   showSettings(): void {
     this.activeView = 'settings';
     this.closeSidebar();
   }
   ```
3. Remove `openAboutDialog()` method (no longer needed from toolbar)
4. Keep `openDirectory()` as-is (still called, just from a different button)
5. Remove `MatMenuModule` import if no other menus remain, and remove `themeMenu`/`settingsMenu` template references

**Template update** in `main-layout.component.html` (chat-container):
```html
@if (activeView === 'tasks') {
  <app-task-list (goToAgent)="goToAgent($event)" />
} @else if (activeView === 'settings') {
  <app-settings (back)="showChat()" />
} @else if (selectedAgent()) {
  <app-chat [agent]="selectedAgent()!" />
} @else {
  <!-- welcome screen -->
}
```

### 3.5 Toolbar Title Update

When `activeView === 'settings'`, the toolbar-left should show:
```html
@if (activeView === 'settings') {
  <mat-icon>settings</mat-icon>
  <span class="agent-name">Settings</span>
}
```

---

## 4. File-by-File Change Summary

| File | Action | Description |
|---|---|---|
| `src/app/features/settings/settings.component.ts` | **Create** | New standalone component |
| `src/app/features/settings/settings.component.html` | **Create** | Template with theme cards + about section |
| `src/app/features/settings/settings.component.scss` | **Create** | Styles for settings page |
| `src/app/layout/main-layout.component.html` | **Modify** | Remove settings menu, add folder button, add settings view toggle, update toolbar-left for settings title |
| `src/app/layout/main-layout.component.ts` | **Modify** | Add `showSettings()`, update `activeView` type, add `SettingsComponent` import, remove `openAboutDialog()` |
| `src/app/layout/main-layout.component.scss` | **Modify** | Minor: no major changes expected |
| `src/app/shared/components/about-dialog/` | **Keep** | Keep the component files; they may still be useful if we want a dialog elsewhere, but they'll no longer be triggered from the toolbar. Can be removed in cleanup. |

---

## 5. Settings Page Layout Design

```
┌──────────────────────────────────────────────────────────┐
│  Settings                                                │
│                                                          │
│  ─── Appearance ───────────────────────────────────────  │
│                                                          │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   │
│  │ Castle  │  │ Castle  │  │Midnight │  │ AMOLED  │   │
│  │  Dark   │  │  Light  │  │  Blue   │  │  Black  │   │
│  │  ████   │  │  ████   │  │  ████   │  │  ████   │   │
│  │   ✓     │  │         │  │         │  │         │   │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘   │
│                                                          │
│  ─── About ────────────────────────────────────────────  │
│                                                          │
│  🏰 Castle                                               │
│  Version 0.1.0                                           │
│  A Discord-like desktop app for GitHub Copilot CLI       │
│  agents. Manage multiple AI agents, each with their      │
│  own personality and capabilities.                       │
│                                                          │
│  Features:                                               │
│  • Multiple AI agents with custom configurations         │
│  • AGENTS.md file discovery                              │
│  • Persistent chat history                               │
│  • Customizable themes                                   │
│  • Permission management                                 │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## 6. Considerations

### 6.1 Navigating Back from Settings
- The settings view should allow easy return to the previous view.
- Options:
  - **Option A:** Clicking an agent in the sidebar returns to chat (already works via `agentSelected` output → `showChat()`).
  - **Option B:** Clicking the castle logo returns to tasks (already works via `tasksClicked` output → `showTasks()`).
  - **Option C:** Add a back button/arrow on the settings page itself via an `(back)` output event.
- **Recommendation:** All three should work. The sidebar interactions already set `activeView` so A and B work naturally. Add a `(back)` output for a dedicated back button on the settings page as well.

### 6.2 MatMenu Removal
- The `MatMenuModule` import can be removed from `MainLayoutComponent` **only if** no other menus remain in the template. Currently, no other menus exist in this component, so it can be safely removed.
- The `MatDividerModule` may still be needed; check before removing.

### 6.3 About Dialog Component
- The `AboutDialogComponent` is currently imported in `MainLayoutComponent`. Once the about content is inlined in the settings page, the dialog import and the `openAboutDialog()` method should be removed from `MainLayoutComponent`.
- The component files themselves can remain for potential reuse (e.g., Help menu in the future) or be deleted if preferred.

### 6.4 Theme Card Accessibility
- Each theme card should be a `<button>` for keyboard accessibility.
- The selected theme should have `aria-pressed="true"`.
- Use sufficient contrast for theme names on their preview backgrounds.

### 6.5 Mobile Responsiveness
- Theme cards should wrap on small screens (use CSS `flex-wrap: wrap` or CSS Grid with `auto-fill`).
- The folder button in the toolbar adds width; ensure it doesn't overflow on small viewports. Consider hiding the text label on mobile and using icon-only.

### 6.6 Scroll Behavior
- The settings page content may exceed viewport height (especially with future general settings).
- The settings component container should have `overflow-y: auto` to allow scrolling.

### 6.7 Future Extensibility
- Structure the settings page with clear section headers so additional sections (General, Agents, Keyboard Shortcuts, etc.) can be added later.
- Use a consistent pattern: section title → section content block.

---

## 7. Implementation Guidance

### Step 1: Create the Settings Component

```
src/app/features/settings/
  settings.component.ts
  settings.component.html
  settings.component.scss
```

The component should:
- Inject `ThemeService` for theme data and selection
- Import constants (`APP_NAME`, `APP_VERSION`) for the about section
- Emit a `back` output event for the back button
- Be standalone

### Step 2: Modify the Main Layout Template

1. Remove the `#settingsMenu` and `#themeMenu` mat-menus
2. Add `folder_open` button before settings button in `toolbar-right`
3. Change settings button to `(click)="showSettings()"`
4. Add `@if (activeView === 'settings')` block in the chat-container
5. Add settings title in toolbar-left

### Step 3: Modify the Main Layout Component

1. Update `activeView` type to include `'settings'`
2. Add `showSettings()` method
3. Import `SettingsComponent`
4. Remove `openAboutDialog()` method
5. Remove unused imports (`MatMenuModule`, `AboutDialogComponent` from imports array)

### Step 4: Verify & Test

1. Settings button navigates to the settings view
2. Theme selection works from the settings page
3. Folder button opens directory picker
4. Sidebar navigation (agents, tasks) returns from settings
5. Back button on settings page works
6. Mobile responsive layout

---

## 8. Dependencies & Risk

| Risk | Likelihood | Mitigation |
|---|---|---|
| Breaking existing theme switching | Low | `ThemeService` API unchanged; just calling from new component |
| Toolbar overflow on small screens | Medium | Test mobile layout; icon-only for folder button |
| Losing back-navigation context | Low | Sidebar clicks already reset `activeView`; add explicit back |
| Removing MatMenu breaks other features | Low | Only used in settings; verify no other menus exist |

---

## 9. Out of Scope

- Routing refactor (converting view toggling to proper Angular routes)
- Exposing all `AppSettings` fields in the UI (can be done as follow-up)
- Settings search/filter functionality
- Import/export settings
- Keyboard shortcuts page
