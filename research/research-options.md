# Research: Review Comment System for the Research View

## Summary

This document analyzes how to add a **code-review-style comment system** to the Research tab in Castle's task-detail view. The user should be able to read research output, leave inline comments/suggestions on specific sections, and then submit all comments in a batch. The researcher agent consumes that feedback and produces an updated research document addressing each comment.

---

## Current Behavior

### Research Tab Flow

1. User opens a task, selects the **Research** tab (`task-detail.component.html`, line 155–228).
2. If research exists, it is rendered as HTML via `marked.parse()` and displayed inside a `div.markdown-content` with `[innerHTML]`.
3. The research content is stored in two places:
   - `task.researchContent` (SQLite column `research_content` in the `tasks` table).
   - A `.md` file in the project's `/research` folder (for non-bug tasks).
4. Research is initiated via the `TASKS_RUN_RESEARCH` IPC channel (`src/main/ipc/index.ts`, line 284). The main process sends a prompt to the agent, and on completion saves the output and notifies the renderer via `CHAT_STREAM_COMPLETE`.

### What's Missing

- The rendered research is **read-only**. There is no mechanism for the user to annotate, comment on, or suggest changes to specific parts of the output.
- There is no concept of a "review round" where the user can batch comments and send them back to the agent for revision.
- The agent has no protocol for receiving structured feedback on its prior output.

---

## Proposed Approach

### Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│  Research Tab (task-detail.component)                     │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Rendered Research Markdown                         │  │
│  │                                                    │  │
│  │  ## Section Title                                  │  │
│  │  Some analysis content...          [💬 Comment]    │  │
│  │                                                    │  │
│  │  ```typescript                                     │  │
│  │  const x = doSomething();          [💬 Comment]    │  │
│  │  ```                                               │  │
│  │                                                    │  │
│  │  More analysis...                  [💬 Comment]    │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─ Comment Panel (collapsible) ─────────────────────┐  │
│  │  💬 Section "## Approach" (line 12):               │  │
│  │     "Consider also evaluating option C..."    [✕]  │  │
│  │  💬 Code block (line 24):                          │  │
│  │     "This should use async/await"             [✕]  │  │
│  │                                                    │  │
│  │  [Submit All Comments]     [Discard All]           │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Section-level granularity** — Comments are attached to markdown sections (headings, paragraphs, code blocks), not arbitrary character ranges. This keeps the UX simple and avoids complex text-selection logic.
2. **Batch submission** — Comments accumulate locally and are submitted together, matching the "code review" mental model. This avoids multiple back-and-forth agent calls.
3. **Agent round-trip** — When submitted, comments are formatted into a structured prompt and sent to the same research agent, which produces a revised document. The revision replaces the prior research content.
4. **Revision history** — Previous research versions are preserved so the user can see what changed.

---

## Technical Analysis

### 1. New Types

**File: `src/shared/types/task.types.ts`**

```typescript
/** A single review comment on research output */
export interface ResearchComment {
  id: string;
  /** The markdown section this comment is attached to (heading text or block index) */
  anchor: ResearchCommentAnchor;
  /** The user's comment text */
  body: string;
  /** When the comment was created */
  createdAt: Date;
}

export interface ResearchCommentAnchor {
  /** Type of markdown block: 'heading', 'paragraph', 'code', 'list', 'blockquote' */
  blockType: string;
  /** Zero-based index of the block in the parsed markdown AST */
  blockIndex: number;
  /** For headings: the heading text. For others: first ~80 chars as a preview */
  preview: string;
}

/** A batch of comments submitted as one review round */
export interface ResearchReview {
  id: string;
  taskId: string;
  comments: ResearchComment[];
  /** The research content version this review was made against */
  researchSnapshot: string;
  submittedAt: Date;
  /** The revised research content produced by the agent (null until complete) */
  revisedContent?: string;
  status: 'pending' | 'in_progress' | 'complete';
}
```

**Update `Task` interface:**

```typescript
export interface Task {
  // ... existing fields ...
  researchReviews?: ResearchReview[];  // history of review rounds
}
```

### 2. Database Schema Changes

**File: `src/main/services/database.service.ts`** — Add a new `research_reviews` table:

```sql
CREATE TABLE IF NOT EXISTS research_reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  comments TEXT NOT NULL,           -- JSON array of ResearchComment[]
  research_snapshot TEXT NOT NULL,   -- the research content at time of review
  revised_content TEXT,              -- agent's revision (null until complete)
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_research_reviews_task_id ON research_reviews(task_id);
```

This is added as a migration in `ensureTables()`, consistent with the existing pattern for `research_content` and `kind` column migrations (database.service.ts lines 162–175).

### 3. Markdown Section Parsing (Renderer Side)

To allow section-level commenting, we need to parse the research markdown into discrete blocks. The `marked` library (already used in `task-detail.component.ts`) exposes a `Lexer` that tokenizes markdown into a flat list of tokens.

**New utility: `src/app/shared/utils/markdown-sections.ts`**

```typescript
import { marked } from 'marked';

export interface MarkdownSection {
  index: number;
  type: string;        // 'heading' | 'paragraph' | 'code' | 'list' | 'blockquote' | ...
  raw: string;         // original markdown text of the block
  preview: string;     // short human-readable label
  html: string;        // rendered HTML for this block
  depth?: number;      // heading level (1-6) if applicable
}

/**
 * Parse markdown into discrete commentable sections.
 * Uses marked's Lexer for tokenization, then renders each token individually.
 */
export function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const tokens = marked.lexer(markdown);
  const sections: MarkdownSection[] = [];

  tokens.forEach((token, index) => {
    // Skip space tokens and other non-content tokens
    if (token.type === 'space') return;

    const html = marked.parser([token] as any, { async: false }) as string;
    const preview = ('text' in token)
      ? (token.text as string).substring(0, 80)
      : token.raw.substring(0, 80);

    sections.push({
      index,
      type: token.type,
      raw: token.raw,
      preview,
      html,
      depth: 'depth' in token ? (token as any).depth : undefined,
    });
  });

  return sections;
}
```

### 4. Research Content Component (New)

Instead of rendering research as a single `[innerHTML]` blob, introduce a new **`ResearchContentComponent`** that renders section-by-section and adds comment affordances.

**File: `src/app/features/tasks/research-content/research-content.component.ts`**

```typescript
@Component({
  selector: 'app-research-content',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatButtonModule, MatTooltipModule,
            MatFormFieldModule, MatInputModule, FormsModule],
  templateUrl: './research-content.component.html',
  styleUrl: './research-content.component.scss'
})
export class ResearchContentComponent {
  /** Raw markdown content */
  content = input.required<string>();

  /** Pending comments (managed by parent) */
  pendingComments = input<ResearchComment[]>([]);

  /** Emitted when user adds a comment to a section */
  commentAdded = output<{ anchor: ResearchCommentAnchor; body: string }>();

  /** Emitted when user removes a pending comment */
  commentRemoved = output<string>();  // comment id

  /** Parsed sections (computed from content) */
  sections = computed(() => parseMarkdownSections(this.content()));

  /** Currently active comment input (section index) */
  activeCommentSection: number | null = null;
  commentText = '';

  openCommentInput(sectionIndex: number): void {
    this.activeCommentSection = sectionIndex;
    this.commentText = '';
  }

  submitComment(section: MarkdownSection): void {
    if (!this.commentText.trim()) return;
    this.commentAdded.emit({
      anchor: {
        blockType: section.type,
        blockIndex: section.index,
        preview: section.preview,
      },
      body: this.commentText.trim(),
    });
    this.activeCommentSection = null;
    this.commentText = '';
  }

  cancelComment(): void {
    this.activeCommentSection = null;
    this.commentText = '';
  }

  getCommentsForSection(sectionIndex: number): ResearchComment[] {
    return this.pendingComments().filter(c => c.anchor.blockIndex === sectionIndex);
  }
}
```

**Template (`research-content.component.html`):**

```html
<div class="research-sections">
  @for (section of sections(); track section.index) {
    <div class="research-section"
         [class.has-comments]="getCommentsForSection(section.index).length > 0">
      <!-- Rendered markdown block -->
      <div class="section-content" [innerHTML]="section.html"></div>

      <!-- Comment button (appears on hover) -->
      <button mat-icon-button class="comment-trigger"
              matTooltip="Add comment"
              (click)="openCommentInput(section.index)">
        <mat-icon>add_comment</mat-icon>
      </button>

      <!-- Inline comments for this section -->
      @for (comment of getCommentsForSection(section.index); track comment.id) {
        <div class="inline-comment">
          <mat-icon class="comment-icon">comment</mat-icon>
          <span class="comment-body">{{ comment.body }}</span>
          <button mat-icon-button (click)="commentRemoved.emit(comment.id)" matTooltip="Remove">
            <mat-icon>close</mat-icon>
          </button>
        </div>
      }

      <!-- Comment input (when active) -->
      @if (activeCommentSection === section.index) {
        <div class="comment-input-area">
          <mat-form-field appearance="outline" class="comment-field">
            <mat-label>Your comment or suggestion</mat-label>
            <textarea matInput [(ngModel)]="commentText"
                      rows="2"
                      placeholder="Suggest a change, ask a question..."
                      (keydown.meta.enter)="submitComment(section)"
                      (keydown.control.enter)="submitComment(section)"
                      autofocus></textarea>
          </mat-form-field>
          <div class="comment-actions">
            <button mat-flat-button color="primary"
                    [disabled]="!commentText.trim()"
                    (click)="submitComment(section)">
              Add Comment
            </button>
            <button mat-button (click)="cancelComment()">Cancel</button>
          </div>
        </div>
      }
    </div>
  }
</div>
```

### 5. Comment Panel & Batch Submission

The **task-detail** component manages the pending comments list and submission. A collapsible panel at the bottom of the Research tab shows all pending comments.

**Additions to `task-detail.component.ts`:**

```typescript
// New state
pendingComments: ResearchComment[] = [];
reviewSubmitting = false;

// Output for submitting review
reviewSubmitted = output<{
  taskId: string;
  comments: ResearchComment[];
  researchSnapshot: string;
}>();

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
```

**Template addition (inside the Research tab, after the research content):**

```html
<!-- Replace the existing single innerHTML div with the new component -->
@if (task()!.researchContent) {
  <app-research-content
    [content]="task()!.researchContent!"
    [pendingComments]="pendingComments"
    (commentAdded)="addComment($event)"
    (commentRemoved)="removeComment($event)" />

  <!-- Comment summary panel -->
  @if (pendingComments.length > 0) {
    <div class="review-panel">
      <div class="review-panel-header">
        <mat-icon>rate_review</mat-icon>
        <span>{{ pendingComments.length }} pending comment{{ pendingComments.length > 1 ? 's' : '' }}</span>
      </div>

      <div class="review-comments-list">
        @for (comment of pendingComments; track comment.id) {
          <div class="review-comment-item">
            <span class="comment-anchor-label">
              {{ comment.anchor.blockType }}: "{{ comment.anchor.preview }}..."
            </span>
            <span class="comment-body">{{ comment.body }}</span>
            <button mat-icon-button (click)="removeComment(comment.id)">
              <mat-icon>close</mat-icon>
            </button>
          </div>
        }
      </div>

      <div class="review-panel-actions">
        <button mat-flat-button color="primary"
                [disabled]="reviewSubmitting"
                (click)="submitReview()">
          <mat-icon>send</mat-icon>
          Submit Review
        </button>
        <button mat-button
                [disabled]="reviewSubmitting"
                (click)="pendingComments = []">
          Discard All
        </button>
      </div>
    </div>
  }
}
```

### 6. IPC Channel & Main Process Handler

**New IPC channel in `src/shared/types/ipc.types.ts`:**

```typescript
export const IPC_CHANNELS = {
  // ... existing channels ...
  TASKS_SUBMIT_RESEARCH_REVIEW: 'tasks:submitResearchReview',
} as const;

// Payload:
[IPC_CHANNELS.TASKS_SUBMIT_RESEARCH_REVIEW]: {
  request: {
    taskId: string;
    comments: ResearchComment[];
    researchSnapshot: string;
  };
  response: { reviewId: string };
};
```

**Handler in `src/main/ipc/index.ts`:**

```typescript
ipcMain.handle(IPC_CHANNELS.TASKS_SUBMIT_RESEARCH_REVIEW, async (_event, { taskId, comments, researchSnapshot }) => {
  const task = await databaseService.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (!task.researchAgentId) throw new Error('No research agent assigned to task');

  const reviewId = uuidv4();

  // Persist the review
  await databaseService.createResearchReview({
    id: reviewId,
    taskId,
    comments,
    researchSnapshot,
    status: 'pending',
  });

  // Get the agent's session
  const agentId = task.researchAgentId;
  let sessionProcess = processManagerService.getSessionByAgentId(agentId);
  if (!sessionProcess) {
    // Re-start the agent session if needed
    const agent = discoveredAgents.get(agentId) || await databaseService.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    const workDir = directoryService.getCurrentDirectory();
    if (!workDir) throw new Error('No workspace directory');
    const session = await processManagerService.startSession(agent, workDir);
    subscribeToSession(session.id, agentId);
    sessionProcess = processManagerService.getSessionByAgentId(agentId);
  }

  // Build the revision prompt
  const commentBlock = comments.map((c, i) =>
    `${i + 1}. [${c.anchor.blockType}: "${c.anchor.preview}..."]\n   Comment: ${c.body}`
  ).join('\n\n');

  const revisionPrompt = [
    `You previously produced the following research document for the task "${task.title}":`,
    ``,
    `---BEGIN RESEARCH---`,
    researchSnapshot,
    `---END RESEARCH---`,
    ``,
    `The reviewer has left the following comments requesting changes:`,
    ``,
    commentBlock,
    ``,
    `Please produce an updated version of the research document that addresses each comment.`,
    `Output ONLY the revised markdown document content. Do not include meta-commentary about the changes.`,
  ].join('\n');

  // Update review status
  await databaseService.updateResearchReview(reviewId, { status: 'in_progress' });

  // Listen for completion
  const onComplete = async (message: { content: string }) => {
    // Save the revised content
    await databaseService.updateTask(taskId, { researchContent: message.content });
    await databaseService.updateResearchReview(reviewId, {
      status: 'complete',
      revisedContent: message.content,
    });

    // Also update the file on disk for non-bug tasks
    if (task.kind !== 'bug') {
      const workDir = directoryService.getCurrentDirectory();
      if (workDir) {
        const researchDir = path.join(workDir, 'research');
        const safeTitle = task.title.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
        const filePath = path.join(researchDir, `${safeTitle}.md`);
        fs.writeFileSync(filePath, message.content, 'utf-8');
      }
    }

    // Notify renderer
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_STREAM_COMPLETE, {
      id: taskId,
      agentId,
      role: 'assistant',
      content: message.content,
      timestamp: new Date(),
    });
  };

  processManagerService.onComplete(sessionProcess!.session.id, onComplete);
  processManagerService.sendMessage(sessionProcess!.session.id, revisionPrompt).catch((error) => {
    console.error('[Research Review] Error:', error);
    databaseService.updateResearchReview(reviewId, { status: 'pending' });
    mainWindow.webContents.send(IPC_CHANNELS.APP_ERROR, { agentId, error: String(error) });
  });

  return { reviewId };
});
```

### 7. ElectronService & TaskService Additions

**`electron.service.ts`:**

```typescript
async submitResearchReview(
  taskId: string,
  comments: ResearchComment[],
  researchSnapshot: string
): Promise<{ reviewId: string } | null> {
  if (!this.api) return null;
  return this.api.tasks.submitResearchReview(taskId, comments, researchSnapshot);
}
```

**`task.service.ts`:**

```typescript
async submitResearchReview(
  taskId: string,
  comments: ResearchComment[],
  researchSnapshot: string
): Promise<void> {
  await this.electronService.submitResearchReview(taskId, comments, researchSnapshot);
  // The task will be refreshed when the agent completes (via streamComplete listener)
}
```

### 8. Preload API Extension

**`src/preload/index.ts`** — Add to the `tasks` namespace:

```typescript
submitResearchReview: (taskId: string, comments: ResearchComment[], researchSnapshot: string) =>
  ipcRenderer.invoke(IPC_CHANNELS.TASKS_SUBMIT_RESEARCH_REVIEW, { taskId, comments, researchSnapshot }),
```

---

## Implementation Plan

### Phase 1: Data Layer
- [ ] Add `ResearchComment`, `ResearchReview` types to `task.types.ts`
- [ ] Add `research_reviews` table migration to `database.service.ts`
- [ ] Add `createResearchReview`, `updateResearchReview`, `getResearchReviews` methods to `DatabaseService`
- [ ] Add `TASKS_SUBMIT_RESEARCH_REVIEW` IPC channel and payload types to `ipc.types.ts`

### Phase 2: Main Process Handler
- [ ] Add the IPC handler for `TASKS_SUBMIT_RESEARCH_REVIEW` in `src/main/ipc/index.ts`
- [ ] Add the preload API bridge in `src/preload/index.ts`

### Phase 3: Renderer — Markdown Section Parser
- [ ] Create `src/app/shared/utils/markdown-sections.ts` utility

### Phase 4: Renderer — Research Content Component
- [ ] Create `ResearchContentComponent` (template, styles, logic)
- [ ] Integrate into `task-detail.component.html` replacing the single `[innerHTML]` div
- [ ] Add section-hover comment button and inline comment input UX

### Phase 5: Renderer — Comment Panel & Submission
- [ ] Add pending comment state and review submission logic to `task-detail.component.ts`
- [ ] Add the review panel template with comment list and submit/discard buttons
- [ ] Wire up `ElectronService.submitResearchReview` and `TaskService.submitResearchReview`
- [ ] Handle completion: clear pending comments, refresh task to show revised content

### Phase 6: Polish
- [ ] Add review panel SCSS (sticky positioning at bottom, comment highlighting)
- [ ] Add visual indicator on sections that have comments (left-border highlight)
- [ ] Add loading/spinner state while agent processes the review
- [ ] Add revision history UI (optional, could show prior versions in a sub-tab or expandable section)

---

## Considerations

### UX Decisions

| Decision | Recommendation | Rationale |
|----------|---------------|-----------|
| Comment granularity | Section-level (headings, paragraphs, code blocks) | Simpler than character-range selection; matches how people review documents. The `marked.lexer()` gives us natural block boundaries for free. |
| Inline vs. sidebar comments | Inline (below each section) | Keeps the context visible; avoids split-attention between a sidebar and the content. Matches VS Code's inline comment UX. |
| Comment persistence before submission | In-memory only (Angular component state) | No need to persist drafts — they're short-lived. Keeps the database simple. If the user navigates away, comments are lost (with a confirmation prompt). |
| Revision model | Replace-in-place with history | The `researchContent` field always holds the latest version. The `research_reviews` table preserves each round's snapshot and revision. |
| Agent session reuse | Reuse existing session if alive | Avoids cold-start latency. The agent already has context from the initial research. If the session is dead, start a fresh one. |

### Technical Risks

1. **Markdown parsing fidelity** — `marked.lexer()` may split content differently than the user perceives. For example, a paragraph followed by a list might be one or two tokens. Mitigation: use the token `raw` field to reconstruct boundaries reliably.

2. **Large research documents** — If research output is very long (10k+ words), the revision prompt (which includes the full original) could exceed the agent's context window. Mitigation: for very large documents, include only the commented sections with surrounding context rather than the full document.

3. **Agent context continuity** — If the agent session was terminated between the initial research and the review, the new session won't have the original conversation context. Mitigation: the revision prompt is self-contained (includes the full original document), so context continuity isn't required.

4. **Concurrent reviews** — If the user submits a review while a previous one is still processing, we need to handle this gracefully. Mitigation: disable the submit button while `reviewSubmitting` is true; the agent processes sequentially.

5. **Section index stability** — If the research content changes between when the user starts commenting and when they submit, the `blockIndex` anchors could be stale. Mitigation: we pass the `researchSnapshot` with the review, so the agent always works against the exact version the user commented on.

### Alternative Approaches Considered

1. **Character-range comments (like Google Docs)** — Too complex for the initial implementation. Requires text selection handling, range serialization, and overlap resolution. Could be a future enhancement.

2. **Separate chat thread for feedback** — The user could just chat with the researcher agent. However, this loses the structured section-level anchoring and the batch-review model. It's also harder to produce a clean revised document vs. an ongoing conversation.

3. **Diff-based revisions** — Show the revision as a diff against the original. This is useful but complex to implement well. Better as a Phase 2 enhancement after the basic comment system works.

---

## File Change Summary

| File | Change Type | Description |
|------|------------|-------------|
| `src/shared/types/task.types.ts` | Modify | Add `ResearchComment`, `ResearchReview` interfaces |
| `src/shared/types/ipc.types.ts` | Modify | Add `TASKS_SUBMIT_RESEARCH_REVIEW` channel + payload |
| `src/main/services/database.service.ts` | Modify | Add `research_reviews` table, CRUD methods |
| `src/main/ipc/index.ts` | Modify | Add review submission handler |
| `src/preload/index.ts` | Modify | Add `submitResearchReview` bridge |
| `src/app/shared/utils/markdown-sections.ts` | **New** | Markdown section parser utility |
| `src/app/features/tasks/research-content/` | **New** | `ResearchContentComponent` (ts, html, scss) |
| `src/app/features/tasks/task-detail/task-detail.component.ts` | Modify | Add comment state, review submission logic |
| `src/app/features/tasks/task-detail/task-detail.component.html` | Modify | Replace innerHTML with `ResearchContentComponent`, add review panel |
| `src/app/features/tasks/task-detail/task-detail.component.scss` | Modify | Styles for review panel, comment highlights |
| `src/app/features/tasks/task-list/task-list.component.ts` | Modify | Wire up review submission event from detail |
| `src/app/core/services/electron.service.ts` | Modify | Add `submitResearchReview` method |
| `src/app/core/services/task.service.ts` | Modify | Add `submitResearchReview` method |
