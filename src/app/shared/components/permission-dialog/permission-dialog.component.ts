/**
 * Permission Dialog Component - Shows ACP permission request from Copilot
 */

import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { FormsModule } from '@angular/forms';
import { deriveScopeOptions, ScopeOption } from '../../../../shared/utils/permission-matcher';

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

export interface PermissionDialogResult {
  optionId: string;
  scopeType?: string;
  scopeValue?: string;
}

@Component({
  selector: 'app-permission-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatRadioModule,
    FormsModule,
  ],
  templateUrl: './permission-dialog.component.html',
  styleUrl: './permission-dialog.component.scss'
})
export class PermissionDialogComponent {
  scopeOptions: ScopeOption[] = [];
  selectedScopeIndex = 0;

  constructor(
    private dialogRef: MatDialogRef<PermissionDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: PermissionDialogData
  ) {
    const toolKind = data.toolCall?.kind;
    if (toolKind) {
      this.scopeOptions = deriveScopeOptions(toolKind, data.toolCall?.locations, data.toolCall?.rawInput);
    }
  }

  selectOption(option: { optionId: string; kind: string }): void {
    const isAlways = option.kind === 'allow_always' || option.kind === 'reject_always';
    const scope = isAlways && this.scopeOptions.length > 0
      ? this.scopeOptions[this.selectedScopeIndex]
      : undefined;

    const result: PermissionDialogResult = {
      optionId: option.optionId,
      scopeType: scope?.scopeType,
      scopeValue: scope?.scopeValue,
    };
    this.dialogRef.close(result);
  }

  isAlwaysOption(kind: string): boolean {
    return kind === 'allow_always' || kind === 'reject_always';
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
