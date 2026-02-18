# Research: Task Completion — Self-Evaluation Step

## Executive Summary

The current implementation workflow goes straight from "agent reports done" → commit → PR → mark task as `done`. There is no verification step. When a research/diagnosis document exists for a task, the agent should be re-prompted to evaluate its implementation against that document before the PR is created. Additionally, a new `review` state should be introduced so tasks with open PRs land in "Ready for Review" instead of jumping directly to "Done".

The implementation touches primarily the `TASKS_RUN_IMPLEMENTATION` IPC handler (the completion callback), the `TaskState` type, the `TASK_STATES` constant, and the lifecycle step UI in `task-detail.component`.

---

## Current Flow vs. Proposed Flow

### Current Flow
```
1. Start Implementation from UI
2. Create conversation, assign to task
3. Create worktree
4. Install dependencies
5. Prompt agent to implement
6. Agent completes → onComplete fires:
   a. Commit changes
   b. Create PR
   c. Mark task as "done"
   d. Emit lifecycle "done"
```

### Proposed Flow
```
1. Start Implementation from UI
2. Create conversation, assign to task
3. Create worktree
4. Install dependencies
5. Prompt agent to implement
6. Agent completes → onComplete fires:
   a. Commit changes (intermediate commit for safety)
   b. NEW: Re-prompt agent to self-evaluate against research doc  ◄──
   c. NEW: Agent evaluates, fixes issues, produces report          ◄──
   d. NEW: Commit any additional fixes                              ◄──
   e. Create PR (with evaluation report in body)
   f. NEW: Mark task as "review" instead of "done"                  ◄──
   g. Emit lifecycle "done"
```

---

## Technical Analysis

### 1. New Task State: `review`

**File:** `src/shared/types/task.types.ts`

The `TaskState` type and `TASK_STATES` constant need a new entry:

```typescript
// Current:
export type TaskState = 'new' | 'in_progress' | 'active' | 'blocked' | 'done';

// Proposed:
export type TaskState = 'new' | 'in_progress' | 'active' | 'blocked' | 'review' | 'done';
```

```typescript
// Addition to TASK_STATES array (insert before 'done'):
{ id: 'review', label: 'Ready for Review', icon: 'rate_review', color: '#06b6d4' },
```

**Impact Analysis:**
- `TASK_STATES` is used for filter chips and state dropdowns in the UI — adding an entry auto-populates these
- The `filteredTasks` computed signal in `task.service.ts` currently hides `done` tasks unless explicitly filtered — `review` tasks should remain visible by default (same as `active`/`in_progress`)
- The database stores state as a TEXT column — no schema migration needed
- The `UpdateTaskInput` already includes `state` — no type changes needed

### 2. Re-Prompt Mechanism (Core Change)

**File:** `src/main/ipc/index.ts` — `TASKS_RUN_IMPLEMENTATION` handler, lines 817-882

The re-prompt pattern already exists in the codebase: the `TASKS_RUN_RESEARCH` handler uses it (lines 603-615) to re-prompt the agent if it didn't write a file. The same `onComplete → subscribe new onComplete → sendMessage` pattern applies here.

**Current onComplete callback** (lines 817-882):
```
Agent completes
  → unsubscribe
  → commit changes
  → create PR
  → mark done
  → broadcast
```

**Proposed onComplete callback:**
```
Agent completes (first prompt - implementation)
  → unsubscribe
  → commit changes (intermediate - "work in progress")
  → IF task has researchContent:
      → send new lifecycle phase: 'evaluating'
      → construct self-evaluation prompt
      → save evaluation prompt as user message in conversation
      → subscribe NEW onComplete handler
      → sendMessage(evaluationPrompt)
      → NEW onComplete:
          → commit any additional changes
          → create PR (with evaluation report)
          → mark as 'review'
          → broadcast
  → ELSE (no research doc):
      → create PR (existing behavior)
      → mark as 'review' (changed from 'done')
      → broadcast
```

### 3. Self-Evaluation Prompt Design

The prompt should:
1. Reference the original research/diagnosis document
2. Ask the agent to compare its implementation against each requirement/fix
3. Encourage fixing any gaps it discovers
4. Request a structured evaluation report

**Proposed prompt:**

```typescript
const evaluationPrompt = [
  `You have completed the initial implementation. Now evaluate your work against the original requirements.`,
  ``,
  `## Original Task`,
  `Title: ${task.title}`,
  `Description: ${task.description || '(none)'}`,
  ``,
  `## Research/Diagnosis Document`,
  task.researchContent,
  ``,
  `## Instructions`,
  `1. Review your implementation against the research document above`,
  `2. Check that every requirement, fix, or recommendation has been addressed`,
  `3. Run any relevant tests or verification steps mentioned in the research`,
  `4. Fix any issues or gaps you find — make the changes directly`,
  `5. After fixing any issues, produce a brief evaluation report summarizing:`,
  `   - What was implemented correctly`,
  `   - What issues were found and fixed during this evaluation`,
  `   - Any remaining items that could not be addressed automatically`,
  ``,
  `Be thorough but focused. Fix real issues, don't just describe them.`,
].join('\n');
```

For bugs with diagnosis documents, the prompt can be more specific:

```typescript
const bugEvalPrompt = [
  `You have completed the initial bug fix. Now verify your fix against the diagnosis document.`,
  ``,
  `## Bug: ${task.title}`,
  ``,
  `## Diagnosis Document`,
  task.researchContent,
  ``,
  `## Instructions`,
  `1. Follow the verification steps from the diagnosis`,
  `2. Confirm the root cause identified in the diagnosis has been addressed`,
  `3. Check for any regressions or edge cases mentioned in the diagnosis`,
  `4. Fix any remaining issues you find`,
  `5. Produce a brief verification report summarizing what you checked and the results`,
  ``,
  `Be thorough. If any verification step fails, fix the issue before reporting.`,
].join('\n');
```

### 4. New Lifecycle Phase: `evaluating`

**Files affected:**
- `src/main/ipc/index.ts` — emit `sendLifecycle('evaluating')` before sending evaluation prompt
- `src/app/features/tasks/task-detail/task-detail.component.ts` — add to `lifecycleLabel` getter
- `src/app/features/tasks/task-detail/task-detail.component.html` — add step to lifecycle steps UI

The lifecycle stepper in the template currently shows:
```
Worktree → Deps → Implement → Commit → PR
```

It should become:
```
Worktree → Deps → Implement → Evaluate → Commit → PR
```

### 5. Evaluation Report in PR Body

The self-evaluation agent response can be captured and included in the PR body:

```typescript
// In the evaluation's onComplete callback:
const evaluationReport = sessionProcess.contentBuffer; // or message.content

const prBody = [
  `## ${currentTask.title}`,
  ``,
  currentTask.description || '',
  ``,
  `---`,
  ``,
  `## Self-Evaluation Report`,
  evaluationReport,
  ``,
  `---`,
  `*Implemented and verified by Castle agent*`,
].join('\n');
```

---

## Detailed Implementation Plan

### Step 1: Add `review` State

**`src/shared/types/task.types.ts`:**

```diff
-export type TaskState = 'new' | 'in_progress' | 'active' | 'blocked' | 'done';
+export type TaskState = 'new' | 'in_progress' | 'active' | 'blocked' | 'review' | 'done';

 export const TASK_STATES: { id: TaskState; label: string; icon: string; color: string }[] = [
   { id: 'new', label: 'New', icon: 'fiber_new', color: '#3b82f6' },
   { id: 'active', label: 'Active', icon: 'radio_button_checked', color: '#8b5cf6' },
   { id: 'in_progress', label: 'In Progress', icon: 'play_circle', color: '#f59e0b' },
   { id: 'blocked', label: 'Blocked', icon: 'block', color: '#ef4444' },
+  { id: 'review', label: 'Ready for Review', icon: 'rate_review', color: '#06b6d4' },
   { id: 'done', label: 'Done', icon: 'check_circle', color: '#22c55e' },
 ];
```

**`src/app/core/services/task.service.ts`:**

Check the `filteredTasks` computed signal — ensure `review` tasks are visible by default (currently only `done` tasks are hidden unless filtered):

```typescript
// The existing logic hides 'done' tasks. 'review' should remain visible.
// No change needed IF the filter only hides state === 'done'.
```

### Step 2: Modify `onComplete` in `TASKS_RUN_IMPLEMENTATION`

**`src/main/ipc/index.ts`** — Replace lines 817-882:

```typescript
const unsubscribeImpl = processManagerService.onComplete(sessionProcess.session.id, async (message) => {
  unsubscribeImpl();

  const currentTask = await databaseService.getTask(taskId);
  if (!currentTask) return;

  // Intermediate commit before evaluation (so evaluation sees committed code)
  let hasChanges = false;
  if (currentTask.worktreePath) {
    try {
      sendLifecycle('committing');
      hasChanges = await gitWorktreeService.commitChanges(
        currentTask.worktreePath,
        `wip: ${currentTask.title}\n\nInitial implementation by Castle agent.`
      );
    } catch (commitError) {
      log.warn('Intermediate commit failed', commitError);
    }
  }

  // Self-evaluation step: re-prompt agent if research/diagnosis exists
  const researchContent = hydrateResearchFromFile(currentTask, workingDirectory).researchContent;
  
  const proceedToFinalize = async (evaluationReport?: string) => {
    // Commit any additional fixes from evaluation
    if (currentTask.worktreePath) {
      try {
        const additionalCommit = await gitWorktreeService.commitChanges(
          currentTask.worktreePath,
          `fix: address evaluation findings for ${currentTask.title}`
        );
        if (additionalCommit) {
          log.info(`Evaluation produced additional commits for task ${taskId}`);
        }
      } catch (e) {
        log.warn('Evaluation commit failed', e);
      }
    }

    // Create PR
    if (currentTask.worktreePath) {
      try {
        const shouldCreatePR = hasChanges
          || await gitWorktreeService.hasCommitsAhead(currentTask.worktreePath);
        if (shouldCreatePR) {
          sendLifecycle('creating_pr');
          
          // Build PR body, including evaluation report if available
          let prBody = `## ${currentTask.title}\n\n${currentTask.description || ''}`;
          if (evaluationReport) {
            prBody += `\n\n---\n\n## Self-Evaluation Report\n\n${evaluationReport}`;
          }
          prBody += `\n\n---\n*Implemented and verified by Castle agent*`;

          const prResult = await gitWorktreeService.pushAndCreatePR(currentTask.worktreePath, {
            title: currentTask.title,
            body: prBody,
            draft: settings.worktreeDraftPR || false,
          });

          if (prResult.success) {
            await databaseService.updateTask(taskId, {
              prUrl: prResult.url,
              prNumber: prResult.prNumber,
              prState: settings.worktreeDraftPR ? 'draft' : 'open',
            });
          } else {
            sendLifecycle('warning', `Auto-PR failed: ${prResult.error}. You can create one manually.`);
          }
        }
      } catch (e) {
        log.warn('PR creation failed', e);
      }
    }

    // Transition to 'review' instead of 'done'
    if (currentTask.state !== 'done' && currentTask.state !== 'review') {
      await databaseService.updateTask(taskId, { state: 'review' });
    }

    sendLifecycle('done');
    broadcaster.send(IPC_CHANNELS.SYNC_TASKS_CHANGED, {
      action: 'updated',
      task: await databaseService.getTask(taskId),
    });
    broadcaster.send(IPC_CHANNELS.CHAT_STREAM_COMPLETE, {
      id: taskId, agentId, role: 'assistant', content: '', timestamp: new Date(),
    });
  };

  if (researchContent) {
    // Self-evaluation phase
    sendLifecycle('evaluating');

    const isBug = currentTask.kind === 'bug';
    const evalPrompt = isBug
      ? buildBugEvaluationPrompt(currentTask, researchContent)
      : buildFeatureEvaluationPrompt(currentTask, researchContent);

    // Save evaluation prompt as user message in conversation
    if (conversationId) {
      const evalMessage = await databaseService.saveMessage({
        agentId, conversationId, role: 'user',
        content: evalPrompt, timestamp: new Date(),
      });
      broadcaster.send(IPC_CHANNELS.SYNC_CHAT_MESSAGE_ADDED, evalMessage);
    }

    // Subscribe to evaluation completion
    const unsubEval = processManagerService.onComplete(sessionProcess.session.id, async (evalMsg) => {
      unsubEval();
      await proceedToFinalize(evalMsg.content);
    });

    // Send evaluation prompt
    processManagerService.sendMessage(sessionProcess.session.id, evalPrompt).catch((error) => {
      log.error(`Self-evaluation prompt error for task ${taskId}`, error);
      // Fall through to finalize without evaluation on error
      proceedToFinalize();
    });
  } else {
    // No research doc — skip evaluation, go straight to finalize
    await proceedToFinalize();
  }
});
```

**Helper functions** (add near the `getResearchFilePath` function):

```typescript
function buildFeatureEvaluationPrompt(task: Task, researchContent: string): string {
  return [
    `You have completed the initial implementation. Now evaluate your work against the original requirements.`,
    ``,
    `## Original Task`,
    `Title: ${task.title}`,
    `Description: ${task.description || '(none)'}`,
    ``,
    `## Research Document`,
    researchContent,
    ``,
    `## Instructions`,
    `1. Review your implementation against every requirement and recommendation in the research document above`,
    `2. Run any relevant tests or verification steps mentioned in the research`,
    `3. Fix any issues or gaps you find — make the changes directly, do not just describe them`,
    `4. After fixing any issues, produce a brief evaluation report summarizing:`,
    `   - What was implemented correctly`,
    `   - What issues were found and fixed during this evaluation`,
    `   - Any remaining items that could not be addressed automatically`,
    ``,
    `Be thorough but focused. Fix real issues, don't just describe them.`,
  ].join('\n');
}

function buildBugEvaluationPrompt(task: Task, researchContent: string): string {
  return [
    `You have completed the initial bug fix. Now verify your work against the diagnosis document.`,
    ``,
    `## Bug: ${task.title}`,
    `Description: ${task.description || '(none)'}`,
    ``,
    `## Diagnosis Document`,
    researchContent,
    ``,
    `## Instructions`,
    `1. Follow the verification steps from the diagnosis document`,
    `2. Confirm the root cause identified in the diagnosis has been addressed`,
    `3. Check for any regressions or edge cases mentioned in the diagnosis`,
    `4. Fix any remaining issues you find — make the changes directly`,
    `5. Produce a brief verification report summarizing what you checked and the results`,
    ``,
    `Be thorough. If any verification step fails, fix the issue before reporting.`,
  ].join('\n');
}
```

### Step 3: Update Lifecycle UI

**`src/app/features/tasks/task-detail/task-detail.component.ts`:**

Add to the `lifecycleLabel` getter:

```typescript
case 'evaluating': return 'Evaluating implementation...';
```

**`src/app/features/tasks/task-detail/task-detail.component.html`:**

Update the lifecycle steps section (lines 316-332). The steps become:

```html
<div class="lifecycle-steps">
  <span class="step" [class.active]="lifecyclePhase === 'creating_worktree'" 
        [class.done]="isPhaseAfter('creating_worktree')">
    <mat-icon>{{ phaseIcon('creating_worktree') }}</mat-icon> Worktree
  </span>
  <span class="step" [class.active]="lifecyclePhase === 'installing_deps'" 
        [class.done]="isPhaseAfter('installing_deps')">
    <mat-icon>{{ phaseIcon('installing_deps') }}</mat-icon> Deps
  </span>
  <span class="step" [class.active]="lifecyclePhase === 'implementing'" 
        [class.done]="isPhaseAfter('implementing')">
    <mat-icon>{{ phaseIcon('implementing') }}</mat-icon> Implement
  </span>
  <span class="step" [class.active]="lifecyclePhase === 'evaluating'" 
        [class.done]="isPhaseAfter('evaluating')">
    <mat-icon>{{ phaseIcon('evaluating') }}</mat-icon> Evaluate
  </span>
  <span class="step" [class.active]="lifecyclePhase === 'committing'" 
        [class.done]="isPhaseAfter('committing')">
    <mat-icon>{{ phaseIcon('committing') }}</mat-icon> Commit
  </span>
  <span class="step" [class.active]="lifecyclePhase === 'creating_pr'">
    <mat-icon>{{ phaseIcon('creating_pr') }}</mat-icon> PR
  </span>
</div>
```

The existing inline phase-check logic is duplicated per step and hard to maintain. Consider adding a helper:

```typescript
private readonly phaseOrder = [
  'creating_worktree', 'installing_deps', 'implementing',
  'evaluating', 'committing', 'creating_pr'
];

isPhaseAfter(phase: string): boolean {
  if (!this.lifecyclePhase) return false;
  return this.phaseOrder.indexOf(this.lifecyclePhase) > this.phaseOrder.indexOf(phase);
}

phaseIcon(phase: string): string {
  if (this.lifecyclePhase === phase) return 'sync';
  if (this.isPhaseAfter(phase)) return 'check_circle';
  return 'radio_button_unchecked';
}
```

### Step 4: Update Completion State Display

**`src/app/features/tasks/task-detail/task-detail.component.html`:**

The implementation-complete section (line 339) currently checks `task()!.state === 'done'`. It should also check for `review`:

```diff
-} @else if (task()!.state === 'done' && task()!.implementAgentId) {
+} @else if ((task()!.state === 'done' || task()!.state === 'review') && task()!.implementAgentId) {
```

The heading and description should vary:

```html
@if (task()!.state === 'review') {
  <mat-icon class="complete-icon" style="color: #06b6d4">rate_review</mat-icon>
  <h3>Ready for Review</h3>
  <p>The agent has implemented and self-evaluated this task. Please review the PR.</p>
} @else {
  <mat-icon class="complete-icon">check_circle</mat-icon>
  <h3>Implementation Complete</h3>
  <p>The agent has finished implementing this task.</p>
}
```

Add a "Mark as Done" button for tasks in `review` state:

```html
@if (task()!.state === 'review') {
  <button mat-flat-button color="primary" (click)="markDone()">
    <mat-icon>check_circle</mat-icon>
    Approve & Mark Done
  </button>
}
```

```typescript
markDone(): void {
  const t = this.task();
  if (!t) return;
  const updates: { task: Task; state: TaskState; closeReason?: BugCloseReason } = { task: t, state: 'done' };
  if (t.kind === 'bug') updates.closeReason = 'fixed';
  this.stateChanged.emit(updates);
}
```

---

## Key Considerations

### 1. Evaluation Only When Research Exists

The self-evaluation step is **conditional** — it only fires when `researchContent` is present. Tasks without research go through the existing flow (minus the state change from `done` to `review`). This avoids an awkward evaluation prompt with no reference material.

### 2. Intermediate Commit Before Evaluation

The agent's initial implementation should be committed before the evaluation prompt so that:
- The evaluation step can see the actual code changes via `git diff`
- If the evaluation prompt fails (error, crash), the initial implementation is preserved
- The evaluation's fixes are a separate commit, making the PR history clear

### 3. Evaluation Response Capture

The `onComplete` callback receives the `StreamingMessage` which includes `message.content` — the full text response from the agent. This is the evaluation report that gets embedded in the PR body.

**Important:** The `processManagerService.onComplete` callback receives the message object. The content buffer contains the agent's full response text. This is currently available in the existing pattern — see line 817 where `async (message)` is already destructured (though currently unused in the body).

### 4. Error Handling

If the evaluation prompt fails:
- The `catch` on `sendMessage` should fall through to `proceedToFinalize()` without an evaluation report
- The implementation is still committed and PR'd — just without the evaluation
- A warning lifecycle event should be emitted

### 5. The `review` State Semantics

| Scenario | State After Implementation |
|----------|--------------------------|
| Implementation + evaluation (research exists) | `review` |
| Implementation without research | `review` |
| Manual state change by user | Any state (user always has control) |
| User approves PR | User clicks "Mark as Done" → `done` |

### 6. Backward Compatibility

- Existing tasks in `done` state are unaffected
- The `review` state is purely additive — no migration needed
- Tasks already completed won't retroactively change state
- The state dropdown allows manual transition to any state, including `done`

### 7. Filter Behavior

The `filteredTasks` computed in `task.service.ts` hides `done` tasks by default. The `review` state should remain visible (it's a state that requires user attention). Current logic:

```typescript
// Hides done unless explicitly filtered
if (!filterState && t.state === 'done') return false;
```

Since `review !== 'done'`, review tasks will naturally be visible. No change needed.

---

## Edge Cases

| Edge Case | Handling |
|-----------|----------|
| Agent produces no content in evaluation | `evaluationReport` is empty string → PR body omits report section |
| Agent crashes during evaluation | `catch` block calls `proceedToFinalize()` without report |
| Task has no worktree (worktrees disabled) | Evaluation still runs (agent can evaluate in main dir), but no intermediate commit |
| Research content is very large | Prompt may hit context limits — consider truncating to last N chars |
| Agent makes no changes during evaluation | Second commit is a no-op (gitWorktreeService.commitChanges returns false) |
| User manually creates PR before evaluation completes | `pushAndCreatePR` may fail — handled by existing error path |
| User cancels during evaluation | Existing cancel flow kills the process — evaluation aborts, task stays in `in_progress` |

---

## File References

### Files to Modify

| File | Changes | Lines |
|------|---------|-------|
| `src/shared/types/task.types.ts` | Add `'review'` to `TaskState`, add entry to `TASK_STATES` | L5, L7-13 |
| `src/main/ipc/index.ts` | Rewrite `onComplete` callback in `TASKS_RUN_IMPLEMENTATION`, add evaluation prompt builders | L817-882 |
| `src/app/features/tasks/task-detail/task-detail.component.ts` | Add `'evaluating'` to `lifecycleLabel`, add `markDone()`, add phase helpers | L336-346, new methods |
| `src/app/features/tasks/task-detail/task-detail.component.html` | Add Evaluate step to lifecycle stepper, update completion state condition, add "Mark Done" button | L316-332, L339, new block |

### Files for Reference (Read Only)

| File | Why |
|------|-----|
| `src/main/ipc/index.ts` L603-615 | Research follow-up prompt pattern (re-prompt after `onComplete`) |
| `src/main/services/process-manager.service.ts` L506-527 | `onComplete` subscription pattern |
| `src/app/core/services/task.service.ts` | `filteredTasks` logic — verify `review` is visible |

---

## Complexity Estimate

| Component | Lines Changed (est.) | Risk |
|-----------|---------------------|------|
| `TaskState` + `TASK_STATES` addition | ~5 | Very Low |
| `onComplete` rewrite with evaluation chain | ~80-100 | Medium |
| Evaluation prompt builder functions | ~40 | Low |
| Lifecycle stepper UI update (+ helpers) | ~30 | Low |
| Completion state display update | ~20 | Low |
| `markDone()` method + button | ~10 | Very Low |
| **Total** | **~185-205** | **Medium** |

### Dependencies
- No new packages
- No database migration (TEXT column accepts any state string)
- No new IPC channels needed

---

## Recommended Implementation Order

1. **Add `review` state** to `TaskState` and `TASK_STATES` — smallest, safest change, immediately testable in UI
2. **Add evaluation prompt builder functions** — pure functions, can be tested in isolation
3. **Rewrite `onComplete` callback** — the core logic change; includes:
   - Intermediate commit
   - Conditional evaluation re-prompt
   - Capture evaluation report
   - PR body enrichment
   - State transition to `review`
4. **Add `evaluating` lifecycle phase** to the `lifecycleLabel` getter
5. **Update lifecycle stepper** in the template to show 6 steps instead of 5
6. **Update completion condition** in template from `state === 'done'` to include `review`
7. **Add "Approve & Mark Done" button** and `markDone()` method for `review` state
8. **Test full flow** — run implementation on a task with research, verify:
   - Agent implements → commits → evaluates → fixes → commits again → PR created → task in `review`
   - PR body includes evaluation report
   - User can approve → `done`
