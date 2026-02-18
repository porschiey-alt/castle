/**
 * Main Layout Component - Discord-like layout with sidebar and chat area
 */

import { Component, OnInit, OnDestroy, inject, ViewChild, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { Subscription } from 'rxjs';

import { SidebarComponent } from '../features/sidebar/sidebar.component';
import { ChatComponent } from '../features/chat/chat.component';
import { ConversationListComponent } from '../features/chat/conversation-list/conversation-list.component';
import { TaskListComponent } from '../features/tasks/task-list/task-list.component';
import { SettingsPageComponent } from '../features/settings/settings-page.component';
import { StatusBarComponent } from '../shared/components/status-bar/status-bar.component';
import { PermissionDialogComponent, PermissionDialogResult } from '../shared/components/permission-dialog/permission-dialog.component';
import { ConfirmDialogComponent, type ConfirmDialogData } from '../shared/components/confirm-dialog/confirm-dialog.component';

import { AgentDialogComponent, AgentDialogData, AgentDialogResult } from '../shared/components/agent-dialog/agent-dialog.component';
import { AgentIconComponent } from '../shared/components/agent-icon/agent-icon.component';

import { ElectronService } from '../core/services/electron.service';
import { AgentService } from '../core/services/agent.service';
import { TaskService } from '../core/services/task.service';
import { ConversationService } from '../core/services/conversation.service';
import { ChatService } from '../core/services/chat.service';

import type { AgentWithSession } from '../../shared/types/agent.types';
import type { CastleAgentConfig } from '../../shared/types/agent.types';

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [
    CommonModule,
    MatSidenavModule,
    MatToolbarModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatDialogModule,
    SidebarComponent,
    ChatComponent,
    ConversationListComponent,
    TaskListComponent,
    SettingsPageComponent,
    StatusBarComponent,
    AgentIconComponent,
  ],
  templateUrl: './main-layout.component.html',
  styleUrl: './main-layout.component.scss'
})
export class MainLayoutComponent implements OnInit, OnDestroy {
  private electronService = inject(ElectronService);
  private agentService = inject(AgentService);
  private taskService = inject(TaskService);
  private conversationService = inject(ConversationService);
  private chatService = inject(ChatService);
  private dialog = inject(MatDialog);
  private permissionSub?: Subscription;
  private permissionRespondedSub?: Subscription;
  private confirmSub?: Subscription;
  private openPermissionDialogs = new Map<string, import('@angular/material/dialog').MatDialogRef<any>>();

  @ViewChild(StatusBarComponent) statusBar!: StatusBarComponent;

  // Expose signals to template
  selectedAgent = this.agentService.selectedAgent;
  activeConversation = this.conversationService.activeConversation;
  
  currentDirectory: string | null = null;
  activeView: 'chat' | 'tasks' | 'settings' = 'chat';
  recentDirectories: string[] = [];
  sidebarOpen = false;
  conversationPanelOpen = window.innerWidth > 768;
  nonGitBannerVisible = false;
  nonGitBannerDismissed = false;

  constructor() {
    // React to agent/conversation signal changes for title updates
    effect(() => {
      const agent = this.selectedAgent();
      const conversation = this.activeConversation();
      // Reading signals inside effect to track them; actual title set via updateWindowTitle
      this.updateWindowTitle();
    });
  }

  async ngOnInit(): Promise<void> {
    // Listen for permission requests from Copilot
    this.permissionSub = this.electronService.permissionRequest$.subscribe((request) => {
      this.showPermissionDialog(request);
    });

    // Listen for permission responses from other devices — dismiss local dialog
    this.permissionRespondedSub = this.electronService.permissionResponded$.subscribe(({ requestId }) => {
      const dialogRef = this.openPermissionDialogs.get(requestId);
      if (dialogRef) {
        dialogRef.close(); // close without emitting a response
        this.openPermissionDialogs.delete(requestId);
      }
    });

    // Listen for confirm dialog requests from main process
    this.confirmSub = this.electronService.confirmRequest$.subscribe((request) => {
      this.showConfirmDialog(request);
    });

    // Load current directory
    this.currentDirectory = await this.electronService.getCurrentDirectory();
    
    // Check if the project is a git repo for non-git banner
    if (this.currentDirectory) {
      try {
        const gitInfo = await this.electronService.checkGit(this.currentDirectory);
        this.nonGitBannerVisible = !gitInfo.isGitRepo;
      } catch {
        this.nonGitBannerVisible = false;
      }
    }

    // Discover agents if directory is set (this auto-selects and starts session for first agent)
    if (this.currentDirectory) {
      await this.agentService.discoverAgents(this.currentDirectory);
      // Load conversations for the auto-selected agent and select the most recent
      const agentId = this.agentService.selectedAgentId();
      if (agentId) {
        await this.conversationService.loadConversations(agentId);
        this.conversationService.selectMostRecent();
      }
    } else {
      this.recentDirectories = await this.electronService.getRecentDirectories();
    }
  }

  ngOnDestroy(): void {
    this.permissionSub?.unsubscribe();
    this.permissionRespondedSub?.unsubscribe();
    this.confirmSub?.unsubscribe();
  }

  private updateWindowTitle(): void {
    if (this.activeView === 'tasks') {
      document.title = 'Castle: Tasks';
    } else if (this.activeView === 'settings') {
      document.title = 'Castle: Settings';
    } else {
      const agent = this.selectedAgent();
      if (agent) {
        document.title = `Castle: ${agent.name}`;
      } else {
        document.title = 'Castle';
      }
    }
  }

  private showPermissionDialog(request: any): void {
    const dialogRef = this.dialog.open(PermissionDialogComponent, {
      data: request,
      width: '480px',
      disableClose: true,
      panelClass: 'permission-dialog'
    });

    this.openPermissionDialogs.set(request.requestId, dialogRef);

    dialogRef.afterClosed().subscribe((result: PermissionDialogResult | undefined) => {
      this.openPermissionDialogs.delete(request.requestId);
      if (result?.optionId) {
        // Find the option to get its kind for persistence
        const selectedOption = request.options?.find((o: any) => o.optionId === result.optionId);
        this.electronService.respondToPermissionRequest(
          request.requestId,
          request.agentId,
          result.optionId,
          selectedOption?.kind,
          request.toolCall?.kind,
          result.scopeType,
          result.scopeValue,
        );
      }
    });
  }

  private showConfirmDialog(request: { requestId: string; title: string; message: string; detail?: string; confirmText?: string; cancelText?: string }): void {
    const message = request.detail ? `${request.message}\n\n${request.detail}` : request.message;
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: request.title,
        message,
        confirmText: request.confirmText ?? 'Confirm',
        cancelText: request.cancelText ?? 'Cancel',
      } as ConfirmDialogData,
      width: '480px',
      disableClose: true,
      panelClass: 'confirm-dialog'
    });

    dialogRef.afterClosed().subscribe((confirmed: boolean | undefined) => {
      this.electronService.respondToConfirmRequest(request.requestId, !!confirmed);
    });
  }

  async openDirectory(): Promise<void> {
    const directory = await this.electronService.selectDirectory();
    if (directory) {
      this.currentDirectory = directory;
      this.activeView = 'chat';
      this.updateWindowTitle();
      this.nonGitBannerDismissed = false;
      await this.agentService.discoverAgents(directory);
      // Load conversations for the auto-selected agent and select the most recent
      const agentId = this.agentService.selectedAgentId();
      if (agentId) {
        await this.conversationService.loadConversations(agentId);
        this.conversationService.selectMostRecent();
      }
      // Update status bar
      if (this.statusBar) {
        this.statusBar.updateDirectory(directory);
      }
      // Check if git repo
      try {
        const gitInfo = await this.electronService.checkGit(directory);
        this.nonGitBannerVisible = !gitInfo.isGitRepo;
      } catch { this.nonGitBannerVisible = false; }
    }
  }

  async openRecentDirectory(dirPath: string): Promise<void> {
    await this.electronService.setCurrentDirectory(dirPath);
    this.currentDirectory = dirPath;
    this.activeView = 'chat';
    this.updateWindowTitle();
    this.nonGitBannerDismissed = false;
    await this.agentService.discoverAgents(dirPath);
    // Load conversations for the auto-selected agent and select the most recent
    const agentId = this.agentService.selectedAgentId();
    if (agentId) {
      await this.conversationService.loadConversations(agentId);
      this.conversationService.selectMostRecent();
    }
    if (this.statusBar) {
      this.statusBar.updateDirectory(dirPath);
    }
    // Check if git repo
    try {
      const gitInfo = await this.electronService.checkGit(dirPath);
      this.nonGitBannerVisible = !gitInfo.isGitRepo;
    } catch { this.nonGitBannerVisible = false; }
  }

  getDirectoryName(dirPath: string): string {
    const parts = dirPath.split(/[/\\]/);
    return parts[parts.length - 1] || dirPath;
  }

  showSettings(): void {
    this.activeView = 'settings';
    this.updateWindowTitle();
    this.closeSidebar();
  }

  backToLanding(): void {
    this.activeView = 'chat';
    this.updateWindowTitle();
  }

  addAgent(): void {
    const dialogRef = this.dialog.open(AgentDialogComponent, {
      data: {} as AgentDialogData,
      width: '520px',
      panelClass: 'agent-dialog',
    });

    dialogRef.afterClosed().subscribe(async (result: AgentDialogResult | undefined) => {
      if (!result || result.action !== 'save') return;
      const configs = this.agentService.getBuiltinAgentConfigs();
      configs.push(result.agent);
      await this.agentService.saveAgentsConfig(configs);
    });
  }

  editAgent(agent: AgentWithSession): void {
    const agentConfig: CastleAgentConfig = {
      name: agent.name,
      icon: agent.icon,
      color: agent.color,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
    };

    const dialogRef = this.dialog.open(AgentDialogComponent, {
      data: { agent: agentConfig } as AgentDialogData,
      width: '520px',
      panelClass: 'agent-dialog',
    });

    dialogRef.afterClosed().subscribe(async (result: AgentDialogResult | undefined) => {
      if (!result) return;
      const configs = this.agentService.getBuiltinAgentConfigs();
      if (result.action === 'save') {
        const idx = configs.findIndex(c => c.name === agent.name);
        if (idx >= 0) {
          configs[idx] = result.agent;
        } else {
          configs.push(result.agent);
        }
      } else if (result.action === 'delete') {
        const idx = configs.findIndex(c => c.name === agent.name);
        if (idx >= 0) configs.splice(idx, 1);
      }
      await this.agentService.saveAgentsConfig(configs);
    });
  }

  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
    // On mobile, also expand the conversation panel when opening the sidebar
    if (this.sidebarOpen && window.innerWidth <= 768) {
      this.conversationPanelOpen = true;
    }
  }

  closeSidebar(): void {
    this.sidebarOpen = false;
    // On mobile, also close the conversation panel when closing the sidebar
    if (window.innerWidth <= 768) {
      this.conversationPanelOpen = false;
    }
  }

  showTasks(): void {
    this.activeView = 'tasks';
    this.updateWindowTitle();
    this.closeSidebar();
    // Load tasks when switching to view
    this.taskService.loadTasks();
  }

  goToTask(taskId: string): void {
    this.taskService.selectTask(taskId);
    this.showTasks();
  }

  showChat(): void {
    this.activeView = 'chat';
    this.updateWindowTitle();
    this.closeSidebar();
    // Load conversations for the selected agent and auto-select the most recent
    const agentId = this.agentService.selectedAgentId();
    if (agentId) {
      this.conversationService.loadConversations(agentId).then(() => {
        this.conversationService.selectMostRecent();
      });
    }
  }

  async onConversationSelected(conversationId: string): Promise<void> {
    const agentId = this.agentService.selectedAgentId();
    if (agentId) {
      await this.chatService.loadHistory(agentId);
    }
    // Close conversation panel on mobile after selection
    if (window.innerWidth <= 768) {
      this.conversationPanelOpen = false;
    }
  }

  toggleConversationPanel(): void {
    this.conversationPanelOpen = !this.conversationPanelOpen;
  }

  goToAgent(agentId: string, newConversation = false): void {
    this.agentService.selectAgent(agentId);
    this.conversationService.loadConversations(agentId).then(() => {
      if (newConversation) {
        this.conversationService.selectConversation(null);
      } else {
        this.conversationService.selectMostRecent();
      }
    });
    this.activeView = 'chat';
    this.updateWindowTitle();
    this.closeSidebar();
  }

  async goToAgentWithNewConversation(event: { agentId: string; title: string }): Promise<void> {
    this.agentService.selectAgent(event.agentId);
    await this.conversationService.loadConversations(event.agentId);
    await this.conversationService.createConversation(event.agentId, event.title);
    this.activeView = 'chat';
    this.updateWindowTitle();
    this.closeSidebar();
  }

  minimizeWindow(): void {
    this.electronService.minimizeWindow();
  }

  maximizeWindow(): void {
    this.electronService.maximizeWindow();
  }

  closeWindow(): void {
    this.electronService.closeWindow();
  }
}
