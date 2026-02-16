/**
 * Theme Service - Manages application theming
 */

import { Injectable, signal, effect } from '@angular/core';
import { ElectronService } from './electron.service';
import type { ThemeCustomization } from '../../../shared/types/settings.types';
import {
  getContrastingTextColor,
  getSecondaryTextColor,
  getMutedTextColor,
  getBorderColor,
  deriveBackgroundColors,
  relativeLuminance,
} from '../../shared/utils/color.utils';

export type ThemeMode = 'light' | 'dark';

export interface CastleTheme {
  id: string;
  name: string;
  mode: ThemeMode;
  primary: string;
  accent: string;
  warn: string;
  // Extended theme properties for dark themes
  bgPrimary?: string;
  bgSecondary?: string;
  bgTertiary?: string;
  bgHover?: string;
  textPrimary?: string;
  textSecondary?: string;
  textMuted?: string;
  borderColor?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private readonly THEME_CLASS_PREFIX = 'castle-';
  
  // Available themes
  readonly availableThemes: CastleTheme[] = [
    {
      id: 'castle-dark',
      name: 'Castle Dark',
      mode: 'dark',
      primary: '#6366f1',
      accent: '#22c55e',
      warn: '#ef4444',
      // Very dark, minimal color palette
      bgPrimary: '#0a0a0a',
      bgSecondary: '#111111',
      bgTertiary: '#1a1a1a',
      bgHover: '#222222',
      textPrimary: '#e5e5e5',
      textSecondary: '#a3a3a3',
      textMuted: '#737373',
      borderColor: '#262626'
    },
    {
      id: 'castle-light',
      name: 'Castle Light',
      mode: 'light',
      primary: '#6366F1',
      accent: '#14B8A6',
      warn: '#F59E0B'
    },
    {
      id: 'midnight',
      name: 'Midnight Blue',
      mode: 'dark',
      primary: '#3b82f6',
      accent: '#22c55e',
      warn: '#f97316',
      bgPrimary: '#0c0c14',
      bgSecondary: '#12121c',
      bgTertiary: '#1a1a28',
      bgHover: '#242436',
      textPrimary: '#e5e5e5',
      textSecondary: '#a3a3a3',
      textMuted: '#737373',
      borderColor: '#2a2a3c'
    },
    {
      id: 'amoled',
      name: 'AMOLED Black',
      mode: 'dark',
      primary: '#ffffff',
      accent: '#22c55e',
      warn: '#ef4444',
      // Pure black for AMOLED screens
      bgPrimary: '#000000',
      bgSecondary: '#0a0a0a',
      bgTertiary: '#141414',
      bgHover: '#1a1a1a',
      textPrimary: '#ffffff',
      textSecondary: '#a3a3a3',
      textMuted: '#666666',
      borderColor: '#1f1f1f'
    }
  ];

  // Current theme signal
  currentTheme = signal<CastleTheme>(this.availableThemes[0]);

  // Custom overrides signal
  customization = signal<ThemeCustomization>({});

  constructor(private electronService: ElectronService) {
    // Apply theme changes to DOM
    effect(() => {
      this.applyTheme(this.currentTheme(), this.customization());
    });

    // Load saved theme
    this.loadSavedTheme();
  }

  /**
   * Load saved theme from settings
   */
  private async loadSavedTheme(): Promise<void> {
    const settings = await this.electronService.getSettings();
    if (settings?.theme) {
      const theme = this.availableThemes.find(t => t.id === settings.theme);
      if (theme) {
        this.currentTheme.set(theme);
      }
    }
    if (settings?.themeCustomization) {
      this.customization.set(settings.themeCustomization);
    }
  }

  /**
   * Set the current theme
   */
  async setTheme(themeId: string): Promise<void> {
    const theme = this.availableThemes.find(t => t.id === themeId);
    if (theme) {
      this.currentTheme.set(theme);
      // Reset customization when switching preset
      this.customization.set({});
      await this.electronService.updateSettings({ theme: themeId, themeCustomization: {} });
    }
  }

  /**
   * Apply custom theme overrides
   */
  async applyCustomization(overrides: ThemeCustomization): Promise<void> {
    this.customization.set(overrides);
    await this.electronService.updateSettings({ themeCustomization: overrides });
  }

  /**
   * Apply theme to the DOM
   */
  private applyTheme(theme: CastleTheme, custom: ThemeCustomization): void {
    const body = document.body;
    
    // Remove existing theme classes
    const classesToRemove = Array.from(body.classList)
      .filter(c => c.startsWith(this.THEME_CLASS_PREFIX) || c === 'midnight' || c === 'amoled');
    classesToRemove.forEach(c => body.classList.remove(c));
    
    // Add new theme class
    body.classList.add(theme.id);
    
    // Set CSS custom properties
    const root = document.documentElement;
    const accent = custom.accentColor || theme.primary;
    root.style.setProperty('--theme-primary', accent);
    root.style.setProperty('--theme-accent', theme.accent);
    root.style.setProperty('--theme-warn', theme.warn);

    // Determine effective background
    const bgPrimary = custom.bgPrimary || (theme.mode === 'dark' ? (theme.bgPrimary || '#0a0a0a') : '#ffffff');

    // Auto-derive text and UI colors from the effective background
    const textPrimary = getContrastingTextColor(bgPrimary);
    const textSecondary = getSecondaryTextColor(bgPrimary);
    const textMuted = getMutedTextColor(bgPrimary);
    const borderColor = getBorderColor(bgPrimary);
    const derived = deriveBackgroundColors(bgPrimary);

    const bgSecondary = custom.bgSecondary || (theme.mode === 'dark' ? (theme.bgSecondary || derived.bgSecondary) : derived.bgSecondary);

    root.style.setProperty('--bg-primary', bgPrimary);
    root.style.setProperty('--bg-secondary', bgSecondary);
    root.style.setProperty('--bg-tertiary', derived.bgTertiary);
    root.style.setProperty('--bg-hover', derived.bgHover);
    root.style.setProperty('--text-primary', textPrimary);
    root.style.setProperty('--text-secondary', textSecondary);
    root.style.setProperty('--text-muted', textMuted);
    root.style.setProperty('--border-color', borderColor);
    root.style.setProperty('--user-bubble', accent);
    root.style.setProperty('--agent-bubble', derived.bgTertiary);
    root.style.setProperty('--code-bg', relativeLuminance(bgPrimary) > 0.179 ? '#f7fafc' : '#0d0d0d');

    // Gradient support
    if (custom.gradientEnabled && custom.gradientEndColor) {
      const dir = custom.gradientDirection || 'to bottom';
      root.style.setProperty('--bg-gradient', `linear-gradient(${dir}, ${bgPrimary}, ${custom.gradientEndColor})`);
      body.style.setProperty('background', `var(--bg-gradient)`);
    } else {
      root.style.removeProperty('--bg-gradient');
      body.style.removeProperty('background');
    }
  }

  /**
   * Toggle between light and dark mode
   */
  toggleMode(): void {
    const current = this.currentTheme();
    const newMode: ThemeMode = current.mode === 'dark' ? 'light' : 'dark';
    
    // Find a theme with the opposite mode
    const newTheme = this.availableThemes.find(t => t.mode === newMode);
    if (newTheme) {
      this.setTheme(newTheme.id);
    }
  }

  /**
   * Get theme by ID
   */
  getTheme(themeId: string): CastleTheme | undefined {
    return this.availableThemes.find(t => t.id === themeId);
  }
}
