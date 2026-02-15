/**
 * Theme Service - Manages application theming
 */

import { Injectable, signal, effect } from '@angular/core';
import { ElectronService } from './electron.service';

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

  constructor(private electronService: ElectronService) {
    // Apply theme changes to DOM
    effect(() => {
      this.applyTheme(this.currentTheme());
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
  }

  /**
   * Set the current theme
   */
  async setTheme(themeId: string): Promise<void> {
    const theme = this.availableThemes.find(t => t.id === themeId);
    if (theme) {
      this.currentTheme.set(theme);
      await this.electronService.updateSettings({ theme: themeId });
    }
  }

  /**
   * Apply theme to the DOM
   */
  private applyTheme(theme: CastleTheme): void {
    const body = document.body;
    
    // Remove existing theme classes
    const classesToRemove = Array.from(body.classList)
      .filter(c => c.startsWith(this.THEME_CLASS_PREFIX) || c === 'midnight' || c === 'amoled');
    classesToRemove.forEach(c => body.classList.remove(c));
    
    // Add new theme class
    body.classList.add(theme.id);
    
    // Set CSS custom properties
    const root = document.documentElement;
    root.style.setProperty('--theme-primary', theme.primary);
    root.style.setProperty('--theme-accent', theme.accent);
    root.style.setProperty('--theme-warn', theme.warn);
    
    // Set mode-specific properties
    if (theme.mode === 'dark') {
      // Use theme-specific colors if available, otherwise defaults
      root.style.setProperty('--bg-primary', theme.bgPrimary || '#0a0a0a');
      root.style.setProperty('--bg-secondary', theme.bgSecondary || '#111111');
      root.style.setProperty('--bg-tertiary', theme.bgTertiary || '#1a1a1a');
      root.style.setProperty('--bg-hover', theme.bgHover || '#222222');
      root.style.setProperty('--text-primary', theme.textPrimary || '#e5e5e5');
      root.style.setProperty('--text-secondary', theme.textSecondary || '#a3a3a3');
      root.style.setProperty('--text-muted', theme.textMuted || '#737373');
      root.style.setProperty('--border-color', theme.borderColor || '#262626');
      root.style.setProperty('--user-bubble', theme.primary);
      root.style.setProperty('--agent-bubble', theme.bgTertiary || '#1a1a1a');
      root.style.setProperty('--code-bg', '#0d0d0d');
    } else {
      root.style.setProperty('--bg-primary', '#ffffff');
      root.style.setProperty('--bg-secondary', '#f7fafc');
      root.style.setProperty('--bg-tertiary', '#edf2f7');
      root.style.setProperty('--bg-hover', '#e2e8f0');
      root.style.setProperty('--text-primary', '#1a202c');
      root.style.setProperty('--text-secondary', '#4a5568');
      root.style.setProperty('--text-muted', '#718096');
      root.style.setProperty('--border-color', '#e2e8f0');
      root.style.setProperty('--user-bubble', theme.primary);
      root.style.setProperty('--agent-bubble', '#edf2f7');
      root.style.setProperty('--code-bg', '#f7fafc');
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
