/**
 * Task Detail Component - View/edit/create a single task with markdown rendering
 * Supports Description and Research tabs
 */

import { Component, input, output, inject, effect, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { marked } from 'marked';

import { TASK_STATES, TASK_KINDS, BUG_CLOSE_REASONS, type Task, type TaskLabel, type TaskState, type TaskKind, type BugCloseReason, type ResearchComment, type ResearchCommentAnchor } from '../../../../shared/types/task.types';
import type { Agent } from '../../../../shared/types/agent.types';
import { ResearchContentComponent } from '../research-content/research-content.component';

marked.setOptions({ breaks: true, gfm: true });

export interface TaskSaveEvent {
  title: string;
  description: string;
  state: TaskState;
  kind: TaskKind;
  labelIds: string[];
}

export interface TaskResearchEvent {
  task: Task;
  agentId: string;
  outputPath?: string;
}

export interface TaskImplementEvent {
  task: Task;
  agentId: string;
}

export interface TaskReviewSubmitEvent {
  taskId: string;
  comments: ResearchComment[];
  researchSnapshot: string;
}

@Component({
  selector: 'app-task-detail',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatChipsModule,
    MatMenuModule,
    MatTooltipModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTabsModule,
    ResearchContentComponent,
  ],
  templateUrl: './task-detail.component.html',
  styleUrl: './task-detail.component.scss'
})
export class TaskDetailComponent implements OnInit {
  /** Existing task (undefined = creating new) */
  task = input<Task | undefined>(undefined);
  /** Available labels for selection */
  labels = input<TaskLabel[]>([]);
  /** All available agents for research picker */
  agents = input<Agent[]>([]);
  /** Start in editing mode */
  startEditing = input(false);
  /** Whether research is currently running */
  researchRunning = input(false);
  /** Whether implementation is currently running */
  implementRunning = input(false);
  /** Whether a review revision is currently running */
  reviewRunning = input(false);

  saved = output<TaskSaveEvent>();
  deleteRequested = output<Task>();
  stateChanged = output<{ task: Task; state: TaskState; closeReason?: BugCloseReason }>();
  researchRequested = output<TaskResearchEvent>();
  implementRequested = output<TaskImplementEvent>();
  reviewSubmitted = output<TaskReviewSubmitEvent>();
  goToResearcher = output<string>();
  goToImplementer = output<string>();
  closed = output<void>();

  states = TASK_STATES;
  kinds = TASK_KINDS;
  closeReasons = BUG_CLOSE_REASONS;
  editing = false;
  activeTab = 0;

  // Form fields
  editTitle = '';
  editDescription = '';
  editState: TaskState = 'new';
  editKind: TaskKind = 'feature';
  editLabelIds: string[] = [];

  // Research agent picker
  selectedResearchAgentId = '';
  // Implementation agent picker
  selectedImplementAgentId = '';
  // Research review comments
  pendingComments: ResearchComment[] = [];
  reviewSubmitting = false;

  /** Clear review state when reviewRunning transitions from true to false */
  private reviewRunningEffect = effect(() => {
    const running = this.reviewRunning();
    if (!running && this.reviewSubmitting) {
      this.onReviewComplete();
    }
  });

  get isCreating(): boolean {
    return !this.task();
  }

  get researchAgents(): Agent[] {
    return this.agents().filter(a =>
      a.name.toLowerCase().includes('research') ||
      a.description?.toLowerCase().includes('research')
    );
  }

  get debugAgents(): Agent[] {
    return this.agents().filter(a =>
      a.name.toLowerCase().includes('debug') ||
      a.description?.toLowerCase().includes('debug') ||
      a.description?.toLowerCase().includes('diagnos')
    );
  }

  get codingAgents(): Agent[] {
    return this.agents().filter(a =>
      !a.name.toLowerCase().includes('research') &&
      !a.description?.toLowerCase().includes('research') &&
      !a.name.toLowerCase().includes('debug') &&
      !a.description?.toLowerCase().includes('debug') &&
      !a.description?.toLowerCase().includes('diagnos')
    );
  }

  get defaultResearchAgentId(): string {
    const t = this.task();

    // For bugs, prefer the debug agent
    if (t?.kind === 'bug') {
      const debug = this.debugAgents;
      if (debug.length > 0) return debug[0].id;
    }

    // For non-bugs, prefer research agents (existing behavior)
    const research = this.researchAgents;
    if (research.length > 0) return research[0].id;
    const all = this.agents();
    return all.length > 0 ? all[0].id : '';
  }

  get defaultCodingAgentId(): string {
    const coding = this.codingAgents;
    if (coding.length > 0) return coding[0].id;
    const all = this.agents();
    return all.length > 0 ? all[0].id : '';
  }

  ngOnInit(): void {
    if (this.startEditing() || this.isCreating) {
      this.enterEditMode();
    }
    this.selectedResearchAgentId = this.defaultResearchAgentId;
    this.selectedImplementAgentId = this.defaultCodingAgentId;
  }

  getStateInfo(state: TaskState) {
    return TASK_STATES.find(s => s.id === state) ?? TASK_STATES[0];
  }

  getKindInfo(kind: TaskKind) {
    return TASK_KINDS.find(k => k.id === kind) ?? TASK_KINDS[0];
  }

  renderMarkdown(text: string): string {
    if (!text) return '';
    return marked.parse(text, { async: false }) as string;
  }

  enterEditMode(): void {
    const t = this.task();
    this.editTitle = t?.title ?? '';
    this.editDescription = t?.description ?? '';
    this.editState = t?.state ?? 'new';
    this.editKind = t?.kind ?? 'feature';
    this.editLabelIds = t?.labels?.map(l => l.id) ?? [];
    this.editing = true;
  }

  cancelEdit(): void {
    if (this.isCreating) {
      this.closed.emit();
    } else {
      this.editing = false;
    }
  }

  save(): void {
    if (!this.editTitle.trim()) return;
    this.saved.emit({
      title: this.editTitle.trim(),
      description: this.editDescription,
      state: this.editState,
      kind: this.editKind,
      labelIds: this.editLabelIds,
    });
    this.editing = false;
  }

  onStateChange(state: TaskState): void {
    const t = this.task();
    if (t) {
      this.stateChanged.emit({ task: t, state });
    }
  }

  onCloseBugWithReason(reason: BugCloseReason): void {
    const t = this.task();
    if (t) {
      this.stateChanged.emit({ task: t, state: 'done', closeReason: reason });
    }
  }

  getCloseReasonInfo(reason: BugCloseReason) {
    return BUG_CLOSE_REASONS.find(r => r.id === reason);
  }

  startResearch(): void {
    const t = this.task();
    if (!t || !this.selectedResearchAgentId) return;
    this.researchRequested.emit({
      task: t,
      agentId: this.selectedResearchAgentId,
    });
  }

  startImplementation(): void {
    const t = this.task();
    if (!t || !this.selectedImplementAgentId) return;
    this.implementRequested.emit({
      task: t,
      agentId: this.selectedImplementAgentId,
    });
  }

  getAgentById(id: string): Agent | undefined {
    return this.agents().find(a => a.id === id);
  }

  addComment(event: { anchor: ResearchCommentAnchor; body: string }): void {
    this.pendingComments = [...this.pendingComments, {
      id: crypto.randomUUID(),
      anchor: event.anchor,
      body: event.body,
      createdAt: new Date(),
    }];
  }

  removeComment(commentId: string): void {
    this.pendingComments = this.pendingComments.filter(c => c.id !== commentId);
  }

  submitReview(): void {
    const t = this.task();
    if (!t || this.pendingComments.length === 0) return;
    this.reviewSubmitting = true;
    this.reviewSubmitted.emit({
      taskId: t.id,
      comments: [...this.pendingComments],
      researchSnapshot: t.researchContent || '',
    });
  }

  onReviewComplete(): void {
    this.pendingComments = [];
    this.reviewSubmitting = false;
  }
}
