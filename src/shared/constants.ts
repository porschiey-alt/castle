/**
 * Shared constants between main and renderer processes
 */

export const APP_NAME = 'Castle';
export const APP_VERSION = '0.1.0';

export const AGENTS_MD_FILENAMES = ['AGENTS.md', 'agents.md'];

export const DEFAULT_WINDOW_WIDTH = 1200;
export const DEFAULT_WINDOW_HEIGHT = 800;
export const MIN_WINDOW_WIDTH = 100;
export const MIN_WINDOW_HEIGHT = 600;

export const COPILOT_MODELS = [
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6', provider: 'Anthropic' },
  { id: 'claude-opus-4.6-fast', name: 'Claude Opus 4.6 (Fast)', provider: 'Anthropic' },
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', provider: 'Anthropic' },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', provider: 'Anthropic' },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'Anthropic' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', provider: 'OpenAI' },
  { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', provider: 'OpenAI' },
  { id: 'gpt-5.2', name: 'GPT-5.2', provider: 'OpenAI' },
  { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', provider: 'OpenAI' },
  { id: 'gpt-5.1', name: 'GPT-5.1', provider: 'OpenAI' },
  { id: 'gpt-5', name: 'GPT-5', provider: 'OpenAI' },
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Preview)', provider: 'Google' }
] as const;

export const BUILTIN_AGENT_COLORS = [
  '#7C3AED', // Purple
  '#10B981', // Green
  '#F59E0B', // Amber
  '#3B82F6', // Blue
  '#EC4899', // Pink
  '#14B8A6', // Teal
  '#F97316', // Orange
  '#8B5CF6'  // Violet
] as const;

export const PERMISSION_LABELS: Record<string, string> = {
  fileRead: 'Read files in workspace',
  fileWrite: 'Write and modify files',
  fileDelete: 'Delete files',
  executeCommands: 'Execute shell commands',
  networkAccess: 'Make network requests',
  gitOperations: 'Perform Git operations'
};

export const DEFAULT_TAILSCALE_PORT = 39417;
