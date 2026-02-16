# Research: Permissions Settings Persisted

## Problem Statement

When a Copilot agent triggers a permission request (via ACP `requestPermission`), the user is prompted with a dialog offering options like "Allow Always", "Allow Once", "Reject Once", and "Reject Always". Currently, selecting "Allow Always" or "Reject Always" has **no persistence**—the choice is forwarded to the ACP session but is not stored in Castle's database. If the app is closed and reopened, or the agent session is restarted, the user will be re-prompted for the same permission.

Additionally, users need a way to **view and manage (delete)** persisted permission grants from the Settings page. These grants must be **scoped to the current repo/project directory**, so different projects can have different permission policies.

---

## Current Architecture Analysis

### How Permissions Flow Today

1. **ACP requests permission** → `ProcessManagerService.startSession()` registers a `requestPermission` callback on the ACP client (line ~155 of `process-manager.service.ts`).
2. The callback creates a `permissionData` object with `requestId`, `agentId`, `agentName`, `toolCall`, and `options`, then emits `'permissionRequest'` on the session's `EventEmitter`.
3. **IPC layer** (`ipc/index.ts`, line ~155) subscribes via `processManagerService.onPermissionRequest()` and broadcasts to the renderer via `IPC_CHANNELS.PERMISSION_REQUEST`.
4. **Renderer** (`MainLayoutComponent.ngOnInit()`) subscribes to `permissionRequest$` and opens a `PermissionDialogComponent`.
5. The dialog displays options (e.g., `allow_always`, `allow_once`, `reject_once`, `reject_always`) and the user clicks one.
6. The selected `optionId` is sent back via `IPC_CHANNELS.PERMISSION_RESPONSE` → `processManagerService.respondToPermission()` → the ACP client resolves the promise with `{ outcome: 'selected', optionId }`.

**Key gap:** The `optionId` is passed straight through to the ACP SDK. Castle never inspects whether it's `allow_always` vs `allow_once`, and never persists the choice.

### Existing Permissions Table (Unused for This Purpose)

The database has a `permissions` table:

```sql
CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  permission_type TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(agent_id, permission_type)
);
```

This table stores coarse `PermissionSet` flags (`fileRead`, `fileWrite`, `fileDelete`, `executeCommands`, `networkAccess`, `gitOperations`) keyed by `agent_id`. It has **no project_path scoping** and **no concept of tool-level granularity**. The `getPermissions()`/`setPermission()` methods in `DatabaseService` and corresponding IPC handlers exist but are not wired into the ACP permission flow.

### ACP Permission Model

The ACP `requestPermission` callback receives:
- `toolCall.title` — e.g., "Edit file", "Run command"
- `toolCall.toolCallId` — unique ID for this specific call
- `toolCall.kind` — e.g., `"read"`, `"edit"`, `"delete"`, `"execute"`, `"fetch"`
- `toolCall.locations` — array of `{ path, line? }` for file operations
- `toolCall.rawInput` — the raw command/input
- `options[]` — array of `{ optionId, name, kind }` where `kind` is `allow_always | allow_once | reject_once | reject_always`

The `kind` field on each option tells us whether the user's choice is a one-time or persistent grant. The `allow_always` / `reject_always` options are the ones we need to persist.

### Project/Repo Scoping Pattern

The codebase already uses project-path scoping for tasks:
- Tasks have a `project_path TEXT` column
- `getTasks()` accepts `projectPath` and filters by it
- `createTask()` stores `projectPath`
- `DirectoryService.getCurrentDirectory()` provides the active project path

This same pattern should be used for persisted permission grants.

---

## Proposed Approach

### 1. New Database Table: `permission_grants`

Create a new table (separate from the existing coarse `permissions` table) to store fine-grained, project-scoped permission decisions:

```sql
CREATE TABLE IF NOT EXISTS permission_grants (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  tool_kind TEXT NOT NULL,        -- 'read', 'edit', 'delete', 'execute', 'fetch', etc.
  tool_title TEXT,                -- Human-readable description (e.g. "Edit file")
  granted INTEGER NOT NULL,       -- 1 = allowed, 0 = rejected
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_path, tool_kind)
);
CREATE INDEX IF NOT EXISTS idx_permission_grants_project ON permission_grants(project_path);
```

**Design decisions:**
- **Keyed by `(project_path, tool_kind)`** — one persisted decision per tool kind per project. This matches how "always" works: if you say "always allow edits" for project X, all future edit-kind permission requests in that project are auto-resolved.
- **Not keyed by agent_id** — since the underlying Copilot CLI permission model is about what actions are allowed in a workspace, not per-agent. If per-agent scoping is desired later, add an optional `agent_id` column.
- **`tool_title`** stored for display in settings UI, but not used as a key.

### 2. DatabaseService Changes

Add these methods to `DatabaseService`:

```typescript
// Get all persisted permission grants for a project
async getPermissionGrants(projectPath: string): Promise<PermissionGrant[]>

// Get a specific grant by project + tool kind
async getPermissionGrant(projectPath: string, toolKind: string): Promise<PermissionGrant | null>

// Save a grant (upsert)
async savePermissionGrant(grant: { projectPath: string; toolKind: string; toolTitle?: string; granted: boolean }): Promise<void>

// Delete a specific grant (user revoking from settings)
async deletePermissionGrant(grantId: string): Promise<void>

// Delete all grants for a project
async deleteAllPermissionGrants(projectPath: string): Promise<void>
```

The migration to create the table goes in `runMigrations()`, following the existing pattern of `CREATE TABLE IF NOT EXISTS`.

### 3. Shared Types

Add to `src/shared/types/settings.types.ts`:

```typescript
export interface PermissionGrant {
  id: string;
  projectPath: string;
  toolKind: string;
  toolTitle?: string;
  granted: boolean;
  createdAt: Date;
}
```

### 4. IPC Channels

Add new channels to `IPC_CHANNELS`:

```typescript
// Permission grant operations (persisted "always" choices)
PERMISSION_GRANTS_GET: 'permissionGrants:get',         // Get grants for current project
PERMISSION_GRANTS_DELETE: 'permissionGrants:delete',    // Delete a specific grant
PERMISSION_GRANTS_DELETE_ALL: 'permissionGrants:deleteAll', // Delete all grants for project
```

Add corresponding `IPCPayloads` entries and IPC handlers in `ipc/index.ts`.

### 5. Permission Interception Logic (Core Change)

The main behavioral change is in the **IPC layer** (`ipc/index.ts`) in the `PERMISSION_RESPONSE` handler, and in the **process-manager** permission request flow.

#### A. On Permission Request (Check for Existing Grant)

Before forwarding the permission request to the renderer, check the database:

```typescript
// In the processManagerService.onPermissionRequest callback:
processManagerService.onPermissionRequest(sessionId, async (data) => {
  const projectPath = directoryService.getCurrentDirectory();
  if (projectPath && data.toolCall?.kind) {
    const existingGrant = await databaseService.getPermissionGrant(projectPath, data.toolCall.kind);
    if (existingGrant) {
      // Auto-respond based on persisted grant
      const matchingOption = data.options.find((o: any) =>
        existingGrant.granted
          ? o.kind === 'allow_always' || o.kind === 'allow_once'
          : o.kind === 'reject_always' || o.kind === 'reject_once'
      );
      if (matchingOption) {
        processManagerService.respondToPermission(data.agentId, data.requestId, matchingOption.optionId);
        return; // Don't show dialog
      }
    }
  }
  // No persisted grant — show dialog as usual
  broadcaster.send(IPC_CHANNELS.PERMISSION_REQUEST, data);
});
```

**Important:** This interception happens in `subscribeToSession()` in `ipc/index.ts`, replacing the current direct broadcast.

#### B. On Permission Response (Persist "Always" Choices)

When the user responds, check if the selected option is an "always" kind:

```typescript
ipcMain.on(IPC_CHANNELS.PERMISSION_RESPONSE, async (_event, { requestId, agentId, optionId }) => {
  // Look up the original request to find the selected option's kind
  const originalRequest = pendingPermissionRequests.get(requestId);
  if (originalRequest) {
    const selectedOption = originalRequest.options.find((o: any) => o.optionId === optionId);
    if (selectedOption && (selectedOption.kind === 'allow_always' || selectedOption.kind === 'reject_always')) {
      const projectPath = directoryService.getCurrentDirectory();
      if (projectPath && originalRequest.toolCall?.kind) {
        await databaseService.savePermissionGrant({
          projectPath,
          toolKind: originalRequest.toolCall.kind,
          toolTitle: originalRequest.toolCall.title,
          granted: selectedOption.kind === 'allow_always',
        });
      }
    }
    pendingPermissionRequests.delete(requestId);
  }
  
  processManagerService.respondToPermission(agentId, requestId, optionId);
  broadcaster.send(IPC_CHANNELS.SYNC_PERMISSION_RESPONDED, { requestId });
});
```

This requires a **pending request cache** (`Map<string, PermissionDialogData>`) to correlate the response back to the original request's metadata.

### 6. Settings Page — Permissions Management UI

Add a new section to the Settings page (`settings-page.component.html`) between the Theme and Remote Access sections:

```html
<!-- Permissions Section -->
<section class="settings-section">
  <h3>
    <mat-icon>security</mat-icon>
    Permissions
  </h3>
  <p class="section-description">
    Manage persisted permission grants for the current project.
    These are "always allow" or "always reject" choices you've made when prompted.
  </p>

  @if (!currentDirectory) {
    <p class="empty-state">No project is currently open.</p>
  } @else {
    <p class="project-scope">
      <mat-icon>folder</mat-icon>
      {{ getDirectoryName(currentDirectory) }}
    </p>

    @if (permissionGrants.length === 0) {
      <p class="empty-state">No persisted permissions for this project.</p>
    } @else {
      @for (grant of permissionGrants; track grant.id) {
        <div class="permission-grant-row">
          <div class="grant-info">
            <mat-icon>{{ getToolKindIcon(grant.toolKind) }}</mat-icon>
            <div>
              <span class="grant-title">{{ grant.toolTitle || grant.toolKind }}</span>
              <span class="grant-status" [class.allowed]="grant.granted" [class.rejected]="!grant.granted">
                {{ grant.granted ? 'Always allowed' : 'Always rejected' }}
              </span>
            </div>
          </div>
          <button mat-icon-button color="warn" (click)="deletePermissionGrant(grant.id)" matTooltip="Remove">
            <mat-icon>delete</mat-icon>
          </button>
        </div>
      }
      <button mat-stroked-button color="warn" (click)="deleteAllPermissionGrants()">
        <mat-icon>delete_sweep</mat-icon>
        Clear all permissions
      </button>
    }
  }
</section>
```

The component needs:
- `currentDirectory` — fetched on init from `ElectronService.getCurrentDirectory()`
- `permissionGrants: PermissionGrant[]` — fetched via a new IPC call
- `deletePermissionGrant(id)` and `deleteAllPermissionGrants()` — call corresponding IPC methods

### 7. Preload & WebSocket API Updates

Add `permissionGrants` methods to both `ElectronAPI` interface and implementations:

```typescript
// In ElectronAPI interface
permissionGrants: {
  get: (projectPath: string) => Promise<PermissionGrant[]>;
  delete: (grantId: string) => Promise<void>;
  deleteAll: (projectPath: string) => Promise<void>;
};
```

Wire up in `preload/index.ts` and `websocket-api.ts` following existing patterns.

### 8. ElectronService Updates

Add renderer-side methods:

```typescript
async getPermissionGrants(projectPath: string): Promise<PermissionGrant[]> {
  return this.api.permissionGrants.get(projectPath);
}

async deletePermissionGrant(grantId: string): Promise<void> {
  return this.api.permissionGrants.delete(grantId);
}

async deleteAllPermissionGrants(projectPath: string): Promise<void> {
  return this.api.permissionGrants.deleteAll(projectPath);
}
```

---

## Implementation Checklist

### Backend (Main Process)
1. **`src/shared/types/settings.types.ts`** — Add `PermissionGrant` interface
2. **`src/shared/types/ipc.types.ts`** — Add IPC channels and payload types
3. **`src/main/services/database.service.ts`** — Add table migration, CRUD methods
4. **`src/main/ipc/index.ts`** — Add IPC handlers for grants CRUD; add pending request cache; intercept permission requests to check DB; intercept permission responses to persist "always" choices
5. **`src/main/services/process-manager.service.ts`** — No changes needed (permission request/response flow stays the same)

### Preload / Bridge
6. **`src/preload/index.ts`** — Add `permissionGrants` API surface
7. **`src/app/core/services/websocket-api.ts`** — Add `permissionGrants` WebSocket implementation
8. **`src/app/core/services/api.service.ts`** — Add `permissionGrants` accessor

### Frontend (Renderer)
9. **`src/app/core/services/electron.service.ts`** — Add `getPermissionGrants()`, `deletePermissionGrant()`, `deleteAllPermissionGrants()`
10. **`src/app/features/settings/settings-page.component.ts`** — Add permissions section logic
11. **`src/app/features/settings/settings-page.component.html`** — Add permissions section UI
12. **`src/app/features/settings/settings-page.component.scss`** — Add styles for grant rows

---

## Key Considerations

### Granularity of the "Always" Decision

The ACP `toolCall.kind` provides a category (e.g., `"edit"`, `"execute"`, `"read"`). We persist at this level, meaning "Always allow edits" covers all future file edits in that project. This is the natural granularity since Copilot CLI itself groups permissions this way.

If finer granularity is needed later (e.g., per-file or per-command), the `permission_grants` table can be extended with additional columns and the unique constraint adjusted.

### Project Path Normalization

Project paths should be normalized before storage to avoid duplicates from case differences (Windows) or trailing slashes. Use `path.resolve()` and consider case-insensitive comparison on Windows:

```typescript
function normalizeProjectPath(p: string): string {
  let normalized = path.resolve(p);
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}
```

### Race Condition: Multiple Permission Requests

Multiple permission requests can arrive simultaneously. The pending request cache must handle concurrent entries. Using a `Map<requestId, data>` naturally handles this since `requestId` is unique per request.

### Session Restart Behavior

When an agent session is restarted (closed and reopened), the ACP SDK starts fresh with no memory of previous grants. This is exactly why Castle needs to intercept and auto-respond—the ACP layer has no persistence of its own.

### Backward Compatibility

The existing `permissions` table and `PermissionSet` system remain untouched. The new `permission_grants` table is additive. The coarse `permissions` table could potentially be deprecated in a future release, but for now both systems can coexist.

### Cross-Device Sync

Since Castle supports WebSocket-based remote access, permission grant changes from settings should broadcast a sync event so other connected devices see the updated state. A new `SYNC_PERMISSION_GRANTS_CHANGED` channel could handle this, but is optional for the initial implementation.

---

## File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/shared/types/settings.types.ts` | Modify | Add `PermissionGrant` interface |
| `src/shared/types/ipc.types.ts` | Modify | Add 3 new IPC channels + payload types |
| `src/main/services/database.service.ts` | Modify | Add migration, 5 new methods |
| `src/main/ipc/index.ts` | Modify | Add grant handlers, pending request cache, interception logic |
| `src/preload/index.ts` | Modify | Add `permissionGrants` API |
| `src/app/core/services/websocket-api.ts` | Modify | Add `permissionGrants` WS implementation |
| `src/app/core/services/api.service.ts` | Modify | Add `permissionGrants` accessor |
| `src/app/core/services/electron.service.ts` | Modify | Add 3 new methods |
| `src/app/features/settings/settings-page.component.ts` | Modify | Add permissions data + actions |
| `src/app/features/settings/settings-page.component.html` | Modify | Add permissions section UI |
| `src/app/features/settings/settings-page.component.scss` | Modify | Add grant row styles |

**Estimated scope:** ~11 files modified, ~250-350 lines of new code.
