## Diagnosis and Suggested Fix

**Bug:** Conversations get confused — processing bubbles leak across conversations and
content disappears when the agent finishes.

---

### Symptoms

1. **Processing bubble bleeds across conversations.** When an agent is processing a
   response for conversation A, switching to conversation B (for the same agent) shows
   B's message history but keeps the streaming/processing bubble at the bottom — a
   bubble that belongs to conversation A.

2. **Conversation clears when agent finishes.** Upon stream completion the currently
   viewed conversation appears empty momentarily (or permanently), and the agent's
   final response may not appear in any conversation the user can see.

---

### Root Cause Analysis

There are two interacting architectural problems and one race condition.

#### 1. Chat state is keyed by `agentId`, not `conversationId`

`ChatService.chatStatesSignal` is a `Map<string, ChatState>` where the key is
**agentId** (`chat.service.ts:27`). Each `ChatState` bundles together:

- `messages` — the message list
- `streamingMessage` — the live streaming bubble
- `isLoading` — whether the agent is working
- `todoItems`, `latestThinking` — ancillary streaming state

Because there is only **one** `ChatState` per agent, all conversations for that agent
share the same `streamingMessage` and `isLoading` flag. When the user switches
conversations, `loadHistory()` correctly replaces `messages` with the new
conversation's history, but it **preserves** the existing `streamingMessage`,
`isLoading`, and related fields:

```typescript
// chat.service.ts:140-145
states.set(agentId, {
  ...currentState,   // ← streamingMessage, isLoading survive
  messages            // ← only messages are replaced
});
```

The template unconditionally renders the streaming bubble whenever
`streamingMessage()` is non-null (`message-list.component.html:16-42`), regardless of
which conversation the streaming actually belongs to.

#### 2. `StreamingMessage` has no `conversationId` field

The `StreamingMessage` interface (`message.types.ts:52-62`) carries `agentId` but no
`conversationId`. The backend's `emitOutput()` in `process-manager.service.ts:191-205`
constructs streaming chunks without any conversation context. This means the frontend
has **no way** to tell which conversation a streaming chunk belongs to, even if the
state model were fixed.

#### 3. Race condition: overlapping `loadHistory` calls on stream completion

When the agent finishes, the backend emits **both** `CHAT_STREAM_COMPLETE` and
`SYNC_CHAT_MESSAGE_ADDED` from the same `onComplete` callback (`ipc/index.ts:141-152`).
On the frontend this triggers two handlers:

1. `streamComplete$` → synchronously calls `addMessageIfNew()` (adds the assistant
   message in memory), then `clearStreamingMessage()`.
2. `chatMessageAdded$` → calls `loadHistory(agentId)` which is **async**.

Additionally, the `effect()` in `chat.component.ts:46-53` also calls `loadHistory()`
whenever `activeConversationId` changes (e.g. when a conversation was auto-created by
`sendMessage`).

Multiple overlapping `loadHistory()` calls can be in-flight simultaneously, each
reading `activeConversationId()` at call time and replacing the message array when the
DB query resolves. The **last to complete wins**, regardless of initiation order. If an
earlier `loadHistory()` (initiated before the message was saved to the DB) resolves
**after** a later one (which includes the new message), it overwrites the state with
stale data — causing messages to vanish.

**Concrete timeline:**

```
T0  sendMessage → createConversation → activeConversationId = X
T1  effect fires → loadHistory (call A) starts, reads convId=X, queries DB
T2  backend saves user message, agent starts processing
T3  agent finishes → streamComplete$ adds assistant msg to memory
T4  chatMessageAdded$ → loadHistory (call B) starts, reads convId=X, queries DB
T5  call B completes → messages = [user, assistant] ✓
T6  call A completes (stale query from T1) → messages = [] ← CLEARS
```

---

### Suggested Fix

The fix has two parts: scope the transient streaming state to a conversation, and
eliminate the overlapping-reload race.

#### Part A — Scope streaming state to a conversation

**A1. Add `conversationId` to `StreamingMessage`.**

```typescript
// shared/types/message.types.ts
export interface StreamingMessage {
  id: string;
  agentId: string;
  conversationId?: string;   // ← add
  content: string;
  // ...
}
```

Wire it through the backend: in `ipc/index.ts`, pass
`activeConversationIds.get(agentId)` into the session's output handler so it can be
included on every streaming chunk emitted by `process-manager.service.ts`.

**A2. Key transient state by `conversationId` (or filter on render).**

The simplest approach: keep `chatStatesSignal` keyed by `agentId` (since only one
session per agent), but when computing the exposed `streamingMessage` signal, **filter
out** chunks whose `conversationId` doesn't match the active conversation:

```typescript
// chat.service.ts
readonly streamingMessage = computed<StreamingMessage | null>(() => {
  const state = this.currentChatState();
  const streaming = state?.streamingMessage;
  if (!streaming) return null;
  const activeConvId = this.conversationService.activeConversationId();
  // Only show streaming for the active conversation (or if no conv yet)
  if (streaming.conversationId && activeConvId &&
      streaming.conversationId !== activeConvId) {
    return null;
  }
  return streaming;
});
```

Apply the same guard to `isLoading`, `todoItems`, and `latestThinking`.

#### Part B — Eliminate overlapping `loadHistory` race

**B1. Add a generation counter to `loadHistory`.**

Guard against stale async completions by incrementing a counter at the start of each
call and discarding results whose counter doesn't match:

```typescript
// chat.service.ts
private loadGeneration = 0;

async loadHistory(agentId: string): Promise<void> {
  const gen = ++this.loadGeneration;
  const conversationId = this.conversationService.activeConversationId();

  const messages = conversationId
    ? await this.electronService.getConversationMessages(conversationId)
    : [];

  // Discard if a newer loadHistory was initiated while we were loading
  if (gen !== this.loadGeneration) return;

  // ... set state
}
```

**B2. Skip the self-originating `chatMessageAdded$` reload.**

The `chatMessageAdded$` handler was intended for cross-device sync. For messages
originating from the current window, `streamComplete$` already adds the message to the
in-memory state, making the immediate reload redundant (and harmful due to the race).

Either:
- Have the backend tag messages with a `source` so the frontend can skip reloads for
  its own messages, **or**
- Remove the `chatMessageAdded$` → `loadHistory` call entirely and instead rely on
  `streamComplete$` to add assistant messages and `sendMessage` to add user messages
  (both already do this). Trigger a full reload only on a separate cross-device sync
  channel.

#### Part C — Harden backend `activeConversationIds` (optional but recommended)

Currently `activeConversationIds` (`ipc/index.ts:34`) is a mutable map set at send time
and read at completion time. If anything changes the mapping between send and complete
(e.g. a second message sent to a different conversation), the assistant reply would be
saved against the wrong conversation.

Fix: capture the `conversationId` at send time in a per-request closure rather than
reading from the shared map at completion time. Pass it into `subscribeToSession` or
stash it on the `SessionProcess` object itself.

---

### Verification Steps

1. **Processing bubble isolation:** Open two conversations for the same agent. Send a
   message in conversation A, then switch to conversation B while the agent is
   processing. Verify B shows its own history with **no** streaming bubble.

2. **Message delivery:** While viewing B (as above), wait for the agent to finish A.
   Switch back to A. Verify the complete assistant response appears in A.

3. **No clears on completion:** Send a message in conversation A and stay in A. Wait
   for the agent to finish. Verify the assistant response appears immediately without
   the conversation flashing empty.

4. **Rapid switching:** Send a message, then rapidly switch between conversations while
   the agent is processing. Verify no messages are lost and no conversations display
   stale or missing content.

5. **New-chat flow:** Click "New Chat," send a message. Verify the auto-created
   conversation shows both user and assistant messages after the agent finishes.

6. **Cross-device sync:** If multi-device support is testable, verify that messages sent
   from device A appear on device B without duplicating or clearing existing state.
