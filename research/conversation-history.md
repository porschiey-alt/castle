# Research: Conversation History Persistence & Management

## Problem Statement

When the Castle app closes, all Copilot CLI agent sessions are terminated (child processes killed), and while chat messages are persisted to the SQLite database, there is no way to **resume a previous Copilot CLI session** with its full agent-side context. Additionally, the UI provides no way to **browse, select, or manage past conversations** — each agent has a single flat message history with no concept of distinct conversations or threads.

## Current Architecture Analysis

### What Already Works

| Layer | Behavior |
|-------|----------|
| **SQLite (main process)** | Messages are persisted in the `messages` table keyed by `agent_id`. They survive app restarts. |
| **Chat history IPC** | `CHAT_GET_HISTORY` loads messages from DB; `ChatComponent.loadHistory()` calls it on init. |
| **Message dedup** | Cross-device sync uses `addMessageIfNew()` to avoid duplicates. |

### What's Missing

1. **No conversation/thread concept** — All messages for an agent are lumped together in one flat list. There's no `conversation_id` column, no way to group messages into discrete conversations.
2. **No conversation list UI** — The sidebar shows agents, not conversations. Users can't browse or switch between past conversations.
3. **Agent session loss on close** — When the app closes, `ProcessManagerService.stopAllSessions()` kills all child processes. The Copilot CLI's server-side session context is destroyed. Reopening the app starts a fresh ACP session.
4. **No ACP session ID tracking** — The `acpSessionId` is stored in-memory only (`SessionProcess.acpSessionId`). It's never persisted to the database.
5. **No conversation titles** — There's no way to label or identify conversations beyond timestamps.

### Current Data Flow

```
User types message
  → ChatService.sendMessage()
    → ElectronService.sendMessage() [IPC]
      → IPC Handler: saves user message to DB, sends to ProcessManager
        → ProcessManager.sendMessage() via ACP prompt
          → Copilot CLI processes, streams chunks back
            → IPC broadcasts chunks → ChatService updates streaming state
              → On complete: saves assistant message to DB, updates UI
```

## Copilot CLI Session Capabilities

### CLI Flags (confirmed from `copilot --help`)

| Flag | Description |
|------|-------------|
| `--resume [sessionId]` | Resume from a previous session (by ID or picker) |
| `--continue` | Resume the most recent session |
| `--acp --stdio` | Current Castle mode — Agent Client Protocol over stdio |

**Key insight**: `--resume` can be passed alongside `--acp`, potentially allowing Castle to resume Copilot CLI sessions after restart.

### ACP SDK Session Methods (v0.14.1)

The `@agentclientprotocol/sdk` provides rich session management:

| Method | Stability | Capability Check | Description |
|--------|-----------|-----------------|-------------|
| `newSession(params)` | Stable | Always available | Create fresh session |
| `loadSession(params)` | Stable | `loadSession: true` | Restore session with full history replay via notifications |
| `unstable_resumeSession(params)` | Unstable | `session.resume` | Resume without history replay (lightweight) |
| `unstable_listSessions(params)` | Unstable | `session.list` | List existing sessions (supports cwd filter + pagination) |
| `unstable_forkSession(params)` | Unstable | `session.fork` | Fork a session for branching conversations |

#### Key Types

```typescript
// SessionInfo — returned by listSessions
type SessionInfo = {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
};

// LoadSessionRequest
type LoadSessionRequest = {
  sessionId: string;
  cwd: string;
  mcpServers: McpServer[];
};

// ResumeSessionRequest
type ResumeSessionRequest = {
  sessionId: string;
  cwd: string;
  mcpServers?: McpServer[];
};

// AgentCapabilities — advertised during initialize()
type AgentCapabilities = {
  loadSession?: boolean;
  sessionCapabilities?: {
    fork?: SessionForkCapabilities | null;
    list?: SessionListCapabilities | null;
    resume?: SessionResumeCapabilities | null;
  };
};
```

#### loadSession vs resumeSession

| Aspect | `loadSession` | `resumeSession` |
|--------|--------------|-----------------|
| History replay | ✅ Streams full conversation history via `session/update` notifications | ❌ No history replay |
| Use case | Full restore (show past messages) | Lightweight continue (Castle already has messages in DB) |
| Stability | Stable (part of ACP spec) | Unstable (experimental) |
| Best for Castle | When agent doesn't have local message history | When Castle already has messages in SQLite |

**Recommendation**: Use `resumeSession` when available (since Castle persists messages locally), fall back to `loadSession`, and finally fall back to `newSession`.

## Proposed Approach

### Phase 1: Conversation Data Model

#### 1a. New `conversations` Table

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  acp_session_id TEXT,           -- Copilot CLI's session ID for resume
  title TEXT,                     -- Auto-generated or user-edited
  working_directory TEXT,         -- cwd at time of conversation
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations(agent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);
```

#### 1b. Add `conversation_id` to Messages

```sql
ALTER TABLE messages ADD COLUMN conversation_id TEXT
  REFERENCES conversations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
```

Existing messages without a `conversation_id` would be migrated into a "Legacy" conversation per agent.

#### 1c. New Shared Types

```typescript
// src/shared/types/conversation.types.ts

export interface Conversation {
  id: string;
  agentId: string;
  acpSessionId?: string;
  title?: string;
  workingDirectory?: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount?: number;    // computed
  lastMessage?: string;     // preview, computed
}
```

### Phase 2: ACP Session Persistence & Resume

#### 2a. Store ACP Session IDs

When `newSession()` returns, persist the `acpSessionId` to the conversation record:

```typescript
// In IPC handler after session creation
const acpSession = await connection.newSession({ cwd, mcpServers });
await databaseService.updateConversation(conversationId, {
  acpSessionId: acpSession.sessionId
});
```

#### 2b. Capability Detection

After `connection.initialize()`, check what the agent supports:

```typescript
const initResult = await connection.initialize({
  protocolVersion: 1,
  clientInfo: { name: 'Castle', version: '0.1.0' }
});

const capabilities = {
  canLoadSession: initResult.agentCapabilities?.loadSession ?? false,
  canResumeSession: !!initResult.agentCapabilities?.sessionCapabilities?.resume,
  canListSessions: !!initResult.agentCapabilities?.sessionCapabilities?.list,
};
```

#### 2c. Session Resume Flow

```
App reopens → User selects agent → User selects conversation
  → ProcessManager spawns `copilot --acp --stdio`
    → ACP initialize()
      → Check capabilities
        → If resume supported AND acpSessionId stored:
            connection.unstable_resumeSession({ sessionId, cwd })
        → Else if loadSession supported AND acpSessionId stored:
            connection.loadSession({ sessionId, cwd, mcpServers })
        → Else:
            connection.newSession({ cwd, mcpServers })  // fresh start
```

#### 2d. CLI Resume Flag (Alternative/Complement)

The `copilot` CLI supports `--resume <sessionId>`. This could be passed at process spawn time:

```typescript
const args: string[] = ['--acp', '--stdio'];
if (acpSessionId) {
  args.push('--resume', acpSessionId);
}
const childProcess = spawn('copilot', args, { ... });
```

This may be simpler and more reliable than using ACP-level resume, since the CLI natively manages its session storage on disk. **This should be tested to confirm `--resume` works with `--acp`.**

### Phase 3: IPC & Service Layer

#### 3a. New IPC Channels

```typescript
// Add to IPC_CHANNELS
CONVERSATIONS_GET_ALL: 'conversations:getAll',
CONVERSATIONS_GET: 'conversations:get',
CONVERSATIONS_CREATE: 'conversations:create',
CONVERSATIONS_UPDATE: 'conversations:update',
CONVERSATIONS_DELETE: 'conversations:delete',
CONVERSATIONS_GET_MESSAGES: 'conversations:getMessages',
```

#### 3b. New ConversationService (Angular)

```typescript
@Injectable({ providedIn: 'root' })
export class ConversationService {
  // Signals
  conversations = signal<Conversation[]>([]);
  activeConversationId = signal<string | null>(null);
  
  // Load conversations for an agent
  async loadConversations(agentId: string): Promise<void>;
  
  // Create a new conversation (called on first message or explicit "New Chat")
  async createConversation(agentId: string): Promise<Conversation>;
  
  // Switch active conversation
  async selectConversation(conversationId: string): Promise<void>;
  
  // Delete a conversation
  async deleteConversation(conversationId: string): Promise<void>;
  
  // Rename a conversation
  async renameConversation(id: string, title: string): Promise<void>;
}
```

#### 3c. Modify ChatService

- `loadHistory()` takes a `conversationId` instead of just `agentId`
- `sendMessage()` associates messages with the active conversation
- Auto-creates a conversation on first message if none exists

### Phase 4: UI — Conversation List

#### 4a. Conversation List Panel

A new panel (sliding drawer or channel list) between the sidebar agent circles and the chat area, similar to Discord's channel list pattern:

```
┌────┬──────────────────┬────────────────────────────┐
│    │ Conversations    │ Chat                       │
│ 🤖 │ ────────────────│ ─────────────────────────  │
│ 🧪 │ ▸ Fix auth bug  │ [messages...]              │
│ 📝 │   Yesterday     │                            │
│    │ ▸ Add login page│                            │
│    │   2 days ago    │                            │
│    │                 │                            │
│    │ [+ New Chat]    │                            │
└────┴──────────────────┴────────────────────────────┘
```

**Location**: Between sidebar and chat, or as a collapsible panel inside the chat area when an agent is selected.

#### 4b. Conversation List Item

Each item shows:
- Title (auto-generated from first message or agent-provided `session_info_update`)
- Last activity timestamp
- Message count badge
- Resume indicator (✓ if ACP session can be resumed)

#### 4c. "New Chat" Button

- Creates a new conversation with a fresh ACP session
- Becomes the active conversation
- First user message auto-generates a title (first ~50 chars of the message, or from ACP `SessionInfoUpdate.title`)

#### 4d. Conversation Context Menu

- Rename
- Delete
- Resume session (explicit trigger)

### Phase 5: Auto-Title Generation

The ACP protocol sends `session_info_update` notifications with a `title` field. Castle should:

1. Listen for `session_info_update` in the `sessionUpdate` handler
2. Update the conversation title in the database
3. Fall back to the first user message (truncated) if no title is provided

```typescript
if (update.sessionUpdate === 'session_info_update') {
  if (update.title) {
    await databaseService.updateConversation(conversationId, {
      title: update.title
    });
  }
}
```

## Database Migration Strategy

```sql
-- Step 1: Create conversations table
CREATE TABLE IF NOT EXISTS conversations (...);

-- Step 2: Add conversation_id column to messages
ALTER TABLE messages ADD COLUMN conversation_id TEXT;

-- Step 3: Migrate existing messages into legacy conversations
INSERT INTO conversations (id, agent_id, title, created_at, updated_at)
  SELECT 
    'legacy-' || agent_id,
    agent_id,
    'Previous conversation',
    MIN(created_at),
    MAX(created_at)
  FROM messages
  GROUP BY agent_id;

-- Step 4: Link existing messages to their legacy conversation
UPDATE messages SET conversation_id = 'legacy-' || agent_id
  WHERE conversation_id IS NULL;

-- Step 5: Create index
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
```

## Considerations & Risks

### ACP Session Resume Reliability

- **Copilot CLI stores sessions on disk** (in `~/.copilot/` or similar). Session resume depends on these files existing.
- **The `--resume` flag with `--acp` is undocumented** — needs testing to confirm it works in ACP mode.
- **`unstable_resumeSession` and `unstable_listSessions` are experimental** — they could change or be removed in future ACP SDK versions.
- **Fallback is essential** — Always be prepared to fall back to `newSession()` if resume fails.

### Session Expiry

- Copilot CLI sessions may expire or be cleaned up after some time
- Castle should handle resume failures gracefully (show "session expired" and offer to start fresh)
- Consider storing a `session_expires_at` or checking session validity before attempting resume

### Data Consistency

- Messages are stored in Castle's SQLite; agent-side context lives in Copilot CLI's session storage
- If Castle's DB is cleared but CLI sessions exist (or vice versa), there's a mismatch
- Design should be resilient: worst case is starting a fresh session with local message display

### Performance

- Conversation list queries need to be efficient (indexed by `agent_id`, `updated_at`)
- `loadSession` replays entire history — for long conversations this could be slow
- Prefer `resumeSession` when Castle already has messages locally

### Multi-Device Sync

- The existing `EventBroadcaster` / WebSocket bridge pattern extends naturally
- Add `SYNC_CONVERSATIONS_CHANGED` push event
- Conversation creation/deletion should broadcast to connected devices

## Implementation Guidance

### Recommended Order

1. **Database migration** — Add `conversations` table, `conversation_id` column, migrate existing data
2. **DatabaseService methods** — CRUD for conversations, update `getMessages` to filter by conversation
3. **IPC channels** — Register conversation handlers
4. **ConversationService (Angular)** — Signals, load/create/select/delete
5. **Update ChatService** — Wire conversation context into message operations
6. **Conversation list UI** — New component between sidebar and chat
7. **ACP session ID persistence** — Store acpSessionId in conversation record
8. **Session resume logic** — Capability detection + resume/load/new fallback chain
9. **Auto-title** — Listen for `session_info_update`, fallback to first message
10. **Polish** — Context menus, keyboard shortcuts, animations

### Testing Strategy

- Unit test: DatabaseService conversation CRUD
- Unit test: Migration creates legacy conversations correctly
- Integration test: `copilot --acp --stdio --resume <id>` works
- E2E test: Create conversation → close app → reopen → resume → verify context continuity
- Edge case: Resume fails → falls back to new session gracefully

### Files to Modify

| File | Changes |
|------|---------|
| `src/shared/types/conversation.types.ts` | **New** — Conversation interface |
| `src/shared/types/ipc.types.ts` | Add conversation IPC channels |
| `src/shared/types/message.types.ts` | Add optional `conversationId` to ChatMessage |
| `src/shared/types/index.ts` | Re-export conversation types |
| `src/main/services/database.service.ts` | Conversations table, migration, CRUD methods |
| `src/main/ipc/index.ts` | Register conversation IPC handlers |
| `src/main/services/process-manager.service.ts` | Store/use acpSessionId, resume logic |
| `src/preload/index.ts` | Expose conversation IPC methods |
| `src/app/core/services/conversation.service.ts` | **New** — Angular service |
| `src/app/core/services/chat.service.ts` | Filter by conversation, auto-create conversation |
| `src/app/core/services/electron.service.ts` | Add conversation API methods |
| `src/app/features/chat/conversation-list/` | **New** — Conversation list component |
| `src/app/features/chat/chat.component.ts` | Wire in conversation context |
| `src/app/features/sidebar/sidebar.component.*` | Possibly adjust layout |
| `src/app/layout/main-layout.component.*` | Add conversation panel slot |

### Estimated Scope

- **Small/Medium complexity** — The existing architecture (IPC pattern, SQLite, Angular signals) directly supports this feature
- **Biggest risk** — ACP resume reliability; mitigated by graceful fallback
- **Biggest effort** — UI for conversation list and wiring it into existing chat flow
