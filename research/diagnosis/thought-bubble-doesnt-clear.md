# Thought Bubble Doesn't Clear — Bug Diagnosis

## Diagnosis and Suggested Fix

### Symptoms

The thought bubble is supposed to clear its text and start fresh whenever new thinking
arrives after a tool call or content chunk. Instead, it accumulates all thinking text
from the entire turn, growing indefinitely. The bubble never resets between thinking
→ tool-call → thinking cycles.

### Root Cause Analysis

The bug is in `src/app/core/services/chat.service.ts`, in the `updateStreamingMessage`
method (lines 267–305).

#### The intended design

The desired lifecycle is:

1. Thinking chunks arrive → text accumulates in the bubble.
2. A tool call (or content chunk) arrives → the bubble should be marked "ready to
   replace."
3. New thinking arrives → if the bubble is marked "ready to replace," clear the old
   text and start fresh with the new thinking.

#### What actually happens

The code tries to detect a "non-thinking gap" by comparing the **current** chunk's
`contentLength` and `toolCallsCount` against `previousContentLength` and
`previousToolCallsCount`:

```typescript
if (hasNewThinking) {
  const contentChanged = contentLength !== currentState.previousContentLength;
  const toolCallsChanged = toolCallsCount !== currentState.previousToolCallsCount;
  const hadNonThinkingGap = contentChanged || toolCallsChanged;

  if (hadNonThinkingGap) {
    // New thinking block after tool calls / content — start fresh
    accumulatedThinking = fullThinking.substring(prevLen);
  } else {
    accumulatedThinking += fullThinking.substring(prevLen);
  }
}
```

The problem: `previousContentLength` and `previousToolCallsCount` are updated on
**every** chunk, not just on chunks that contain new thinking. Here is the chronological
trace:

| Step | Event | `thinkingLen` | `toolCallsCount` | `prevToolCallsCount` (saved) | `hasNewThinking` | Gap detected? |
|------|-------|---------------|-------------------|-------------------------------|------------------|---------------|
| 1 | Thinking chunk | 50 | 0 | 0→0 | ✅ | N/A (no gap expected) |
| 2 | Tool call starts | 50 | 1 | 0→**1** | ❌ | — (skipped, no new thinking) |
| 3 | Tool call update | 50 | 1 | 1→**1** | ❌ | — (skipped) |
| 4 | **New thinking** | 80 | 1 | **1**→1 | ✅ | ❌ `1 === 1` — **no gap detected!** |

At step 2, when the tool call arrives, `previousToolCallsCount` is updated from 0 to 1.
By step 4, when new thinking finally arrives and the `if (hasNewThinking)` block
executes, `toolCallsCount` (1) equals `previousToolCallsCount` (1). The code sees no
change. The gap is **invisible** because the intermediate non-thinking chunks already
updated the "previous" counters.

The same race applies to `previousContentLength` — content chunks update it
immediately, so by the time the next thinking chunk arrives, the values already match.

#### Why it occasionally works

If a tool call arrives in the **same** chunk as new thinking (a rare timing
coincidence), the comparison happens before `previousToolCallsCount` is updated, so
the gap is detected and the bubble clears. This is unpredictable.

### Suggested Fix

Add an explicit `readyToReplace` flag to `ChatState` that is set when a non-thinking
event arrives (tool call or content change) while there is existing accumulated
thinking. When new thinking arrives and the flag is set, clear the bubble and reset
the flag.

#### 1. Add the flag to `ChatState`

**File:** `src/app/core/services/chat.service.ts`

```diff
 interface ChatState {
   messages: ChatMessage[];
   streamingMessage: StreamingMessage | null;
   streamingConversationId: string | null;
   isLoading: boolean;
   todoItems: TodoItem[];
   accumulatedThinking: string;
   previousThinkingLength: number;
   previousContentLength: number;
   previousToolCallsCount: number;
+  /** Set when a tool-call or content chunk arrives after thinking; next thinking block will clear the bubble */
+  thinkingReadyToReplace: boolean;
 }
```

#### 2. Initialize it in `defaultChatState()`

```diff
 function defaultChatState(): ChatState {
   return {
     messages: [],
     streamingMessage: null,
     streamingConversationId: null,
     isLoading: false,
     todoItems: [],
     accumulatedThinking: '',
     previousThinkingLength: 0,
     previousContentLength: 0,
-    previousToolCallsCount: 0
+    previousToolCallsCount: 0,
+    thinkingReadyToReplace: false
   };
 }
```

#### 3. Rewrite the gap-detection logic in `updateStreamingMessage()`

```diff
 private updateStreamingMessage(agentId: string, message: StreamingMessage): void {
   const states = new Map(this.chatStatesSignal());
   const currentState = states.get(agentId) || defaultChatState();

   const fullThinking = message.thinking || '';
   const contentLength = message.content?.length || 0;
   const toolCallsCount = message.toolCalls?.length || 0;

   const prevLen = currentState.previousThinkingLength;
   const hasNewThinking = fullThinking.length > prevLen;

+  const contentChanged = contentLength !== currentState.previousContentLength;
+  const toolCallsChanged = toolCallsCount !== currentState.previousToolCallsCount;
+
+  // Mark ready-to-replace when a non-thinking event occurs while we have thinking text
+  let readyToReplace = currentState.thinkingReadyToReplace;
+  if (!hasNewThinking && (contentChanged || toolCallsChanged) && currentState.accumulatedThinking) {
+    readyToReplace = true;
+  }
+
   let accumulatedThinking = currentState.accumulatedThinking;

   if (hasNewThinking) {
-    const contentChanged = contentLength !== currentState.previousContentLength;
-    const toolCallsChanged = toolCallsCount !== currentState.previousToolCallsCount;
-    const hadNonThinkingGap = contentChanged || toolCallsChanged;
-
-    if (hadNonThinkingGap) {
+    if (readyToReplace) {
       // New thinking block after tool calls / content — start fresh
       accumulatedThinking = fullThinking.substring(prevLen);
+      readyToReplace = false;
     } else {
       accumulatedThinking += fullThinking.substring(prevLen);
     }
   }

   states.set(agentId, {
     ...currentState,
     streamingMessage: message,
     accumulatedThinking,
     previousThinkingLength: fullThinking.length,
     previousContentLength: contentLength,
-    previousToolCallsCount: toolCallsCount
+    previousToolCallsCount: toolCallsCount,
+    thinkingReadyToReplace: readyToReplace
   });

   this.chatStatesSignal.set(states);
 }
```

#### 4. Reset the flag in `clearStreamingMessage()`

```diff
 private clearStreamingMessage(agentId: string): void {
   // ... existing code ...
   states.set(agentId, {
     ...currentState,
     streamingMessage: null,
     streamingConversationId: null,
     accumulatedThinking: '',
     previousThinkingLength: 0,
     previousContentLength: 0,
-    previousToolCallsCount: 0
+    previousToolCallsCount: 0,
+    thinkingReadyToReplace: false
   });
 }
```

#### Why this fixes the problem

The new `thinkingReadyToReplace` flag **decouples detection from consumption**:

| Step | Event | Flag action | Bubble state |
|------|-------|-------------|--------------|
| 1 | Thinking chunk | flag stays `false` | Text accumulates |
| 2 | Tool call arrives | flag set to `true` | Text unchanged (still visible) |
| 3 | Tool call update | flag stays `true` | Text unchanged |
| 4 | New thinking | flag is `true` → **clear** bubble, reset flag to `false` | Fresh text |
| 5 | More thinking | flag is `false` | Text accumulates |

The flag survives across any number of intermediate non-thinking chunks, ensuring the
clear always happens on the next thinking block regardless of timing.

### Verification Steps

1. **Basic cycle:** Send a message that triggers thinking → tool call → more thinking.
   Confirm the thought bubble clears its text when the second thinking block begins
   (after the tool call).
2. **Multiple tool calls:** Send a message that triggers thinking → tool call A →
   tool call B → more thinking. Confirm the bubble still clears on the new thinking,
   even though multiple tool-call events occurred in the gap.
3. **Content then thinking:** Send a message that triggers thinking → content chunk →
   more thinking. Confirm the bubble clears (content chunks also set the flag).
4. **Continuous thinking:** Send a message that triggers uninterrupted thinking (no
   tool calls). Confirm the bubble accumulates text normally without clearing.
5. **Rapid cycling:** Send a complex message that triggers multiple thinking → tool →
   thinking cycles in quick succession. Confirm each cycle clears and restarts properly.
6. **Stream completion:** Confirm the bubble disappears entirely when the stream
   completes (the `clearStreamingMessage` resets everything).
