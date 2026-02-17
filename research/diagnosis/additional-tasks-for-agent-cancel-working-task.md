# Additional Tasks for Agent Cancel Working Task — Bug Diagnosis

## Diagnosis and Suggested Fix

### Symptoms

After the initial fix in commit `497c482`, agents can now technically have multiple
ACP sessions (one per worktree). However, the following problems remain:

1. **Conversation A's output appears in Conversation B's chat.** When Task B starts,
   its streaming output is shown in the UI as belonging to Conversation A, and
   Conversation B (which was created for Task B) never receives its intended work.

2. **Task A appears to be cancelled.** Although Task A's session is no longer killed,
   its streaming state in the renderer is overwritten when Task B starts, making it
   look cancelled from the user's perspective.

3. **Task B's work never actually starts in its conversation.** The prompt is sent to
   the correct session, but completion events save messages to the wrong conversation.

### Root Cause Analysis

The initial fix (commit `497c482`) correctly addressed session creation — multiple
sessions per agent can now coexist. However, **three shared-state systems still use
agentId as their sole key**, creating collisions when two sessions exist for the same
agent:

#### Problem 1: `activeConversationIds` is keyed by `agentId` — last write wins

**File:** `src/main/ipc/index.ts`, line 40

```typescript
const activeConversationIds = new Map<string, string>();  // agentId → conversationId
```

**Collision sequence:**

| Time | Event | `activeConversationIds[agentA]` |
|------|-------|-------------------------------|
| T1 | Task A starts, sets conversation A | `conv-A` |
| T2 | Task B starts, sets conversation B | `conv-B` ← **overwrites** |
| T3 | Task A completes, reads `activeConversationIds.get(agentId)` | gets `conv-B` ← **wrong!** |

**Line 787** (implementation handler):
```typescript
activeConversationIds.set(agentId, conversationId);  // Task B overwrites Task A
```

**Line 170** (subscribeToSession completion handler):
```typescript
const conversationId = activeConversationIds.get(agentId);  // Task A reads Task B's ID
```

This causes Task A's completion messages to be saved to Conversation B's ID, and
Task B's conversation to appear to contain Task A's output.

#### Problem 2: `subscribeToSession` completion handler uses shared conversation lookup

**File:** `src/main/ipc/index.ts`, lines 167–189

```typescript
processManagerService.onComplete(sessionId, async (message) => {
  const conversationId = activeConversationIds.get(agentId);  // ← agent-scoped, not session-scoped
  // ... saves message to whichever conversation was last set for this agent
});
```

Even though each session has its own `onComplete` listener (keyed by `sessionId`),
the **closure captures `agentId`** and looks up the conversation at completion time.
By then, the map has been overwritten by the second task.

#### Problem 3: `SYNC_STREAMING_STARTED` broadcast clobbers renderer state

**File:** `src/main/ipc/index.ts`, line 859

```typescript
broadcaster.send(IPC_CHANNELS.SYNC_STREAMING_STARTED, { agentId, conversationId });
```

**Renderer:** `src/app/core/services/chat.service.ts`, line 169–171

```typescript
this.electronService.streamingStarted$.subscribe(({ agentId, conversationId }) => {
  this.setStreamingConversationId(agentId, conversationId ?? null);
  this.setLoading(agentId, true);
});
```

The renderer's `ChatService` stores streaming state **per agent** (`ChatState` is
keyed by `agentId` in `chatStatesSignal`). When Task B fires
`SYNC_STREAMING_STARTED`, it overwrites the `streamingConversationId` for that agent,
which controls which conversation shows the streaming bubble. This makes Task A's
streaming content disappear from its conversation and appear in Task B's.

#### Problem 4: `CHAT_STREAM_CHUNK` broadcasts use agentId with no session discrimination

**File:** `src/main/ipc/index.ts`, line 163–164

```typescript
processManagerService.onOutput(sessionId, (message) => {
  broadcaster.send(IPC_CHANNELS.CHAT_STREAM_CHUNK, message);
});
```

The `StreamingMessage` contains `agentId` but no `conversationId` or `sessionId`.
The renderer receives chunks from **both** sessions and applies them all to the
single `streamingMessage` slot for that agent — they interleave and overwrite
each other.

#### Problem 5: `respondToPermission` and `getAcpSessionId` use first-match lookup

**File:** `src/main/services/process-manager.service.ts`, lines 534–537

```typescript
respondToPermission(agentId: string, ...): void {
  const sessionProcess = this.getSessionByAgentId(agentId);  // no workDir filter
```

Without a `workingDirectory` parameter, `getSessionByAgentId` returns the first
session found for that agent. Permission responses may be routed to the wrong
session.

### Suggested Fix

The core issue is that **conversation routing must be scoped by session, not agent**.
The `activeConversationIds` map and all event broadcasting need to carry a session
identifier so the correct conversation receives each session's output.

#### 1. Re-key `activeConversationIds` by sessionId

**File:** `src/main/ipc/index.ts`

```diff
-// Track active conversationId per agent for associating assistant replies
-const activeConversationIds = new Map<string, string>();
+// Track active conversationId per session for associating assistant replies
+const activeConversationIds = new Map<string, string>();  // sessionId → conversationId
```

#### 2. Update `subscribeToSession` to use sessionId for conversation lookup

The completion handler already receives `sessionId` as a closure parameter — use it:

```diff
  function subscribeToSession(sessionId: string, agentId: string): void {
    // ...
    processManagerService.onComplete(sessionId, async (message) => {
-     const conversationId = activeConversationIds.get(agentId);
+     const conversationId = activeConversationIds.get(sessionId);
      // ... rest unchanged
    });

    // ...
    processManagerService.onTitleUpdate(sessionId, async ({ title }) => {
-     const conversationId = activeConversationIds.get(agentId);
+     const conversationId = activeConversationIds.get(sessionId);
      // ...
    });

-   const acpId = processManagerService.getAcpSessionId(agentId);
+   const acpId = processManagerService.getAcpSessionId(sessionId);
    if (acpId) {
-     const conversationId = activeConversationIds.get(agentId);
+     const conversationId = activeConversationIds.get(sessionId);
      // ...
    }
  }
```

#### 3. Update all callers to set conversation by sessionId

**Chat handler** (`CHAT_SEND_MESSAGE`, line 246):

```diff
    if (conversationId) {
-     activeConversationIds.set(agentId, conversationId);
+     activeConversationIds.set(sessionProcess.session.id, conversationId);
    } else {
-     activeConversationIds.delete(agentId);
+     activeConversationIds.delete(sessionProcess.session.id);
    }
```

Note: the session lookup happens before the message is sent, so move the
`activeConversationIds.set()` call to **after** session resolution (after line 287).

**Implementation handler** (`TASKS_RUN_IMPLEMENTATION`, line 786):

```diff
    if (conversationId) {
-     activeConversationIds.set(agentId, conversationId);
+     activeConversationIds.set(sessionProcess.session.id, conversationId);
    }
```

**Research handler** (`TASKS_RUN_RESEARCH`) — apply the same pattern.

**Research review handler** (`TASKS_SUBMIT_RESEARCH_REVIEW`) — apply the same pattern.

#### 4. Include `conversationId` in `CHAT_STREAM_CHUNK` messages

The `StreamingMessage` already flows from the session through `onOutput`. Tag it
with the conversation before broadcasting:

```diff
  processManagerService.onOutput(sessionId, (message) => {
+   // Tag streaming chunks with their target conversation
+   const conversationId = activeConversationIds.get(sessionId);
+   if (conversationId) {
+     (message as any).conversationId = conversationId;
+   }
    broadcaster.send(IPC_CHANNELS.CHAT_STREAM_CHUNK, message);
  });
```

Then update the `StreamingMessage` type to include an optional `conversationId`:

**File:** `src/shared/types/message.types.ts`

```diff
 export interface StreamingMessage {
   id: string;
   agentId: string;
+  conversationId?: string;
   content: string;
   // ...
 }
```

#### 5. Update the renderer to use conversationId for stream routing

**File:** `src/app/core/services/chat.service.ts`

The renderer should use `conversationId` from the streaming chunk to determine which
conversation's state to update, rather than blindly using `agentId`:

```diff
  this.electronService.streamChunk$.subscribe((chunk: StreamingMessage) => {
-   this.updateStreamingMessage(chunk.agentId, chunk);
+   // Only apply streaming chunks to the currently viewed conversation
+   const state = this.currentChatState();
+   if (chunk.conversationId && state?.streamingConversationId
+       && chunk.conversationId !== state.streamingConversationId) {
+     return; // chunk belongs to a different conversation for this agent
+   }
+   this.updateStreamingMessage(chunk.agentId, chunk);
```

#### 6. Fix `respondToPermission` to route by sessionId

**File:** `src/main/services/process-manager.service.ts`

Change `respondToPermission` to accept a `sessionId` (or look up by the permission
`requestId` which is tied to a specific session's event emitter). The simplest fix:
broadcast the permission response to **all** sessions for the agent, since only the
one that emitted the request will have a listener for that `requestId`:

```diff
  respondToPermission(agentId: string, requestId: string, optionId: string): void {
-   const sessionProcess = this.getSessionByAgentId(agentId);
-   if (sessionProcess) {
-     sessionProcess.eventEmitter.emit('permissionResponse', { requestId, optionId });
+   // Broadcast to all sessions for this agent — only the requesting one
+   // will have a listener waiting for this specific requestId.
+   for (const sp of this.sessions.values()) {
+     if (sp.session.agentId === agentId) {
+       sp.eventEmitter.emit('permissionResponse', { requestId, optionId });
+     }
    }
  }
```

### Verification Steps

1. **Concurrent tasks:** Assign Task A and Task B to the same agent with worktrees
   enabled. Verify both run to completion, each in their own conversation, without
   interfering.

2. **Correct conversation routing:** While both tasks stream, open each conversation.
   Verify each shows only its own task's output (no interleaving).

3. **Completion saves to correct conversation:** After both tasks complete, check
   the database. Verify each assistant message is saved with the correct
   `conversationId`.

4. **Permission routing:** If both sessions request permissions simultaneously,
   verify each permission response reaches the correct session.

5. **Chat while implementing:** Send a manual chat message while an implementation
   task is running. Verify the chat uses its own session and conversation, and the
   implementation continues unaffected.

6. **Single-task regression:** Run a single implementation task. Verify it works
   exactly as before (no regression from the session-scoped conversation changes).
