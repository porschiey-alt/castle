/**
 * Permission Dialog Component - Shows ACP permission request from Copilot
 */

import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

export interface PermissionDialogData {
  requestId: string;
  agentId: string;
  agentName: string;
  toolCall: {
    title?: string;
    toolCallId: string;
    kind?: string | null;
    locations?: Array<{ path: string; line?: number | null }> | null;
    rawInput?: unknown;
  };
  options: Array<{
    optionId: string;
    name: string;
    kind: string;
  }>;
}

@Component({
  selector: 'app-permission-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule
  ],
  templateUrl: './permission-dialog.component.html',
  styleUrl: './permission-dialog.component.scss'
})
export class PermissionDialogComponent {
  constructor(
    private dialogRef: MatDialogRef<PermissionDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: PermissionDialogData
  ) {}

  selectOption(optionId: string): void {
    this.dialogRef.close(optionId);
  }

  getToolKindIcon(kind: string): string {
    switch (kind) {
      case 'read': return 'visibility';
      case 'edit': return 'edit';
      case 'delete': return 'delete';
      case 'move': return 'drive_file_move';
      case 'search': return 'search';
      case 'execute': return 'terminal';
      case 'fetch': return 'cloud_download';
      default: return 'build';
    }
  }

  formatRawInput(rawInput: unknown): string {
    if (typeof rawInput === 'string') return rawInput;
    try {
      return JSON.stringify(rawInput, null, 2);
    } catch {
      return String(rawInput);
    }
  }

  getIcon(kind: string): string {
    switch (kind) {
      case 'allow_always': return 'check_circle';
      case 'allow_once': return 'check';
      case 'reject_once': return 'block';
      case 'reject_always': return 'cancel';
      default: return 'help';
    }
  }

  getColor(kind: string): string {
    return kind.startsWith('allow') ? 'primary' : 'warn';
  }
}
