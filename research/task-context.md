# Research: Task Context — Exposing Castle Tasks to Agents

## Executive Summary

Castle's task management system stores rich task data (title, description, state, kind, labels, research content, PR status, branches, etc.) in a local SQLite database, but **agents have no way to access this data**. When a user asks an agent "List my current Castle tasks" or "What's the status of the auth refactor task?", the agent has no mechanism to read, query, or even know about the task system.

This research evaluates three approaches for giving agents read access to Castle's task data:

1. **Context Injection** — Inject task summaries into prompts (simplest, least flexible)
2. **MCP Server** — Build a dedicated MCP tool server that queries Castle's database (most robust, extensible)
3. **Hybrid** — System prompt awareness + on-demand context injection (balanced)

**Recommended approach:** Build a lightweight **MCP Server** that exposes Castle task data as tools. This follows the established MCP pattern already supported by the agent system, is the most extensible, and lets the agent decide *when* to query task data rather than always injecting it.

---

## Current Architecture Analysis

### Task Data Model

**File:** `src/shared/types/task.types.ts` (Lines 42-63)

```typescript
export interface Task {
  id: string;
  title: string;
  description: string;
  state: TaskState;        // 'new' | 'in_progress' | 'active' | 'blocked' | 'review' | 'done'
  kind: TaskKind;          // 'feature' | 'bug' | 'chore' | 'spike'
  labels: TaskLabel[];
  projectPath?: string;
  researchContent?: string;
  researchAgentId?: string;
  implementAgentId?: string;
  worktreePath?: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  prState?: TaskPRState;
  closeReason?: BugCloseReason;
  createdAt: Date;
  updatedAt: Date;
}
```

### Task Storage & Queries

**File:** `src/main/services/database.service.ts`

| Method | Line | Description |
|--------|------|-------------|
| `getTasks(state?, kind?, projectPath?)` | ~1065 | Filtered list, ordered by `updated_at DESC` |
| `getTask(taskId)` | ~1015 | Single task by ID with hydrated labels |
| `getLabelsForTask(taskId)` | ~1134 | JOIN query for labels |
| `getTaskLabels()` | ~1154 | All available labels |
| `createTask(input, projectPath?)` | ~943 | Insert new task |
| `updateTask(taskId, updates)` | ~967 | Selective field updates |

**Schema:** Tasks table has columns for all `Task` interface fields, plus `task_labels` and `task_label_assignments` junction tables.

### How Agents Currently Get Context

**File:** `src/main/services/process-manager.service.ts` (Lines 460-474)

```typescript
// System prompt: one-time injection on first message
if (sessionProcess.systemPrompt && !sessionProcess.systemPromptSent) {
  promptBlocks.push({ type: 'text', text: sessionProcess.systemPrompt });
  sessionProcess.systemPromptSent = true;
}
promptBlocks.push({ type: 'text', text: content });
```

- System prompt is a plain text prepended **once** to the first message
- No mechanism for dynamic context injection
- No embedded resources or structured data blocks are sent

### How MCP Servers Are Configured

**File:** `src/shared/types/agent.types.ts` (Lines 25-30)

```typescript
export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
```

**File:** `src/main/services/process-manager.service.ts` (Lines 336-383)

```typescript
// Agent's mcpServers are transformed and passed to ACP session
const mcpServers = (agent.mcpServers || []).map(s => ({
  name: s.name,
  command: s.command,
  args: s.args || [],
  env: Object.entries(s.env || {}).map(([name, value]) => ({ name, value }))
}));

// Passed to all session creation methods:
await connection.newSession({ cwd: workingDirectory, mcpServers });
await connection.loadSession({ sessionId, cwd, mcpServers });
await connection.unstable_resumeSession({ sessionId, cwd, mcpServers });
```

**Key insight:** MCP servers are spawned as **child processes of the Copilot CLI**, not of Castle. They communicate with the agent via stdio (MCP protocol), and the agent calls their tools when it decides to.

### ACP ContentBlock Types

**File:** `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts` (Lines 383-393)

```typescript
export type ContentBlock = (TextContent & { type: "text" })
  | (ImageContent & { type: "image" })
  | (AudioContent & { type: "audio" })
  | (ResourceLink & { type: "resource_link" })
  | (EmbeddedResource & { type: "resource" });
```

The `embeddedContext` capability (from `PromptCapabilities`) would allow sending `ContentBlock::Resource` (embedded data) alongside text in prompts. However, Castle doesn't currently check or use this capability.

---

## Approach Analysis

### Approach 1: System Prompt Context Injection

**How it works:** Inject a summary of all tasks into the agent's system prompt on session start, and optionally refresh it by prepending updated data to subsequent messages.

**Pros:**
- Simplest implementation (~30-50 lines)
- No new processes, files, or infrastructure
- Agent always has context from the start

**Cons:**
- Stale data — tasks created/updated mid-conversation won't be reflected
- Token waste — task data is sent even when the user never asks about tasks
- Doesn't scale — 50+ tasks would consume significant context window
- No structured query capability — agent can't filter/search tasks
- Refreshing requires re-sending all task data (or a slash command)

**Implementation:**
```typescript
// In process-manager.service.ts sendMessage(), modify prompt construction:
if (sessionProcess.systemPrompt && !sessionProcess.systemPromptSent) {
  const tasks = await databaseService.getTasks(undefined, undefined, projectPath);
  const taskContext = formatTasksForPrompt(tasks);
  promptBlocks.push({ type: 'text', text: sessionProcess.systemPrompt + '\n\n' + taskContext });
  sessionProcess.systemPromptSent = true;
}
```

### Approach 2: MCP Server (Recommended)

**How it works:** Build a lightweight Node.js MCP server that exposes Castle task data as tools. The Copilot CLI spawns it as a child process and the agent calls its tools when needed.

**Pros:**
- Agent-driven — queries data only when the user asks about tasks
- No token waste — data only sent when requested
- Extensible — can add more Castle data sources (conversations, settings, agents) later
- Follows established MCP pattern already supported by the agent system
- Structured tools with parameters (filter by state, kind, search by title, etc.)
- Always up-to-date — reads database at query time

**Cons:**
- More complex setup (~200-300 lines)
- Requires solving the database access problem (MCP server runs as a separate process)
- New dependency: MCP SDK (`@modelcontextprotocol/sdk`)
- MCP server needs to be built/bundled and discoverable

**Database access challenge:** The MCP server runs as a child process of Copilot CLI, not Castle. It cannot call Castle's in-memory `DatabaseService` directly. Options:

| Option | How | Pros | Cons |
|--------|-----|------|------|
| **A. Read castle.db file directly** | MCP server uses `sql.js` to read the same SQLite file | Simple, no IPC needed | May read stale data (Castle uses 1s debounced save) |
| **B. JSON cache file** | Castle writes `tasks.json` on every task change; MCP reads it | No SQLite dependency | Extra file I/O; still slightly stale |
| **C. HTTP/WS bridge** | MCP server connects to Castle via WebSocket | Always fresh data | Complex; Castle needs a new endpoint |
| **D. Named pipe / Unix socket** | MCP server talks to Castle via IPC | Fresh data, low overhead | Platform-specific; complex |

**Recommended: Option A (direct SQLite read)**
- Castle already saves the database file to disk at `userData/castle.db`
- The debounce is 1 second — acceptable staleness for task listing
- `sql.js` is already a Castle dependency (no new package for SQLite)
- The MCP server opens the file in **read-only mode**, avoiding write conflicts
- Pass the database path via environment variable when registering the MCP server

### Approach 3: Hybrid (Prompt Augmentation + On-Demand)

**How it works:** Add task awareness to the system prompt ("You can ask the Castle system for task data"), then intercept messages that mention tasks and inject fresh data as embedded context.

**Pros:**
- More token-efficient than Approach 1
- Doesn't require external process like Approach 2
- Can use ACP's `ContentBlock::Resource` for structured data

**Cons:**
- Requires natural language detection (unreliable — "tasks" has many meanings)
- Still sends data per-message when detected (not agent-driven)
- Not extensible to other data sources without more detection logic
- Embedded context requires `PromptCapabilities.embeddedContext` support from agent

---

## Recommended Approach: MCP Server

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Castle (Electron)                        │
│                                                                  │
│  ┌──────────────┐     ┌──────────────────┐                      │
│  │  Database     │────▶│  castle.db file   │◀── read-only ──┐   │
│  │  Service      │     │  (userData/)       │                │   │
│  │  (in-memory)  │     └──────────────────┘                │   │
│  └──────────────┘                                          │   │
│                                                             │   │
│  ┌──────────────┐                                          │   │
│  │  Process      │─── spawn ──▶ copilot --acp --stdio      │   │
│  │  Manager      │                    │                     │   │
│  └──────────────┘                    │                     │   │
│                                       │ spawns mcpServers   │   │
│  Agent Config:                        │                     │   │
│  mcpServers: [{                       ▼                     │   │
│    name: "castle-tasks",    ┌──────────────────┐           │   │
│    command: "node",         │  castle-tasks     │───────────┘   │
│    args: ["mcp-server.js"], │  MCP Server       │               │
│    env: { DB_PATH: "..." }  │  (stdio)          │               │
│  }]                         └──────────────────┘               │
└─────────────────────────────────────────────────────────────────┘
```

### MCP Server Tool Definitions

```typescript
// Tools exposed by the castle-tasks MCP server:

// 1. List all tasks (with optional filters)
{
  name: "castle_list_tasks",
  description: "List Castle project tasks. Returns title, state, kind, labels, and metadata.",
  inputSchema: {
    type: "object",
    properties: {
      state: {
        type: "string",
        enum: ["new", "in_progress", "active", "blocked", "review", "done"],
        description: "Filter by task state (optional)"
      },
      kind: {
        type: "string",
        enum: ["feature", "bug", "chore", "spike"],
        description: "Filter by task kind (optional)"
      }
    }
  }
}

// 2. Get task details
{
  name: "castle_get_task",
  description: "Get detailed information about a specific Castle task by ID, including description, research content, branch, and PR status.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The task ID" }
    },
    required: ["taskId"]
  }
}

// 3. Search tasks by title/description
{
  name: "castle_search_tasks",
  description: "Search Castle tasks by keyword in title or description.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search term" }
    },
    required: ["query"]
  }
}

// 4. Get task summary/statistics
{
  name: "castle_task_summary",
  description: "Get a summary of Castle tasks: counts by state and kind, recent activity.",
  inputSchema: { type: "object", properties: {} }
}
```

### MCP Server Implementation

**File to create:** `src/main/mcp/castle-tasks-server.ts`

This will be a standalone Node.js script (bundled separately) that implements the MCP protocol:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import initSqlJs from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = process.env.CASTLE_DB_PATH;
if (!DB_PATH) {
  process.exit(1);
}

// Open database in read-only mode
async function openDatabase() {
  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(DB_PATH);
  return new SQL.Database(buffer);
}

// Re-read database on each tool call for freshness
async function queryTasks(state?: string, kind?: string): Promise<Task[]> {
  const db = await openDatabase();
  try {
    let sql = 'SELECT * FROM tasks';
    const conditions: string[] = [];
    const params: any[] = [];
    
    if (state) { conditions.push('state = ?'); params.push(state); }
    if (kind) { conditions.push('kind = ?'); params.push(kind); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY updated_at DESC';
    
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    
    const tasks: Task[] = [];
    while (stmt.step()) {
      tasks.push(rowToTask(stmt.getAsObject()));
    }
    stmt.free();
    return tasks;
  } finally {
    db.close();
  }
}

// Create MCP server
const server = new Server({ name: 'castle-tasks', version: '1.0.0' }, {
  capabilities: { tools: {} }
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'castle_list_tasks', description: '...', inputSchema: { ... } },
    { name: 'castle_get_task', description: '...', inputSchema: { ... } },
    { name: 'castle_search_tasks', description: '...', inputSchema: { ... } },
    { name: 'castle_task_summary', description: '...', inputSchema: { ... } },
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case 'castle_list_tasks': { /* query and return */ }
    case 'castle_get_task': { /* query by ID */ }
    case 'castle_search_tasks': { /* LIKE search */ }
    case 'castle_task_summary': { /* aggregate counts */ }
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
```

### Auto-Registration with Agents

Castle should automatically inject the `castle-tasks` MCP server into every agent's configuration, rather than requiring manual setup per-agent.

**File:** `src/main/services/process-manager.service.ts` (modify Lines 336-341)

```typescript
// Build MCP servers list: agent-defined + Castle built-in
const mcpServers = (agent.mcpServers || []).map(s => ({
  name: s.name,
  command: s.command,
  args: s.args || [],
  env: Object.entries(s.env || {}).map(([name, value]) => ({ name, value }))
}));

// Auto-inject Castle built-in MCP servers
const castleMcpServers = this.getCastleBuiltinMcpServers();
mcpServers.push(...castleMcpServers);
```

```typescript
private getCastleBuiltinMcpServers(): McpServer[] {
  const dbPath = this.databaseService.getDatabasePath();
  const serverScript = path.join(__dirname, 'mcp', 'castle-tasks-server.js');
  
  return [{
    name: 'castle-tasks',
    command: 'node',
    args: [serverScript],
    env: [
      { name: 'CASTLE_DB_PATH', value: dbPath }
    ]
  }];
}
```

### Build & Bundle Considerations

The MCP server script needs to be:
1. **Compiled separately** from the main Electron app (it runs as a standalone Node.js process)
2. **Bundled** into the Electron app's resources so the path is predictable
3. **sql.js** must be available to it (either bundled or installed separately)

**Options for bundling:**
- **Option A:** Bundle as a single-file script using esbuild/rollup, include `sql.js` WASM
- **Option B:** Ship as a separate `package.json` workspace with its own `node_modules`
- **Option C:** Use the same `node_modules` as the Electron app (simplest — `sql.js` is already installed)

**Recommended: Option C** for simplicity. The MCP server script lives in `src/main/mcp/` and is compiled alongside the main process code. It accesses `sql.js` from the shared `node_modules`.

---

## Step-by-Step Implementation Plan

### Phase 1: MCP Server Core

1. **Install MCP SDK dependency:**
   ```
   npm install @modelcontextprotocol/sdk
   ```

2. **Create the MCP server script:** `src/main/mcp/castle-tasks-server.ts`
   - Open castle.db in read-only mode via `sql.js`
   - Implement 4 tools: `castle_list_tasks`, `castle_get_task`, `castle_search_tasks`, `castle_task_summary`
   - Format task data as human-readable markdown for the agent

3. **Add build step** to compile the MCP server separately (or alongside main process code)

4. **Test standalone:** Run the MCP server manually, send JSON-RPC requests via stdin, verify responses

### Phase 2: Auto-Registration

5. **Modify `ProcessManagerService`** to inject the castle-tasks MCP server into every agent session
   - Add `getCastleBuiltinMcpServers()` method
   - Merge with agent-defined MCP servers before passing to `newSession()`

6. **Expose database path:** Add `getDatabasePath()` to `DatabaseService` (returns the file path)

7. **Ensure database is flushed** before MCP server reads:
   - Call `saveDatabase()` (force flush) when starting a session that includes built-in MCP servers
   - Or reduce the debounce to ~500ms for task-related writes

### Phase 3: Testing & Polish

8. **End-to-end test:** Start a conversation, ask "List my castle tasks", verify the agent calls `castle_list_tasks` and returns formatted results

9. **Add task-awareness to system prompt** (optional enhancement):
   ```
   You have access to Castle's task management system via the castle_list_tasks, castle_get_task, 
   castle_search_tasks, and castle_task_summary tools. Use these when the user asks about their 
   tasks, project status, or task details.
   ```

10. **Permission handling:** Decide whether the castle-tasks tools should auto-approve (no confirmation dialog) since they are read-only Castle-internal tools

### Phase 4: Extensions (Future)

11. **Write tools:** `castle_update_task`, `castle_create_task` — allow agents to modify tasks
12. **More data sources:** `castle_list_conversations`, `castle_get_agent_info`, `castle_get_settings`
13. **Notification-based refresh:** If the agent holds stale data, use `available_commands_update` to signal new tools

---

## Key Considerations

### 1. Database Freshness

The Castle main process uses `sql.js` with an **in-memory database** that flushes to disk with a **1-second debounce**. The MCP server reads the on-disk file.

**Risk:** If a user creates a task and immediately asks the agent to list it, the MCP server may read a stale file.

**Mitigations:**
- Force a `saveDatabase()` flush before starting agent sessions (ensures consistent state at session start)
- Accept 1-second eventual consistency for mid-session changes (acceptable UX)
- Future: implement a file-watch or IPC notification to invalidate cache

### 2. Concurrent Database Access

SQLite supports multiple readers. Since the MCP server only **reads** (no writes), there's no conflict with Castle's writer. `sql.js` opens the file as a buffer copy, so it won't even lock the file.

However, the MCP server re-reads the file on each tool call. This is a deliberate design choice:
- **Pro:** Always gets the latest saved state
- **Con:** Small overhead (~5-10ms to read and parse a typical castle.db)

For large databases, consider caching with a file-modified-time check:
```typescript
let cachedDb: Database | null = null;
let cachedMtime: number = 0;

function getDatabase(): Database {
  const stat = fs.statSync(DB_PATH);
  if (!cachedDb || stat.mtimeMs !== cachedMtime) {
    cachedDb?.close();
    const buffer = fs.readFileSync(DB_PATH);
    cachedDb = new SQL.Database(buffer);
    cachedMtime = stat.mtimeMs;
  }
  return cachedDb;
}
```

### 3. MCP Server Lifecycle

The Copilot CLI spawns MCP servers when a session starts and kills them when the session ends. Castle doesn't need to manage the MCP server lifecycle.

**Edge case:** If the castle.db path changes (e.g., user moves app data), the MCP server will fail. The environment variable is set at session start, so this is only an issue if the path changes mid-session (unlikely).

### 4. Tool Output Formatting

The agent receives tool results as text. Format task data as **concise markdown** for readability:

```typescript
function formatTaskList(tasks: Task[]): string {
  if (tasks.length === 0) return 'No tasks found.';
  
  const lines = tasks.map(t => {
    const labels = t.labels?.length ? ` [${t.labels.map(l => l.name).join(', ')}]` : '';
    const pr = t.prUrl ? ` | PR: ${t.prUrl}` : '';
    return `- **${t.title}** (${t.state}, ${t.kind})${labels}${pr}\n  ID: ${t.id}`;
  });
  
  return `## Castle Tasks (${tasks.length})\n\n${lines.join('\n')}`;
}

function formatTaskDetail(task: Task): string {
  return [
    `## ${task.title}`,
    `**State:** ${task.state} | **Kind:** ${task.kind}`,
    task.labels?.length ? `**Labels:** ${task.labels.map(l => l.name).join(', ')}` : '',
    `**Created:** ${task.createdAt} | **Updated:** ${task.updatedAt}`,
    '',
    '### Description',
    task.description || '(none)',
    task.branchName ? `\n**Branch:** ${task.branchName}` : '',
    task.worktreePath ? `**Worktree:** ${task.worktreePath}` : '',
    task.prUrl ? `**PR:** ${task.prUrl} (${task.prState})` : '',
    task.researchContent ? `\n### Research\n${task.researchContent.substring(0, 2000)}` : '',
  ].filter(Boolean).join('\n');
}
```

### 5. Permission Auto-Approval

Castle's permission system gates tool calls through user confirmation dialogs. For Castle-internal read-only tools, auto-approval makes sense:

**File:** `src/main/ipc/index.ts` (Lines 193-219, permission handling)

The permission resolver checks `getPermissionGrantsByToolKind()`. Castle could:
- Pre-grant permissions for `castle_*` tools at session start
- Or add a special case in the permission resolver to auto-approve `castle-tasks` tool calls

```typescript
// In permission request handler:
if (toolKind.startsWith('castle_')) {
  // Auto-approve Castle internal tools (read-only)
  return { granted: true };
}
```

### 6. Project Path Scoping

Tasks are scoped to a `projectPath`. The MCP server should filter by the project that the agent is currently working in.

**Solution:** Pass the project path as an additional environment variable:
```typescript
env: [
  { name: 'CASTLE_DB_PATH', value: dbPath },
  { name: 'CASTLE_PROJECT_PATH', value: workingDirectory }
]
```

The MCP server uses this as a default filter for `castle_list_tasks`:
```typescript
// Default filter: only show tasks for the current project
const defaultProjectPath = process.env.CASTLE_PROJECT_PATH;
if (!args.allProjects && defaultProjectPath) {
  conditions.push('project_path = ?');
  params.push(defaultProjectPath);
}
```

---

## Edge Cases

| Edge Case | Handling |
|-----------|----------|
| No castle.db file exists yet | MCP server returns empty results gracefully |
| castle.db is being written when MCP reads | sql.js reads a buffer copy — no conflict |
| Agent asks about tasks before any exist | Return "No tasks found" message |
| Task has very long description/research | Truncate to ~2000 chars in tool response |
| MCP server crashes | Copilot CLI handles respawn; agent sees tool error |
| Multiple projects open | Filter by `CASTLE_PROJECT_PATH` env var |
| User asks to create/modify tasks | Phase 4 — initially read-only tools only |
| Database schema changes | MCP server should handle missing columns gracefully |
| Agent calls tool repeatedly in one turn | Each call re-reads DB — fresh data each time |

---

## File References

### Files to Create

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `src/main/mcp/castle-tasks-server.ts` | MCP server with 4 tools | ~200-250 |
| `src/shared/types/mcp.types.ts` | Types for Castle built-in MCP servers (optional) | ~20 |

### Files to Modify

| File | Changes | Est. Lines |
|------|---------|-----------|
| `src/main/services/process-manager.service.ts` | Add `getCastleBuiltinMcpServers()`, merge into mcpServers list (Lines 336-341) | ~25-30 |
| `src/main/services/database.service.ts` | Add `getDatabasePath()` method, force flush on session start | ~10 |
| `src/main/ipc/index.ts` | Auto-approve castle_ tool permissions (Lines 193-219) | ~5-10 |
| `package.json` | Add `@modelcontextprotocol/sdk` dependency | ~1 |
| `tsconfig.json` or build config | Ensure MCP server is compiled/bundled | ~5 |

### Files for Reference

| File | Why |
|------|-----|
| `src/shared/types/task.types.ts` | Task interface definition |
| `src/shared/types/agent.types.ts` | MCPServerConfig interface |
| `src/main/services/agent-discovery.service.ts` | Pattern for agent configuration |
| `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts` | McpServer, McpServerStdio types |

---

## Complexity Estimate

| Phase | Effort | Risk |
|-------|--------|------|
| Phase 1: MCP Server core (4 tools) | ~200-250 lines, 1 new file | Low — MCP SDK is well-documented |
| Phase 2: Auto-registration | ~40-50 lines, 3 modified files | Low — follows existing pattern |
| Phase 3: Testing & polish | ~20 lines + manual testing | Low |
| Phase 4: Write tools (future) | ~100-150 lines | Medium — needs careful permission handling |
| **Total (Phases 1-3)** | **~270-320 lines, 1 new + 3 modified** | **Low-Medium** |

### Dependencies
- **New:** `@modelcontextprotocol/sdk` — Official MCP SDK for building servers
- **Existing:** `sql.js` — Already installed, used for read-only DB access in MCP server

---

## Recommended Implementation Order

1. **Install `@modelcontextprotocol/sdk`** — add to package.json
2. **Add `getDatabasePath()` to DatabaseService** — expose the castle.db file path
3. **Build the MCP server** (`castle-tasks-server.ts`) — implement all 4 read tools
4. **Test standalone** — verify the MCP server responds to JSON-RPC tool calls
5. **Auto-inject into agent sessions** — modify `ProcessManagerService.startSession()`
6. **Auto-approve permissions** — add castle_ tool auto-grant in IPC permission handler
7. **End-to-end test** — ask an agent "List my Castle tasks" and verify
8. **Optional: Enhance system prompt** — add a line about task tool availability
9. **Future: Write tools** — `castle_update_task`, `castle_create_task`
10. **Future: More data sources** — conversations, agents, settings
