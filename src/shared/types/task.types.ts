/**
 * Task Workflow Types
 */

export type TaskState = 'new' | 'in_progress' | 'active' | 'blocked' | 'done';

export const TASK_STATES: { id: TaskState; label: string; icon: string; color: string }[] = [
  { id: 'new', label: 'New', icon: 'fiber_new', color: '#3b82f6' },
  { id: 'active', label: 'Active', icon: 'radio_button_checked', color: '#8b5cf6' },
  { id: 'in_progress', label: 'In Progress', icon: 'play_circle', color: '#f59e0b' },
  { id: 'blocked', label: 'Blocked', icon: 'block', color: '#ef4444' },
  { id: 'done', label: 'Done', icon: 'check_circle', color: '#22c55e' },
];

export type TaskKind = 'feature' | 'bug' | 'chore' | 'spike';

export const TASK_KINDS: { id: TaskKind; label: string; icon: string; color: string }[] = [
  { id: 'feature', label: 'Feature', icon: 'star', color: '#3b82f6' },
  { id: 'bug', label: 'Bug', icon: 'bug_report', color: '#ef4444' },
  { id: 'chore', label: 'Chore', icon: 'build', color: '#6b7280' },
  { id: 'spike', label: 'Spike', icon: 'science', color: '#8b5cf6' },
];

export interface TaskLabel {
  id: string;
  name: string;
  color: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  state: TaskState;
  kind: TaskKind;
  labels: TaskLabel[];
  researchContent?: string;
  researchAgentId?: string;
  githubIssueNumber?: number;
  githubRepo?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateTaskInput = Pick<Task, 'title' | 'description' | 'state' | 'kind'> & {
  labelIds?: string[];
};

export type UpdateTaskInput = Partial<Pick<Task, 'title' | 'description' | 'state' | 'kind' | 'researchContent' | 'researchAgentId'>> & {
  labelIds?: string[];
};
