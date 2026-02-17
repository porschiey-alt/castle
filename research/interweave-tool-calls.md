# Interweave Tool Calls with Chat Messages

## Problem Statement

When an agent is processing a task, the current UI renders a single `<app-message-bubble>` for the entire streaming response. Inside that bubble, **all tool calls** are grouped into one block at the top, and **all text content** appears in a separate block below. However, the agent actually interleaves these — it might say something, then run some tools, then say more, then run more tools. The current presentation loses this temporal ordering, making the agent's workflow harder to follow.

### Desired Behavior

The conversation should show interleaved segments like:

> **Agent:** Let me work on that for you!
>
> ▸ 5 previous tool calls
>   - Reading File Foo
>   - Reading File Bar
>
> **Agent:** Now I've got the idea! I need to edit Something.txt
>
> ▸ 10 previous tool calls
>   - Editing something.txt

---

## Technical Analysis

### Current Architecture

#### Data Flow (Streaming)

1. **`ProcessManagerService`** (main process) receives ACP `sessionUpdate` events from the Copilot CLI child process.
2. Each event type (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`) is handled inside a `sessionUpdate` callback.
3. Every event emits a single `StreamingMessage` object via `eventEmitter.emit('output', ...)`.
4. The IPC layer (`ipc/index.ts`) forwards this to the renderer via `broadcaster.send(IPC_CHANNELS.CHAT_STREAM_CHUNK, message)`.
5. **`ChatService`** (renderer) receives chunks and stores the **entire** `StreamingMessage` as one signal: `streamingMessage`.
6. **`MessageListComponent`** renders a single `<app-message-bubble>` for the streaming message.
7. **`MessageBubbleComponent`** renders:
   - Thinking block (top)
   - Tool calls list (middle, with collapsed count for >5)
   - Message body text (bottom)

#### Key Types

```typescript
// shared/types/message.types.ts

interface StreamingMessage {
  id: string;
  agentId: string;
  content: string;       // ← single flat string, appended to over time
  thinking: string;      // ← single flat string
  isComplete: boolean;
  toolCalls?: ToolCall[];  // ← flat array, grows over time
  todoItems?: TodoItem[];
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus; // 'pending' | 'running' | 'success' | 'error'
  result?: string;
  error?: string;
}
```

#### Key Files

| File | Role |
|------|------|
| `src/shared/types/message.types.ts` | Type definitions for `StreamingMessage`, `ToolCall`, `ChatMessage` |
| `src/main/services/process-manager.service.ts` | Manages ACP child processes; builds and emits `StreamingMessage` |
| `src/main/ipc/index.ts` | IPC handlers; forwards streaming events to renderer |
| `src/app/core/services/chat.service.ts` | Renderer-side state management for messages |
| `src/app/features/chat/message-list/` | Renders the list of messages + streaming bubble |
| `src/app/features/chat/message-bubble/` | Renders a single message (text, tools, thinking) |

### Root Cause

The `StreamingMessage` type accumulates **all** content into a single flat `content` string and a single flat `toolCalls[]` array. There is no concept of ordered segments, so the renderer has no way to know *when* text appeared relative to tool calls.

In `ProcessManagerService.sessionUpdate()`:
- `agent_message_chunk` appends to `contentBuffer` (a single string)
- `tool_call` / `tool_call_update` adds/updates entries in a `toolCalls` Map
- Both then call `emitOutput()`, which sends the entire accumulated state

The template in `message-bubble.component.html` renders tool calls first, then text — always in that fixed order.

---

## Proposed Approach

### Core Concept: Ordered Segments

Replace the flat `content` + `toolCalls[]` model with an ordered list of **segments**. Each segment is either a "text" segment or a "tool-group" segment, preserving the temporal order in which content arrived.

### New Types

```typescript
// New: A segment of streaming output
interface StreamingSegment {
  type: 'text' | 'tool-group';
  // For 'text' segments:
  content?: string;
  // For 'tool-group' segments:
  toolCalls?: ToolCall[];
}

// Updated StreamingMessage
interface StreamingMessage {
  id: string;
  agentId: string;
  thinking: string;
  isComplete: boolean;
  segments: StreamingSegment[];   // ← replaces content + toolCalls
  todoItems?: TodoItem[];
}
```

### Changes by Layer

#### 1. `ProcessManagerService` (Main Process)

**Current:** Maintains `contentBuffer: string` and `toolCalls: Map<string, ToolCall>`.

**Proposed:** Maintain an ordered `segments: StreamingSegment[]` array. When a new ACP event arrives:

- **`agent_message_chunk`:** If the last segment is `type: 'text'`, append to it. Otherwise, push a new text segment.
- **`tool_call`:** If the last segment is `type: 'tool-group'`, add the tool call to it. Otherwise, push a new tool-group segment with this tool call.
- **`tool_call_update`:** Find and update the tool call in whichever segment contains it.
- **`agent_thought_chunk`:** Continue appending to the flat `thinkingBuffer` (thinking is metadata, not interleaved).
- **`plan`:** Continue handling as today (todoItems are separate).

The `emitOutput()` function already emits the full accumulated state on every event — it will now include the `segments` array.

```typescript
// In SessionProcess:
segments: StreamingSegment[];  // replaces contentBuffer + toolCalls

// In sessionUpdate handler:
if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
  const last = segments[segments.length - 1];
  if (last?.type === 'text') {
    last.content += update.content.text;
  } else {
    segments.push({ type: 'text', content: update.content.text });
  }
  emitOutput();
}

if (update.sessionUpdate === 'tool_call') {
  const toolCall: ToolCall = { /* ... */ };
  const last = segments[segments.length - 1];
  if (last?.type === 'tool-group') {
    last.toolCalls!.push(toolCall);
  } else {
    segments.push({ type: 'tool-group', toolCalls: [toolCall] });
  }
  emitOutput();
}
```

#### 2. `StreamingMessage` and `ChatMessage` Types

- Add `segments: StreamingSegment[]` to `StreamingMessage`.
- **Deprecation path:** Keep `content` and `toolCalls` as computed convenience getters for backward compat (e.g. `get content() { return segments.filter(s => s.type === 'text').map(s => s.content).join(''); }`). Alternatively, keep them populated in parallel during a transition period.
- Optionally add `segments` to `MessageMetadata` on `ChatMessage` so persisted messages can also be rendered interleaved when loaded from history.

#### 3. `ChatService` (Renderer)

Minimal changes needed. The service already stores the whole `StreamingMessage` — it just needs to flow the new `segments` field through.

#### 4. `MessageBubbleComponent` (Template + Logic)

This is where the most visible changes happen.

**Current template structure:**
```
thinking → tool-calls-list → message-body
```

**New template structure:**
```
thinking → @for (segment of segments) { text-block | tool-group }
```

```html
<!-- Thinking (unchanged) -->
@if (thinking) { ... }

<!-- Interleaved segments -->
@for (segment of segments; track $index) {
  @if (segment.type === 'text') {
    <div class="message-body">
      @for (part of parseContent(segment.content); track $index) {
        <!-- same text/code rendering as today -->
      }
    </div>
  } @else if (segment.type === 'tool-group') {
    <div class="tool-calls-list">
      <!-- collapsible group with count -->
      @if (segment.toolCalls.length > MAX_VISIBLE) {
        <div class="tool-calls-collapsed">...</div>
      }
      @for (tool of visibleTools(segment); track tool.id) {
        <div class="tool-call-item" ...>...</div>
      }
    </div>
  }
}

<!-- Streaming cursor at the end -->
@if (isStreaming()) {
  <span class="cursor">▊</span>
}
```

**Component logic changes:**
- Replace `activeToolCalls`, `visibleToolCalls`, `hiddenToolCallCount` with segment-aware equivalents.
- Add a `segments` computed property that reads from `streamingMessage.segments` (streaming) or `message.metadata.segments` (persisted).
- The `parsedContent` getter becomes a method `parseContent(text: string)` that takes a segment's content.

#### 5. `MessageListComponent` (Minimal Changes)

Pass through `streamingMessage.segments` to `MessageBubbleComponent`. Since the bubble already receives the full streaming message via inputs, it can read segments directly.

#### 6. Persisted Messages (Database)

**Option A (Recommended for Phase 1):** Don't persist segments. Historical messages continue rendering in the old flat style — only streaming messages get the interleaved view. This is the minimal change.

**Option B (Full):** Store `segments` in `MessageMetadata`. The database `saveMessage` call in `ipc/index.ts` would include the segments from the completed `StreamingMessage`. Old messages without segments fall back to the flat rendering.

---

## Implementation Plan

### Phase 1: Core Segmentation (Streaming Only)

1. **Add `StreamingSegment` type** to `message.types.ts`
2. **Update `StreamingMessage`** to include `segments[]`
3. **Refactor `ProcessManagerService.sessionUpdate()`** to build ordered segments instead of flat buffers
4. **Keep backward-compatible** `content` string derivation (join all text segments) so `emitOutput()` / `onComplete` / database saves don't break
5. **Update `MessageBubbleComponent`** template + logic to render segments when available, falling back to flat rendering when not
6. **Update SCSS** for consistent styling of interleaved segments

### Phase 2: Polish & Persistence

7. **Add collapsible tool groups** — each tool-group segment gets its own expand/collapse, with a label like "5 tool calls" (similar to the existing `hiddenToolCallCount` but per-group)
8. **Persist segments** to `MessageMetadata` so historical messages also render interleaved
9. **Animate transitions** — smooth appearance of new segments during streaming

---

## Considerations

### Backward Compatibility

- The `content` field on `StreamingMessage` must remain populated for:
  - Database persistence (`saveMessage` uses `message.content`)
  - The `onComplete` handler that saves assistant messages
  - Any code that reads `streamingMessage.content` directly
- Solution: Derive `content` from segments (concatenation of all text segments) and keep it in sync.

### Performance

- The `segments` array will be rebuilt/emitted on every ACP event. Since `emitOutput()` already sends the full state each time, this is no worse than today.
- The template iterates over segments instead of a single block — for typical agent responses (5-20 segments), this is negligible.

### Edge Cases

- **Agent sends text, then tools, then more text, then more tools**: This is the happy path — produces 4 segments.
- **Agent sends only tools (no text)**: Single tool-group segment. Streaming cursor shows after it.
- **Agent sends only text (no tools)**: Single text segment. Renders identically to today.
- **Tool call update arrives for a tool in an earlier segment**: Need to search all segments for the matching `toolCallId`, not just the last one.
- **Empty text chunks**: Ignore or trim — don't create empty text segments.
- **Rapid alternation** (text → tool → text → tool per character): The "append to last if same type" logic prevents this from creating excessive segments.

### Streaming UX

- The **cursor** (▊) should appear after the *last* segment, regardless of type.
- The **processing shimmer** should appear when there are no segments yet (agent hasn't started producing output).
- During streaming, the last segment is "active" — if it's a text segment, it grows character by character. If it's a tool-group, new tool calls may appear.

### Testing Strategy

- Unit test: Given a sequence of ACP events, verify the resulting `segments` array structure.
- Visual test: Confirm the template renders segments in the correct order with proper styling.
- Regression: Ensure persisted historical messages (without segments) still render correctly.

---

## File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/shared/types/message.types.ts` | Modify | Add `StreamingSegment` interface; add `segments` to `StreamingMessage` |
| `src/main/services/process-manager.service.ts` | Modify | Replace flat buffers with segment-building logic in `sessionUpdate`; keep `content` derived |
| `src/app/features/chat/message-bubble/message-bubble.component.ts` | Modify | Add segment-aware computed properties; make `parseContent` a method |
| `src/app/features/chat/message-bubble/message-bubble.component.html` | Modify | Iterate over segments instead of fixed thinking→tools→text layout |
| `src/app/features/chat/message-bubble/message-bubble.component.scss` | Modify | Minor styling adjustments for interleaved layout consistency |
| `src/app/features/chat/message-list/message-list.component.html` | No change | Already passes `streamingMessage` through to bubble |
| `src/app/core/services/chat.service.ts` | No change | Already flows `StreamingMessage` as-is |
| `src/main/ipc/index.ts` | No change (Phase 1) | Continue saving flat `content` to database |

---

## Estimated Complexity

- **Type changes:** Trivial
- **ProcessManagerService refactor:** Moderate — the segment-building logic replaces existing buffer logic but must handle the same ACP event types
- **MessageBubbleComponent:** Moderate — template restructuring with fallback for old messages
- **SCSS:** Minor — existing tool-call and message-body styles are reusable
- **Risk:** Low — the change is additive (new `segments` field) with backward-compatible fallbacks
