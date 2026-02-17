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
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

import { TaskService } from '../../../core/services/task.service';
import { AgentService } from '../../../core/services/agent.service';
import { ElectronService } from '../../../core/services/electron.service';
import { ConfirmDialogComponent, type ConfirmDialogData } from '../../../shared/components/confirm-dialog/confirm-dialog.component';
import { TaskDetailComponent, type TaskSaveEvent, type TaskResearchEvent, type TaskImplementEvent, type TaskReviewSubmitEvent } from '../task-detail/task-detail.component';
import { TASK_STATES, TASK_KINDS, type Task, type TaskState, type TaskKind, type BugCloseReason } from '../../../../shared/types/task.types';

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
  taskService = inject(TaskService);
  private agentService = inject(AgentService);
  private electronService = inject(ElectronService);
  private dialog = inject(MatDialog);

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

  /** Emitted when user clicks "Take me to the Researcher/Agent" */
  goToAgent = output<string>();
  goToAgentNewConvo = output<{ agentId: string; title: string }>();

  private diagnosisCleanupUnsub?: () => void;

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.taskService.loadTasks(),
      this.taskService.loadLabels(),
    ]);

    // Listen for diagnosis file cleanup prompts
    this.diagnosisCleanupUnsub = this.electronService.onDiagnosisFileCleanup(async (data) => {
      const confirmed = await this.openConfirmDialog({
        title: 'Delete Diagnosis File',
        message: `This bug has a diagnosis file:\n${data.filePath}\n\nWould you like to delete it?`,
        confirmText: 'Delete',
      });
      if (confirmed) {
        await this.electronService.deleteDiagnosisFile(data.filePath);
      }
    });
  }

  ngOnDestroy(): void {
    this.diagnosisCleanupUnsub?.();
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

  async onStateChange(event: { task: Task; state: TaskState; closeReason?: BugCloseReason }): Promise<void> {
    const updates: { state: TaskState; closeReason?: BugCloseReason } = { state: event.state };
    if (event.closeReason) {
      updates.closeReason = event.closeReason;
    }
    await this.taskService.updateTask(event.task.id, updates);
  }

  async deleteTask(task: Task): Promise<void> {
    const confirmed = await this.openConfirmDialog({
      title: 'Delete Task',
      message: `Delete task "${task.title}"?`,
      confirmText: 'Delete',
    });
    if (confirmed) {
      await this.taskService.deleteTask(task.id);
    }
  }

  async onResearchRequested(event: TaskResearchEvent): Promise<void> {
    this.taskService.markResearchRunning(event.task.id);
    // Navigate to agent chat with a fresh "Research: <name>" conversation
    this.goToAgentNewConvo.emit({ agentId: event.agentId, title: `Research: ${event.task.title}` });
    await this.taskService.runResearch(event.task.id, event.agentId, event.outputPath);
  }

  async onImplementRequested(event: TaskImplementEvent): Promise<void> {
    this.taskService.markImplementRunning(event.task.id);
    // Transition task to "in_progress" when implementation starts
    if (event.task.state !== 'in_progress' && event.task.state !== 'done') {
      await this.taskService.updateTask(event.task.id, { state: 'in_progress' });
    }
    // Navigate to agent chat with a fresh "CODE: <name>" conversation
    this.goToAgentNewConvo.emit({ agentId: event.agentId, title: `CODE: ${event.task.title}` });
    // Run implementation via IPC (main process handles completion)
    await this.taskService.runImplementation(event.task.id, event.agentId);
  }

  async onReviewSubmitted(event: TaskReviewSubmitEvent): Promise<void> {
    this.taskService.markReviewRunning(event.taskId);
    await this.taskService.submitResearchReview(event.taskId, event.comments, event.researchSnapshot);
  }

  private openConfirmDialog(data: ConfirmDialogData): Promise<boolean> {
    const dialogRef = this.dialog.open(ConfirmDialogComponent, { data });
    return firstValueFrom(dialogRef.afterClosed()).then(result => !!result);
  }
}
