# Additional Tasks for Agent Cancel Working Task — Bug Diagnosis

## Diagnosis and Suggested Fix

### Symptoms

When an agent is already working on a task in a worktree (Task A, running in
branch/cwd A), and a new implementation task (Task B) is assigned to the same agent,
the first task's ACP session is killed. The agent loses all in-progress work for
Task A. The user expects both tasks to run concurrently in separate worktrees.

### Root Cause Analysis

The entire system is built on a **1:1 agent-to-session mapping**. Every layer —
from the session store, to the IPC handlers, to the conversation tracking, to the
renderer — assumes each agent has at most one active session. This assumption
collapses when worktrees enable parallel work.

#### Layer 1 (Primary): `ProcessManagerService.getSessionByAgentId()` returns a single session

**File:** `src/main/services/process-manager.service.ts`, line 632

```typescript
getSessionByAgentId(agentId: string): SessionProcess | undefined {
  for (const sessionProcess of this.sessions.values()) {
    if (sessionProcess.session.agentId === agentId) {
      return sessionProcess;          // ← returns FIRST match only
    }
  }
  return undefined;
}
```

The sessions map is keyed by `sessionId`, but this lookup scans by `agentId` and
returns the first match. When an agent has two sessions (one per worktree), this
method silently ignores the second.

#### Layer 2 (Primary): Implementation handler explicitly kills the existing session

**File:** `src/main/ipc/index.ts`, lines 706–712

```typescript
let sessionProcess = processManagerService.getSessionByAgentId(agentId);
if (sessionProcess && worktreePath) {
  // Existing session was started with a different cwd — kill and recreate
  console.log('[Implementation] Restarting agent session for worktree cwd');
  await processManagerService.stopSession(sessionProcess.session.id);
  sessionProcess = undefined;
}
```

When the implementation handler sees an existing session and a new `worktreePath`, it
**kills the existing session** so it can create a new one with the worktree's cwd.
This is the direct cause of the cancellation. The code assumes "there can only be one
session per agent, so we must replace it."

#### Layer 3: `startSession()` returns early if any session exists for the agent

**File:** `src/main/services/process-manager.service.ts`, lines 82–86

```typescript
async startSession(agent: Agent, workingDirectory: string, ...): Promise<AgentSession> {
  const existingSession = this.getSessionByAgentId(agent.id);
  if (existingSession) {
    return existingSession.session;    // ← refuses to create a second session
  }
  // ...
}
```

Even if the implementation handler didn't kill the first session, `startSession()`
would refuse to create a second one — it returns the existing session immediately.
This means the new task would accidentally share the first task's session and cwd.

#### Layer 4: `activeConversationIds` is keyed by agentId (1:1)

**File:** `src/main/ipc/index.ts`, line 37

```typescript
const activeConversationIds = new Map<string, string>();  // agentId → conversationId
```

When the second task sets `activeConversationIds.set(agentId, conversationId)`, it
**overwrites** the first task's conversation mapping. The first task's completion
handler (in `subscribeToSession`) will then save its messages to the wrong
conversation.

#### Layer 5: `sendMessage()` looks up session by agentId

**File:** `src/main/services/process-manager.service.ts`, line 407

The `sendMessage(sessionId, content)` takes a `sessionId` parameter, so this method
itself is fine. But the callers (chat handler at line 238, research handler at
line 483) all resolve the session via `getSessionByAgentId(agentId)` — which would
return an arbitrary session if multiple exist.

#### Layer 6: Renderer-side assumes one session per agent

The renderer's `AgentService`, `ChatService`, and `AgentWithSession` type all model
a single `session?: AgentSession` per agent. The UI has no concept of multiple
concurrent sessions for one agent.

### Suggested Fix

The fix requires allowing multiple sessions per agent, keyed by a task-scoped
identifier. The minimal change preserves the existing single-session behavior for
chat conversations (which should continue to use one session per agent) while
allowing the implementation handler to create independent additional sessions for
worktree tasks.

#### 1. Allow `startSession()` to create multiple sessions per agent

**File:** `src/main/services/process-manager.service.ts`

Remove the early-return guard and add an optional `taskId` to `SessionProcess` for
disambiguation:

```diff
 interface SessionProcess {
+  taskId?: string;               // Set for implementation sessions
   session: AgentSession;
   // ...
 }
```

```diff
- async startSession(agent: Agent, workingDirectory: string, acpSessionIdToResume?: string): Promise<AgentSession> {
-   const existingSession = this.getSessionByAgentId(agent.id);
-   if (existingSession) {
-     return existingSession.session;
-   }
+ async startSession(agent: Agent, workingDirectory: string, options?: { acpSessionIdToResume?: string; taskId?: string }): Promise<AgentSession> {
+   // For task-scoped sessions, allow multiple per agent.
+   // For general chat, reuse existing session (no taskId).
+   if (!options?.taskId) {
+     const existingSession = this.getSessionByAgentId(agent.id);
+     if (existingSession && !existingSession.taskId) {
+       return existingSession.session;
+     }
+   }
```

Store `taskId` on the new `SessionProcess`:

```diff
     const sessionProcess: SessionProcess = {
+      taskId: options?.taskId,
       session,
       process: childProcess,
       // ...
     };
```

#### 2. Add a task-scoped session lookup

**File:** `src/main/services/process-manager.service.ts`

```typescript
getSessionByTask(agentId: string, taskId: string): SessionProcess | undefined {
  for (const sp of this.sessions.values()) {
    if (sp.session.agentId === agentId && sp.taskId === taskId) {
      return sp;
    }
  }
  return undefined;
}
```

Keep the existing `getSessionByAgentId` but restrict it to non-task sessions (for
chat):

```diff
 getSessionByAgentId(agentId: string): SessionProcess | undefined {
   for (const sessionProcess of this.sessions.values()) {
-    if (sessionProcess.session.agentId === agentId) {
+    if (sessionProcess.session.agentId === agentId && !sessionProcess.taskId) {
       return sessionProcess;
     }
   }
   return undefined;
 }
```

#### 3. Rewrite the implementation handler to create independent sessions

**File:** `src/main/ipc/index.ts`, lines 706–718

Replace the stop-and-recreate logic with a task-scoped session creation:

```diff
-   let sessionProcess = processManagerService.getSessionByAgentId(agentId);
-   if (sessionProcess && worktreePath) {
-     // Existing session was started with a different cwd — kill and recreate
-     console.log('[Implementation] Restarting agent session for worktree cwd');
-     await processManagerService.stopSession(sessionProcess.session.id);
-     sessionProcess = undefined;
-   }
-   if (!sessionProcess) {
-     const session = await processManagerService.startSession(agent, effectiveWorkDir);
-     subscribeToSession(session.id, agentId);
-     sessionProcess = processManagerService.getSessionByAgentId(agentId);
-     if (!sessionProcess) throw new Error('Failed to start implementation agent session');
-   }
+   // Create a task-scoped session so this doesn't interfere with other work
+   let sessionProcess = processManagerService.getSessionByTask(agentId, taskId);
+   if (!sessionProcess) {
+     const session = await processManagerService.startSession(agent, effectiveWorkDir, { taskId });
+     subscribeToSession(session.id, agentId);
+     sessionProcess = processManagerService.getSessionByTask(agentId, taskId);
+     if (!sessionProcess) throw new Error('Failed to start implementation agent session');
+   }
```

#### 4. Use session-scoped conversation tracking instead of agent-scoped

**File:** `src/main/ipc/index.ts`

Replace the `activeConversationIds` Map with a **session-scoped** map:

```diff
-const activeConversationIds = new Map<string, string>();  // agentId → conversationId
+const activeConversationIds = new Map<string, string>();  // sessionId → conversationId
```

Then update all callers to use `sessionId` as the key instead of `agentId`:
- `subscribeToSession`: use `sessionId` to look up `conversationId`
- Chat handler: set by `sessionProcess.session.id`
- Research handler: set by `sessionProcess.session.id`
- Implementation handler: set by `sessionProcess.session.id`

This ensures each session's completion handler saves messages to the correct
conversation regardless of how many sessions the agent has.

#### 5. Update `cancelMessage()` to accept sessionId

**File:** `src/main/services/process-manager.service.ts`

The current `cancelMessage(agentId)` cancels by agent, which would be ambiguous with
multiple sessions. Change it to cancel by `sessionId`:

```diff
-async cancelMessage(agentId: string): Promise<void> {
-  const sessionProcess = this.getSessionByAgentId(agentId);
+async cancelMessage(sessionId: string): Promise<void> {
+  const sessionProcess = this.sessions.get(sessionId);
   if (!sessionProcess) return;
   // ... rest unchanged
```

Update the IPC caller to resolve the appropriate session first.

### What does NOT need to change

- **Chat handler** (`CHAT_SEND_MESSAGE`): The chat view still uses one session per
  agent via the existing `getSessionByAgentId()` (which now excludes task sessions).
  No change needed.
- **Research handler** (`TASKS_RUN_RESEARCH`): Research uses the agent's main session
  in the main cwd. This is fine as-is — research doesn't create worktrees.
- **Renderer**: The renderer UI doesn't need to track multiple sessions. Implementation
  tasks already have their own lifecycle tracking (`WORKTREE_LIFECYCLE` events). The
  single-session chat view continues to show the agent's main chat session.

### Verification Steps

1. **Concurrent tasks:** Assign two implementation tasks to the same agent. Verify both
   tasks run to completion simultaneously in separate worktrees without either being
   cancelled.
2. **Chat while implementing:** While an agent is working on an implementation task,
   send a chat message to the same agent. Verify the chat works independently and the
   implementation continues.
3. **Task completion:** Verify that when each implementation task completes, its commit
   and PR are created from the correct worktree/branch (not cross-contaminated).
4. **Conversation integrity:** Verify that each task's messages are saved to the correct
   conversation (not mixed with another task's messages).
5. **Cancel single task:** Cancel one implementation task. Verify the other task
   continues running unaffected.
6. **Research while implementing:** Start a research task on an agent that is also
   implementing. Verify both run without interference.
7. **Session cleanup:** After all tasks complete, verify there are no orphaned sessions
   lingering in the process manager.
