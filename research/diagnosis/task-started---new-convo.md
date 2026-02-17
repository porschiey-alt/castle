## Diagnosis and Suggested Fix

### Symptoms

When a user clicks **"Start Implementation"** (or **"Start Research"/"Start Diagnosis"**)
on a task, the app navigates to the agent chat but **no new conversation appears in the
conversations panel**. The task prompt and its streamed response either land in the
previously-active conversation or float as orphan messages with no conversation association.

The user expects a new conversation entry to appear in the panel with a descriptive title
like **"CODE: Fix login timeout"** or **"Research: Caching strategy"**.

### Root Cause Analysis

The bug has two independent layers: a **frontend timing issue** and a **backend bypass of
the conversation system**.

#### Layer 1 — Backend: Task handlers bypass the conversation system entirely

The normal chat flow goes through `CHAT_SEND_MESSAGE` (ipc/index.ts:204), which:
1. Sets `activeConversationIds.set(agentId, conversationId)` so assistant replies are
   associated with a conversation
2. Saves the user message to the DB with a `conversationId`
3. Sends the prompt to the process manager

The task handlers (`TASKS_RUN_IMPLEMENTATION` at line 581 and `TASKS_RUN_RESEARCH` at
line 452) **skip all of this**. They call `processManagerService.sendMessage()` directly,
which means:

- **No conversation is created** — there is no `databaseService.createConversation()` call
- **No `activeConversationIds` entry** — when the `subscribeToSession` `onComplete` handler
  fires (line 141), it reads `activeConversationIds.get(agentId)` which is either `undefined`
  or stale from a previous manual chat, so the assistant response is saved to the wrong
  (or no) conversation
- **The task prompt is never saved as a user message** — only the assistant response is
  eventually persisted (via the generic `onComplete` subscription), making it impossible
  to reconstruct the full conversation

This is the **primary root cause**: the backend has no code to create a dedicated conversation
for task operations.

#### Layer 2 — Frontend: `goToAgentNewConvo` clears selection but doesn't create a conversation

The previous fix attempt (visible in the current code) added a `goToAgentNewConvo` output
that triggers `goToAgent($event, true)` in `main-layout.component.ts` (line 280). When
`newConversation` is true, it calls `this.conversationService.selectConversation(null)`.

This clears the active conversation ID on the frontend, putting the chat into "new
conversation" mode. However:

- The `selectConversation(null)` call happens **inside a `.then()` callback** (after
  `loadConversations` resolves), but `onImplementRequested` immediately calls
  `taskService.runImplementation()` on the next line. The IPC handler on the backend
  fires and starts sending messages **before** the frontend has finished clearing the
  active conversation — a race condition.
- Even if the timing were fixed, the frontend "new conversation" mode relies on
  `chatService.sendMessage()` to auto-create a conversation on the **next user-typed
  message**. But task prompts are sent directly from the backend, so no user message
  is ever sent through the frontend, and the auto-create logic never triggers.

#### Layer 3 — Research path is missing the `goToAgentNewConvo` emit entirely

`onResearchRequested` (task-list.component.ts:157) does not emit `goToAgentNewConvo` at
all — it just fires `runResearch()` without navigating the user to the chat view or
creating a conversation. Research messages are completely orphaned.

### Data flow summary

```
User clicks "Start Implementation"
  → task-list.component.ts: onImplementRequested()
    → goToAgentNewConvo.emit(agentId)          ← frontend: selectConversation(null)
    → taskService.runImplementation(taskId, agentId)
      → electron IPC: TASKS_RUN_IMPLEMENTATION
        → processManagerService.sendMessage()  ← sends directly, no conversation created
        → subscribeToSession.onComplete()
          → activeConversationIds.get(agentId) ← undefined/stale — response saved wrong
```

### Suggested Fix

The fix should create a real conversation on the **backend** before sending the task prompt,
then notify the frontend to select it.

#### 1. Backend: Create a conversation in the task IPC handlers

In `src/main/ipc/index.ts`, update both `TASKS_RUN_IMPLEMENTATION` and `TASKS_RUN_RESEARCH`
to create a conversation and wire it up:

```typescript
// Inside TASKS_RUN_IMPLEMENTATION handler, before sending the prompt:

// Create a dedicated conversation for this implementation
const convoTitle = `CODE: ${task.title}`;
const conversation = await databaseService.createConversation({
  agentId,
  title: convoTitle,
});

// Associate future assistant replies with this conversation
activeConversationIds.set(agentId, conversation.id);

// Save the implementation prompt as a user message in the conversation
await databaseService.saveMessage({
  agentId,
  conversationId: conversation.id,
  role: 'user',
  content: prompt,
  timestamp: new Date(),
});

// Notify frontend that a new conversation was created
broadcaster.send(IPC_CHANNELS.SYNC_CONVERSATIONS_CHANGED, { agentId });
```

Apply the same pattern to `TASKS_RUN_RESEARCH`, using the title format:
- For bugs: `Diagnosis: ${task.title}`
- For features: `Research: ${task.title}`

#### 2. Frontend: Select the newly-created conversation after navigation

In `src/app/layout/main-layout.component.ts`, update `goToAgent()` so that the
`newConversation` path loads conversations **after** the backend has had time to create one.
The simplest approach: rather than `selectConversation(null)`, just call `selectMostRecent()`
since the backend will have just created the task conversation as the newest entry:

```typescript
goToAgent(agentId: string, newConversation = false): void {
  this.agentService.selectAgent(agentId);
  // Delay loading until next tick so the backend conversation is committed
  setTimeout(async () => {
    await this.conversationService.loadConversations(agentId);
    this.conversationService.selectMostRecent();
  }, 200);
  this.activeView = 'chat';
  this.closeSidebar();
}
```

A cleaner alternative: have `runImplementation` / `runResearch` **return the conversation ID**
from the IPC, and pass it through so the frontend can directly select it.

#### 3. Frontend: Add navigation + conversation for research too

In `src/app/features/tasks/task-list/task-list.component.ts`, update `onResearchRequested`
to also emit `goToAgentNewConvo` so the user is taken to the chat:

```typescript
async onResearchRequested(event: TaskResearchEvent): Promise<void> {
  this.taskService.markResearchRunning(event.task.id);
  this.goToAgentNewConvo.emit(event.agentId);
  await this.taskService.runResearch(event.task.id, event.agentId, event.outputPath);
}
```

### Files Changed

| File | Change |
|---|---|
| `src/main/ipc/index.ts` | Create conversation + save user message + set `activeConversationIds` in both `TASKS_RUN_IMPLEMENTATION` and `TASKS_RUN_RESEARCH` handlers |
| `src/app/layout/main-layout.component.ts` | Fix `goToAgent()` to handle timing so newly-created conversation is selected |
| `src/app/features/tasks/task-list/task-list.component.ts` | Add `goToAgentNewConvo.emit()` in `onResearchRequested` |

### Verification Steps

1. **Implementation**: Open a task → Implementation tab → "Start Implementation". Verify:
   - The app switches to the chat view
   - A new conversation appears in the conversation panel titled "CODE: \<task title\>"
   - The implementation prompt appears as a user message in the conversation
   - The agent's streamed response appears in the same conversation
2. **Research**: Open a task → Research tab → "Start Research". Verify:
   - The app switches to the chat view
   - A new conversation appears titled "Research: \<task title\>"
   - The research prompt and agent response are in that conversation
3. **Diagnosis (bugs)**: Open a bug → Diagnosis tab → "Start Diagnosis". Verify:
   - A new conversation appears titled "Diagnosis: \<bug title\>"
4. **"Take me to the Agent"**: While implementation is running, click the link. Verify:
   - It navigates to the agent's most recent conversation (the implementation one)
5. **"Take me to the Researcher"**: Same as above for research
6. **Normal chat**: Verify "New Chat" and manual conversations are unaffected
7. **Cross-device sync**: Verify conversation appears on other connected devices
