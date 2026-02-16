# Windows Confirmation Dialog → Modal

## Diagnosis and Suggested Fix

### Symptoms

When certain actions are triggered in the app (deleting a task, or cleaning up a diagnosis file), a **native OS confirmation dialog** (`window.confirm(...)`) appears. On Windows this manifests as a system-level browser dialog box that:

- Appears **outside** the Electron app window (or as a detached modal chrome dialog).
- Breaks the visual continuity of the application.
- Cannot be styled or themed to match the app's Material Design look and feel.
- Blocks the JavaScript thread synchronously.

### Root Cause Analysis

Two calls to the native `confirm()` function exist in **`src/app/features/tasks/task-list/task-list.component.ts`**:

| Line | Context | Code |
|------|---------|------|
| **64** | Diagnosis-file cleanup prompt (in `ngOnInit`) | `confirm(\`This bug has a diagnosis file:\n${data.filePath}\n\nWould you like to delete it?\`)` |
| **137** | Delete-task confirmation (in `deleteTask`) | `confirm(\`Delete task "${task.title}"?\`)` |

These are the **only** two occurrences in the entire `src/` tree. No `window.alert()` or `window.prompt()` calls were found.

The native `confirm()` is a synchronous, blocking browser API. In an Electron app it renders as a Windows system dialog, which is jarring and inconsistent with the rest of the UI that uses Angular Material (`MatDialog`).

### Suggested Fix

Create a **reusable `ConfirmDialogComponent`** using `MatDialog` (already a dependency—used by `PermissionDialogComponent`, `TaskFormDialogComponent`, and `AboutDialogComponent`), then replace both `confirm()` calls.

#### 1. Create `src/app/shared/components/confirm-dialog/confirm-dialog.component.ts`

```typescript
import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

export interface ConfirmDialogData {
  title?: string;        // Dialog title (default: "Confirm")
  message: string;       // Body text / question
  confirmText?: string;  // Confirm button label (default: "OK")
  cancelText?: string;   // Cancel button label (default: "Cancel")
  warn?: boolean;        // If true, confirm button uses warn color
}

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>{{ data.title || 'Confirm' }}</h2>
    <mat-dialog-content>
      <p style="white-space: pre-line">{{ data.message }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>{{ data.cancelText || 'Cancel' }}</button>
      <button mat-raised-button
              [color]="data.warn ? 'warn' : 'primary'"
              (click)="dialogRef.close(true)">
        {{ data.confirmText || 'OK' }}
      </button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDialogComponent {
  constructor(
    public dialogRef: MatDialogRef<ConfirmDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: ConfirmDialogData
  ) {}
}
```

#### 2. Update `task-list.component.ts`

Add imports:

```typescript
import { MatDialog } from '@angular/material/dialog';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../../shared/components/confirm-dialog/confirm-dialog.component';
import { firstValueFrom } from 'rxjs';
```

Inject `MatDialog`:

```typescript
private dialog = inject(MatDialog);
```

**Replace line 64** (diagnosis cleanup):

```typescript
// Before
if (confirm(`This bug has a diagnosis file:\n${data.filePath}\n\nWould you like to delete it?`)) {

// After
const ref = this.dialog.open(ConfirmDialogComponent, {
  data: {
    title: 'Delete Diagnosis File',
    message: `This bug has a diagnosis file:\n${data.filePath}\n\nWould you like to delete it?`,
    confirmText: 'Delete',
    warn: true,
  } as ConfirmDialogData,
  width: '420px',
});
const confirmed = await firstValueFrom(ref.afterClosed());
if (confirmed) {
```

**Replace line 137** (delete task):

```typescript
// Before
if (confirm(`Delete task "${task.title}"?`)) {

// After
const ref = this.dialog.open(ConfirmDialogComponent, {
  data: {
    title: 'Delete Task',
    message: `Delete task "${task.title}"?`,
    confirmText: 'Delete',
    warn: true,
  } as ConfirmDialogData,
  width: '380px',
});
const confirmed = await firstValueFrom(ref.afterClosed());
if (confirmed) {
```

Both call sites are already in `async` functions, so `await` works without further refactoring.

### Verification Steps

1. **Search for remaining native dialogs** — run `grep -rn "confirm\s*(" src/ --include="*.ts"` and confirm zero hits (excluding test files and unrelated identifiers).
2. **Delete-task flow** — click the delete action on a task → verify an in-app Material dialog appears with "Delete Task" title and styled Delete / Cancel buttons.
3. **Diagnosis cleanup flow** — close a bug that has a diagnosis file → verify an in-app Material dialog prompts for file deletion.
4. **Cancel behavior** — in both dialogs, clicking Cancel (or pressing Escape / clicking the backdrop) should dismiss the dialog and **not** perform the destructive action.
5. **Theming** — confirm the dialog respects the app's Material theme (dark/light mode, color palette).
6. **Build** — `npm run build` should complete without errors.
