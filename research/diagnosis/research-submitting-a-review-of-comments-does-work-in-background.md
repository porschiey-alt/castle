## Diagnosis and Suggested Fix

### Symptoms

When a user adds review comments to a research document and clicks "Submit Review":

1. The review is sent to the research agent in the background (the agent receives a revision prompt and begins working).
2. **No visual feedback** is shown on the Research tab — the review panel simply disables its buttons via `reviewSubmitting`, but nothing else changes.
3. The user has no way to know that an agent is actively revising the document, and there is no link to navigate to the agent to observe its progress.
4. When the revision completes, `streamComplete$` fires and `task-list` clears `reviewRunningTaskIds`, but the `task-detail` component is never told to show a "revision in progress" state because it never receives the `reviewRunning` status.

In contrast, initial research and implementation both have dedicated spinner UIs with "Take me to the Agent" buttons.

### Root Cause Analysis

The data flow has two gaps:

**Gap 1 — `reviewRunning` is tracked in `task-list` but never passed down to `task-detail`.**

`TaskListComponent` tracks `reviewRunningTaskIds` (line 54) and exposes `isReviewRunning()` (line 195), but the template (`task-list.component.html` line 12–28) never binds it to `<app-task-detail>`:

```html
<!-- task-list.component.html -->
<app-task-detail
  [task]="task"
  ...
  [researchRunning]="isResearchRunning(task.id)"
  [implementRunning]="isImplementRunning(task.id)"
  <!-- ❌ Missing: [reviewRunning]="isReviewRunning(task.id)" -->
  ...
/>
```

`TaskDetailComponent` has no `reviewRunning` input signal at all — it only has the local `reviewSubmitting` boolean which is set to `true` on submit but is never set back to `false` because `onReviewComplete()` is never called from the parent (the parent tracks completion via `_reviewCompleteTaskId` but has no mechanism to invoke the child method).

**Gap 2 — The Research tab template has no "revision in progress" UI state.**

Even if `reviewRunning` were passed in, the template has no conditional block to display a spinner + "Take me to the Researcher" link while the agent is revising the document. The existing `@if (researchRunning())` block only covers the *initial* research scenario (when `researchContent` is empty). Once research content exists, a review submission leaves the UI in the same "show content + review panel" state with no indication of background work.

**Gap 3 — `onReviewComplete()` is never called.**

`task-list` sets `_reviewCompleteTaskId` when the stream completes (line 79), but there is no binding or mechanism that calls `task-detail.onReviewComplete()`. The pending comments and `reviewSubmitting` flag are therefore never cleared after the revision completes.

### Suggested Fix

**1. Add a `reviewRunning` input to `TaskDetailComponent`** (`task-detail.component.ts`):

```typescript
/** Whether a review revision is currently running */
reviewRunning = input(false);
```

**2. Bind it from the parent template** (`task-list.component.html`):

```html
<app-task-detail
  ...
  [reviewRunning]="isReviewRunning(task.id)"
  ...
/>
```

**3. Add a "revision in progress" UI block in the Research tab** (`task-detail.component.html`).

After the `<app-research-content>` block and the review panel, but before the `@else if (researchRunning())` block, add a new conditional that renders when `reviewRunning()` is true:

```html
@if (task()!.researchContent) {
  <!-- Show content (existing) -->
  <app-research-content ... />

  <!-- Review in progress indicator (NEW) -->
  @if (reviewRunning()) {
    <div class="research-running">
      <mat-icon class="research-spinner">sync</mat-icon>
      <h3>Revising research based on your comments...</h3>
      <p>The agent is updating the document to address your review comments.</p>
      <button mat-stroked-button color="primary"
              (click)="goToResearcher.emit(task()!.researchAgentId!)">
        <mat-icon>open_in_new</mat-icon>
        Take me to the Researcher
      </button>
    </div>
  } @else if (pendingComments.length > 0) {
    <!-- Existing review panel -->
    <div class="review-panel">...</div>
  }
}
```

This replaces the review-panel with a spinner+link while the revision is running, and restores the review panel once the revision completes and `reviewRunning` goes back to `false`.

**4. Clear pending comments when the revision completes.**

Replace the `_reviewCompleteTaskId` pattern with a proper reactive approach. In `task-list.component.ts`, use a `ViewChild` or an `effect` to call `onReviewComplete()` on the child, or simpler — use a new output/input pair:

In `task-detail.component.ts`, watch the `reviewRunning` input and clear state when it transitions from `true` to `false`:

```typescript
import { effect } from '@angular/core';

// In constructor or field initializer:
private reviewRunningEffect = effect(() => {
  const running = this.reviewRunning();
  if (!running && this.reviewSubmitting) {
    // Review just finished
    this.onReviewComplete();
  }
});
```

This eliminates the need for `_reviewCompleteTaskId` in the parent entirely.

### Verification Steps

1. **Open a task with existing research content** in the Research tab.
2. **Add one or more review comments** using the inline comment UI.
3. **Click "Submit Review"** — verify that:
   - The review panel is replaced by a spinner with the message "Revising research based on your comments..."
   - A "Take me to the Researcher" button is displayed and navigates to the agent's chat view when clicked.
   - The tab label shows a spinner icon (same as initial research).
4. **Wait for the revision to complete** — verify that:
   - The spinner disappears.
   - The research content is refreshed with the revised document.
   - The pending comments list is cleared.
   - The `reviewSubmitting` flag is reset to `false`.
5. **Test edge cases**:
   - Submit a review and immediately navigate away from the task, then return — the spinner should still be shown if the revision is in progress.
   - If the agent errors during revision, verify the error is surfaced and the UI doesn't get stuck in a loading state.
