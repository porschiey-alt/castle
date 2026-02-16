/**
 * Task Service - Signals-based state management for tasks
 */

import { Injectable, inject, signal, computed } from '@angular/core';
import { ElectronService } from './electron.service';
import type { Task, TaskLabel, TaskState, TaskKind, CreateTaskInput, UpdateTaskInput, ResearchComment } from '../../../shared/types/task.types';

@Injectable({
  providedIn: 'root'
})
export class TaskService {
  private electronService = inject(ElectronService);

  // State
  private tasksSignal = signal<Task[]>([]);
  private labelsSignal = signal<TaskLabel[]>([]);
  private selectedTaskIdSignal = signal<string | null>(null);
  private loadingSignal = signal(false);
  private filterStateSignal = signal<TaskState | null>(null);
  private filterKindSignal = signal<TaskKind | null>(null);

  // Running state tracking (survives navigation)
  private researchRunningIds = signal(new Set<string>());
  private implementRunningIds = signal(new Set<string>());
  private reviewRunningIds = signal(new Set<string>());

  // Public signals
  readonly tasks = this.tasksSignal.asReadonly();
  readonly labels = this.labelsSignal.asReadonly();
  readonly selectedTaskId = this.selectedTaskIdSignal.asReadonly();
  readonly loading = this.loadingSignal.asReadonly();
  readonly filterState = this.filterStateSignal.asReadonly();
  readonly filterKind = this.filterKindSignal.asReadonly();

  readonly selectedTask = computed(() => {
    const id = this.selectedTaskIdSignal();
    if (!id) return null;
    return this.tasksSignal().find(t => t.id === id) ?? null;
  });

  readonly unfinishedCount = computed(() =>
    this.tasksSignal().filter(t => t.state !== 'done').length
  );

  readonly filteredTasks = computed(() => {
    const state = this.filterStateSignal();
    const kind = this.filterKindSignal();
    let all = this.tasksSignal();
    if (state) {
      all = all.filter(t => t.state === state);
    } else {
      // Hide finished tasks by default unless "Done" filter is active
      all = all.filter(t => t.state !== 'done');
    }
    if (kind) all = all.filter(t => t.kind === kind);
    return all;
  });

  constructor() {
    // Listen for stream completions globally (survives component destruction)
    this.electronService.streamComplete$.subscribe(async (msg) => {
      if (this.researchRunningIds().has(msg.id)) {
        this.researchRunningIds.update(s => { const n = new Set(s); n.delete(msg.id); return n; });
        await this.refreshTask(msg.id);
      }
      if (this.reviewRunningIds().has(msg.id)) {
        this.reviewRunningIds.update(s => { const n = new Set(s); n.delete(msg.id); return n; });
        await this.refreshTask(msg.id);
      }
    });

    // Cross-device sync: another device created/updated/deleted a task
    this.electronService.tasksChanged$.subscribe((data) => {
      if (data.action === 'created' && data.task) {
        this.tasksSignal.update(tasks => {
          if (tasks.some(t => t.id === data.task!.id)) return tasks;
          return [data.task!, ...tasks];
        });
      } else if (data.action === 'updated' && data.task) {
        this.tasksSignal.update(tasks =>
          tasks.map(t => t.id === data.task!.id ? data.task! : t)
        );
      } else if (data.action === 'deleted' && data.taskId) {
        this.tasksSignal.update(tasks => tasks.filter(t => t.id !== data.taskId));
        if (this.selectedTaskIdSignal() === data.taskId) {
          this.selectedTaskIdSignal.set(null);
        }
      }
    });
  }

  isResearchRunning(taskId: string): boolean {
    return this.researchRunningIds().has(taskId);
  }

  isImplementRunning(taskId: string): boolean {
    return this.implementRunningIds().has(taskId);
  }

  isReviewRunning(taskId: string): boolean {
    return this.reviewRunningIds().has(taskId);
  }

  markResearchRunning(taskId: string): void {
    this.researchRunningIds.update(s => { const n = new Set(s); n.add(taskId); return n; });
  }

  markImplementRunning(taskId: string): void {
    this.implementRunningIds.update(s => { const n = new Set(s); n.add(taskId); return n; });
  }

  clearImplementRunning(taskId: string): void {
    this.implementRunningIds.update(s => { const n = new Set(s); n.delete(taskId); return n; });
  }

  markReviewRunning(taskId: string): void {
    this.reviewRunningIds.update(s => { const n = new Set(s); n.add(taskId); return n; });
  }

  async loadTasks(): Promise<void> {
    this.loadingSignal.set(true);
    try {
      const tasks = await this.electronService.getTasks();
      this.tasksSignal.set(tasks);
    } finally {
      this.loadingSignal.set(false);
    }
  }

  async loadLabels(): Promise<void> {
    const labels = await this.electronService.getTaskLabels();
    this.labelsSignal.set(labels);
  }

  selectTask(taskId: string | null): void {
    this.selectedTaskIdSignal.set(taskId);
  }

  setFilter(state: TaskState | null): void {
    this.filterStateSignal.set(state);
  }

  setKindFilter(kind: TaskKind | null): void {
    this.filterKindSignal.set(kind);
  }

  async createTask(input: CreateTaskInput): Promise<Task | null> {
    const task = await this.electronService.createTask(input);
    if (task) {
      // Dedup — the SYNC_TASKS_CHANGED broadcast may have already added it
      this.tasksSignal.update(tasks => {
        if (tasks.some(t => t.id === task.id)) return tasks;
        return [task, ...tasks];
      });
    }
    return task;
  }

  async updateTask(taskId: string, updates: UpdateTaskInput): Promise<Task | null> {
    const task = await this.electronService.updateTask(taskId, updates);
    if (task) {
      this.tasksSignal.update(tasks =>
        tasks.map(t => t.id === taskId ? task : t)
      );
    }
    return task;
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.electronService.deleteTask(taskId);
    this.tasksSignal.update(tasks => tasks.filter(t => t.id !== taskId));
    if (this.selectedTaskIdSignal() === taskId) {
      this.selectedTaskIdSignal.set(null);
    }
  }

  async createLabel(name: string, color: string): Promise<TaskLabel | null> {
    const label = await this.electronService.createTaskLabel(name, color);
    if (label) {
      this.labelsSignal.update(labels => [...labels, label]);
    }
    return label;
  }

  async deleteLabel(labelId: string): Promise<void> {
    await this.electronService.deleteTaskLabel(labelId);
    this.labelsSignal.update(labels => labels.filter(l => l.id !== labelId));
  }

  async runResearch(taskId: string, agentId: string, outputPath?: string): Promise<void> {
    await this.electronService.runTaskResearch(taskId, agentId, outputPath);
    // Mark the task as having a research agent
    this.tasksSignal.update(tasks =>
      tasks.map(t => t.id === taskId ? { ...t, researchAgentId: agentId } : t)
    );
  }

  /** Reload a single task from the database (e.g. after research completes) */
  async refreshTask(taskId: string): Promise<void> {
    const task = await this.electronService.getTask(taskId);
    if (task) {
      this.tasksSignal.update(tasks =>
        tasks.map(t => t.id === taskId ? task : t)
      );
    }
  }

  async submitResearchReview(taskId: string, comments: ResearchComment[], researchSnapshot: string): Promise<void> {
    await this.electronService.submitResearchReview(taskId, comments, researchSnapshot);
  }
}
