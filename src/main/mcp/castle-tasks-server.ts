/**
 * Castle Tasks MCP Server
 *
 * A lightweight MCP (Model Context Protocol) server that exposes Castle's task
 * data as tools for agents. Reads the castle.db SQLite file directly using sql.js.
 *
 * Communicates via JSON-RPC 2.0 over stdio (stdin/stdout).
 *
 * Environment variables:
 *   CASTLE_DB_PATH      — Path to the castle.db SQLite file (required)
 *   CASTLE_PROJECT_PATH — Default project path filter (optional)
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as fs from 'fs';

// ── Types ──────────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  title: string;
  description: string;
  state: string;
  kind: string;
  project_path: string | null;
  research_content: string | null;
  research_agent_id: string | null;
  implement_agent_id: string | null;
  github_issue_number: number | null;
  github_repo: string | null;
  close_reason: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  pr_url: string | null;
  pr_number: number | null;
  pr_state: string | null;
  created_at: string;
  updated_at: string;
}

interface LabelRow {
  id: string;
  name: string;
  color: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

// ── Configuration ──────────────────────────────────────────────────────────────

const DB_PATH = process.env.CASTLE_DB_PATH;
const DEFAULT_PROJECT_PATH = process.env.CASTLE_PROJECT_PATH;

if (!DB_PATH) {
  process.stderr.write('CASTLE_DB_PATH environment variable is required\n');
  process.exit(1);
}

// ── Database helpers ───────────────────────────────────────────────────────────

let cachedMtimeMs = 0;
let cachedDb: SqlJsDatabase | null = null;
let sqlPromise: ReturnType<typeof initSqlJs> | null = null;

async function getSQL() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs();
  }
  return sqlPromise;
}

/** Re-read the database file when it has been modified on disk. */
async function getDatabase(): Promise<SqlJsDatabase | null> {
  if (!fs.existsSync(DB_PATH!)) return null;

  const stat = fs.statSync(DB_PATH!);
  if (cachedDb && stat.mtimeMs === cachedMtimeMs) return cachedDb;

  const SQL = await getSQL();
  const buffer = fs.readFileSync(DB_PATH!);
  cachedDb?.close();
  cachedDb = new SQL.Database(buffer);
  cachedMtimeMs = stat.mtimeMs;
  return cachedDb;
}

function getLabelsForTask(db: SqlJsDatabase, taskId: string): LabelRow[] {
  const labels: LabelRow[] = [];
  const stmt = db.prepare(
    `SELECT l.id, l.name, l.color
     FROM task_labels l
     INNER JOIN task_label_assignments a ON a.label_id = l.id
     WHERE a.task_id = ?`
  );
  stmt.bind([taskId]);
  while (stmt.step()) {
    labels.push(stmt.getAsObject() as unknown as LabelRow);
  }
  stmt.free();
  return labels;
}

// ── Tool implementations ───────────────────────────────────────────────────────

async function listTasks(args: { state?: string; kind?: string; allProjects?: boolean }): Promise<string> {
  const db = await getDatabase();
  if (!db) return 'No Castle database found.';

  let sql = `SELECT id, title, description, state, kind, project_path, branch_name, pr_url, pr_state, created_at, updated_at
             FROM tasks`;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (args.state) { conditions.push('state = ?'); params.push(args.state); }
  if (args.kind) { conditions.push('kind = ?'); params.push(args.kind); }
  if (!args.allProjects && DEFAULT_PROJECT_PATH) {
    conditions.push('project_path = ?');
    params.push(DEFAULT_PROJECT_PATH);
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY updated_at DESC';

  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);

  const lines: string[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as TaskRow;
    const labels = getLabelsForTask(db, row.id);
    const labelStr = labels.length ? ` [${labels.map(l => l.name).join(', ')}]` : '';
    const pr = row.pr_url ? ` | PR: ${row.pr_url} (${row.pr_state || 'unknown'})` : '';
    const branch = row.branch_name ? ` | Branch: ${row.branch_name}` : '';
    lines.push(`- **${row.title}** (${row.state}, ${row.kind})${labelStr}${branch}${pr}\n  ID: \`${row.id}\``);
  }
  stmt.free();

  if (lines.length === 0) return 'No tasks found.';
  return `## Castle Tasks (${lines.length})\n\n${lines.join('\n')}`;
}

async function getTask(args: { taskId: string }): Promise<string> {
  const db = await getDatabase();
  if (!db) return 'No Castle database found.';

  const stmt = db.prepare(
    `SELECT id, title, description, state, kind, project_path, research_content,
            research_agent_id, implement_agent_id, github_issue_number, github_repo,
            close_reason, worktree_path, branch_name, pr_url, pr_number, pr_state,
            created_at, updated_at
     FROM tasks WHERE id = ?`
  );
  stmt.bind([args.taskId]);

  if (!stmt.step()) { stmt.free(); return `Task not found: ${args.taskId}`; }
  const row = stmt.getAsObject() as unknown as TaskRow;
  stmt.free();

  const labels = getLabelsForTask(db, row.id);

  const parts: string[] = [
    `## ${row.title}`,
    `**State:** ${row.state} | **Kind:** ${row.kind}`,
  ];
  if (labels.length) parts.push(`**Labels:** ${labels.map(l => l.name).join(', ')}`);
  parts.push(`**Created:** ${row.created_at} | **Updated:** ${row.updated_at}`);
  parts.push('');
  parts.push('### Description');
  parts.push(row.description || '(none)');
  if (row.branch_name) parts.push(`\n**Branch:** ${row.branch_name}`);
  if (row.worktree_path) parts.push(`**Worktree:** ${row.worktree_path}`);
  if (row.pr_url) parts.push(`**PR:** ${row.pr_url} (${row.pr_state || 'unknown'})`);
  if (row.github_issue_number && row.github_repo) {
    parts.push(`**GitHub Issue:** ${row.github_repo}#${row.github_issue_number}`);
  }
  if (row.research_content) {
    const truncated = row.research_content.length > 2000
      ? row.research_content.substring(0, 2000) + '\n\n...(truncated)'
      : row.research_content;
    parts.push(`\n### Research\n${truncated}`);
  }

  return parts.join('\n');
}

async function searchTasks(args: { query: string }): Promise<string> {
  const db = await getDatabase();
  if (!db) return 'No Castle database found.';

  const stmt = db.prepare(
    `SELECT id, title, description, state, kind, branch_name, pr_url, pr_state, created_at, updated_at
     FROM tasks
     WHERE title LIKE ? OR description LIKE ?
     ORDER BY updated_at DESC`
  );
  const pattern = `%${args.query}%`;
  stmt.bind([pattern, pattern]);

  const lines: string[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as TaskRow;
    const labels = getLabelsForTask(db, row.id);
    const labelStr = labels.length ? ` [${labels.map(l => l.name).join(', ')}]` : '';
    lines.push(`- **${row.title}** (${row.state}, ${row.kind})${labelStr}\n  ID: \`${row.id}\``);
  }
  stmt.free();

  if (lines.length === 0) return `No tasks matching "${args.query}".`;
  return `## Search Results for "${args.query}" (${lines.length})\n\n${lines.join('\n')}`;
}

async function taskSummary(): Promise<string> {
  const db = await getDatabase();
  if (!db) return 'No Castle database found.';

  // Counts by state
  const stateStmt = db.prepare(`SELECT state, COUNT(*) as count FROM tasks GROUP BY state ORDER BY count DESC`);
  const stateCounts: string[] = [];
  let total = 0;
  while (stateStmt.step()) {
    const row = stateStmt.getAsObject() as { state: string; count: number };
    stateCounts.push(`  - ${row.state}: ${row.count}`);
    total += row.count;
  }
  stateStmt.free();

  // Counts by kind
  const kindStmt = db.prepare(`SELECT kind, COUNT(*) as count FROM tasks GROUP BY kind ORDER BY count DESC`);
  const kindCounts: string[] = [];
  while (kindStmt.step()) {
    const row = kindStmt.getAsObject() as { kind: string; count: number };
    kindCounts.push(`  - ${row.kind}: ${row.count}`);
  }
  kindStmt.free();

  // Recently updated
  const recentStmt = db.prepare(`SELECT title, state, kind, updated_at FROM tasks ORDER BY updated_at DESC LIMIT 5`);
  const recent: string[] = [];
  while (recentStmt.step()) {
    const row = recentStmt.getAsObject() as { title: string; state: string; kind: string; updated_at: string };
    recent.push(`  - ${row.title} (${row.state}) — updated ${row.updated_at}`);
  }
  recentStmt.free();

  const parts: string[] = [
    `## Castle Task Summary`,
    `**Total tasks:** ${total}`,
    '',
    '### By State',
    ...stateCounts,
    '',
    '### By Kind',
    ...kindCounts,
  ];

  if (recent.length) {
    parts.push('', '### Recently Updated', ...recent);
  }

  return parts.join('\n');
}

// ── MCP Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'castle_list_tasks',
    description: 'List Castle project tasks. Returns title, state, kind, labels, and metadata for each task.',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['new', 'in_progress', 'active', 'blocked', 'review', 'done'],
          description: 'Filter by task state (optional)',
        },
        kind: {
          type: 'string',
          enum: ['feature', 'bug', 'chore', 'spike'],
          description: 'Filter by task kind (optional)',
        },
        allProjects: {
          type: 'boolean',
          description: 'If true, show tasks from all projects instead of just the current one (optional)',
        },
      },
    },
  },
  {
    name: 'castle_get_task',
    description: 'Get detailed information about a specific Castle task by ID, including description, research content, branch, and PR status.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'castle_search_tasks',
    description: 'Search Castle tasks by keyword in title or description.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term to match against task title and description' },
      },
      required: ['query'],
    },
  },
  {
    name: 'castle_task_summary',
    description: 'Get a summary of Castle tasks: total count, counts by state and kind, and recently updated tasks.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── JSON-RPC / MCP protocol handler ────────────────────────────────────────────

function jsonRpcResponse(id: number | string, result: any) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: number | string | null, code: number, message: string) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(request: JsonRpcRequest): Promise<string> {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      return jsonRpcResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'castle-tasks', version: '1.0.0' },
      });

    case 'notifications/initialized':
      // No response needed for notifications
      return '';

    case 'tools/list':
      return jsonRpcResponse(id, { tools: TOOLS });

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      try {
        let result: string;
        switch (toolName) {
          case 'castle_list_tasks':
            result = await listTasks(toolArgs);
            break;
          case 'castle_get_task':
            result = await getTask(toolArgs);
            break;
          case 'castle_search_tasks':
            result = await searchTasks(toolArgs);
            break;
          case 'castle_task_summary':
            result = await taskSummary();
            break;
          default:
            return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
        }
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: result }],
        });
      } catch (err: any) {
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }

    case 'ping':
      return jsonRpcResponse(id, {});

    default:
      // Ignore unknown notifications (method names starting with notifications/)
      if (method.startsWith('notifications/')) return '';
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ── stdio transport ────────────────────────────────────────────────────────────

function startServer() {
  let buffer = Buffer.alloc(0);
  let processing = false;

  async function processBuffer() {
    if (processing) return;
    processing = true;

    try {
      while (true) {
        // Find header/body separator
        const separatorIndex = buffer.indexOf('\r\n\r\n');
        if (separatorIndex === -1) break;

        const header = buffer.subarray(0, separatorIndex).toString('utf-8');
        const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
        if (!contentLengthMatch) {
          // Skip malformed header
          buffer = buffer.subarray(separatorIndex + 4);
          continue;
        }

        const contentLength = parseInt(contentLengthMatch[1], 10);
        const bodyStart = separatorIndex + 4;

        if (buffer.length < bodyStart + contentLength) break; // wait for more data

        const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf-8');
        buffer = buffer.subarray(bodyStart + contentLength);

        try {
          const request = JSON.parse(body) as JsonRpcRequest;
          const response = await handleRequest(request);
          if (response) {
            const responseBytes = Buffer.byteLength(response, 'utf-8');
            process.stdout.write(`Content-Length: ${responseBytes}\r\n\r\n${response}`);
          }
        } catch (err: any) {
          const errResponse = jsonRpcError(null, -32700, `Parse error: ${err.message}`);
          const errBytes = Buffer.byteLength(errResponse, 'utf-8');
          process.stdout.write(`Content-Length: ${errBytes}\r\n\r\n${errResponse}`);
        }
      }
    } finally {
      processing = false;
    }
  }

  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    processBuffer();
  });

  process.stdin.on('end', () => {
    cachedDb?.close();
    process.exit(0);
  });
}

startServer();
