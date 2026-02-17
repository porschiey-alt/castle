# Empty Agent Chat Bubble — Bug Diagnosis

## Diagnosis and Suggested Fix

### Symptoms

An empty chat bubble (showing only the avatar, agent name, and timestamp — no body
content) appears in the message list. This occurs:

- **During processing:** the streaming bubble renders even when there is no content,
  no tool calls, and no segments yet.
- **After processing:** the completed assistant message is saved and added to the
  messages list even when `content` is an empty string and no meaningful segments
  exist, producing a permanent empty bubble.

### Root Cause Analysis

The bug has two contributing locations.

#### 1. No guard on the streaming bubble in `message-list.component.html`

```html
<!-- message-list.component.html, line 15 -->
@if (streamingMessage(); as streaming) {
  <app-message-bubble
    [streamingContent]="streaming.content"
    [streamingToolCalls]="streaming.toolCalls"
    [streamingSegments]="streaming.segments"
    [isStreaming]="true"
    ...
  />
```

The streaming bubble is rendered whenever `streamingMessage()` is non-null. At the very
start of processing — before any content, tool calls, or segments arrive — the
`StreamingMessage` object exists (emitted on the first chunk or by `streamingStarted$`)
but all its fields are empty. The bubble renders with an avatar and header but nothing
in the body.

Within the bubble template, the **legacy path** (no segments) does handle this partially
with a processing shimmer at line 88–92:

```html
} @else if (isStreaming()) {
  <div class="processing-indicator">
    <div class="processing-shimmer"></div>
  </div>
```

But the **segments path** (line 21) has no such guard. When `hasSegments` is true but
all segments are tool-call-only with no text, the bubble renders tool-call items but
ends with an empty text area or just a blinking cursor. And if there's a text segment
with empty content, it renders an empty `<div class="message-body">` with no
protection:

```html
<!-- line 46-48: no check for empty segment.content -->
} @else {
  <div class="message-body">
    <div class="text-content" [innerHTML]="renderMarkdown(segment.content)"></div>
  </div>
}
```

#### 2. No guard on saved messages in the messages list or at save time

When the stream completes, the IPC handler in `src/main/ipc/index.ts` (line 153)
unconditionally saves the assistant message:

```typescript
const assistantMessage = await databaseService.saveMessage({
  agentId,
  conversationId,
  role: 'assistant',
  content: message.content,   // can be ''
  metadata: ...,
  timestamp: new Date()
});
```

Then `ChatService.streamComplete$` (line 134) adds it to the in-memory message list:

```typescript
this.addMessageIfNew(message.agentId, message);
```

And in the template, **every** message gets a bubble:

```html
@for (message of messages(); track trackByMessageId($index, message)) {
  <app-message-bubble [message]="message" ... />
}
```

There is no check for whether the message has any displayable content. The bubble always
renders the outer container with avatar + header. The body section's `@if (content)`
guard (line 80) prevents the text body from showing, and if there are no tool calls
either, the bubble is visually empty — just a header with whitespace.

#### Why it's visible "above" other bubbles

The empty saved message is appended to the `messages` array when the stream completes.
On the next turn (when the user sends another message and a new streaming response
begins), the empty bubble sits as the last historical message, directly above the new
streaming bubble — making it conspicuously empty at the boundary.

### Suggested Fix

Add guards at three levels: the message-bubble component (core defense), the
message-list template (streaming bubble), and the segments rendering path.

#### 1. Add an `isEmpty` computed property to `MessageBubbleComponent`

**File:** `src/app/features/chat/message-bubble/message-bubble.component.ts`

Add a getter that returns `true` when the bubble has absolutely nothing to display:

```typescript
/** True when the bubble has no displayable content at all */
get isEmpty(): boolean {
  if (this.isStreaming()) {
    // During streaming, empty until there's content, segments, or tool calls
    const hasContent = !!this.streamingContent()?.trim();
    const hasSegments = (this.streamingSegments() || []).length > 0;
    const hasToolCalls = (this.streamingToolCalls() || []).length > 0;
    return !hasContent && !hasSegments && !hasToolCalls;
  }
  // Historical message: empty if no text content, no segments, and no tool calls
  const msg = this.message();
  if (!msg) return true;
  const hasContent = !!msg.content?.trim();
  const hasSegments = (msg.metadata?.segments || []).length > 0;
  const hasToolCalls = (msg.metadata?.toolCalls || []).length > 0;
  return !hasContent && !hasSegments && !hasToolCalls;
}
```

#### 2. Wrap the entire bubble template in an `@if (!isEmpty)` guard

**File:** `src/app/features/chat/message-bubble/message-bubble.component.html`

```diff
+@if (!isEmpty) {
 <div class="message-bubble" [class.user]="isUser" [class.agent]="!isUser" [class.streaming]="isStreaming()" [class.processing]="isProcessing">
   <!-- Avatar -->
   <div class="avatar">
     ...
   </div>
   <!-- Message content -->
   <div class="message-content">
     ...
   </div>
 </div>
+}
```

This is the **core defense** — no matter how a message gets into the list, if it has
nothing to display, the bubble is simply not rendered.

#### 3. Guard empty text segments in the segments rendering path

**File:** `src/app/features/chat/message-bubble/message-bubble.component.html`

In the segments loop, skip text segments with empty/whitespace content:

```diff
     @if (segment.type === 'tool-calls') {
       ...
-    } @else {
+    } @else if (segment.content.trim()) {
       <div class="message-body">
         <div class="text-content" [innerHTML]="renderMarkdown(segment.content)" (click)="onContentClick($event)"></div>
       </div>
     }
```

#### 4. (Optional) Filter empty messages out of the list in `message-list.component.html`

For an additional layer of defense, filter in the template so empty messages don't even
attempt to render:

```diff
-@for (message of messages(); track trackByMessageId($index, message)) {
+@for (message of messages(); track trackByMessageId($index, message)) {
+  @if (message.content?.trim() || message.metadata?.segments?.length || message.metadata?.toolCalls?.length) {
     <app-message-bubble
       [message]="message"
       [agentName]="agentName()"
       [agentIcon]="agentIcon()"
     />
+  }
```

### Verification Steps

1. **During streaming (early phase):** Send a message and observe the initial moments
   before the agent produces any content or tool calls. Confirm no empty bubble appears;
   the bubble should only render once there is content, a tool call, or a segment.
2. **Tool-call-only response:** Trigger a response where the agent calls tools but
   produces no text content. Confirm the bubble renders tool calls (not empty), or
   hides entirely if there's truly nothing to display.
3. **Normal response:** Send a standard message. Confirm the bubble renders with full
   content as before — no regression.
4. **Historical messages:** Reload the conversation history. Confirm any previously
   saved empty messages do not render as empty bubbles.
5. **Segments with empty text:** If a saved message has segments containing a text
   segment with empty content, confirm that segment is skipped and no empty body div
   appears.
6. **Streaming completes:** After a response finishes, confirm no lingering empty
   bubble remains between the completed message and the next interaction.
