/**
 * Database Service - SQLite persistence layer using sql.js
 * sql.js is a pure JavaScript implementation that doesn't require native compilation
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { 
  AppSettings, 
  DEFAULT_SETTINGS, 
  PermissionSet, 
  DEFAULT_PERMISSIONS,
  WindowBounds 
} from '../../shared/types';
import { ChatMessage, MessageRole } from '../../shared/types/message.types';
import { Agent } from '../../shared/types/agent.types';

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
    
    console.log(`Database initialized at: ${this.dbPath}`);
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
      console.error('Failed to save database:', error);
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

  // ============ Message Methods ============

  async saveMessage(message: Omit<ChatMessage, 'id'>): Promise<ChatMessage> {
    if (!this.db) throw new Error('Database not initialized');

    const id = uuidv4();
    this.db.run(
      `INSERT INTO messages (id, agent_id, role, content, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        message.agentId,
        message.role,
        message.content,
        message.metadata ? JSON.stringify(message.metadata) : null,
        message.timestamp.toISOString()
      ]
    );

    this.saveDatabase();
    return { ...message, id };
  }

  async getMessages(agentId: string, limit = 100, offset = 0): Promise<ChatMessage[]> {
    if (!this.db) throw new Error('Database not initialized');

    const messages: ChatMessage[] = [];
    const stmt = this.db.prepare(
      `SELECT id, agent_id, role, content, metadata, created_at
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

    return messages.reverse(); // Reverse to get chronological order
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
