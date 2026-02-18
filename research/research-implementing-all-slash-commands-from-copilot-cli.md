# Research: Implementing Slash Commands from Copilot CLI

## Executive Summary

The Copilot CLI provides **40+ interactive slash commands** (e.g., `/compact`, `/model`, `/clear`, `/plan`, `/review`, `/context`, `/diff`), but none of these are accessible when using Copilot through ACP (Agent Client Protocol) mode — which is how Castle communicates with it. The ACP protocol instead provides **programmatic equivalents** for some of these via methods like `setSessionMode()`, `setSessionConfigOption()`, `unstable_setSessionModel()`, and `prompt()` with command-style content.

This document proposes building a **slash command engine** in Castle that:
1. Intercepts `/command` messages before they reach the agent
2. Routes them to appropriate handlers — some call ACP methods, some execute locally in Castle
3. Supports Castle-specific custom commands alongside Copilot equivalents
4. Provides autocomplete/suggestions in the chat input

---

## Copilot CLI Slash Commands — Full Inventory

The following commands are available in Copilot CLI interactive mode (`copilot help commands`):

### ACP-Mappable Commands (have programmatic ACP equivalents)

| CLI Command | ACP Equivalent | Notes |
|-------------|---------------|-------|
| `/model [model]` | `connection.unstable_setSessionModel()` | Switch model mid-session |
| `/compact` | `connection.prompt()` with compact instruction | Summarize history to reduce context (could also be ACP session config) |
| `/clear`, `/new` | Kill session + `connection.newSession()` | Clear history = start fresh session |
| `/plan [prompt]` | `connection.setSessionMode({ modeId: 'plan' })` or prompt with plan instructions | Plan mode |
| `/review [prompt]` | `connection.setSessionMode({ modeId: 'review' })` or prompt | Code review mode |
| `/context` | Read from `UsageUpdate` session updates | Show token usage — ACP streams `usage_update` |
| `/agent` | Agent selection in Castle UI | Already handled by Castle's agent picker |
| `/diff` | `gitWorktreeService.getDiff()` | Already available in Castle |
| `/cwd`, `/cd` | `directoryService.setCurrentDirectory()` | Already available in Castle |
| `/rename <name>` | `connection.prompt()` or local DB update | Rename session/conversation |
| `/resume [id]` | `connection.unstable_resumeSession()` | Session resume — Castle already attempts this |
| `/share [file\|gist]` | Local file export | Could implement as conversation export |

### Castle-Local Commands (no ACP needed)

| CLI Command | Castle Implementation | Notes |
|-------------|----------------------|-------|
| `/exit`, `/quit` | N/A — Castle is a desktop app | Not applicable |
| `/login`, `/logout` | `gh auth login/logout` | Uses gh CLI |
| `/feedback` | Open URL | Link to feedback form |
| `/help` | Show command list | Local display |
| `/theme` | Castle theme settings | Already has theme system |
| `/init` | Already handled by agent discovery | AGENTS.md etc. |
| `/instructions` | Show agent system prompt | Display/edit agent config |

### ACP-Adjacent Commands (use ACP protocol features)

| CLI Command | ACP Feature | Status |
|-------------|------------|--------|
| `/fleet [prompt]` | Not in ACP spec | Copilot-specific parallel agents |
| `/mcp` | `mcpServers` param in newSession | MCP server management |
| `/skills` | Not in ACP spec | Copilot-specific |
| `/plugin` | Not in ACP spec | Copilot-specific |
| `/lsp` | Not in ACP spec | Copilot-specific |
| `/tasks` | Not in ACP spec (Castle has its own task system) | Different concept |
| `/experimental` | Not in ACP spec | Copilot-specific |
| `/usage` | `UsageUpdate` session notification | Token/cost metrics |
| `/session` | Session metadata | Could use stored session info |
| `/streamer-mode` | N/A | UI preference |

### Not Applicable in Castle Context

| CLI Command | Reason |
|-------------|--------|
| `/add-dir` | Castle manages working directory |
| `/list-dirs` | Castle manages working directory |
| `/terminal-setup` | Not a terminal app |
| `/changelog` | CLI-specific |
| `/allow-all`, `/yolo` | Castle uses permission dialog system |
| `/reset-allowed-tools` | Castle uses permission grant system |
| `/alt-screen` | Terminal-specific |
| `/user` | GitHub user management via gh CLI |

---

## ACP Protocol Capabilities Analysis

### What Castle Currently Captures

From `process-manager.service.ts` (lines 319-399):

```typescript
// Capabilities captured (line 329-333):
sessionProcess.capabilities = {
  canLoadSession: agentCaps?.loadSession ?? false,
  canResumeSession: !!agentCaps?.sessionCapabilities?.resume,
  canListSessions: !!agentCaps?.sessionCapabilities?.list,
};
```

### What Castle Currently IGNORES

The `newSession()` response contains rich data that Castle discards:

```typescript
// NewSessionResponse type (SDK schema):
{
  sessionId: SessionId;
  modes?: SessionModeState;        // ← IGNORED: availableModes + currentModeId
  configOptions?: SessionConfigOption[];  // ← IGNORED: mode, model, thought_level configs
  models?: SessionModelState;      // ← IGNORED: availableModels + currentModelId
}
```

### ACP Session Update Types Castle Doesn't Handle

The `sessionUpdate` callback in `process-manager.service.ts` (lines 211-313) handles:
- ✅ `agent_message_chunk`
- ✅ `agent_thought_chunk`
- ✅ `tool_call` / `tool_call_update`
- ✅ `plan`
- ✅ `session_info_update`
- ❌ `available_commands_update` — **ACP can advertise available commands!**
- ❌ `current_mode_update` — Mode change notifications
- ❌ `config_option_update` — Config change notifications
- ❌ `usage_update` — Token usage/cost data

### Key ACP SDK Types for Commands

```typescript
// AvailableCommand — ACP agents can advertise commands:
type AvailableCommand = {
  name: string;           // e.g., "create_plan", "research_codebase"
  description: string;    // Human-readable description
  input?: AvailableCommandInput;  // Optional input specification
};

// AvailableCommandsUpdate — Agent sends these during sessions:
type AvailableCommandsUpdate = {
  availableCommands: AvailableCommand[];
};

// SessionMode — Available agent modes:
type SessionMode = {
  id: SessionModeId;
  name: string;
  description?: string;
};

// SessionConfigOption — Config options like model, thought_level:
type SessionConfigOption = {
  type: "select";
  id: SessionConfigId;
  name: string;
  description?: string;
  category?: "mode" | "model" | "thought_level" | string;
};
```

---

## Proposed Architecture

### Slash Command Engine Design

```
┌──────────────────────────────────────────────────────────────┐
│                        Frontend                               │
│                                                               │
│  ┌─────────────────┐    ┌──────────────────────────────────┐ │
│  │  ChatInput       │───▶│  SlashCommandService (frontend)  │ │
│  │  (intercepts /)  │    │  - Parse /command arg            │ │
│  │  (autocomplete)  │    │  - Route to handler              │ │
│  └─────────────────┘    │  - Show suggestions               │ │
│                          │  - Execute local commands         │ │
│                          │  - Forward ACP commands via IPC   │ │
│                          └──────────────┬───────────────────┘ │
└─────────────────────────────────────────┼─────────────────────┘
                                          │ IPC
┌─────────────────────────────────────────┼─────────────────────┐
│                     Main Process         │                     │
│                                          │                     │
│  ┌───────────────────────────────────────┴──────────────────┐ │
│  │              IPC Handlers                                 │ │
│  │  SLASH_EXECUTE: route to ProcessManagerService methods    │ │
│  └───────────────────────┬──────────────────────────────────┘ │
│                          │                                     │
│  ┌───────────────────────┴──────────────────────────────────┐ │
│  │          ProcessManagerService                            │ │
│  │  - setMode(agentId, modeId)                              │ │
│  │  - setModel(agentId, modelId)                            │ │
│  │  - setConfigOption(agentId, configId, value)             │ │
│  │  - getSessionInfo(agentId) → modes, models, usage       │ │
│  │  - resetSession(agentId) → kill + newSession             │ │
│  │  - compactSession(agentId) → special prompt              │ │
│  └──────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

### Command Categories

```typescript
type CommandCategory = 'local' | 'acp' | 'hybrid';

interface SlashCommand {
  name: string;           // e.g., "model", "clear", "help"
  aliases?: string[];     // e.g., ["new"] for "clear"
  description: string;
  category: CommandCategory;
  args?: CommandArgDef;
  handler: (args: string, context: CommandContext) => Promise<CommandResult>;
}

interface CommandArgDef {
  name: string;
  required: boolean;
  completions?: () => string[] | Promise<string[]>;  // For autocomplete
}

interface CommandContext {
  agentId: string;
  conversationId: string | null;
  sessionId: string | null;
}

interface CommandResult {
  type: 'message' | 'action' | 'error';
  content?: string;        // Display text
  action?: string;         // Action to take (e.g., 'navigate', 'refresh')
}
```

---

## Implementation Plan

### Phase 1: Command Engine Core + Local Commands

**Files to create:**
- `src/app/core/services/slash-command.service.ts` — Frontend command registry, parser, and router
- `src/shared/types/slash-command.types.ts` — Shared command type definitions

**Changes to existing files:**
- `src/app/features/chat/chat-input/chat-input.component.ts` — Intercept `/` messages before sending
- `src/app/features/chat/chat.component.ts` — Route commands through SlashCommandService

**Commands in Phase 1:**

| Command | Implementation |
|---------|---------------|
| `/help` | Show all available commands (local display, no message sent) |
| `/clear` | Clear conversation history + create new session (IPC calls) |
| `/new` | Alias for `/clear` |
| `/diff` | Call `electronService.getWorktreeDiff()` and display in chat |
| `/rename <name>` | Call `conversationService.renameConversation()` |

**Implementation details:**

```typescript
// slash-command.service.ts
@Injectable({ providedIn: 'root' })
export class SlashCommandService {
  private commands = new Map<string, SlashCommand>();

  constructor(
    private chatService: ChatService,
    private conversationService: ConversationService,
    private agentService: AgentService,
    private electronService: ElectronService,
  ) {
    this.registerBuiltinCommands();
  }

  /** Check if a message is a slash command */
  isCommand(message: string): boolean {
    return message.startsWith('/') && !message.startsWith('/ ');
  }

  /** Parse command name and arguments from a message */
  parse(message: string): { command: string; args: string } | null {
    const match = message.match(/^\/(\S+)\s*(.*)/);
    if (!match) return null;
    return { command: match[1].toLowerCase(), args: match[2].trim() };
  }

  /** Execute a slash command. Returns true if handled, false to send as regular message. */
  async execute(message: string, context: CommandContext): Promise<CommandResult | null> {
    const parsed = this.parse(message);
    if (!parsed) return null;

    const cmd = this.commands.get(parsed.command)
      || [...this.commands.values()].find(c => c.aliases?.includes(parsed.command));
    if (!cmd) return { type: 'error', content: `Unknown command: /${parsed.command}. Type /help for available commands.` };

    return cmd.handler(parsed.args, context);
  }

  /** Get command suggestions for autocomplete */
  getSuggestions(partial: string): SlashCommand[] {
    const query = partial.replace(/^\//, '').toLowerCase();
    return [...this.commands.values()].filter(c =>
      c.name.startsWith(query) || c.aliases?.some(a => a.startsWith(query))
    );
  }
}
```

**Chat input interception:**

```typescript
// chat.component.ts — modify onSendMessage:
async onSendMessage(content: string): Promise<void> {
  const agentId = this.agent().id;

  // Check for slash commands
  if (this.slashCommandService.isCommand(content)) {
    const context = {
      agentId,
      conversationId: this.conversationService.activeConversationId(),
      sessionId: null, // will be resolved in handler
    };
    const result = await this.slashCommandService.execute(content, context);
    if (result) {
      // Display result as a system message in the chat
      this.displaySystemMessage(result);
      return;
    }
  }

  // Normal message flow
  await this.chatService.sendMessage(agentId, content);
}
```

### Phase 2: ACP Session Commands

**New methods in `ProcessManagerService`:**

```typescript
// process-manager.service.ts — new methods:

/** Get available modes for an agent's session */
getAvailableModes(agentId: string): SessionMode[] {
  return this.getSessionByAgentId(agentId)?.modes?.availableModes || [];
}

/** Switch session mode */
async setMode(agentId: string, modeId: string): Promise<void> {
  const sp = this.getSessionByAgentId(agentId);
  if (!sp?.connection || !sp.acpSessionId) throw new Error('No active session');
  await sp.connection.setSessionMode({ sessionId: sp.acpSessionId, modeId });
}

/** Switch model */
async setModel(agentId: string, modelId: string): Promise<void> {
  const sp = this.getSessionByAgentId(agentId);
  if (!sp?.connection || !sp.acpSessionId) throw new Error('No active session');
  await sp.connection.unstable_setSessionModel({ sessionId: sp.acpSessionId, modelId });
}

/** Set config option */
async setConfigOption(agentId: string, configId: string, value: string): Promise<void> {
  const sp = this.getSessionByAgentId(agentId);
  if (!sp?.connection || !sp.acpSessionId) throw new Error('No active session');
  await sp.connection.setSessionConfigOption({
    sessionId: sp.acpSessionId, configId, value
  });
}

/** Get session usage info */
getSessionUsage(agentId: string): { used: number; size: number } | null {
  return this.getSessionByAgentId(agentId)?.usage || null;
}

/** Reset session (clear history) */
async resetSession(agentId: string, workingDirectory: string): Promise<AgentSession> {
  await this.stopSession(this.getSessionByAgentId(agentId)?.session.id || '');
  // Re-start without resume ID (forces new session)
  const agent = /* look up agent */;
  return this.startSession(agent, workingDirectory);
}
```

**Capture session data from newSession response:**

```typescript
// In startSession(), after newSession call (line 380-386):
const acpSession = await connection.newSession({ cwd: workingDirectory, mcpServers });
acpSessionId = acpSession.sessionId;

// NEW: Capture modes, models, configOptions
sessionProcess.modes = acpSession.modes || null;
sessionProcess.models = acpSession.models || null;
sessionProcess.configOptions = acpSession.configOptions || null;
```

**Handle session update notifications:**

```typescript
// In sessionUpdate callback, add cases:
if (update.sessionUpdate === 'available_commands_update') {
  sessionProcess.availableCommands = update.availableCommands;
  eventEmitter.emit('commandsUpdated', update.availableCommands);
}

if (update.sessionUpdate === 'current_mode_update') {
  if (sessionProcess.modes) {
    sessionProcess.modes.currentModeId = update.currentModeId;
  }
  eventEmitter.emit('modeChanged', update.currentModeId);
}

if (update.sessionUpdate === 'usage_update') {
  sessionProcess.usage = { used: update.used, size: update.size, cost: update.cost };
  eventEmitter.emit('usageUpdated', sessionProcess.usage);
}
```

**New IPC channels:**

```typescript
// ipc.types.ts additions:
SLASH_SET_MODE: 'slash:setMode',
SLASH_SET_MODEL: 'slash:setModel',
SLASH_SET_CONFIG: 'slash:setConfig',
SLASH_GET_SESSION_INFO: 'slash:getSessionInfo',
SLASH_RESET_SESSION: 'slash:resetSession',
SLASH_COMPACT_SESSION: 'slash:compactSession',
```

**Commands in Phase 2:**

| Command | Implementation |
|---------|---------------|
| `/model [name]` | Call `setModel()` via IPC, or list available models if no arg |
| `/mode [name]` | Call `setMode()` via IPC, or list available modes if no arg |
| `/compact` | Send a special prompt asking agent to summarize the conversation |
| `/context` | Show token usage from `UsageUpdate` data |
| `/usage` | Show detailed session metrics |

### Phase 3: Autocomplete UI

**Changes to `chat-input.component.ts`:**

```typescript
// New properties:
suggestions: SlashCommand[] = [];
showSuggestions = false;
selectedSuggestionIndex = 0;

// In onKeydown or ngModel change handler:
onMessageChange(value: string): void {
  if (value.startsWith('/') && !value.includes(' ')) {
    this.suggestions = this.slashCommandService.getSuggestions(value);
    this.showSuggestions = this.suggestions.length > 0;
    this.selectedSuggestionIndex = 0;
  } else {
    this.showSuggestions = false;
  }
}

// Handle arrow keys for navigation:
onKeydown(event: KeyboardEvent): void {
  if (this.showSuggestions) {
    if (event.key === 'ArrowDown') { /* navigate down */ }
    if (event.key === 'ArrowUp') { /* navigate up */ }
    if (event.key === 'Tab' || event.key === 'Enter') { /* select suggestion */ }
    if (event.key === 'Escape') { this.showSuggestions = false; }
    return;
  }
  // Existing Enter handling...
}
```

**Template addition:**
```html
@if (showSuggestions) {
  <div class="slash-suggestions">
    @for (cmd of suggestions; track cmd.name; let i = $index) {
      <div class="suggestion" [class.active]="i === selectedSuggestionIndex"
           (click)="selectSuggestion(cmd)">
        <span class="cmd-name">/{{ cmd.name }}</span>
        <span class="cmd-desc">{{ cmd.description }}</span>
      </div>
    }
  </div>
}
```

### Phase 4: Advanced Commands

| Command | Implementation |
|---------|---------------|
| `/plan [prompt]` | Switch to plan mode + send prompt |
| `/review [prompt]` | Switch to review mode + send prompt |
| `/share [file]` | Export conversation to markdown file |
| `/session` | Show session info (id, mode, model, branch) |
| `/instructions` | Show/toggle agent system prompt |

---

## Key Considerations

### 1. Where to Intercept: Frontend vs Backend

**Recommendation: Frontend interception with backend execution.**

- The chat input component detects `/` prefix and routes to `SlashCommandService`
- Local commands (help, rename) execute entirely in the frontend
- ACP commands (model, mode, compact) send an IPC call to the main process
- The message is **not** saved to the database or sent to the agent as a prompt
- Instead, a system-style response is displayed in the chat showing the result

### 2. System Messages for Command Feedback

Commands need to produce visible feedback. Options:

**Option A: Ephemeral system messages** (recommended)
- Don't save to database
- Display inline in chat with distinct styling (e.g., gray, no avatar, monospace)
- Disappear on conversation reload

**Option B: Persisted system messages**
- Save with `role: 'system'` to database
- Persist across reloads
- Clutters conversation history

**Recommendation:** Option A for most commands. Only persist commands that change state (like `/rename`).

### 3. Command vs. Agent Message Ambiguity

If a user types `/something` that isn't a registered command, it should be treated as a regular message sent to the agent. The existing placeholder text already hints at this: `"Type a message or use / for commands..."`.

However, we should show an "Unknown command" error for close matches to prevent accidental sends:

```typescript
if (!cmd) {
  // Check if it's close to a real command (typo detection)
  const close = this.findCloseMatch(parsed.command);
  if (close) {
    return { type: 'error', content: `Unknown command /${parsed.command}. Did you mean /${close}?` };
  }
  // Not close to any command — send as regular message
  return null;
}
```

### 4. SessionProcess Interface Changes

The `SessionProcess` interface needs new fields to store session metadata:

```typescript
interface SessionProcess {
  // ... existing fields ...
  modes: SessionModeState | null;          // NEW
  models: SessionModelState | null;        // NEW
  configOptions: SessionConfigOption[];    // NEW
  usage: { used: number; size: number; cost?: Cost } | null;  // NEW
  availableCommands: AvailableCommand[];   // NEW
}
```

### 5. Compact Command Implementation

`/compact` in Copilot CLI summarizes conversation history to reduce the context window. Via ACP, this can be implemented as:

```typescript
// Option 1: Special prompt that triggers summarization
const compactPrompt = 'Summarize the conversation so far into a concise context that preserves all key decisions, code changes, and requirements. This summary will replace the full conversation history.';
await processManagerService.sendMessage(sessionId, compactPrompt);

// Option 2: Kill session, start new one, inject summary as system prompt
// More aggressive but guaranteed to reduce context
```

The Copilot agent likely has built-in handling for `/compact` when sent as a text prompt — it may recognize it and perform the summarization natively even through ACP.

### 6. Available Commands from ACP

The ACP spec includes `AvailableCommandsUpdate` — meaning the agent can dynamically advertise which commands it supports. Castle should:
1. Listen for these notifications
2. Merge them with Castle's built-in commands  
3. When an ACP-advertised command is invoked, send it as a prompt (the agent expects it)

This is the key bridge: ACP agents can expose their own commands, and Castle's engine routes to them.

---

## Edge Cases

| Edge Case | Handling |
|-----------|----------|
| `/model` with no active session | Show error: "Start a conversation first" |
| `/model invalidmodel` | Show error with list of valid models |
| `/clear` during active streaming | Cancel stream first, then clear |
| User types `/` then backspaces | Hide suggestions |
| Multiple `/` commands on separate lines | Only treat first line as command if it starts with `/` |
| Agent session dies mid-command | Catch error, show "Session disconnected" |
| `/compact` on very short conversation | Skip or warn "Conversation is already compact" |

---

## File References

### Files to Create

| File | Purpose |
|------|---------|
| `src/shared/types/slash-command.types.ts` | Command type definitions |
| `src/app/core/services/slash-command.service.ts` | Frontend command registry + parser |

### Files to Modify

| File | Changes |
|------|---------|
| `src/app/features/chat/chat-input/chat-input.component.ts` | Add autocomplete, `/` detection |
| `src/app/features/chat/chat-input/chat-input.component.html` | Add suggestions dropdown |
| `src/app/features/chat/chat-input/chat-input.component.scss` | Style suggestions |
| `src/app/features/chat/chat.component.ts` | Route `/` messages through SlashCommandService |
| `src/main/services/process-manager.service.ts` | Add `setMode`, `setModel`, `setConfigOption`, capture session response data, handle new session update types |
| `src/shared/types/ipc.types.ts` | Add slash command IPC channels |
| `src/main/ipc/index.ts` | Add slash command IPC handlers |
| `src/app/core/services/electron.service.ts` | Add slash command IPC methods |
| `src/app/core/services/websocket-api.ts` | Add slash command WebSocket methods |

### Files for Reference

| File | Why |
|------|-----|
| `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts` | ACP type definitions (modes, models, commands) |
| `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` | ACP connection methods |

---

## Complexity Estimate

| Phase | Files | Lines (est.) | Risk |
|-------|-------|-------------|------|
| Phase 1: Engine + local commands | 4 new + 3 modified | ~250-300 | Low |
| Phase 2: ACP session commands | 5 modified | ~200-250 | Medium |
| Phase 3: Autocomplete UI | 3 modified | ~100-150 | Low |
| Phase 4: Advanced commands | 1 modified | ~100 | Low |
| **Total** | **4 new + 8 modified** | **~650-800** | **Medium** |

### Dependencies
- No new npm packages
- Requires ACP SDK ^0.14.1 (already installed)
- Some ACP methods are `@experimental` (e.g., `unstable_setSessionModel`)

---

## Recommended Implementation Order

1. **Shared types** — `SlashCommand`, `CommandContext`, `CommandResult` types
2. **SlashCommandService** — Parser, registry, `isCommand()`, `execute()`, `getSuggestions()`
3. **Chat component interception** — Route `/` messages through service instead of `chatService.sendMessage()`
4. **Local commands** — `/help`, `/clear`, `/new`, `/rename`, `/diff`
5. **System message display** — Render command results as ephemeral system messages in chat
6. **ProcessManagerService extensions** — Capture modes/models/configOptions from `newSession()` response, handle new session update types
7. **ACP IPC channels + handlers** — `setMode`, `setModel`, `resetSession`
8. **ACP commands** — `/model`, `/mode`, `/context`, `/compact`
9. **Autocomplete UI** — Suggestions dropdown in chat input
10. **Advanced commands** — `/plan`, `/review`, `/share`, `/session`

### Priority Commands (implement first)

The most impactful commands for users, in order:

1. **`/help`** — Essential for discoverability
2. **`/clear`** — Most common operation (new conversation with same agent)
3. **`/model`** — Users want to switch models mid-conversation
4. **`/compact`** — Critical for long conversations hitting context limits
5. **`/context`** — Visibility into token usage
6. **`/diff`** — Quick access to see changes
7. **`/mode`** — Switch between ask/architect/code modes
