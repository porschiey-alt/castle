

Now I have comprehensive understanding. Let me produce the research document.Here is the research document:

---

# Research: Adding Task Kinds (Bug Type Support)

## Problem Statement

The Castle task system currently has **no concept of task kinds/types** (e.g., bug, feature, chore, story). Tasks only have a **workflow state** (`new`, `active`, `in_progress`, `blocked`, `done`) and optional **labels** for freeform categorization. There is no first-class way to distinguish a bug from a feature request or any other work item type.

## Current Architecture

### Task Data Model (`src\shared\types\task.types.ts`)

```typescript
export interface Task {
  id: string;
  title: string;
  description: string;
  state: TaskState;         // workflow state only
  labels: TaskLabel[];      // freeform tags
  researchContent?: string;
  researchAgentId?: string;
  githubIssueNumber?: number;
  githubRepo?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

**Missing:** No `kind` field. The `state` field is a workflow status, not a categorization of the type of work.

### Task States (the only structured categorization)

| State         | Icon                  | Color   |
|---------------|-----------------------|---------|
| `new`         | `fiber_new`           | #3b82f6 |
| `active`      | `radio_button_checked`| #8b5cf6 |
| `in_progress` | `play_circle`         | #f59e0b |
| `blocked`     | `block`               | #ef4444 |
| `done`        | `check_circle`        | #22c55e |

### Database Schema (`src\main\services\database.service.ts`)

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'new',
  research_content TEXT,
  research_agent_id TEXT,
  github_issue_number INTEGER,
  github_repo TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

**Missing:** No `kind` column.

### Affected Layers (Full Stack)

| Layer | File | Impact |
|-------|------|--------|
| **Shared Types** | `src\shared\types\task.types.ts` | Add `TaskKind` type, `TASK_KINDS` constant, update `Task` interface |
| **Shared IPC** | `src\shared\types\ipc.types.ts` | Update `CreateTaskInput` payload to include `kind` |
| **Database** | `src\main\services\database.service.ts` | Add `kind` column, update CRUD queries |
| **Frontend Service** | `src\app\core\services\task.service.ts` | Update filter capabilities, pass `kind` through |
| **Task Form Dialog** | `src\app\features\tasks\task-form-dialog\task-form-dialog.component.ts` | Add kind selector to form |
| **Task List** | `src\app\features\tasks\task-list\task-list.component.ts` | Add kind filter, display kind badge |
| **Task Detail** | `src\app\features\tasks\task-detail\task-detail.component.ts` | Display and edit kind |

## Proposed Approach

### Option A: First-Class `TaskKind` Field (Recommended)

Add a structured `kind` field to tasks, parallel to how `TaskState` works today — a union type with a matching constant array providing icons, colors, and labels.

#### Proposed Task Kinds

```typescript
export type TaskKind = 'feature' | 'bug' | 'chore' | 'spike';

export const TASK_KINDS: { id: TaskKind; label: string; icon: string; color: string }[] = [
  { id: 'feature', label: 'Feature', icon: 'star', color: '#3b82f6' },
  { id: 'bug', label: 'Bug', icon: 'bug_report', color: '#ef4444' },
  { id: 'chore', label: 'Chore', icon: 'build', color: '#6b7280' },
  { id: 'spike', label: 'Spike', icon: 'science', color: '#8b5cf6' },
];
```

#### Why Recommended
- Mirrors the proven `TaskState` pattern already in the codebase
- Provides consistent UI treatment (icon + color per kind)
- Enables filtering tasks by kind (e.g., "show me all bugs")
- Database column allows efficient queries
- Clean separation: **kind** = "what type of work" vs **state** = "where in the workflow"

### Option B: Use Labels as Pseudo-Kinds

Create predefined labels like "bug", "feature", etc. and treat them as kinds.

#### Why Not Recommended
- Labels are freeform — no schema enforcement
- No guaranteed icon/color consistency
- Users can delete or rename "bug" label
- Filtering by kind requires label name matching (fragile)
- Conflates categorization with tagging

## Implementation Plan

### Step 1: Shared Types (`src\shared\types\task.types.ts`)

```typescript
// Add after TaskState definitions
export type TaskKind = 'feature' | 'bug' | 'chore' | 'spike';

export const TASK_KINDS: { id: TaskKind; label: string; icon: string; color: string }[] = [
  { id: 'feature', label: 'Feature', icon: 'star', color: '#3b82f6' },
  { id: 'bug', label: 'Bug', icon: 'bug_report', color: '#ef4444' },
  { id: 'chore', label: 'Chore', icon: 'build', color: '#6b7280' },
  { id: 'spike', label: 'Spike', icon: 'science', color: '#8b5cf6' },
];

// Update Task interface
export interface Task {
  // ... existing fields
  kind: TaskKind;  // NEW
}

// Update CreateTaskInput
export type CreateTaskInput = Pick<Task, 'title' | 'description' | 'state' | 'kind'> & {
  labelIds?: string[];
};

// Update UpdateTaskInput  
export type UpdateTaskInput = Partial<Pick<Task, 'title' | 'description' | 'state' | 'kind' | 'researchContent' | 'researchAgentId'>> & {
  labelIds?: string[];
};
```

### Step 2: Database Migration (`src\main\services\database.service.ts`)

Add column to existing table (SQLite ALTER TABLE):

```sql
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'feature';
```

This should be added as a migration step in the `initializeDatabase()` method, after the initial CREATE TABLE. Existing tasks will default to `'feature'`.

Update CRUD queries:
- **createTask**: Include `kind` in INSERT
- **updateTask**: Include `kind` in UPDATE SET clause
- **getTasks**: Include `kind` in SELECT, add optional `kind` filter parameter

### Step 3: IPC Types (`src\shared\types\ipc.types.ts`)

Update the `TASKS_GET_ALL` request to accept optional `kind` filter:

```typescript
[IPC_CHANNELS.TASKS_GET_ALL]: {
  request: { state?: string; kind?: string };
  response: Task[];
};
```

### Step 4: Task Form Dialog

Add a kind selector dropdown (similar to the existing state selector):

```html
<mat-form-field appearance="outline" class="full-width">
  <mat-label>Kind</mat-label>
  <mat-select [(ngModel)]="kind">
    @for (k of kinds; track k.id) {
      <mat-option [value]="k.id">
        <mat-icon [style.color]="k.color">{{ k.icon }}</mat-icon>
        {{ k.label }}
      </mat-option>
    }
  </mat-select>
</mat-form-field>
```

### Step 5: Task List Component

- Add kind filter buttons alongside existing state filters
- Display kind icon/badge on each task card
- Support combined filtering (state + kind)

### Step 6: Task Detail Component

- Display the kind with icon and color
- Allow kind editing (same pattern as state editing)

## Considerations

### Backward Compatibility
- Existing tasks in the database have no `kind` column. The `ALTER TABLE ... DEFAULT 'feature'` migration handles this gracefully.
- All existing functionality continues to work — `kind` is additive.

### Default Kind
- New tasks should default to `'feature'` (most common work item type).
- The form dialog should pre-select `'feature'` when creating a new task.

### GitHub Issue Sync
- Tasks with `githubIssueNumber` may have GitHub labels indicating bug vs feature. A future enhancement could auto-map GitHub labels to task kinds during sync.

### Extensibility
- The `TaskKind` union type is easy to extend with new kinds (e.g., `'epic'`, `'tech-debt'`, `'test'`).
- The `TASK_KINDS` constant array pattern means adding a new kind only requires one entry.

### UI/UX
- Kind and state serve different purposes and should be visually distinct in the UI.
- Kind = what it is (icon badge). State = where it is in the workflow (status indicator).
- Consider using the kind icon as a prefix on task cards for quick visual scanning.

### Migration Safety
- SQLite supports `ALTER TABLE ADD COLUMN` with defaults — this is safe for existing databases.
- No data loss risk.

## Files to Modify (Summary)

| # | File | Change |
|---|------|--------|
| 1 | `src\shared\types\task.types.ts` | Add `TaskKind`, `TASK_KINDS`, update interfaces |
| 2 | `src\shared\types\ipc.types.ts` | Update `TASKS_GET_ALL` request type |
| 3 | `src\main\services\database.service.ts` | Add migration, update CRUD |
| 4 | `src\app\core\services\task.service.ts` | Add kind filter support |
| 5 | `src\app\features\tasks\task-form-dialog\task-form-dialog.component.ts` | Add kind selector |
| 6 | `src\app\features\tasks\task-list\task-list.component.ts` | Add kind display + filter |
| 7 | `src\app\features\tasks\task-detail\task-detail.component.ts` | Add kind display + edit |

## Estimated Complexity

**Low-Medium.** The change follows an established pattern (`TaskState` / `TASK_STATES`) and touches well-defined layers. No architectural changes needed — this is a new field propagated through existing plumbing.