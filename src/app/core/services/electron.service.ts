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
  private streamingStartedSubject = new Subject<{ agentId: string; conversationId?: string }>();
  private conversationsChangedSubject = new Subject<{ action: string; conversation?: Conversation; conversationId?: string }>();
  private worktreeLifecycleSubject = new Subject<{ taskId: string; agentId: string; taskTitle: string; phase: string; message?: string }>();
  private confirmRequestSubject = new Subject<{ requestId: string; title: string; message: string; detail?: string; confirmText?: string; cancelText?: string }>();

  // Observables
  readonly streamChunk$ = this.streamChunkSubject.asObservable();
  readonly streamComplete$ = this.streamCompleteSubject.asObservable();
  readonly error$ = this.errorSubject.asObservable();
  readonly permissionRequest$ = this.permissionRequestSubject.asObservable();
  readonly tasksChanged$ = this.tasksChangedSubject.asObservable();
  readonly chatMessageAdded$ = this.chatMessageAddedSubject.asObservable();
  readonly permissionResponded$ = this.permissionRespondedSubject.asObservable();
  readonly streamingStarted$ = this.streamingStartedSubject.asObservable();
  readonly conversationsChanged$ = this.conversationsChangedSubject.asObservable();
  readonly worktreeLifecycle$ = this.worktreeLifecycleSubject.asObservable();
  readonly confirmRequest$ = this.confirmRequestSubject.asObservable();

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

    this.api.sync.onStreamingStarted((data) => {
      this.ngZone.run(() => {
        this.streamingStartedSubject.next(data);
      });
    });

    this.api.sync.onConversationsChanged((data) => {
      this.ngZone.run(() => {
        this.conversationsChangedSubject.next(data);
      });
    });

    this.api.worktree.onLifecycle((event) => {
      this.ngZone.run(() => {
        this.worktreeLifecycleSubject.next(event);
      });
    });

    this.api.confirm.onRequest((data) => {
      this.ngZone.run(() => {
        this.confirmRequestSubject.next(data);
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

  respondToPermissionRequest(requestId: string, agentId: string, optionId: string, optionKind?: string, toolKind?: string, scopeType?: string, scopeValue?: string): void {
    this.api.permissions.respond(requestId, agentId, optionId, optionKind, toolKind, scopeType, scopeValue);
  }

  respondToConfirmRequest(requestId: string, confirmed: boolean): void {
    this.api.confirm.respond(requestId, confirmed);
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

  async runTaskResearch(taskId: string, agentId: string, outputPath?: string, conversationId?: string): Promise<{ taskId: string } | null> {
    return this.api.tasks.runResearch(taskId, agentId, outputPath, conversationId);
  }

  async runTaskImplementation(taskId: string, agentId: string, conversationId?: string): Promise<{ taskId: string } | null> {
    return this.api.tasks.runImplementation(taskId, agentId, conversationId);
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

  // ============ GitHub Issues Methods ============

  async checkGitHubIssues(): Promise<{ available: boolean; repo: string | null }> {
    return this.api.githubIssues.check();
  }

  async listGitHubIssues(state?: 'open' | 'closed' | 'all'): Promise<{ number: number; title: string; body: string; state: string; labels: string[]; url: string }[]> {
    return this.api.githubIssues.list(state);
  }

  async pushToGitHub(taskId: string): Promise<Task> {
    return this.api.githubIssues.push(taskId);
  }

  async importFromGitHub(issueNumbers: number[]): Promise<Task[]> {
    return this.api.githubIssues.import(issueNumbers);
  }

  async unlinkFromGitHub(taskId: string): Promise<Task> {
    return this.api.githubIssues.unlink(taskId);
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

  // ============ Worktree Methods ============

  async createWorktree(repoPath: string, taskTitle: string, taskId: string, kind?: string): Promise<{ worktreePath: string; branchName: string }> {
    return this.api.worktree.create(repoPath, taskTitle, taskId, kind);
  }

  async removeWorktree(worktreePath: string, deleteBranch?: boolean): Promise<void> {
    return this.api.worktree.remove(worktreePath, deleteBranch);
  }

  async listWorktrees(repoPath: string): Promise<{ path: string; branch: string; head: string; isMainWorktree: boolean }[]> {
    return this.api.worktree.list(repoPath);
  }

  async getWorktreeStatus(worktreePath: string): Promise<{ exists: boolean; branch?: string; hasChanges?: boolean }> {
    return this.api.worktree.status(worktreePath);
  }

  async createPullRequest(worktreePath: string, title: string, body: string, draft?: boolean): Promise<{ success: boolean; url?: string; prNumber?: number; error?: string }> {
    return this.api.worktree.createPR(worktreePath, title, body, draft);
  }

  async getWorktreeDiff(worktreePath: string): Promise<{ summary: string; diff: string }> {
    return this.api.worktree.getDiff(worktreePath);
  }

  async commitWorktree(worktreePath: string, message: string): Promise<{ committed: boolean }> {
    return this.api.worktree.commit(worktreePath, message);
  }

  async checkGit(repoPath: string): Promise<{ isGitRepo: boolean; hasUncommittedChanges: boolean; currentBranch: string | null }> {
    return this.api.worktree.checkGit(repoPath);
  }

  onWorktreeLifecycle(callback: (event: { taskId: string; agentId: string; taskTitle: string; phase: string; message?: string }) => void): void {
    this.api.worktree.onLifecycle(callback);
  }
}
