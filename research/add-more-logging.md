# Add More Logging — Research & Analysis

## Problem Statement

The application currently relies on ad-hoc `console.log`, `console.warn`, and `console.error` calls scattered across the codebase (~83 instances). There is no centralized logging service, no structured log format, no log levels, and no persistent log file output. The architecture plan (`plans/castle-architecture.md`, line 100) references a `src/main/utils/logger.ts` utility that **does not yet exist**.

**Goal:** Introduce a lightweight, centralized logger and instrument every meaningful event — agent activity, tool calls, chat messages, permission decisions, session lifecycle, IPC calls, errors — with appropriate severity levels.

---

## Current State

### Console Usage by File (83 total calls)

| File | Count | Types |
|------|-------|-------|
| `src/main/services/git-worktree.service.ts` | 22 | log, warn, error |
| `src/main/ipc/index.ts` | 18 | log, warn, error |
| `src/main/services/process-manager.service.ts` | 13 | log, warn, error |
| `src/main/index.ts` | 7 | log, error |
| `src/main/services/tailscale-server.service.ts` | 5 | log, error |
| `src/main/services/ws-bridge.service.ts` | 4 | log, error |
| `src/main/services/agent-discovery.service.ts` | 4 | log, warn |
| `src/main/services/database.service.ts` | 2 | log, error |
| `src/app/core/services/websocket-api.ts` | 3 | log, error |
| `src/app/features/chat/chat.component.ts` | 2 | error |
| `src/app/core/services/agent.service.ts` | 1 | error |
| `src/main/window.ts` | 1 | log |
| `src/main.ts` | 1 | error |

### What's Logged Today (Representative Samples)

```
[ProcessManager] Available models: ...
[ProcessManager] stderr (status=ready, operation=prompt): ...
[GitWorktree] Created worktree at: ...
[WsBridge] Client connected from ...
[WebSocketAPI] Connected / Disconnected
```

### What's NOT Logged Today

- **Chat message lifecycle** — no logging when a message is sent, received, or streamed
- **Tool call events** — no logging when an agent invokes a tool
- **Permission decisions** — no logging when a user allows/denies a permission
- **Session lifecycle** — session start/stop logged inconsistently
- **IPC handler invocations** — most IPC calls have no entry/exit logging
- **Agent discovery results** — partial logging only
- **Settings changes** — no logging
- **Conversation operations** — no logging
- **Task lifecycle** — research/implementation start logged, but not completion
- **Renderer-side events** — almost no logging (3 calls total)

### Existing Conventions

- **Prefix pattern:** `[ServiceName]` string prefix (not enforced)
- **No structured data:** All messages are plain strings
- **No log levels:** `console.log` used for both debug and info
- **No persistence:** All output goes to stdout/stderr only

---

## Proposed Approach

### 1. Create a Centralized Logger Utility

Create the planned `src/main/utils/logger.ts` as a lightweight wrapper that:
- Provides structured log levels: `debug`, `info`, `warn`, `error`
- Supports child loggers with a `context` prefix (e.g., `logger.child('ProcessManager')`)
- Outputs to both console and a rotating log file
- Includes ISO timestamps and severity in each line
- Is zero-dependency (no external logging library needed for v1)

```typescript
// src/main/utils/logger.ts

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(context: string): Logger;
}
```

**Output format:**
```
2026-02-17T20:30:00.000Z [INFO]  [ProcessManager] Session started {agentId: "abc", sessionId: "xyz"}
2026-02-17T20:30:01.000Z [INFO]  [IPC] Chat message sent {agentId: "abc", contentLength: 42}
2026-02-17T20:30:02.000Z [ERROR] [ProcessManager] ACP initialization failed {error: "timeout"}
```

### 2. Log File Persistence

- Write logs to `{userData}/logs/castle.log` (Electron's `app.getPath('userData')`)
- Rotate daily or at 10 MB, keeping the last 5 files
- File logging can use simple `fs.appendFileSync` or async write stream
- Consider making file logging configurable (on/off, level threshold)

### 3. Renderer-Side Logger

For the Angular renderer, create a simple `LogService` injectable that:
- Mirrors the main-process logger API (`info`, `warn`, `error`)
- Outputs to `console.*` in development
- Optionally forwards logs to the main process via IPC for unified log files

---

## Instrumentation Points

### Main Process — High Priority

#### A. Process Manager (`src/main/services/process-manager.service.ts`)

| Event | Level | What to Log |
|-------|-------|-------------|
| Session created | INFO | `agentId`, `sessionId`, working directory |
| Session resumed | INFO | `agentId`, `sessionId`, resume method (resume vs load vs new) |
| Session stopped | INFO | `agentId`, `sessionId`, reason |
| ACP initialization failed | ERROR | `agentId`, error message |
| Message sent to ACP | INFO | `agentId`, content length (not content — privacy) |
| Streaming output chunk | DEBUG | `agentId`, chunk type (content/thinking/toolCall), length |
| Streaming complete | INFO | `agentId`, message segments count, total duration |
| Tool call received | INFO | `agentId`, tool name, tool kind, locations (paths only) |
| Process stderr | WARN | `agentId`, status, operation, stderr snippet |
| Process exit | INFO | `agentId`, exit code, signal |
| Model query results | INFO | Available models, selected model |

#### B. IPC Handlers (`src/main/ipc/index.ts`)

| Event | Level | What to Log |
|-------|-------|-------------|
| `CHAT_SEND_MESSAGE` | INFO | `agentId`, content length, `conversationId` |
| `CHAT_SEND_MESSAGE` error | ERROR | `agentId`, error message |
| `CHAT_CANCEL_MESSAGE` | INFO | `agentId` |
| `AGENTS_DISCOVER` | INFO | Count of discovered agents |
| `AGENTS_START_SESSION` | INFO | `agentId`, working directory |
| `AGENTS_STOP_SESSION` | INFO | `agentId` |
| `PERMISSION_RESPONSE` | INFO | `agentId`, `optionKind`, `toolKind`, whether persisted |
| Permission auto-resolved | INFO | `agentId`, `toolKind`, grant decision (from DB) |
| Permission prompt shown | INFO | `agentId`, `toolKind`, request details |
| `TASKS_RUN_RESEARCH` | INFO | `taskId`, agent name |
| `TASKS_RUN_RESEARCH` complete | INFO | `taskId`, whether file was written |
| `TASKS_RUN_RESEARCH` error | ERROR | `taskId`, error message |
| `TASKS_RUN_IMPLEMENTATION` | INFO | `taskId`, worktree enabled, branch name |
| `TASKS_RUN_IMPLEMENTATION` complete | INFO | `taskId`, PR URL if created |
| `TASKS_RUN_IMPLEMENTATION` error | ERROR | `taskId`, error message |
| `DIRECTORY_SET_CURRENT` | INFO | New directory path |
| `SETTINGS_UPDATE` | INFO | Keys updated (not values — may contain sensitive data) |

#### C. Git Worktree Service (`src/main/services/git-worktree.service.ts`)

| Event | Level | What to Log |
|-------|-------|-------------|
| Worktree created | INFO | Branch name, worktree path |
| Worktree removed | INFO | Branch name, worktree path |
| Dependency install started | INFO | Package manager, worktree path |
| Dependency install failed | WARN | Package manager, error snippet |
| PR created | INFO | Branch name, PR URL |
| PR creation failed | WARN | Branch name, error |
| Auto-commit | INFO | Branch name, commit message |
| Orphan cleanup | INFO | Count of orphans removed |

#### D. Database Service (`src/main/services/database.service.ts`)

| Event | Level | What to Log |
|-------|-------|-------------|
| Database initialized | INFO | Database file path |
| Schema migration | INFO | Migration version |
| Permission grant saved | INFO | `projectPath`, `toolKind`, granted |
| Permission grant deleted | INFO | `grantId` |

#### E. Other Main Process Services

| Service | Event | Level |
|---------|-------|-------|
| `agent-discovery.service.ts` | Agents discovered from workspace | INFO |
| `agent-discovery.service.ts` | AGENTS.md parse error | WARN |
| `ws-bridge.service.ts` | Client connected/disconnected | INFO |
| `ws-bridge.service.ts` | Message routing error | ERROR |
| `tailscale-server.service.ts` | Server started/stopped | INFO |
| `tailscale-server.service.ts` | Server error | ERROR |
| `directory.service.ts` | Directory changed | INFO |
| `index.ts` (bootstrap) | Services initialized | INFO |
| `index.ts` (bootstrap) | Window created | INFO |
| `index.ts` (bootstrap) | Uncaught exception | ERROR |

### Renderer Process — Medium Priority

#### F. Angular Services

| Service | Event | Level |
|---------|-------|-------|
| `agent.service.ts` | Agent selected | INFO |
| `agent.service.ts` | Session auto-start failed | ERROR |
| `chat.service.ts` | Message sent | INFO |
| `chat.service.ts` | Stream started/completed | INFO |
| `chat.service.ts` | Send/cancel failed | ERROR |
| `conversation.service.ts` | Conversation created/selected/deleted | INFO |
| `task.service.ts` | Research/implementation started | INFO |
| `task.service.ts` | Task state changed | INFO |
| `electron.service.ts` | IPC event received (permission, error, sync) | DEBUG |
| `websocket-api.ts` | Connected/disconnected/reconnecting | INFO |
| `websocket-api.ts` | Connection error | ERROR |

#### G. Angular Components

| Component | Event | Level |
|-----------|-------|-------|
| `permission-dialog` | Dialog opened | INFO |
| `permission-dialog` | User selected option | INFO |
| `main-layout` | Permission auto-dismissed (cross-device) | INFO |

---

## Implementation Guidance

### Step 1: Create the Logger Utility

**File:** `src/main/utils/logger.ts`

Design the logger as a factory pattern:

```typescript
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function formatMessage(level: string, context: string, message: string, data?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ' ' + JSON.stringify(data) : '';
  return `${timestamp} [${level.padEnd(5)}] [${context}] ${message}${dataStr}`;
}

function createLogger(context: string): Logger {
  return {
    debug: (msg, data) => write('DEBUG', context, msg, data),
    info:  (msg, data) => write('INFO',  context, msg, data),
    warn:  (msg, data) => write('WARN',  context, msg, data),
    error: (msg, data) => write('ERROR', context, msg, data),
    child: (childContext) => createLogger(`${context}:${childContext}`),
  };
}

export const logger = createLogger('App');
```

### Step 2: Replace Console Calls in Main Process

Migrate each service to use the logger:

```typescript
// Before (process-manager.service.ts)
console.log(`[ProcessManager] Available models: ${modelNames.join(', ')}`);

// After
const log = logger.child('ProcessManager');
log.info('Available models', { models: modelNames });
```

**Priority order for migration:**
1. `process-manager.service.ts` — Most agent-related activity
2. `src/main/ipc/index.ts` — All IPC handlers
3. `git-worktree.service.ts` — Task execution
4. `index.ts` — App lifecycle
5. Remaining services

### Step 3: Add New Log Points

For each entry in the "Instrumentation Points" tables above, add the corresponding `log.info()` or `log.error()` call. Focus on:
- **Entry/exit of important operations** (session start, message send, task run)
- **Decision points** (permission auto-resolved, worktree creation decision)
- **Error paths** (every `catch` block should log with `log.error()`)
- **State transitions** (session status changes, task state changes)

### Step 4: Create Renderer Logger Service

**File:** `src/app/core/services/log.service.ts`

```typescript
@Injectable({ providedIn: 'root' })
export class LogService {
  private context = 'App';

  child(context: string): LogService {
    const svc = new LogService();
    svc.context = context;
    return svc;
  }

  info(message: string, data?: Record<string, unknown>): void {
    console.log(`[${this.context}] ${message}`, data ?? '');
  }

  warn(message: string, data?: Record<string, unknown>): void {
    console.warn(`[${this.context}] ${message}`, data ?? '');
  }

  error(message: string, data?: Record<string, unknown>): void {
    console.error(`[${this.context}] ${message}`, data ?? '');
  }
}
```

### Step 5: Instrument Renderer Services

Inject `LogService` into Angular services and components, replace raw `console.*` calls.

---

## Privacy & Security Considerations

| Concern | Guidance |
|---------|----------|
| **Message content** | Never log full user message content. Log `contentLength` instead. |
| **File contents** | Never log file contents read/written. Log file paths only. |
| **Command arguments** | Log the command name/binary, but be cautious with arguments (may contain secrets). |
| **rawInput** | The ACP `rawInput` field may contain sensitive data — log tool name and kind only. |
| **API keys / tokens** | Never log environment variables or authentication tokens. |
| **User paths** | File paths are acceptable to log (they're in the user's local logs). |

---

## Performance Considerations

- **Synchronous writes** (`fs.appendFileSync`) block the event loop — acceptable for low-frequency INFO logs, but use **async writes** or a **write buffer** for high-frequency DEBUG logs (e.g., streaming chunks).
- **DEBUG level** should be off by default in production builds. Gate with a `LOG_LEVEL` environment variable or app setting.
- **Structured data** objects passed to the logger should be lightweight — avoid serializing large objects (e.g., full message bodies, file contents).
- **Log rotation** should happen automatically to prevent unbounded disk usage.

---

## Files Requiring Changes

| File | Change Type |
|------|-------------|
| **New:** `src/main/utils/logger.ts` | Create centralized logger utility |
| **New:** `src/app/core/services/log.service.ts` | Create Angular logger service |
| `src/main/services/process-manager.service.ts` | Replace 13 console calls + add new log points |
| `src/main/ipc/index.ts` | Replace 18 console calls + add IPC handler logging |
| `src/main/services/git-worktree.service.ts` | Replace 22 console calls + add new log points |
| `src/main/index.ts` | Replace 7 console calls + add lifecycle logging |
| `src/main/services/tailscale-server.service.ts` | Replace 5 console calls |
| `src/main/services/ws-bridge.service.ts` | Replace 4 console calls |
| `src/main/services/agent-discovery.service.ts` | Replace 4 console calls |
| `src/main/services/database.service.ts` | Replace 2 console calls + add schema/grant logging |
| `src/main/window.ts` | Replace 1 console call |
| `src/main.ts` | Replace 1 console call |
| `src/app/core/services/websocket-api.ts` | Replace 3 console calls, use LogService |
| `src/app/features/chat/chat.component.ts` | Replace 2 console calls, use LogService |
| `src/app/core/services/agent.service.ts` | Replace 1 console call, use LogService |
| `src/app/core/services/chat.service.ts` | Add stream lifecycle logging |
| `src/app/core/services/conversation.service.ts` | Add conversation operation logging |
| `src/app/core/services/task.service.ts` | Add task lifecycle logging |
| `src/app/core/services/electron.service.ts` | Add IPC event logging |
| `src/app/shared/components/permission-dialog/*` | Add permission dialog logging |
| `src/app/features/main-layout/main-layout.component.ts` | Add permission flow logging |
| `plans/castle-architecture.md` | Update to reflect logger implementation |

---

## Phased Implementation Plan

### Phase 1: Logger Utility (Foundation)
- [ ] Create `src/main/utils/logger.ts` with levels, formatting, file output
- [ ] Create `src/app/core/services/log.service.ts` for renderer
- [ ] Add log rotation and configurable log level

### Phase 2: Migrate Existing Console Calls (83 calls)
- [ ] `process-manager.service.ts` — 13 calls
- [ ] `src/main/ipc/index.ts` — 18 calls
- [ ] `git-worktree.service.ts` — 22 calls
- [ ] `index.ts` — 7 calls
- [ ] All remaining main-process files — 16 calls
- [ ] All renderer files — 6 calls

### Phase 3: Add New Instrumentation (High-Value Points)
- [ ] Agent session lifecycle (start, resume, stop, error)
- [ ] Chat message send/receive/stream-complete
- [ ] Tool call events (name, kind, locations)
- [ ] Permission request/response/auto-resolve
- [ ] Task research/implementation start/complete/error
- [ ] IPC handler entry for major operations

### Phase 4: Add Remaining Instrumentation
- [ ] Git worktree lifecycle events
- [ ] Settings changes
- [ ] Directory changes
- [ ] Database operations
- [ ] Agent discovery
- [ ] Renderer-side service events
- [ ] WebSocket connection lifecycle

### Phase 5: Polish
- [ ] Verify no sensitive data is logged (audit pass)
- [ ] Add `LOG_LEVEL` environment variable or setting
- [ ] Document log file location and format for users
- [ ] Update architecture docs

---

## Open Questions

1. **External library vs custom?** A custom logger keeps dependencies at zero and is sufficient for this use case. However, `electron-log` provides built-in file rotation and crash reporting. Tradeoff: simplicity vs features.
2. **Log level setting?** Should the log level be configurable in the Settings UI, or only via environment variable? (Recommendation: environment variable for now, UI setting later.)
3. **Renderer → main forwarding?** Should renderer logs be forwarded to the main process log file via IPC, or stay in the browser console only? (Recommendation: console-only for now to avoid IPC overhead.)
4. **Structured vs plain text?** JSON-structured logs are machine-parseable but harder to read. Plain text with optional data suffix is more human-friendly. (Recommendation: plain text for v1, with structured data as an optional JSON suffix.)
5. **Log viewer?** Should we add a log viewer in the Settings page? (Recommendation: out of scope for this task; users can open the log file directly.)
