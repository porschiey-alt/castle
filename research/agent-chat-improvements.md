# Agent Chat Improvements — Technical Research

## Problem Statement

When an agent processes a long task, it sends a stream of thinking messages, chat content updates, and tool call information. The current UI has three key problems:

1. **Thought messages accumulate**: All thinking text appends into `thinkingBuffer` on the backend and renders as one massive, unreadable block in a single `thinking-block` div.
2. **Everything in one bubble**: Thinking, tool calls, and chat text all render inside a single `<app-message-bubble>`, making it difficult to visually parse what's happening.
3. **Streaming content vanishes on completion**: When the stream completes, `clearStreamingMessage()` sets `streamingMessage` to `null`, and the final `ChatMessage` saved to the database only contains `content` and `role` — all tool calls, segments, and intermediate text are lost.

---

## Current Architecture

### Data Flow

```
User message
  → IPC CHAT_SEND_MESSAGE
    → ProcessManagerService.sendMessage()
      → ACP connection.prompt()
        → sessionUpdate callbacks (thought_chunk, message_chunk, tool_call, tool_call_update, plan)
          → emitOutput() builds StreamingMessage from accumulated buffers
            → eventEmitter.emit('output', streamingMessage)
              → IPC CHAT_STREAM_CHUNK → renderer
      → on prompt() completion:
        → eventEmitter.emit('complete', completeMessage)
          → IPC CHAT_STREAM_COMPLETE
            → databaseService.saveMessage({ content, role, agentId, conversationId, timestamp })
            → renderer: addMessageIfNew() + clearStreamingMessage()
```

### Key Files

| File | Role |
|------|------|
| `src/main/services/process-manager.service.ts` | Backend: accumulates buffers, emits `StreamingMessage` chunks |
| `src/main/ipc/index.ts` | IPC layer: forwards chunks to renderer, saves final message to DB |
| `src/shared/types/message.types.ts` | Shared types: `StreamingMessage`, `ChatMessage`, `MessageSegment`, `ToolCall` |
| `src/app/core/services/chat.service.ts` | Frontend state: manages `ChatState` per agent with signals |
| `src/app/features/chat/chat.component.ts` | Chat page: wires signals to child components |
| `src/app/features/chat/message-list/message-list.component.html` | Renders historical messages + single streaming bubble |
| `src/app/features/chat/message-bubble/message-bubble.component.ts` | Message rendering: parses content, resolves segments |
| `src/app/features/chat/message-bubble/message-bubble.component.html` | Template: thinking block, segments, tool calls, text |
| `src/app/features/chat/message-bubble/message-bubble.component.scss` | Styles: shimmer animation, thinking-block, tool-call items |

### Current StreamingMessage Shape

```typescript
interface StreamingMessage {
  id: string;
  agentId: string;
  content: string;         // Accumulated text (all agent_message_chunk text appended)
  thinking: string;        // Accumulated thinking (all agent_thought_chunk text appended)
  isComplete: boolean;
  toolCalls?: ToolCall[];  // All tool calls collected from session
  todoItems?: TodoItem[];
  segments?: MessageSegment[];  // Chronological interleaving of text + tool-call groups
}
```

### How Thinking Accumulates (the core UX problem)

In `process-manager.service.ts` line 220-223:
```typescript
if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
  sessionProcess.thinkingBuffer += update.content.text;
  emitOutput();
}
```

Every thought chunk appends to `thinkingBuffer`. The UI renders the **entire buffer** in one div:
```html
@if (thinking) {
  <div class="thinking-block">
    <mat-icon class="thinking-icon">psychology</mat-icon>
    <span class="thinking-text">{{ thinking }}</span>
  </div>
}
```

This produces the wall of text described in the issue.

### How Stream Completion Loses Data

In `chat.service.ts` line 80-84:
```typescript
this.electronService.streamComplete$.subscribe((message: ChatMessage) => {
  this.addMessageIfNew(message.agentId, message);
  this.clearStreamingMessage(message.agentId);  // ← sets streamingMessage to null
  this.setLoading(message.agentId, false);
});
```

And in `ipc/index.ts` line 141-151, the saved message only has:
```typescript
const assistantMessage = await databaseService.saveMessage({
  agentId,
  conversationId,
  role: 'assistant',
  content: message.content,   // ← only text content
  timestamp: new Date()        // ← no toolCalls, no segments, no thinking
});
```

So all tool calls and intermediate text segments are lost when the stream finishes.

---

## Proposed Approach

### 1. Thought Messages — "Replace, Don't Accumulate"

**Goal**: Show only the latest thought in a standalone bubble with a shimmer/flicker animation. When a new thought arrives, it replaces the old one. When the agent finishes, the thought bubble disappears.

#### Backend Changes (`process-manager.service.ts`)

**Option A — Minimal Backend Change (Recommended)**: Keep `thinkingBuffer` as-is (for potential logging), but add a new `latestThinking` field to `StreamingMessage`:

```typescript
// In message.types.ts — add to StreamingMessage:
latestThinking?: string;

// In process-manager.service.ts — track latest thought:
sessionProcess.latestThinking = '';

// In agent_thought_chunk handler:
if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
  sessionProcess.thinkingBuffer += update.content.text;
  sessionProcess.latestThinking = update.content.text;  // replace, don't append
  emitOutput();
}
```

But the above only catches single chunks. Agent thoughts often come in multiple rapid chunks that form one sentence. A better approach:

**Option B — Sentence-level Replacement (Recommended)**: Track thinking as an array of complete thoughts. Use a heuristic (e.g., pause between chunks > 500ms, or a newline delimiter) to detect thought boundaries:

```typescript
// In StreamingMessage:
thinkingMessages?: string[];  // Array of individual thoughts

// In process-manager.service.ts:
sessionProcess.thinkingMessages = [];
sessionProcess.currentThinkingChunk = '';
sessionProcess.lastThinkingAt = 0;

// On agent_thought_chunk:
const now = Date.now();
const GAP = 800; // ms threshold for "new thought"
if (now - sessionProcess.lastThinkingAt > GAP && sessionProcess.currentThinkingChunk.trim()) {
  sessionProcess.thinkingMessages.push(sessionProcess.currentThinkingChunk.trim());
  sessionProcess.currentThinkingChunk = '';
}
sessionProcess.currentThinkingChunk += update.content.text;
sessionProcess.lastThinkingAt = now;
```

Then the UI renders only the last item from `thinkingMessages` or the current `currentThinkingChunk`.

**Option C — Frontend-Only (Simplest)**: Don't change the backend at all. In `MessageBubbleComponent`, use `thinking.split(/\n+/).pop()` or just show the last ~100 characters. This is the least accurate but simplest to implement.

**Recommendation**: Start with **Option C** (frontend-only) for rapid iteration. If thought boundaries don't split cleanly on newlines, upgrade to **Option B**.

#### Frontend Changes

- The thinking block gets its own standalone bubble (not inside the message bubble).
- Apply the existing `shimmer` animation (or a new `pulse`/`flicker` CSS animation) to the standalone thought bubble.
- When `streamingMessage` is null (stream complete), the thought bubble disappears naturally.

### 2. Split the Single Bubble into Multiple Bubbles

**Goal**: Instead of rendering one massive `<app-message-bubble>` for the streaming state, render the streaming content as a **list of discrete visual elements**: a thought bubble, tool-call groups, and text messages — each as a separate bubble.

#### Current (single bubble)
```
┌─────────────────────────────────┐
│ 🧠 thinking thinking thinking.. │
│ 🔧 tool_call_1  ✓              │
│ 🔧 tool_call_2  ⟳              │
│ Here's what I found...          │
│ 🔧 tool_call_3  ⟳              │
│ The answer is...                │
│ ▊                               │
└─────────────────────────────────┘
```

#### Proposed (multiple bubbles)
```
┌────────────────────────────────────┐
│ 💭 Exploring the codebase...       │  ← thought bubble (shimmer animation)
└────────────────────────────────────┘

┌────────────────────────────────────┐
│ 🔧 read_file          ✓           │  ← tool-call group bubble
│ 🔧 list_directory      ✓           │
└────────────────────────────────────┘

┌────────────────────────────────────┐
│ Here's what I found in the code... │  ← text bubble
└────────────────────────────────────┘

┌────────────────────────────────────┐
│ 🔧 edit_file           ⟳          │  ← tool-call group bubble
└────────────────────────────────────┘

▊                                      ← cursor / processing indicator
```

#### Implementation Strategy

**Approach A — Decompose in `message-list.component.html` (Recommended)**:

Instead of passing the entire `StreamingMessage` to one `<app-message-bubble>`, decompose the segments into individual bubbles at the `message-list` level:

```html
@if (streamingMessage(); as streaming) {
  <!-- Thought bubble (standalone, latest only) -->
  @if (streaming.thinking) {
    <app-thinking-bubble [thinking]="streaming.thinking" />
  }

  <!-- Render each segment as its own bubble -->
  @for (segment of streaming.segments; track $index) {
    @if (segment.type === 'tool-calls') {
      <app-tool-calls-bubble [toolCalls]="segment.toolCalls" />
    } @else {
      <app-message-bubble
        [streamingContent]="segment.content"
        [isStreaming]="$last"
        [agentName]="agentName()"
        [agentIcon]="agentIcon()"
      />
    }
  }

  <!-- Processing indicator when no segments yet -->
  @if (!streaming.segments?.length) {
    <app-message-bubble [isStreaming]="true" [agentName]="agentName()" [agentIcon]="agentIcon()" />
  }
}
```

This requires creating two small new components:
- `ThinkingBubbleComponent` — renders latest thought with animation
- `ToolCallsBubbleComponent` — renders a group of tool calls (could just be extracted from existing message-bubble markup)

Or alternatively, reuse `MessageBubbleComponent` with different input combinations.

**Approach B — Single component with segment-level rendering**: Keep a single wrapper but use CSS to visually separate segments into distinct card-like regions. Less code change but less clean separation.

**Recommendation**: **Approach A** provides the clearest UX and cleanest component architecture.

### 3. Persist Streaming Data on Completion

**Goal**: When the agent finishes, keep tool calls and intermediate chat messages visible. Only remove the animated thought bubble.

#### Problem

Currently, `clearStreamingMessage()` nukes the entire `streamingMessage` signal, and the saved `ChatMessage` only has `content`. All segments, tool calls, and thinking are lost.

#### Solution

**Step 1 — Save segments and tool calls to the database**:

In `ipc/index.ts`, include metadata when saving:

```typescript
processManagerService.onComplete(sessionId, async (message) => {
  const assistantMessage = await databaseService.saveMessage({
    agentId,
    conversationId,
    role: 'assistant',
    content: message.content,
    timestamp: new Date(),
    metadata: {
      toolCalls: message.toolCalls,
      // Optionally save segments for historical interleaved rendering
    }
  });
  broadcaster.send(IPC_CHANNELS.CHAT_STREAM_COMPLETE, assistantMessage);
});
```

**Step 2 — Database schema**: Ensure `MessageMetadata` is stored. Check if the database `saveMessage` method already persists a `metadata` column. If not, add one (JSON column).

**Step 3 — Render historical messages with segments**: The `message-bubble.component.ts` already has a legacy path for `activeToolCalls` from `message.metadata.toolCalls`. Once tool calls are saved to the DB, they'll render in historical messages automatically via the existing legacy template path.

**Step 4 — Keep streaming segments visible during transition**: Instead of immediately clearing `streamingMessage`, introduce a brief "completion" state:

```typescript
// In chat.service.ts:
this.electronService.streamComplete$.subscribe((message: ChatMessage) => {
  this.addMessageIfNew(message.agentId, message);
  this.clearStreamingMessage(message.agentId);  // This is fine if DB message has the data
  this.setLoading(message.agentId, false);
});
```

If segments are saved to the DB and the historical message renders them, the transition is seamless — streaming bubble disappears, historical bubble with same data appears.

### 4. Keep Tool Calls Rendering As-Is

The current tool call rendering (status icons, collapsible older calls, running/success/error styling) is working well. No changes needed beyond:
- Extracting it into its own component (if going with Approach A above)
- Ensuring tool calls persist in the database

---

## Detailed Implementation Plan

### Phase 1: Thought Bubble Isolation

**Files to modify:**
- `src/shared/types/message.types.ts` — (optional) add `latestThinking` field
- `src/app/features/chat/message-bubble/message-bubble.component.html` — remove thinking block from here
- `src/app/features/chat/message-list/message-list.component.html` — add standalone thinking bubble
- `src/app/features/chat/message-list/message-list.component.scss` — style the thinking bubble

**New file (optional):**
- `src/app/features/chat/thinking-bubble/thinking-bubble.component.ts|html|scss` — dedicated thinking bubble component

**Logic:**
- Extract the `thinking-block` from `message-bubble` into either a new component or inline in `message-list`
- Show only the last thought (split on newlines or use `latestThinking`)
- Apply shimmer/pulse animation
- Conditionally render only when `streamingMessage()?.thinking` is truthy

### Phase 2: Split Streaming Into Multiple Bubbles

**Files to modify:**
- `src/app/features/chat/message-list/message-list.component.html` — decompose streaming segments
- `src/app/features/chat/message-list/message-list.component.ts` — add helper methods for segment decomposition
- `src/app/features/chat/message-bubble/message-bubble.component.ts` — simplify (remove thinking/streaming-segment responsibility)
- `src/app/features/chat/message-bubble/message-bubble.component.html` — simplify template

**New files (recommended):**
- `src/app/features/chat/thinking-bubble/` — thinking bubble component
- `src/app/features/chat/tool-calls-bubble/` — tool-calls group component (extract from message-bubble)

### Phase 3: Persist Streaming Data

**Files to modify:**
- `src/main/ipc/index.ts` — include `metadata.toolCalls` when saving assistant message
- `src/main/services/database.service.ts` — ensure `metadata` JSON column exists and is read/written
- `src/app/features/chat/message-bubble/message-bubble.component.ts` — ensure historical messages render tool calls (already partially implemented via `activeToolCalls` getter)

**Database check:**
- Verify the messages table has a `metadata` column (likely already there based on `ChatMessage.metadata` type existing)
- Verify `saveMessage()` and `getMessages()` handle the metadata field

### Phase 4: Polish & Transitions

- Ensure auto-scroll behavior works with multiple bubbles
- Add fade-out animation for thought bubble on completion
- Test with long agent sessions (many tool calls, many thoughts)
- Verify that conversation history loads correctly with persisted tool calls

---

## Considerations

### Performance
- Multiple bubbles instead of one means more DOM elements during streaming. With Angular's `@for` + `track`, this should be efficient. The segment count is typically <20 for most agent runs.
- The `resolvedSegments` getter currently runs on every change detection cycle. Consider using `computed()` signals if converting to signal-based inputs.

### Thought Boundary Detection
- The simplest approach (split on newlines, show last line) may produce choppy results if thoughts are streamed character-by-character without natural boundaries.
- A time-gap heuristic on the backend (e.g., 800ms gap = new thought) would be more reliable but requires backend changes.
- Consider using the `report_intent` / tool name changes as thought boundaries — these are already discrete events from the ACP protocol.

### Database Migration
- Adding `metadata` to saved messages (if not already present) may require a schema migration. Check `database.service.ts` for existing schema.
- Historical messages without metadata will render fine (the `activeToolCalls` getter returns `[]` if metadata is missing).

### Backward Compatibility
- The `StreamingMessage.thinking` field (full buffer) should remain for any consumers that depend on it. The UI just chooses to display only the latest portion.
- The `segments` array is already optional. Adding new bubble components that consume segments is backward-compatible.

### Auto-Scroll
- The current `MessageListComponent` auto-scrolls on `AfterViewChecked`. With multiple bubbles being added/updated during streaming, ensure that frequent DOM changes don't cause scroll jank. May need to throttle scroll-to-bottom calls.

### Testing
- Test with an agent that does 50+ tool calls to ensure collapsed tool call count works per-bubble.
- Test with rapid thought updates to verify only latest thought shows.
- Test conversation reload to verify persisted tool calls render correctly.
- Test cancel flow — ensure partial streaming data doesn't leave ghost bubbles.

---

## Summary of Changes by File

| File | Change |
|------|--------|
| `message.types.ts` | Optional: add `latestThinking` to `StreamingMessage` |
| `message-list.component.html` | Decompose streaming into thought + segment bubbles |
| `message-list.component.ts` | Add segment helpers, import new components |
| `message-bubble.component.html` | Remove thinking block, simplify streaming path |
| `message-bubble.component.ts` | Remove thinking inputs/getters if extracted |
| `message-bubble.component.scss` | Move thinking-block styles to new component |
| `ipc/index.ts` | Save `metadata.toolCalls` on stream complete |
| `database.service.ts` | Verify metadata column persistence |
| **New:** `thinking-bubble/` | Standalone thought component with shimmer animation |
| **New:** `tool-calls-bubble/` | Extracted tool-call group component |
