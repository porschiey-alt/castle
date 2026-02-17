# Worktree Cleanup Fails — Bug Diagnosis

## Diagnosis and Suggested Fix

### Symptoms

When the user confirms LRU worktree cleanup, the operation fails with:

```
error: failed to delete 'C:/source/castle/.castle-worktrees/e3ad1c36-...': Permission denied
```

Both `git worktree remove --force` **and** the `fs.rmSync` fallback fail. The
branch deletion that follows also fails because the worktree still references it.

### Root Cause Analysis

The worktree directory being cleaned up is the **current working directory (cwd)** of
a running Copilot CLI child process. On Windows, a process's cwd is locked by the
OS — the directory cannot be deleted while any process holds it as its cwd.

#### The sequence of events

1. Agent A starts a task implementation. The implementation handler creates a worktree
   at `.castle-worktrees/<taskId>` and spawns a Copilot CLI child process with
   `cwd: worktreePath` (line 113–118 of `process-manager.service.ts`).

2. The task completes. The implementation handler marks the task as done and the
   session transitions to `ready` — but **the child process is never killed**. It
   remains alive, idle, with its cwd still pointing at the worktree directory.

3. Later, a new task triggers the worktree limit. The LRU cleanup picks the oldest
   worktree (the one from step 1) and calls `removeWorktree()`.

4. `removeWorktree()` runs `git worktree remove <path> --force` (line 427). Git
   tries to delete the directory, but Windows refuses because the Copilot CLI
   process still has it as its cwd → **Permission denied**.

5. The fallback `fs.rmSync(worktreePath, { recursive: true, force: true })` (line
   432) also fails for the same reason — the OS won't allow deleting a directory
   that is a process's cwd.

6. Because the worktree directory survives, `git branch -D` also fails (line 441)
   since git considers the branch still checked out in the worktree.

#### Why only on Windows?

On Unix-like systems, a directory can be deleted even while a process has it as its
cwd (the inode remains until all references are released). On Windows, the directory
is locked and cannot be removed while any handle (including cwd) is held.

#### Code path confirmation

**File:** `src/main/ipc/index.ts`, lines 699–700

```typescript
if (response === 0) {
  await gitWorktreeService.cleanupWorktrees(lru);  // ← no session stop first
```

The cleanup is called without first stopping any agent session whose
`workingDirectory` matches the worktree path.

**File:** `src/main/services/git-worktree.service.ts`, lines 426–437

```typescript
try {
  await gitExec(['worktree', 'remove', worktreePath, '--force'], repoRoot);
} catch (error) {
  log.warn('Error removing worktree', error);
  if (fs.existsSync(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true });  // ← also fails
  }
  try {
    await gitExec(['worktree', 'prune'], repoRoot);
  } catch { /* ignore */ }
}
```

Neither the primary nor fallback path can succeed while the process holds the cwd.

### Suggested Fix

Two complementary changes: (1) stop any agent sessions whose cwd is the worktree
being removed **before** attempting deletion, and (2) make `removeWorktree` more
resilient on Windows by retrying after a short delay.

#### 1. Add a method to find and stop sessions by working directory

**File:** `src/main/services/process-manager.service.ts`

```typescript
/**
 * Stop all sessions whose working directory starts with the given path.
 * Must be called before deleting a worktree directory on Windows.
 */
async stopSessionsByWorkDir(workDirPrefix: string): Promise<void> {
  const normalized = path.normalize(workDirPrefix);
  for (const [sessionId, sp] of this.sessions) {
    if (path.normalize(sp.session.workingDirectory).startsWith(normalized)) {
      log.info(`Stopping session ${sessionId} (cwd: ${sp.session.workingDirectory}) before worktree removal`);
      await this.stopSession(sessionId);
    }
  }
}
```

(Add `import * as path from 'path'` at the top if not already imported.)

#### 2. Stop sessions before LRU cleanup in the implementation handler

**File:** `src/main/ipc/index.ts`, line 700

```diff
                if (response === 0) {
+                 // Stop any agent sessions whose cwd is inside the worktrees being removed
+                 for (const wt of lru) {
+                   await processManagerService.stopSessionsByWorkDir(wt.path);
+                 }
                  await gitWorktreeService.cleanupWorktrees(lru);
```

#### 3. Stop sessions before manual worktree removal

**File:** `src/main/ipc/index.ts`, line 984–986

```diff
  handle(IPC_CHANNELS.WORKTREE_REMOVE, async (_event, { worktreePath, deleteBranch }) => {
+   await processManagerService.stopSessionsByWorkDir(worktreePath);
    await gitWorktreeService.removeWorktree(worktreePath, deleteBranch);
  });
```

#### 4. Stop sessions before orphan cleanup

**File:** `src/main/services/git-worktree.service.ts`, lines 610–614

The `cleanupOrphans` method is called at app startup and doesn't have access to the
process manager. The calling code should stop sessions first. Alternatively, pass a
cleanup callback:

**File:** `src/main/ipc/index.ts` (wherever `cleanupOrphans` is called):

```diff
+ // Stop sessions for orphan worktrees before removing them
+ const orphanWorktrees = await gitWorktreeService.listCastleWorktrees(workingDirectory);
+ for (const wt of orphanWorktrees) {
+   if (!activeTaskIds.has(path.basename(wt.path))) {
+     await processManagerService.stopSessionsByWorkDir(wt.path);
+   }
+ }
  await gitWorktreeService.cleanupOrphans(workingDirectory, activeTaskIds);
```

#### 5. Add a retry with delay in `removeWorktree` as a safety net

On Windows, even after `SIGTERM`, the process may take a moment to fully exit and
release its cwd handle. Add a brief retry loop:

**File:** `src/main/services/git-worktree.service.ts`, lines 426–437

```diff
    try {
      await gitExec(['worktree', 'remove', worktreePath, '--force'], repoRoot);
      log.info(`Removed worktree: ${worktreePath}`);
    } catch (error) {
      log.warn('Error removing worktree', error);
-     if (fs.existsSync(worktreePath)) {
-       fs.rmSync(worktreePath, { recursive: true, force: true });
-     }
-     try {
-       await gitExec(['worktree', 'prune'], repoRoot);
-     } catch { /* ignore */ }
+     // Retry with delay — process may need time to release cwd handle (Windows)
+     let removed = false;
+     for (let attempt = 0; attempt < 3 && !removed; attempt++) {
+       await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
+       try {
+         if (fs.existsSync(worktreePath)) {
+           fs.rmSync(worktreePath, { recursive: true, force: true });
+         }
+         removed = true;
+       } catch (retryErr) {
+         log.warn(`Retry ${attempt + 1}/3 failed to delete worktree directory`, retryErr);
+       }
+     }
+     try {
+       await gitExec(['worktree', 'prune'], repoRoot);
+     } catch { /* ignore */ }
    }
```

### Verification Steps

1. **Basic cleanup:** Start a task implementation that creates a worktree. Wait for
   it to complete. Trigger another task that hits the worktree limit. Confirm the
   LRU cleanup prompt appears, and clicking "Clean up & continue" successfully
   removes the old worktree and creates the new one.

2. **Active session cleanup:** Start a task that is still in-progress in a worktree.
   Manually trigger worktree removal for that path via the UI. Confirm the session
   is stopped first and the worktree is deleted without permission errors.

3. **Orphan cleanup on startup:** Create a worktree, then delete its task from the
   database (simulating an orphan). Restart the app. Confirm the orphan worktree
   is cleaned up without errors.

4. **Branch deletion:** After successful worktree removal, confirm the associated
   branch is also deleted (no stale `castle/` branches remain).

5. **Non-worktree session unaffected:** While a normal chat session is active for
   an agent (cwd = main project directory), clean up an unrelated worktree. Confirm
   the chat session is not interrupted.

6. **Unix behavior preserved:** On macOS/Linux, confirm the cleanup still works
   as before (the retry loop is harmless on systems where cwd deletion succeeds
   immediately).
