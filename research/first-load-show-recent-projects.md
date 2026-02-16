# Research: First Load — Show Recent Projects

## Problem Statement

When the Castle app first loads and no folder has been opened (via CLI argument or prior session), the user sees a static "Welcome to Castle" screen with only a generic "Open a Project" button. There is no quick way to jump back into a previously opened project. The app should display a list of recently opened folders so the user can resume work with a single click.

## Current Architecture

### Data Flow for Directory Selection
1. **Main process**: `DirectoryService` manages the current directory and persists recent directories via `DatabaseService`.
2. **Database**: A `recent_directories` table stores up to 10 recent paths, ordered by `last_opened` timestamp. Non-existent directories are filtered out at read time.
3. **IPC**: `DIRECTORY_GET_RECENT` channel already exists and is wired end-to-end (main → preload → renderer).
4. **Renderer**: `ElectronService.getRecentDirectories()` is already implemented, returning `Promise<string[]>`.

### Current First-Load View
The empty state lives in `src/app/layout/main-layout.component.html` lines 82–91:
```html
<div class="no-agent-selected">
  <mat-icon class="large-icon">smart_toy</mat-icon>
  <h2>Welcome to Castle</h2>
  <p>Select an agent from the sidebar to start chatting</p>
  @if (!currentDirectory) {
    <button mat-raised-button color="primary" (click)="openDirectory()">
      <mat-icon>folder_open</mat-icon>
      Open a Project
    </button>
  }
</div>
```

This block renders when `activeView === 'chat'` and no agent is selected. The `!currentDirectory` guard further gates showing the "Open a Project" button.

### What Already Works (No Changes Needed)
| Layer | Status |
|---|---|
| `recent_directories` DB table | ✅ Exists, stores 10 entries |
| `DatabaseService.getRecentDirectories()` | ✅ Returns paths ordered by last_opened DESC |
| `DatabaseService.addRecentDirectory()` | ✅ Upserts on open, prunes to 10 |
| `DirectoryService.getRecentDirectories()` | ✅ Filters out non-existent paths |
| IPC channel `DIRECTORY_GET_RECENT` | ✅ Registered in `ipc/index.ts` |
| Preload `directory.getRecent` | ✅ Exposed via contextBridge |
| `ElectronService.getRecentDirectories()` | ✅ Returns `Promise<string[]>` |

**The entire backend pipeline is already built. Only the renderer UI needs changes.**

## Proposed Approach

### Option A: Inline in MainLayoutComponent (Recommended)

Enhance the existing empty-state block in `main-layout.component.html` to fetch and display recent directories. This is the simplest approach — no new components, no new routes, no new services.

**Changes required:**
1. **`main-layout.component.ts`** — Add a `recentDirectories` signal, load it in `ngOnInit`, and add an `openRecentDirectory(path)` method.
2. **`main-layout.component.html`** — Extend the `no-agent-selected` block to show a recent projects list.
3. **`main-layout.component.scss`** — Add styles for the recent projects list.

### Option B: Separate WelcomeComponent

Create a standalone `WelcomeComponent` rendered inside the chat container. More modular, but heavier for what is essentially a few lines of template.

**Recommendation:** Option A. The existing component already owns this state and the change is small.

## Detailed Implementation Guidance (Option A)

### 1. `main-layout.component.ts`

```typescript
// Add to class properties:
recentDirectories: string[] = [];

// In ngOnInit, after loading currentDirectory:
if (!this.currentDirectory) {
  this.recentDirectories = await this.electronService.getRecentDirectories();
}

// Add method:
async openRecentDirectory(dirPath: string): Promise<void> {
  this.currentDirectory = dirPath;
  // Trigger the same flow as openDirectory()
  await this.agentService.discoverAgents(dirPath);
  if (this.statusBar) {
    this.statusBar.updateDirectory(dirPath);
  }
  if (this.activeView === 'tasks') {
    this.taskService.loadTasks();
  }
}
```

Note: `openRecentDirectory` shares logic with `openDirectory`. Consider extracting a private `setDirectory(path)` helper to avoid duplication. The `selectDirectory()` call also calls `directoryService.setCurrentDirectory` under the hood (which records it as recent), so `openRecentDirectory` should do the same by calling through to the main process. The simplest way is to invoke `electronService.discoverAgents(dirPath)` which goes through IPC — and the IPC `AGENTS_DISCOVER` handler does *not* call `directoryService.setCurrentDirectory`. So we need one additional IPC call or we refactor slightly.

**Refinement:** The `openDirectory()` method calls `electronService.selectDirectory()`, which internally calls `directoryService.selectDirectory()` → `directoryService.setCurrentDirectory()` (which saves to recent). For recent directories, we need a `setCurrentDirectory` IPC call or we simply call `selectDirectory` IPC and skip the dialog part. The cleanest approach: **add a new IPC channel** `DIRECTORY_SET_CURRENT` or reuse the existing `addRecentDirectory` flow by having the renderer tell the main process to set the current directory.

Actually, looking more carefully: when `discoverAgents(workspacePath)` is called, the main process's `AGENTS_DISCOVER` handler only discovers agents — it does NOT update `directoryService.currentDirectory`. The current flow relies on `selectDirectory()` doing that. So for a recent directory click, we need the main process to also know the directory changed.

**Best fix:** Add a new IPC channel `DIRECTORY_SET_CURRENT` that calls `directoryService.setCurrentDirectory(path)`. This keeps the architecture clean.

### 2. New IPC Channel: `DIRECTORY_SET_CURRENT`

**`src/shared/types/ipc.types.ts`** — Add:
```typescript
DIRECTORY_SET_CURRENT: 'directory:setCurrent',
```

**`src/main/ipc/index.ts`** — Add handler:
```typescript
ipcMain.handle(IPC_CHANNELS.DIRECTORY_SET_CURRENT, async (_event, { path }) => {
  await directoryService.setCurrentDirectory(path);
});
```

**`src/preload/index.ts`** — Add to directory API:
```typescript
setCurrent: (dirPath: string) => ipcRenderer.invoke(IPC_CHANNELS.DIRECTORY_SET_CURRENT, { path: dirPath }),
```

**`src/app/core/services/electron.service.ts`** — Add:
```typescript
async setCurrentDirectory(dirPath: string): Promise<void> {
  if (!this.api) return;
  return this.api.directory.setCurrent(dirPath);
}
```

### 3. `main-layout.component.html`

Replace the existing empty-state block:

```html
<div class="no-agent-selected">
  <mat-icon class="large-icon">smart_toy</mat-icon>
  <h2>Welcome to Castle</h2>
  <p>Select an agent from the sidebar to start chatting</p>
  @if (!currentDirectory) {
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
  }
</div>
```

### 4. `main-layout.component.scss`

```scss
.recent-projects {
  width: 100%;
  max-width: 480px;
  margin-bottom: 16px;

  h3 {
    margin: 0 0 8px 0;
    font-size: 14px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
}

.recent-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.recent-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: none;
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition: background-color 0.15s;

  &:hover {
    background: var(--bg-tertiary);
  }

  mat-icon {
    color: var(--text-muted);
    flex-shrink: 0;
  }
}

.recent-item-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.recent-name {
  font-weight: 500;
  font-size: 14px;
}

.recent-path {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

### 5. Helper Method in `main-layout.component.ts`

```typescript
getDirectoryName(dirPath: string): string {
  const parts = dirPath.split(/[/\\]/);
  return parts[parts.length - 1] || dirPath;
}
```

## Considerations

### Edge Cases
- **All recent directories have been deleted from disk**: The `DirectoryService.getRecentDirectories()` already filters these out. The UI will show an empty list, falling through to just the "Open a Project" button.
- **Very long paths**: Handled via CSS `text-overflow: ellipsis` on the path display.
- **Browser mode (no Electron)**: `ElectronService.getRecentDirectories()` returns `[]` when no API is available. The list simply won't show.
- **Returning from an opened project**: If the user opens a project and later closes it (not currently possible, but future-proofing), the recent list won't show because `currentDirectory` will still be set.

### UX Notes
- Show the folder's basename prominently (e.g., "castle") with the full path below in muted text.
- Limit display to the stored 10 entries (already enforced by DB).
- Keep the "Open a Project" button always visible below the recent list for discoverability.
- No need for a "Clear Recents" action in v1.

### Performance
- `getRecentDirectories()` does a DB query + filesystem existence check for up to 10 paths. This is fast (< 10ms) and runs once on init. No concerns.

### Testing
- The feature is UI-only on the renderer side. Manual testing is sufficient for v1.
- Verify: fresh install (no recents → just shows button), after opening 1–3 projects (recents appear), after deleting a recent directory from disk (it's filtered out).

## Files to Modify

| File | Change |
|---|---|
| `src/shared/types/ipc.types.ts` | Add `DIRECTORY_SET_CURRENT` channel + payload type |
| `src/preload/index.ts` | Add `setCurrent` to directory API |
| `src/main/ipc/index.ts` | Add `DIRECTORY_SET_CURRENT` handler |
| `src/app/core/services/electron.service.ts` | Add `setCurrentDirectory()` method |
| `src/app/layout/main-layout.component.ts` | Add `recentDirectories`, load on init, add `openRecentDirectory()` and `getDirectoryName()` |
| `src/app/layout/main-layout.component.html` | Render recent projects list in empty state |
| `src/app/layout/main-layout.component.scss` | Styles for recent projects list |

## Summary

The backend infrastructure (DB table, services, IPC channels, preload bridge, Angular service method) **already exists**. The main work is:
1. A small IPC addition (`DIRECTORY_SET_CURRENT`) to let the renderer tell the main process which directory to use — 4 files, ~1 line each.
2. UI changes in the main layout component to fetch and render the recent directories list — 3 files, ~60 lines total.

Total estimated scope: **~7 files changed, ~80 lines added**.