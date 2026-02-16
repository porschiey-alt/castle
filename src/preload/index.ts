/**
 * Electron Preload Script
 * Exposes safe IPC methods to the renderer process
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/types/ipc.types';
import { AppSettings, PermissionSet, PermissionResponse } from '../shared/types/settings.types';
import { Agent, AgentDiscoveryResult, AgentSession } from '../shared/types/agent.types';
import { ChatMessage, StreamingMessage } from '../shared/types/message.types';
import { Task, TaskLabel, CreateTaskInput, UpdateTaskInput, ResearchComment } from '../shared/types/task.types';

// Type definitions for the exposed API
export interface ElectronAPI {
  // Directory operations
  directory: {
    select: () => Promise<string | null>;
    getCurrent: () => Promise<string | null>;
    getRecent: () => Promise<string[]>;
    setCurrent: (dirPath: string) => Promise<void>;
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
    cancelMessage: (agentId: string) => Promise<void>;
    onStreamChunk: (callback: (message: StreamingMessage) => void) => () => void;
    onStreamComplete: (callback: (message: ChatMessage) => void) => () => void;
  };

  // Permission operations
  permissions: {
    get: (agentId: string) => Promise<PermissionSet>;
    set: (agentId: string, permission: keyof PermissionSet, granted: boolean) => Promise<void>;
    onRequest: (callback: (request: unknown) => void) => () => void;
    respond: (requestId: string, agentId: string, optionId: string) => void;
  };

  // Settings operations
  settings: {
    get: () => Promise<AppSettings>;
    update: (updates: Partial<AppSettings>) => Promise<AppSettings>;
  };

  // Tailscale / remote access
  tailscale: {
    restart: (port: number) => Promise<{ running: boolean; port?: number; error?: string }>;
    status: () => Promise<{ running: boolean; port: number | null }>;
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

  // Task operations
  tasks: {
    getAll: (state?: string) => Promise<Task[]>;
    get: (taskId: string) => Promise<Task | null>;
    create: (input: CreateTaskInput) => Promise<Task>;
    update: (taskId: string, updates: UpdateTaskInput) => Promise<Task>;
    delete: (taskId: string) => Promise<void>;
    getLabels: () => Promise<TaskLabel[]>;
    createLabel: (name: string, color: string) => Promise<TaskLabel>;
    deleteLabel: (labelId: string) => Promise<void>;
    runResearch: (taskId: string, agentId: string, outputPath?: string) => Promise<{ taskId: string }>;
    submitResearchReview: (taskId: string, comments: ResearchComment[], researchSnapshot: string) => Promise<{ reviewId: string }>;
    deleteDiagnosisFile: (filePath: string) => Promise<{ deleted: boolean }>;
    onDiagnosisFileCleanup: (callback: (data: { taskId: string; filePath: string }) => void) => () => void;
  };

  // Cross-device sync events
  sync: {
    onTasksChanged: (callback: (data: { action: string; task?: Task; taskId?: string }) => void) => () => void;
    onChatMessageAdded: (callback: (message: ChatMessage) => void) => () => void;
    onPermissionResponded: (callback: (data: { requestId: string }) => void) => () => void;
  };
}

// Create the API object
const electronAPI: ElectronAPI = {
  directory: {
    select: () => ipcRenderer.invoke(IPC_CHANNELS.DIRECTORY_SELECT),
    getCurrent: () => ipcRenderer.invoke(IPC_CHANNELS.DIRECTORY_GET_CURRENT),
    getRecent: () => ipcRenderer.invoke(IPC_CHANNELS.DIRECTORY_GET_RECENT),
    setCurrent: (dirPath: string) => ipcRenderer.invoke(IPC_CHANNELS.DIRECTORY_SET_CURRENT, { path: dirPath })
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
    cancelMessage: (agentId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_CANCEL_MESSAGE, { agentId }),
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
    respond: (requestId: string, agentId: string, optionId: string) =>
      ipcRenderer.send(IPC_CHANNELS.PERMISSION_RESPONSE, { requestId, agentId, optionId })
  },

  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    update: (updates: Partial<AppSettings>) =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE, updates)
  },

  tailscale: {
    restart: (port: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.TAILSCALE_RESTART, { port }),
    status: () =>
      ipcRenderer.invoke(IPC_CHANNELS.TAILSCALE_STATUS),
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
  },

  tasks: {
    getAll: (state?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASKS_GET_ALL, { state }),
    get: (taskId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASKS_GET, { taskId }),
    create: (input: CreateTaskInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASKS_CREATE, input),
    update: (taskId: string, updates: UpdateTaskInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASKS_UPDATE, { taskId, updates }),
    delete: (taskId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASKS_DELETE, { taskId }),
    getLabels: () =>
      ipcRenderer.invoke(IPC_CHANNELS.TASKS_LABELS_GET_ALL),
    createLabel: (name: string, color: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASKS_LABELS_CREATE, { name, color }),
    deleteLabel: (labelId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASKS_LABELS_DELETE, { labelId }),
    runResearch: (taskId: string, agentId: string, outputPath?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASKS_RUN_RESEARCH, { taskId, agentId, outputPath }),
    submitResearchReview: (taskId: string, comments: ResearchComment[], researchSnapshot: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASKS_SUBMIT_RESEARCH_REVIEW, { taskId, comments, researchSnapshot }),
    deleteDiagnosisFile: (filePath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASKS_DELETE_DIAGNOSIS_FILE, { filePath }),
    onDiagnosisFileCleanup: (callback: (data: { taskId: string; filePath: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { taskId: string; filePath: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.TASKS_DIAGNOSIS_FILE_CLEANUP, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TASKS_DIAGNOSIS_FILE_CLEANUP, handler);
    },
  },

  sync: {
    onTasksChanged: (callback: (data: { action: string; task?: Task; taskId?: string }) => void) => {
      const handler = (_event: IpcRendererEvent, data: { action: string; task?: Task; taskId?: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.SYNC_TASKS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SYNC_TASKS_CHANGED, handler);
    },
    onChatMessageAdded: (callback: (message: ChatMessage) => void) => {
      const handler = (_event: IpcRendererEvent, message: ChatMessage) => callback(message);
      ipcRenderer.on(IPC_CHANNELS.SYNC_CHAT_MESSAGE_ADDED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SYNC_CHAT_MESSAGE_ADDED, handler);
    },
    onPermissionResponded: (callback: (data: { requestId: string }) => void) => {
      const handler = (_event: IpcRendererEvent, data: { requestId: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.SYNC_PERMISSION_RESPONDED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SYNC_PERMISSION_RESPONDED, handler);
    },
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
