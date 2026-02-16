/**
 * Main Layout Component - Discord-like layout with sidebar and chat area
 */

import { Component, OnInit, OnDestroy, inject, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { Subscription } from 'rxjs';

import { SidebarComponent } from '../features/sidebar/sidebar.component';
import { ChatComponent } from '../features/chat/chat.component';
import { TaskListComponent } from '../features/tasks/task-list/task-list.component';
import { StatusBarComponent } from '../shared/components/status-bar/status-bar.component';
import { AboutDialogComponent } from '../shared/components/about-dialog/about-dialog.component';
import { SettingsDialogComponent } from '../shared/components/settings-dialog/settings-dialog.component';
import { PermissionDialogComponent } from '../shared/components/permission-dialog/permission-dialog.component';

import { ElectronService } from '../core/services/electron.service';
import { AgentService } from '../core/services/agent.service';
import { ThemeService } from '../core/services/theme.service';
import { TaskService } from '../core/services/task.service';

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [
    CommonModule,
    MatSidenavModule,
    MatToolbarModule,
    MatIconModule,
    MatButtonModule,
    MatMenuModule,
    MatTooltipModule,
    MatDividerModule,
    MatDialogModule,
    SidebarComponent,
    ChatComponent,
    TaskListComponent,
    StatusBarComponent,
    AboutDialogComponent
  ],
  templateUrl: './main-layout.component.html',
  styleUrl: './main-layout.component.scss'
})
export class MainLayoutComponent implements OnInit, OnDestroy {
  private electronService = inject(ElectronService);
  private agentService = inject(AgentService);
  private themeService = inject(ThemeService);
  private taskService = inject(TaskService);
  private dialog = inject(MatDialog);
  private permissionSub?: Subscription;
  private permissionRespondedSub?: Subscription;
  private openPermissionDialogs = new Map<string, import('@angular/material/dialog').MatDialogRef<any>>();

  @ViewChild(StatusBarComponent) statusBar!: StatusBarComponent;

  // Expose signals to template
  selectedAgent = this.agentService.selectedAgent;
  currentTheme = this.themeService.currentTheme;
  availableThemes = this.themeService.availableThemes;
  
  currentDirectory: string | null = null;
  activeView: 'chat' | 'tasks' = 'chat';
  recentDirectories: string[] = [];
  sidebarOpen = false;

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
        this.electronService.respondToPermissionRequest(request.requestId, request.agentId, optionId);
      }
    });
  }

  async openDirectory(): Promise<void> {
    const directory = await this.electronService.selectDirectory();
    if (directory) {
      this.currentDirectory = directory;
      await this.agentService.discoverAgents(directory);
      // Update status bar
      if (this.statusBar) {
        this.statusBar.updateDirectory(directory);
      }
      // Reload tasks scoped to the new project
      if (this.activeView === 'tasks') {
        this.taskService.loadTasks();
      }
    }
  }

  async openRecentDirectory(dirPath: string): Promise<void> {
    await this.electronService.setCurrentDirectory(dirPath);
    this.currentDirectory = dirPath;
    await this.agentService.discoverAgents(dirPath);
    if (this.statusBar) {
      this.statusBar.updateDirectory(dirPath);
    }
    if (this.activeView === 'tasks') {
      this.taskService.loadTasks();
    }
  }

  getDirectoryName(dirPath: string): string {
    const parts = dirPath.split(/[/\\]/);
    return parts[parts.length - 1] || dirPath;
  }

  setTheme(themeId: string): void {
    this.themeService.setTheme(themeId);
  }

  openAboutDialog(): void {
    this.dialog.open(AboutDialogComponent, {
      width: '400px',
      panelClass: 'about-dialog'
    });
  }

  openSettingsDialog(): void {
    this.dialog.open(SettingsDialogComponent, {
      width: '480px',
      panelClass: 'settings-dialog'
    });
  }

  addAgent(): void {
    // TODO: Open add agent dialog
    console.log('Add agent feature coming soon');
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
  }

  goToAgent(agentId: string): void {
    this.agentService.selectAgent(agentId);
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
