/**
 * Electron Preload Script
 * Exposes safe IPC methods to the renderer process
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/types/ipc.types';
import { AppSettings, PermissionSet, PermissionResponse } from '../shared/types/settings.types';
import { Agent, AgentDiscoveryResult, AgentSession } from '../shared/types/agent.types';
import { ChatMessage, StreamingMessage } from '../shared/types/message.types';

// Type definitions for the exposed API
export interface ElectronAPI {
  // Directory operations
  directory: {
    select: () => Promise<string | null>;
    getCurrent: () => Promise<string | null>;
    getRecent: () => Promise<string[]>;
  };

  // Agent operations
  agents: {
    discover: (workspacePath: string) => Promise<AgentDiscoveryResult>;
    startSession: (agentId: string, workingDirectory: string) => Promise<AgentSession>;
    stopSession: (sessionId: string) => Promise<void>;
    getSession: (agentId: string) => Promise<AgentSession | null>;
  };

  // Chat operations
  chat: {
    sendMessage: (agentId: string, content: string) => Promise<ChatMessage>;
    getHistory: (agentId: string, limit?: number, offset?: number) => Promise<ChatMessage[]>;
    clearHistory: (agentId: string) => Promise<void>;
    onStreamChunk: (callback: (message: StreamingMessage) => void) => () => void;
    onStreamComplete: (callback: (message: ChatMessage) => void) => () => void;
  };

  // Permission operations
  permissions: {
    get: (agentId: string) => Promise<PermissionSet>;
    set: (agentId: string, permission: keyof PermissionSet, granted: boolean) => Promise<void>;
    onRequest: (callback: (request: unknown) => void) => () => void;
    respond: (requestId: string, response: PermissionResponse) => void;
  };

  // Settings operations
  settings: {
    get: () => Promise<AppSettings>;
    update: (updates: Partial<AppSettings>) => Promise<AppSettings>;
  };

  // Window operations
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
  };

  // App events
  app: {
    onReady: (callback: () => void) => () => void;
    onError: (callback: (error: { agentId?: string; error: string }) => void) => () => void;
    getActiveModel: () => Promise<string | null>;
  };
}

// Create the API object
const electronAPI: ElectronAPI = {
  directory: {
    select: () => ipcRenderer.invoke(IPC_CHANNELS.DIRECTORY_SELECT),
    getCurrent: () => ipcRenderer.invoke(IPC_CHANNELS.DIRECTORY_GET_CURRENT),
    getRecent: () => ipcRenderer.invoke(IPC_CHANNELS.DIRECTORY_GET_RECENT)
  },

  agents: {
    discover: (workspacePath: string) => 
      ipcRenderer.invoke(IPC_CHANNELS.AGENTS_DISCOVER, { workspacePath }),
    startSession: (agentId: string, workingDirectory: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENTS_START_SESSION, { agentId, workingDirectory }),
    stopSession: (sessionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENTS_STOP_SESSION, { sessionId }),
    getSession: (agentId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENTS_GET_SESSION, { agentId })
  },

  chat: {
    sendMessage: (agentId: string, content: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND_MESSAGE, { agentId, content }),
    getHistory: (agentId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_HISTORY, { agentId, limit, offset }),
    clearHistory: (agentId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_CLEAR_HISTORY, { agentId }),
    onStreamChunk: (callback: (message: StreamingMessage) => void) => {
      const handler = (_event: IpcRendererEvent, message: StreamingMessage) => callback(message);
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_CHUNK, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_CHUNK, handler);
    },
    onStreamComplete: (callback: (message: ChatMessage) => void) => {
      const handler = (_event: IpcRendererEvent, message: ChatMessage) => callback(message);
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_COMPLETE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_COMPLETE, handler);
    }
  },

  permissions: {
    get: (agentId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_GET, { agentId }),
    set: (agentId: string, permission: keyof PermissionSet, granted: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_SET, { agentId, permission, granted }),
    onRequest: (callback: (request: unknown) => void) => {
      const handler = (_event: IpcRendererEvent, request: unknown) => callback(request);
      ipcRenderer.on(IPC_CHANNELS.PERMISSION_REQUEST, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PERMISSION_REQUEST, handler);
    },
    respond: (requestId: string, response: PermissionResponse) =>
      ipcRenderer.send(IPC_CHANNELS.PERMISSION_RESPONSE, { requestId, response })
  },

  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    update: (updates: Partial<AppSettings>) =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE, updates)
  },

  window: {
    minimize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE)
  },

  app: {
    onReady: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.APP_READY, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_READY, handler);
    },
    onError: (callback: (error: { agentId?: string; error: string }) => void) => {
      const handler = (_event: IpcRendererEvent, error: { agentId?: string; error: string }) => callback(error);
      ipcRenderer.on(IPC_CHANNELS.APP_ERROR, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_ERROR, handler);
    },
    getActiveModel: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_ACTIVE_MODEL)
  }
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Type declaration for window object
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
