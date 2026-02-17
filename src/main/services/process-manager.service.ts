/**
 * Process Manager Service - Manages Copilot CLI child processes via ACP
 */

import { spawn, ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Agent, AgentSession } from '../../shared/types/agent.types';
import { StreamingMessage, ToolCall, TodoItem, MessageSegment } from '../../shared/types/message.types';

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
  capabilities: {
    canLoadSession: boolean;
    canResumeSession: boolean;
    canListSessions: boolean;
  };
}

export class ProcessManagerService {
  private sessions: Map<string, SessionProcess> = new Map();
  private cachedBestModel: string | null = null;

  getActiveModel(): string | null {
    return this.cachedBestModel;
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
          console.log(`[ProcessManager] Available models: ${modelIds.join(', ')}`);
          console.log(`[ProcessManager] Selected model: ${this.cachedBestModel}`);
          return this.cachedBestModel;
        }
      }
    } catch (e) {
      console.warn('[ProcessManager] Could not query models from CLI:', e);
    }
    return null;
  }

  /**
   * Start a new Copilot CLI session for an agent via ACP.
   * If acpSessionIdToResume is provided, attempts to resume that session.
   */
  async startSession(agent: Agent, workingDirectory: string, acpSessionIdToResume?: string): Promise<AgentSession> {
    const existingSession = this.getSessionByAgentId(agent.id);
    if (existingSession) {
      return existingSession.session;
    }

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
      console.error(
        `[Agent ${agent.name}] stderr (status=${status}, operation=${operation}): ${msg}`
      );
    });

    childProcess.on('error', (error) => {
      console.error(`[Agent ${agent.name}] Process error:`, error);
      sessionProcess.session.status = 'error';
      eventEmitter.emit('error', error.message);
    });

    childProcess.on('exit', (code, signal) => {
      console.log(`[Agent ${agent.name}] Process exited with code ${code}, signal ${signal}`);
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

      let acpSessionId: string | null = null;

      // Try to resume existing ACP session
      if (acpSessionIdToResume) {
        if (sessionProcess.capabilities.canResumeSession) {
          try {
            sessionProcess.currentOperation = 'unstable_resumeSession';
            const resumed = await connection.unstable_resumeSession({
              sessionId: acpSessionIdToResume,
              cwd: workingDirectory,
              mcpServers
            });
            acpSessionId = (resumed as any)?.sessionId || acpSessionIdToResume;
            console.log(`[Agent ${agent.name}] Resumed ACP session: ${acpSessionId}`);
          } catch (e) {
            console.warn(`[Agent ${agent.name}] Resume failed, trying loadSession:`, e);
          }
        }

        if (!acpSessionId && sessionProcess.capabilities.canLoadSession) {
          try {
            sessionProcess.currentOperation = 'loadSession';
            const loaded = await connection.loadSession({
              sessionId: acpSessionIdToResume,
              cwd: workingDirectory,
              mcpServers
            });
            acpSessionId = (loaded as any)?.sessionId || acpSessionIdToResume;
            console.log(`[Agent ${agent.name}] Loaded ACP session: ${acpSessionId}`);
          } catch (e) {
            console.warn(`[Agent ${agent.name}] Load session failed, creating new:`, e);
          }
        }
      }

      // Fall back to new session
      if (!acpSessionId) {
        sessionProcess.currentOperation = 'newSession';
        const acpSession = await connection.newSession({
          cwd: workingDirectory,
          mcpServers
        });
        acpSessionId = acpSession.sessionId;
        console.log(`[Agent ${agent.name}] New ACP session: ${acpSessionId}`);
      }

      sessionProcess.acpSessionId = acpSessionId;
      sessionProcess.currentOperation = 'idle';
      session.status = 'ready';
    } catch (error) {
      console.error(`[Agent ${agent.name}] ACP initialization failed:`, error);
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

    // If the session is still starting, wait for it to become ready
    if (sessionProcess.session.status === 'starting') {
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
      // Send prompt and wait for full response
      sessionProcess.currentOperation = 'prompt';
      const response = await sessionProcess.connection.prompt({
        sessionId: sessionProcess.acpSessionId,
        prompt: [{ type: 'text', text: content }]
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
      sessionProcess.eventEmitter.emit('complete', completeMessage);

      sessionProcess.currentOperation = 'idle';
      sessionProcess.session.status = 'ready';
    } catch (error) {
      console.error(
        `[Agent ${sessionProcess.session.agentId}] Error during operation="${sessionProcess.currentOperation}":`,
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
    const sessionProcess = this.getSessionByAgentId(agentId);
    if (sessionProcess) {
      sessionProcess.eventEmitter.emit('permissionResponse', { requestId, optionId });
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
   * Stop a session
   */
  async stopSession(sessionId: string): Promise<void> {
    const sessionProcess = this.sessions.get(sessionId);
    if (!sessionProcess) return;

    if (sessionProcess.process.pid) {
      sessionProcess.process.kill('SIGTERM');
    }

    this.sessions.delete(sessionId);
  }

  /**
   * Stop all sessions
   */
  stopAllSessions(): void {
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
   * Get session by agent ID
   */
  getSessionByAgentId(agentId: string): SessionProcess | undefined {
    for (const sessionProcess of this.sessions.values()) {
      if (sessionProcess.session.agentId === agentId) {
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
