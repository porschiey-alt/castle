/**
 * Process Manager Service - Manages Copilot CLI child processes via ACP
 */

import { spawn, ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Agent, AgentSession } from '../../shared/types/agent.types';
import { StreamingMessage, ToolCall } from '../../shared/types/message.types';

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
  toolCalls: Map<string, ToolCall>;
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
   * Start a new Copilot CLI session for an agent via ACP
   */
  async startSession(agent: Agent, workingDirectory: string): Promise<AgentSession> {
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

    if (agent.systemPrompt) {
      args.push('--agent', agent.name);
    }

    // Spawn copilot in ACP mode
    const childProcess = spawn('copilot', args, {
      cwd: workingDirectory,
      shell: true,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const eventEmitter = new EventEmitter();

    // Log stderr for debugging
    childProcess.stderr?.on('data', (data: Buffer) => {
      console.error(`[Agent ${agent.name}] stderr:`, data.toString());
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
      toolCalls: new Map()
    };

    // Create ACP client handler
    const client: import('@agentclientprotocol/sdk').Client = {
      async requestPermission(params) {
        // Auto-allow for now; later we can forward to the UI
        const allowOption = params.options.find(o => o.kind === 'allow_always')
          || params.options.find(o => o.kind === 'allow_once')
          || params.options[0];
        return { outcome: { outcome: 'selected' as const, optionId: allowOption.optionId } };
      },
      async sessionUpdate(params) {
        const { update } = params;
        sessionProcess.session.lastActivityAt = new Date();

        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          sessionProcess.contentBuffer += update.content.text;
          const streamingMessage: StreamingMessage = {
            id: sessionId,
            agentId: agent.id,
            content: sessionProcess.contentBuffer,
            isComplete: false,
            toolCalls: Array.from(sessionProcess.toolCalls.values())
          };
          eventEmitter.emit('output', streamingMessage);
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

          const streamingMessage: StreamingMessage = {
            id: sessionId,
            agentId: agent.id,
            content: sessionProcess.contentBuffer,
            isComplete: false,
            toolCalls: Array.from(sessionProcess.toolCalls.values())
          };
          eventEmitter.emit('output', streamingMessage);
        }

        if (update.sessionUpdate === 'tool_call_update') {
          const existing = sessionProcess.toolCalls.get(update.toolCallId);
          if (existing) {
            const s = update.status;
            existing.status = s === 'completed' ? 'success' : s === 'failed' ? 'error' : s === 'in_progress' ? 'running' : 'pending';
          }
        }
      }
    };

    const connection = new acp.ClientSideConnection((_agent: any) => client, stream);
    sessionProcess.connection = connection;

    this.sessions.set(sessionId, sessionProcess);

    try {
      // Initialize ACP protocol
      await connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'Castle', version: '0.1.0' }
      });

      // Create ACP session
      const acpSession = await connection.newSession({
        cwd: workingDirectory,
        mcpServers: (agent.mcpServers || []).map(s => ({
          name: s.name,
          command: s.command,
          args: s.args || [],
          env: Object.entries(s.env || {}).map(([name, value]) => ({ name, value }))
        }))
      });

      sessionProcess.acpSessionId = acpSession.sessionId;
      session.status = 'ready';
      console.log(`[Agent ${agent.name}] ACP session ready: ${acpSession.sessionId}`);
    } catch (error) {
      console.error(`[Agent ${agent.name}] ACP initialization failed:`, error);
      session.status = 'error';
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

    if (sessionProcess.session.status !== 'ready') {
      throw new Error(`Session ${sessionId} is not ready (status: ${sessionProcess.session.status})`);
    }

    if (!sessionProcess.acpSessionId) {
      throw new Error(`Session ${sessionId} has no ACP session`);
    }

    sessionProcess.session.status = 'busy';
    sessionProcess.session.lastActivityAt = new Date();
    sessionProcess.contentBuffer = '';
    sessionProcess.toolCalls.clear();

    try {
      // Send prompt and wait for full response
      const response = await sessionProcess.connection.prompt({
        sessionId: sessionProcess.acpSessionId,
        prompt: [{ type: 'text', text: content }]
      });

      // Emit final complete message
      const completeMessage: StreamingMessage = {
        id: sessionId,
        agentId: sessionProcess.session.agentId,
        content: sessionProcess.contentBuffer,
        isComplete: true,
        toolCalls: Array.from(sessionProcess.toolCalls.values())
      };
      sessionProcess.eventEmitter.emit('complete', completeMessage);

      sessionProcess.session.status = 'ready';
    } catch (error) {
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
   * Mark session as ready
   */
  markSessionReady(sessionId: string): void {
    const sessionProcess = this.sessions.get(sessionId);
    if (sessionProcess && sessionProcess.session.status === 'busy') {
      sessionProcess.session.status = 'ready';
    }
  }
}
