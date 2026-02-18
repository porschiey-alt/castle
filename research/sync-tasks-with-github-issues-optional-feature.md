# Research: Sync Tasks with GitHub Issues (Optional Feature)

## Executive Summary

Castle has a full-featured local task system (create, edit, state management, labels, research/implementation workflows) that operates entirely offline in a local SQLite database. The `Task` model already includes `githubIssueNumber` and `githubRepo` fields in both the TypeScript interface and the database schema, but **they are never populated** — there is no code that reads from or writes to GitHub Issues. The existing GitHub integration is limited to PR creation via the `gh` CLI.

This document proposes a design for optional, bidirectional sync between Castle tasks and GitHub Issues, leveraging the existing `gh` CLI authentication (no new tokens or OAuth flows needed) and the provider pattern already established in `GitWorktreeService`.

---

## Current State Analysis

### What Already Exists

| Component | Status | Notes |
|-----------|--------|-------|
| `Task.githubIssueNumber` field | ✅ In schema + types | Never written to |
| `Task.githubRepo` field | ✅ In schema + types | Never written to |
| `UpdateTaskInput` type | ❌ Missing these fields | Only includes PR-related fields |
| `CreateTaskInput` type | ❌ Missing these fields | Only title, description, state, kind |
| GitHub remote detection | ✅ `GitHubProvider.matchesRemote()` | Regex: `/github\.com/i` |
| `gh` CLI authentication | ✅ `GitHubProvider.isAuthenticated()` | Uses `gh auth status` |
| `gh` CLI usage pattern | ✅ PRs via `gh pr create` | Proven pattern to extend |
| Settings infrastructure | ✅ `AppSettings` with toggles | Has worktree section as template |
| Provider pattern | ✅ `PullRequestProvider` interface | Could be extended or paralleled |
| Owner/repo URL parsing | ❌ Does not exist | `gh` CLI auto-detects from git remote |
| Issue API integration | ❌ Does not exist | Needs to be built |

### Key Architectural Decisions Already Made
- **`gh` CLI over Octokit**: The project chose the GitHub CLI for GitHub operations, meaning no API tokens need to be managed in-app — `gh` handles auth via system keychain
- **Provider pattern**: An abstract `PullRequestProvider` interface exists, though Issue operations would likely need a separate interface or extension
- **`execFile` (not `exec`)**: All external commands use `execFile` for shell injection safety
- **Tasks scoped to projectPath**: Tasks are already associated with a `projectPath`, aligning naturally with per-repo GitHub issue sync

---

## Technical Analysis

### GitHub CLI Issue Commands

The `gh` CLI provides a complete issue management API:

```bash
# Create issue
gh issue create --title "Title" --body "Body" --label "bug,priority"

# Get issue (JSON output)
gh issue view 42 --json number,title,body,state,labels,url

# List issues (JSON output)
gh issue list --json number,title,body,state,labels,url --limit 100

# Update issue
gh issue edit 42 --title "New Title" --body "New Body"

# Close issue
gh issue close 42

# Reopen issue
gh issue reopen 42

# Add labels
gh issue edit 42 --add-label "bug,priority"

# Remove labels
gh issue edit 42 --remove-label "wontfix"
```

**All commands auto-detect the repo from the git remote** — no need to parse owner/repo URLs.

### Mapping: Castle Tasks ↔ GitHub Issues

| Castle Field | GitHub Issue Field | Sync Direction | Notes |
|-------------|-------------------|----------------|-------|
| `title` | `title` | ↔ Bidirectional | Direct map |
| `description` | `body` | ↔ Bidirectional | Markdown in both |
| `state` (new/active/in_progress/blocked/done) | `state` (open/closed) | ↔ With mapping | Castle `done` → GitHub `closed`; all others → `open` |
| `kind` (feature/bug/chore/spike) | Labels | → Push only | Map to GitHub labels like `kind:feature`, `kind:bug` |
| `labels` | Labels | ↔ Bidirectional | Castle TaskLabels ↔ GitHub Labels |
| `githubIssueNumber` | `number` | ← From GitHub | Set on create or link |
| `githubRepo` | Auto-detected | ← From remote | `owner/repo` string |
| `closeReason` | Close comment or label | → Push only | Could add as label: `close:fixed`, `close:wontfix` |

### State Mapping

```
Castle Task States        GitHub Issue States
─────────────────        ──────────────────
new          ──────────→  open
active       ──────────→  open
in_progress  ──────────→  open
blocked      ──────────→  open  (+ label "blocked")
done         ──────────→  closed

open         ←──────────  new (if no existing Castle state)
closed       ←──────────  done
```

---

## Proposed Approach

### Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                        Frontend                           │
│                                                           │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐ │
│  │  Task Detail  │   │  Task List   │   │  Settings    │ │
│  │ (link/unlink  │   │ (sync badge, │   │ (toggle,     │ │
│  │  indicator)   │   │  import btn) │   │  auto-sync)  │ │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘ │
│         │                  │                   │          │
│  ┌──────┴──────────────────┴───────────────────┴───────┐ │
│  │              TaskService + ElectronService           │ │
│  └─────────────────────────┬───────────────────────────┘ │
└────────────────────────────┼─────────────────────────────┘
                             │ IPC
┌────────────────────────────┼─────────────────────────────┐
│                     Main Process                          │
│                            │                              │
│  ┌─────────────────────────┴───────────────────────────┐ │
│  │                   IPC Handlers                       │ │
│  │ GITHUB_ISSUES_SYNC, GITHUB_ISSUES_IMPORT,           │ │
│  │ GITHUB_ISSUES_PUSH, GITHUB_ISSUES_CHECK             │ │
│  └───────────┬─────────────────────────┬───────────────┘ │
│              │                         │                  │
│  ┌───────────┴───────────┐  ┌──────────┴──────────────┐  │
│  │   GitHubIssueService  │  │    DatabaseService      │  │
│  │  (gh CLI wrapper)     │  │  (task CRUD + github    │  │
│  │                       │  │   fields)               │  │
│  └───────────────────────┘  └─────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Phase 1: Core Infrastructure (Backend)

#### 1.1 Create `GitHubIssueService`

New file: `src/main/services/github-issue.service.ts`

This service wraps `gh` CLI commands for issue operations:

```typescript
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
}

export class GitHubIssueService {
  /** Check if current directory is a GitHub repo with gh auth */
  async isAvailable(cwd: string): Promise<boolean>

  /** Get owner/repo string from git remote */
  async getRepoSlug(cwd: string): Promise<string | null>

  /** List all open issues */
  async listIssues(cwd: string, state?: 'open' | 'closed' | 'all'): Promise<GitHubIssue[]>

  /** Get single issue by number */
  async getIssue(cwd: string, issueNumber: number): Promise<GitHubIssue | null>

  /** Create a new issue, returns the created issue */
  async createIssue(cwd: string, title: string, body: string, labels?: string[]): Promise<GitHubIssue>

  /** Update an existing issue */
  async updateIssue(cwd: string, issueNumber: number, updates: { title?: string; body?: string }): Promise<void>

  /** Close an issue */
  async closeIssue(cwd: string, issueNumber: number): Promise<void>

  /** Reopen an issue */
  async reopenIssue(cwd: string, issueNumber: number): Promise<void>

  /** Add labels to an issue */
  async addLabels(cwd: string, issueNumber: number, labels: string[]): Promise<void>

  /** Remove labels from an issue */
  async removeLabels(cwd: string, issueNumber: number, labels: string[]): Promise<void>
}
```

Implementation uses `execFileAsync('gh', [...args], { cwd })` — the same pattern as `GitHubProvider`.

#### 1.2 Update Type Definitions

**`src/shared/types/task.types.ts`:**

Add `githubIssueNumber` and `githubRepo` to `CreateTaskInput` and `UpdateTaskInput`:

```typescript
export type CreateTaskInput = Pick<Task, 'title' | 'description' | 'state' | 'kind'> & {
  labelIds?: string[];
  githubIssueNumber?: number;  // NEW
  githubRepo?: string;         // NEW
};

export type UpdateTaskInput = Partial<Pick<Task, 
  'title' | 'description' | 'state' | 'kind' | 'researchContent' | 'researchAgentId' | 
  'implementAgentId' | 'closeReason' | 'worktreePath' | 'branchName' | 'prUrl' | 'prNumber' | 'prState' |
  'githubIssueNumber' | 'githubRepo'  // NEW
>> & {
  labelIds?: string[];
};
```

#### 1.3 Update Database Service

**`src/main/services/database.service.ts`:**

Add support for `githubIssueNumber` and `githubRepo` in `createTask()` and `updateTask()`:

```typescript
// createTask: add to INSERT statement
`INSERT INTO tasks (id, title, description, state, kind, project_path, github_issue_number, github_repo, ...)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ...)`

// updateTask: add to dynamic SET builder
if (updates.githubIssueNumber !== undefined) { sets.push('github_issue_number = ?'); params.push(updates.githubIssueNumber); }
if (updates.githubRepo !== undefined) { sets.push('github_repo = ?'); params.push(updates.githubRepo); }
```

#### 1.4 Add IPC Channels

**`src/shared/types/ipc.types.ts`:**

```typescript
// GitHub Issue operations
GITHUB_ISSUES_CHECK: 'github:issues:check',       // Check if GitHub sync is available
GITHUB_ISSUES_LIST: 'github:issues:list',          // List remote issues
GITHUB_ISSUES_PUSH: 'github:issues:push',          // Push task → GitHub issue
GITHUB_ISSUES_PULL: 'github:issues:pull',           // Pull GitHub issue → task
GITHUB_ISSUES_IMPORT: 'github:issues:import',      // Bulk import issues as tasks
GITHUB_ISSUES_UNLINK: 'github:issues:unlink',      // Remove link between task and issue
```

#### 1.5 Add IPC Handlers

**`src/main/ipc/index.ts`:**

```typescript
handle(IPC_CHANNELS.GITHUB_ISSUES_CHECK, async () => {
  const cwd = directoryService.getCurrentDirectory();
  if (!cwd) return { available: false };
  const available = await githubIssueService.isAvailable(cwd);
  const repo = available ? await githubIssueService.getRepoSlug(cwd) : null;
  return { available, repo };
});

handle(IPC_CHANNELS.GITHUB_ISSUES_PUSH, async (_event, { taskId }) => {
  // Load task → create or update GitHub issue → save issue number back to task
});

handle(IPC_CHANNELS.GITHUB_ISSUES_IMPORT, async (_event, { issueNumbers }) => {
  // For each issue: gh issue view → create task with linked issue number
});
```

#### 1.6 Add Settings Toggle

**`src/shared/types/settings.types.ts`:**

```typescript
export interface AppSettings {
  // ... existing fields ...
  githubIssueSyncEnabled: boolean;  // NEW - opt-in toggle
}

export const DEFAULT_SETTINGS: AppSettings = {
  // ... existing defaults ...
  githubIssueSyncEnabled: false,
};
```

---

### Phase 2: Frontend Integration

#### 2.1 Task Service Extensions

**`src/app/core/services/task.service.ts`:**

Add methods:
```typescript
async checkGitHubAvailable(): Promise<{ available: boolean; repo: string | null }>
async pushToGitHub(taskId: string): Promise<void>
async importFromGitHub(issueNumbers: number[]): Promise<Task[]>
async unlinkFromGitHub(taskId: string): Promise<void>
```

#### 2.2 Task Detail Component — GitHub Badge & Actions

**In task-detail template**, add near the PR badge area:

```html
@if (task.githubIssueNumber) {
  <a class="github-issue-badge" [href]="getIssueUrl(task)" target="_blank">
    <mat-icon>link</mat-icon>
    #{{ task.githubIssueNumber }}
  </a>
  <button mat-icon-button matTooltip="Unlink from GitHub Issue" (click)="unlinkIssue()">
    <mat-icon>link_off</mat-icon>
  </button>
} @else if (githubAvailable) {
  <button mat-button (click)="pushToGitHub()">
    <mat-icon>cloud_upload</mat-icon>
    Push to GitHub
  </button>
}
```

#### 2.3 Task List Component — Import Button

Add an "Import from GitHub" button in the task list header:

```html
@if (githubAvailable) {
  <button mat-icon-button matTooltip="Import from GitHub Issues" (click)="openImportDialog()">
    <mat-icon>cloud_download</mat-icon>
  </button>
}
```

#### 2.4 Import Dialog Component

New component: `src/app/features/tasks/github-import-dialog/`

A dialog that:
1. Fetches open GitHub issues via `GITHUB_ISSUES_LIST`
2. Shows checkboxes to select which to import
3. Filters out issues already linked to tasks
4. Creates tasks for selected issues

#### 2.5 Settings Page — GitHub Section

Add a new section to `settings-page.component.html`:

```html
<!-- GitHub Integration Section -->
<section class="settings-section">
  <h3>
    <mat-icon>code</mat-icon>
    GitHub Issues
  </h3>
  <p class="section-description">
    Sync tasks with GitHub Issues when the project has a GitHub remote.
  </p>
  <div class="setting-row">
    <div class="setting-label">
      <span>Enable GitHub Issue sync</span>
      <span class="setting-hint">Push tasks to GitHub Issues and import issues as tasks</span>
    </div>
    <mat-slide-toggle
      [(ngModel)]="githubIssueSyncEnabled"
      (change)="saveGitHubSettings()">
    </mat-slide-toggle>
  </div>
</section>
```

---

### Phase 3: Sync Logic

#### 3.1 Push: Task → GitHub Issue

When a task is created or updated AND `githubIssueSyncEnabled` AND the repo is on GitHub:

```
Task Created (no issue number)
  → gh issue create --title "Task Title" --body "Task Description"
  → Parse issue URL → extract issue number
  → updateTask(taskId, { githubIssueNumber, githubRepo })

Task Updated (has issue number)
  → gh issue edit {number} --title "..." --body "..."
  → If state changed to 'done': gh issue close {number}
  → If state changed from 'done': gh issue reopen {number}
```

#### 3.2 Pull: GitHub Issue → Task

Import flow (manual, not automatic polling):

```
User clicks "Import from GitHub"
  → gh issue list --json number,title,body,state,labels,url
  → Show dialog with issues not yet linked to tasks
  → User selects issues
  → For each: createTask({ title, description, kind, githubIssueNumber, githubRepo })
```

#### 3.3 Sync on Task State Change

Hook into the existing `TASKS_UPDATE` handler:

```typescript
// In TASKS_UPDATE IPC handler, after database update
if (settings.githubIssueSyncEnabled && updatedTask.githubIssueNumber) {
  const cwd = directoryService.getCurrentDirectory();
  if (cwd) {
    // Title/description sync
    if (updates.title || updates.description) {
      await githubIssueService.updateIssue(cwd, updatedTask.githubIssueNumber, {
        title: updates.title,
        body: updates.description,
      });
    }
    // State sync
    if (updates.state === 'done') {
      await githubIssueService.closeIssue(cwd, updatedTask.githubIssueNumber);
    } else if (updates.state && updates.state !== 'done' && /* was done before */) {
      await githubIssueService.reopenIssue(cwd, updatedTask.githubIssueNumber);
    }
  }
}
```

---

## Key Considerations

### 1. Opt-In by Design
- Feature is **off by default** via `githubIssueSyncEnabled: false`
- Works only when the repo has a `github.com` remote
- Requires `gh` CLI to be installed and authenticated
- Individual tasks can be linked/unlinked independently

### 2. Sync Direction Philosophy
- **Push is explicit**: User clicks "Push to GitHub" or enables auto-push
- **Import is explicit**: User manually imports issues via dialog
- **No automatic polling**: Avoid surprise API calls and rate limits
- **State changes auto-push** when sync is enabled (lightweight — single `gh` call)

### 3. Error Handling
- `gh` CLI not installed → gracefully degrade, hide GitHub UI elements
- `gh` not authenticated → show error with instructions
- Network offline → queue failed operations? Or just show error and let user retry
- Issue deleted on GitHub → handle 404 gracefully, offer to unlink
- Rate limiting → `gh` CLI handles this internally

### 4. Conflict Resolution
- **Last-write-wins**: No complex merge logic
- Castle is the source of truth for task metadata (state, kind, research, etc.)
- GitHub is the source of truth for issue number and remote collaboration
- If both sides changed the title, Castle's version wins on next push

### 5. Label Mapping
- Castle `TaskKind` maps to GitHub labels: `kind:feature`, `kind:bug`, `kind:chore`, `kind:spike`
- Castle `TaskLabel` names map directly to GitHub label names
- GitHub labels not matching Castle labels are preserved but not displayed in Castle
- The `blocked` state could map to a `blocked` GitHub label

### 6. Edge Cases

| Scenario | Behavior |
|----------|----------|
| Issue already exists, user creates task | Use "Link existing issue" flow |
| Task deleted locally | Issue NOT deleted on GitHub (too destructive) |
| Issue closed on GitHub externally | Not auto-detected (no polling); user can manually refresh |
| Multiple Castle instances, same repo | Each instance manages its own task-issue links; cross-device sync handles local propagation |
| Repo has no GitHub remote | GitHub features hidden entirely |
| `gh` CLI not installed | GitHub features hidden; log warning |
| Issue number collision (task linked to wrong issue) | Unlink button allows correction |

### 7. What NOT to Build (Out of Scope)
- Automatic background polling of GitHub Issues
- Webhook-based real-time sync
- Comment sync (GitHub issue comments ↔ Castle research comments)
- Milestone/project board sync
- Assignee sync
- GitHub Actions integration

---

## File References

### Files to Modify

| File | Changes |
|------|---------|
| `src/shared/types/task.types.ts` | Add `githubIssueNumber`/`githubRepo` to `CreateTaskInput` and `UpdateTaskInput` |
| `src/shared/types/ipc.types.ts` | Add `GITHUB_ISSUES_*` IPC channels |
| `src/shared/types/settings.types.ts` | Add `githubIssueSyncEnabled` setting |
| `src/main/services/database.service.ts` | Handle `github_issue_number`/`github_repo` in `createTask()` and `updateTask()` |
| `src/main/ipc/index.ts` | Add GitHub issue IPC handlers; hook sync into `TASKS_UPDATE` and `TASKS_CREATE` |
| `src/app/core/services/task.service.ts` | Add GitHub check/push/import/unlink methods |
| `src/app/core/services/electron.service.ts` | Add GitHub issue IPC wrapper methods |
| `src/app/core/services/websocket-api.ts` | Add GitHub issue API methods |
| `src/app/features/tasks/task-detail/task-detail.component.ts` | Add GitHub badge, push/unlink buttons |
| `src/app/features/tasks/task-detail/task-detail.component.html` | GitHub UI elements |
| `src/app/features/tasks/task-list/task-list.component.ts` | Add import button, GitHub availability check |
| `src/app/features/tasks/task-list/task-list.component.html` | Import button in header |
| `src/app/features/settings/settings-page.component.ts` | GitHub settings toggle |
| `src/app/features/settings/settings-page.component.html` | GitHub settings section |

### Files to Create

| File | Purpose |
|------|---------|
| `src/main/services/github-issue.service.ts` | `gh` CLI wrapper for issue CRUD |
| `src/app/features/tasks/github-import-dialog/github-import-dialog.component.ts` | Issue import selection dialog |
| `src/app/features/tasks/github-import-dialog/github-import-dialog.component.html` | Import dialog template |
| `src/app/features/tasks/github-import-dialog/github-import-dialog.component.scss` | Import dialog styles |

### Files for Reference (Read Only)

| File | Why |
|------|-----|
| `src/main/services/git-worktree.service.ts` | `GitHubProvider` as pattern for `gh` CLI usage, `execFileAsync` pattern |
| `src/app/shared/components/confirm-dialog/confirm-dialog.component.ts` | Dialog pattern reference |

---

## Complexity Estimate

| Phase | Files | Lines (est.) | Risk | Dependencies |
|-------|-------|-------------|------|--------------|
| Phase 1: Backend infrastructure | 5 modified + 1 new | ~250-300 | Low | `gh` CLI installed |
| Phase 2: Frontend integration | 8 modified + 3 new | ~350-400 | Medium | Phase 1 |
| Phase 3: Sync logic (auto-push on update) | 1 modified | ~50-80 | Low | Phase 1 + 2 |
| **Total** | **14 modified + 4 new** | **~650-780** | **Medium** | `gh` CLI |

### External Dependencies
- **`gh` CLI** — already a dependency for PR creation; no new installs needed
- **No new npm packages** — all operations via `child_process.execFile`

---

## Recommended Implementation Order

1. **`GitHubIssueService`** — core `gh` CLI wrapper (can be tested in isolation)
2. **Type updates** — `CreateTaskInput`, `UpdateTaskInput`, `AppSettings`, IPC channels
3. **Database updates** — `createTask()`/`updateTask()` support for github fields
4. **IPC handlers** — `GITHUB_ISSUES_CHECK`, `GITHUB_ISSUES_PUSH`, `GITHUB_ISSUES_LIST`, `GITHUB_ISSUES_IMPORT`, `GITHUB_ISSUES_UNLINK`
5. **Settings toggle** — `githubIssueSyncEnabled` in settings page
6. **Frontend service methods** — `TaskService` + `ElectronService` + `WebSocketAPI`
7. **Task detail GitHub badge** — Show linked issue number, push/unlink buttons
8. **Import dialog** — Select and import GitHub issues as tasks
9. **Auto-sync on update** — Hook into `TASKS_UPDATE` handler for state/title/description sync
10. **Task list import button** — Header action to open import dialog

Each phase is independently useful:
- After step 5, users can manually push tasks to GitHub
- After step 8, users can import issues
- After step 9, ongoing changes stay in sync automatically
