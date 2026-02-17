/**
 * Electron Service - Bridge to Electron IPC API
 *
 * Uses ApiService to automatically select between native Electron IPC
 * (when running in the Electron shell) and a WebSocket bridge (when
 * loaded from a remote browser over Tailscale).
 */

import { Injectable, NgZone, inject } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import type { ElectronAPI } from '../../../preload/index';
import type { Agent, AgentDiscoveryResult, AgentSession, CastleAgentConfig } from '../../../shared/types/agent.types';
import type { ChatMessage, StreamingMessage } from '../../../shared/types/message.types';
import type { AppSettings, PermissionSet, PermissionResponse, PermissionGrant } from '../../../shared/types/settings.types';
import type { Task, TaskLabel, CreateTaskInput, UpdateTaskInput, ResearchComment } from '../../../shared/types/task.types';
import type { Conversation, CreateConversationInput, UpdateConversationInput } from '../../../shared/types/conversation.types';
import { ApiService } from './api.service';

@Injectable({
  providedIn: 'root'
})
export class ElectronService {
  private api: ElectronAPI;
  private apiService = inject(ApiService);
  
  // Subjects for streaming events
  private streamChunkSubject = new Subject<StreamingMessage>();
  private streamCompleteSubject = new Subject<ChatMessage>();
  private errorSubject = new Subject<{ agentId?: string; error: string }>();
  private permissionRequestSubject = new Subject<any>();
  private tasksChangedSubject = new Subject<{ action: string; task?: Task; taskId?: string }>();
  private chatMessageAddedSubject = new Subject<ChatMessage>();
  private permissionRespondedSubject = new Subject<{ requestId: string }>();
  private conversationsChangedSubject = new Subject<{ action: string; conversation?: Conversation; conversationId?: string }>();

  // Observables
  readonly streamChunk$ = this.streamChunkSubject.asObservable();
  readonly streamComplete$ = this.streamCompleteSubject.asObservable();
  readonly error$ = this.errorSubject.asObservable();
  readonly permissionRequest$ = this.permissionRequestSubject.asObservable();
  readonly tasksChanged$ = this.tasksChangedSubject.asObservable();
  readonly chatMessageAdded$ = this.chatMessageAddedSubject.asObservable();
  readonly permissionResponded$ = this.permissionRespondedSubject.asObservable();
  readonly conversationsChanged$ = this.conversationsChangedSubject.asObservable();

  constructor(private ngZone: NgZone) {
    this.api = this.apiService.api;
    this.setupEventListeners();
  }

  private setupEventListeners(): void {

    // Subscribe to streaming events
    this.api.chat.onStreamChunk((message) => {
      this.ngZone.run(() => {
        this.streamChunkSubject.next(message);
      });
    });

    this.api.chat.onStreamComplete((message) => {
      this.ngZone.run(() => {
        this.streamCompleteSubject.next(message);
      });
    });

    this.api.app.onError((error) => {
      this.ngZone.run(() => {
        this.errorSubject.next(error);
      });
    });

    this.api.permissions.onRequest((request) => {
      this.ngZone.run(() => {
        this.permissionRequestSubject.next(request);
      });
    });

    this.api.sync.onTasksChanged((data) => {
      this.ngZone.run(() => {
        this.tasksChangedSubject.next(data);
      });
    });

    this.api.sync.onChatMessageAdded((message) => {
      this.ngZone.run(() => {
        this.chatMessageAddedSubject.next(message);
      });
    });

    this.api.sync.onPermissionResponded((data) => {
      this.ngZone.run(() => {
        this.permissionRespondedSubject.next(data);
      });
    });

    this.api.sync.onConversationsChanged((data) => {
      this.ngZone.run(() => {
        this.conversationsChangedSubject.next(data);
      });
    });
  }

  get isElectron(): boolean {
    return this.apiService.isElectron;
  }

  // ============ Directory Methods ============

  async selectDirectory(): Promise<string | null> {
    return this.api.directory.select();
  }

  async getCurrentDirectory(): Promise<string | null> {
    return this.api.directory.getCurrent();
  }

  async getRecentDirectories(): Promise<string[]> {
    return this.api.directory.getRecent();
  }

  async setCurrentDirectory(dirPath: string): Promise<void> {
    return this.api.directory.setCurrent(dirPath);
  }

  // ============ Agent Methods ============

  async discoverAgents(workspacePath: string): Promise<AgentDiscoveryResult | null> {
    return this.api.agents.discover(workspacePath);
  }

  async startAgentSession(agentId: string, workingDirectory: string): Promise<AgentSession | null> {
    return this.api.agents.startSession(agentId, workingDirectory);
  }

  async stopAgentSession(sessionId: string): Promise<void> {
    return this.api.agents.stopSession(sessionId);
  }

  async getAgentSession(agentId: string): Promise<AgentSession | null> {
    return this.api.agents.getSession(agentId);
  }

  async saveBuiltinAgentsConfig(agents: CastleAgentConfig[]): Promise<void> {
    return this.api.agents.saveBuiltinConfig(agents);
  }

  // ============ Chat Methods ============

  async sendMessage(agentId: string, content: string, conversationId?: string): Promise<ChatMessage | null> {
    return this.api.chat.sendMessage(agentId, content, conversationId);
  }

  async getChatHistory(agentId: string, limit?: number, offset?: number): Promise<ChatMessage[]> {
    return this.api.chat.getHistory(agentId, limit, offset);
  }

  async clearChatHistory(agentId: string): Promise<void> {
    return this.api.chat.clearHistory(agentId);
  }

  async cancelMessage(agentId: string): Promise<void> {
    return this.api.chat.cancelMessage(agentId);
  }

  // ============ Permission Methods ============

  async getPermissions(agentId: string): Promise<PermissionSet | null> {
    return this.api.permissions.get(agentId);
  }

  async setPermission(
    agentId: string, 
    permission: keyof PermissionSet, 
    granted: boolean
  ): Promise<void> {
    return this.api.permissions.set(agentId, permission, granted);
  }

  respondToPermissionRequest(requestId: string, agentId: string, optionId: string, optionKind?: string, toolKind?: string): void {
    this.api.permissions.respond(requestId, agentId, optionId, optionKind, toolKind);
  }

  // ============ Permission Grant Methods ============

  async getPermissionGrants(projectPath: string): Promise<PermissionGrant[]> {
    return this.api.permissionGrants.get(projectPath);
  }

  async deletePermissionGrant(grantId: number): Promise<void> {
    return this.api.permissionGrants.delete(grantId);
  }

  async deleteAllPermissionGrants(projectPath: string): Promise<void> {
    return this.api.permissionGrants.deleteAll(projectPath);
  }

  // ============ Settings Methods ============

  async getSettings(): Promise<AppSettings | null> {
    return this.api.settings.get();
  }

  async updateSettings(updates: Partial<AppSettings>): Promise<AppSettings | null> {
    return this.api.settings.update(updates);
  }

  // ============ Tailscale Methods ============

  async restartTailscale(port: number): Promise<{ running: boolean; port?: number; error?: string }> {
    return this.api.tailscale.restart(port);
  }

  async getTailscaleStatus(): Promise<{ running: boolean; port: number | null }> {
    return this.api.tailscale.status();
  }

  // ============ Window Methods ============

  minimizeWindow(): void {
    this.api.window.minimize();
  }

  maximizeWindow(): void {
    this.api.window.maximize();
  }

  closeWindow(): void {
    this.api.window.close();
  }

  // ============ App Methods ============

  async getActiveModel(): Promise<string | null> {
    return this.api.app.getActiveModel();
  }

  // ============ Task Methods ============

  async getTasks(state?: string): Promise<Task[]> {
    return this.api.tasks.getAll(state);
  }

  async getTask(taskId: string): Promise<Task | null> {
    return this.api.tasks.get(taskId);
  }

  async createTask(input: CreateTaskInput): Promise<Task | null> {
    return this.api.tasks.create(input);
  }

  async updateTask(taskId: string, updates: UpdateTaskInput): Promise<Task | null> {
    return this.api.tasks.update(taskId, updates);
  }

  async deleteTask(taskId: string): Promise<void> {
    return this.api.tasks.delete(taskId);
  }

  async getTaskLabels(): Promise<TaskLabel[]> {
    return this.api.tasks.getLabels();
  }

  async createTaskLabel(name: string, color: string): Promise<TaskLabel | null> {
    return this.api.tasks.createLabel(name, color);
  }

  async deleteTaskLabel(labelId: string): Promise<void> {
    return this.api.tasks.deleteLabel(labelId);
  }

  async runTaskResearch(taskId: string, agentId: string, outputPath?: string): Promise<{ taskId: string } | null> {
    return this.api.tasks.runResearch(taskId, agentId, outputPath);
  }

  async runTaskImplementation(taskId: string, agentId: string): Promise<{ taskId: string } | null> {
    return this.api.tasks.runImplementation(taskId, agentId);
  }

  async submitResearchReview(taskId: string, comments: ResearchComment[], researchSnapshot: string): Promise<{ reviewId: string } | null> {
    return this.api.tasks.submitResearchReview(taskId, comments, researchSnapshot);
  }

  async deleteDiagnosisFile(filePath: string): Promise<{ deleted: boolean } | null> {
    return this.api.tasks.deleteDiagnosisFile(filePath);
  }

  onDiagnosisFileCleanup(callback: (data: { taskId: string; filePath: string }) => void): () => void {
    return this.api.tasks.onDiagnosisFileCleanup(callback);
  }

  // ============ Conversation Methods ============

  async getConversations(agentId: string): Promise<Conversation[]> {
    return this.api.conversations.getAll(agentId);
  }

  async getConversation(conversationId: string): Promise<Conversation | null> {
    return this.api.conversations.get(conversationId);
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation | null> {
    return this.api.conversations.create(input);
  }

  async updateConversation(conversationId: string, updates: UpdateConversationInput): Promise<Conversation | null> {
    return this.api.conversations.update(conversationId, updates);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    return this.api.conversations.delete(conversationId);
  }

  async deleteAllConversations(agentId: string): Promise<void> {
    return this.api.conversations.deleteAll(agentId);
  }

  async getConversationMessages(conversationId: string, limit?: number, offset?: number): Promise<ChatMessage[]> {
    return this.api.conversations.getMessages(conversationId, limit, offset);
  }
}
