# Worktree Cleanup Fails — Permission Denied on Windows

## Diagnosis and Suggested Fix

### Symptoms

When Castle attempts to remove a git worktree (during LRU cleanup, manual removal, or orphan cleanup), the operation fails with:

```
error: failed to delete 'C:/source/castle/.castle-worktrees/<uuid>': Permission denied
```

This occurs on **Windows only**. Two prior fix attempts were made:
- **Commit `7903dbc`**: Added `forceRemoveDirectory()` with `makeWritableRecursive()` and retries as a fallback when `git worktree remove --force` fails.
- **Commit `9a6e774`** (PR #13): Added `stopSessionsByWorkDir()` to kill Copilot CLI child processes whose `cwd` is inside the worktree before attempting removal, plus retry delays.

Despite both fixes, the error persists.

### Root Cause Analysis

There are **two distinct problems**, one of which remains unresolved:

#### Problem 1: `stopSession()` sends SIGTERM but doesn't wait for process exit (UNRESOLVED — PRIMARY CAUSE)

**File:** `src/main/services/process-manager.service.ts`, lines 641–652

```typescript
async stopSession(sessionId: string): Promise<void> {
    const sessionProcess = this.sessions.get(sessionId);
    if (!sessionProcess) return;
    if (sessionProcess.process.pid) {
      sessionProcess.process.kill('SIGTERM');   // ← fires signal, returns immediately
    }
    this.sessions.delete(sessionId);            // ← removes from map, doesn't wait for exit
}
```

`process.kill('SIGTERM')` is **asynchronous** — it sends the signal and returns immediately. The process hasn't actually exited yet when `stopSession()` resolves. The calling code in `stopSessionsByWorkDir()` awaits `stopSession()`, but since `stopSession()` resolves instantly (it never waits for the `'exit'` event), the worktree removal begins while the child process is still alive and holding the directory handle as its cwd.

The retry delays (1s, 2s, 3s) in `removeWorktree` help probabilistically, but the process may take longer to die, especially if:
- The Copilot CLI is in the middle of an operation
- Sub-processes spawned by the CLI agent are still running (e.g., tool calls running `npm`, `node`, `git` commands in the worktree directory)

#### Problem 2: `shell: true` on Windows creates a process tree — SIGTERM only kills the shell (UNRESOLVED — SECONDARY CAUSE)

**File:** `src/main/services/process-manager.service.ts`, lines 117–122

```typescript
const childProcess = spawn('copilot', args, {
    cwd: workingDirectory,
    shell: true,           // ← on Windows, spawns cmd.exe → copilot.exe
    ...
});
```

On Windows, `spawn(..., { shell: true })` creates `cmd.exe` which then launches `copilot.exe`. When `process.kill('SIGTERM')` is called:
- **On POSIX**: `SIGTERM` is sent to the process, which can forward it to children.
- **On Windows**: Node.js translates `SIGTERM` to a `TerminateProcess` call on the direct child PID only (`cmd.exe`). This does **not** kill the `copilot` process or any of its sub-processes (tool calls running `git`, `node`, etc.). Those orphaned processes continue to hold cwd handles on the worktree directory.

Furthermore, the Copilot CLI itself may spawn sub-processes (tool calls) that set their cwd to the worktree. These grandchild+ processes are never tracked or killed by `ProcessManagerService`.

#### Why the retries still fail

The `forceRemoveDirectory` retry logic (3 attempts × 500ms) and the `removeWorktree` retry logic (3 attempts × 1/2/3 seconds) both race against process cleanup. On Windows, orphaned `copilot.exe` and its child processes may hold directory handles for much longer than the total ~6 seconds of retry time, making the deletion fail consistently.

### Suggested Fix

#### Fix 1: Wait for process exit after sending kill signal

**File:** `src/main/services/process-manager.service.ts`

Replace the `stopSession` method to actually wait for the process to exit:

```typescript
async stopSession(sessionId: string): Promise<void> {
    const sessionProcess = this.sessions.get(sessionId);
    if (!sessionProcess) return;

    log.info(`Stopping session ${sessionId} for agent ${sessionProcess.session.agentId}`);

    const proc = sessionProcess.process;
    this.sessions.delete(sessionId);

    if (!proc.pid || proc.exitCode !== null) return;

    // Wait for process to actually exit (with timeout)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // If still alive after 5s, force-kill
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        resolve();
      }, 5000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      // Kill the entire process tree on Windows, plain SIGTERM on POSIX
      if (process.platform === 'win32') {
        try {
          // taskkill /T /F kills the entire process tree
          const { execSync } = require('child_process');
          execSync(`taskkill /PID ${proc.pid} /T /F`, {
            stdio: 'ignore',
            timeout: 5000,
          });
        } catch {
          // Process may already be dead
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      } else {
        proc.kill('SIGTERM');
      }
    });
  }
```

Key changes:
1. **Waits for the `'exit'` event** before resolving, so callers know the process is truly dead.
2. **Uses `taskkill /T /F /PID`** on Windows to kill the entire process tree (cmd.exe → copilot.exe → any sub-processes).
3. **Has a 5-second timeout** with a `SIGKILL` fallback to prevent indefinite hanging.

#### Fix 2: Add a grace period in `stopSessionsByWorkDir`

Even after the process tree is killed, Windows may take a moment to release file handles. Add a small delay after stopping sessions:

**File:** `src/main/services/process-manager.service.ts`

```typescript
async stopSessionsByWorkDir(workDirPrefix: string): Promise<void> {
    const normalized = path.normalize(workDirPrefix);
    let stoppedAny = false;
    for (const [sessionId, sp] of this.sessions) {
      if (path.normalize(sp.session.workingDirectory).startsWith(normalized)) {
        log.info(`Stopping session ${sessionId} (cwd: ${sp.session.workingDirectory}) before worktree removal`);
        await this.stopSession(sessionId);
        stoppedAny = true;
      }
    }
    // Give Windows time to release directory handles after process tree death
    if (stoppedAny && process.platform === 'win32') {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
```

#### Fix 3 (Defensive): Improve `forceRemoveDirectory` to also kill processes with open handles

As a last resort, if the directory still can't be deleted, use a Windows-specific approach to find and kill processes with open handles in the directory. This is the "nuclear option" and should only be needed if Fixes 1 and 2 aren't sufficient:

**File:** `src/main/services/git-worktree.service.ts`

Add before the `forceRemoveDirectory` retry loop in `removeWorktree`:

```typescript
// On Windows, kill any remaining processes whose cwd is inside the worktree
if (process.platform === 'win32') {
  try {
    const { execSync } = require('child_process');
    // Find and kill processes with cwd inside the worktree path
    // Use PowerShell to find processes with matching working directories
    const normalizedPath = worktreePath.replace(/\//g, '\\');
    const cmd = `Get-Process | Where-Object { try { $_.Path -and (Resolve-Path $_.Path -ErrorAction SilentlyContinue) } catch { $false } } | ForEach-Object { try { $cwd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine; if ($cwd -like '*${normalizedPath}*') { Stop-Process -Id $_.Id -Force } } catch {} }`;
    execSync(`powershell -NoProfile -Command "${cmd}"`, { stdio: 'ignore', timeout: 10000 });
  } catch { /* best-effort */ }
}
```

However, **Fixes 1 and 2 should be sufficient** in the vast majority of cases. Fix 3 is documented here only as an escalation path if needed.

### Verification Steps

1. **Create a worktree-based task** so a Copilot CLI session is running with `cwd` set to the worktree.
2. **While the session is active**, trigger LRU cleanup (or manually remove the worktree).
3. **Verify** that:
   - The log shows `Stopping session ... before worktree removal`
   - On Windows, the log should show the `taskkill` path being used
   - The process exits (log: `Agent ... process exited: code=...`)
   - **After** the exit event, the worktree removal proceeds
   - The worktree directory is successfully deleted
   - The branch is successfully deleted
4. **Check for orphaned processes**: After cleanup, run `tasklist | findstr copilot` to verify no orphaned Copilot CLI processes remain.
5. **Test the timeout path**: Start a task, send a long-running prompt, then immediately trigger cleanup. Verify the 5-second SIGKILL timeout fires and the worktree is still cleaned up.
6. **Test on POSIX** (if applicable): Verify the non-Windows path still uses SIGTERM and doesn't regress.
7. **Test orphan cleanup on startup**: Restart the app with stale worktrees on disk; verify `cleanupOrphans` succeeds even when no sessions are tracked in `ProcessManagerService` (handles may be held by processes from a previous app launch — the `forceRemoveDirectory` retry should handle this since there are no sessions to stop).
