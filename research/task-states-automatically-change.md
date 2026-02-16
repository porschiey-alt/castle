# Research: Task States Automatically Change

## Problem Statement

Two enhancements are needed to improve task workflow automation and visibility:

1. **Research/Diagnosis badge on task list** — Add a visual indicator (badge/icon) to the task list cards so users can see at a glance which tasks have research or diagnosis documents attached.
2. **Auto-transition to "In Progress" on implementation start** — When the user clicks "Start Implementation" in the Implementation tab, the task state should automatically change to `in_progress`.

---

## Technical Analysis

### 1. Research/Diagnosis Badge on Task List

#### Current Behavior

The task list (`task-list.component.html`, lines 93–124) renders each task as a card showing:
- Kind icon (feature/bug/chore/spike)
- State icon (new/active/in_progress/blocked/done)
- Title
- Labels
- State label text

There is **no indicator** for whether a task has research content or a diagnosis file.

#### Data Availability

The `Task` interface (`task.types.ts`, line 48) already includes:
```ts
researchContent?: string;
researchAgentId?: string;
```

When tasks are loaded via IPC (`main/ipc/index.ts`, lines 332–336), the `hydrateResearchFromFile()` function reads the on-disk research/diagnosis markdown file and populates `researchContent`. So by the time the task reaches the UI, `task.researchContent` is truthy if and only if research output exists.

Additionally, `task.researchAgentId` is set when a research agent has been assigned (even before completion). This could be used to distinguish "research started but not finished" from "research complete."

#### Proposed Approach

Add a small icon/badge to the task card's left icon group (`.task-card-left`) or the meta section (`.task-card-meta`). A `science` icon (or `bug_report` for bugs) with a distinct color would serve as a visual cue.

**Template change** in `task-list.component.html` — inside the `@for (task of tasks(); track task.id)` loop, after the existing icons:

```html
<!-- In .task-card-left or .task-card-meta -->
@if (task.researchContent) {
  <mat-icon class="research-badge"
            [matTooltip]="task.kind === 'bug' ? 'Has diagnosis' : 'Has research'"
            [style.color]="'#8b5cf6'">
    {{ task.kind === 'bug' ? 'bug_report' : 'science' }}
  </mat-icon>
}
```

**Best placement options** (in order of recommendation):

| Option | Location | Pros | Cons |
|--------|----------|------|------|
| A | After state icon in `.task-card-left` | Grouped with other status icons, highly visible | May feel crowded with 3 icons |
| B | In `.task-card-meta` next to state label | Clean separation, meta area has space | Less prominent |
| C | As a small dot/indicator on the title line | Subtle, non-intrusive | May be missed |

**Recommended: Option A** — Place it after the state icon in `.task-card-left`. This keeps all status indicators grouped together and is immediately visible when scanning the list.

**SCSS** — Add to `task-list.component.scss`:

```scss
.research-badge {
  font-size: 16px;
  width: 16px;
  height: 16px;
  opacity: 0.85;
}
```

#### Edge Cases

- Tasks with `researchAgentId` but no `researchContent` (research started, not finished): Could optionally show a faded/outlined icon, but this adds complexity. Recommend only showing the badge when `researchContent` is truthy (research is complete).
- The `hydrateResearchFromFile()` function already clears stale `researchContent` when the file is missing on disk, so the badge will correctly disappear if the user deletes the file.

---

### 2. Auto-Transition to "In Progress" on Implementation Start

#### Current Behavior

When the user clicks "Start Implementation":

1. `task-detail.component.ts` → `startImplementation()` (line 256) emits `implementRequested` event
2. `task-list.component.ts` → `onImplementRequested()` (line 148) calls:
   - `taskService.markImplementRunning(event.task.id)` — UI-only flag for spinner
   - `goToAgent.emit(event.agentId)` — navigate to agent chat
   - `taskService.runImplementation(event.task.id, event.agentId)` — IPC call to main process
3. Main process (`main/ipc/index.ts`, line 534) handles `TASKS_RUN_IMPLEMENTATION`:
   - Saves `implementAgentId` to DB (line 562)
   - Sends implementation prompt to agent
   - On completion: auto-transitions task to `done` (lines 568–580), broadcasts update

**The task state is never changed to `in_progress` when implementation starts.** It only transitions to `done` upon completion.

#### Proposed Approach

There are two places where this transition could happen:

**Option 1: Frontend (TaskListComponent)** — Change state in `onImplementRequested()`:

```ts
async onImplementRequested(event: TaskImplementEvent): Promise<void> {
  this.taskService.markImplementRunning(event.task.id);

  // Auto-transition to in_progress if task is new or active
  if (event.task.state !== 'in_progress' && event.task.state !== 'done') {
    await this.taskService.updateTask(event.task.id, { state: 'in_progress' });
  }

  this.goToAgent.emit(event.agentId);
  await this.taskService.runImplementation(event.task.id, event.agentId);
}
```

**Option 2: Backend (IPC handler)** — Change state in the `TASKS_RUN_IMPLEMENTATION` handler:

```ts
// After saving implementAgentId (line 562)
if (task.state !== 'in_progress' && task.state !== 'done') {
  await databaseService.updateTask(taskId, { state: 'in_progress' });
  broadcaster.send(IPC_CHANNELS.SYNC_TASKS_CHANGED, {
    action: 'updated',
    task: await databaseService.getTask(taskId),
  });
}
```

**Recommended: Option 2 (Backend)** — This is more robust because:
- It ensures the state change happens even if the frontend crashes
- It's consistent with the existing completion handler that already auto-transitions to `done` on the backend (line 568–580)
- The `SYNC_TASKS_CHANGED` broadcast will update all connected renderers (cross-device sync support)

However, **combining both options** provides the best UX — an optimistic update on the frontend (instant UI feedback) plus the authoritative backend change:

- Frontend: optimistically update the local signal so the UI reflects `in_progress` immediately
- Backend: persist the state change and broadcast to other devices

#### Guard Conditions

The state should only auto-transition if the task is NOT already `in_progress`, `done`, or `blocked`:
- `new` → `in_progress` ✓
- `active` → `in_progress` ✓
- `blocked` → leave as-is (user should manually unblock first)
- `in_progress` → no-op
- `done` → no-op (shouldn't happen in normal flow, but guard anyway)

#### State Transition Diagram (updated)

```
new ──[Start Implementation]──> in_progress ──[Agent completes]──> done
 │                                    │
 └──[manual]──> active                └──[manual]──> blocked
```

---

## Implementation Guidance

### Files to Modify

| File | Change |
|------|--------|
| `src/app/features/tasks/task-list/task-list.component.html` | Add research badge icon to task cards |
| `src/app/features/tasks/task-list/task-list.component.scss` | Style the research badge |
| `src/app/features/tasks/task-list/task-list.component.ts` | Add `hasResearch(task)` helper (optional, could inline in template) |
| `src/main/ipc/index.ts` | Auto-transition to `in_progress` in `TASKS_RUN_IMPLEMENTATION` handler |
| `src/app/features/tasks/task-list/task-list.component.ts` | Optimistic `in_progress` update in `onImplementRequested()` |

### Implementation Steps

#### Part 1: Research Badge

1. In `task-list.component.html`, inside the `.task-card-left` div (after line 101), add:
   ```html
   @if (task.researchContent) {
     <mat-icon class="research-badge"
               [matTooltip]="task.kind === 'bug' ? 'Has diagnosis' : 'Has research'"
               [style.color]="'#8b5cf6'">
       {{ task.kind === 'bug' ? 'bug_report' : 'science' }}
     </mat-icon>
   }
   ```

2. In `task-list.component.scss`, add the `.research-badge` style inside `.task-card-left`:
   ```scss
   .research-badge {
     font-size: 16px;
     width: 16px;
     height: 16px;
     opacity: 0.85;
   }
   ```

#### Part 2: Auto-Transition to In Progress

3. In `src/main/ipc/index.ts`, in the `TASKS_RUN_IMPLEMENTATION` handler, after the `await databaseService.updateTask(taskId, { implementAgentId: agentId })` line (562), add:
   ```ts
   // Auto-transition to in_progress when implementation starts
   if (task.state !== 'in_progress' && task.state !== 'done' && task.state !== 'blocked') {
     await databaseService.updateTask(taskId, { state: 'in_progress' });
     broadcaster.send(IPC_CHANNELS.SYNC_TASKS_CHANGED, {
       action: 'updated',
       task: await databaseService.getTask(taskId),
     });
   }
   ```

4. In `src/app/features/tasks/task-list/task-list.component.ts`, in `onImplementRequested()`, add an optimistic state update before the IPC call:
   ```ts
   async onImplementRequested(event: TaskImplementEvent): Promise<void> {
     this.taskService.markImplementRunning(event.task.id);

     // Optimistic: transition to in_progress immediately in UI
     if (event.task.state !== 'in_progress' && event.task.state !== 'done' && event.task.state !== 'blocked') {
       await this.taskService.updateTask(event.task.id, { state: 'in_progress' });
     }

     this.goToAgent.emit(event.agentId);
     await this.taskService.runImplementation(event.task.id, event.agentId);
   }
   ```

   > **Note:** Since `taskService.updateTask()` calls the backend via IPC which already broadcasts `SYNC_TASKS_CHANGED`, the frontend optimistic update also serves as the authoritative update. The backend handler in step 3 then becomes a safety net (will be a no-op if the state is already `in_progress`).

---

## Considerations

1. **Performance**: The research badge check (`task.researchContent` truthiness) is O(1) — no additional IPC calls or file reads needed since `hydrateResearchFromFile()` already runs on task load.

2. **Cross-device sync**: The backend auto-transition + `SYNC_TASKS_CHANGED` broadcast ensures all connected instances see the state change.

3. **Idempotency**: Both the badge and the state transition are idempotent — re-rendering or re-triggering won't cause issues.

4. **Blocked tasks**: We intentionally skip auto-transition for `blocked` tasks. If a task is blocked, the user likely has a reason and should manually change the state.

5. **Future enhancement**: Could also auto-transition to `active` when research starts (via `TASKS_RUN_RESEARCH` handler), following the same pattern. This is out of scope for this task but worth noting.
