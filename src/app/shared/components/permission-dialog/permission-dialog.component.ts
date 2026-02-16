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
