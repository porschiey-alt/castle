/**
 * WebSocket-based implementation of ElectronAPI
 *
 * Used when the Angular app is loaded in a remote browser (no Electron).
 * Routes all API calls through a WebSocket connection to the Castle main process.
 */

import type { ElectronAPI } from '../../../preload/index';
import type { AgentDiscoveryResult, AgentSession, CastleAgentConfig } from '../../../shared/types/agent.types';
import type { ChatMessage, StreamingMessage } from '../../../shared/types/message.types';
import type { AppSettings, PermissionSet, PermissionGrant } from '../../../shared/types/settings.types';
import type { Task, TaskLabel, CreateTaskInput, UpdateTaskInput, ResearchComment } from '../../../shared/types/task.types';
import type { Conversation, CreateConversationInput, UpdateConversationInput } from '../../../shared/types/conversation.types';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';

type EventCallback = (...args: any[]) => void;

/** Generate a unique ID without requiring a secure context (crypto.randomUUID needs HTTPS) */
let _idCounter = 0;
function generateId(): string {
  return `${Date.now()}-${++_idCounter}-${Math.random().toString(36).slice(2, 9)}`;
}

export class WebSocketAPI implements ElectronAPI {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private eventListeners = new Map<string, Set<EventCallback>>();
  private connectPromise: Promise<void>;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.connectPromise = this.connect();
  }

  // ---- Connection management ----

  private connect(): Promise<void> {
    return new Promise((resolve) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}`;

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('[WebSocketAPI] Connected');
        resolve();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = () => {
        console.log('[WebSocketAPI] Disconnected, reconnecting...');
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      };

      this.ws.onerror = (err) => {
        console.error('[WebSocketAPI] Error:', err);
      };
    });
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Response to a request
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const { resolve, reject } = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Push event
    if (msg.channel) {
      const listeners = this.eventListeners.get(msg.channel);
      if (listeners) {
        for (const cb of listeners) {
          cb(msg.payload);
        }
      }
    }
  }

  private async invoke(channel: string, payload?: unknown): Promise<any> {
    await this.connectPromise;
    return new Promise((resolve, reject) => {
      const id = generateId();
      this.pendingRequests.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, channel, payload }));
    });
  }

  private on(channel: string, callback: EventCallback): () => void {
    if (!this.eventListeners.has(channel)) {
      this.eventListeners.set(channel, new Set());
    }
    this.eventListeners.get(channel)!.add(callback);
    return () => {
      this.eventListeners.get(channel)?.delete(callback);
    };
  }

  // ---- ElectronAPI implementation ----

  directory = {
    select: (): Promise<string | null> =>
      this.invoke(IPC_CHANNELS.DIRECTORY_SELECT),
    getCurrent: (): Promise<string | null> =>
      this.invoke(IPC_CHANNELS.DIRECTORY_GET_CURRENT),
    getRecent: (): Promise<string[]> =>
      this.invoke(IPC_CHANNELS.DIRECTORY_GET_RECENT),
    setCurrent: (dirPath: string): Promise<void> =>
      this.invoke(IPC_CHANNELS.DIRECTORY_SET_CURRENT, { path: dirPath }),
  };

  agents = {
    discover: (workspacePath: string): Promise<AgentDiscoveryResult> =>
      this.invoke(IPC_CHANNELS.AGENTS_DISCOVER, { workspacePath }),
    startSession: (agentId: string, workingDirectory: string): Promise<AgentSession> =>
      this.invoke(IPC_CHANNELS.AGENTS_START_SESSION, { agentId, workingDirectory }),
    stopSession: (sessionId: string): Promise<void> =>
      this.invoke(IPC_CHANNELS.AGENTS_STOP_SESSION, { sessionId }),
    getSession: (agentId: string): Promise<AgentSession | null> =>
      this.invoke(IPC_CHANNELS.AGENTS_GET_SESSION, { agentId }),
    saveBuiltinConfig: (agents: CastleAgentConfig[]): Promise<void> =>
      this.invoke(IPC_CHANNELS.AGENTS_SAVE_BUILTIN_CONFIG, { agents }),
  };

  chat = {
    sendMessage: (agentId: string, content: string, conversationId?: string): Promise<ChatMessage> =>
      this.invoke(IPC_CHANNELS.CHAT_SEND_MESSAGE, { agentId, content, conversationId }),
    getHistory: (agentId: string, limit?: number, offset?: number): Promise<ChatMessage[]> =>
      this.invoke(IPC_CHANNELS.CHAT_GET_HISTORY, { agentId, limit, offset }),
    clearHistory: (agentId: string): Promise<void> =>
      this.invoke(IPC_CHANNELS.CHAT_CLEAR_HISTORY, { agentId }),
    cancelMessage: (agentId: string): Promise<void> =>
      this.invoke(IPC_CHANNELS.CHAT_CANCEL_MESSAGE, { agentId }),
    onStreamChunk: (callback: (message: StreamingMessage) => void): (() => void) =>
      this.on(IPC_CHANNELS.CHAT_STREAM_CHUNK, callback),
    onStreamComplete: (callback: (message: ChatMessage) => void): (() => void) =>
      this.on(IPC_CHANNELS.CHAT_STREAM_COMPLETE, callback),
  };

  permissions = {
    get: (agentId: string): Promise<PermissionSet> =>
      this.invoke(IPC_CHANNELS.PERMISSION_GET, { agentId }),
    set: (agentId: string, permission: keyof PermissionSet, granted: boolean): Promise<void> =>
      this.invoke(IPC_CHANNELS.PERMISSION_SET, { agentId, permission, granted }),
    onRequest: (callback: (request: unknown) => void): (() => void) =>
      this.on(IPC_CHANNELS.PERMISSION_REQUEST, callback),
    respond: (requestId: string, agentId: string, optionId: string, optionKind?: string, toolKind?: string): void => {
      this.invoke(IPC_CHANNELS.PERMISSION_RESPONSE, { requestId, agentId, optionId, optionKind, toolKind });
    },
  };

  permissionGrants = {
    get: (projectPath: string): Promise<PermissionGrant[]> =>
      this.invoke(IPC_CHANNELS.PERMISSION_GRANTS_GET, { projectPath }),
    delete: (grantId: number): Promise<void> =>
      this.invoke(IPC_CHANNELS.PERMISSION_GRANTS_DELETE, { grantId }),
    deleteAll: (projectPath: string): Promise<void> =>
      this.invoke(IPC_CHANNELS.PERMISSION_GRANTS_DELETE_ALL, { projectPath }),
  };

  settings = {
    get: (): Promise<AppSettings> =>
      this.invoke(IPC_CHANNELS.SETTINGS_GET),
    update: (updates: Partial<AppSettings>): Promise<AppSettings> =>
      this.invoke(IPC_CHANNELS.SETTINGS_UPDATE, updates),
  };

  tailscale = {
    restart: (port: number): Promise<{ running: boolean; port?: number; error?: string }> =>
      this.invoke(IPC_CHANNELS.TAILSCALE_RESTART, { port }),
    status: (): Promise<{ running: boolean; port: number | null }> =>
      this.invoke(IPC_CHANNELS.TAILSCALE_STATUS),
  };

  window = {
    minimize: (): void => { /* no-op for remote clients */ },
    maximize: (): void => { /* no-op for remote clients */ },
    close: (): void => { /* no-op for remote clients */ },
  };

  app = {
    onReady: (callback: () => void): (() => void) =>
      this.on(IPC_CHANNELS.APP_READY, callback),
    onError: (callback: (error: { agentId?: string; error: string }) => void): (() => void) =>
      this.on(IPC_CHANNELS.APP_ERROR, callback),
    getActiveModel: (): Promise<string | null> =>
      this.invoke(IPC_CHANNELS.APP_GET_ACTIVE_MODEL),
  };

  tasks = {
    getAll: (state?: string): Promise<Task[]> =>
      this.invoke(IPC_CHANNELS.TASKS_GET_ALL, { state }),
    get: (taskId: string): Promise<Task | null> =>
      this.invoke(IPC_CHANNELS.TASKS_GET, { taskId }),
    create: (input: CreateTaskInput): Promise<Task> =>
      this.invoke(IPC_CHANNELS.TASKS_CREATE, input),
    update: (taskId: string, updates: UpdateTaskInput): Promise<Task> =>
      this.invoke(IPC_CHANNELS.TASKS_UPDATE, { taskId, updates }),
    delete: (taskId: string): Promise<void> =>
      this.invoke(IPC_CHANNELS.TASKS_DELETE, { taskId }),
    getLabels: (): Promise<TaskLabel[]> =>
      this.invoke(IPC_CHANNELS.TASKS_LABELS_GET_ALL),
    createLabel: (name: string, color: string): Promise<TaskLabel> =>
      this.invoke(IPC_CHANNELS.TASKS_LABELS_CREATE, { name, color }),
    deleteLabel: (labelId: string): Promise<void> =>
      this.invoke(IPC_CHANNELS.TASKS_LABELS_DELETE, { labelId }),
    runResearch: (taskId: string, agentId: string, outputPath?: string, conversationId?: string): Promise<{ taskId: string }> =>
      this.invoke(IPC_CHANNELS.TASKS_RUN_RESEARCH, { taskId, agentId, outputPath, conversationId }),
    runImplementation: (taskId: string, agentId: string, conversationId?: string): Promise<{ taskId: string }> =>
      this.invoke(IPC_CHANNELS.TASKS_RUN_IMPLEMENTATION, { taskId, agentId, conversationId }),
    submitResearchReview: (taskId: string, comments: ResearchComment[], researchSnapshot: string): Promise<{ reviewId: string }> =>
      this.invoke(IPC_CHANNELS.TASKS_SUBMIT_RESEARCH_REVIEW, { taskId, comments, researchSnapshot }),
    deleteDiagnosisFile: (filePath: string): Promise<{ deleted: boolean }> =>
      this.invoke(IPC_CHANNELS.TASKS_DELETE_DIAGNOSIS_FILE, { filePath }),
    onDiagnosisFileCleanup: (callback: (data: { taskId: string; filePath: string }) => void): (() => void) =>
      this.on(IPC_CHANNELS.TASKS_DIAGNOSIS_FILE_CLEANUP, callback),
  };

  sync = {
    onTasksChanged: (callback: (data: { action: string; task?: any; taskId?: string }) => void): (() => void) =>
      this.on(IPC_CHANNELS.SYNC_TASKS_CHANGED, callback),
    onChatMessageAdded: (callback: (message: ChatMessage) => void): (() => void) =>
      this.on(IPC_CHANNELS.SYNC_CHAT_MESSAGE_ADDED, callback),
    onPermissionResponded: (callback: (data: { requestId: string }) => void): (() => void) =>
      this.on(IPC_CHANNELS.SYNC_PERMISSION_RESPONDED, callback),
    onStreamingStarted: (callback: (data: { agentId: string; conversationId?: string }) => void): (() => void) =>
      this.on(IPC_CHANNELS.SYNC_STREAMING_STARTED, callback),
    onConversationsChanged: (callback: (data: { action: string; conversation?: Conversation; conversationId?: string }) => void): (() => void) =>
      this.on(IPC_CHANNELS.SYNC_CONVERSATIONS_CHANGED, callback),
  };

  conversations = {
    getAll: (agentId: string): Promise<Conversation[]> =>
      this.invoke(IPC_CHANNELS.CONVERSATIONS_GET_ALL, { agentId }),
    get: (conversationId: string): Promise<Conversation | null> =>
      this.invoke(IPC_CHANNELS.CONVERSATIONS_GET, { conversationId }),
    create: (input: CreateConversationInput): Promise<Conversation> =>
      this.invoke(IPC_CHANNELS.CONVERSATIONS_CREATE, input),
    update: (conversationId: string, updates: UpdateConversationInput): Promise<Conversation> =>
      this.invoke(IPC_CHANNELS.CONVERSATIONS_UPDATE, { conversationId, updates }),
    delete: (conversationId: string): Promise<void> =>
      this.invoke(IPC_CHANNELS.CONVERSATIONS_DELETE, { conversationId }),
    deleteAll: (agentId: string): Promise<void> =>
      this.invoke(IPC_CHANNELS.CONVERSATIONS_DELETE_ALL, { agentId }),
    getMessages: (conversationId: string, limit?: number, offset?: number): Promise<ChatMessage[]> =>
      this.invoke(IPC_CHANNELS.CONVERSATIONS_GET_MESSAGES, { conversationId, limit, offset }),
  };
}
