## Diagnosis and Suggested Fix

**Bug:** Research Revision — navigate away and come back hides spinner  
**Date:** 2026-02-16  
**Components:** `TaskListComponent`, `TaskDetailComponent`, `TaskService`

---

### Symptoms

1. User submits review comments on a research document (triggering a revision).
2. A spinner and "Revising research based on your comments…" message appear correctly.
3. User navigates away from the Tasks view (e.g., to Chat) and then navigates back.
4. The spinner is gone. The UI shows no indication that the revision is still in progress, even though the backend agent is still working.
5. When the revision eventually completes, the content updates silently.

---

### Root Cause Analysis

#### The navigation model destroys `TaskListComponent`

The main layout (`main-layout.component.html`) switches between views using `@if`:

```html
@if (activeView === 'tasks') {
  <app-task-list ... />
} @else if (selectedAgent()) {
  <app-chat ... />
}
```

When `activeView` changes from `'tasks'` to `'chat'`, Angular **destroys** the `<app-task-list>` component entirely. When the user navigates back, a **brand-new** `TaskListComponent` instance is created.

#### Running-state tracking lives in ephemeral component state

`TaskListComponent` tracks which tasks have active operations using plain `Set<string>` properties:

```typescript
// task-list.component.ts, lines 52-54
researchRunningTaskIds = new Set<string>();
implementRunningTaskIds = new Set<string>();
reviewRunningTaskIds = new Set<string>();
```

These are **component instance fields** — they exist only as long as the component exists. When the component is destroyed on navigation, the Sets are garbage-collected. When a new instance is created on return, all three Sets start empty.

#### The spinner is driven entirely by these ephemeral Sets

The template passes the running state to `TaskDetailComponent` via:

```html
<!-- task-list.component.html, line 19 -->
[reviewRunning]="isReviewRunning(task.id)"
```

Which calls:

```typescript
// task-list.component.ts, line 193-195
isReviewRunning(taskId: string): boolean {
  return this.reviewRunningTaskIds.has(taskId);
}
```

After navigation round-trip, `reviewRunningTaskIds` is a fresh empty Set → `isReviewRunning()` returns `false` → no spinner.

#### The stream-completion listener is also lost

The `streamComplete$` subscription (line 68) that cleans up the Sets and refreshes tasks is set up in `ngOnInit` and torn down in `ngOnDestroy`. After component recreation, the new subscription has no knowledge of previously-started operations. If the stream completes while the user is on a different view, the event is missed entirely (the old subscription was already unsubscribed, the new one doesn't exist yet).

#### Same bug affects research and implementation spinners

The same pattern applies to `researchRunningTaskIds` and `implementRunningTaskIds` — they would exhibit the identical bug if the user navigates away during those operations.

---

### Suggested Fix

Move the running-state tracking out of the ephemeral `TaskListComponent` and into the persistent `TaskService` singleton (`providedIn: 'root'`). The service survives navigation because it is never destroyed.

#### 1. Add running-state signals to `TaskService`

```typescript
// task.service.ts — add these fields and methods

// Running state tracking (survives navigation)
private researchRunningIds = signal(new Set<string>());
private implementRunningIds = signal(new Set<string>());
private reviewRunningIds = signal(new Set<string>());

readonly isResearchRunning = (taskId: string) =>
  this.researchRunningIds().has(taskId);

readonly isReviewRunning = (taskId: string) =>
  this.reviewRunningIds().has(taskId);

readonly isImplementRunning = (taskId: string) =>
  this.implementRunningIds().has(taskId);

markResearchRunning(taskId: string): void {
  this.researchRunningIds.update(s => { const n = new Set(s); n.add(taskId); return n; });
}

markReviewRunning(taskId: string): void {
  this.reviewRunningIds.update(s => { const n = new Set(s); n.add(taskId); return n; });
}

markImplementRunning(taskId: string): void {
  this.implementRunningIds.update(s => { const n = new Set(s); n.add(taskId); return n; });
}
```

#### 2. Listen for `streamComplete$` in the service constructor

Move the stream-completion subscription from `TaskListComponent.ngOnInit` into the `TaskService` constructor. Since the service is a singleton, this subscription lives for the entire app lifetime:

```typescript
// task.service.ts — constructor
constructor() {
  // Listen for stream completions globally
  this.electronService.streamComplete$.subscribe(async (msg) => {
    if (this.researchRunningIds().has(msg.id)) {
      this.researchRunningIds.update(s => { const n = new Set(s); n.delete(msg.id); return n; });
      await this.refreshTask(msg.id);
    }
    if (this.reviewRunningIds().has(msg.id)) {
      this.reviewRunningIds.update(s => { const n = new Set(s); n.delete(msg.id); return n; });
      await this.refreshTask(msg.id);
    }
  });
}
```

#### 3. Simplify `TaskListComponent`

Remove the three `Set` fields, the `completeSub` subscription, and the `isResearchRunning` / `isReviewRunning` / `isImplementRunning` methods. Delegate to `TaskService` instead:

```typescript
// task-list.component.ts — updated methods
async onResearchRequested(event: TaskResearchEvent): Promise<void> {
  this.taskService.markResearchRunning(event.task.id);
  await this.taskService.runResearch(event.task.id, event.agentId, event.outputPath);
}

async onReviewSubmitted(event: TaskReviewSubmitEvent): Promise<void> {
  this.taskService.markReviewRunning(event.taskId);
  await this.taskService.submitResearchReview(event.taskId, event.comments, event.researchSnapshot);
}

// Template bindings change to:
//   [researchRunning]="taskService.isResearchRunning(task.id)"
//   [reviewRunning]="taskService.isReviewRunning(task.id)"
//   [implementRunning]="taskService.isImplementRunning(task.id)"
```

#### 4. No changes needed to `TaskDetailComponent`

The `reviewRunning` input will now correctly reflect the persisted state from the service, so the template's `@if (reviewRunning())` blocks, the `reviewRunningEffect`, and `onReviewComplete()` all continue to work as-is.

---

### Verification Steps

1. **Reproduce the original bug (before fix):**
   - Open a task with existing research content.
   - Add review comments and click "Submit Review."
   - Confirm the spinner appears ("Revising research based on your comments…").
   - Navigate to Chat, then back to Tasks → re-select the task.
   - Observe: spinner should now still be visible.

2. **Spinner persists across navigation:**
   - Submit a review. Navigate away and back multiple times.
   - Each time the spinner and revision message should appear until the revision completes.

3. **Spinner clears on completion:**
   - Submit a review. Wait for it to complete (stream finishes).
   - The spinner should disappear and updated research content should render.

4. **Completion while navigated away:**
   - Submit a review. Navigate to Chat immediately.
   - Wait for the revision to finish (watch the agent's chat for completion).
   - Navigate back to Tasks → re-select the task.
   - The spinner should be gone and the updated research content should be visible.

5. **Same verification for research and implementation spinners:**
   - Start a research operation, navigate away and back — spinner should persist.
   - Start an implementation, navigate away and back — spinner should persist.

6. **No duplicate refresh on completion:**
   - Confirm that `refreshTask` is only called once when a stream completes (by the service), not by both the service and the component.
