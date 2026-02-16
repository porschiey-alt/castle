# Research: Implementing Slash Commands from Copilot CLI

## Problem Statement

The Copilot CLI provides a rich set of `/slash` commands (e.g., `/clear`, `/compact`, `/model`, `/help`) that allow users to control session state, switch models, manage context, and more. These commands are **not accessible through ACP** — when Castle sends a message like `/compact` via `connection.prompt()`, it's sent as plain text to the LLM rather than being interpreted as a command. Castle needs a slash command engine that:

1. Intercepts slash commands before they reach ACP
2. Maps commands to the appropriate ACP methods or local operations
3. Supports Castle-specific custom commands
4. Provides autocomplete/discovery in the UI

---

## Copilot CLI Slash Commands — Full Inventory

Based on research of the Copilot CLI, here is the complete set of known slash commands and how they map to available mechanisms:

### Session & Context Commands

| Command | CLI Behavior | ACP Equivalent |
|---------|-------------|----------------|
| `/clear` or `/new` | Clears conversation context, starts fresh session | `connection.newSession()` — kill and recreate the ACP session |
| `/compact` | Summarizes conversation to reduce context token usage | **No ACP method** — must be sent as a prompt with instructions, or use `unstable_forkSession()` |
| `/session` | Shows current session info (ID, working directory, status) | Local — read from `SessionProcess` in memory |
| `/context` | Visualize context window usage (tokens used/total) | ACP `usage_update` session notification (if supported) |

### Model & Mode Commands

| Command | CLI Behavior | ACP Equivalent |
|---------|-------------|----------------|
| `/model [name]` | Switch LLM or open model picker | `connection.unstable_setSessionModel({ sessionId, modelId })` or `connection.setSessionConfigOption()` with category `"model"` |
| `/agent` | List/switch agents | Local — Castle already has agent switching in the sidebar |

### Directory & Permission Commands

| Command | CLI Behavior | ACP Equivalent |
|---------|-------------|----------------|
| `/cwd` or `/cd [path]` | Show or change working directory | Local — Castle manages working directory via `DirectoryService`; requires session restart for CWD change |
| `/add-dir [path]` | Grant Copilot access to an additional directory | **No ACP method** — could use `extMethod()` or prompt-based approach |
| `/list-dirs` | Show permitted directories | Local — read from directory service |
| `/allow-all` or `/yolo` | Grant all tool permissions automatically | Local — toggle permission auto-approve in Castle settings |

### Output & Sharing Commands

| Command | CLI Behavior | ACP Equivalent |
|---------|-------------|----------------|
| `/diff` | Show file changes made in the working directory | Local — run `git diff` in the working directory |
| `/share [file\|gist] [path]` | Export session as markdown or GitHub Gist | Local — serialize chat history to file or Gist API |
| `/usage` | Show token/request usage stats for session | ACP `UsageUpdate` notification data (context `size` and `used` tokens, optional `cost`) |

### UI & System Commands

| Command | CLI Behavior | ACP Equivalent |
|---------|-------------|----------------|
| `/help` | List available commands | Local — display command registry |
| `/theme [name]` | Change terminal theme | Local — Castle already has `ThemeService` |
| `/feedback` | Submit feedback | Local — open feedback form or GitHub issue |
| `/exit` or `/quit` | Exit CLI session | Local — stop agent session |
| `/terminal-setup` | Enable multiline input / terminal settings | N/A — Castle textarea already supports multiline |
| `/ide` | Connect to IDE workspace | N/A — Castle is the IDE-like client |
| `/user` | Switch GitHub user | **No ACP method** — could use `connection.authenticate()` |
| `/experimental` | Toggle experimental features | Local — settings toggle |

---

## ACP Protocol Analysis

### What ACP Already Supports

The ACP SDK (`@agentclientprotocol/sdk@0.14.1`) provides several mechanisms relevant to slash command functionality:

#### 1. `available_commands_update` Session Notification

ACP has a built-in concept of **available commands** that agents can advertise dynamically:

```typescript
type AvailableCommand = {
  name: string;           // e.g. "create_plan", "research_codebase"
  description: string;    // Human-readable description
  input?: {               // Optional unstructured text input
    hint: string;         // Placeholder hint
  };
};

// Sent via sessionUpdate notification:
{ sessionUpdate: "available_commands_update", availableCommands: [...] }
```

**Castle currently ignores this notification.** The process manager's `sessionUpdate` handler only processes `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, and `plan`.

#### 2. `setSessionMode()` — Switch Agent Modes

```typescript
connection.setSessionMode({
  sessionId: acpSessionId,
  modeId: "code"  // e.g., "ask", "code", "architect"
});
```

The `newSession()` response can include a `modes` field with `availableModes` and `currentModeId`. Castle currently discards this data.

#### 3. `unstable_setSessionModel()` — Switch Models (Experimental)

```typescript
connection.unstable_setSessionModel({
  sessionId: acpSessionId,
  modelId: "claude-sonnet-4"
});
```

The `newSession()` response can include a `models` field with available models. Castle currently ignores this and instead passes `--model` at process spawn time.

#### 4. `setSessionConfigOption()` — General Config

```typescript
connection.setSessionConfigOption({
  sessionId: acpSessionId,
  configId: "mode",       // or "model", "thought_level", etc.
  value: "code"
});
```

Returns the full updated config. The `newSession()` response includes `configOptions` with categories like `"mode"`, `"model"`, `"thought_level"`.

#### 5. `cancel()` — Cancel In-Progress Prompt

```typescript
connection.cancel({ sessionId: acpSessionId });
```

Castle currently kills the entire child process on cancel — `cancel()` is a more graceful alternative.

#### 6. `extMethod()` / `extNotification()` — Extension Points

```typescript
connection.extMethod("custom/command", { arg: "value" });
```

Allows sending arbitrary non-spec methods to the agent. Could be used for commands not in the ACP spec.

### What ACP Does NOT Support

- **No `/compact` method** — context summarization isn't an ACP operation
- **No `/diff` method** — file change tracking is a local/git concern
- **No `/share` method** — session export is a client-side operation
- **No `/add-dir` method** — directory permissions aren't part of ACP (they're a client concern)

---

## Proposed Architecture

### Design: Hybrid Slash Command Engine

Commands fall into three categories based on where they execute:

```
┌─────────────────────────────────────────────────┐
│                 Chat Input                       │
│   User types: /model claude-sonnet-4            │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│           Slash Command Parser                   │
│  Detects /command [args] pattern                │
│  Looks up in CommandRegistry                     │
└──────┬──────────┬──────────────┬────────────────┘
       │          │              │
       ▼          ▼              ▼
┌──────────┐ ┌──────────┐ ┌──────────────────────┐
│  LOCAL   │ │   ACP    │ │  PASSTHROUGH         │
│ Commands │ │ Commands │ │  (send as prompt)    │
│          │ │          │ │                      │
│ /help    │ │ /model   │ │ Unrecognized /cmd    │
│ /clear   │ │ /mode    │ │ sent to agent as-is  │
│ /diff    │ │ /compact │ │                      │
│ /share   │ │ /cancel  │ │                      │
│ /theme   │ │          │ │                      │
│ /session │ │          │ │                      │
│ /usage   │ │          │ │                      │
└──────────┘ └──────────┘ └──────────────────────┘
```

### Command Registry

A central registry that all layers can register commands into:

```typescript
// src/shared/types/command.types.ts

export interface SlashCommand {
  name: string;                    // e.g., "model"
  aliases?: string[];              // e.g., ["m"]
  description: string;
  usage?: string;                  // e.g., "/model [model-name]"
  category: CommandCategory;
  args?: CommandArg[];
  execute: CommandExecutor;        // Differs by layer (renderer vs main)
}

export type CommandCategory =
  | 'session'      // /clear, /compact, /session, /context
  | 'model'        // /model, /mode
  | 'directory'    // /cwd, /cd, /add-dir, /list-dirs
  | 'output'       // /diff, /share, /usage
  | 'ui'           // /help, /theme, /feedback
  | 'system'       // /exit, /allow-all, /experimental
  | 'custom';      // User-defined Castle commands

export interface CommandArg {
  name: string;
  required: boolean;
  description: string;
  choices?: string[];              // For autocomplete
}

export type CommandResult = {
  type: 'system-message';          // Show as system message in chat
  content: string;
} | {
  type: 'action';                  // Perform an action (no chat output)
  action: string;
} | {
  type: 'passthrough';             // Send to agent as regular prompt
};
```

### Execution Layers

#### Layer 1: Renderer-Side Parser (`SlashCommandService`)

Intercepts input before it goes to IPC. Handles:
- Pattern detection (`/command [args]`)
- UI-only commands (`/help`, `/theme`)
- Routing to main process for ACP/local commands

```typescript
// src/app/core/services/slash-command.service.ts

@Injectable({ providedIn: 'root' })
export class SlashCommandService {
  private commands = new Map<string, RendererSlashCommand>();

  register(command: RendererSlashCommand): void { ... }

  parse(input: string): { command: string; args: string } | null {
    const match = input.match(/^\/(\S+)\s*(.*)?$/);
    if (!match) return null;
    return { command: match[1].toLowerCase(), args: (match[2] || '').trim() };
  }

  async execute(input: string, agentId: string): Promise<CommandResult> {
    const parsed = this.parse(input);
    if (!parsed) return { type: 'passthrough' };

    const cmd = this.commands.get(parsed.command)
      || this.findByAlias(parsed.command);

    if (!cmd) return { type: 'passthrough' };
    return cmd.execute(parsed.args, agentId);
  }

  getCompletions(partial: string): SlashCommand[] {
    // For autocomplete dropdown
    return [...this.commands.values()]
      .filter(c => c.name.startsWith(partial) ||
                   c.aliases?.some(a => a.startsWith(partial)));
  }
}
```

#### Layer 2: Main-Process Command Handlers

New IPC channel for commands that need main-process access:

```typescript
// New IPC channel
SLASH_COMMAND_EXECUTE: 'slash:execute'

// Handler in main process
ipcMain.handle(IPC_CHANNELS.SLASH_COMMAND_EXECUTE, async (_event, { agentId, command, args }) => {
  switch (command) {
    case 'clear':
      // Kill existing session, it auto-restarts on next message
      await processManagerService.cancelMessage(agentId);
      await databaseService.clearHistory(agentId);
      return { type: 'system-message', content: 'Session cleared.' };

    case 'model':
      // Use ACP setSessionConfigOption or unstable_setSessionModel
      const session = processManagerService.getSessionByAgentId(agentId);
      if (session?.connection && session.acpSessionId) {
        await session.connection.unstable_setSessionModel({
          sessionId: session.acpSessionId,
          modelId: args
        });
      }
      return { type: 'system-message', content: `Model changed to ${args}` };

    case 'compact':
      // Fork session, summarize, replace
      // ...
  }
});
```

#### Layer 3: ACP `AvailableCommand` Integration

Capture agent-advertised commands from `available_commands_update`:

```typescript
// In process-manager.service.ts sessionUpdate handler, add:
if (update.sessionUpdate === 'available_commands_update') {
  sessionProcess.availableCommands = update.availableCommands;
  eventEmitter.emit('commandsUpdate', update.availableCommands);
}
```

These agent-advertised commands can be merged into the autocomplete registry so users discover them alongside Castle's built-in commands.

---

## Implementation Plan

### Phase 1: Core Engine + Essential Commands

**Goal:** Build the command registry, parser, and implement the 5 most impactful commands.

#### 1.1 Shared Types
- **New file:** `src/shared/types/command.types.ts` — `SlashCommand`, `CommandResult`, `CommandCategory` types

#### 1.2 Renderer: SlashCommandService
- **New file:** `src/app/core/services/slash-command.service.ts`
  - Command registry (Map of name → handler)
  - `parse(input)` — detect `/command [args]` pattern
  - `execute(input, agentId)` — route to handler or return passthrough
  - `getCompletions(partial)` — for autocomplete
- Register built-in renderer commands: `/help`, `/theme`

#### 1.3 Chat Input Integration
- **Modify:** `src/app/features/chat/chat-input/chat-input.component.ts`
  - Inject `SlashCommandService`
  - In `onSend()`, call `slashCommandService.parse()` first
  - If command is recognized, execute locally or via IPC instead of sending as chat message
- **Modify:** `src/app/core/services/chat.service.ts`
  - Add `addSystemMessage(agentId, content)` method for showing command output in chat

#### 1.4 Main Process: Command IPC Handler
- **Modify:** `src/shared/types/ipc.types.ts` — add `SLASH_COMMAND_EXECUTE` channel
- **Modify:** `src/main/ipc/index.ts` — add handler for slash command execution
- **Modify:** `src/app/core/services/electron.service.ts` — add `executeSlashCommand()` method
- **Modify:** `src/preload/index.ts` — expose new IPC channel

#### 1.5 Implement Phase 1 Commands

| Command | Layer | Implementation |
|---------|-------|---------------|
| `/help` | Renderer | List all registered commands as a system message |
| `/clear` | Main | Kill session + clear DB history; session auto-restarts on next message |
| `/model [name]` | Main → ACP | Call `unstable_setSessionModel()` or `setSessionConfigOption()` |
| `/theme [name]` | Renderer | Call `ThemeService.setTheme()` |
| `/session` | Main | Return session metadata (ID, status, agent, CWD, uptime) |

### Phase 2: ACP Integration + More Commands

#### 2.1 Capture Session Metadata from `newSession()`
- **Modify:** `src/main/services/process-manager.service.ts`
  - Store `modes`, `models`, `configOptions` from `NewSessionResponse`
  - Handle `available_commands_update`, `config_option_update`, `current_mode_update`, `usage_update` in `sessionUpdate`
  - Expose getters for modes/models/config/commands

#### 2.2 Implement Phase 2 Commands

| Command | Layer | Implementation |
|---------|-------|---------------|
| `/compact` | Main → ACP | Fork session (summarize context) via `unstable_forkSession()`, or send a summarization prompt |
| `/mode [name]` | Main → ACP | Call `setSessionMode()` with mode from `availableModes` |
| `/diff` | Main (local) | Run `git diff` in working directory, return output |
| `/usage` | Main → ACP | Read from cached `UsageUpdate` data |
| `/cancel` | Main → ACP | Call `connection.cancel()` instead of killing process |
| `/cd [path]` | Main (local) | Change working directory via `DirectoryService`, restart session |

#### 2.3 Surface Agent-Advertised Commands
- Listen for `available_commands_update` notifications
- Merge agent commands into the autocomplete registry
- When user invokes an agent command, send it as a regular prompt (the agent handles it)

### Phase 3: UI Polish + Custom Commands

#### 3.1 Autocomplete Dropdown
- **Modify:** `src/app/features/chat/chat-input/chat-input.component.ts`
  - Detect when input starts with `/`
  - Show overlay/dropdown with matching commands, descriptions, and usage hints
  - Keyboard navigation (↑↓ to select, Tab/Enter to complete)
  - **New file:** `src/app/features/chat/chat-input/command-autocomplete.component.ts`

#### 3.2 System Message UI
- **New or modify:** Message bubble component
  - Add a `role: 'system'` rendering style — distinct from user/assistant (muted color, icon, no avatar)
  - Used for command output (`/help`, `/session`, etc.)

#### 3.3 Custom Command Registration (Extensibility)
- Allow `AGENTS.md` to define custom slash commands per agent
- Example:
  ```markdown
  ## Commands
  - `/deploy` - Deploy the current build to staging
  - `/test [suite]` - Run test suite
  ```
- These get registered as passthrough commands that are sent to the agent as prompts with instruction framing

---

## Key Considerations

### 1. Where to Parse: Renderer vs Main Process

**Recommendation: Parse in the renderer, execute in both layers.**

- The renderer has direct access to UI state (theme, scroll, focus)
- The main process has access to ACP connections, file system, and git
- Parsing in the renderer allows immediate UI feedback (no IPC round-trip for `/help`)
- Commands needing ACP or FS access route through a new IPC channel

### 2. What Happens with Unrecognized Commands

Three options:
- **a) Error message** — "Unknown command /foo. Type /help for available commands."
- **b) Passthrough** — Send to agent as a regular prompt (the agent may understand it)
- **c) Configurable** — Let users choose behavior in settings

**Recommendation: Option (b) passthrough.** The Copilot CLI agent might support commands that Castle doesn't know about (especially with `available_commands_update`). Only show an error if the user explicitly types a Castle-registered command with bad arguments.

### 3. `/compact` Complexity

`/compact` is the hardest command to implement because ACP has no native "summarize context" method. Options:

- **Option A: `unstable_forkSession()`** — Fork the session, send a "summarize" prompt to the fork, then use the summary to prime a new session. Complex, depends on unstable API.
- **Option B: Kill-and-restart** — End the session, start a new one, inject a system message with a summary of the conversation history from the database. Simple but loses tool state.
- **Option C: Prompt-based** — Send a message like "Please summarize our conversation so far to compress context" as a regular prompt. Simplest, but uses tokens and the result isn't a true context compaction.

**Recommendation: Start with Option C (prompt-based), upgrade to Option A if `forkSession` stabilizes.**

### 4. `/model` — Timing and Session State

Changing models mid-session via `unstable_setSessionModel()` is experimental. The safer approach:

1. First try `setSessionConfigOption()` with category `"model"` (the stable API)
2. Fall back to `unstable_setSessionModel()`
3. If neither works, restart the session with `--model <new_model>` flag

Castle should also cache the `configOptions` from `newSession()` to know which models are actually available at runtime (rather than relying on the hardcoded `COPILOT_MODELS` constant).

### 5. `/clear` vs Kill-and-Restart

The cleanest `/clear` implementation:

1. Call `processManagerService.cancelMessage()` to kill the process
2. Call `databaseService.clearHistory(agentId)` to wipe DB
3. The session auto-restarts on next message (existing behavior)

This is simpler than trying to reset ACP session state in-place.

### 6. System Messages in Chat

Slash command output needs to be visually distinct in the chat. Add a `role: 'system'` message style:

```typescript
// System messages should:
// - Have a muted/info color (not user blue or agent dark)
// - Show an icon (e.g., terminal icon or info icon)
// - Not have an avatar
// - Not be saved to the database (ephemeral) — OR saved with role: 'system'
// - Support rich formatting (tables for /help, code blocks for /diff)
```

### 7. Graceful Cancel via ACP

Castle currently kills the entire child process to cancel a message. ACP provides `connection.cancel()` which asks the agent to stop gracefully. Benefits:
- Session stays alive (no restart overhead)
- Partial results are preserved
- Agent can clean up tool state

**Recommendation: Switch to `connection.cancel()` as part of this work.**

---

## File Change Summary

### New Files

| File | Purpose |
|------|---------|
| `src/shared/types/command.types.ts` | SlashCommand, CommandResult, CommandArg types |
| `src/app/core/services/slash-command.service.ts` | Command registry, parser, renderer-side executor |
| `src/app/features/chat/chat-input/command-autocomplete.component.ts` | Autocomplete dropdown UI (Phase 3) |

### Modified Files

| File | Changes |
|------|---------|
| `src/shared/types/ipc.types.ts` | Add `SLASH_COMMAND_EXECUTE` channel + payload types |
| `src/preload/index.ts` | Expose new IPC method |
| `src/app/core/services/electron.service.ts` | Add `executeSlashCommand()` method |
| `src/app/core/services/chat.service.ts` | Add `addSystemMessage()` for command output |
| `src/app/features/chat/chat-input/chat-input.component.ts` | Intercept `/` commands before send |
| `src/main/ipc/index.ts` | Add slash command execution handler |
| `src/main/services/process-manager.service.ts` | Store session metadata (modes, models, configOptions, availableCommands); handle new session update types; add `cancel()` method; expose getters |
| `src/shared/types/message.types.ts` | (Optional) Add `'system'` to `MessageRole` union |
| `src/app/features/chat/message-bubble/message-bubble.component.*` | System message rendering style |

---

## Command Implementation Reference

Below is a quick-reference for how each command should be implemented:

```
/help           → Renderer: enumerate registry, show as system message
/clear          → IPC → Main: kill session + clear DB
/compact        → IPC → Main: send summarize prompt (Phase 1), or fork session (Phase 2)
/model [name]   → IPC → Main → ACP: setSessionConfigOption or unstable_setSessionModel
/mode [name]    → IPC → Main → ACP: setSessionMode
/session        → IPC → Main: read SessionProcess metadata, return as system message
/usage          → IPC → Main: read cached UsageUpdate, return as system message
/diff           → IPC → Main: exec `git diff` in CWD, return as system message (code block)
/share [path]   → IPC → Main: serialize chat history to markdown file
/theme [name]   → Renderer: call ThemeService.setTheme()
/cd [path]      → IPC → Main: change CWD via DirectoryService, restart session
/cancel         → IPC → Main → ACP: connection.cancel() (graceful)
/exit           → IPC → Main: stop session
/allow-all      → IPC → Main: toggle permission auto-approve in settings
```

---

## Estimated Scope

| Phase | New Files | Modified Files | Estimated Lines |
|-------|-----------|---------------|-----------------|
| Phase 1 (Core + 5 commands) | 2 | 6 | ~400 |
| Phase 2 (ACP + 6 commands) | 0 | 3 | ~300 |
| Phase 3 (Autocomplete + polish) | 1 | 3 | ~250 |
| **Total** | **3** | **~9 unique** | **~950** |
