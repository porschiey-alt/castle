# Diagnosis and Suggested Fix

## Bug: Selecting the Agent Combines the Chat

---

## Symptoms

When a user clicks an agent in the sidebar, the chat area displays **all messages from every conversation** for that agent, merged into a single combined view. The conversation panel on the left shows individual conversations, but none is highlighted as active. The user expects clicking an agent to show either the most recent conversation or the last conversation they were viewing — not every message the agent has ever exchanged.

---

## Root Cause Analysis

The bug is triggered by the following call chain:

### 1. Sidebar click calls `showChat()`

In `main-layout.component.html` (line 7), the sidebar's `agentSelected` event is bound to `showChat()`:

```html
<app-sidebar ... (agentSelected)="showChat()" />
```

### 2. `showChat()` clears the active conversation

In `main-layout.component.ts` (lines 233–242):

```typescript
showChat(): void {
  this.activeView = 'chat';
  this.closeSidebar();
  this.conversationService.clearActive();       // ← sets activeConversationId to null
  const agentId = this.agentService.selectedAgentId();
  if (agentId) {
    this.conversationService.loadConversations(agentId);
  }
}
```

`clearActive()` sets `activeConversationIdSignal` to `null`.

### 3. `loadHistory()` falls back to the "all messages" query

In `chat.service.ts` (lines 101–109), when `conversationId` is `null`, the code falls through to `getChatHistory(agentId)`:

```typescript
async loadHistory(agentId: string): Promise<void> {
  const conversationId = this.conversationService.activeConversationId();

  let messages: ChatMessage[];
  if (conversationId) {
    messages = await this.electronService.getConversationMessages(conversationId);
  } else {
    messages = await this.electronService.getChatHistory(agentId);  // ← ALL messages
  }
  ...
}
```

### 4. `getChatHistory` returns every message for the agent

In `database.service.ts` (lines 361–398), `getMessages()` queries:

```sql
SELECT ... FROM messages WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
```

This returns messages from **all conversations** for the agent, producing the "combined chat" view.

### 5. The `ChatComponent` effect triggers the reload

The `ChatComponent` constructor has an `effect()` that watches `activeConversationId()`. When `clearActive()` sets it to `null`, the effect fires and calls `loadHistory()` with no active conversation — hitting the same "all messages" fallback.

### Secondary issue: Single ACP session shared across conversations

In `ipc/index.ts` (lines 86–118), when an agent session starts, it looks for **any** conversation with an `acpSessionId` and resumes that single session. All conversations under an agent share one ACP process. Conversations are virtual groupings of messages in the database, not separate ACP sessions. This means:

- Switching between conversations doesn't switch the underlying ACP context
- The resume indicator (`sync` icon in conversation-list) can be misleading — only one session exists regardless of which conversation is selected
- Sending a message in conversation B still uses the same ACP session that was started for conversation A

---

## Suggested Fix

### Fix 1: Auto-select the most recent conversation when selecting an agent (immediate fix)

Replace `clearActive()` in `showChat()` with logic that selects the most recent conversation after loading them.

**File: `src/app/layout/main-layout.component.ts`**

Change `showChat()`:

```typescript
async showChat(): Promise<void> {
  this.activeView = 'chat';
  this.closeSidebar();

  const agentId = this.agentService.selectedAgentId();
  if (agentId) {
    await this.conversationService.loadConversations(agentId);
    // Auto-select the most recent conversation instead of clearing
    const conversations = this.conversationService.conversations();
    if (conversations.length > 0) {
      this.conversationService.selectConversation(conversations[0].id);
    } else {
      this.conversationService.clearActive();
    }
  }
}
```

Apply the same pattern in `goToAgent()`:

```typescript
async goToAgent(agentId: string): Promise<void> {
  this.agentService.selectAgent(agentId);
  await this.conversationService.loadConversations(agentId);
  const conversations = this.conversationService.conversations();
  if (conversations.length > 0) {
    this.conversationService.selectConversation(conversations[0].id);
  } else {
    this.conversationService.clearActive();
  }
  this.activeView = 'chat';
  this.closeSidebar();
}
```

### Fix 2: Remove the "all messages" fallback in `loadHistory()` (defense in depth)

The `getChatHistory()` fallback that returns all messages across conversations should not produce a combined view. Change `chat.service.ts`:

```typescript
async loadHistory(agentId: string): Promise<void> {
  const conversationId = this.conversationService.activeConversationId();

  let messages: ChatMessage[];
  if (conversationId) {
    messages = await this.electronService.getConversationMessages(conversationId);
  } else {
    // No conversation selected — show empty state instead of combined history
    messages = [];
  }
  ...
}
```

### Fix 3 (future): One ACP session per conversation

This is a larger architectural change. Each conversation should map to its own ACP session so that:

- Selecting a conversation resumes its specific ACP context
- New conversations create a fresh ACP session
- The resume indicator accurately reflects per-conversation state

This would require changes to:
- `agent.service.ts` — pass `acpSessionId` from the selected conversation when starting/switching sessions
- `ipc/index.ts` — support switching the active ACP session when the user changes conversations
- `process-manager.service.ts` — manage multiple ACP sessions per agent, or tear down and restart when switching
- `conversation.service.ts` — emit the `acpSessionId` of the selected conversation so the session layer can act on it

---

## Verification Steps

1. **Reproduce the bug**: Select an agent from the sidebar with multiple conversations. Confirm that the chat shows combined messages from all conversations.
2. **Apply Fix 1**: After the change, selecting an agent should auto-select the most recent conversation and display only its messages.
3. **Apply Fix 2**: If somehow no conversation is selected, the chat should show an empty state (or "New conversation" prompt), not a combined dump of all messages.
4. **Test new agent (no conversations)**: Selecting an agent with zero conversations should show the empty state and allow the user to start a new conversation by sending a message.
5. **Test conversation switching**: After selecting an agent, clicking different conversations in the conversation panel should load only that conversation's messages.
6. **Test the `goToAgent()` path**: From the Tasks view, clicking "Go to agent" should also land on the most recent conversation, not the combined view.
