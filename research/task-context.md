# Research: Task Context Tool for Agents

## Summary

This document analyzes how to build a **context tool/skill** that Castle agents can use to read the status of tasks from the Castle database. The goal: when a user asks an agent "List my current castle tasks", the agent can query the task database and return a formatted summary — no human intervention, no copy-pasting, no separate UI tab required.

---

## Current Architecture

### How Agents Run

Castle agents are Copilot CLI child processes managed via the **Agent Client Protocol (ACP)** (`@agentclientprotocol/sdk ^0.14.1`). The flow:

1. `ProcessManagerService` spawns `copilot --acp --stdio` with an optional `--model` flag.
2. An ACP `ClientSideConnection` is created over the child's stdin/stdout.
3. `connection.newSession()` is called with `{ cwd, mcpServers }`.
4. Messages are sent via `connection.prompt()`.

Key detail: ACP's `newSession` accepts an `mcpServers` array. This is already wired up in `process-manager.service.ts:268-274`:

```typescript
const mcpServers = (agent.mcpServers || []).map(s => ({
  name: s.name,
  command: s.command,
  args: s.args || [],
  env: Object.entries(s.env || {}).map(([name, value]) => ({ name, value }))
}));
```

These MCP servers become tools the Copilot agent can call autonomously during a conversation.

### How Tasks Are Stored

Tasks live in a SQLite database (via sql.js) with this schema:

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `title` | TEXT | Required |
| `description` | TEXT | Defaults to `''` |
| `state` | TEXT | `new`, `active`, `in_progress`, `blocked`, `done` |
| `kind` | TEXT | `feature`, `bug`, `chore`, `spike` |
| `project_path` | TEXT | Scoped to workspace |
| `research_content` | TEXT | Nullable |
| `research_agent_id` | TEXT | Nullable |
| `implement_agent_id` | TEXT | Nullable |
| `github_issue_number` | INTEGER | Nullable |
| `github_repo` | TEXT | Nullable |
| `close_reason` | TEXT | For bugs: `fixed`, `no_repro`, `wont_fix`, `duplicate` |
| `created_at` | DATETIME | Auto-set |
| `updated_at` | DATETIME | Auto-updated |

Related tables: `task_labels`, `task_label_assignments`, `research_reviews`.

### Existing IPC Task Channels

Task operations are already exposed as IPC handlers (in `src/main/ipc/index.ts`) and registered in the shared `ipcHandlerRegistry`:

| Channel | Purpose |
|---------|---------|
| `tasks:getAll` | List tasks (filter by state, kind, project_path) |
| `tasks:get` | Get single task by ID |
| `tasks:create` | Create a new task |
| `tasks:update` | Update task fields |
| `tasks:delete` | Delete a task |
| `tasks:labels:getAll` | List all labels |

These handlers are accessible from both Electron IPC and the WebSocket bridge (`WsBridgeService`), meaning they work for local and remote (Tailscale) clients.

---

## Proposed Approach: MCP Server for Castle Tasks

The cleanest and most architecturally consistent approach is to build a **local MCP (Model Context Protocol) server** that exposes Castle task data as tools the Copilot agent can call.

### Why MCP?

1. **Already supported** — The `Agent.mcpServers` field and the ACP session creation already wire MCP servers to agents. No new protocol work needed.
2. **Agent-native** — MCP tools appear as first-class callable tools to the agent. When the user asks "list my tasks", the agent can autonomously call the tool.
3. **Standard protocol** — MCP is the emerging standard for tool integration with LLM agents. Keeps Castle aligned with the ecosystem.
4. **Decoupled** — The MCP server runs as a separate process, doesn't pollute the main process, and can be reused by workspace-level agents too.

### Alternative Approaches Considered

| Approach | Pros | Cons |
|----------|------|------|
| **System prompt injection** — Fetch tasks and inject them into the agent's system prompt or first message | Simple, no new infrastructure | Stale data; can't refresh; bloats context; doesn't scale |
| **Custom ACP extension** — Add task-query methods to the ACP protocol | Tight integration | Requires Copilot CLI changes; not feasible with external CLI |
| **Chat-side pre-processing** — Intercept user messages, detect task-related queries, inject data before sending to agent | No agent changes | Fragile NLP parsing; agent doesn't know it has this ability; breaks conversational flow |
| **MCP Server** ✅ | Native tool support; agent self-discovers capabilities; standard protocol; already plumbed | Requires building a small MCP server process |

---

## Technical Design

### Component: `castle-mcp-server`

A small Node.js script (shipped with Castle) that implements the MCP stdio transport and exposes Castle task tools.

#### Communication Path

```
Copilot CLI (agent)
    ↕ ACP (stdio)
Castle ProcessManager
    → spawns agent with mcpServers config
        → Copilot CLI spawns castle-mcp-server as child
            ↕ MCP (stdio)
            castle-mcp-server
                → reads castle.db (or calls IPC handlers)
```

#### Option A: Direct Database Access

The MCP server reads `castle.db` directly using sql.js (same library the main process uses).

**Pros:** Simple, no IPC dependencies, fast.
**Cons:** Concurrent SQLite access risk (sql.js loads entire DB into memory — two readers is fine, but writes from main process won't be seen until MCP server re-reads). Need to pass the DB path as an environment variable.

#### Option B: IPC Proxy via HTTP/WebSocket

The MCP server calls back to Castle's main process via the WebSocket bridge (same mechanism the remote browser UI uses).

**Pros:** Always-fresh data; single source of truth; can reuse existing task handlers.
**Cons:** Requires the Tailscale/WS server to be running locally (or a new lightweight HTTP endpoint). Adds network hop latency.

#### Recommended: Option A (Direct DB Read) with Periodic Re-read

For a read-only context tool, direct DB access is simpler and sufficient. The MCP server can re-read the database file on each tool invocation to get fresh data. sql.js loads the full file into memory, so each invocation is a clean snapshot.

### MCP Tool Definitions

The MCP server should expose the following tools:

#### 1. `castle_list_tasks`

**Description:** List Castle tasks for the current project, optionally filtered by state or kind.

**Parameters:**
```json
{
  "state": { "type": "string", "enum": ["new", "active", "in_progress", "blocked", "done"], "description": "Filter by task state" },
  "kind": { "type": "string", "enum": ["feature", "bug", "chore", "spike"], "description": "Filter by task kind" },
  "include_done": { "type": "boolean", "description": "Include completed tasks (default: false)" }
}
```

**Returns:** JSON array of task summaries:
```json
[
  {
    "id": "uuid",
    "title": "Add dark mode support",
    "state": "in_progress",
    "kind": "feature",
    "labels": ["UI", "theme"],
    "description": "...",
    "createdAt": "2026-02-10T...",
    "updatedAt": "2026-02-15T..."
  }
]
```

#### 2. `castle_get_task`

**Description:** Get full details of a specific Castle task by ID or title search.

**Parameters:**
```json
{
  "taskId": { "type": "string", "description": "Task UUID" },
  "search": { "type": "string", "description": "Search by title (fuzzy match)" }
}
```

**Returns:** Full task object including description, research content, labels, and GitHub issue link.

#### 3. `castle_task_summary`

**Description:** Get a high-level summary of all Castle tasks (counts by state and kind).

**Parameters:** None.

**Returns:**
```json
{
  "total": 12,
  "byState": { "new": 3, "active": 2, "in_progress": 4, "blocked": 1, "done": 2 },
  "byKind": { "feature": 6, "bug": 4, "chore": 1, "spike": 1 }
}
```

### File Structure

```
src/
  mcp/
    castle-tasks-server.ts    # MCP server entry point
    tools/
      list-tasks.ts           # castle_list_tasks implementation
      get-task.ts             # castle_get_task implementation
      task-summary.ts         # castle_task_summary implementation
    db-reader.ts              # Read-only sql.js database access
```

### Wiring Into Agent Config

The MCP server needs to be registered as an MCP server on each agent. Two approaches:

#### Approach 1: Auto-inject at Session Creation (Recommended)

Modify `ProcessManagerService.startSession()` to always include the Castle tasks MCP server in the `mcpServers` array passed to `connection.newSession()`:

```typescript
// In process-manager.service.ts, startSession():
const castleMcpServer = {
  name: 'castle-tasks',
  command: 'node',
  args: [path.join(__dirname, '..', 'mcp', 'castle-tasks-server.js')],
  env: [
    { name: 'CASTLE_DB_PATH', value: this.dbPath },
    { name: 'CASTLE_PROJECT_PATH', value: workingDirectory }
  ]
};

const mcpServers = [
  castleMcpServer,
  ...(agent.mcpServers || []).map(s => ({
    name: s.name,
    command: s.command,
    args: s.args || [],
    env: Object.entries(s.env || {}).map(([name, value]) => ({ name, value }))
  }))
];
```

**Pros:** All agents automatically get task context. No config changes needed.
**Cons:** Agents that don't need task context still have the tool registered (harmless — they just won't call it).

#### Approach 2: Agent Config in AGENTS.md

Add the MCP server to specific agent configs:

```yaml
- name: General Assistant
  icon: 🤖
  mcpServers:
    - name: castle-tasks
      command: node
      args: ["<path>/castle-tasks-server.js"]
```

**Pros:** Granular control.
**Cons:** User must configure it; breaks when paths change; doesn't work for builtin agents without code changes.

### Implementation Guidance

#### Step 1: Create the MCP Server

Use the `@modelcontextprotocol/sdk` package (standard MCP SDK for TypeScript):

```typescript
// src/mcp/castle-tasks-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({
  name: 'castle-tasks',
  version: '1.0.0'
}, {
  capabilities: { tools: {} }
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'castle_list_tasks',
      description: 'List Castle project tasks, optionally filtered by state or kind',
      inputSchema: { /* ... */ }
    },
    // ... other tools
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case 'castle_list_tasks':
      return await listTasks(request.params.arguments);
    // ... other tools
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

#### Step 2: Implement the DB Reader

```typescript
// src/mcp/db-reader.ts
import initSqlJs from 'sql.js';
import * as fs from 'fs';

export class CastleDbReader {
  constructor(private dbPath: string) {}

  async getTasks(filters: { state?: string; kind?: string; projectPath?: string }): Promise<Task[]> {
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(this.dbPath);
    const db = new SQL.Database(buffer);
    // ... query and return
    db.close();
  }
}
```

Re-reading the file on each invocation ensures fresh data without write conflicts.

#### Step 3: Wire Into ProcessManagerService

Pass the Castle DB path and project path as environment variables when spawning the MCP server. Modify `startSession()` to auto-inject the castle-tasks MCP server.

Key details:
- The DB path is `app.getPath('userData') + '/castle.db'` — needs to be passed from `DatabaseService` to `ProcessManagerService`.
- The project path comes from `DirectoryService.getCurrentDirectory()`.
- The MCP server JS file path depends on whether running in dev or production (use `process.resourcesPath` vs `__dirname`).

#### Step 4: Build Configuration

Add the MCP server to the build pipeline:
- Compile `src/mcp/castle-tasks-server.ts` to JS (can be a separate tsconfig target or bundled with the main process).
- Ensure the compiled file is included in the Electron app resources.

#### Step 5: Update Agent System Prompts (Optional)

Add a hint to agent system prompts so they know they have task access:

```
You have access to Castle task management tools. When the user asks about 
their tasks, use the castle_list_tasks, castle_get_task, or castle_task_summary 
tools to query the task database.
```

This is optional — MCP tools are self-describing, and modern models will discover and use them based on the tool descriptions alone.

---

## Considerations

### Read-Only vs Read-Write

Starting with **read-only** tools is safer and simpler:
- No risk of agents accidentally modifying task state.
- No permission model complexity.
- Satisfies the core use case: "list my tasks", "what's my current workload?", "show me blocked tasks".

Future write operations (create task, update state, add labels) can be added incrementally with appropriate permission gates.

### Performance

- sql.js loads the entire DB into memory (~KB to low MB range for typical task counts). Reading is fast.
- Each MCP tool call re-reads the file: ~5-10ms overhead. Negligible for interactive use.
- No persistent connection or long-running process beyond the MCP server lifetime (tied to agent session).

### Security

- The MCP server only has access to the Castle database file (read-only).
- No network access needed.
- Database path is passed via environment variable, not hardcoded.
- The MCP server runs with the same user privileges as Castle.

### Project Path Scoping

Tasks in Castle are scoped by `project_path`. The MCP server should filter tasks to the current workspace by default (matching the behavior of `TASKS_GET_ALL` in the IPC handler).

### Cross-Device Sync Caveat

If the user is accessing Castle from a remote browser (via Tailscale), the MCP server runs on the host machine and reads the local database. This is correct behavior — the host has the authoritative database.

### Packaging

The MCP server script needs to be distributed with the Electron app:
- **Dev:** Reference via relative path from the project root.
- **Production:** Include in the `resources/` directory or bundle with the main process code.

The `sql.js` WASM binary also needs to be accessible to the MCP server process. Since it's already a dependency, this should work out of the box when the server is spawned as a Node.js child process.

---

## Implementation Phases

### Phase 1: Core Read-Only MCP Server
- Create `castle-tasks-server.ts` with `castle_list_tasks`, `castle_get_task`, `castle_task_summary`.
- Create `db-reader.ts` with read-only sql.js access.
- Auto-inject into agent sessions via `ProcessManagerService`.
- Test with "List my current tasks" in any agent chat.

### Phase 2: Enhanced Querying
- Add filtering by label, date range, and search.
- Add `castle_list_labels` tool.
- Support natural language queries like "show me bugs created this week".

### Phase 3: Write Operations (Optional)
- Add `castle_create_task`, `castle_update_task` tools.
- Gate behind Castle's existing permission system.
- Allow agents to create tasks from conversation context (e.g., "create a bug for the issue we just discussed").

---

## Key Files to Modify

| File | Change |
|------|--------|
| `src/mcp/castle-tasks-server.ts` | **New** — MCP server entry point |
| `src/mcp/db-reader.ts` | **New** — Read-only DB access |
| `src/main/services/process-manager.service.ts` | Inject castle-tasks MCP server into `startSession()` |
| `src/main/services/database.service.ts` | Expose `dbPath` getter for use by process manager |
| `src/shared/types/agent.types.ts` | Already has `mcpServers` field — no change needed |
| `package.json` | Add `@modelcontextprotocol/sdk` dependency |
| `tsconfig.json` (or new `tsconfig.mcp.json`) | Build target for MCP server |
| `resources/agents.md` | Optionally add system prompt hints about task tools |

---

## Summary

Building a Castle Tasks MCP server is the most architecturally clean solution. It leverages existing infrastructure (ACP's MCP server support, the sql.js database, the agent session lifecycle) while adding minimal new code. The MCP server reads the database directly, runs as a child process of the Copilot CLI agent, and exposes three simple tools that let any agent answer task-related questions naturally.
