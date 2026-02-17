/**
 * Main Layout Component - Discord-like layout with sidebar and chat area
 */

import { Component, OnInit, OnDestroy, inject, ViewChild } from '@angular/core';
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
import { PermissionDialogComponent } from '../shared/components/permission-dialog/permission-dialog.component';

import { AgentDialogComponent, AgentDialogData, AgentDialogResult } from '../shared/components/agent-dialog/agent-dialog.component';

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

    // Load current directory
    this.currentDirectory = await this.electronService.getCurrentDirectory();
    
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
  }

  private showPermissionDialog(request: any): void {
    const dialogRef = this.dialog.open(PermissionDialogComponent, {
      data: request,
      width: '480px',
      disableClose: true,
      panelClass: 'permission-dialog'
    });

    this.openPermissionDialogs.set(request.requestId, dialogRef);

    dialogRef.afterClosed().subscribe((optionId: string) => {
      this.openPermissionDialogs.delete(request.requestId);
      if (optionId) {
        // Find the option to get its kind for persistence
        const selectedOption = request.options?.find((o: any) => o.optionId === optionId);
        this.electronService.respondToPermissionRequest(
          request.requestId,
          request.agentId,
          optionId,
          selectedOption?.kind,
          request.toolCall?.kind
        );
      }
    });
  }

  async openDirectory(): Promise<void> {
    const directory = await this.electronService.selectDirectory();
    if (directory) {
      this.currentDirectory = directory;
      this.activeView = 'chat';
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
    }
  }

  async openRecentDirectory(dirPath: string): Promise<void> {
    await this.electronService.setCurrentDirectory(dirPath);
    this.currentDirectory = dirPath;
    this.activeView = 'chat';
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
  }

  getDirectoryName(dirPath: string): string {
    const parts = dirPath.split(/[/\\]/);
    return parts[parts.length - 1] || dirPath;
  }

  showSettings(): void {
    this.activeView = 'settings';
    this.closeSidebar();
  }

  backToLanding(): void {
    this.activeView = 'chat';
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
  }

  closeSidebar(): void {
    this.sidebarOpen = false;
  }

  showTasks(): void {
    this.activeView = 'tasks';
    this.closeSidebar();
    // Load tasks when switching to view
    this.taskService.loadTasks();
  }

  showChat(): void {
    this.activeView = 'chat';
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
