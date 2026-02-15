/**
 * IPC channel definitions and payload types for Electron communication
 */

import { Agent, AgentDiscoveryResult, AgentSession } from './agent.types';
import { ChatMessage, StreamingMessage } from './message.types';
import { AppSettings, PermissionRequest, PermissionResponse, PermissionSet } from './settings.types';

// IPC Channel names
export const IPC_CHANNELS = {
  // Directory operations
  DIRECTORY_SELECT: 'directory:select',
  DIRECTORY_GET_CURRENT: 'directory:getCurrent',
  DIRECTORY_GET_RECENT: 'directory:getRecent',
  
  // Agent operations
  AGENTS_DISCOVER: 'agents:discover',
  AGENTS_GET_ALL: 'agents:getAll',
  AGENTS_START_SESSION: 'agents:startSession',
  AGENTS_STOP_SESSION: 'agents:stopSession',
  AGENTS_GET_SESSION: 'agents:getSession',
  
  // Chat operations
  CHAT_SEND_MESSAGE: 'chat:sendMessage',
  CHAT_GET_HISTORY: 'chat:getHistory',
  CHAT_CLEAR_HISTORY: 'chat:clearHistory',
  CHAT_STREAM_CHUNK: 'chat:streamChunk',
  CHAT_STREAM_COMPLETE: 'chat:streamComplete',
  
  // Permission operations
  PERMISSION_REQUEST: 'permission:request',
  PERMISSION_RESPONSE: 'permission:response',
  PERMISSION_GET: 'permission:get',
  PERMISSION_SET: 'permission:set',
  
  // Settings operations
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  
  // Window operations
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  
  // App events
  APP_READY: 'app:ready',
  APP_ERROR: 'app:error',
  APP_GET_ACTIVE_MODEL: 'app:getActiveModel'
} as const;

// Type-safe IPC payload definitions
export interface IPCPayloads {
  // Directory
  [IPC_CHANNELS.DIRECTORY_SELECT]: {
    request: void;
    response: string | null;
  };
  [IPC_CHANNELS.DIRECTORY_GET_CURRENT]: {
    request: void;
    response: string | null;
  };
  [IPC_CHANNELS.DIRECTORY_GET_RECENT]: {
    request: void;
    response: string[];
  };
  
  // Agents
  [IPC_CHANNELS.AGENTS_DISCOVER]: {
    request: { workspacePath: string };
    response: AgentDiscoveryResult;
  };
  [IPC_CHANNELS.AGENTS_GET_ALL]: {
    request: void;
    response: Agent[];
  };
  [IPC_CHANNELS.AGENTS_START_SESSION]: {
    request: { agentId: string; workingDirectory: string };
    response: AgentSession;
  };
  [IPC_CHANNELS.AGENTS_STOP_SESSION]: {
    request: { sessionId: string };
    response: void;
  };
  [IPC_CHANNELS.AGENTS_GET_SESSION]: {
    request: { agentId: string };
    response: AgentSession | null;
  };
  
  // Chat
  [IPC_CHANNELS.CHAT_SEND_MESSAGE]: {
    request: { agentId: string; content: string };
    response: ChatMessage;
  };
  [IPC_CHANNELS.CHAT_GET_HISTORY]: {
    request: { agentId: string; limit?: number; offset?: number };
    response: ChatMessage[];
  };
  [IPC_CHANNELS.CHAT_CLEAR_HISTORY]: {
    request: { agentId: string };
    response: void;
  };
  [IPC_CHANNELS.CHAT_STREAM_CHUNK]: {
    request: never;
    response: StreamingMessage;
  };
  [IPC_CHANNELS.CHAT_STREAM_COMPLETE]: {
    request: never;
    response: ChatMessage;
  };
  
  // Permissions
  [IPC_CHANNELS.PERMISSION_REQUEST]: {
    request: never;
    response: PermissionRequest;
  };
  [IPC_CHANNELS.PERMISSION_RESPONSE]: {
    request: { requestId: string; response: PermissionResponse };
    response: void;
  };
  [IPC_CHANNELS.PERMISSION_GET]: {
    request: { agentId: string };
    response: PermissionSet;
  };
  [IPC_CHANNELS.PERMISSION_SET]: {
    request: { agentId: string; permission: keyof PermissionSet; granted: boolean };
    response: void;
  };
  
  // Settings
  [IPC_CHANNELS.SETTINGS_GET]: {
    request: void;
    response: AppSettings;
  };
  [IPC_CHANNELS.SETTINGS_UPDATE]: {
    request: Partial<AppSettings>;
    response: AppSettings;
  };
}

// Helper type for IPC invoke
export type IPCInvokeChannel = keyof IPCPayloads;
export type IPCRequest<T extends IPCInvokeChannel> = IPCPayloads[T]['request'];
export type IPCResponse<T extends IPCInvokeChannel> = IPCPayloads[T]['response'];
