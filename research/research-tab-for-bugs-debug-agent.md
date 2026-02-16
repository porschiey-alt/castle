# Research: Research Tab for Bugs + Debug Agent

## Summary

This document analyzes how to introduce a **Debug Agent** to Castle and adapt the Research tab so that bug-type tasks use this agent by default, with output appended to the task description (as a `## Diagnosis and Suggested Fix` section) rather than written to the `/research` folder.

The changes touch four layers: the agent registry, the IPC research handler, the task-detail component's agent-selection logic, and the research prompt itself.

---

## Current Behavior

### Agent Discovery

Agents are defined in two places:

1. **`resources/agents.md`** - parsed by `AgentDiscoveryService` (`src/main/services/agent-discovery.service.ts`) using a `<!-- castle-config -->` YAML-like block.
2. **Fallback defaults** - `getDefaultAgents()` in the same file, used when no `agents.md` is found.

Current built-in agents: General Assistant, Code Reviewer, Test Writer, Documentation, Refactorer, Researcher. There is **no debug-focused agent**.

### Research Tab Flow

1. User opens a task, clicks the **Research** tab.
2. The `task-detail.component.ts` presents an agent picker. It groups agents into "Research Agents" (name/description contains "research") and "Other Agents". The default selection is the first research agent found.
3. User clicks **Start Research** which emits a `TaskResearchEvent`.
4. The parent component calls `TaskService.runResearch()` -> `ElectronService.runTaskResearch()` -> IPC channel `tasks:runResearch`.
5. In `src/main/ipc/index.ts`, the `TASKS_RUN_RESEARCH` handler:
   - Builds a generic research prompt (always the same, regardless of task kind).
   - Sends it to the agent via ACP.
   - On completion, saves the output to `task.researchContent` in the database **and** writes a `.md` file to the `/research` folder.

### Task Kind System

`TaskKind` is defined in `src/shared/types/task.types.ts` as: `'feature' | 'bug' | 'chore' | 'spike'`. The task kind is available on the `Task` object but **is not used anywhere in the research flow** - the prompt, agent selection, and output destination are all identical regardless of kind.

---

## Proposed Approach

### 1. Add the Debug Agent

**File: `resources/agents.md`** - Add a new agent entry inside the `<!-- castle-config -->` block:

```yaml
  - name: Debugger
    icon: 
    color: "#EF4444"
    description: Diagnoses bugs and suggests fixes
    systemPrompt: |
      You are a debugging specialist. Your job is to systematically diagnose
      issues and suggest precise fixes. When given a bug report, you should:
      - Reproduce the problem by tracing the code path described
      - Identify the root cause through systematic analysis
      - Examine relevant stack traces, error messages, and logs
      - Suggest where to add logging or breakpoints for further diagnosis
      - Propose a concrete fix with specific code changes
      - Consider edge cases and potential regressions from the fix
      Structure your output under a "## Diagnosis and Suggested Fix" heading
      with subsections for: Symptoms, Root Cause Analysis, Suggested Fix,
      and Verification Steps. Be precise and reference specific files and
      line numbers when possible.
```

**File: `src/main/services/agent-discovery.service.ts`** - Add a matching entry to `getDefaultAgents()` (the fallback when `agents.md` is missing):

```typescript
{
  id: uuidv4(),
  name: 'Debugger',
  description: 'Diagnoses bugs and suggests fixes',
  icon: '',
  color: '#EF4444',
  systemPrompt: `You are a debugging specialist...`, // same as above
  source: 'builtin'
}
```

### 2. Modify Agent Selection Defaults in the Research Tab

**File: `src/app/features/tasks/task-detail/task-detail.component.ts`**

Currently, the `defaultResearchAgentId` getter always picks the first agent whose name/description contains "research". It needs to be kind-aware:

```typescript
get debugAgents(): Agent[] {
  return this.agents().filter(a =>
    a.name.toLowerCase().includes('debug') ||
    a.description?.toLowerCase().includes('debug') ||
    a.description?.toLowerCase().includes('diagnos')
  );
}

get defaultResearchAgentId(): string {
  const t = this.task();

  // For bugs, prefer the debug agent
  if (t?.kind === 'bug') {
    const debug = this.debugAgents;
    if (debug.length > 0) return debug[0].id;
  }

  // For non-bugs, prefer research agents (existing behavior)
  const research = this.researchAgents;
  if (research.length > 0) return research[0].id;
  const all = this.agents();
  return all.length > 0 ? all[0].id : '';
}
```

The template's agent picker grouping should also be updated. When the task is a bug, "Debug Agents" should appear first in the dropdown instead of "Research Agents":

```html
<!-- In the research tab agent picker -->
@if (task()!.kind === 'bug' && debugAgents.length > 0) {
  <mat-optgroup label="Debug Agents">
    @for (a of debugAgents; track a.id) {
      <mat-option [value]="a.id">
        <span class="agent-option">{{ a.icon }} {{ a.name }}</span>
      </mat-option>
    }
  </mat-optgroup>
}
@if (researchAgents.length > 0) {
  <mat-optgroup label="Research Agents">
    @for (a of researchAgents; track a.id) {
      <mat-option [value]="a.id">
        <span class="agent-option">{{ a.icon }} {{ a.name }}</span>
      </mat-option>
    }
  </mat-optgroup>
}
@if (codingAgents.length > 0) {
  <mat-optgroup label="Other Agents">
    @for (a of codingAgents; track a.id) {
      <mat-option [value]="a.id">
        <span class="agent-option">{{ a.icon }} {{ a.name }}</span>
      </mat-option>
    }
  </mat-optgroup>
}
```

The `codingAgents` getter will also need updating to exclude debug agents so they don't appear in two groups.

### 3. Change the Research Prompt for Bugs

**File: `src/main/ipc/index.ts`** - The `TASKS_RUN_RESEARCH` handler currently builds a one-size-fits-all prompt. It needs to branch based on `task.kind`:

```typescript
let researchPrompt: string;

if (task.kind === 'bug') {
  researchPrompt = [
    `Diagnose the following bug and suggest a fix.`,
    ``,
    `Bug: ${task.title}`,
    ``,
    `Description:`,
    task.description || '(no description provided)',
    ``,
    `Systematically analyze this bug. Identify the root cause and propose a concrete fix.`,
    `Structure your output under a "## Diagnosis and Suggested Fix" heading with subsections`,
    `for: Symptoms, Root Cause Analysis, Suggested Fix, and Verification Steps.`,
    `Output ONLY the markdown content starting with the ## heading.`,
  ].join('\n');
} else {
  researchPrompt = `Research the following task and produce a detailed analysis document in Markdown format.\n\nTask: ${task.title}\n\nDescription:\n${task.description || '(no description provided)'}\n\nPlease provide a thorough research document covering technical analysis, proposed approach, considerations, and implementation guidance. Output ONLY the markdown document content.`;
}
```

### 4. Change the Output Destination for Bugs

**File: `src/main/ipc/index.ts`** - In the `onComplete` handler within `TASKS_RUN_RESEARCH`, the current behavior saves to both `researchContent` and a file. For bugs, the output should be appended to the task's `description` instead, and no file should be written:

```typescript
const onComplete = async (message: { content: string }) => {
  if (task.kind === 'bug') {
    // Append diagnosis to the task description
    const separator = task.description ? '\n\n' : '';
    const updatedDescription = (task.description || '') + separator + message.content;
    await databaseService.updateTask(taskId, {
      description: updatedDescription,
      researchContent: message.content,  // still cache it for the Research tab display
    });
  } else {
    // Existing behavior: save to researchContent + file
    await databaseService.updateTask(taskId, { researchContent: message.content });

    const fs = require('fs');
    const path = require('path');
    const researchDir = outputPath || path.join(workingDirectory, 'research');
    if (!fs.existsSync(researchDir)) {
      fs.mkdirSync(researchDir, { recursive: true });
    }
    const safeTitle = task.title.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
    const filePath = path.join(researchDir, `${safeTitle}.md`);
    fs.writeFileSync(filePath, message.content, 'utf-8');
    console.log(`[Research] Saved research to ${filePath}`);
  }

  // Notify renderer in both cases
  mainWindow.webContents.send(IPC_CHANNELS.CHAT_STREAM_COMPLETE, {
    id: taskId,
    agentId,
    role: 'assistant',
    content: message.content,
    timestamp: new Date()
  });
};
```

### 5. Update the `UpdateTaskInput` Type

The `description` field is already present in `UpdateTaskInput` (it uses `Partial<Pick<Task, 'title' | 'description' | ...>>`), so no type changes are needed. The `DatabaseService.updateTask` method already handles `description` updates. No changes needed here.

---

## File Change Summary

| File | Change | Complexity |
|------|--------|-----------|
| `resources/agents.md` | Add Debugger agent to castle-config block | Trivial |
| `src/main/services/agent-discovery.service.ts` | Add Debugger to `getDefaultAgents()` fallback | Trivial |
| `src/main/ipc/index.ts` | Branch prompt and output logic on `task.kind === 'bug'` | Low |
| `src/app/features/tasks/task-detail/task-detail.component.ts` | Add `debugAgents` getter; make `defaultResearchAgentId` kind-aware; update `codingAgents` to exclude debug agents | Low |
| `src/app/features/tasks/task-detail/task-detail.component.html` | Add debug agent group to the Research tab's agent picker | Low |

---

## Considerations

### Idempotency of Description Appending

If the user runs the debug research multiple times, the `## Diagnosis and Suggested Fix` section will be appended each time. Options to handle this:

1. **Replace existing section** - Before appending, check if `## Diagnosis and Suggested Fix` already exists in the description and replace everything from that heading onward. This is the cleanest approach:
   ```typescript
   const marker = '## Diagnosis and Suggested Fix';
   const existingIdx = (task.description || '').indexOf(marker);
   const baseDescription = existingIdx >= 0
     ? task.description!.substring(0, existingIdx).trimEnd()
     : (task.description || '');
   const updatedDescription = baseDescription + '\n\n' + message.content;
   ```
2. **Append with timestamp** - Keep all runs as a history. More verbose but preserves old diagnoses.

**Recommendation:** Option 1 (replace) is better since the diagnosis is meant to be the current analysis, not a log.

### Agent Filtering Logic

The current filtering is name/description-based (`includes('research')`). Adding `includes('debug')` follows the same pattern. This is fragile if users rename agents. A more robust approach would be to add a `role` or `capabilities` field to the `Agent` type (e.g., `capabilities: ['research']` or `capabilities: ['debug']`). However, that would be a larger refactor and is not necessary for this change.

### Research Tab Label for Bugs

When the task is a bug, the Research tab could be relabeled to "Diagnosis" to better reflect its purpose:

```html
<ng-template mat-tab-label>
  <mat-icon>{{ task()!.kind === 'bug' ? 'bug_report' : 'science' }}</mat-icon>
  <span class="tab-label-text">{{ task()!.kind === 'bug' ? 'Diagnosis' : 'Research' }}</span>
</ng-template>
```

This is optional but improves UX clarity.

### Research Tab Empty State for Bugs

The current empty state text says "Assign an agent to research this task. The output will be saved as a markdown document." For bugs, this should say something like "Assign an agent to diagnose this bug. The diagnosis will be appended to the task description."

### The `researchContent` Field for Bugs

Even though bug diagnoses go into the description, keeping a copy in `researchContent` is useful because:
- The Research/Diagnosis tab uses `task.researchContent` to display results (line 142 of the template: `@if (task()!.researchContent)`).
- It serves as a cache so the tab can show the diagnosis without parsing it back out of the description.

### System Prompt Interaction

The debug agent's `systemPrompt` and the IPC handler's prompt work together. The system prompt sets the agent's persona and approach; the IPC prompt provides the specific bug details. The agent (Copilot CLI) will combine both when generating a response. This is the same pattern used by the Researcher agent today.

---

## Implementation Steps

1. **Add the Debugger agent** to `resources/agents.md` inside the `<!-- castle-config -->` block, and to `getDefaultAgents()` in `agent-discovery.service.ts`.

2. **Update `task-detail.component.ts`**:
   - Add `debugAgents` getter (filter by "debug"/"diagnos" in name/description).
   - Make `defaultResearchAgentId` return the first debug agent when `task.kind === 'bug'`.
   - Update `codingAgents` to exclude debug agents.

3. **Update `task-detail.component.html`**:
   - Add debug agent group to the Research tab's agent picker.
   - Optionally rename the Research tab label to "Diagnosis" for bugs.
   - Optionally update the empty-state copy for bugs.

4. **Update `src/main/ipc/index.ts`** (`TASKS_RUN_RESEARCH` handler):
   - Branch the prompt based on `task.kind`.
   - Branch the `onComplete` handler: for bugs, append to description (replacing any existing diagnosis section); for non-bugs, keep existing file-write behavior.

5. **Test**: Create a bug task, open the Research tab, verify the Debugger agent is pre-selected, run it, and confirm the output appears in the task description under `## Diagnosis and Suggested Fix`.

---

## Risks

1. **Description field size** - Appending diagnosis to the description could make it very long. The database column is `TEXT` (unlimited in SQLite), so no technical limit, but the UI textarea and markdown renderer should handle large content gracefully. This is already the case since `researchContent` can be arbitrarily long too.

2. **Overwriting user edits** - If a user manually edits the `## Diagnosis and Suggested Fix` section and then re-runs diagnosis, their edits will be replaced. The replace-existing-section approach makes this an intentional trade-off.

3. **Agent naming fragility** - The debug agent detection relies on string matching against agent names/descriptions. If a user creates a workspace agent with "debug" in the name, it will be categorized as a debug agent. This is acceptable behavior since workspace agents should be able to override built-in roles.
