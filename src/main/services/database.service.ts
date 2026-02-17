/**
 * Database Service - SQLite persistence layer using sql.js
 * sql.js is a pure JavaScript implementation that doesn't require native compilation
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from './logger.service';

const log = createLogger('Database');
import { 
  AppSettings, 
  DEFAULT_SETTINGS, 
  PermissionSet, 
  DEFAULT_PERMISSIONS,
  PermissionGrant,
  WindowBounds 
} from '../../shared/types';
import { ChatMessage, MessageRole } from '../../shared/types/message.types';
import { Agent } from '../../shared/types/agent.types';
import { Conversation, CreateConversationInput, UpdateConversationInput } from '../../shared/types/conversation.types';
import { Task, TaskState, TaskKind, TaskLabel, TaskPRState, CreateTaskInput, UpdateTaskInput, BugCloseReason, ResearchReview, ResearchComment } from '../../shared/types/task.types';

/** Parse a date string from SQLite as UTC, handling both ISO 8601 (with Z) and SQLite datetime() (without Z) formats. */
function parseUtcDate(dateStr: string): Date {
  if (dateStr.endsWith('Z') || dateStr.includes('+') || dateStr.includes('T')) {
    return new Date(dateStr);
  }
  // SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' in UTC but without timezone indicator.
  // Appending 'Z' ensures it's parsed as UTC rather than local time.
  return new Date(dateStr + 'Z');
}

export class DatabaseService {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.dbPath = path.join(userDataPath, 'castle.db');
  }

  async initialize(): Promise<void> {
    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Initialize sql.js
    const SQL = await initSqlJs();

    // Load existing database or create new one
    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
    } else {
      this.db = new SQL.Database();
    }
    
    // Run migrations
    this.runMigrations();
    
    // Save to persist schema
    this.saveDatabase();
    
    log.info(`Database initialized at: ${this.dbPath}`);
  }

  private runMigrations(): void {
    if (!this.db) throw new Error('Database not initialized');

    // Create tables
    this.db.run(`
      -- Agents table
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        icon TEXT,
        color TEXT,
        system_prompt TEXT,
        source TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`
      -- Messages table
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);

    this.db.run(`
      -- Permissions table
      CREATE TABLE IF NOT EXISTS permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        permission_type TEXT NOT NULL,
        granted INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(agent_id, permission_type)
      )
    `);

    this.db.run(`
      -- Settings table
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`
      -- Recent directories table
      CREATE TABLE IF NOT EXISTS recent_directories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        last_opened DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_permissions_agent_id ON permissions(agent_id)`);

    // Task tables
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'new',
        research_content TEXT,
        research_agent_id TEXT,
        github_issue_number INTEGER,
        github_repo TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_labels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL DEFAULT '#6b7280'
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_label_assignments (
        task_id TEXT NOT NULL,
        label_id TEXT NOT NULL,
        PRIMARY KEY (task_id, label_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (label_id) REFERENCES task_labels(id) ON DELETE CASCADE
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at)`);

    // Migration: add research columns if missing
    try {
      this.db.run(`ALTER TABLE tasks ADD COLUMN research_content TEXT`);
    } catch { /* column already exists */ }
    try {
      this.db.run(`ALTER TABLE tasks ADD COLUMN research_agent_id TEXT`);
    } catch { /* column already exists */ }

    // Migration: add kind column if missing
    try {
      this.db.run(`ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'feature'`);
    } catch { /* column already exists */ }
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind)`);

    // Migration: add project_path column if missing
    try {
      this.db.run(`ALTER TABLE tasks ADD COLUMN project_path TEXT`);
    } catch { /* column already exists */ }
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_project_path ON tasks(project_path)`);

    // Migration: add close_reason column if missing
    try {
      this.db.run(`ALTER TABLE tasks ADD COLUMN close_reason TEXT`);
    } catch { /* column already exists */ }

    // Migration: add implement_agent_id column if missing
    try {
      this.db.run(`ALTER TABLE tasks ADD COLUMN implement_agent_id TEXT`);
    } catch { /* column already exists */ }

    // Migration: add worktree columns if missing
    try {
      this.db.run(`ALTER TABLE tasks ADD COLUMN worktree_path TEXT`);
    } catch { /* column already exists */ }
    try {
      this.db.run(`ALTER TABLE tasks ADD COLUMN branch_name TEXT`);
    } catch { /* column already exists */ }
    // Migration: add PR metadata columns
    try {
      this.db.run(`ALTER TABLE tasks ADD COLUMN pr_url TEXT`);
    } catch { /* column already exists */ }
    try {
      this.db.run(`ALTER TABLE tasks ADD COLUMN pr_number INTEGER`);
    } catch { /* column already exists */ }
    try {
      this.db.run(`ALTER TABLE tasks ADD COLUMN pr_state TEXT`);
    } catch { /* column already exists */ }

    // Research reviews table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS research_reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        comments TEXT NOT NULL,
        research_snapshot TEXT NOT NULL,
        revised_content TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_research_reviews_task_id ON research_reviews(task_id)`);

    // Conversations table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        acp_session_id TEXT,
        title TEXT,
        working_directory TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations(agent_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)`);

    // Migration: add conversation_id to messages
    try {
      this.db.run(`ALTER TABLE messages ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE`);
    } catch { /* column already exists */ }
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)`);

    // Migration: add task_id to conversations
    try {
      this.db.run(`ALTER TABLE conversations ADD COLUMN task_id TEXT`);
    } catch { /* column already exists */ }
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_task_id ON conversations(task_id)`);

    // Migration: create legacy conversations for existing messages without conversation_id
    this.migrateLegacyConversations();

    // Permission grants table (scoped by project path + tool kind)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS permission_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        tool_kind TEXT NOT NULL,
        granted INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_path, tool_kind)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_permission_grants_project ON permission_grants(project_path)`);
  }

  private migrateLegacyConversations(): void {
    if (!this.db) return;

    // Find agents with messages that have no conversation_id
    const stmt = this.db.prepare(
      `SELECT DISTINCT agent_id FROM messages WHERE conversation_id IS NULL`
    );
    const agentIds: string[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { agent_id: string };
      agentIds.push(row.agent_id);
    }
    stmt.free();

    for (const agentId of agentIds) {
      const legacyId = `legacy-${agentId}`;
      // Create a legacy conversation if it doesn't exist
      this.db.run(
        `INSERT OR IGNORE INTO conversations (id, agent_id, title, created_at, updated_at)
         VALUES (?, ?, 'Previous conversation', 
           (SELECT MIN(created_at) FROM messages WHERE agent_id = ?),
           (SELECT MAX(created_at) FROM messages WHERE agent_id = ?))`,
        [legacyId, agentId, agentId, agentId]
      );
      // Link orphaned messages
      this.db.run(
        `UPDATE messages SET conversation_id = ? WHERE agent_id = ? AND conversation_id IS NULL`,
        [legacyId, agentId]
      );
    }
  }

  /**
   * Save database to disk with debouncing to avoid excessive writes
   */
  private saveDatabase(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    
    this.saveTimeout = setTimeout(() => {
      this.saveDatabaseSync();
    }, 100);
  }

  private saveDatabaseSync(): void {
    if (!this.db) return;
    
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (error) {
      log.error('Failed to save database', error);
    }
  }

  // ============ Settings Methods ============

  async getSettings(): Promise<AppSettings> {
    if (!this.db) throw new Error('Database not initialized');

    const settings: Partial<AppSettings> = {};
    
    const stmt = this.db.prepare('SELECT key, value FROM settings');
    while (stmt.step()) {
      const row = stmt.getAsObject() as { key: string; value: string };
      try {
        (settings as Record<string, unknown>)[row.key] = JSON.parse(row.value);
      } catch {
        (settings as Record<string, unknown>)[row.key] = row.value;
      }
    }
    stmt.free();

    return { ...DEFAULT_SETTINGS, ...settings };
  }

  async updateSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
    if (!this.db) throw new Error('Database not initialized');

    for (const [key, value] of Object.entries(updates)) {
      this.db.run(
        `INSERT INTO settings (key, value, updated_at) 
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        [key, JSON.stringify(value)]
      );
    }

    this.saveDatabase();
    return this.getSettings();
  }

  // ============ Permission Grant Methods ============

  async getPermissionGrant(projectPath: string, toolKind: string): Promise<PermissionGrant | null> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(
      `SELECT id, project_path, tool_kind, granted, created_at FROM permission_grants
       WHERE project_path = ? AND tool_kind = ?`
    );
    stmt.bind([projectPath, toolKind]);
    let grant: PermissionGrant | null = null;
    if (stmt.step()) {
      const row = stmt.getAsObject() as any;
      grant = {
        id: row.id,
        projectPath: row.project_path,
        toolKind: row.tool_kind,
        granted: !!row.granted,
        createdAt: row.created_at,
      };
    }
    stmt.free();
    return grant;
  }

  async getPermissionGrants(projectPath: string): Promise<PermissionGrant[]> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(
      `SELECT id, project_path, tool_kind, granted, created_at FROM permission_grants
       WHERE project_path = ? ORDER BY created_at DESC`
    );
    stmt.bind([projectPath]);
    const grants: PermissionGrant[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      grants.push({
        id: row.id,
        projectPath: row.project_path,
        toolKind: row.tool_kind,
        granted: !!row.granted,
        createdAt: row.created_at,
      });
    }
    stmt.free();
    return grants;
  }

  async savePermissionGrant(projectPath: string, toolKind: string, granted: boolean): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run(
      `INSERT INTO permission_grants (project_path, tool_kind, granted, created_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(project_path, tool_kind) DO UPDATE SET granted = excluded.granted, created_at = datetime('now')`,
      [projectPath, toolKind, granted ? 1 : 0]
    );
    this.saveDatabase();
  }

  async deletePermissionGrant(grantId: number): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run(`DELETE FROM permission_grants WHERE id = ?`, [grantId]);
    this.saveDatabase();
  }

  async deleteAllPermissionGrants(projectPath: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run(`DELETE FROM permission_grants WHERE project_path = ?`, [projectPath]);
    this.saveDatabase();
  }

  // ============ Message Methods ============

  async saveMessage(message: Omit<ChatMessage, 'id'>): Promise<ChatMessage> {
    if (!this.db) throw new Error('Database not initialized');

    const id = uuidv4();
    this.db.run(
      `INSERT INTO messages (id, agent_id, conversation_id, role, content, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        message.agentId,
        message.conversationId || null,
        message.role,
        message.content,
        message.metadata ? JSON.stringify(message.metadata) : null,
        message.timestamp.toISOString()
      ]
    );

    // Update conversation's updated_at timestamp
    if (message.conversationId) {
      this.db.run(
        `UPDATE conversations SET updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), message.conversationId]
      );
    }

    this.saveDatabase();
    return { ...message, id };
  }

  async getMessages(agentId: string, limit = 100, offset = 0): Promise<ChatMessage[]> {
    if (!this.db) throw new Error('Database not initialized');

    const messages: ChatMessage[] = [];
    const stmt = this.db.prepare(
      `SELECT id, agent_id, conversation_id, role, content, metadata, created_at
       FROM messages
       WHERE agent_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    );
    stmt.bind([agentId, limit, offset]);
    
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: string;
        agent_id: string;
        conversation_id: string | null;
        role: string;
        content: string;
        metadata: string | null;
        created_at: string;
      };
      
      messages.push({
        id: row.id,
        agentId: row.agent_id,
        conversationId: row.conversation_id || undefined,
        role: row.role as MessageRole,
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        timestamp: new Date(row.created_at)
      });
    }
    stmt.free();

    return messages.reverse();
  }

  async searchMessages(agentId: string, query: string): Promise<ChatMessage[]> {
    if (!this.db) throw new Error('Database not initialized');

    const messages: ChatMessage[] = [];
    const stmt = this.db.prepare(
      `SELECT id, agent_id, role, content, metadata, created_at
       FROM messages
       WHERE agent_id = ? AND content LIKE ?
       ORDER BY created_at DESC
       LIMIT 50`
    );
    stmt.bind([agentId, `%${query}%`]);
    
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: string;
        agent_id: string;
        role: string;
        content: string;
        metadata: string | null;
        created_at: string;
      };
      
      messages.push({
        id: row.id,
        agentId: row.agent_id,
        role: row.role as MessageRole,
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        timestamp: new Date(row.created_at)
      });
    }
    stmt.free();

    return messages;
  }

  async clearHistory(agentId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run('DELETE FROM messages WHERE agent_id = ?', [agentId]);
    this.saveDatabase();
  }

  // ============ Conversation Methods ============

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    if (!this.db) throw new Error('Database not initialized');

    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO conversations (id, agent_id, title, working_directory, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.agentId, input.title || null, input.workingDirectory || null, input.taskId || null, now, now]
    );

    this.saveDatabase();
    return this.getConversation(id) as Promise<Conversation>;
  }

  async getConversation(conversationId: string): Promise<Conversation | null> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(
      `SELECT c.id, c.agent_id, c.acp_session_id, c.title, c.working_directory, c.task_id, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count,
              (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
       FROM conversations c WHERE c.id = ?`
    );
    stmt.bind([conversationId]);

    if (!stmt.step()) { stmt.free(); return null; }

    const row = stmt.getAsObject() as {
      id: string; agent_id: string; acp_session_id: string | null;
      title: string | null; working_directory: string | null; task_id: string | null;
      created_at: string; updated_at: string;
      message_count: number; last_message: string | null;
    };
    stmt.free();

    return {
      id: row.id,
      agentId: row.agent_id,
      acpSessionId: row.acp_session_id || undefined,
      taskId: row.task_id || undefined,
      title: row.title || undefined,
      workingDirectory: row.working_directory || undefined,
      createdAt: parseUtcDate(row.created_at),
      updatedAt: parseUtcDate(row.updated_at),
      messageCount: row.message_count,
      lastMessage: row.last_message || undefined,
    };
  }

  async getConversations(agentId: string): Promise<Conversation[]> {
    if (!this.db) throw new Error('Database not initialized');

    const conversations: Conversation[] = [];
    const stmt = this.db.prepare(
      `SELECT c.id, c.agent_id, c.acp_session_id, c.title, c.working_directory, c.task_id, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count,
              (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
       FROM conversations c
       WHERE c.agent_id = ?
       ORDER BY c.updated_at DESC`
    );
    stmt.bind([agentId]);

    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: string; agent_id: string; acp_session_id: string | null;
        title: string | null; working_directory: string | null; task_id: string | null;
        created_at: string; updated_at: string;
        message_count: number; last_message: string | null;
      };
      conversations.push({
        id: row.id,
        agentId: row.agent_id,
        acpSessionId: row.acp_session_id || undefined,
        taskId: row.task_id || undefined,
        title: row.title || undefined,
        workingDirectory: row.working_directory || undefined,
        createdAt: parseUtcDate(row.created_at),
        updatedAt: parseUtcDate(row.updated_at),
        messageCount: row.message_count,
        lastMessage: row.last_message || undefined,
      });
    }
    stmt.free();
    return conversations;
  }

  async updateConversation(conversationId: string, updates: UpdateConversationInput): Promise<Conversation> {
    if (!this.db) throw new Error('Database not initialized');

    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
    if (updates.acpSessionId !== undefined) { sets.push('acp_session_id = ?'); params.push(updates.acpSessionId); }

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(conversationId);
      this.db.run(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`, params);
      this.saveDatabase();
    }

    return this.getConversation(conversationId) as Promise<Conversation>;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
    this.db.run('DELETE FROM conversations WHERE id = ?', [conversationId]);
    this.saveDatabase();
  }

  async deleteAllConversations(agentId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run(
      'DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_id = ?)',
      [agentId]
    );
    this.db.run('DELETE FROM conversations WHERE agent_id = ?', [agentId]);
    this.saveDatabase();
  }

  async getMessagesByConversation(conversationId: string, limit = 100, offset = 0): Promise<ChatMessage[]> {
    if (!this.db) throw new Error('Database not initialized');

    const messages: ChatMessage[] = [];
    const stmt = this.db.prepare(
      `SELECT id, agent_id, conversation_id, role, content, metadata, created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    );
    stmt.bind([conversationId, limit, offset]);

    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: string; agent_id: string; conversation_id: string | null;
        role: string; content: string; metadata: string | null; created_at: string;
      };
      messages.push({
        id: row.id,
        agentId: row.agent_id,
        conversationId: row.conversation_id || undefined,
        role: row.role as MessageRole,
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        timestamp: new Date(row.created_at)
      });
    }
    stmt.free();
    return messages.reverse();
  }

  // ============ Permission Methods ============

  async getPermissions(agentId: string): Promise<PermissionSet> {
    if (!this.db) throw new Error('Database not initialized');

    const permissions: Partial<PermissionSet> = {};
    const stmt = this.db.prepare(
      `SELECT permission_type, granted
       FROM permissions
       WHERE agent_id = ?`
    );
    stmt.bind([agentId]);
    
    while (stmt.step()) {
      const row = stmt.getAsObject() as { permission_type: string; granted: number };
      (permissions as Record<string, boolean>)[row.permission_type] = row.granted === 1;
    }
    stmt.free();

    return { ...DEFAULT_PERMISSIONS, ...permissions };
  }

  async setPermission(
    agentId: string, 
    permission: keyof PermissionSet, 
    granted: boolean
  ): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run(
      `INSERT INTO permissions (agent_id, permission_type, granted, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(agent_id, permission_type) 
       DO UPDATE SET granted = excluded.granted, updated_at = datetime('now')`,
      [agentId, permission, granted ? 1 : 0]
    );
    
    this.saveDatabase();
  }

  // ============ Agent Methods ============

  async saveAgent(agent: Agent): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run(
      `INSERT INTO agents (id, name, description, icon, color, system_prompt, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         icon = excluded.icon,
         color = excluded.color,
         system_prompt = excluded.system_prompt,
         source = excluded.source`,
      [
        agent.id,
        agent.name,
        agent.description,
        agent.icon || null,
        agent.color || null,
        agent.systemPrompt || null,
        agent.source
      ]
    );
    
    this.saveDatabase();
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(
      `SELECT id, name, description, icon, color, system_prompt, source
       FROM agents
       WHERE id = ?`
    );
    stmt.bind([agentId]);
    
    if (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: string;
        name: string;
        description: string;
        icon: string | null;
        color: string | null;
        system_prompt: string | null;
        source: string;
      };
      stmt.free();
      
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        icon: row.icon || undefined,
        color: row.color || undefined,
        systemPrompt: row.system_prompt || undefined,
        source: row.source as 'builtin' | 'workspace'
      };
    }
    
    stmt.free();
    return null;
  }

  // ============ Recent Directories Methods ============

  async addRecentDirectory(dirPath: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run(
      `INSERT INTO recent_directories (path, last_opened)
       VALUES (?, datetime('now'))
       ON CONFLICT(path) DO UPDATE SET last_opened = datetime('now')`,
      [dirPath]
    );

    // Keep only last 10 directories
    this.db.run(
      `DELETE FROM recent_directories
       WHERE id NOT IN (
         SELECT id FROM recent_directories
         ORDER BY last_opened DESC
         LIMIT 10
       )`
    );
    
    this.saveDatabase();
  }

  async getRecentDirectories(): Promise<string[]> {
    if (!this.db) throw new Error('Database not initialized');

    const directories: string[] = [];
    const stmt = this.db.prepare(
      `SELECT path FROM recent_directories
       ORDER BY last_opened DESC
       LIMIT 10`
    );
    
    while (stmt.step()) {
      const row = stmt.getAsObject() as { path: string };
      directories.push(row.path);
    }
    stmt.free();

    return directories;
  }

  // ============ Task Methods ============

  async createTask(input: CreateTaskInput, projectPath?: string): Promise<Task> {
    if (!this.db) throw new Error('Database not initialized');

    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO tasks (id, title, description, state, kind, project_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.title, input.description || '', input.state || 'new', input.kind || 'feature', projectPath || null, now, now]
    );

    if (input.labelIds?.length) {
      for (const labelId of input.labelIds) {
        this.db.run(
          `INSERT OR IGNORE INTO task_label_assignments (task_id, label_id) VALUES (?, ?)`,
          [id, labelId]
        );
      }
    }

    this.saveDatabase();
    return this.getTask(id) as Promise<Task>;
  }

  async updateTask(taskId: string, updates: UpdateTaskInput): Promise<Task> {
    if (!this.db) throw new Error('Database not initialized');

    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
    if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
    if (updates.state !== undefined) { sets.push('state = ?'); params.push(updates.state); }
    if (updates.kind !== undefined) { sets.push('kind = ?'); params.push(updates.kind); }
    if (updates.researchContent !== undefined) { sets.push('research_content = ?'); params.push(updates.researchContent); }
    if (updates.researchAgentId !== undefined) { sets.push('research_agent_id = ?'); params.push(updates.researchAgentId); }
    if (updates.closeReason !== undefined) { sets.push('close_reason = ?'); params.push(updates.closeReason); }
    if (updates.implementAgentId !== undefined) { sets.push('implement_agent_id = ?'); params.push(updates.implementAgentId); }
    if (updates.worktreePath !== undefined) { sets.push('worktree_path = ?'); params.push(updates.worktreePath); }
    if (updates.branchName !== undefined) { sets.push('branch_name = ?'); params.push(updates.branchName); }
    if (updates.prUrl !== undefined) { sets.push('pr_url = ?'); params.push(updates.prUrl); }
    if (updates.prNumber !== undefined) { sets.push('pr_number = ?'); params.push(updates.prNumber); }
    if (updates.prState !== undefined) { sets.push('pr_state = ?'); params.push(updates.prState); }

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(taskId);
      this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    if (updates.labelIds !== undefined) {
      this.db.run(`DELETE FROM task_label_assignments WHERE task_id = ?`, [taskId]);
      for (const labelId of updates.labelIds) {
        this.db.run(
          `INSERT OR IGNORE INTO task_label_assignments (task_id, label_id) VALUES (?, ?)`,
          [taskId, labelId]
        );
      }
    }

    this.saveDatabase();
    return this.getTask(taskId) as Promise<Task>;
  }

  async deleteTask(taskId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(`DELETE FROM task_label_assignments WHERE task_id = ?`, [taskId]);
    this.db.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
    this.saveDatabase();
  }

  async getTask(taskId: string): Promise<Task | null> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(
      `SELECT id, title, description, state, kind, project_path, research_content, research_agent_id, implement_agent_id, github_issue_number, github_repo, close_reason, worktree_path, branch_name, pr_url, pr_number, pr_state, created_at, updated_at
       FROM tasks WHERE id = ?`
    );
    stmt.bind([taskId]);

    if (!stmt.step()) { stmt.free(); return null; }

    const row = stmt.getAsObject() as {
      id: string; title: string; description: string; state: string; kind: string;
      project_path: string | null;
      research_content: string | null; research_agent_id: string | null;
      implement_agent_id: string | null;
      github_issue_number: number | null; github_repo: string | null;
      close_reason: string | null;
      worktree_path: string | null; branch_name: string | null;
      pr_url: string | null; pr_number: number | null; pr_state: string | null;
      created_at: string; updated_at: string;
    };
    stmt.free();

    const labels = this.getLabelsForTask(taskId);

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      state: row.state as TaskState,
      kind: (row.kind || 'feature') as TaskKind,
      labels,
      projectPath: row.project_path ?? undefined,
      researchContent: row.research_content ?? undefined,
      researchAgentId: row.research_agent_id ?? undefined,
      implementAgentId: row.implement_agent_id ?? undefined,
      githubIssueNumber: row.github_issue_number ?? undefined,
      githubRepo: row.github_repo ?? undefined,
      closeReason: (row.close_reason as BugCloseReason) ?? undefined,
      worktreePath: row.worktree_path ?? undefined,
      branchName: row.branch_name ?? undefined,
      prUrl: row.pr_url ?? undefined,
      prNumber: row.pr_number ?? undefined,
      prState: (row.pr_state as TaskPRState) ?? undefined,
      createdAt: parseUtcDate(row.created_at),
      updatedAt: parseUtcDate(row.updated_at),
    };
  }

  async getTasks(stateFilter?: string, kindFilter?: string, projectPath?: string): Promise<Task[]> {
    if (!this.db) throw new Error('Database not initialized');

    let sql = `SELECT id, title, description, state, kind, project_path, research_content, research_agent_id, implement_agent_id, github_issue_number, github_repo, close_reason, worktree_path, branch_name, pr_url, pr_number, pr_state, created_at, updated_at
               FROM tasks`;
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (stateFilter) {
      conditions.push(`state = ?`);
      params.push(stateFilter);
    }
    if (kindFilter) {
      conditions.push(`kind = ?`);
      params.push(kindFilter);
    }
    if (projectPath) {
      conditions.push(`project_path = ?`);
      params.push(projectPath);
    }
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ` ORDER BY updated_at DESC`;

    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params);

    const tasks: Task[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: string; title: string; description: string; state: string; kind: string;
        project_path: string | null;
        research_content: string | null; research_agent_id: string | null;
        implement_agent_id: string | null;
        github_issue_number: number | null; github_repo: string | null;
        close_reason: string | null;
        worktree_path: string | null; branch_name: string | null;
        pr_url: string | null; pr_number: number | null; pr_state: string | null;
        created_at: string; updated_at: string;
      };

      tasks.push({
        id: row.id,
        title: row.title,
        description: row.description,
        state: row.state as TaskState,
        kind: (row.kind || 'feature') as TaskKind,
        labels: this.getLabelsForTask(row.id),
        projectPath: row.project_path ?? undefined,
        researchContent: row.research_content ?? undefined,
        researchAgentId: row.research_agent_id ?? undefined,
        implementAgentId: row.implement_agent_id ?? undefined,
        githubIssueNumber: row.github_issue_number ?? undefined,
        githubRepo: row.github_repo ?? undefined,
        closeReason: (row.close_reason as BugCloseReason) ?? undefined,
        worktreePath: row.worktree_path ?? undefined,
        branchName: row.branch_name ?? undefined,
        prUrl: row.pr_url ?? undefined,
        prNumber: row.pr_number ?? undefined,
        prState: (row.pr_state as TaskPRState) ?? undefined,
        createdAt: parseUtcDate(row.created_at),
        updatedAt: parseUtcDate(row.updated_at),
      });
    }
    stmt.free();
    return tasks;
  }

  private getLabelsForTask(taskId: string): TaskLabel[] {
    if (!this.db) return [];
    const labels: TaskLabel[] = [];
    const stmt = this.db.prepare(
      `SELECT l.id, l.name, l.color
       FROM task_labels l
       INNER JOIN task_label_assignments a ON a.label_id = l.id
       WHERE a.task_id = ?`
    );
    stmt.bind([taskId]);
    while (stmt.step()) {
      const row = stmt.getAsObject() as { id: string; name: string; color: string };
      labels.push(row);
    }
    stmt.free();
    return labels;
  }

  // ============ Task Label Methods ============

  async getTaskLabels(): Promise<TaskLabel[]> {
    if (!this.db) throw new Error('Database not initialized');
    const labels: TaskLabel[] = [];
    const stmt = this.db.prepare(`SELECT id, name, color FROM task_labels ORDER BY name`);
    while (stmt.step()) {
      const row = stmt.getAsObject() as { id: string; name: string; color: string };
      labels.push(row);
    }
    stmt.free();
    return labels;
  }

  async createTaskLabel(name: string, color: string): Promise<TaskLabel> {
    if (!this.db) throw new Error('Database not initialized');
    const id = uuidv4();
    this.db.run(`INSERT INTO task_labels (id, name, color) VALUES (?, ?, ?)`, [id, name, color]);
    this.saveDatabase();
    return { id, name, color };
  }

  async deleteTaskLabel(labelId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(`DELETE FROM task_label_assignments WHERE label_id = ?`, [labelId]);
    this.db.run(`DELETE FROM task_labels WHERE id = ?`, [labelId]);
    this.saveDatabase();
  }

  // ============ Research Review Methods ============

  async createResearchReview(review: { id: string; taskId: string; comments: ResearchComment[]; researchSnapshot: string; status: string }): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    this.db.run(
      `INSERT INTO research_reviews (id, task_id, comments, research_snapshot, status, submitted_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [review.id, review.taskId, JSON.stringify(review.comments), review.researchSnapshot, review.status]
    );
    this.saveDatabase();
  }

  async updateResearchReview(reviewId: string, updates: { status?: string; revisedContent?: string }): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    const sets: string[] = [];
    const params: unknown[] = [];
    if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
    if (updates.revisedContent !== undefined) { sets.push('revised_content = ?'); params.push(updates.revisedContent); }
    if (updates.status === 'complete') { sets.push("completed_at = datetime('now')"); }
    if (sets.length > 0) {
      params.push(reviewId);
      this.db.run(`UPDATE research_reviews SET ${sets.join(', ')} WHERE id = ?`, params);
      this.saveDatabase();
    }
  }

  async getResearchReviews(taskId: string): Promise<ResearchReview[]> {
    if (!this.db) throw new Error('Database not initialized');
    const reviews: ResearchReview[] = [];
    const stmt = this.db.prepare(
      `SELECT id, task_id, comments, research_snapshot, revised_content, status, submitted_at
       FROM research_reviews WHERE task_id = ? ORDER BY submitted_at DESC`
    );
    stmt.bind([taskId]);
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: string; task_id: string; comments: string; research_snapshot: string;
        revised_content: string | null; status: string; submitted_at: string;
      };
      reviews.push({
        id: row.id,
        taskId: row.task_id,
        comments: JSON.parse(row.comments),
        researchSnapshot: row.research_snapshot,
        revisedContent: row.revised_content ?? undefined,
        status: row.status as 'pending' | 'in_progress' | 'complete',
        submittedAt: new Date(row.submitted_at),
      });
    }
    stmt.free();
    return reviews;
  }

  // ============ Cleanup ============

  close(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveDatabaseSync(); // Final save
    }
    
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
