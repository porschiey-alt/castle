/**
 * Task List Component - Main task management view
 */

import { Component, inject, output, OnInit, OnDestroy, ViewChild } from '@angular/core';
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
import { ConversationService } from '../../../core/services/conversation.service';
import { ConfirmDialogComponent, type ConfirmDialogData } from '../../../shared/components/confirm-dialog/confirm-dialog.component';
import { TaskDetailComponent, type TaskSaveEvent, type TaskResearchEvent, type TaskImplementEvent, type TaskCreatePREvent, type TaskReviewSubmitEvent } from '../task-detail/task-detail.component';
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
  private conversationService = inject(ConversationService);
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

  @ViewChild(TaskDetailComponent) taskDetailComponent?: TaskDetailComponent;

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

    // Listen for worktree lifecycle events
    this.electronService.onWorktreeLifecycle((event) => {
      this.taskDetailComponent?.onLifecycleUpdate(event);
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
    const convId = await this.createAndNavigateToConversation(event.agentId, event.task.title, event.task.id);
    await this.taskService.runResearch(event.task.id, event.agentId, event.outputPath, convId);
  }

  async onImplementRequested(event: TaskImplementEvent): Promise<void> {
    this.taskService.markImplementRunning(event.task.id);
    // Transition task to "in_progress" when implementation starts
    if (event.task.state !== 'in_progress' && event.task.state !== 'done') {
      await this.taskService.updateTask(event.task.id, { state: 'in_progress' });
    }
    const convId = await this.createAndNavigateToConversation(event.agentId, event.task.title, event.task.id);
    // Run implementation via IPC (main process handles completion)
    await this.taskService.runImplementation(event.task.id, event.agentId, convId);
  }

  async onReviewSubmitted(event: TaskReviewSubmitEvent): Promise<void> {
    this.taskService.markReviewRunning(event.taskId);
    await this.taskService.submitResearchReview(event.taskId, event.comments, event.researchSnapshot);
  }

  async onCreatePR(event: TaskCreatePREvent): Promise<void> {
    const task = event.task;
    if (!task.worktreePath) return;
    const body = task.description
      ? `## ${task.title}\n\n${task.description}`
      : task.title;
    const settings = await this.electronService.getSettings();
    const draft = settings?.worktreeDraftPR || false;
    const result = await this.electronService.createPullRequest(task.worktreePath, task.title, body, draft);
    this.taskDetailComponent?.onPRResult(result);
    // Reload task to get updated PR metadata
    if (result.success) {
      await this.taskService.loadTasks();
    }
  }

  async onDiffLoadRequested(worktreePath: string): Promise<void> {
    const result = await this.electronService.getWorktreeDiff(worktreePath);
    this.taskDetailComponent?.onDiffLoaded(result);
  }

  private openConfirmDialog(data: ConfirmDialogData): Promise<boolean> {
    const dialogRef = this.dialog.open(ConfirmDialogComponent, { data });
    return firstValueFrom(dialogRef.afterClosed()).then(result => !!result);
  }

  /** Create a conversation, navigate to the agent chat, and return the conversation ID */
  private async createAndNavigateToConversation(agentId: string, title: string, taskId?: string): Promise<string | undefined> {
    await this.conversationService.loadConversations(agentId);
    const conv = await this.conversationService.createConversation(agentId, title, taskId);
    this.goToAgent.emit(agentId);
    return conv?.id ?? undefined;
  }
}
