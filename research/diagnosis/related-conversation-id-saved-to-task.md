## Diagnosis and Suggested Fix

### Symptoms

When a user triggers research or implementation on a task, a new conversation is created (e.g., "Research: My Task" or "CODE: My Task") and the agent performs work inside that conversation. However, when the user later returns to the task detail and clicks **"Take me to the Researcher"**, **"View Agent Conversation"**, or **"Take me to the Agent"**, they are navigated to the agent's **most recent conversation** rather than the specific conversation that was used for that task's research or implementation.

This happens because the "go to agent" buttons only emit the `agentId`, and the `MainLayoutComponent.goToAgent()` method calls `selectMostRecent()` — which picks whatever conversation is newest, not the one tied to the task.

### Root Cause Analysis

The data flow has a gap between conversation creation and task persistence:

1. **Conversation is created but never saved to the task.** In `TaskListComponent.onResearchRequested()` and `onImplementRequested()`, a new conversation is created via `createAndNavigateToConversation()`, and its `conversationId` is passed to the IPC handler. The IPC handler uses it only for routing streaming messages (`activeConversationIds.set(agentId, conversationId)`), but **never persists it on the task record**.

2. **The `Task` type has no conversation ID fields.** The `Task` interface in `task.types.ts` has `researchAgentId` and `implementAgentId` but no `researchConversationId` or `implementConversationId`.

3. **The database schema has no conversation ID columns.** The `tasks` table has `research_agent_id` and `implement_agent_id` but no corresponding conversation ID columns.

4. **Navigation only uses `agentId`.** The `goToResearcher` and `goToImplementer` outputs emit only a `string` (the agent ID). The `goToAgent()` handler in `MainLayoutComponent` selects the agent and then calls `selectMostRecent()`, which navigates to whatever conversation happens to be newest — not the task-specific one.

**Files involved in the bug:**

| File | Role |
|------|------|
| `src/shared/types/task.types.ts` | `Task` interface — missing `researchConversationId` and `implementConversationId` |
| `src/main/services/database.service.ts` | DB schema and queries — missing columns and mapping |
| `src/main/ipc/index.ts` | IPC handlers — receive `conversationId` but don't persist it to the task |
| `src/app/features/tasks/task-detail/task-detail.component.ts` | `goToResearcher`/`goToImplementer` outputs emit only `agentId` |
| `src/app/features/tasks/task-detail/task-detail.component.html` | Button click handlers only pass `agentId` |
| `src/app/features/tasks/task-list/task-list.component.ts` | Bridges detail → layout; only forwards `agentId` |
| `src/app/features/tasks/task-list/task-list.component.html` | Template bindings |
| `src/app/layout/main-layout.component.ts` | `goToAgent()` calls `selectMostRecent()` instead of selecting a specific conversation |
| `src/app/layout/main-layout.component.html` | Template wiring |

### Suggested Fix

**1. Add conversation ID fields to the `Task` type** (`src/shared/types/task.types.ts`):

```ts
export interface Task {
  // ... existing fields ...
  researchConversationId?: string;   // NEW
  implementConversationId?: string;  // NEW
}
```

Also add them to `UpdateTaskInput`:

```ts
export type UpdateTaskInput = Partial<Pick<Task, 'title' | 'description' | 'state' | 'kind'
  | 'researchContent' | 'researchAgentId' | 'implementAgentId'
  | 'researchConversationId' | 'implementConversationId'  // NEW
  | 'closeReason'>> & {
  labelIds?: string[];
};
```

**2. Add database columns** (`src/main/services/database.service.ts`):

Add migration blocks (same pattern as existing migrations):

```ts
try {
  this.db.run(`ALTER TABLE tasks ADD COLUMN research_conversation_id TEXT`);
} catch { /* column already exists */ }
try {
  this.db.run(`ALTER TABLE tasks ADD COLUMN implement_conversation_id TEXT`);
} catch { /* column already exists */ }
```

Update the `updateTask` method to handle the new fields, and update all `SELECT` queries and row-mapping to include `research_conversation_id` / `implement_conversation_id`.

**3. Persist conversation IDs in IPC handlers** (`src/main/ipc/index.ts`):

In the `TASKS_RUN_RESEARCH` handler, after saving the `researchAgentId`, also save the conversation ID:

```ts
await databaseService.updateTask(taskId, {
  researchAgentId: agentId,
  researchConversationId: conversationId,  // NEW
});
```

Same for `TASKS_RUN_IMPLEMENTATION`:

```ts
await databaseService.updateTask(taskId, {
  implementAgentId: agentId,
  implementConversationId: conversationId,  // NEW
});
```

**4. Change navigation outputs to emit `{ agentId, conversationId }`** (`task-detail.component.ts`):

```ts
goToResearcher = output<{ agentId: string; conversationId?: string }>();
goToImplementer = output<{ agentId: string; conversationId?: string }>();
```

Update the template button clicks:

```html
(click)="goToResearcher.emit({ agentId: task()!.researchAgentId!, conversationId: task()!.researchConversationId })"
```

```html
(click)="goToImplementer.emit({ agentId: task()!.implementAgentId!, conversationId: task()!.implementConversationId })"
```

**5. Update `TaskListComponent` and `MainLayoutComponent` to select the specific conversation:**

In `task-list.component.ts`, change the output type and forwarding:

```ts
goToAgent = output<{ agentId: string; conversationId?: string }>();
```

In `main-layout.component.html`, pass the full event:

```html
<app-task-list (goToAgent)="goToAgentConversation($event)" .../>
```

In `main-layout.component.ts`, add a new method:

```ts
goToAgentConversation(event: { agentId: string; conversationId?: string }): void {
  this.agentService.selectAgent(event.agentId);
  this.conversationService.loadConversations(event.agentId).then(() => {
    if (event.conversationId) {
      this.conversationService.selectConversation(event.conversationId);
    } else {
      this.conversationService.selectMostRecent();
    }
  });
  this.activeView = 'chat';
  this.closeSidebar();
}
```

### Verification Steps

1. **Create a task** and run research on it. Verify that after research completes, the task record in the database has a non-null `research_conversation_id`.
2. **Navigate away** from the task (e.g., go to chat, switch agents, create new conversations).
3. **Return to the task** and click "Take me to the Researcher". Verify it opens the exact conversation that was used for research, not the most recent one.
4. **Repeat for implementation**: run implementation, navigate away, return, click "View Agent Conversation" — verify it opens the correct implementation conversation.
5. **Test the "Request Revision" flow**: after implementation is done, click "Request Revision" and verify it navigates to the implementation conversation.
6. **Edge case — no conversation ID**: for tasks created before this fix (where `researchConversationId`/`implementConversationId` are null), verify the fallback behavior still works (selects the most recent conversation for that agent).
7. **Cross-device sync**: verify that the conversation IDs are included in the task data broadcasted via `SYNC_TASKS_CHANGED`.
