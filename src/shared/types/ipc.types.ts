/**
 * IPC channel definitions and payload types for Electron communication
 */

import { Agent, AgentDiscoveryResult, AgentSession } from './agent.types';
import { ChatMessage, StreamingMessage } from './message.types';
import { AppSettings, PermissionRequest, PermissionResponse, PermissionSet } from './settings.types';
import { Task, TaskLabel, CreateTaskInput, UpdateTaskInput, ResearchComment } from './task.types';
import { Conversation, CreateConversationInput, UpdateConversationInput } from './conversation.types';

// IPC Channel names
export const IPC_CHANNELS = {
  // Directory operations
  DIRECTORY_SELECT: 'directory:select',
  DIRECTORY_GET_CURRENT: 'directory:getCurrent',
  DIRECTORY_GET_RECENT: 'directory:getRecent',
  DIRECTORY_SET_CURRENT: 'directory:setCurrent',
  
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
  CHAT_CANCEL_MESSAGE: 'chat:cancelMessage',
  
  // Permission operations
  PERMISSION_REQUEST: 'permission:request',
  PERMISSION_RESPONSE: 'permission:response',
  PERMISSION_GET: 'permission:get',
  PERMISSION_SET: 'permission:set',
  
  // Settings operations
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',

  // Tailscale / remote access
  TAILSCALE_RESTART: 'tailscale:restart',
  TAILSCALE_STATUS: 'tailscale:status',
  
  // Window operations
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  
  // App events
  APP_READY: 'app:ready',
  APP_ERROR: 'app:error',
  APP_GET_ACTIVE_MODEL: 'app:getActiveModel',

  // Task operations
  TASKS_GET_ALL: 'tasks:getAll',
  TASKS_GET: 'tasks:get',
  TASKS_CREATE: 'tasks:create',
  TASKS_UPDATE: 'tasks:update',
  TASKS_DELETE: 'tasks:delete',
  TASKS_LABELS_GET_ALL: 'tasks:labels:getAll',
  TASKS_LABELS_CREATE: 'tasks:labels:create',
  TASKS_LABELS_DELETE: 'tasks:labels:delete',
  TASKS_RUN_RESEARCH: 'tasks:runResearch',
  TASKS_RUN_IMPLEMENTATION: 'tasks:runImplementation',
  TASKS_SUBMIT_RESEARCH_REVIEW: 'tasks:submitResearchReview',
  TASKS_DIAGNOSIS_FILE_CLEANUP: 'tasks:diagnosisFileCleanup',
  TASKS_DELETE_DIAGNOSIS_FILE: 'tasks:deleteDiagnosisFile',

  // Cross-device sync push events
  SYNC_TASKS_CHANGED: 'sync:tasksChanged',
  SYNC_CHAT_MESSAGE_ADDED: 'sync:chatMessageAdded',
  SYNC_PERMISSION_RESPONDED: 'sync:permissionResponded',
  SYNC_CONVERSATIONS_CHANGED: 'sync:conversationsChanged',

  // Conversation operations
  CONVERSATIONS_GET_ALL: 'conversations:getAll',
  CONVERSATIONS_GET: 'conversations:get',
  CONVERSATIONS_CREATE: 'conversations:create',
  CONVERSATIONS_UPDATE: 'conversations:update',
  CONVERSATIONS_DELETE: 'conversations:delete',
  CONVERSATIONS_GET_MESSAGES: 'conversations:getMessages',
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
  [IPC_CHANNELS.DIRECTORY_SET_CURRENT]: {
    request: { path: string };
    response: void;
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
    request: { agentId: string; content: string; conversationId?: string };
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
  [IPC_CHANNELS.CHAT_CANCEL_MESSAGE]: {
    request: { agentId: string };
    response: void;
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

  // Tasks
  [IPC_CHANNELS.TASKS_GET_ALL]: {
    request: { state?: string; kind?: string };
    response: Task[];
  };
  [IPC_CHANNELS.TASKS_GET]: {
    request: { taskId: string };
    response: Task | null;
  };
  [IPC_CHANNELS.TASKS_CREATE]: {
    request: CreateTaskInput;
    response: Task;
  };
  [IPC_CHANNELS.TASKS_UPDATE]: {
    request: { taskId: string; updates: UpdateTaskInput };
    response: Task;
  };
  [IPC_CHANNELS.TASKS_DELETE]: {
    request: { taskId: string };
    response: void;
  };
  [IPC_CHANNELS.TASKS_LABELS_GET_ALL]: {
    request: void;
    response: TaskLabel[];
  };
  [IPC_CHANNELS.TASKS_LABELS_CREATE]: {
    request: { name: string; color: string };
    response: TaskLabel;
  };
  [IPC_CHANNELS.TASKS_LABELS_DELETE]: {
    request: { labelId: string };
    response: void;
  };
  [IPC_CHANNELS.TASKS_RUN_RESEARCH]: {
    request: { taskId: string; agentId: string; outputPath?: string };
    response: { taskId: string };
  };
  [IPC_CHANNELS.TASKS_RUN_IMPLEMENTATION]: {
    request: { taskId: string; agentId: string };
    response: { taskId: string };
  };
  [IPC_CHANNELS.TASKS_SUBMIT_RESEARCH_REVIEW]: {
    request: { taskId: string; comments: ResearchComment[]; researchSnapshot: string };
    response: { reviewId: string };
  };

  // Conversations
  [IPC_CHANNELS.CONVERSATIONS_GET_ALL]: {
    request: { agentId: string };
    response: Conversation[];
  };
  [IPC_CHANNELS.CONVERSATIONS_GET]: {
    request: { conversationId: string };
    response: Conversation | null;
  };
  [IPC_CHANNELS.CONVERSATIONS_CREATE]: {
    request: CreateConversationInput;
    response: Conversation;
  };
  [IPC_CHANNELS.CONVERSATIONS_UPDATE]: {
    request: { conversationId: string; updates: UpdateConversationInput };
    response: Conversation;
  };
  [IPC_CHANNELS.CONVERSATIONS_DELETE]: {
    request: { conversationId: string };
    response: void;
  };
  [IPC_CHANNELS.CONVERSATIONS_GET_MESSAGES]: {
    request: { conversationId: string; limit?: number; offset?: number };
    response: ChatMessage[];
  };
}

// Helper type for IPC invoke
export type IPCInvokeChannel = keyof IPCPayloads;
export type IPCRequest<T extends IPCInvokeChannel> = IPCPayloads[T]['request'];
export type IPCResponse<T extends IPCInvokeChannel> = IPCPayloads[T]['response'];
