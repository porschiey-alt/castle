/**
 * GitHub Import Dialog - Select and import GitHub Issues as tasks
 */

import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TaskService } from '../../../core/services/task.service';

export interface GitHubImportDialogData {
  existingIssueNumbers: (number | undefined)[];
}

interface SelectableIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  url: string;
  selected: boolean;
  alreadyImported: boolean;
}

@Component({
  selector: 'app-github-import-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatIconModule,
    MatButtonModule,
    MatCheckboxModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>cloud_download</mat-icon>
      Import from GitHub Issues
    </h2>

    <mat-dialog-content>
      @if (loading) {
        <div class="loading">
          <mat-spinner diameter="36"></mat-spinner>
          <span>Loading issues...</span>
        </div>
      } @else if (error) {
        <div class="error">
          <mat-icon>error</mat-icon>
          <span>{{ error }}</span>
        </div>
      } @else if (issues.length === 0) {
        <div class="empty">
          <mat-icon>check_circle</mat-icon>
          <span>No open issues found, or all issues are already imported.</span>
        </div>
      } @else {
        <div class="issue-list">
          @for (issue of issues; track issue.number) {
            <label class="issue-row" [class.disabled]="issue.alreadyImported">
              <mat-checkbox
                [(ngModel)]="issue.selected"
                [disabled]="issue.alreadyImported">
              </mat-checkbox>
              <div class="issue-info">
                <span class="issue-title">
                  <span class="issue-number">#{{ issue.number }}</span>
                  {{ issue.title }}
                </span>
                @if (issue.alreadyImported) {
                  <span class="already-imported">Already imported</span>
                }
                @if (issue.labels.length > 0) {
                  <div class="issue-labels">
                    @for (label of issue.labels; track label) {
                      <span class="issue-label">{{ label }}</span>
                    }
                  </div>
                }
              </div>
            </label>
          }
        </div>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="dialogRef.close()">Cancel</button>
      <button mat-flat-button color="primary"
              [disabled]="!hasSelection || importing"
              (click)="doImport()">
        <mat-icon>cloud_download</mat-icon>
        {{ importing ? 'Importing...' : 'Import Selected' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    :host { display: block; }

    mat-dialog-content {
      min-height: 200px;
      max-height: 400px;
      overflow-y: auto;
    }

    h2[mat-dialog-title] {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .loading, .empty, .error {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 24px;
      justify-content: center;
      color: var(--text-muted);
    }

    .error { color: #ef4444; }

    .issue-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .issue-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 4px;
      border-radius: 6px;
      cursor: pointer;

      &:hover { background: var(--hover-bg, rgba(255,255,255,0.05)); }
      &.disabled {
        opacity: 0.5;
        cursor: default;
      }
    }

    .issue-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }

    .issue-title {
      font-size: 14px;
      color: var(--text-primary);
    }

    .issue-number {
      color: var(--text-muted);
      margin-right: 4px;
    }

    .already-imported {
      font-size: 11px;
      color: var(--text-muted);
      font-style: italic;
    }

    .issue-labels {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }

    .issue-label {
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 10px;
      background: rgba(255,255,255,0.08);
      color: var(--text-secondary, #aaa);
    }
  `]
})
export class GitHubImportDialogComponent implements OnInit {
  dialogRef = inject(MatDialogRef<GitHubImportDialogComponent>);
  private data: GitHubImportDialogData = inject(MAT_DIALOG_DATA);
  private taskService = inject(TaskService);

  issues: SelectableIssue[] = [];
  loading = true;
  error: string | null = null;
  importing = false;

  get hasSelection(): boolean {
    return this.issues.some(i => i.selected);
  }

  async ngOnInit(): Promise<void> {
    try {
      const existingNumbers = new Set(this.data.existingIssueNumbers?.filter(Boolean));
      const raw = await this.taskService.listGitHubIssues('open');
      this.issues = raw.map(issue => ({
        ...issue,
        selected: false,
        alreadyImported: existingNumbers.has(issue.number),
      }));
    } catch (err: any) {
      this.error = err.message || 'Failed to load issues';
    } finally {
      this.loading = false;
    }
  }

  async doImport(): Promise<void> {
    const selected = this.issues.filter(i => i.selected).map(i => i.number);
    if (!selected.length) return;
    this.importing = true;
    try {
      this.dialogRef.close(selected);
    } catch {
      this.importing = false;
    }
  }
}
