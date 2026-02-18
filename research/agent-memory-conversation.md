# Research: Agent Memory — Conversation Continuity Across App Restarts

## Executive Summary

When the Castle app is closed, the Copilot CLI child process is killed and the ACP session ends. When the app reopens, the user sees their full conversation history (loaded from the local SQLite database), but the agent has **no memory** of the prior conversation. The system already attempts ACP session resume via `unstable_resumeSession()` and `loadSession()`, but these frequently fail in practice — and when they fail, the code silently falls back to `newSession()` with no conversation context. There is no fallback mechanism to reconstruct the agent's memory from stored messages.

This document analyzes the problem, maps the current code paths, and proposes multiple approaches ranked by reliability.

---

## Problem Analysis

### The Core Disconnect

| Component | Has History? | Source |
|-----------|-------------|--------|
| **User (UI)** | ✅ Yes | SQLite `messages` table → loaded on conversation select |
| **Agent (LLM)** | ❌ No | ACP session is dead; new session has empty context |

The user sees all prior messages rendered in the chat view. The agent receives only the next new message with no prior context. When asked "do you remember what we talked about?", the agent correctly says no.

### Current Resume Architecture

The system already has a 3-tier resume strategy in `process-manager.service.ts` (lines 342-386):

```
1. unstable_resumeSession(sessionId)  — if canResumeSession capability
   ↓ fails
2. loadSession(sessionId)             — if canLoadSession capability
   ↓ fails
3. newSession()                       — always works, but no context
```

**Why resume fails:**
- **`unstable_resumeSession`** is experimental (`@experimental` in SDK docs) and requires the `session.resume` capability from the agent. Copilot CLI may not consistently support this, especially across app restarts where the underlying copilot process is a completely new instance.
- **`loadSession`** requires the `loadSession` capability. It instructs the agent to "restore the session context and conversation history" — but this depends on the agent having persisted its own session state server-side. A new copilot CLI process may not find the old session.
- Both rely on the **same session ID** being valid on the new copilot process, but since we spawn a fresh `copilot --acp --stdio` process each time, the old session ID may be meaningless to the new process.

### Additional Bug: Auto-Start in `CHAT_SEND_MESSAGE` Skips Resume

When a message triggers an auto-start (no existing session), the `CHAT_SEND_MESSAGE` handler at `ipc/index.ts` line 287 calls:

```typescript
const session = await processManagerService.startSession(agent, workingDirectory);
// ^^^ No acpSessionIdToResume passed!
```

This means if the user sends a message without first explicitly starting a session (which triggers `AGENTS_START_SESSION` with resume logic), the session is **always new** with no resume attempt.

In contrast, `AGENTS_START_SESSION` (line 130-137) properly looks up the `acpSessionId` from the database:

```typescript
let acpSessionIdToResume = resumeSessionId || undefined;
if (!acpSessionIdToResume) {
  const conversations = await databaseService.getConversations(agentId);
  const withSession = conversations.find(c => c.acpSessionId);
  if (withSession?.acpSessionId) {
    acpSessionIdToResume = withSession.acpSessionId;
  }
}
```

---

## Approach Analysis

### Approach 1: Fix the Auto-Start Resume Gap (Quick Win)

**What:** Ensure the `CHAT_SEND_MESSAGE` auto-start path also passes the `acpSessionId` for resume.

**Where:** `src/main/ipc/index.ts` line 287

**Change:**
```typescript
// Current (broken):
const session = await processManagerService.startSession(agent, workingDirectory);

// Fixed:
let acpSessionIdToResume: string | undefined;
if (conversationId) {
  const conv = await databaseService.getConversation(conversationId);
  acpSessionIdToResume = conv?.acpSessionId || undefined;
}
if (!acpSessionIdToResume) {
  const conversations = await databaseService.getConversations(agentId);
  const withSession = conversations.find(c => c.acpSessionId);
  acpSessionIdToResume = withSession?.acpSessionId || undefined;
}
const session = await processManagerService.startSession(agent, workingDirectory, acpSessionIdToResume);
```

**Limitation:** This only helps if `resumeSession`/`loadSession` actually succeeds — which they often don't across app restarts.

**Complexity:** Low (~10 lines changed)

---

### Approach 2: History Injection via System Prompt (Primary Recommendation)

**What:** When a session is new (not successfully resumed) and the conversation has prior messages, inject a summary of the conversation history as part of the first prompt.

**How it works:**
1. When `sendMessage()` is called and `systemPromptSent` is `false` (first message of a new session)
2. Check if the conversation has existing messages in the database
3. If yes, load them and format as a conversation history preamble
4. Prepend to the prompt blocks before the user's new message

**Where:** `src/main/services/process-manager.service.ts` `sendMessage()` method OR `src/main/ipc/index.ts` `CHAT_SEND_MESSAGE` handler

**Implementation — Option A: In the IPC handler (recommended)**

The IPC handler has access to both `databaseService` and `conversationId`, making it the natural place:

```typescript
// In CHAT_SEND_MESSAGE handler, before calling processManagerService.sendMessage()

// Check if this is a new session for a conversation with existing history
const sp = processManagerService.getSessionByAgentId(agentId);
const isNewSession = sp && !sp.systemPromptSent; // first message in session
if (isNewSession && conversationId) {
  const priorMessages = await databaseService.getMessagesByConversation(conversationId, 50);
  if (priorMessages.length > 0) {
    // Format history as context and prepend to the content
    const historyContext = formatConversationHistory(priorMessages);
    content = historyContext + '\n\n' + content;
  }
}
```

**Problem:** `systemPromptSent` is private to `SessionProcess`. The IPC layer cannot access it directly.

**Implementation — Option B: Add a method to ProcessManagerService**

Add a method like `isFirstMessage(agentId)` or pass history directly into `sendMessage`:

```typescript
// process-manager.service.ts
isFirstMessage(agentId: string): boolean {
  const sp = this.getSessionByAgentId(agentId);
  return sp ? !sp.systemPromptSent : false;
}
```

Or extend `sendMessage` signature:

```typescript
async sendMessage(sessionId: string, content: string, conversationHistory?: string): Promise<void> {
```

**Implementation — Option C: In ProcessManagerService `sendMessage()` directly**

Pass conversation history as an additional parameter and inject it alongside the system prompt:

```typescript
async sendMessage(sessionId: string, content: string, conversationHistory?: ChatMessage[]): Promise<void> {
  // ... existing code ...
  const promptBlocks: Array<{ type: 'text'; text: string }> = [];
  
  if (sessionProcess.systemPrompt && !sessionProcess.systemPromptSent) {
    promptBlocks.push({ type: 'text', text: sessionProcess.systemPrompt });
    sessionProcess.systemPromptSent = true;
  }
  
  // Inject conversation history on first message if session wasn't resumed
  if (conversationHistory && conversationHistory.length > 0 && !sessionProcess.historyInjected) {
    const formatted = this.formatHistory(conversationHistory);
    promptBlocks.push({ type: 'text', text: formatted });
    sessionProcess.historyInjected = true;
  }
  
  promptBlocks.push({ type: 'text', text: content });
  // ...
}
```

**History formatting function:**

```typescript
private formatHistory(messages: ChatMessage[]): string {
  const lines = messages.map(m => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    // Truncate very long messages to save tokens
    const content = m.content.length > 2000
      ? m.content.substring(0, 2000) + '... [truncated]'
      : m.content;
    return `${role}: ${content}`;
  });
  
  return [
    '<conversation_history>',
    'The following is the prior conversation history from a previous session.',
    'You should treat this as context you already know about, as if you had this conversation.',
    '',
    ...lines,
    '</conversation_history>'
  ].join('\n');
}
```

**IPC handler change:**

```typescript
// In CHAT_SEND_MESSAGE handler
let conversationHistory: ChatMessage[] | undefined;
if (conversationId) {
  // Only load history if the session is fresh (hasn't had messages yet)
  const sp = processManagerService.getSessionByAgentId(agentId);
  if (sp && processManagerService.isFirstMessage(agentId)) {
    const messages = await databaseService.getMessagesByConversation(conversationId, 50);
    // Exclude the message we just saved (the current user message)
    conversationHistory = messages.filter(m => m.id !== userMessage.id);
  }
}

processManagerService.sendMessage(sessionProcess.session.id, content, conversationHistory).catch(...);
```

**Pros:**
- Works regardless of whether ACP resume succeeds
- Uses data already in the database
- Agent gets real conversational context
- No dependency on external session persistence

**Cons:**
- Costs tokens (the history goes into the context window)
- Very long conversations may need truncation/summarization
- Agent might not perfectly recall nuances of prior tool calls

**Complexity:** Medium (~40-60 lines across 2 files)

---

### Approach 3: Track Resume Success and Conditionally Inject History

**What:** Combine Approaches 1 and 2. Track whether the ACP resume succeeded, and only inject history when it didn't.

**Where:** `process-manager.service.ts`

**How:**

Add a `sessionResumed` flag to `SessionProcess`:

```typescript
interface SessionProcess {
  // ... existing fields ...
  sessionResumed: boolean;  // true if resumeSession/loadSession succeeded
  historyInjected: boolean; // true if we've already injected history
}
```

Set it during `startSession()`:

```typescript
// After resume/load/new session logic
sessionProcess.sessionResumed = (acpSessionIdToResume !== undefined && acpSessionId === acpSessionIdToResume);
```

Expose it:

```typescript
wasSessionResumed(agentId: string): boolean {
  const sp = this.getSessionByAgentId(agentId);
  return sp?.sessionResumed ?? false;
}
```

In the IPC layer, only inject history if resume failed:

```typescript
if (!processManagerService.wasSessionResumed(agentId) && conversationId) {
  // Load and pass conversation history
}
```

**Pros:**
- Avoids redundant history injection when ACP resume works
- Best of both worlds

**Cons:**
- More complexity
- Need to test both paths

**Complexity:** Medium-High (~60-80 lines across 2 files)

---

### Approach 4: Conversation-Specific Session Routing

**What:** Currently the system finds ANY `acpSessionId` from any conversation for an agent. Instead, route to the specific conversation's session ID.

**Problem identified:** At `ipc/index.ts` line 133:
```typescript
const withSession = conversations.find(c => c.acpSessionId);
```
This picks the **first conversation with ANY session ID**, not the one the user is actually viewing. If the user is viewing Conversation B but Conversation A has a stored session ID, it resumes Conversation A's session — meaning the agent remembers the wrong conversation.

**Fix:** Pass the active `conversationId` to `AGENTS_START_SESSION` and look up its specific `acpSessionId`:

```typescript
// Frontend: pass conversationId when starting session
await this.electronService.startAgentSession(agentId, workingDirectory, conversationId);

// Backend: look up specific conversation's session ID
let acpSessionIdToResume = resumeSessionId || undefined;
if (!acpSessionIdToResume && conversationId) {
  const conv = await databaseService.getConversation(conversationId);
  acpSessionIdToResume = conv?.acpSessionId || undefined;
}
```

**Complexity:** Low-Medium (~15-20 lines across frontend + backend)

---

### Approach 5: Summarization for Long Conversations

**What:** Instead of injecting full history (which can exhaust the context window), generate a summary.

**How:** On the first message of a non-resumed session:
1. Load the last N messages
2. If the message count exceeds a threshold (e.g., 20), send a summarization request first
3. Use the summary as context instead of full history

**Implementation sketch:**
```typescript
if (messages.length > 20) {
  // Fork the session or use a separate prompt to generate summary
  const summary = await summarizeConversation(messages);
  historyContext = `Previous conversation summary:\n${summary}`;
} else {
  historyContext = formatFullHistory(messages);
}
```

**Complexity:** High (requires summarization pipeline, possibly a separate LLM call)

**Recommendation:** Defer this as a v2 enhancement. Start with simple truncation (e.g., last 30 messages, truncate long individual messages).

---

## Recommended Implementation Order

### Phase 1: Quick Fixes (Immediate)
1. **Fix auto-start resume gap** (Approach 1) — `CHAT_SEND_MESSAGE` handler should pass `acpSessionIdToResume`
2. **Fix conversation-specific routing** (Approach 4) — Use the active conversation's session ID, not any random one

### Phase 2: History Injection (Core Solution)
3. **Add `sessionResumed` and `historyInjected` flags** to `SessionProcess`
4. **Add `isFirstMessage()` and `wasSessionResumed()` methods** to `ProcessManagerService`
5. **Implement history injection** in `sendMessage()` — load prior messages from DB, format, and prepend on first message of a non-resumed session
6. **Add history formatting** with truncation for long conversations

### Phase 3: Polish (Future)
7. Add conversation summarization for very long histories
8. Consider clearing `acpSessionId` from conversations when app closes (since the session will likely be invalid anyway)
9. Add logging/telemetry to track how often resume succeeds vs. falls back

---

## Key Considerations & Edge Cases

### Token Budget
- The ACP `prompt` field accepts `Array<ContentBlock>`, each of type `text`, `image`, `resource`, etc.
- Injecting 30 messages of ~500 chars each = ~15,000 characters ≈ ~4,000 tokens
- This is well within typical context windows (128k+) but should be capped

### History Message Limit
- `getMessagesByConversation()` supports `limit` and `offset` parameters (default 100)
- Recommend loading last 30-50 messages for injection
- Individual messages should be truncated at ~2000 chars

### System Prompt Interaction
- System prompt is prepended on first message (`systemPromptSent` flag)
- History injection should happen AFTER system prompt, BEFORE user message:
  ```
  [system prompt] → [conversation history] → [current user message]
  ```

### Tool Call History
- Messages have `metadata.segments` and `metadata.toolCalls` stored in the DB
- For history injection, only the text content is critical — tool call details can be summarized or omitted
- Including tool call names (without full args) helps the agent understand what it previously did

### Race Conditions
- If the user sends a message before the session is ready, `sendMessage()` already waits via `waitForReady()`
- History injection on the first message is safe because `systemPromptSent` is checked synchronously within the same call

### Multiple Conversations per Agent
- An agent can have many conversations; only the active conversation's history should be injected
- The `conversationId` is already tracked via `activeConversationIds.get(agentId)` in the IPC layer

### What if Resume DOES Succeed?
- If `unstable_resumeSession` or `loadSession` succeeds, the agent already has context
- Injecting history would be redundant and could confuse the agent with duplicate context
- The `sessionResumed` flag (Approach 3) prevents this

---

## Relevant File References

| File | Purpose | Key Lines |
|------|---------|-----------|
| `src/main/services/process-manager.service.ts` | ACP session lifecycle, `sendMessage()` | L87-399 (startSession), L428-500 (sendMessage), L155-170 (SessionProcess) |
| `src/main/ipc/index.ts` | IPC handlers, auto-start logic | L109-143 (AGENTS_START_SESSION), L250-303 (CHAT_SEND_MESSAGE), L161-248 (subscribeToSession) |
| `src/main/services/database.service.ts` | Message persistence, history loading | L759-789 (getMessagesByConversation), L682-718 (getConversations) |
| `src/app/core/services/chat.service.ts` | Frontend chat state, message sending | L192-212 (loadHistory), L217-241 (sendMessage) |
| `src/app/core/services/agent.service.ts` | Agent selection, session auto-start | L82-105 (selectAgent), L110-120 (startSession) |
| `src/app/core/services/conversation.service.ts` | Conversation state management | activeConversationId signal |
| `src/app/core/services/electron.service.ts` | IPC bridge | L155-156 (startAgentSession) |
| `src/shared/types/conversation.types.ts` | Conversation type with acpSessionId | L8, L27 |
| `src/shared/types/message.types.ts` | ChatMessage, MessageRole types | MessageRole, ChatMessage interface |
| `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` | ACP SDK types | L258-313 (loadSession, resumeSession docs) |
| `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts` | Schema types | L1464-1495 (PromptRequest), L1727-1750 (ResumeSessionRequest) |

---

## Complexity Estimate

| Phase | Files Modified | Lines Changed | Risk |
|-------|---------------|---------------|------|
| Phase 1 (Quick Fixes) | 2 | ~25 | Low |
| Phase 2 (History Injection) | 2 | ~60-80 | Medium |
| Phase 3 (Summarization) | 2-3 | ~100+ | Higher |
| **Total (Phase 1+2)** | **2** | **~85-105** | **Medium** |
