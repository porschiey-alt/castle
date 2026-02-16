

Now let me look at the UI components for tasks and the electron service.Now I have a complete picture of the codebase. Let me produce the analysis document.# Sync Tasks with GitHub Issues — Technical Research & Analysis

## 1. Executive Summary

Castle's task system currently operates as a fully local SQLite-backed workflow with no external integration. This research proposes adding an **opt-in, bidirectional sync** between Castle tasks and GitHub Issues for workspaces whose git remote points to a GitHub repository. The existing codebase already anticipates this feature — the `tasks` database table includes `github_issue_number` and `github_repo` columns, and the `Task` TypeScript interface defines optional `githubIssueNumber` and `githubRepo` fields — but no sync logic, GitHub API service, or UI affordances exist yet.

---

## 2. Current State of the Codebase

### 2.1 Task Data Model (`src/shared/types/task.types.ts`)

```typescript
export interface Task {
  id: string;
  title: string;
  description: string;
  state: TaskState;               // 'new' | 'in_progress' | 'active' | 'blocked' | 'done'
  labels: TaskLabel[];
  researchContent?: string;
  researchAgentId?: string;
  githubIssueNumber?: number;     // ← already defined, unused
  githubRepo?: string;            // ← already defined, unused
  createdAt: Date;
  updatedAt: Date;
}
```

### 2.2 Database Schema (`src/main/services/database.service.ts`)

The `tasks` table already contains the columns:
```sql
github_issue_number INTEGER,
github_repo TEXT,
```
These columns are read during `getTask()` and `getTasks()`, and mapped onto the `Task` object, but are never written during `createTask()` or `updateTask()`.

### 2.3 Task IPC & Service Layer

| Layer | File | Role |
|-------|------|------|
| DB CRUD | `src/main/services/database.service.ts` | SQLite read/write |
| IPC Handlers | `src/main/ipc/index.ts` | Electron main ↔ renderer bridge |
| Preload API | `src/preload/index.ts` | Exposes `tasks.*` methods to renderer |
| Angular Service | `src/app/core/services/electron.service.ts` | Renderer-side IPC wrapper |
| State Management | `src/app/core/services/task.service.ts` | Signals-based Angular state |
| UI | `src/app/features/tasks/task-{list,detail,form-dialog}/` | Components |

### 2.4 What Does NOT Exist Yet

- **No GitHub API client** — no REST or GraphQL calls anywhere in the codebase.
- **No git remote detection logic** — `DirectoryService` manages workspace paths but does not inspect `.git/config`.
- **No GitHub authentication storage** — `AppSettings` has no token/PAT field.
- **No sync engine, conflict resolution, or webhook/polling infrastructure.**

---

## 3. Proposed Architecture

### 3.1 High-Level Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│  Renderer (Angular)                                          │
│  TaskService  ──IPC──▶  IPC Handlers  ──▶  GitHubSyncService │
│      ▲                                          │            │
│      │                                          ▼            │
│      └─────── DatabaseService ◄──────── GitHub REST API      │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 New Components Required

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `GitHubService` | `src/main/services/github.service.ts` | REST API calls (issues CRUD, labels, repo detection) |
| `GitRemoteHelper` | `src/main/services/git-remote.helper.ts` | Parse git remote to extract `owner/repo` |
| New IPC channels | `src/shared/types/ipc.types.ts` | GitHub-specific IPC channels |
| Settings fields | `src/shared/types/settings.types.ts` | `githubToken`, `githubSyncEnabled` |
| UI: Sync toggle | Task detail & settings | Opt-in control per task or globally |
| DB migration | `database.service.ts` | Add `github_synced_at`, `github_issue_id` columns |

---

## 4. Detailed Implementation Plan

### 4.1 Phase 1 — Git Remote Detection

**File: `src/main/services/git-remote.helper.ts`**

Detect whether the current workspace has a GitHub remote:

```typescript
import { execSync } from 'child_process';

export interface GitHubRemoteInfo {
  owner: string;
  repo: string;
  fullName: string;  // "owner/repo"
}

export function detectGitHubRemote(workspacePath: string): GitHubRemoteInfo | null {
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: workspacePath,
      encoding: 'utf-8',
    }).trim();

    // Match HTTPS: https://github.com/owner/repo.git
    // Match SSH:   git@github.com:owner/repo.git
    const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
    const sshMatch = remoteUrl.match(/github\.com:([^/]+)\/([^/.]+)/);
    const match = httpsMatch || sshMatch;

    if (!match) return null;
    return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
  } catch {
    return null;
  }
}
```

This should be called when the workspace directory is set/changed, and the result cached on `DirectoryService`.

### 4.2 Phase 2 — GitHub Authentication

**Approach options (ranked):**

| Option | Mechanism | Pros | Cons |
|--------|-----------|------|------|
| **A. GitHub CLI (`gh`)** | Shell out to `gh auth token` | Zero UI needed, leverages existing auth | Requires `gh` installed |
| **B. Personal Access Token** | User pastes PAT in settings | Simple, no external deps | Token management burden on user |
| **C. OAuth Device Flow** | Built-in OAuth flow | Best UX, no external deps | Complex to implement, needs OAuth app registration |

**Recommendation:** Start with **Option A** (GitHub CLI) with **Option B** as fallback. Most Castle users will have `gh` installed since they're developer-focused.

```typescript
// In GitHubService
private async getToken(workspacePath: string): Promise<string | null> {
  // Try gh CLI first
  try {
    const token = execSync('gh auth token', {
      cwd: workspacePath,
      encoding: 'utf-8',
    }).trim();
    if (token) return token;
  } catch { /* gh not available */ }

  // Fall back to stored PAT
  const settings = await this.db.getSettings();
  return (settings as any).githubToken || null;
}
```

**Settings type extension:**
```typescript
// In settings.types.ts
export interface AppSettings {
  // ... existing fields
  githubToken?: string;         // Optional PAT fallback
  githubSyncEnabled: boolean;   // Global opt-in
}
```

### 4.3 Phase 3 — GitHub API Service

**File: `src/main/services/github.service.ts`**

Use Node.js built-in `https` module or a minimal HTTP client (no new dependency needed — Electron's `net` module works). Alternatively, the `@octokit/rest` package could be added for better ergonomics.

**Core operations needed:**

```typescript
export class GitHubService {
  // Issue CRUD
  async createIssue(owner: string, repo: string, title: string, body: string, labels?: string[]): Promise<GitHubIssue>;
  async updateIssue(owner: string, repo: string, issueNumber: number, updates: Partial<GitHubIssueUpdate>): Promise<GitHubIssue>;
  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue>;
  async closeIssue(owner: string, repo: string, issueNumber: number): Promise<void>;
  async reopenIssue(owner: string, repo: string, issueNumber: number): Promise<void>;

  // Label sync
  async getLabels(owner: string, repo: string): Promise<GitHubLabel[]>;
  async createLabel(owner: string, repo: string, name: string, color: string): Promise<GitHubLabel>;

  // Bulk fetch for sync
  async listIssues(owner: string, repo: string, options?: { state?: 'open' | 'closed'; since?: string }): Promise<GitHubIssue[]>;
}
```

**GitHub Issue type:**
```typescript
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string; color: string }[];
  created_at: string;
  updated_at: string;
}
```

### 4.4 Phase 4 — State Mapping

Castle tasks have 5 states; GitHub Issues have 2 (`open`/`closed`). A mapping strategy is needed:

| Castle State | GitHub Issue State | Rationale |
|-------------|-------------------|-----------|
| `new` | `open` | New task = open issue |
| `active` | `open` | Active work = still open |
| `in_progress` | `open` | In progress = still open |
| `blocked` | `open` | Blocked but not done = still open |
| `done` | `closed` | Completed = closed |

**Reverse mapping (GitHub → Castle):**
- `open` → preserve existing Castle state (or default to `new` for imports)
- `closed` → `done`

Castle's finer-grained states should be stored as a **label** on the GitHub issue (e.g., `castle:in_progress`, `castle:blocked`) to enable round-trip fidelity.

### 4.5 Phase 5 — Sync Engine

**Sync strategy: Last-write-wins with timestamp comparison.**

```typescript
export class GitHubSyncService {
  constructor(
    private db: DatabaseService,
    private github: GitHubService,
    private directoryService: DirectoryService
  ) {}

  /**
   * Push a single task to GitHub (create or update issue)
   */
  async pushTask(task: Task): Promise<Task> {
    const remote = this.getRemoteInfo();
    if (!remote) throw new Error('No GitHub remote detected');

    if (task.githubIssueNumber) {
      // Update existing issue
      await this.github.updateIssue(remote.owner, remote.repo, task.githubIssueNumber, {
        title: task.title,
        body: task.description,
        state: task.state === 'done' ? 'closed' : 'open',
        labels: this.mapLabelsToGitHub(task),
      });
    } else {
      // Create new issue
      const issue = await this.github.createIssue(
        remote.owner, remote.repo, task.title, task.description,
        this.mapLabelsToGitHub(task).map(l => l.name)
      );
      // Store the issue number back on the task
      await this.db.updateTask(task.id, {
        // Need to extend UpdateTaskInput to allow setting github fields
      });
      // Direct DB update for github fields
      this.db.setTaskGitHubLink(task.id, issue.number, remote.fullName);
    }

    return await this.db.getTask(task.id) as Task;
  }

  /**
   * Pull a GitHub issue into the local task system
   */
  async pullIssue(issueNumber: number): Promise<Task> {
    const remote = this.getRemoteInfo();
    if (!remote) throw new Error('No GitHub remote detected');

    const issue = await this.github.getIssue(remote.owner, remote.repo, issueNumber);

    // Check if a local task already tracks this issue
    const existing = await this.db.getTaskByGitHubIssue(remote.fullName, issueNumber);

    if (existing) {
      // Update local task from GitHub
      return await this.db.updateTask(existing.id, {
        title: issue.title,
        description: issue.body,
        state: issue.state === 'closed' ? 'done' : existing.state,
      });
    } else {
      // Create new local task from GitHub issue
      return await this.db.createTask({
        title: issue.title,
        description: issue.body || '',
        state: issue.state === 'closed' ? 'done' : 'new',
        // githubIssueNumber and githubRepo set via separate DB call
      });
    }
  }

  /**
   * Full sync: compare local tasks with GitHub issues
   */
  async fullSync(): Promise<SyncResult> { /* ... */ }
}
```

### 4.6 Phase 6 — Database Changes

Extend `DatabaseService` with new methods:

```typescript
// New methods needed
async setTaskGitHubLink(taskId: string, issueNumber: number, repo: string): Promise<void> {
  this.db.run(
    `UPDATE tasks SET github_issue_number = ?, github_repo = ?, updated_at = datetime('now') WHERE id = ?`,
    [issueNumber, repo, taskId]
  );
  this.saveDatabase();
}

async getTaskByGitHubIssue(repo: string, issueNumber: number): Promise<Task | null> {
  const stmt = this.db.prepare(
    `SELECT id FROM tasks WHERE github_repo = ? AND github_issue_number = ?`
  );
  stmt.bind([repo, issueNumber]);
  if (!stmt.step()) { stmt.free(); return null; }
  const row = stmt.getAsObject() as { id: string };
  stmt.free();
  return this.getTask(row.id);
}
```

Also extend `updateTask()` to handle `githubIssueNumber` and `githubRepo` in the `UpdateTaskInput`:

```typescript
// In task.types.ts — extend UpdateTaskInput
export type UpdateTaskInput = Partial<Pick<Task,
  'title' | 'description' | 'state' | 'researchContent' | 'researchAgentId' |
  'githubIssueNumber' | 'githubRepo'  // ← add these
>> & {
  labelIds?: string[];
};
```

Consider adding a `github_synced_at` column for tracking last sync time:
```sql
ALTER TABLE tasks ADD COLUMN github_synced_at DATETIME;
```

### 4.7 Phase 7 — New IPC Channels

```typescript
// In ipc.types.ts — add to IPC_CHANNELS
GITHUB_DETECT_REMOTE: 'github:detectRemote',
GITHUB_SYNC_TASK: 'github:syncTask',
GITHUB_PULL_ISSUE: 'github:pullIssue',
GITHUB_PULL_ALL_ISSUES: 'github:pullAllIssues',
GITHUB_FULL_SYNC: 'github:fullSync',
GITHUB_GET_STATUS: 'github:getStatus',

// IPCPayloads additions
[IPC_CHANNELS.GITHUB_DETECT_REMOTE]: {
  request: void;
  response: { owner: string; repo: string; fullName: string } | null;
};
[IPC_CHANNELS.GITHUB_SYNC_TASK]: {
  request: { taskId: string };
  response: Task;
};
[IPC_CHANNELS.GITHUB_PULL_ISSUE]: {
  request: { issueNumber: number };
  response: Task;
};
[IPC_CHANNELS.GITHUB_FULL_SYNC]: {
  request: void;
  response: { created: number; updated: number; errors: string[] };
};
```

### 4.8 Phase 8 — UI Changes

#### 4.8.1 Task Detail — GitHub Badge

When a task is linked to a GitHub issue, show a clickable badge:

```html
@if (task()!.githubIssueNumber) {
  <a class="github-badge" [href]="'https://github.com/' + task()!.githubRepo + '/issues/' + task()!.githubIssueNumber"
     target="_blank" matTooltip="View on GitHub">
    <mat-icon>open_in_new</mat-icon>
    #{{ task()!.githubIssueNumber }}
  </a>
}
```

#### 4.8.2 Task Detail — Sync Button

Add a "Sync with GitHub" button in the task detail actions bar:

```html
@if (githubRemote()) {
  <button mat-icon-button (click)="syncWithGitHub()" matTooltip="Sync with GitHub Issue">
    <mat-icon>sync</mat-icon>
  </button>
}
```

#### 4.8.3 Task Form Dialog — Import from Issue

Add an "Import from GitHub Issue" option in the task creation flow:

```html
<mat-form-field appearance="outline" class="full-width" *ngIf="githubAvailable">
  <mat-label>Link to GitHub Issue # (optional)</mat-label>
  <input matInput type="number" [(ngModel)]="githubIssueNumber" placeholder="e.g. 42" />
</mat-form-field>
```

#### 4.8.4 Task List — Bulk Sync

Add a sync-all button in the task list header:

```html
@if (githubRemote()) {
  <button mat-icon-button (click)="syncAllTasks()" matTooltip="Sync all tasks with GitHub">
    <mat-icon>cloud_sync</mat-icon>
  </button>
}
```

#### 4.8.5 Settings Page

Add GitHub configuration section:
- Toggle: "Enable GitHub Issues sync"
- Input: "GitHub Personal Access Token" (only if `gh` CLI not detected)
- Status indicator: "Connected to owner/repo" or "No GitHub remote detected"

---

## 5. Dependency Considerations

| Option | Package | Size | Notes |
|--------|---------|------|-------|
| **Minimal (recommended)** | None — use Electron `net` or Node `https` | 0 KB | Full control, fewer deps |
| **Ergonomic** | `@octokit/rest` | ~50 KB | Well-typed, handles pagination, rate limiting |
| **Lightweight** | `@octokit/request` | ~15 KB | Just the HTTP layer without full SDK |

**Recommendation:** Start with **no new dependency** — use Node.js `https` module directly. The GitHub REST API for issues is simple enough that a thin wrapper suffices. If complexity grows (pagination, rate-limit handling), migrate to `@octokit/request`.

---

## 6. Conflict Resolution Strategy

When both local and remote have changed since last sync:

| Scenario | Resolution |
|----------|-----------|
| Only local changed | Push to GitHub |
| Only remote changed | Pull from GitHub |
| Both changed, same content | No-op |
| Both changed, different content | **Last-write-wins** based on `updatedAt` vs `issue.updated_at` |
| Task deleted locally, issue still open | Prompt user: close issue or re-import? |
| Issue closed remotely, task not done | Set task state to `done` |

For MVP, **last-write-wins** is sufficient. A more sophisticated merge UI can be added later.

---

## 7. Security Considerations

1. **Token storage:** The GitHub PAT (if used) must be stored via `electron-store` with encryption, NOT in plain SQLite. The existing `electron-store` dependency supports encryption.
2. **Preload isolation:** GitHub API calls must happen in the **main process only**. The renderer should never have direct access to tokens.
3. **Scope limitation:** Only request `repo` scope for the PAT (or rely on `gh` which already handles scoping).
4. **Rate limiting:** GitHub API allows 5,000 requests/hour for authenticated users. Add basic rate-limit awareness (check `X-RateLimit-Remaining` header).

---

## 8. Label Sync Strategy

Castle labels and GitHub labels should sync bidirectionally:

| Direction | Behavior |
|-----------|----------|
| Castle → GitHub | On push, ensure all Castle labels exist on the repo; apply matching labels to issue |
| GitHub → Castle | On pull, import GitHub labels that don't exist locally; map by name |
| Color mapping | GitHub labels use 6-digit hex (no `#`); Castle uses `#`-prefixed hex — trivial conversion |
| Castle state labels | Push `castle:state_name` labels to preserve fine-grained states on GitHub |

---

## 9. Implementation Phases & Effort Estimate

| Phase | Description | Files Touched | Complexity |
|-------|-------------|---------------|------------|
| 1 | Git remote detection | 2 new, 1 modified | Low |
| 2 | GitHub authentication (gh CLI + PAT) | 1 new, 2 modified | Low |
| 3 | GitHub API service | 1 new | Medium |
| 4 | State mapping utilities | 1 new | Low |
| 5 | Sync engine | 1 new, 1 modified (DB) | High |
| 6 | Database extensions | 1 modified | Low |
| 7 | IPC channels + preload | 3 modified | Medium |
| 8 | UI changes (badge, sync button, import, settings) | 4–5 modified | Medium |

**Total new files:** ~4–5  
**Total modified files:** ~8–10

---

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `gh` CLI not installed | Auth fails silently | Detect and prompt for PAT fallback with clear UI messaging |
| GitHub API rate limits | Sync fails mid-operation | Respect `X-RateLimit-Remaining`; batch operations; show status to user |
| Sync conflicts lose data | User frustration | Always keep local copy; log sync history; add undo capability later |
| Private repos need auth | Feature appears broken | Validate token permissions on first sync attempt; surface clear errors |
| Large repos (1000+ issues) | Slow full sync | Paginate; use `since` filter; only sync issues with `castle:` labels |
| Network failures mid-sync | Partial state | Each task syncs independently; track `github_synced_at` per task |

---

## 11. Future Enhancements (Out of Scope for MVP)

- **Webhook listener** — Real-time sync via GitHub webhooks instead of polling
- **Assignee mapping** — Map GitHub assignees to Castle agents
- **Milestone sync** — Map Castle label groups to GitHub milestones
- **Comment sync** — Sync GitHub issue comments to Castle task notes
- **PR linking** — Auto-detect PRs that reference synced issues
- **Multi-remote support** — Handle forks and multiple remotes
- **GitHub Projects integration** — Sync with GitHub Projects v2 board columns

---

## 12. Recommended Implementation Order

1. **Git remote detection** → gives the "is this a GitHub repo?" signal
2. **GitHub auth** → enables API access
3. **Single-task push** → create issue from Castle task (most common flow)
4. **Single-task pull** → import issue by number
5. **GitHub badge on task detail** → visual feedback that sync is working
6. **Bulk sync** → sync all linked tasks
7. **Import all issues** → pull all open issues as tasks
8. **Settings UI** → token management, enable/disable toggle