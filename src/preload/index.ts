/**
 * Electron Preload Script
 * Exposes safe IPC methods to the renderer process
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/types/ipc.types';
import { AppSettings, PermissionSet, PermissionResponse, PermissionGrant } from '../shared/types/settings.types';
import { Agent, AgentDiscoveryResult, AgentSession, CastleAgentConfig } from '../shared/types/agent.types';
import { ChatMessage, StreamingMessage } from '../shared/types/message.types';
import { Task, TaskLabel, CreateTaskInput, UpdateTaskInput, ResearchComment } from '../shared/types/task.types';
import { Conversation, CreateConversationInput, UpdateConversationInput } from '../shared/types/conversation.types';

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
    saveBuiltinConfig: (agents: CastleAgentConfig[]) => Promise<void>;
  };

  // Chat operations
  chat: {
    sendMessage: (agentId: string, content: string, conversationId?: string) => Promise<ChatMessage>;
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
    respond: (requestId: string, agentId: string, optionId: string, optionKind?: string, toolKind?: string) => void;
  };

  // Permission grant management
  permissionGrants: {
    get: (projectPath: string) => Promise<PermissionGrant[]>;
    delete: (grantId: number) => Promise<void>;
    deleteAll: (projectPath: string) => Promise<void>;
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
    runResearch: (taskId: string, agentId: string, outputPath?: string, conversationId?: string) => Promise<{ taskId: string }>;
    runImplementation: (taskId: string, agentId: string, conversationId?: string) => Promise<{ taskId: string }>;
    submitResearchReview: (taskId: string, comments: ResearchComment[], researchSnapshot: string) => Promise<{ reviewId: string }>;
    deleteDiagnosisFile: (filePath: string) => Promise<{ deleted: boolean }>;
    onDiagnosisFileCleanup: (callback: (data: { taskId: string; filePath: string }) => void) => () => void;
  };

  // Cross-device sync events
  sync: {
    onTasksChanged: (callback: (data: { action: string; task?: Task; taskId?: string }) => void) => () => void;
    onChatMessageAdded: (callback: (message: ChatMessage) => void) => () => void;
    onPermissionResponded: (callback: (data: { requestId: string }) => void) => () => void;
    onStreamingStarted: (callback: (data: { agentId: string; conversationId?: string }) => void) => () => void;
    onConversationsChanged: (callback: (data: { action: string; conversation?: Conversation; conversationId?: string }) => void) => () => void;
  };

  // Conversation operations
  conversations: {
    getAll: (agentId: string) => Promise<Conversation[]>;
    get: (conversationId: string) => Promise<Conversation | null>;
    create: (input: CreateConversationInput) => Promise<Conversation>;
    update: (conversationId: string, updates: UpdateConversationInput) => Promise<Conversation>;
    delete: (conversationId: string) => Promise<void>;
    deleteAll: (agentId: string) => Promise<void>;
    getMessages: (conversationId: string, limit?: number, offset?: number) => Promise<ChatMessage[]>;
  };

  // Worktree operations
  worktree: {
    create: (repoPath: string, taskTitle: string, taskId: string) => Promise<{ worktreePath: string; branchName: string }>;
    remove: (worktreePath: string, deleteBranch?: boolean) => Promise<void>;
    list: (repoPath: string) => Promise<{ path: string; branch: string; head: string; isMainWorktree: boolean }[]>;
    status: (worktreePath: string) => Promise<{ exists: boolean; branch?: string; hasChanges?: boolean }>;
    createPR: (worktreePath: string, title: string, body: string) => Promise<{ success: boolean; url?: string; error?: string }>;
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
      ipcRenderer.invoke(IPC_CHANNELS.AGENTS_GET_SESSION, { agentId }),
    saveBuiltinConfig: (agents: CastleAgentConfig[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENTS_SAVE_BUILTIN_CONFIG, { agents })
  },

  chat: {
    sendMessage: (agentId: string, content: string, conversationId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND_MESSAGE, { agentId, content, conversationId }),
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
    respond: (requestId: string, agentId: string, optionId: string, optionKind?: string, toolKind?: string) =>
      ipcRenderer.send(IPC_CHANNELS.PERMISSION_RESPONSE, { requestId, agentId, optionId, optionKind, toolKind })
  },

  permissionGrants: {
    get: (projectPath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_GRANTS_GET, { projectPath }),
    delete: (grantId: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_GRANTS_DELETE, { grantId }),
    deleteAll: (projectPath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_GRANTS_DELETE_ALL, { projectPath }),
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
    runResearch: (taskId: string, agentId: string, outputPath?: string, conversationId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASKS_RUN_RESEARCH, { taskId, agentId, outputPath, conversationId }),
    runImplementation: (taskId: string, agentId: string, conversationId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASKS_RUN_IMPLEMENTATION, { taskId, agentId, conversationId }),
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
    onStreamingStarted: (callback: (data: { agentId: string; conversationId?: string }) => void) => {
      const handler = (_event: IpcRendererEvent, data: { agentId: string; conversationId?: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.SYNC_STREAMING_STARTED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SYNC_STREAMING_STARTED, handler);
    },
    onConversationsChanged: (callback: (data: { action: string; conversation?: Conversation; conversationId?: string }) => void) => {
      const handler = (_event: IpcRendererEvent, data: { action: string; conversation?: Conversation; conversationId?: string }) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.SYNC_CONVERSATIONS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.SYNC_CONVERSATIONS_CHANGED, handler);
    },
  },

  conversations: {
    getAll: (agentId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_GET_ALL, { agentId }),
    get: (conversationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_GET, { conversationId }),
    create: (input: CreateConversationInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_CREATE, input),
    update: (conversationId: string, updates: UpdateConversationInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_UPDATE, { conversationId, updates }),
    delete: (conversationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_DELETE, { conversationId }),
    deleteAll: (agentId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_DELETE_ALL, { agentId }),
    getMessages: (conversationId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_GET_MESSAGES, { conversationId, limit, offset }),
  },

  worktree: {
    create: (repoPath: string, taskTitle: string, taskId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_CREATE, { repoPath, taskTitle, taskId }),
    remove: (worktreePath: string, deleteBranch?: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_REMOVE, { worktreePath, deleteBranch }),
    list: (repoPath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_LIST, { repoPath }),
    status: (worktreePath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_STATUS, { worktreePath }),
    createPR: (worktreePath: string, title: string, body: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_CREATE_PR, { worktreePath, title, body }),
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Type declaration for window object
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
