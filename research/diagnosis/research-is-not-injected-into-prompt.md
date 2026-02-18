# Research Is Not Injected Into Implementation Prompt

## Diagnosis and Suggested Fix

### Symptoms

When a task has completed research (a research document exists on disk, e.g., `research/my-task.md`), and the user clicks "Implement" to hand the task to an agent, the agent does **not** receive the research document in its prompt. The agent proceeds to do its own investigation from scratch, which may deviate from the approved research findings.

The research document **does** appear correctly in the UI (the task detail page shows the research content), but it is not included in the implementation prompt sent to the Copilot CLI.

### Root Cause Analysis

**File:** `src/main/ipc/index.ts`, lines 681–800

The implementation handler fetches the task from the database at line 683:

```typescript
const task = await databaseService.getTask(taskId);
```

Then at lines 797–799 it conditionally includes research:

```typescript
if (task.researchContent) {
  prompt += `\n\nResearch Analysis:\n${task.researchContent}`;
}
```

**The problem:** `task.researchContent` is **always empty/undefined** at this point.

Here's why: the research system writes its output to a **file on disk** (e.g., `research/my-task.md` or `research/diagnosis/my-bug.md`). It does **not** save the content back to the database's `research_content` column. The column is defined in the schema (`database.service.ts`, line 148) and the update mechanism exists (`database.service.ts`, line 977), but no code ever calls `updateTask({ researchContent: ... })` after research completes.

The UI works correctly because the `TASKS_GET` and `TASKS_GET_ALL` IPC handlers call `hydrateResearchFromFile()` (lines 458, 465) which reads the file from disk and injects it into the returned task object:

```typescript
// line 461 — TASKS_GET handler
handle(IPC_CHANNELS.TASKS_GET, async (_event, { taskId }) => {
    const task = await databaseService.getTask(taskId);
    if (!task) return null;
    const projectPath = directoryService.getCurrentDirectory();
    return hydrateResearchFromFile(task, projectPath);  // ← reads file, populates researchContent
});
```

But the `TASKS_RUN_IMPLEMENTATION` handler (line 681) calls `databaseService.getTask(taskId)` **directly** — it never calls `hydrateResearchFromFile()`. Since the database column is empty, `task.researchContent` is `undefined`, and the `if` guard at line 797 skips the research injection entirely.

**Data flow summary:**

```
Research phase:
  Agent writes → research/my-task.md (file on disk)
  Database research_content column → NULL (never updated)

UI display (works):
  TASKS_GET → databaseService.getTask() → hydrateResearchFromFile() → reads file → researchContent populated ✓

Implementation (broken):
  TASKS_RUN_IMPLEMENTATION → databaseService.getTask() → researchContent is undefined → skipped ✗
```

### Suggested Fix (Applied)

Instead of injecting the full research content into the prompt (which bloats the context), point the agent at the research file on disk and let it read the document itself. The `getResearchFilePath` helper already computes the correct path.

**File:** `src/main/ipc/index.ts`, implementation prompt construction (line ~840)

Changed:

```typescript
if (task.researchContent) {
  prompt += `\n\nResearch Analysis:\n${task.researchContent}`;
}
```

To:

```typescript
const researchFilePath = getResearchFilePath(task, workingDirectory);
if (fs.existsSync(researchFilePath)) {
  prompt += `\n\nA research/analysis document has been prepared for this task. Read it before starting implementation:\n${researchFilePath}`;
}
```

This resolves both problems at once:
1. Research is no longer skipped (file existence is checked, not the empty DB column).
2. The prompt stays small — the agent reads the file itself using its tool capabilities.

### Verification Steps

1. **Create a task** and run research on it. Verify the research file is written to disk (e.g., `research/my-task.md`).
2. **Check the database** — confirm `research_content` is NULL for the task (this is expected and not the fix target).
3. **Click "Implement"** on the task.
4. **Verify the log output** — the implementation prompt logged at line 796 should now include the `Research Analysis:` section with the full content of the research file.
5. **Observe the agent's behavior** — it should reference the research findings rather than starting its own investigation.
6. **Test edge case: missing research file** — delete the research file, then implement. The agent should proceed without research (graceful degradation, no crash).
7. **Test edge case: bug-type task** — research files for bugs are stored in `research/diagnosis/`. Verify the correct path is resolved via `getResearchFilePath`.
8. **Test edge case: no working directory** — if `directoryService.getCurrentDirectory()` returns null, `hydrateResearchFromFile` returns the task unchanged (line 439). The implementation handler already throws at line 695 if there's no working directory, so this is a non-issue in practice.
