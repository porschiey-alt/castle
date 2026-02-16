/**
 * Task Form Dialog - Create or edit a task
 */

import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';

import { TASK_STATES, TASK_KINDS, type Task, type TaskLabel, type TaskState, type TaskKind } from '../../../../shared/types/task.types';

export interface TaskFormDialogData {
  task?: Task;
  labels: TaskLabel[];
}

export interface TaskFormDialogResult {
  title: string;
  description: string;
  state: TaskState;
  kind: TaskKind;
  labelIds: string[];
}

@Component({
  selector: 'app-task-form-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatIconModule,
    MatChipsModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ data.task ? 'Edit Task' : 'New Task' }}</h2>
    <mat-dialog-content>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Title</mat-label>
        <input matInput [(ngModel)]="title" placeholder="Task title" autofocus />
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Description (Markdown supported)</mat-label>
        <textarea matInput [(ngModel)]="description" rows="8" placeholder="Describe the task..."></textarea>
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>State</mat-label>
        <mat-select [(ngModel)]="state">
          @for (s of states; track s.id) {
            <mat-option [value]="s.id">
              <mat-icon [style.color]="s.color">{{ s.icon }}</mat-icon>
              {{ s.label }}
            </mat-option>
          }
        </mat-select>
      </mat-form-field>

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

      @if (data.labels.length > 0) {
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Labels</mat-label>
          <mat-select [(ngModel)]="selectedLabelIds" multiple>
            @for (label of data.labels; track label.id) {
              <mat-option [value]="label.id">
                <span class="label-dot" [style.background-color]="label.color"></span>
                {{ label.name }}
              </mat-option>
            }
          </mat-select>
        </mat-form-field>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button color="primary" [disabled]="!title.trim()" (click)="save()">
        {{ data.task ? 'Save' : 'Create' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    :host { display: block; }
    mat-dialog-content { display: flex; flex-direction: column; gap: 4px; min-width: 420px; }
    .full-width { width: 100%; }
    textarea { font-family: 'Fira Code', monospace; font-size: 13px; }
    .label-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
    mat-icon { font-size: 18px; width: 18px; height: 18px; vertical-align: middle; margin-right: 4px; }
  `]
})
export class TaskFormDialogComponent {
  data = inject<TaskFormDialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject(MatDialogRef<TaskFormDialogComponent>);

  states = TASK_STATES;
  kinds = TASK_KINDS;
  title = this.data.task?.title ?? '';
  description = this.data.task?.description ?? '';
  state: TaskState = this.data.task?.state ?? 'new';
  kind: TaskKind = this.data.task?.kind ?? 'feature';
  selectedLabelIds: string[] = this.data.task?.labels?.map(l => l.id) ?? [];

  save(): void {
    if (!this.title.trim()) return;
    this.dialogRef.close({
      title: this.title.trim(),
      description: this.description,
      state: this.state,
      kind: this.kind,
      labelIds: this.selectedLabelIds,
    } as TaskFormDialogResult);
  }
}
