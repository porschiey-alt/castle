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
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ThemeService, CastleTheme } from '../../core/services/theme.service';
import { ElectronService } from '../../core/services/electron.service';
import { ApiService } from '../../core/services/api.service';
import { APP_NAME, APP_VERSION, DEFAULT_TAILSCALE_PORT } from '../../../shared/constants';
import type { ThemeCustomization, PermissionGrant } from '../../../shared/types/settings.types';
import { getContrastingTextColor, contrastRatio } from '../../shared/utils/color.utils';

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
    MatSelectModule,
    MatTooltipModule,
  ],
  templateUrl: './settings-page.component.html',
  styleUrl: './settings-page.component.scss'
})
export class SettingsPageComponent implements OnInit {
  private themeService = inject(ThemeService);
  private electronService = inject(ElectronService);
  private apiService = inject(ApiService);

  currentTheme = this.themeService.currentTheme;
  availableThemes = this.themeService.availableThemes;
  customization = this.themeService.customization;
  appName = APP_NAME;
  appVersion = APP_VERSION;

  // Customization form state
  customBgPrimary = '';
  customAccentColor = '';
  customSecondaryAccentColor = '';
  gradientEnabled = false;
  gradientEndColor = '#1a1a2e';
  gradientDirection = 'to bottom';

  gradientDirections = [
    { value: 'to bottom', label: 'Top → Bottom' },
    { value: 'to right', label: 'Left → Right' },
    { value: 'to bottom right', label: 'Diagonal ↘' },
    { value: 'to bottom left', label: 'Diagonal ↙' },
  ];

  /** True when running in the native Electron shell (not a remote browser) */
  get isElectron(): boolean {
    return this.apiService.isElectron;
  }

  // Remote access state
  tailscaleEnabled = false;
  tailscalePort = DEFAULT_TAILSCALE_PORT;
  tailscaleRunning = false;
  tailscaleError: string | null = null;
  saving = false;

  // Worktree settings state
  worktreeEnabled = true;
  worktreeMaxConcurrent = 5;
  worktreeAutoInstallDeps = true;
  worktreeDraftPR = false;

  // GitHub Issues sync state
  githubIssueSyncEnabled = false;

  // Logging state
  logLevel: 'debug' | 'info' | 'warn' | 'error' = 'info';

  // Permission grants state
  permissionGrants: PermissionGrant[] = [];
  currentProjectPath: string | null = null;

  async ngOnInit(): Promise<void> {
    const settings = await this.electronService.getSettings();
    if (settings) {
      this.tailscaleEnabled = settings.tailscaleEnabled ?? false;
      this.tailscalePort = settings.tailscalePort ?? DEFAULT_TAILSCALE_PORT;
      this.worktreeEnabled = settings.worktreeEnabled !== false;
      this.worktreeMaxConcurrent = settings.worktreeMaxConcurrent ?? 5;
      this.worktreeAutoInstallDeps = settings.worktreeAutoInstallDeps !== false;
      this.worktreeDraftPR = settings.worktreeDraftPR ?? false;
      this.githubIssueSyncEnabled = settings.githubIssueSyncEnabled ?? false;
      this.logLevel = settings.logLevel ?? 'info';

      // Load existing customization
      const c = settings.themeCustomization;
      if (c) {
        this.customBgPrimary = c.bgPrimary || '';
        this.customAccentColor = c.accentColor || '';
        this.customSecondaryAccentColor = c.secondaryAccentColor || '';
        this.gradientEnabled = c.gradientEnabled || false;
        this.gradientEndColor = c.gradientEndColor || '#1a1a2e';
        this.gradientDirection = c.gradientDirection || 'to bottom';
      }
    }
    // If no customization loaded, initialize from current theme
    if (!this.customBgPrimary) {
      const theme = this.currentTheme();
      this.customBgPrimary = theme.bgPrimary || (theme.mode === 'dark' ? '#0a0a0a' : '#ffffff');
    }
    if (!this.customAccentColor) {
      this.customAccentColor = this.currentTheme().primary;
    }
    if (!this.customSecondaryAccentColor) {
      this.customSecondaryAccentColor = this.currentTheme().secondaryAccent;
    }

    const status = await this.electronService.getTailscaleStatus();
    this.tailscaleRunning = status.running;

    // Load permission grants for current project
    this.currentProjectPath = await this.electronService.getCurrentDirectory();
    if (this.currentProjectPath) {
      this.permissionGrants = await this.electronService.getPermissionGrants(this.currentProjectPath);
    }
  }

  setTheme(themeId: string): void {
    this.themeService.setTheme(themeId);
    // Reset local form to preset defaults
    const theme = this.availableThemes.find(t => t.id === themeId);
    if (theme) {
      this.customBgPrimary = theme.bgPrimary || (theme.mode === 'dark' ? '#0a0a0a' : '#ffffff');
      this.customAccentColor = theme.primary;
      this.customSecondaryAccentColor = theme.secondaryAccent;
      this.gradientEnabled = false;
      this.gradientEndColor = '#1a1a2e';
      this.gradientDirection = 'to bottom';
    }
  }

  onCustomizationChange(): void {
    const overrides: ThemeCustomization = {
      bgPrimary: this.customBgPrimary || undefined,
      accentColor: this.customAccentColor || undefined,
      secondaryAccentColor: this.customSecondaryAccentColor || undefined,
      gradientEnabled: this.gradientEnabled,
      gradientEndColor: this.gradientEnabled ? this.gradientEndColor : undefined,
      gradientDirection: this.gradientEnabled ? this.gradientDirection : undefined,
    };
    this.themeService.applyCustomization(overrides);
  }

  /** Get auto-calculated text color for preview */
  getAutoTextColor(): string {
    return getContrastingTextColor(this.customBgPrimary || '#0a0a0a');
  }

  /** Get the WCAG contrast ratio for display */
  getContrastRatio(): string {
    const bg = this.customBgPrimary || '#0a0a0a';
    const text = getContrastingTextColor(bg);
    return contrastRatio(bg, text).toFixed(1);
  }

  /** Build a preview gradient string */
  getGradientPreview(): string {
    if (!this.gradientEnabled) return this.customBgPrimary || '#0a0a0a';
    return `linear-gradient(${this.gradientDirection}, ${this.customBgPrimary || '#0a0a0a'}, ${this.gradientEndColor})`;
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

  async saveWorktreeSettings(): Promise<void> {
    await this.electronService.updateSettings({
      worktreeEnabled: this.worktreeEnabled,
      worktreeMaxConcurrent: Math.max(1, Math.min(20, this.worktreeMaxConcurrent)),
      worktreeAutoInstallDeps: this.worktreeAutoInstallDeps,
      worktreeDraftPR: this.worktreeDraftPR,
    });
  }

  async saveGitHubSettings(): Promise<void> {
    await this.electronService.updateSettings({
      githubIssueSyncEnabled: this.githubIssueSyncEnabled,
    });
  }

  async saveLogLevel(): Promise<void> {
    await this.electronService.updateSettings({ logLevel: this.logLevel });
  }

  resetCustomization(): void {
    const theme = this.currentTheme();
    this.customBgPrimary = theme.bgPrimary || (theme.mode === 'dark' ? '#0a0a0a' : '#ffffff');
    this.customAccentColor = theme.primary;
    this.customSecondaryAccentColor = theme.secondaryAccent;
    this.gradientEnabled = false;
    this.gradientEndColor = '#1a1a2e';
    this.gradientDirection = 'to bottom';
    this.themeService.applyCustomization({});
  }

  async deleteGrant(grant: PermissionGrant): Promise<void> {
    await this.electronService.deletePermissionGrant(grant.id);
    this.permissionGrants = this.permissionGrants.filter(g => g.id !== grant.id);
  }

  async deleteAllGrants(): Promise<void> {
    if (!this.currentProjectPath) return;
    await this.electronService.deleteAllPermissionGrants(this.currentProjectPath);
    this.permissionGrants = [];
  }

  getGrantIcon(toolKind: string): string {
    switch (toolKind) {
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

  formatGrantScope(grant: PermissionGrant): string {
    switch (grant.scopeType) {
      case 'path': return grant.scopeValue;
      case 'path_prefix': return grant.scopeValue ? `files in ${grant.scopeValue}` : 'project directory';
      case 'glob': return grant.scopeValue;
      case 'command': return `\`${grant.scopeValue}\``;
      case 'command_prefix': return `${grant.scopeValue} *`;
      case 'domain': return grant.scopeValue;
      case 'url_prefix': return grant.scopeValue;
      default: return 'all';
    }
  }
}
