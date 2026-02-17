# Worktree Agent Tasks

## Research: Using Git Worktrees for Parallel Agent Development

### 1. Problem Statement

Castle currently runs all agent sessions (research, implementation) against the same working directory — the single active workspace tracked by `DirectoryService.getCurrentDirectory()`. This means:

- **Only one implementation agent can safely modify files at a time.** Two agents writing to the same directory will cause file conflicts, race conditions, and corrupted state.
- **The user's working tree is mutated directly.** If an agent makes a bad change, the user must manually revert.
- **No branch isolation.** All agent work happens on whatever branch is currently checked out, making it impossible to run parallel feature branches.

**Goal:** Enable multiple agents to work simultaneously on different Git branches, each in an isolated filesystem, and automatically create a Pull Request when done.

---

### 2. What Are Git Worktrees?

Git worktrees allow a single `.git` repository to have **multiple working directories**, each checked out to a different branch. Unlike cloning, worktrees share the same object store, refs, and history — making them lightweight and fast.

```bash
# Create a worktree for a new feature branch based on main
git worktree add .worktrees/feature-login -b feature/login main

# List all worktrees
git worktree list

# Remove a worktree after merging
git worktree remove .worktrees/feature-login
git worktree prune
```

**Key properties:**
- Each worktree has its own index, HEAD, and working files
- A branch can only be checked out in **one** worktree at a time
- Worktrees share the `.git` object database — no extra disk cost for history
- Creating a worktree is nearly instant (no network fetch, no clone)

---

### 3. How This Maps to Castle's Architecture

#### 3.1 Current Flow (Single Directory)

```
DirectoryService.getCurrentDirectory()  →  "C:\source\my-project"
                                              ↓
ProcessManagerService.startSession(agent, workingDirectory)
                                              ↓
spawn('copilot', ['--acp', '--stdio'], { cwd: "C:\source\my-project" })
                                              ↓
ACP newSession({ cwd: "C:\source\my-project" })
```

All agents share the same `cwd`. Concurrent implementation agents would stomp on each other's file changes.

#### 3.2 Proposed Flow (Worktree Per Task)

```
Task "Add login page" → implementation requested
                              ↓
WorktreeService.createWorktree("feature/add-login-page")
    → git worktree add .worktrees/add-login-page -b feature/add-login-page main
    → returns "C:\source\my-project\.worktrees\add-login-page"
                              ↓
ProcessManagerService.startSession(agent, worktreeDirectory)
    → spawn('copilot', [...], { cwd: worktreeDirectory })
    → ACP newSession({ cwd: worktreeDirectory })
                              ↓
Agent works in isolated directory (own branch, own file state)
                              ↓
On completion → git add, commit, push → gh pr create
                              ↓
WorktreeService.cleanupWorktree("add-login-page")
```

**The key insight:** Castle already passes `workingDirectory` to `startSession()` and through to `spawn({ cwd })`. Switching from the main directory to a worktree directory requires **no changes to the ProcessManager or ACP protocol** — only the directory path changes.

---

### 4. Technical Analysis

#### 4.1 New Service: `WorktreeService`

A new Electron main-process service that wraps Git worktree operations.

**Responsibilities:**
- Create worktrees for tasks (branch name derived from task title)
- Track active worktrees and their associated tasks
- Run `npm install` (or equivalent) in new worktrees if `node_modules` is gitignored
- Commit and push agent changes on task completion
- Create Pull Requests via `gh` CLI
- Clean up worktrees after PR is merged or task is cancelled

**Proposed API:**

```typescript
interface WorktreeService {
  // Create a new worktree for a task, returns the worktree directory path
  createForTask(task: Task, baseBranch?: string): Promise<WorktreeInfo>;

  // Get the worktree directory for an active task
  getWorktreeForTask(taskId: string): WorktreeInfo | null;

  // Commit all changes in a worktree
  commitChanges(taskId: string, message: string): Promise<void>;

  // Push branch and create a PR
  pushAndCreatePR(taskId: string, options: PROptions): Promise<PRResult>;

  // Remove worktree and optionally delete branch
  cleanup(taskId: string, deleteBranch?: boolean): Promise<void>;

  // List all active worktrees managed by Castle
  listActive(): WorktreeInfo[];

  // Check if git worktree is available in the current project
  isAvailable(projectPath: string): Promise<boolean>;
}

interface WorktreeInfo {
  taskId: string;
  branchName: string;
  directory: string;       // Absolute path to worktree
  baseBranch: string;      // Branch it was created from (e.g., "main")
  createdAt: Date;
}

interface PROptions {
  title: string;
  body: string;
  baseBranch: string;
  draft?: boolean;
  labels?: string[];
  reviewers?: string[];
}

interface PRResult {
  url: string;
  number: number;
}
```

#### 4.2 Git Command Execution

All git operations should use Node.js `child_process.execFile` (not `exec` — avoids shell injection) run from the appropriate working directory:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

async function gitExec(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

// Example: Create worktree
await gitExec([
  'worktree', 'add',
  worktreePath,
  '-b', branchName,
  baseBranch
], projectRoot);
```

#### 4.3 Branch Naming Convention

Derive branch names from task metadata to ensure uniqueness and readability:

```
feature/<task-kind>/<sanitized-task-title>-<short-id>
```

Examples:
- `feature/add-login-page-a1b2`
- `bugfix/fix-null-pointer-in-parser-c3d4`
- `chore/update-dependencies-e5f6`

```typescript
function branchNameForTask(task: Task): string {
  const prefix = task.kind === 'bug' ? 'bugfix' : task.kind || 'feature';
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
  const shortId = task.id.substring(0, 4);
  return `${prefix}/${slug}-${shortId}`;
}
```

#### 4.4 Worktree Directory Location

Place worktrees in a `.worktrees/` directory at the project root:

```
C:\source\my-project\
├── .git\
├── .worktrees\                    ← Add to .gitignore
│   ├── add-login-page-a1b2\      ← Worktree for task A
│   │   ├── src\
│   │   ├── package.json
│   │   └── ...
│   └── fix-null-pointer-c3d4\    ← Worktree for task B
│       ├── src\
│       ├── package.json
│       └── ...
├── src\
├── package.json
└── ...
```

**Important:** `.worktrees/` must be added to `.gitignore` to prevent accidental commits.

#### 4.5 Dependency Installation

Since `node_modules/` is typically gitignored, new worktrees won't have dependencies. The service must detect the package manager and install:

```typescript
async function installDependencies(worktreeDir: string): Promise<void> {
  if (await fileExists(path.join(worktreeDir, 'package-lock.json'))) {
    await execFileAsync('npm', ['ci', '--prefer-offline'], { cwd: worktreeDir });
  } else if (await fileExists(path.join(worktreeDir, 'yarn.lock'))) {
    await execFileAsync('yarn', ['install', '--frozen-lockfile'], { cwd: worktreeDir });
  } else if (await fileExists(path.join(worktreeDir, 'pnpm-lock.yaml'))) {
    await execFileAsync('pnpm', ['install', '--frozen-lockfile'], { cwd: worktreeDir });
  }
  // For non-JS projects: detect Cargo.toml, go.mod, requirements.txt, etc.
}
```

**Note:** `npm ci --prefer-offline` uses the local cache where possible, minimizing network and time. For large projects, this step may take 30-60 seconds — the UI should show a progress state.

#### 4.6 PR Creation via `gh` CLI

The `gh` CLI is the simplest, most reliable way to create PRs programmatically. It piggybacks on the user's existing GitHub authentication.

```typescript
async function createPR(worktreeDir: string, options: PROptions): Promise<PRResult> {
  // Stage and commit any remaining changes
  await gitExec(['add', '-A'], worktreeDir);
  await gitExec(['commit', '-m', options.title, '--allow-empty'], worktreeDir);

  // Push branch
  const branch = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], worktreeDir);
  await gitExec(['push', '--set-upstream', 'origin', branch], worktreeDir);

  // Create PR
  const args = [
    'pr', 'create',
    '--base', options.baseBranch,
    '--head', branch,
    '--title', options.title,
    '--body', options.body,
  ];
  if (options.draft) args.push('--draft');
  if (options.labels?.length) args.push('--label', options.labels.join(','));
  if (options.reviewers?.length) args.push('--reviewer', options.reviewers.join(','));

  const output = await execFileAsync('gh', args, { cwd: worktreeDir });
  const url = output.stdout.trim();
  const prNumber = parseInt(url.split('/').pop() || '0');

  return { url, number: prNumber };
}
```

**Prerequisites:**
- `gh` CLI must be installed and authenticated (`gh auth status`)
- The repository must have a GitHub remote
- Castle should detect and validate these prerequisites before offering worktree features

#### 4.7 Task Lifecycle Integration

The modified implementation flow in `ipc/index.ts`:

```
TASKS_RUN_IMPLEMENTATION handler:
  1. Load task from database
  2. Get agent from cache/database
  3. [NEW] Create worktree via WorktreeService.createForTask(task)
  4. [NEW] Install dependencies in worktree
  5. Start agent session with worktree directory as workingDirectory
  6. Build implementation prompt (include branch context)
  7. Send message via ACP

On agent completion (CHAT_STREAM_COMPLETE):
  8. [NEW] Auto-commit agent changes
  9. [NEW] Push and create PR via WorktreeService.pushAndCreatePR()
  10. [NEW] Store PR URL/number on the task record
  11. [NEW] Optionally clean up worktree (or keep for revisions)
  12. Transition task to 'done' state
```

#### 4.8 Database Schema Changes

Add columns to track worktree and PR state per task:

```sql
ALTER TABLE tasks ADD COLUMN worktree_branch TEXT;
ALTER TABLE tasks ADD COLUMN worktree_path TEXT;
ALTER TABLE tasks ADD COLUMN pr_url TEXT;
ALTER TABLE tasks ADD COLUMN pr_number INTEGER;
ALTER TABLE tasks ADD COLUMN pr_state TEXT;  -- 'draft', 'open', 'merged', 'closed'
```

Update the `Task` TypeScript interface:

```typescript
export interface Task {
  // ... existing fields ...
  worktreeBranch?: string;
  worktreePath?: string;
  prUrl?: string;
  prNumber?: number;
  prState?: 'draft' | 'open' | 'merged' | 'closed';
}
```

---

### 5. Implementation Phases

#### Phase 1: Core Worktree Service
- Create `WorktreeService` in `src/main/services/`
- Implement `createForTask()`, `cleanup()`, `listActive()`, `isAvailable()`
- Add `.worktrees/` to `.gitignore` handling
- Add DB schema migration for worktree/PR columns
- Add IPC channels for worktree operations

#### Phase 2: Integration with Task Implementation Flow
- Modify `TASKS_RUN_IMPLEMENTATION` handler to create worktree before starting agent session
- Pass worktree directory instead of main project directory to `startSession()`
- Add dependency installation step with progress reporting
- Handle errors (disk space, git not installed, etc.)

#### Phase 3: Auto-Commit and PR Creation
- On implementation complete, auto-stage and commit changes
- Push branch to remote
- Create PR via `gh` CLI with task title/description as PR body
- Store PR metadata on task record
- Add UI indicators for PR state (link, status badge)

#### Phase 4: Worktree Lifecycle Management
- Track active worktrees across app restarts (persist in DB)
- Clean up orphaned worktrees on app startup
- Allow user to re-open a worktree for follow-up agent work
- Handle "agent requests changes" scenario (re-enter worktree, make changes, push)
- Add periodic `git worktree prune` calls

#### Phase 5: UI and UX

**Branch selection:**
- When starting an implementation task, prompt the user to either create a new branch (auto-named from the task) or select an existing branch from a dropdown populated via `git branch -a`
- This allows agents to continue work on in-progress branches or collaborate on a shared feature branch

**Agent chat status indicators:**
- The agent chat view for an implementation task should display a persistent status bar showing:
  - **Task name** — which task the agent is working on
  - **Git branch** — the branch / worktree the agent is operating in (e.g., `feature/add-login-page-a1b2`)
  - **Current step** — a live indicator of which lifecycle phase the agent is in: `Creating worktree` → `Installing dependencies` → `Implementation` → `Committing changes` → `Creating PR` → `Done`
- These status updates are driven by events emitted from the IPC handler at each phase transition

**PR revision workflow:**
- After a PR is created, the worktree is **not** cleaned up immediately — it is kept alive for revisions
- When PR review comments are received (detected via GitHub webhook, polling, or manual refresh), Castle surfaces them in the task's chat view
- The user can continue the agent chat for that task; the agent receives the PR review comments as context and works in the same worktree to address them
- New commits are pushed to the existing PR branch automatically (no new PR created)
- The worktree is only cleaned up when the user explicitly marks the task as done or the PR is merged

**Other UI elements:**
- Show worktree/branch status on task cards
- Show PR link and status on task detail view
- Add manual "Create PR" button for tasks where auto-PR is not desired
- Show diff preview before creating PR
- Settings: enable/disable worktree mode, default base branch, draft PR by default

---

### 6. Considerations and Edge Cases

#### 6.1 Disk Space
Each worktree creates a full copy of the working tree files (but shares `.git` objects). For a project with 100MB of source files, each active worktree adds ~100MB. Node projects with `node_modules` can be significantly larger after dependency install.

**Mitigation:**
- Limit maximum concurrent worktrees (configurable, default 3-5)
- Auto-cleanup completed worktrees after PR is created
- Warn user about disk usage before creating worktree

#### 6.2 Long-Running Processes
If an agent starts a dev server or watcher in the worktree, those processes must be tracked and killed during cleanup.

**Mitigation:**
- Track all child processes spawned per worktree
- Force-kill on cleanup with graceful shutdown attempt first

#### 6.3 Git Lock Contention
Multiple worktrees share the same `.git` directory. Concurrent git operations can occasionally cause lock contention on `.git/index.lock` or similar files.

**Mitigation:**
- Git worktrees use separate index files by design (`.git/worktrees/<name>/index`)
- Operations on the shared ref store (push, fetch) should be serialized via a queue
- Use `--no-optional-locks` flag for read-only git operations

#### 6.4 Branch Conflicts
Two agents might modify the same files on different branches. This is fine at the worktree level (separate directories), but could cause merge conflicts when PRs are merged.

**Mitigation:**
- This is by design — PRs provide the conflict resolution mechanism
- Optionally detect overlapping file changes and warn the user
- Recommend merging PRs one at a time and rebasing remaining branches

#### 6.5 Non-Git Projects
If the user's project isn't a Git repository, worktrees aren't available.

**Mitigation:**
- `WorktreeService.isAvailable()` checks for `.git` directory and valid `git` binary on PATH
- Gracefully fall back to current single-directory behavior
- **Display a persistent banner** in the Castle UI when a non-git project is opened (or when `git` is not installed), clearly stating: _"Git is not detected in this project. Worktree-based parallel agent tasks are unavailable."_ The banner should include a link to documentation on initializing a git repository or installing git
- The banner should be dismissible but reappear if the user navigates to a different non-git project

#### 6.6 Uncommitted Changes in Main Worktree
If the user has uncommitted changes in their main working directory, creating a worktree from that state won't include those changes (worktrees branch from committed state).

**Mitigation:**
- Warn user about uncommitted changes before starting a worktree-based task
- Optionally stash changes first, or create worktree from `HEAD` (which reflects the last commit)

#### 6.7 Windows-Specific Concerns
- Long path names: `.worktrees/<name>/node_modules/...` can exceed Windows 260-char limit
  - **Mitigation:** Enable long paths via `git config core.longpaths true` in the worktree
- File locking: Windows locks open files more aggressively than Unix
  - **Mitigation:** Ensure all file handles are closed before worktree cleanup
- Symlinks: Some projects use symlinks that may not work in worktrees on Windows
  - **Mitigation:** Enable `core.symlinks` and run as admin if needed, or document limitation

#### 6.8 Authentication and Origin Providers
The `gh` CLI must be authenticated. Castle should check this proactively.

```typescript
async function isGhAuthenticated(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}
```

If not authenticated, Castle can prompt the user to run `gh auth login` or provide a PAT.

**Future: Multi-Provider Support**

The initial implementation targets GitHub via the `gh` CLI, but the `WorktreeService` should be designed with a **provider-agnostic abstraction** so that future versions can support other origin providers such as Azure DevOps, GitLab, Bitbucket, etc.

Proposed approach for future extensibility:

```typescript
interface PullRequestProvider {
  readonly name: string;  // 'github', 'azure-devops', 'gitlab', etc.

  // Detect if this provider matches the current repository's remote URL
  matchesRemote(remoteUrl: string): boolean;

  // Check if the user is authenticated with this provider
  isAuthenticated(cwd: string): Promise<boolean>;

  // Create a pull/merge request
  createPR(cwd: string, options: PROptions): Promise<PRResult>;

  // Push commits to an existing PR (for revisions)
  pushToExistingPR(cwd: string, prNumber: number): Promise<void>;

  // Fetch PR review comments
  getPRComments(cwd: string, prNumber: number): Promise<PRComment[]>;
}
```

The `WorktreeService` would detect the remote URL (`git remote get-url origin`) and select the appropriate provider. For v1, only a `GitHubProvider` (using `gh` CLI) is implemented. Azure DevOps support (`az repos pr create`) and GitLab support (`glab mr create`) can be added as additional providers without modifying the core worktree logic.

---

### 7. Alternative Approaches Considered

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **Git Worktrees** | Lightweight, fast, shared history, native Git feature | Requires git knowledge, disk space per worktree | ✅ **Recommended** |
| **Shallow Clones** | Full isolation | Slow (network fetch), duplicate history, complex tracking | ❌ Too slow |
| **Docker Containers** | Perfect isolation | Heavy, requires Docker install, complex setup | ❌ Too heavy |
| **Temp Branches (no worktree)** | Simple | Only one checkout at a time, no parallelism | ❌ Defeats purpose |
| **Git Stash-based** | No extra disk | Sequential only, fragile, no parallelism | ❌ Defeats purpose |
| **Patch Files** | Minimal disk | Complex to manage, no live file system for agent | ❌ Impractical |

---

### 8. Feasibility Assessment

| Factor | Status | Notes |
|--------|--------|-------|
| Git worktree support | ✅ Available | Built into Git since v2.5 (2015). Universally available. |
| Castle architecture compatibility | ✅ Compatible | `startSession()` already accepts `workingDirectory` — just pass worktree path instead. |
| ACP protocol compatibility | ✅ Compatible | ACP `newSession({ cwd })` works with any directory. No protocol changes needed. |
| `gh` CLI for PR creation | ✅ Available | Widely installed. Can detect availability and fall back gracefully. |
| Dependency install in worktrees | ⚠️ Moderate | Adds latency (30-120s for npm install). Can be mitigated with `--prefer-offline`. |
| Disk space | ⚠️ Moderate | ~100MB per worktree for typical projects. Cap concurrent worktrees. |
| Complexity | ⚠️ Moderate | New service + DB changes + IPC channels + UI updates. ~5-8 new/modified files. |

**Overall: Highly feasible.** The most impactful change (passing worktree path to `startSession`) is a one-line modification. The bulk of the work is the lifecycle management around worktree creation, dependency install, PR creation, and cleanup.

---

### 9. Dependencies and Prerequisites

**Required:**
- `git` v2.5+ installed and on PATH (for `git worktree` support)
- Project must be a git repository with a remote

**Required for PR creation:**
- `gh` CLI installed and authenticated (`gh auth login`)
- Repository must be hosted on GitHub

**No new npm packages required.** All operations use `child_process.execFile` against `git` and `gh` CLI tools. This avoids adding heavy dependencies like `nodegit` or `simple-git`.

---

### 10. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Agent corrupts worktree state | Medium | Low | Worktree is disposable; delete and recreate |
| Disk fills up from many worktrees | Low | High | Cap concurrent worktrees; auto-cleanup on completion |
| `gh` CLI not installed | Medium | Medium | Detect and show setup instructions; allow manual PR |
| Git lock contention | Low | Medium | Serialize push/fetch operations; worktree-local ops are safe |
| Agent makes no meaningful changes | Medium | Low | Detect empty diff; skip PR creation; notify user |
| Windows long paths | Medium | Medium | Enable `core.longpaths`; use short worktree directory names |
| npm install fails in worktree | Low | High | Show error; allow retry; fall back to main directory |

---

### 11. Summary

Git worktrees are an excellent fit for Castle's parallel agent architecture. The core integration is straightforward because `ProcessManagerService.startSession()` already parameterizes the working directory — pointing it at a worktree instead of the main project directory requires minimal code change.

The primary engineering effort is in **lifecycle management**: creating worktrees, installing dependencies, committing changes, creating PRs, and cleaning up. This is a self-contained feature that can be built incrementally across 5 phases without disrupting existing functionality.

**Key architectural decision:** Worktree mode should be **opt-in per task** (not a global setting), allowing users to run simple tasks in the main directory while using worktrees for parallel implementation tasks that benefit from branch isolation.
