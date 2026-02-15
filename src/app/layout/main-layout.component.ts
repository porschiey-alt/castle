/**
 * Main Layout Component - Discord-like layout with sidebar and chat area
 */

import { Component, OnInit, inject, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';

import { SidebarComponent } from '../features/sidebar/sidebar.component';
import { ChatComponent } from '../features/chat/chat.component';
import { StatusBarComponent } from '../shared/components/status-bar/status-bar.component';
import { AboutDialogComponent } from '../shared/components/about-dialog/about-dialog.component';

import { ElectronService } from '../core/services/electron.service';
import { AgentService } from '../core/services/agent.service';
import { ThemeService } from '../core/services/theme.service';

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
    StatusBarComponent,
    AboutDialogComponent
  ],
  templateUrl: './main-layout.component.html',
  styleUrl: './main-layout.component.scss'
})
export class MainLayoutComponent implements OnInit {
  private electronService = inject(ElectronService);
  private agentService = inject(AgentService);
  private themeService = inject(ThemeService);
  private dialog = inject(MatDialog);

  @ViewChild(StatusBarComponent) statusBar!: StatusBarComponent;

  // Expose signals to template
  selectedAgent = this.agentService.selectedAgent;
  currentTheme = this.themeService.currentTheme;
  availableThemes = this.themeService.availableThemes;
  
  currentDirectory: string | null = null;

  async ngOnInit(): Promise<void> {
    // Load current directory
    this.currentDirectory = await this.electronService.getCurrentDirectory();
    
    // Discover agents if directory is set
    if (this.currentDirectory) {
      await this.agentService.discoverAgents(this.currentDirectory);
    }
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
    // For now, show a message that this feature is coming
    console.log('Add agent feature coming soon');
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
