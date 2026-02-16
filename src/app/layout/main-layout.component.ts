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

  @ViewChild(StatusBarComponent) statusBar!: StatusBarComponent;

  // Expose signals to template
  selectedAgent = this.agentService.selectedAgent;
  currentTheme = this.themeService.currentTheme;
  availableThemes = this.themeService.availableThemes;
  
  currentDirectory: string | null = null;
  activeView: 'chat' | 'tasks' = 'chat';

  async ngOnInit(): Promise<void> {
    // Listen for permission requests from Copilot
    this.permissionSub = this.electronService.permissionRequest$.subscribe((request) => {
      this.showPermissionDialog(request);
    });

    // Load current directory
    this.currentDirectory = await this.electronService.getCurrentDirectory();
    
    // Discover agents if directory is set (this auto-selects and starts session for first agent)
    if (this.currentDirectory) {
      await this.agentService.discoverAgents(this.currentDirectory);
    }
  }

  ngOnDestroy(): void {
    this.permissionSub?.unsubscribe();
  }

  private showPermissionDialog(request: any): void {
    const dialogRef = this.dialog.open(PermissionDialogComponent, {
      data: request,
      width: '480px',
      disableClose: true,
      panelClass: 'permission-dialog'
    });

    dialogRef.afterClosed().subscribe((optionId: string) => {
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
    }
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

  addAgent(): void {
    // TODO: Open add agent dialog
    console.log('Add agent feature coming soon');
  }

  showTasks(): void {
    this.activeView = 'tasks';
    // Load tasks when switching to view
    this.taskService.loadTasks();
  }

  showChat(): void {
    this.activeView = 'chat';
  }

  goToAgent(agentId: string): void {
    this.agentService.selectAgent(agentId);
    this.activeView = 'chat';
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
