/**
 * Task List Component - Main task management view
 */

import { Component, inject, output, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { Subscription } from 'rxjs';

import { TaskService } from '../../../core/services/task.service';
import { AgentService } from '../../../core/services/agent.service';
import { ElectronService } from '../../../core/services/electron.service';
import { TaskDetailComponent, type TaskSaveEvent, type TaskResearchEvent, type TaskImplementEvent } from '../task-detail/task-detail.component';
import { TASK_STATES, TASK_KINDS, type Task, type TaskState, type TaskKind } from '../../../../shared/types/task.types';

@Component({
  selector: 'app-task-list',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatChipsModule,
    MatTooltipModule,
    MatMenuModule,
    TaskDetailComponent,
  ],
  templateUrl: './task-list.component.html',
  styleUrl: './task-list.component.scss'
})
export class TaskListComponent implements OnInit, OnDestroy {
  private taskService = inject(TaskService);
  private agentService = inject(AgentService);
  private electronService = inject(ElectronService);
  private completeSub?: Subscription;

  states = TASK_STATES;
  kinds = TASK_KINDS;
  tasks = this.taskService.filteredTasks;
  labels = this.taskService.labels;
  agents = this.agentService.agents;
  selectedTask = this.taskService.selectedTask;
  loading = this.taskService.loading;
  filterState = this.taskService.filterState;
  filterKind = this.taskService.filterKind;

  creating = false;
  researchRunningTaskIds = new Set<string>();
  implementRunningTaskIds = new Set<string>();

  /** Emitted when user clicks "Take me to the Researcher/Agent" */
  goToAgent = output<string>();

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.taskService.loadTasks(),
      this.taskService.loadLabels(),
    ]);

    // Listen for stream completions to detect research finishing
    this.completeSub = this.electronService.streamComplete$.subscribe(async (msg) => {
      // Check if this is a research completion for a task we're tracking
      if (this.researchRunningTaskIds.has(msg.id)) {
        this.researchRunningTaskIds.delete(msg.id);
        await this.taskService.refreshTask(msg.id);
      }
    });
  }

  ngOnDestroy(): void {
    this.completeSub?.unsubscribe();
  }

  getStateInfo(state: TaskState) {
    return TASK_STATES.find(s => s.id === state) ?? TASK_STATES[0];
  }

  getKindInfo(kind: TaskKind) {
    return TASK_KINDS.find(k => k.id === kind) ?? TASK_KINDS[0];
  }

  setFilter(state: TaskState | null): void {
    this.taskService.setFilter(state);
  }

  setKindFilter(kind: TaskKind | null): void {
    this.taskService.setKindFilter(kind);
  }

  selectTask(task: Task): void {
    this.taskService.selectTask(task.id);
  }

  deselectTask(): void {
    this.creating = false;
    this.taskService.selectTask(null);
  }

  startCreating(): void {
    this.taskService.selectTask(null);
    this.creating = true;
  }

  async onSave(taskId: string | null, event: TaskSaveEvent): Promise<void> {
    if (taskId) {
      await this.taskService.updateTask(taskId, {
        title: event.title,
        description: event.description,
        state: event.state,
        kind: event.kind,
        labelIds: event.labelIds,
      });
    } else {
      const created = await this.taskService.createTask({
        title: event.title,
        description: event.description,
        state: event.state,
        kind: event.kind,
        labelIds: event.labelIds,
      });
      this.creating = false;
      if (created) {
        this.taskService.selectTask(created.id);
      }
    }
  }

  async onStateChange(event: { task: Task; state: TaskState }): Promise<void> {
    await this.taskService.updateTask(event.task.id, { state: event.state });
  }

  async deleteTask(task: Task): Promise<void> {
    if (confirm(`Delete task "${task.title}"?`)) {
      await this.taskService.deleteTask(task.id);
    }
  }

  async onResearchRequested(event: TaskResearchEvent): Promise<void> {
    this.researchRunningTaskIds.add(event.task.id);
    await this.taskService.runResearch(event.task.id, event.agentId, event.outputPath);
  }

  async onImplementRequested(event: TaskImplementEvent): Promise<void> {
    this.implementRunningTaskIds.add(event.task.id);
    // Switch to that agent's chat with the task context
    this.goToAgent.emit(event.agentId);

    // Build implementation prompt with research context if available
    const task = event.task;
    let prompt = `Implement the following task:\n\nTitle: ${task.title}\n\nDescription:\n${task.description || '(none)'}`;
    if (task.researchContent) {
      prompt += `\n\nResearch Analysis:\n${task.researchContent}`;
    }
    prompt += `\n\nPlease implement the changes described above.`;

    // Send message to the agent
    await this.electronService.sendMessage(event.agentId, prompt);
    this.implementRunningTaskIds.delete(event.task.id);
  }

  isResearchRunning(taskId: string): boolean {
    return this.researchRunningTaskIds.has(taskId);
  }

  isImplementRunning(taskId: string): boolean {
    return this.implementRunningTaskIds.has(taskId);
  }
}
