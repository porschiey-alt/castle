# Worktree Cleanup Fails — Bug Diagnosis

## Diagnosis and Suggested Fix

### Symptoms

When the user confirms LRU worktree cleanup (triggered by hitting the max-concurrent
worktree limit), the operation fails with:

```
error: failed to delete '.castle-worktrees/<uuid>': Permission denied
```

This happens on **both** `git worktree remove --force` (line 469 of
`git-worktree.service.ts`) **and** the `forceRemoveDirectory()` fallback (line 474),
which was added in commit `7903dbc` specifically to handle this case.

The retry logic in `forceRemoveDirectory()` retries 3 times with increasing delays
(500ms, 1000ms, 1500ms), but the lock holder never releases, so all retries fail.
The branch deletion then also fails because the worktree reference still exists.

### Root Cause Analysis

**The Copilot CLI child process holds an OS-level lock on the worktree directory.**

When a worktree task is run, `ProcessManagerService.startSession()` spawns a Copilot
CLI child process with `cwd: workingDirectory` (line 113–114 of
`process-manager.service.ts`):

```typescript
const childProcess = spawn('copilot', args, {
  cwd: workingDirectory,   // ← this IS the worktree directory
  shell: true,
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe']
});
```

On Windows, a running process's **current working directory is locked by the OS** —
no other process can delete, rename, or move that directory while the process is
alive. This is a fundamental Windows filesystem behavior that no amount of retries,
`chmod`, or `--force` flags can overcome.

**Why commit `7903dbc` didn't fix it:**

The fix in `7903dbc` added `forceRemoveDirectory()` which:
1. Recursively clears read-only flags (`makeWritableRecursive`)
2. Uses `fs.rmSync` with `maxRetries` and `retryDelay`
3. Retries the full operation up to 3 times

This correctly handles **read-only files** (like `.git` internals), but that's not
the problem here. The problem is a **process-level directory lock**. No filesystem
operation can remove a directory that is the cwd of a running process on Windows.
The fix addressed a different failure mode than the one actually occurring.

**The lifecycle gap:**

The cleanup flow at line 724–725 of `ipc/index.ts` is:

```typescript
if (confirmed) {
  await gitWorktreeService.cleanupWorktrees(lru);  // ← attempts to delete directory
  // ...
}
```

There is **no call to stop the session** whose `workingDirectory` matches the
worktree being cleaned up. The session (and its child process) remains alive
throughout the cleanup attempt. The session's Copilot CLI child process:
- Was spawned with `cwd` = the worktree path
- May have status `ready` (idle) but is **still a running OS process**
- Holds the Windows directory lock until killed

Even after the task completes (agent status becomes `ready`), the Copilot CLI child
process stays alive waiting for more prompts — it's designed to be reused for
subsequent messages. It's never terminated unless explicitly stopped via
`processManagerService.stopSession()`.

### Suggested Fix

**Stop all sessions whose working directory matches the worktree being removed,
then proceed with cleanup.**

#### 1. Add `stopSessionsByWorkDir()` to `ProcessManagerService`

**File:** `src/main/services/process-manager.service.ts`

Add a new method after `stopSession()` (around line 632):

```typescript
/**
 * Stop all sessions whose working directory matches the given path.
 * Used before deleting worktree directories to release OS file locks.
 */
async stopSessionsByWorkDir(workingDirectory: string): Promise<void> {
  const normalizedTarget = path.normalize(workingDirectory);
  const toStop: string[] = [];

  for (const [sessionId, sp] of this.sessions) {
    if (path.normalize(sp.session.workingDirectory) === normalizedTarget) {
      toStop.push(sessionId);
    }
  }

  for (const sessionId of toStop) {
    await this.stopSession(sessionId);
  }

  if (toStop.length > 0) {
    log.info(`Stopped ${toStop.length} session(s) using workDir: ${workingDirectory}`);
  }
}
```

This requires adding `import * as path from 'path';` at the top of
`process-manager.service.ts` if not already present.

#### 2. Call `stopSessionsByWorkDir()` before cleanup in `ipc/index.ts`

**File:** `src/main/ipc/index.ts`, line 724–725

```diff
              if (confirmed) {
+               // Stop sessions whose cwd is inside the worktrees being removed,
+               // so that their child processes release the Windows directory lock.
+               for (const wt of lru) {
+                 await processManagerService.stopSessionsByWorkDir(wt.path);
+               }
                await gitWorktreeService.cleanupWorktrees(lru);
                worktreeResult = await gitWorktreeService.createWorktree(workingDirectory, task.title, taskId, task.kind, baseBranch);
              }
```

#### 3. Add a brief delay after stopping sessions

On Windows, after `SIGTERM` is sent, the process may take a moment to fully exit and
release the directory lock. Add a small delay after stopping sessions:

**File:** `src/main/ipc/index.ts` (same location)

```diff
              if (confirmed) {
                for (const wt of lru) {
                  await processManagerService.stopSessionsByWorkDir(wt.path);
                }
+               // Give Windows a moment to release directory locks after process termination
+               await new Promise(resolve => setTimeout(resolve, 500));
                await gitWorktreeService.cleanupWorktrees(lru);
```

#### 4. Also stop sessions in `removeWorktree` as a defensive measure

For any other code path that calls `removeWorktree` directly (e.g., `WORKTREE_REMOVE`
IPC handler at line 1002–1003, or `cleanupOrphans`), the worktree service should
accept an optional session-stopper callback:

**File:** `src/main/services/git-worktree.service.ts`

```diff
- async removeWorktree(worktreePath: string, deleteBranch = false): Promise<void> {
+ async removeWorktree(
+   worktreePath: string,
+   deleteBranch = false,
+   onBeforeRemove?: (worktreePath: string) => Promise<void>
+ ): Promise<void> {
    if (!fs.existsSync(worktreePath)) {
      log.info(`Worktree does not exist: ${worktreePath}`);
      return;
    }
+
+   // Allow caller to release locks (e.g., stop child processes using this dir)
+   if (onBeforeRemove) {
+     await onBeforeRemove(worktreePath);
+     // Brief delay for OS to release directory locks
+     await new Promise(resolve => setTimeout(resolve, 500));
+   }
```

Then callers can pass:

```typescript
await gitWorktreeService.removeWorktree(wt.path, true, async (wtPath) => {
  await processManagerService.stopSessionsByWorkDir(wtPath);
});
```

#### 5. Improve `forceRemoveDirectory` error reporting

Currently the function silently fails after 3 retries. It should throw on final
failure so the caller knows cleanup didn't succeed:

**File:** `src/main/services/git-worktree.service.ts`, line 170–172

```diff
      } else {
        log.warn(`forceRemoveDirectory failed after ${MAX_RETRIES} attempts`, error);
+       throw error;  // Let caller know cleanup failed
      }
```

### Verification Steps

1. **Reproduce:** Create a worktree task, let it complete (agent becomes `ready`).
   Hit the worktree limit by creating more tasks. Confirm LRU cleanup. Verify it now
   succeeds without `Permission denied`.

2. **Process check:** Before cleanup, verify the child process is alive via Task
   Manager. After `stopSessionsByWorkDir`, verify it's gone.

3. **Multiple sessions:** If the same worktree has multiple sessions (shouldn't
   normally happen, but defensively), verify all are stopped.

4. **Race condition:** Verify the 500ms delay is sufficient. On slow machines or
   under heavy I/O, the process may take longer to exit. The existing retry logic
   in `forceRemoveDirectory` provides additional resilience.

5. **Orphan cleanup:** Test `cleanupOrphans()` (called on app startup) — these
   worktrees may not have active sessions (they exited with the app), so they should
   already be deletable. Verify no regression.

6. **Linux/macOS:** On Unix, cwd locking doesn't apply. Verify the fix doesn't
   introduce unnecessary delays or failures on those platforms. The
   `stopSessionsByWorkDir` call is harmless (just stops sessions that won't be
   needed), and the 500ms delay is negligible.
