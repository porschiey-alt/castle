# Research: Implement Tab — Mark as Done

## Executive Summary

The Implementation tab in the task detail view currently has two states: an "empty" state with an agent picker and "Start Implementation" button, and an "in progress" spinner with a link to the agent. **There is no "completed" state.** Once the agent finishes implementing, the `implementRunning` flag is cleared immediately after the message is sent (not after the agent completes), the tab reverts to its empty state, and nothing records the outcome. The task state is never changed to "done."

This document analyzes the full implementation pipeline and proposes a design for a post-implementation "done" flow with revision support.

---

## Current Architecture Analysis

### Implementation Flow (As-Is)

```
User clicks "Start Implementation"
        │
        ▼
TaskDetailComponent.startImplementation()
  emits implementRequested { task, agentId }
        │
        ▼
TaskListComponent.onImplementRequested()
  1. taskService.markImplementRunning(task.id)
  2. goToAgent.emit(agentId)           ← switches to chat view
  3. electronService.sendMessage(agentId, prompt)  ← fire-and-forget
  4. taskService.clearImplementRunning(task.id)     ← IMMEDIATELY clears
        │
        ▼
  User is now in chat view watching the agent work.
  Implementation tab has no awareness of when the agent finishes.
  Task state remains unchanged.
```

### Key Problems

1. **`clearImplementRunning` is called immediately** after `sendMessage`, not after the agent completes. The spinner disappears instantly, unlike research which uses `streamComplete$` events to detect completion.

2. **No completion detection** — Research uses `CHAT_STREAM_COMPLETE` with the `taskId` as the message `id` so `TaskService.streamComplete$` can match it. Implementation has no equivalent; it sends a chat message like any other, and the completion event uses the message's own ID, which is unrelated to the task.

3. **No "done" state transition** — The task state is never automatically changed after implementation.

4. **No implementation result capture** — The agent's response (success, partial, or failure) is not stored on the task.

5. **No revision flow** — There is no way to request changes from the implementing agent with task context.

6. **`goToImplementer` emits `task.researchAgentId`** (line 298 of task-detail.component.html) instead of the implementation agent ID. This is a bug — it navigates to the research agent, not the implementing agent.

### Comparison with Research Flow

| Aspect | Research Flow | Implementation Flow |
|--------|--------------|---------------------|
| Prompt sent via | `processManagerService.sendMessage()` in IPC handler | `electronService.sendMessage()` in renderer |
| Completion detection | `onComplete` callback in IPC → sends `CHAT_STREAM_COMPLETE` with `id: taskId` | None |
| Running state cleared | On `streamComplete$` matching taskId | Immediately after `sendMessage` |
| Result stored | File on disk + hydrated into `task.researchContent` | Not stored |
| Agent ID stored | `task.researchAgentId` | Not stored |
| Revision flow | Research review comments → revision prompt → updated file | None |
| State transition | None (manual) | None |

### Relevant Code Locations

| File | Lines | What |
|------|-------|------|
| `src/app/features/tasks/task-detail/task-detail.component.html` | 283–352 | Implementation tab template |
| `src/app/features/tasks/task-detail/task-detail.component.ts` | 256–263 | `startImplementation()` method |
| `src/app/features/tasks/task-list/task-list.component.ts` | 147–163 | `onImplementRequested()` — sends prompt, clears running immediately |
| `src/app/core/services/task.service.ts` | 25, 79, 91–96 | `implementRunningIds` signal management |
| `src/shared/types/task.types.ts` | 1–89 | Task type (no `implementAgentId` field) |
| `src/main/ipc/index.ts` | 279–298 | `TASKS_UPDATE` handler (already handles done→cleanup for bugs) |

---

## Proposed Approach

### Overview

The implementation flow should mirror the research flow's architecture: the prompt should be sent from the **main process** IPC handler (not the renderer), completion should be detected via `onComplete` callbacks, and the result should be stored and communicated back to the renderer.

### Phase 1: Track Implementation Agent & Detect Completion

#### 1.1 Add `implementAgentId` to Task Type

**`src/shared/types/task.types.ts`**
```typescript
export interface Task {
  // ...existing fields...
  implementAgentId?: string;   // NEW: Agent that implemented this task
}

export type UpdateTaskInput = Partial<Pick<Task, 
  'title' | 'description' | 'state' | 'kind' | 
  'researchContent' | 'researchAgentId' | 
  'implementAgentId' |    // NEW
  'closeReason'
>> & {
  labelIds?: string[];
};
```

#### 1.2 Add Database Column

**`src/main/services/database.service.ts`** — Add migration:
```sql
ALTER TABLE tasks ADD COLUMN implement_agent_id TEXT;
```

Update `getTask()`, `getTasks()`, `updateTask()` to read/write `implement_agent_id`.

#### 1.3 New IPC Channel: `TASKS_RUN_IMPLEMENTATION`

**`src/shared/types/ipc.types.ts`**
```typescript
TASKS_RUN_IMPLEMENTATION: 'tasks:runImplementation',
```

This mirrors `TASKS_RUN_RESEARCH`. The handler will:
1. Get the task and agent from the database
2. Ensure the agent has a session
3. Build the implementation prompt (same as current renderer logic)
4. Send the prompt via `processManagerService.sendMessage()`
5. Register an `onComplete` callback
6. On completion: update task state to `done`, send `CHAT_STREAM_COMPLETE` with `id: taskId`

#### 1.4 IPC Handler Implementation

**`src/main/ipc/index.ts`** — New handler:
```typescript
ipcMain.handle(IPC_CHANNELS.TASKS_RUN_IMPLEMENTATION, async (_event, { taskId, agentId }) => {
  const task = await databaseService.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  let agent = discoveredAgents.get(agentId) || await databaseService.getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const workingDirectory = directoryService.getCurrentDirectory();
  if (!workingDirectory) throw new Error('No workspace directory selected');

  // Ensure agent has a session
  let sessionProcess = processManagerService.getSessionByAgentId(agentId);
  if (!sessionProcess) {
    const session = await processManagerService.startSession(agent, workingDirectory);
    subscribeToSession(session.id, agentId);
    sessionProcess = processManagerService.getSessionByAgentId(agentId);
    if (!sessionProcess) throw new Error('Failed to start agent session');
  }

  // Build implementation prompt
  let prompt = `Implement the following task:\n\nTitle: ${task.title}\n\nDescription:\n${task.description || '(none)'}`;
  if (task.researchContent) {
    prompt += `\n\nResearch Analysis:\n${task.researchContent}`;
  }
  prompt += `\n\nPlease implement the changes described above.`;

  // Save implementAgentId
  await databaseService.updateTask(taskId, { implementAgentId: agentId });

  // Listen for completion
  const unsubscribe = processManagerService.onComplete(sessionProcess.session.id, async (message) => {
    unsubscribe();
    
    // Auto-transition task to done
    await databaseService.updateTask(taskId, { state: 'done' });
    
    // Notify renderer
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_STREAM_COMPLETE, {
      id: taskId,
      agentId,
      role: 'assistant',
      content: message.content,
      timestamp: new Date(),
    });
  });

  // Send prompt
  processManagerService.sendMessage(sessionProcess.session.id, prompt).catch((error) => {
    console.error('[Implementation] Error:', error);
    mainWindow.webContents.send(IPC_CHANNELS.APP_ERROR, { agentId, error: String(error) });
  });

  return { taskId };
});
```

#### 1.5 Wire Up Preload, ElectronService, TaskService

Follow the same pattern as `runResearch`:

- **Preload**: Add `runImplementation(taskId, agentId)` to the `tasks` API
- **ElectronService**: Add `runTaskImplementation(taskId, agentId)` method
- **TaskService**: Add `runImplementation(taskId, agentId)` method that calls the electron service and updates the local task signal

#### 1.6 Update TaskService Completion Detection

In the `streamComplete$` subscription in `TaskService.constructor()`:
```typescript
this.electronService.streamComplete$.subscribe(async (msg) => {
  // Research completion
  if (this.researchRunningIds().has(msg.id)) {
    this.researchRunningIds.update(s => { const n = new Set(s); n.delete(msg.id); return n; });
    await this.refreshTask(msg.id);
  }
  // Implementation completion — NEW
  if (this.implementRunningIds().has(msg.id)) {
    this.implementRunningIds.update(s => { const n = new Set(s); n.delete(msg.id); return n; });
    await this.refreshTask(msg.id);  // Will pull updated state='done'
  }
  // Review completion
  if (this.reviewRunningIds().has(msg.id)) {
    this.reviewRunningIds.update(s => { const n = new Set(s); n.delete(msg.id); return n; });
    await this.refreshTask(msg.id);
  }
});
```

#### 1.7 Update TaskListComponent.onImplementRequested()

Replace the current fire-and-forget approach:
```typescript
async onImplementRequested(event: TaskImplementEvent): Promise<void> {
  this.taskService.markImplementRunning(event.task.id);
  // Navigate to agent chat so user can watch
  this.goToAgent.emit(event.agentId);
  // Run implementation via IPC (main process handles completion)
  await this.taskService.runImplementation(event.task.id, event.agentId);
}
```

### Phase 2: Implementation Completed UI State

#### 2.1 Three-State Implementation Tab

The Implementation tab should have three states:

| State | Condition | UI |
|-------|-----------|-----|
| **Empty** | `!implementAgentId && !implementRunning` | Agent picker + "Start Implementation" button |
| **In Progress** | `implementRunning` | Spinner + "Take me to the Agent" link |
| **Completed** | `task.state === 'done' && task.implementAgentId` | Success banner + "Request Revision" + "Take me to the Agent" |

#### 2.2 Completed State UI

```html
<!-- Implementation completed -->
@if (task()!.state === 'done' && task()!.implementAgentId && !implementRunning()) {
  <div class="implementation-complete">
    <mat-icon class="complete-icon">check_circle</mat-icon>
    <h3>Implementation Complete</h3>
    <p>The agent has finished implementing this task.</p>

    <div class="implementation-actions">
      <button mat-stroked-button color="primary"
              (click)="goToImplementer.emit(task()!.implementAgentId!)">
        <mat-icon>open_in_new</mat-icon>
        View Agent Conversation
      </button>

      <button mat-flat-button color="warn"
              (click)="requestRevision()">
        <mat-icon>replay</mat-icon>
        Request Revision
      </button>
    </div>
  </div>
}
```

#### 2.3 Completed State Styling

```scss
.implementation-complete {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 20px;
  text-align: center;

  .complete-icon {
    font-size: 48px;
    width: 48px;
    height: 48px;
    color: #22c55e; // Green — matches "done" state color
  }

  h3 {
    margin: 8px 0 4px 0;
    color: var(--text-primary);
  }

  p {
    margin: 0 0 20px 0;
    color: var(--text-secondary);
    max-width: 400px;
  }
}

.implementation-actions {
  display: flex;
  gap: 12px;
}
```

### Phase 3: Revision Flow

#### 3.1 "Request Revision" Behavior

When the user clicks "Request Revision":
1. Change task state back to `in_progress` (via `stateChanged` emit or direct update)
2. Navigate to the implementing agent's chat view
3. Optionally pre-populate a revision prompt, or let the user type their own

**Simple approach (recommended for v1):**
```typescript
requestRevision(): void {
  const t = this.task();
  if (!t) return;
  // Transition state back to in_progress
  this.stateChanged.emit({ task: t, state: 'in_progress' });
  // Navigate to the implementing agent's chat
  this.goToImplementer.emit(t.implementAgentId!);
}
```

This keeps it simple: the user is taken to the chat where they can type their revision instructions naturally. The agent has the full conversation context since the original implementation prompt and response are in the chat history.

**Advanced approach (future):**
- A dedicated revision comment/prompt dialog (similar to research review)
- The revision prompt is sent programmatically with task context
- Implementation re-runs through the IPC handler with a revision prompt

#### 3.2 State Transitions

```
                    ┌──────────────────────┐
                    │                      │
  Start Impl.      ▼                      │
  ────────── → in_progress ─── Agent ──→ done
                    ▲          completes   │
                    │                      │
                    └── Request Revision ──┘
```

- **Start Implementation**: State → `in_progress`
- **Agent completes**: State → `done` (automatic)
- **Request Revision**: State → `in_progress` (user-initiated), navigate to agent chat

### Phase 4: Fix Existing Bug

#### 4.1 `goToImplementer` Uses Wrong Agent ID

**Current (line 298 of task-detail.component.html):**
```html
<button mat-stroked-button color="primary" (click)="goToImplementer.emit(task()!.researchAgentId!)">
```

**Should be:**
```html
<button mat-stroked-button color="primary" (click)="goToImplementer.emit(task()!.implementAgentId!)">
```

This is currently pointing to `researchAgentId` because `implementAgentId` doesn't exist yet. Once `implementAgentId` is added, this must be updated.

---

## Implementation Checklist

### Database & Types
- [ ] Add `implementAgentId` to `Task` interface in `task.types.ts`
- [ ] Add `implementAgentId` to `UpdateTaskInput`
- [ ] Add `implement_agent_id` column to `tasks` table (migration in `database.service.ts`)
- [ ] Update `getTask()` and `getTasks()` to read `implement_agent_id`
- [ ] Update `updateTask()` to write `implement_agent_id`

### IPC Layer
- [ ] Add `TASKS_RUN_IMPLEMENTATION` to `IPC_CHANNELS` in `ipc.types.ts`
- [ ] Add `IPCPayloads` entry for the new channel
- [ ] Register `TASKS_RUN_IMPLEMENTATION` handler in `ipc/index.ts`
- [ ] Add `runImplementation` to preload API in `preload/index.ts`
- [ ] Add `ElectronAPI.tasks.runImplementation` type definition

### Services
- [ ] Add `runTaskImplementation()` to `ElectronService`
- [ ] Add `runImplementation()` to `TaskService`
- [ ] Update `TaskService.streamComplete$` subscription to handle implementation completion
- [ ] Remove immediate `clearImplementRunning` from `TaskListComponent.onImplementRequested()`

### UI
- [ ] Update Implementation tab template with three states (empty / running / complete)
- [ ] Add "Request Revision" button in completed state
- [ ] Add `requestRevision()` method to `TaskDetailComponent`
- [ ] Fix `goToImplementer` to use `implementAgentId` instead of `researchAgentId`
- [ ] Add completed-state styles to `task-detail.component.scss`
- [ ] Ensure `implementRunning` input correctly reflects the signal through task refresh

---

## Edge Cases & Considerations

1. **Agent session lost mid-implementation** — If the agent crashes or the session is stopped, the `onComplete` callback will never fire. Need a timeout or error handler that clears `implementRunning` and sets task to an error/blocked state. The `APP_ERROR` event could be used for this.

2. **User navigates away during implementation** — The `implementRunningIds` signal in `TaskService` survives navigation (it's a root-scoped service). The `streamComplete$` subscription in the constructor also survives. This is already the correct architecture.

3. **Multiple implementations** — If a user starts implementation, then requests revision and starts again, the `implementAgentId` gets overwritten. The previous agent's chat still has the old conversation. Consider whether to track a history of implementation attempts.

4. **Task already done** — The Implementation tab should show the completed state even if the task was manually marked done (not via agent). Consider: should the completed UI only show when `implementAgentId` is set, or always when state is `done`?

5. **Agent completion detection reliability** — `processManagerService.onComplete` fires when the Copilot CLI returns a complete response. If the agent's response is cut off or the process exits, this may not fire. Need error handling on the session process.

6. **Race condition: state change before completion** — If the user manually changes the task state while implementation is running, the auto-transition to `done` could overwrite their change. The `onComplete` handler should check if the task state is still `in_progress` before transitioning.

7. **Bug tasks** — When a bug task is auto-marked `done` by implementation completion, should a `closeReason` be auto-set to `'fixed'`? Recommend: yes, default to `'fixed'` for bugs.

8. **Prompt quality** — The current implementation prompt is simple. Consider enriching it with:
   - The research document content (already included)
   - The task kind (bug vs feature affects how the agent should approach it)
   - The workspace context (already implicit via the agent's working directory)

---

## Complexity Assessment

| Component | Effort | Risk |
|-----------|--------|------|
| Add `implementAgentId` to types + DB | Low | Low |
| New IPC handler `TASKS_RUN_IMPLEMENTATION` | Medium | Medium — mirrors research pattern |
| Preload + ElectronService + TaskService wiring | Low | Low — boilerplate |
| Completion detection via `streamComplete$` | Low | Low — pattern already exists |
| Implementation tab three-state UI | Medium | Low |
| Request Revision flow | Low | Low — state change + navigation |
| Fix `goToImplementer` bug | Trivial | None |
| Error handling (session loss, timeouts) | Medium | Medium |

**Overall: Medium complexity.** The main risk is in completion detection reliability and the new IPC handler, but both follow established patterns from the research flow.

---

## Dependencies

- No new packages required
- Depends on existing: `processManagerService.onComplete()`, `CHAT_STREAM_COMPLETE` event pattern
- Schema migration for `implement_agent_id` column

---

## Open Questions

1. **Auto-transition vs. prompt** — Should the task auto-mark as `done` when the agent completes, or should the user confirm? **Recommendation: Auto-mark, with easy revision path.**

2. **State before implementation starts** — Should starting implementation auto-change state to `in_progress`? Currently it doesn't. **Recommendation: Yes, auto-transition to `in_progress` when starting.**

3. **Implementation summary storage** — Should we store a summary of what the agent did (like `researchContent` for research)? **Recommendation: Defer for v1. The full conversation is in chat history. Can add `implementSummary` field later.**

4. **Re-implementation** — After marking done and later requesting revision, should the Implementation tab reset to empty state or show a "Re-implement" button? **Recommendation: Show the agent picker again with "Re-implement" button, keeping the completed-state visible until a new implementation starts.**

5. **Multi-turn implementation** — If the user has a conversation with the agent (not just the initial prompt), how do we know when "implementation is truly done"? **Recommendation: For v1, mark done after the initial prompt response. The user can continue the conversation in the chat view and the task stays done unless they explicitly request revision from the Implementation tab.**
