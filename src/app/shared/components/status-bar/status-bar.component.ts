/**
 * Status Bar Component - Bottom status bar with model selector
 */

import { Component, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

import { ElectronService } from '../../../core/services/electron.service';
import { AgentService } from '../../../core/services/agent.service';
import { COPILOT_MODELS } from '../../../../shared/constants';

@Component({
  selector: 'app-status-bar',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatSelectModule,
    MatFormFieldModule,
    FormsModule
  ],
  templateUrl: './status-bar.component.html',
  styleUrl: './status-bar.component.scss'
})
export class StatusBarComponent implements OnInit, OnDestroy {
  private electronService = inject(ElectronService);
  private agentService = inject(AgentService);
  private subscription?: Subscription;

  currentDirectory = signal<string | null>(null);
  selectedModel = signal<string>('');
  
  selectedAgent = this.agentService.selectedAgent;
  
  readonly models = COPILOT_MODELS;

  async ngOnInit(): Promise<void> {
    await this.loadDirectory();
    await this.loadActiveModel();

    // Refresh model after first response arrives (session may have just started)
    this.subscription = this.electronService.streamComplete$.subscribe(() => {
      this.loadActiveModel();
    });
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
  }

  private async loadDirectory(): Promise<void> {
    const dir = await this.electronService.getCurrentDirectory();
    this.currentDirectory.set(dir);
  }

  async loadActiveModel(): Promise<void> {
    const model = await this.electronService.getActiveModel();
    if (model) {
      this.selectedModel.set(model);
    }
  }

  // Called from main layout when directory changes
  updateDirectory(dir: string | null): void {
    this.currentDirectory.set(dir);
  }

  get connectionStatus(): string {
    return this.electronService.isElectron ? 'Connected' : 'Browser Mode';
  }

  get directoryName(): string {
    const dir = this.currentDirectory();
    if (!dir) return 'No project';
    const parts = dir.split(/[/\\]/);
    return parts[parts.length - 1] || dir;
  }

  onModelChange(modelId: string): void {
    this.selectedModel.set(modelId);
    // TODO: Save model preference to settings
  }
}
