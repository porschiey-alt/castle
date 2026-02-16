/**
 * Electron Service - Bridge to Electron IPC API
 */

import { Injectable, NgZone } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import type { ElectronAPI } from '../../../preload/index';
import type { Agent, AgentDiscoveryResult, AgentSession } from '../../../shared/types/agent.types';
import type { ChatMessage, StreamingMessage } from '../../../shared/types/message.types';
import type { AppSettings, PermissionSet, PermissionResponse } from '../../../shared/types/settings.types';
import type { Task, TaskLabel, CreateTaskInput, UpdateTaskInput } from '../../../shared/types/task.types';

@Injectable({
  providedIn: 'root'
})
export class ElectronService {
  private api: ElectronAPI | null = null;
  
  // Subjects for streaming events
  private streamChunkSubject = new Subject<StreamingMessage>();
  private streamCompleteSubject = new Subject<ChatMessage>();
  private errorSubject = new Subject<{ agentId?: string; error: string }>();
  private permissionRequestSubject = new Subject<any>();

  // Observables
  readonly streamChunk$ = this.streamChunkSubject.asObservable();
  readonly streamComplete$ = this.streamCompleteSubject.asObservable();
  readonly error$ = this.errorSubject.asObservable();
  readonly permissionRequest$ = this.permissionRequestSubject.asObservable();

  constructor(private ngZone: NgZone) {
    this.initializeApi();
  }

  private initializeApi(): void {
    if (typeof window !== 'undefined' && window.electronAPI) {
      this.api = window.electronAPI;
      this.setupEventListeners();
    } else {
      console.warn('Electron API not available - running in browser mode');
    }
  }

  private setupEventListeners(): void {
    if (!this.api) return;

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
  }

  get isElectron(): boolean {
    return this.api !== null;
  }

  // ============ Directory Methods ============

  async selectDirectory(): Promise<string | null> {
    if (!this.api) return null;
    return this.api.directory.select();
  }

  async getCurrentDirectory(): Promise<string | null> {
    if (!this.api) return null;
    return this.api.directory.getCurrent();
  }

  async getRecentDirectories(): Promise<string[]> {
    if (!this.api) return [];
    return this.api.directory.getRecent();
  }

  // ============ Agent Methods ============

  async discoverAgents(workspacePath: string): Promise<AgentDiscoveryResult | null> {
    if (!this.api) return null;
    return this.api.agents.discover(workspacePath);
  }

  async startAgentSession(agentId: string, workingDirectory: string): Promise<AgentSession | null> {
    if (!this.api) return null;
    return this.api.agents.startSession(agentId, workingDirectory);
  }

  async stopAgentSession(sessionId: string): Promise<void> {
    if (!this.api) return;
    return this.api.agents.stopSession(sessionId);
  }

  async getAgentSession(agentId: string): Promise<AgentSession | null> {
    if (!this.api) return null;
    return this.api.agents.getSession(agentId);
  }

  // ============ Chat Methods ============

  async sendMessage(agentId: string, content: string): Promise<ChatMessage | null> {
    if (!this.api) return null;
    return this.api.chat.sendMessage(agentId, content);
  }

  async getChatHistory(agentId: string, limit?: number, offset?: number): Promise<ChatMessage[]> {
    if (!this.api) return [];
    return this.api.chat.getHistory(agentId, limit, offset);
  }

  async clearChatHistory(agentId: string): Promise<void> {
    if (!this.api) return;
    return this.api.chat.clearHistory(agentId);
  }

  // ============ Permission Methods ============

  async getPermissions(agentId: string): Promise<PermissionSet | null> {
    if (!this.api) return null;
    return this.api.permissions.get(agentId);
  }

  async setPermission(
    agentId: string, 
    permission: keyof PermissionSet, 
    granted: boolean
  ): Promise<void> {
    if (!this.api) return;
    return this.api.permissions.set(agentId, permission, granted);
  }

  respondToPermissionRequest(requestId: string, agentId: string, optionId: string): void {
    if (!this.api) return;
    this.api.permissions.respond(requestId, agentId, optionId);
  }

  // ============ Settings Methods ============

  async getSettings(): Promise<AppSettings | null> {
    if (!this.api) return null;
    return this.api.settings.get();
  }

  async updateSettings(updates: Partial<AppSettings>): Promise<AppSettings | null> {
    if (!this.api) return null;
    return this.api.settings.update(updates);
  }

  // ============ Window Methods ============

  minimizeWindow(): void {
    if (!this.api) return;
    this.api.window.minimize();
  }

  maximizeWindow(): void {
    if (!this.api) return;
    this.api.window.maximize();
  }

  closeWindow(): void {
    if (!this.api) return;
    this.api.window.close();
  }

  // ============ App Methods ============

  async getActiveModel(): Promise<string | null> {
    if (!this.api) return null;
    return this.api.app.getActiveModel();
  }

  // ============ Task Methods ============

  async getTasks(state?: string): Promise<Task[]> {
    if (!this.api) return [];
    return this.api.tasks.getAll(state);
  }

  async getTask(taskId: string): Promise<Task | null> {
    if (!this.api) return null;
    return this.api.tasks.get(taskId);
  }

  async createTask(input: CreateTaskInput): Promise<Task | null> {
    if (!this.api) return null;
    return this.api.tasks.create(input);
  }

  async updateTask(taskId: string, updates: UpdateTaskInput): Promise<Task | null> {
    if (!this.api) return null;
    return this.api.tasks.update(taskId, updates);
  }

  async deleteTask(taskId: string): Promise<void> {
    if (!this.api) return;
    return this.api.tasks.delete(taskId);
  }

  async getTaskLabels(): Promise<TaskLabel[]> {
    if (!this.api) return [];
    return this.api.tasks.getLabels();
  }

  async createTaskLabel(name: string, color: string): Promise<TaskLabel | null> {
    if (!this.api) return null;
    return this.api.tasks.createLabel(name, color);
  }

  async deleteTaskLabel(labelId: string): Promise<void> {
    if (!this.api) return;
    return this.api.tasks.deleteLabel(labelId);
  }

  async runTaskResearch(taskId: string, agentId: string, outputPath?: string): Promise<{ taskId: string } | null> {
    if (!this.api) return null;
    return this.api.tasks.runResearch(taskId, agentId, outputPath);
  }
}
