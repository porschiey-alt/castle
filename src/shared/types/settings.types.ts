/**
 * Settings and permission type definitions
 */

export interface ThemeCustomization {
  bgPrimary?: string;
  bgSecondary?: string;
  accentColor?: string;
  secondaryAccentColor?: string;
  gradientEnabled?: boolean;
  gradientEndColor?: string;
  gradientDirection?: string;
}

export interface AppSettings {
  theme: string;
  themeCustomization?: ThemeCustomization;
  defaultModel: string;
  autoStartAgents: boolean;
  showToolCalls: boolean;
  fontSize: number;
  recentDirectories: string[];
  windowBounds?: WindowBounds;
  tailscaleEnabled: boolean;
  tailscalePort: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export interface PermissionSet {
  fileRead: boolean;
  fileWrite: boolean;
  fileDelete: boolean;
  executeCommands: boolean;
  networkAccess: boolean;
  gitOperations: boolean;
}

export interface PermissionRequest {
  id: string;
  agentId: string;
  agentName: string;
  permission: keyof PermissionSet;
  context: string;
  timestamp: Date;
}

export interface PermissionResponse {
  granted: boolean;
  remember: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'castle-dark',
  defaultModel: 'claude-sonnet-4.5',
  autoStartAgents: false,
  showToolCalls: true,
  fontSize: 14,
  recentDirectories: [],
  tailscaleEnabled: false,
  tailscalePort: 39417
};

export const DEFAULT_PERMISSIONS: PermissionSet = {
  fileRead: true,
  fileWrite: false,
  fileDelete: false,
  executeCommands: false,
  networkAccess: false,
  gitOperations: false
};

export interface PermissionGrant {
  id: number;
  projectPath: string;
  toolKind: string;
  granted: boolean;
  createdAt: string;
}
