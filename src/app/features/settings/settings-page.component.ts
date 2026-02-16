/**
 * Settings Page Component - Full settings view with themes, remote access, and about info
 */

import { Component, inject, OnInit, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatDividerModule } from '@angular/material/divider';

import { ThemeService, CastleTheme } from '../../core/services/theme.service';
import { ElectronService } from '../../core/services/electron.service';
import { APP_NAME, APP_VERSION, DEFAULT_TAILSCALE_PORT } from '../../../shared/constants';

@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatSlideToggleModule,
    MatFormFieldModule,
    MatInputModule,
    MatDividerModule,
  ],
  templateUrl: './settings-page.component.html',
  styleUrl: './settings-page.component.scss'
})
export class SettingsPageComponent implements OnInit {
  private themeService = inject(ThemeService);
  private electronService = inject(ElectronService);

  currentTheme = this.themeService.currentTheme;
  availableThemes = this.themeService.availableThemes;
  appName = APP_NAME;
  appVersion = APP_VERSION;

  // Remote access state
  tailscaleEnabled = false;
  tailscalePort = DEFAULT_TAILSCALE_PORT;
  tailscaleRunning = false;
  tailscaleError: string | null = null;
  saving = false;

  async ngOnInit(): Promise<void> {
    const settings = await this.electronService.getSettings();
    if (settings) {
      this.tailscaleEnabled = settings.tailscaleEnabled ?? false;
      this.tailscalePort = settings.tailscalePort ?? DEFAULT_TAILSCALE_PORT;
    }
    const status = await this.electronService.getTailscaleStatus();
    this.tailscaleRunning = status.running;
  }

  setTheme(themeId: string): void {
    this.themeService.setTheme(themeId);
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
}
