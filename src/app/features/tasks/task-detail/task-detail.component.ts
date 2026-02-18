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

import { TASK_STATES, TASK_KINDS, BUG_CLOSE_REASONS, type Task, type TaskLabel, type TaskState, type TaskKind, type BugCloseReason, type ResearchComment, type ResearchCommentAnchor, type TaskPRState } from '../../../../shared/types/task.types';
import type { Agent } from '../../../../shared/types/agent.types';
import { ResearchContentComponent } from '../research-content/research-content.component';
import { AgentIconComponent } from '../../../shared/components/agent-icon/agent-icon.component';

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

export interface TaskCreatePREvent {
  task: Task;
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
    AgentIconComponent,
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
  createPRRequested = output<TaskCreatePREvent>();
  diffLoadRequested = output<string>();
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
  // PR creation state
  prCreating = false;
  prUrl: string | null = null;
  prError: string | null = null;
  // Worktree lifecycle phase
  lifecyclePhase: string | null = null;
  lifecycleWarning: string | null = null;
  // Diff preview
  diffSummary: string | null = null;
  diffContent: string | null = null;
  showDiffPreview = false;
  loadingDiff = false;

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

  createPR(): void {
    const t = this.task();
    if (!t || !t.worktreePath) return;
    this.prCreating = true;
    this.prUrl = null;
    this.prError = null;
    this.createPRRequested.emit({ task: t });
  }

  /** Called by parent when PR creation completes */
  onPRResult(result: { success: boolean; url?: string; prNumber?: number; error?: string }): void {
    this.prCreating = false;
    if (result.success && result.url) {
      this.prUrl = result.url;
    } else {
      this.prError = result.error || 'Failed to create pull request';
    }
  }

  /** Called by parent when worktree lifecycle phase changes */
  onLifecycleUpdate(event: { taskId: string; agentId?: string; taskTitle?: string; phase: string; message?: string }): void {
    const t = this.task();
    if (!t || t.id !== event.taskId) return;

    if (event.phase === 'warning') {
      this.lifecycleWarning = event.message || null;
    } else {
      this.lifecyclePhase = event.phase;
      // Clear warning when phase advances
      if (event.phase === 'done') {
        this.lifecyclePhase = null;
      }
    }
  }

  /** Load diff preview for the worktree */
  async loadDiffPreview(): Promise<void> {
    const t = this.task();
    if (!t?.worktreePath) return;
    this.loadingDiff = true;
    this.showDiffPreview = true;
    this.diffLoadRequested.emit(t.worktreePath);
  }

  /** Called by parent with diff results */
  onDiffLoaded(result: { summary: string; diff: string }): void {
    this.diffSummary = result.summary;
    this.diffContent = result.diff;
    this.loadingDiff = false;
  }

  /** Format lifecycle phase for display */
  get lifecycleLabel(): string {
    switch (this.lifecyclePhase) {
      case 'creating_worktree': return 'Creating worktree...';
      case 'installing_deps': return 'Installing dependencies...';
      case 'implementing': return 'Implementation in progress...';
      case 'evaluating': return 'Evaluating implementation...';
      case 'committing': return 'Committing changes...';
      case 'creating_pr': return 'Creating pull request...';
      default: return '';
    }
  }

  private readonly phaseOrder = [
    'creating_worktree', 'installing_deps', 'implementing',
    'evaluating', 'committing', 'creating_pr'
  ];

  isPhaseAfter(phase: string): boolean {
    if (!this.lifecyclePhase) return false;
    return this.phaseOrder.indexOf(this.lifecyclePhase) > this.phaseOrder.indexOf(phase);
  }

  phaseIcon(phase: string): string {
    if (this.lifecyclePhase === phase) return 'sync';
    if (this.isPhaseAfter(phase)) return 'check_circle';
    return 'radio_button_unchecked';
  }

  markDone(): void {
    const t = this.task();
    if (!t) return;
    const updates: { task: Task; state: TaskState; closeReason?: BugCloseReason } = { task: t, state: 'done' };
    if (t.kind === 'bug') updates.closeReason = 'fixed';
    this.stateChanged.emit(updates);
  }

  /** Get PR state display info */
  getPRStateInfo(state: TaskPRState): { label: string; icon: string; color: string } {
    switch (state) {
      case 'draft': return { label: 'Draft', icon: 'edit_note', color: '#6b7280' };
      case 'open': return { label: 'Open', icon: 'merge', color: '#22c55e' };
      case 'merged': return { label: 'Merged', icon: 'merge', color: '#8b5cf6' };
      case 'closed': return { label: 'Closed', icon: 'close', color: '#ef4444' };
    }
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

  requestRevision(): void {
    const t = this.task();
    if (!t) return;
    // Transition state back to in_progress
    this.stateChanged.emit({ task: t, state: 'in_progress' });
    // Navigate to the implementing agent's chat
    this.goToImplementer.emit(t.implementAgentId!);
  }
}
