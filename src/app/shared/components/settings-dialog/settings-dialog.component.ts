/**
 * Settings Dialog Component
 */

import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

import { ElectronService } from '../../../core/services/electron.service';
import { ApiService } from '../../../core/services/api.service';
import { DEFAULT_TAILSCALE_PORT } from '../../../../shared/constants';

@Component({
  selector: 'app-settings-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatSlideToggleModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './settings-dialog.component.html',
  styleUrl: './settings-dialog.component.scss'
})
export class SettingsDialogComponent implements OnInit {
  private electronService = inject(ElectronService);
  private apiService = inject(ApiService);
  private dialogRef = inject(MatDialogRef<SettingsDialogComponent>);

  /** True when running in the native Electron shell (not a remote browser) */
  get isElectron(): boolean {
    return this.apiService.isElectron;
  }

  tailscaleEnabled = false;
  tailscalePort = DEFAULT_TAILSCALE_PORT;
  tailscaleRunning = false;
  tailscaleError: string | null = null;
  saving = false;

  // Worktree settings
  worktreeEnabled = true;
  worktreeDefaultBaseBranch = 'main';
  worktreeDraftPR = false;
  worktreeMaxConcurrent = 5;
  worktreeAutoInstallDeps = true;

  async ngOnInit(): Promise<void> {
    const settings = await this.electronService.getSettings();
    if (settings) {
      this.tailscaleEnabled = settings.tailscaleEnabled ?? false;
      this.tailscalePort = settings.tailscalePort ?? DEFAULT_TAILSCALE_PORT;
      this.worktreeEnabled = settings.worktreeEnabled !== false;
      this.worktreeDefaultBaseBranch = settings.worktreeDefaultBaseBranch || 'main';
      this.worktreeDraftPR = settings.worktreeDraftPR ?? false;
      this.worktreeMaxConcurrent = settings.worktreeMaxConcurrent ?? 5;
      this.worktreeAutoInstallDeps = settings.worktreeAutoInstallDeps !== false;
    }
    const status = await this.electronService.getTailscaleStatus();
    this.tailscaleRunning = status.running;
  }

  async onToggle(): Promise<void> {
    this.saving = true;
    this.tailscaleError = null;

    await this.electronService.updateSettings({
      tailscaleEnabled: this.tailscaleEnabled,
      tailscalePort: this.tailscalePort,
    });

    if (this.tailscaleEnabled) {
      const result = await this.electronService.restartTailscale(this.tailscalePort);
      this.tailscaleRunning = result.running;
      if (result.error) {
        this.tailscaleError = result.error;
      }
    } else {
      // Stopping requires an app restart for now — settings are saved,
      // server won't start next launch. For immediate stop we restart with port 0
      // which the server handles as "stop".
      this.tailscaleRunning = false;
    }

    this.saving = false;
  }

  async applyPort(): Promise<void> {
    if (!this.tailscaleEnabled) return;
    this.saving = true;
    this.tailscaleError = null;

    await this.electronService.updateSettings({ tailscalePort: this.tailscalePort });
    const result = await this.electronService.restartTailscale(this.tailscalePort);
    this.tailscaleRunning = result.running;
    if (result.error) {
      this.tailscaleError = result.error;
    }

    this.saving = false;
  }

  async saveWorktreeSettings(): Promise<void> {
    this.saving = true;
    await this.electronService.updateSettings({
      worktreeEnabled: this.worktreeEnabled,
      worktreeDefaultBaseBranch: this.worktreeDefaultBaseBranch,
      worktreeDraftPR: this.worktreeDraftPR,
      worktreeMaxConcurrent: this.worktreeMaxConcurrent,
      worktreeAutoInstallDeps: this.worktreeAutoInstallDeps,
    });
    this.saving = false;
  }

  close(): void {
    this.dialogRef.close();
  }
}
