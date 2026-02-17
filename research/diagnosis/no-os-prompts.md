# No OS Prompts — Bug Diagnosis

## Diagnosis and Suggested Fix

### Symptoms

The application uses native Electron `dialog.*` APIs to prompt the user in certain
code paths, breaking the design principle that all user-facing prompts should be
rendered as in-app Angular Material dialogs/modals. Three OS-level dialog usages exist:

| # | File | Line | API | Context |
|---|------|------|-----|---------|
| 1 | `src/main/ipc/index.ts` | 654 | `dialog.showMessageBox` | Worktree LRU cleanup confirmation when the worktree limit is reached during implementation |
| 2 | `src/main/services/directory.service.ts` | 22 | `dialog.showOpenDialog` | Workspace directory picker |
| 3 | `src/main/index.ts` | 216 | `dialog.showErrorBox` | Fatal initialization error before the renderer window loads |

**Occurrence #1** (worktree LRU cleanup) is the most recently added and the primary
offender — it was explicitly called out in the bug report. It shows an OS-native
message box asking the user to confirm worktree cleanup.

**Occurrence #2** (directory picker) is a native file-system dialog. This is standard
and arguably acceptable — even native apps use OS file pickers — but could be
replaced with an in-app directory browser if the design demands it.

**Occurrence #3** (initialization error) fires before the Angular renderer is available
and cannot be replaced with an in-app modal. This is an acceptable last-resort
fallback.

The remaining analysis focuses on **Occurrence #1**, the worktree LRU cleanup
`dialog.showMessageBox`, which is unambiguously wrong.

### Root Cause Analysis

**File:** `src/main/ipc/index.ts`, lines 648–668

```typescript
} catch (limitErr: any) {
  if (limitErr?.message?.includes('Maximum concurrent worktrees')) {
    const active = await gitWorktreeService.listCastleWorktrees(workingDirectory);
    const lru = await gitWorktreeService.getLruWorktrees(workingDirectory, 1);
    if (lru.length > 0) {
      const branchList = lru.map(w => `  • ${w.branch} ...`).join('\n');
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Clean up & continue', 'Cancel'],
        defaultId: 0,
        title: 'Worktree Limit Reached',
        message: `All ${active.length} worktree slots are in use.`,
        detail: `Remove the oldest worktree to make room?\n\n${branchList}`,
      });
      if (response === 0) {
        await gitWorktreeService.cleanupWorktrees(lru);
        worktreeResult = await gitWorktreeService.createWorktree(...);
      }
    }
  }
  if (!worktreeResult) throw limitErr;
}
```

The IPC handler directly calls `dialog.showMessageBox` from the main process. This is
problematic because:

1. It renders a native OS dialog that looks out of place in the app.
2. The main process blocks on user input — the IPC handler is `await`ing the dialog.
3. The app already has an established pattern for renderer-side confirmation modals:
   - A `ConfirmDialogComponent` exists at
     `src/app/shared/components/confirm-dialog/confirm-dialog.component.ts`
   - It accepts `{ title, message, confirmText, cancelText }` via `MAT_DIALOG_DATA`
   - It returns `true`/`false` via `dialogRef.close()`
   - It's already used in `task-list.component.ts` for delete confirmations
4. The `WORKTREE_LIFECYCLE` event channel already pushes status updates from main →
   renderer, so the infrastructure for renderer-side interaction exists.

### Suggested Fix

Replace the `dialog.showMessageBox` call with a **renderer-side confirmation flow**
using the existing IPC event pattern (main → renderer → main). The main process emits
a confirmation request, the renderer shows the `ConfirmDialogComponent`, and sends
the response back.

#### 1. Add new IPC channels for worktree cleanup confirmation

**File:** `src/shared/types/ipc.types.ts`

```diff
   WORKTREE_CHECK_GIT: 'worktree:checkGit',
   WORKTREE_LIFECYCLE: 'worktree:lifecycle',
+  WORKTREE_CLEANUP_REQUEST: 'worktree:cleanupRequest',
+  WORKTREE_CLEANUP_RESPONSE: 'worktree:cleanupResponse',
```

#### 2. Replace the native dialog in the IPC handler

**File:** `src/main/ipc/index.ts`

Replace lines 648–668 with a renderer-side confirmation flow:

```typescript
} catch (limitErr: any) {
  if (limitErr?.message?.includes('Maximum concurrent worktrees')) {
    const active = await gitWorktreeService.listCastleWorktrees(workingDirectory);
    const lru = await gitWorktreeService.getLruWorktrees(workingDirectory, 1);
    if (lru.length > 0) {
      const branchList = lru.map(w => `  • ${w.branch} (last used: ${w.lastModified.toLocaleDateString()})`).join('\n');

      // Ask the renderer to show a confirmation dialog
      const confirmed = await new Promise<boolean>((resolve) => {
        const requestId = uuidv4();

        const handler = (_event: any, response: { requestId: string; confirmed: boolean }) => {
          if (response.requestId === requestId) {
            ipcMain.removeHandler(IPC_CHANNELS.WORKTREE_CLEANUP_RESPONSE);
            resolve(response.confirmed);
          }
        };

        // Listen for the response (one-shot)
        ipcMain.removeHandler(IPC_CHANNELS.WORKTREE_CLEANUP_RESPONSE);
        ipcMain.handle(IPC_CHANNELS.WORKTREE_CLEANUP_RESPONSE, handler);

        // Send the request to the renderer
        broadcaster.send(IPC_CHANNELS.WORKTREE_CLEANUP_REQUEST, {
          requestId,
          taskId,
          title: 'Worktree Limit Reached',
          message: `All ${active.length} worktree slots are in use.\n\nRemove the oldest worktree to make room?\n\n${branchList}`,
          confirmText: 'Clean up & continue',
          cancelText: 'Cancel',
        });
      });

      if (confirmed) {
        await gitWorktreeService.cleanupWorktrees(lru);
        worktreeResult = await gitWorktreeService.createWorktree(workingDirectory, task.title, taskId, task.kind, baseBranch);
      }
    }
  }
  if (!worktreeResult) throw limitErr;
}
```

#### 3. Wire the event in the API layer

**File:** `src/app/core/services/websocket-api.ts` — add to the worktree section:

```typescript
onCleanupRequest: (callback: (event: {
  requestId: string;
  taskId: string;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
}) => void): void => {
  this.on(IPC_CHANNELS.WORKTREE_CLEANUP_REQUEST, callback);
},
respondCleanup: (requestId: string, confirmed: boolean): Promise<void> =>
  this.invoke(IPC_CHANNELS.WORKTREE_CLEANUP_RESPONSE, { requestId, confirmed }),
```

#### 4. Wire the event in `ElectronService`

**File:** `src/app/core/services/electron.service.ts`

Add a subject and subscription:

```typescript
private worktreeCleanupRequestSubject = new Subject<{
  requestId: string; taskId: string;
  title: string; message: string;
  confirmText: string; cancelText: string;
}>();
readonly worktreeCleanupRequest$ = this.worktreeCleanupRequestSubject.asObservable();
```

In `setupEventListeners()`:

```typescript
this.api.worktree.onCleanupRequest((event) => {
  this.ngZone.run(() => {
    this.worktreeCleanupRequestSubject.next(event);
  });
});
```

Add a response method:

```typescript
async respondWorktreeCleanup(requestId: string, confirmed: boolean): Promise<void> {
  return this.api.worktree.respondCleanup(requestId, confirmed);
}
```

#### 5. Handle in a renderer component

The best place is the `task-list.component.ts` since it already uses
`ConfirmDialogComponent` and manages the implementation lifecycle. Subscribe to
the cleanup request observable and open the existing confirm dialog:

**File:** `src/app/features/tasks/task-list/task-list.component.ts`

```typescript
// In ngOnInit or constructor:
this.electronService.worktreeCleanupRequest$.subscribe(async (request) => {
  const confirmed = await this.openConfirmDialog({
    title: request.title,
    message: request.message,
    confirmText: request.confirmText,
    cancelText: request.cancelText,
  });
  await this.electronService.respondWorktreeCleanup(request.requestId, confirmed);
});
```

#### 6. Remove the `dialog` import from `ipc/index.ts`

After the change, `dialog` is no longer used in `src/main/ipc/index.ts`. Remove it
from the import:

```diff
-import { BrowserWindow, ipcMain, dialog } from 'electron';
+import { BrowserWindow, ipcMain } from 'electron';
```

### Summary of all OS dialog usages and disposition

| # | Location | API | Action |
|---|----------|-----|--------|
| 1 | `src/main/ipc/index.ts:654` | `dialog.showMessageBox` | **Replace** with renderer-side `ConfirmDialogComponent` via IPC round-trip (detailed above) |
| 2 | `src/main/services/directory.service.ts:22` | `dialog.showOpenDialog` | **Keep** — native file/directory picker is standard UX; replacing it would require building an entire file browser component with no clear benefit |
| 3 | `src/main/index.ts:216` | `dialog.showErrorBox` | **Keep** — fires during fatal startup errors before the renderer is available; there's no Angular renderer to show a modal to |

### Verification Steps

1. **Worktree limit scenario:** Configure the max worktree limit to 1. Create a task
   implementation that uses a worktree. Then create a second implementation. Confirm
   the cleanup confirmation appears as an in-app Angular Material dialog (not a native
   OS dialog).
2. **Confirm cleanup:** Click "Clean up & continue" in the dialog. Verify the old
   worktree is removed and the new one is created successfully.
3. **Cancel cleanup:** Click "Cancel" in the dialog. Verify the implementation
   fails gracefully with an appropriate error message (the original `throw limitErr`
   path).
4. **No OS dialogs:** Manually search the built application for any remaining
   `dialog.showMessageBox` or `dialog.showMessageBoxSync` calls (excluding
   `showErrorBox` at startup and `showOpenDialog` for directory selection).
5. **Existing confirms still work:** Delete a task and verify the existing
   `ConfirmDialogComponent` still works correctly.
6. **Multi-window:** If running with Tailscale multi-device, verify the cleanup
   request only appears on the device that triggered the implementation.
