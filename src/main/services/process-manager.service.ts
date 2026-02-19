/**
 * Process Manager Service - Manages Copilot CLI child processes via ACP
 */

import { spawn, execFile, ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import { EventEmitter } from 'events';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Agent, AgentSession } from '../../shared/types/agent.types';
import { StreamingMessage, ToolCall, TodoItem, MessageSegment } from '../../shared/types/message.types';
import { createLogger } from './logger.service';

const log = createLogger('ProcessManager');

// Lazy-loaded ESM module — use Function to prevent tsc from converting import() to require()
let acpModule: typeof import('@agentclientprotocol/sdk') | null = null;
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
async function getAcp(): Promise<typeof import('@agentclientprotocol/sdk')> {
  if (!acpModule) {
    acpModule = await dynamicImport('@agentclientprotocol/sdk');
  }
  return acpModule!;
}

interface SessionProcess {
  session: AgentSession;
  process: ChildProcess;
  connection: any; // acp.ClientSideConnection (loaded dynamically)
  acpSessionId: string | null;
  eventEmitter: EventEmitter;
  contentBuffer: string;
  thinkingBuffer: string;
  toolCalls: Map<string, ToolCall>;
  todoItems: TodoItem[];
  segments: MessageSegment[];
  currentOperation: string;
  systemPrompt?: string;
  systemPromptSent: boolean;
  capabilities: {
    canLoadSession: boolean;
    canResumeSession: boolean;
    canListSessions: boolean;
  };
}

export class ProcessManagerService {
  private sessions: Map<string, SessionProcess> = new Map();
  private cachedBestModel: string | null = null;
  private databasePath: string | null = null;
  // Maps permission requestId → sessionId for correct routing when multiple sessions share an agentId
  private pendingPermissions: Map<string, string> = new Map();

  getActiveModel(): string | null {
    return this.cachedBestModel;
  }

  /** Set the castle.db file path so built-in MCP servers can be injected. */
  setDatabasePath(dbPath: string): void {
    log.info(`setDatabasePath called with: ${dbPath}`);
    this.databasePath = dbPath;
    this.writeMcpConfig();
  }

  /**
   * Write Castle's MCP server config to ~/.copilot/mcp.json so the Copilot CLI
   * picks it up automatically without needing --additional-mcp-config.
   */
  private writeMcpConfig(): void {
    if (!this.databasePath) return;
    try {
      const fs = require('fs');
      const os = require('os');
      const mcpDir = path.join(os.homedir(), '.copilot');
      const mcpFile = path.join(mcpDir, 'mcp.json');
      const serverScript = path.join(__dirname, '..', 'mcp', 'castle-tasks-server.js');

      // Read existing config to preserve other MCP servers
      let existing: any = {};
      if (fs.existsSync(mcpFile)) {
        try { existing = JSON.parse(fs.readFileSync(mcpFile, 'utf-8')); } catch { /* ignore */ }
      }

      const mcpServers = existing.mcpServers || {};
      mcpServers['castle-tasks'] = {
        type: 'stdio',
        command: 'node',
        args: [serverScript],
        env: {
          CASTLE_DB_PATH: this.databasePath,
        },
      };

      fs.mkdirSync(mcpDir, { recursive: true });
      fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers }, null, 2), 'utf-8');
      log.info(`MCP config written to ${mcpFile}`);
    } catch (err) {
      log.error('Failed to write MCP config', err);
    }
  }

  /** Return MCP server configs for Castle built-in tools. */
  private getCastleBuiltinMcpServers(workingDirectory: string): Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> {
    if (!this.databasePath) {
      log.warn('getCastleBuiltinMcpServers: databasePath is not set, skipping castle-tasks MCP server');
      return [];
    }

    const serverScript = path.join(__dirname, '..', 'mcp', 'castle-tasks-server.js');
    const exists = require('fs').existsSync(serverScript);
    log.info(`getCastleBuiltinMcpServers: serverScript=${serverScript}, exists=${exists}, databasePath=${this.databasePath}, workingDirectory=${workingDirectory}`);

    return [{
      name: 'castle-tasks',
      command: 'node',
      args: [serverScript],
      env: [
        { name: 'CASTLE_DB_PATH', value: this.databasePath },
        { name: 'CASTLE_PROJECT_PATH', value: workingDirectory },
      ],
    }];
  }

  /**
   * Query available models from `copilot --help` and pick the best one.
   */
  private async resolveBestModel(): Promise<string | null> {
    if (this.cachedBestModel) return this.cachedBestModel;

    try {
      const { execSync } = require('child_process');
      const help: string = execSync('copilot --help', { encoding: 'utf-8', shell: true, timeout: 10000 });

      // Extract model choices from: --model <model>  ... (choices: "model1", "model2", ...)
      const match = help.match(/--model\s.*?choices:\s*([\s\S]*?\))/);
      if (match) {
        const modelIds = [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
        if (modelIds.length > 0) {
          this.cachedBestModel = this.pickBestModel(modelIds);
          log.info(`Available models: ${modelIds.join(', ')}`);
          log.info(`Selected model: ${this.cachedBestModel}`);
          return this.cachedBestModel;
        }
      }
    } catch (e) {
      log.warn('Could not query models from CLI', e);
    }
    return null;
  }

  /**
   * Start a new Copilot CLI session for an agent via ACP.
   * If acpSessionIdToResume is provided, attempts to resume that session.
   */
  async startSession(agent: Agent, workingDirectory: string, acpSessionIdToResume?: string): Promise<AgentSession> {
    const self = this;
    const existingSession = this.getSessionByAgentId(agent.id, workingDirectory);
    if (existingSession) {
      log.info(`Reusing existing session for agent "${agent.name}" (${agent.id}) in ${workingDirectory}`);
      return existingSession.session;
    }

    log.info(`Starting new session for agent "${agent.name}" in ${workingDirectory}`);
    const sessionId = uuidv4();
    const session: AgentSession = {
      id: sessionId,
      agentId: agent.id,
      workingDirectory,
      status: 'starting',
      startedAt: new Date(),
      lastActivityAt: new Date()
    };

    // Build CLI arguments
    const args: string[] = ['--acp', '--stdio'];

    // Resolve and use the best available model
    const bestModel = await this.resolveBestModel();
    if (bestModel) {
      args.push('--model', bestModel);
    }

    // MCP servers are configured via ~/.copilot/mcp.json (written at app startup)
    // rather than --additional-mcp-config CLI flag (which has Windows shell escaping issues)

    // Spawn copilot in ACP mode
    const childProcess = spawn('copilot', args, {
      cwd: workingDirectory,
      shell: true,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const eventEmitter = new EventEmitter();

    // Log stderr with context about the current operation and session status
    childProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      const status = sessionProcess.session.status;
      const operation = sessionProcess.currentOperation || 'unknown';
      log.error(
        `Agent "${agent.name}" stderr (status=${status}, operation=${operation}): ${msg}`
      );
    });

    childProcess.on('error', (error) => {
      const op = sessionProcess?.currentOperation ?? 'unknown';
      log.error(`Agent "${agent.name}" process error (operation=${op})`, error);
      sessionProcess.session.status = 'error';
      eventEmitter.emit('error', error.message);
    });

    childProcess.on('exit', (code, signal) => {
      log.info(`Agent "${agent.name}" process exited: code=${code}, signal=${signal}`);
      sessionProcess.session.status = 'stopped';
      eventEmitter.emit('exit', { code, signal });
      this.sessions.delete(sessionId);
    });

    // Create ACP stream from child process stdio
    const acp = await getAcp();
    const output = Writable.toWeb(childProcess.stdin!) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(childProcess.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);

    const sessionProcess: SessionProcess = {
      session,
      process: childProcess,
      connection: null!,
      acpSessionId: null,
      eventEmitter,
      contentBuffer: '',
      thinkingBuffer: '',
      toolCalls: new Map(),
      todoItems: [],
      segments: [],
      currentOperation: 'spawning',
      systemPrompt: agent.systemPrompt,
      systemPromptSent: false,
      capabilities: { canLoadSession: false, canResumeSession: false, canListSessions: false }
    };

    // Register immediately so concurrent calls find it (status is 'starting')
    this.sessions.set(sessionId, sessionProcess);

    // Create ACP client handler
    const client: import('@agentclientprotocol/sdk').Client = {
      async requestPermission(params) {
        // Forward to renderer and wait for user response
        return new Promise((resolve) => {
          const requestId = uuidv4();
          log.info(`Permission requested: requestId=${requestId}, tool=${params.toolCall?.kind}, options=[${params.options.map(o => `${o.optionId}:${o.kind}`).join(', ')}]`);
          // Track which session owns this request for correct routing
          self.pendingPermissions.set(requestId, sessionId);
          const permissionData = {
            requestId,
            agentId: agent.id,
            agentName: agent.name,
            toolCall: params.toolCall,
            options: params.options.map(o => ({
              optionId: o.optionId,
              name: o.name,
              kind: o.kind
            }))
          };

          // Listen for the response
          const onResponse = (response: { requestId: string; optionId: string }) => {
            if (response.requestId === requestId) {
              eventEmitter.off('permissionResponse', onResponse);
              self.pendingPermissions.delete(requestId);
              log.info(`Permission resolved: requestId=${requestId}, optionId=${response.optionId}`);
              resolve({ outcome: { outcome: 'selected' as const, optionId: response.optionId } });
            }
          };
          eventEmitter.on('permissionResponse', onResponse);

          // Emit to IPC layer
          eventEmitter.emit('permissionRequest', permissionData);
        });
      },
      async sessionUpdate(params) {
        const { update } = params;
        sessionProcess.session.lastActivityAt = new Date();

        const emitOutput = () => {
          const streamingMessage: StreamingMessage = {
            id: sessionId,
            agentId: agent.id,
            content: sessionProcess.contentBuffer,
            thinking: sessionProcess.thinkingBuffer,
            isComplete: false,
            toolCalls: Array.from(sessionProcess.toolCalls.values()),
            todoItems: sessionProcess.todoItems.length > 0 ? [...sessionProcess.todoItems] : undefined,
            segments: sessionProcess.segments.map(seg =>
              seg.type === 'tool-calls'
                ? { ...seg, toolCalls: seg.toolCalls.map(tc => ({ ...tc })) }
                : { ...seg }
            )
          };
          eventEmitter.emit('output', streamingMessage);
        };

        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          sessionProcess.contentBuffer += update.content.text;
          // Append to existing text segment or create a new one
          const last = sessionProcess.segments[sessionProcess.segments.length - 1];
          if (last && last.type === 'text') {
            last.content += update.content.text;
          } else {
            sessionProcess.segments.push({ type: 'text', content: update.content.text });
          }
          emitOutput();
        }

        if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
          sessionProcess.thinkingBuffer += update.content.text;
          emitOutput();
        }

        if (update.sessionUpdate === 'tool_call') {
          const acpStatus = update.status;
          const toolCall: ToolCall = {
            id: update.toolCallId,
            name: update.title || 'tool',
            arguments: {},
            status: acpStatus === 'completed' ? 'success' : acpStatus === 'failed' ? 'error' : acpStatus === 'in_progress' ? 'running' : 'pending'
          };
          log.debug(`Agent "${agent.name}" tool call: ${toolCall.name} (${toolCall.id}) status=${toolCall.status}`);
          sessionProcess.toolCalls.set(update.toolCallId, toolCall);
          // Add to existing tool-calls segment or create a new one
          const last = sessionProcess.segments[sessionProcess.segments.length - 1];
          if (last && last.type === 'tool-calls') {
            last.toolCalls.push(toolCall);
          } else {
            sessionProcess.segments.push({ type: 'tool-calls', toolCalls: [toolCall] });
          }
          emitOutput();
        }

        if (update.sessionUpdate === 'tool_call_update') {
          const existing = sessionProcess.toolCalls.get(update.toolCallId);
          if (existing) {
            const s = update.status;
            existing.status = s === 'completed' ? 'success' : s === 'failed' ? 'error' : s === 'in_progress' ? 'running' : 'pending';
            if (update.title) existing.name = update.title;
            if (existing.status === 'error') {
              const u = update as any;
              log.error(`Agent "${agent.name}" tool call failed: ${existing.name} (${update.toolCallId})`, {
                error: u.error || u.message || u.result,
              });
            } else {
              log.debug(`Agent "${agent.name}" tool call update: ${existing.name} (${update.toolCallId}) status=${existing.status}`);
            }
            // Update the tool call in segments too
            for (const seg of sessionProcess.segments) {
              if (seg.type === 'tool-calls') {
                const tc = seg.toolCalls.find(t => t.id === update.toolCallId);
                if (tc) {
                  tc.status = existing.status;
                  if (update.title) tc.name = update.title;
                  break;
                }
              }
            }
          }
          emitOutput();
        }

        if (update.sessionUpdate === 'plan') {
          sessionProcess.todoItems = (update.entries || []).map((entry: any) => ({
            content: entry.content || '',
            status: entry.status || 'pending',
            priority: entry.priority
          }));
          emitOutput();
        }

        if (update.sessionUpdate === 'session_info_update') {
          if ((update as any).title) {
            eventEmitter.emit('titleUpdate', { title: (update as any).title });
          }
        }
      }
    };

    const connection = new acp.ClientSideConnection((_agent: any) => client, stream);
    sessionProcess.connection = connection;

    try {
      // Initialize ACP protocol
      sessionProcess.currentOperation = 'initialize';
      const initResult = await connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'Castle', version: '0.1.0' }
      });

      // Detect agent capabilities
      const agentCaps = initResult?.agentCapabilities;
      sessionProcess.capabilities = {
        canLoadSession: agentCaps?.loadSession ?? false,
        canResumeSession: !!agentCaps?.sessionCapabilities?.resume,
        canListSessions: !!agentCaps?.sessionCapabilities?.list,
      };

      const mcpServers = (agent.mcpServers || []).map(s => ({
        name: s.name,
        command: s.command,
        args: s.args || [],
        env: Object.entries(s.env || {}).map(([name, value]) => ({ name, value }))
      }));
      log.info(`Agent "${agent.name}" has ${mcpServers.length} agent-configured MCP server(s)`);

      // Auto-inject Castle built-in MCP servers
      mcpServers.push(...this.getCastleBuiltinMcpServers(workingDirectory));
      log.info(`Total MCP servers to register: ${mcpServers.length} — [${mcpServers.map(s => s.name).join(', ')}]`);

      let acpSessionId: string | null = null;

      // Try to resume existing ACP session
      if (acpSessionIdToResume) {
        if (sessionProcess.capabilities.canResumeSession) {
          try {
            sessionProcess.currentOperation = 'unstable_resumeSession';
            log.info(`unstable_resumeSession: passing ${mcpServers.length} MCP server(s) with sessionId=${acpSessionIdToResume}`);
            const resumed = await connection.unstable_resumeSession({
              sessionId: acpSessionIdToResume,
              cwd: workingDirectory,
              mcpServers
            });
            acpSessionId = (resumed as any)?.sessionId || acpSessionIdToResume;
            log.info(`Agent "${agent.name}" resumed ACP session: ${acpSessionId}`);
          } catch (e) {
            log.warn(`Agent "${agent.name}" resume failed, trying loadSession`, e);
          }
        }

        if (!acpSessionId && sessionProcess.capabilities.canLoadSession) {
          try {
            sessionProcess.currentOperation = 'loadSession';
            log.info(`loadSession: passing ${mcpServers.length} MCP server(s) with sessionId=${acpSessionIdToResume}`);
            const loaded = await connection.loadSession({
              sessionId: acpSessionIdToResume,
              cwd: workingDirectory,
              mcpServers
            });
            acpSessionId = (loaded as any)?.sessionId || acpSessionIdToResume;
            log.info(`Agent "${agent.name}" loaded ACP session: ${acpSessionId}`);
          } catch (e) {
            log.warn(`Agent "${agent.name}" load session failed, creating new`, e);
          }
        }
      }

      // Fall back to new session
      if (!acpSessionId) {
        sessionProcess.currentOperation = 'newSession';
        log.info(`newSession: passing ${mcpServers.length} MCP server(s), mcpServers=${JSON.stringify(mcpServers.map(s => ({ name: s.name, command: s.command, args: s.args })))}`);
        const acpSession = await connection.newSession({
          cwd: workingDirectory,
          mcpServers
        });
        acpSessionId = acpSession.sessionId;
        log.info(`Agent "${agent.name}" new ACP session: ${acpSessionId}`);
      }

      sessionProcess.acpSessionId = acpSessionId;
      sessionProcess.currentOperation = 'idle';
      session.status = 'ready';
    } catch (error) {
      log.error(`Agent "${agent.name}" ACP initialization failed`, error);
      session.status = 'error';
      this.sessions.delete(sessionId);
      throw error;
    }

    return session;
  }

  /**
   * Pick the best model from available models.
   * Preference: opus (latest first) > sonnet (latest) > codex (latest) > gpt > gemini > first available
   */
  private pickBestModel(modelIds: string[]): string | null {
    if (!modelIds.length) return null;

    const preference = [
      (id: string) => id.includes('opus') && !id.includes('fast'),
      (id: string) => id.includes('opus'),
      (id: string) => id.includes('sonnet'),
      (id: string) => id.includes('codex') && !id.includes('mini'),
      (id: string) => id.startsWith('gpt'),
      (id: string) => id.includes('gemini'),
    ];

    for (const test of preference) {
      const matches = modelIds.filter(test).sort().reverse();
      if (matches.length > 0) return matches[0];
    }

    return modelIds[0];
  }

  /**
   * Send a message to an agent session via ACP prompt
   */
  async sendMessage(sessionId: string, content: string): Promise<void> {
    const sessionProcess = this.sessions.get(sessionId);
    if (!sessionProcess) {
      throw new Error(`Session ${sessionId} not found`);
    }

    log.info(`Sending message to agent ${sessionProcess.session.agentId}: contentLength=${content.length}`);

    // If the session is still starting, wait for it to become ready
    if (sessionProcess.session.status === 'starting') {
      log.info(`Waiting for session ${sessionId} to become ready`);
      await this.waitForReady(sessionProcess);
    }

    if (sessionProcess.session.status !== 'ready') {
      throw new Error(`Session ${sessionId} is not ready (status: ${sessionProcess.session.status})`);
    }

    if (!sessionProcess.acpSessionId) {
      throw new Error(`Session ${sessionId} has no ACP session`);
    }

    sessionProcess.session.status = 'busy';
    sessionProcess.session.lastActivityAt = new Date();
    sessionProcess.contentBuffer = '';
    sessionProcess.thinkingBuffer = '';
    sessionProcess.toolCalls.clear();
    sessionProcess.todoItems = [];
    sessionProcess.segments = [];

    try {
      // Build prompt content blocks, prepending system prompt on first message
      const promptBlocks: Array<{ type: 'text'; text: string }> = [];
      if (sessionProcess.systemPrompt && !sessionProcess.systemPromptSent) {
        log.info(`Prepending system prompt for agent ${sessionProcess.session.agentId}`);
        promptBlocks.push({ type: 'text', text: sessionProcess.systemPrompt });
        sessionProcess.systemPromptSent = true;
      }
      promptBlocks.push({ type: 'text', text: content });

      // Send prompt and wait for full response
      sessionProcess.currentOperation = 'prompt';
      const response = await sessionProcess.connection.prompt({
        sessionId: sessionProcess.acpSessionId,
        prompt: promptBlocks
      });

      // Emit final complete message
      const completeMessage: StreamingMessage = {
        id: sessionId,
        agentId: sessionProcess.session.agentId,
        content: sessionProcess.contentBuffer,
        thinking: sessionProcess.thinkingBuffer,
        isComplete: true,
        toolCalls: Array.from(sessionProcess.toolCalls.values()),
        todoItems: sessionProcess.todoItems.length > 0 ? [...sessionProcess.todoItems] : undefined,
        segments: [...sessionProcess.segments]
      };

      log.info(`Agent ${sessionProcess.session.agentId} response complete: contentLength=${sessionProcess.contentBuffer.length}, toolCalls=${sessionProcess.toolCalls.size}`);
      sessionProcess.eventEmitter.emit('complete', completeMessage);

      sessionProcess.currentOperation = 'idle';
      sessionProcess.session.status = 'ready';
    } catch (error) {
      log.error(
        `Agent ${sessionProcess.session.agentId} error during operation="${sessionProcess.currentOperation}"`,
        error
      );
      sessionProcess.currentOperation = 'idle';
      sessionProcess.session.status = 'ready';
      throw error;
    }
  }

  /**
   * Subscribe to session output (streaming chunks)
   */
  onOutput(sessionId: string, callback: (message: StreamingMessage) => void): () => void {
    const sessionProcess = this.sessions.get(sessionId);
    if (!sessionProcess) {
      throw new Error(`Session ${sessionId} not found`);
    }

    sessionProcess.eventEmitter.on('output', callback);
    return () => { sessionProcess.eventEmitter.off('output', callback); };
  }

  /**
   * Subscribe to session completion
   */
  onComplete(sessionId: string, callback: (message: StreamingMessage) => void): () => void {
    const sessionProcess = this.sessions.get(sessionId);
    if (!sessionProcess) {
      throw new Error(`Session ${sessionId} not found`);
    }

    sessionProcess.eventEmitter.on('complete', callback);
    return () => { sessionProcess.eventEmitter.off('complete', callback); };
  }

  /**
   * Subscribe to permission requests
   */
  onPermissionRequest(sessionId: string, callback: (data: any) => void): () => void {
    const sessionProcess = this.sessions.get(sessionId);
    if (!sessionProcess) {
      throw new Error(`Session ${sessionId} not found`);
    }

    sessionProcess.eventEmitter.on('permissionRequest', callback);
    return () => { sessionProcess.eventEmitter.off('permissionRequest', callback); };
  }

  /**
   * Send a permission response back to the ACP client handler
   */
  respondToPermission(agentId: string, requestId: string, optionId: string): void {
    // Use requestId mapping to find the correct session (avoids wrong session when
    // the same agent has multiple sessions, e.g. main + worktree)
    const targetSessionId = this.pendingPermissions.get(requestId);
    const sessionProcess = targetSessionId
      ? this.sessions.get(targetSessionId)
      : this.getSessionByAgentId(agentId);
    if (sessionProcess) {
      log.info(`Permission response forwarded to agent ${agentId}: requestId=${requestId}, optionId=${optionId}, sessionId=${sessionProcess.session.id}`);
      sessionProcess.eventEmitter.emit('permissionResponse', { requestId, optionId });
    } else {
      log.error(`Permission response failed: no session found for agent ${agentId} (requestId=${requestId})`);
    }
  }

  /**
   * Subscribe to session errors
   */
  onError(sessionId: string, callback: (error: string) => void): () => void {
    const sessionProcess = this.sessions.get(sessionId);
    if (!sessionProcess) {
      throw new Error(`Session ${sessionId} not found`);
    }

    sessionProcess.eventEmitter.on('error', callback);
    return () => { sessionProcess.eventEmitter.off('error', callback); };
  }

  /**
   * Subscribe to session title updates from ACP session_info_update
   */
  onTitleUpdate(sessionId: string, callback: (data: { title: string }) => void): () => void {
    const sessionProcess = this.sessions.get(sessionId);
    if (!sessionProcess) {
      throw new Error(`Session ${sessionId} not found`);
    }

    sessionProcess.eventEmitter.on('titleUpdate', callback);
    return () => { sessionProcess.eventEmitter.off('titleUpdate', callback); };
  }

  /**
   * Get the ACP session ID for an agent's active session
   */
  getAcpSessionId(agentId: string): string | null {
    const sessionProcess = this.getSessionByAgentId(agentId);
    return sessionProcess?.acpSessionId || null;
  }

  /**
   * Cancel the in-progress message for an agent session.
   * Kills the child process, clears buffers, and removes the session
   * so it will be auto-restarted on the next message.
   */
  async cancelMessage(agentId: string): Promise<void> {
    const sessionProcess = this.getSessionByAgentId(agentId);
    if (!sessionProcess) return;

    log.info(`Cancelling message for agent ${agentId}, killing process`);

    // Kill the child process to abort any in-flight ACP prompt
    if (sessionProcess.process.pid) {
      sessionProcess.process.kill('SIGTERM');
    }

    // Clear buffers
    sessionProcess.contentBuffer = '';
    sessionProcess.thinkingBuffer = '';
    sessionProcess.toolCalls.clear();
    sessionProcess.todoItems = [];
    sessionProcess.segments = [];

    // Emit a cancellation event so the UI can clean up
    sessionProcess.eventEmitter.emit('cancelled', { agentId });

    // Remove the session; it will be auto-started on next message
    this.sessions.delete(sessionProcess.session.id);
  }

  /**
   * Subscribe to session cancellation
   */
  onCancelled(sessionId: string, callback: (data: { agentId: string }) => void): () => void {
    const sessionProcess = this.sessions.get(sessionId);
    if (!sessionProcess) {
      throw new Error(`Session ${sessionId} not found`);
    }

    sessionProcess.eventEmitter.on('cancelled', callback);
    return () => { sessionProcess.eventEmitter.off('cancelled', callback); };
  }

  /**
   * Stop a session, killing the process tree and waiting for exit.
   * On Windows, uses taskkill /T /F to kill the entire process tree
   * (shell + child processes) so file handles are released before
   * worktree directory removal.
   */
  async stopSession(sessionId: string): Promise<void> {
    const sessionProcess = this.sessions.get(sessionId);
    if (!sessionProcess) return;

    const pid = sessionProcess.process.pid;
    log.info(`Stopping session ${sessionId} for agent ${sessionProcess.session.agentId} (pid=${pid})`);

    if (pid) {
      // Build a promise that resolves when the process exits (or times out)
      const exitPromise = new Promise<void>(resolve => {
        const timeout = setTimeout(() => {
          log.warn(`Process ${pid} did not exit within 10s, force-killing`);
          try { sessionProcess.process.kill('SIGKILL'); } catch { /* already dead */ }
          resolve();
        }, 10_000);

        sessionProcess.process.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });

        // If the process is already dead, resolve immediately
        if (sessionProcess.process.exitCode !== null || sessionProcess.process.killed) {
          clearTimeout(timeout);
          resolve();
        }
      });

      if (process.platform === 'win32') {
        // On Windows, SIGTERM doesn't reliably kill processes. Use taskkill
        // with /T (tree kill) and /F (force) to kill the shell and all children.
        try {
          execFile('taskkill', ['/T', '/F', '/PID', String(pid)], (err) => {
            if (err) log.warn(`taskkill failed for pid ${pid}`, err);
          });
        } catch (err) {
          log.warn(`Failed to invoke taskkill for pid ${pid}`, err);
          sessionProcess.process.kill();
        }
      } else {
        sessionProcess.process.kill('SIGTERM');
      }

      await exitPromise;
    }

    this.sessions.delete(sessionId);
  }

  /**
   * Stop all sessions whose working directory starts with the given path.
   * Must be called before deleting a worktree directory on Windows.
   */
  async stopSessionsByWorkDir(workDirPrefix: string): Promise<void> {
    const normalized = path.normalize(workDirPrefix);
    let stoppedAny = false;
    for (const [sessionId, sp] of this.sessions) {
      if (path.normalize(sp.session.workingDirectory).startsWith(normalized)) {
        log.info(`Stopping session ${sessionId} (cwd: ${sp.session.workingDirectory}) before worktree removal`);
        await this.stopSession(sessionId);
        stoppedAny = true;
      }
    }
    // Give Windows time to release directory handles after process tree death
    if (stoppedAny && process.platform === 'win32') {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * Stop all sessions
   */
  stopAllSessions(): void {
    log.info(`Stopping all sessions (${this.sessions.size} active)`);
    for (const [sessionId] of this.sessions) {
      this.stopSession(sessionId);
    }
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): AgentSession | null {
    return this.sessions.get(sessionId)?.session || null;
  }

  /**
   * Get session by agent ID, optionally filtering by working directory.
   * When workingDirectory is provided, only returns a session whose cwd matches.
   * This allows an agent to have multiple concurrent sessions in different worktrees.
   */
  getSessionByAgentId(agentId: string, workingDirectory?: string): SessionProcess | undefined {
    for (const sessionProcess of this.sessions.values()) {
      if (sessionProcess.session.agentId === agentId) {
        if (workingDirectory && sessionProcess.session.workingDirectory !== workingDirectory) {
          continue;
        }
        return sessionProcess;
      }
    }
    return undefined;
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): AgentSession[] {
    return Array.from(this.sessions.values()).map(sp => sp.session);
  }

  /**
   * Wait for a session to leave the 'starting' state (become ready, error, or stopped).
   */
  private waitForReady(sessionProcess: SessionProcess, timeoutMs = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      // Already done
      if (sessionProcess.session.status !== 'starting') {
        return resolve();
      }

      const pollInterval = 200;
      let elapsed = 0;
      const timer = setInterval(() => {
        elapsed += pollInterval;
        if (sessionProcess.session.status !== 'starting') {
          clearInterval(timer);
          return resolve();
        }
        if (elapsed >= timeoutMs) {
          clearInterval(timer);
          return reject(new Error(`Timed out waiting for session ${sessionProcess.session.id} to become ready`));
        }
      }, pollInterval);
    });
  }

  /**
   * Mark session as ready
   */
  markSessionReady(sessionId: string): void {
    const sessionProcess = this.sessions.get(sessionId);
    if (sessionProcess && sessionProcess.session.status === 'busy') {
      sessionProcess.session.status = 'ready';
    }
  }
}
