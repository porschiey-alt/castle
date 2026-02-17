/**
 * Agent Dialog Component - Create or edit an agent
 */

import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

import { AgentIconComponent } from '../agent-icon/agent-icon.component';
import type { CastleAgentConfig } from '../../../../shared/types/agent.types';
import { BUILTIN_AGENT_COLORS, AGENT_MATERIAL_ICONS, AGENT_EMOJI_OPTIONS } from '../../../../shared/constants';

export interface AgentDialogData {
  agent?: CastleAgentConfig;
}

export type AgentDialogResult =
  | { action: 'save'; agent: CastleAgentConfig }
  | { action: 'delete' };

@Component({
  selector: 'app-agent-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatMenuModule,
    AgentIconComponent,
  ],
  template: `
    <h2 mat-dialog-title>{{ isEditing ? 'Edit Agent' : 'New Agent' }}</h2>
    <mat-dialog-content>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Name</mat-label>
        <input matInput [(ngModel)]="name" placeholder="Agent name" autofocus />
      </mat-form-field>

      <div class="icon-color-row">
        <div class="icon-picker-field">
          <label class="icon-picker-label">Icon</label>
          <button mat-stroked-button [matMenuTriggerFor]="iconMenu" class="icon-preview-btn"
                  type="button">
            <app-agent-icon [icon]="icon || 'mat:smart_toy'" />
            <mat-icon class="dropdown-arrow">arrow_drop_down</mat-icon>
          </button>

          <mat-menu #iconMenu="matMenu" class="icon-picker-menu">
            <div class="icon-grid" (click)="$event.stopPropagation()">
              <div class="icon-section-label">Material Icons</div>
              <div class="icon-options">
                @for (mi of materialIconOptions; track mi) {
                  <button mat-icon-button type="button"
                          (click)="selectIcon('mat:' + mi)"
                          [class.selected]="icon === 'mat:' + mi"
                          [attr.aria-label]="mi">
                    <mat-icon>{{ mi }}</mat-icon>
                  </button>
                }
              </div>
              <div class="icon-section-label">Emoji</div>
              <div class="icon-options">
                @for (em of emojiOptions; track em) {
                  <button mat-icon-button type="button"
                          (click)="selectIcon(em)"
                          [class.selected]="icon === em"
                          [attr.aria-label]="em">
                    {{ em }}
                  </button>
                }
              </div>
              <mat-form-field appearance="outline" class="custom-emoji-field">
                <mat-label>Custom emoji</mat-label>
                <input matInput [(ngModel)]="customEmoji" placeholder="Paste emoji..."
                       (ngModelChange)="onCustomEmojiChange($event)" />
              </mat-form-field>
            </div>
          </mat-menu>
        </div>

        <mat-form-field appearance="outline" class="color-field">
          <mat-label>Color</mat-label>
          <input matInput [(ngModel)]="color" placeholder="#7C3AED" />
        </mat-form-field>
      </div>

      <div class="color-swatches">
        @for (c of colorOptions; track c) {
          <button
            type="button"
            class="color-swatch"
            [class.selected]="color === c"
            [style.background-color]="c"
            (click)="color = c"
            [attr.aria-label]="'Select color ' + c">
          </button>
        }
      </div>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Description</mat-label>
        <input matInput [(ngModel)]="description" placeholder="What this agent does" />
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>System Prompt (optional)</mat-label>
        <textarea matInput [(ngModel)]="systemPrompt" rows="6"
          placeholder="Custom instructions for this agent..."></textarea>
      </mat-form-field>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      @if (isEditing) {
        <button mat-button color="warn" class="delete-btn" (click)="remove()">
          <mat-icon>delete</mat-icon>
          Delete
        </button>
      }
      <span class="spacer"></span>
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button color="primary" [disabled]="!name.trim()" (click)="save()">
        {{ isEditing ? 'Save' : 'Add Agent' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    :host { display: block; }
    mat-dialog-content {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 420px;
    }
    .full-width { width: 100%; }
    .icon-color-row {
      display: flex;
      gap: 12px;
    }
    .icon-field { flex: 0 0 120px; }
    .icon-picker-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 0 0 auto;
    }
    .icon-picker-label {
      font-size: 12px;
      color: var(--text-secondary, rgba(255,255,255,0.7));
      margin-bottom: 2px;
    }
    .icon-preview-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 64px;
      height: 56px;
      font-size: 24px;
    }
    .icon-preview-btn app-agent-icon {
      font-size: 24px;
    }
    .icon-preview-btn mat-icon.dropdown-arrow {
      font-size: 18px;
      width: 18px;
      height: 18px;
    }
    .color-field { flex: 1; }
    .color-swatches {
      display: flex;
      gap: 6px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .color-swatch {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 2px solid transparent;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .color-swatch:hover { border-color: rgba(255,255,255,0.5); }
    .color-swatch.selected { border-color: #fff; }
    textarea { font-family: 'Fira Code', monospace; font-size: 13px; }
    mat-dialog-actions .delete-btn { margin-right: auto; }
    .spacer { flex: 1; }
  `]
})
export class AgentDialogComponent {
  data = inject<AgentDialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject(MatDialogRef<AgentDialogComponent>);

  isEditing = !!this.data.agent;
  name = this.data.agent?.name ?? '';
  icon = this.data.agent?.icon ?? '';
  color = this.data.agent?.color ?? BUILTIN_AGENT_COLORS[0];
  description = this.data.agent?.description ?? '';
  systemPrompt = this.data.agent?.systemPrompt ?? '';

  colorOptions = [...BUILTIN_AGENT_COLORS];
  materialIconOptions = [...AGENT_MATERIAL_ICONS];
  emojiOptions = [...AGENT_EMOJI_OPTIONS];
  customEmoji = '';

  selectIcon(value: string): void {
    this.icon = value;
  }

  onCustomEmojiChange(value: string): void {
    if (value) {
      this.icon = value;
    }
  }

  save(): void {
    if (!this.name.trim()) return;
    this.dialogRef.close({
      action: 'save',
      agent: {
        name: this.name.trim(),
        icon: this.icon || undefined,
        color: this.color || undefined,
        description: this.description || undefined,
        systemPrompt: this.systemPrompt || undefined,
      },
    } as AgentDialogResult);
  }

  remove(): void {
    this.dialogRef.close({ action: 'delete' } as AgentDialogResult);
  }
}
