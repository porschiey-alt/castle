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

export type BugCloseReason = 'no_repro' | 'wont_fix' | 'fixed' | 'duplicate';

export const BUG_CLOSE_REASONS: { id: BugCloseReason; label: string; icon: string }[] = [
  { id: 'fixed', label: 'Fixed', icon: 'check_circle' },
  { id: 'no_repro', label: 'No Repro', icon: 'help_outline' },
  { id: 'wont_fix', label: "Won't Fix", icon: 'do_not_disturb' },
  { id: 'duplicate', label: 'Duplicate', icon: 'content_copy' },
];

export interface TaskLabel {
  id: string;
  name: string;
  color: string;
}

export type TaskPRState = 'draft' | 'open' | 'merged' | 'closed';

export interface Task {
  id: string;
  title: string;
  description: string;
  state: TaskState;
  kind: TaskKind;
  labels: TaskLabel[];
  projectPath?: string;
  researchContent?: string;
  researchAgentId?: string;
  implementAgentId?: string;
  githubIssueNumber?: number;
  githubRepo?: string;
  closeReason?: BugCloseReason;
  worktreePath?: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  prState?: TaskPRState;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateTaskInput = Pick<Task, 'title' | 'description' | 'state' | 'kind'> & {
  labelIds?: string[];
};

export type UpdateTaskInput = Partial<Pick<Task, 'title' | 'description' | 'state' | 'kind' | 'researchContent' | 'researchAgentId' | 'implementAgentId' | 'closeReason' | 'worktreePath' | 'branchName' | 'prUrl' | 'prNumber' | 'prState'>> & {
  labelIds?: string[];
};

/** Anchor identifying which markdown section a comment is attached to */
export interface ResearchCommentAnchor {
  blockType: string;
  blockIndex: number;
  preview: string;
}

/** A single review comment on research output */
export interface ResearchComment {
  id: string;
  anchor: ResearchCommentAnchor;
  body: string;
  createdAt: Date;
}

/** A batch of comments submitted as one review round */
export interface ResearchReview {
  id: string;
  taskId: string;
  comments: ResearchComment[];
  researchSnapshot: string;
  submittedAt: Date;
  revisedContent?: string;
  status: 'pending' | 'in_progress' | 'complete';
}
