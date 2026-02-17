/**
 * WebSocket Bridge Service
 *
 * Accepts WebSocket connections from remote browsers and proxies
 * IPC-style request/response calls to the same services used by
 * the Electron IPC handlers.  Also broadcasts push events to all
 * connected clients.
 *
 * Message protocol:
 *   Client → Server  { id, channel, payload }   (WSRequest)
 *   Server → Client  { id, result?, error? }     (WSResponse)
 *   Server → Client  { channel, payload }         (WSEvent — push)
 */

import { WebSocketServer, WebSocket } from 'ws';
import type * as http from 'http';
import type { EventSink } from './event-broadcaster';
import { createLogger } from './logger.service';

const log = createLogger('WsBridge');

interface WSRequest {
  id: string;
  channel: string;
  payload: unknown;
}

interface WSResponse {
  id: string;
  result?: unknown;
  error?: string;
}

interface WSEvent {
  channel: string;
  payload: unknown;
}

export class WsBridgeService implements EventSink {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private handlerRegistry: Map<string, (payload: any) => Promise<any>>;

  /**
   * @param handlerRegistry Shared map of IPC channel → handler function,
   *        populated by registerIpcHandlers().
   */
  constructor(handlerRegistry: Map<string, (payload: any) => Promise<any>>) {
    this.handlerRegistry = handlerRegistry;
  }

  /**
   * Attach to an existing HTTP server so WS upgrade shares the same port.
   */
  start(httpServer: http.Server): void {
    this.wss = new WebSocketServer({ server: httpServer });

    this.wss.on('connection', (ws, req) => {
      log.info(`Client connected from ${req.socket.remoteAddress}`);
      this.clients.add(ws);

      ws.on('message', (data) => {
        this.handleMessage(ws, data.toString());
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        log.info('Client disconnected');
      });

      ws.on('error', (err) => {
        log.error('Client error', err);
        this.clients.delete(ws);
      });
    });

    log.info('WebSocket bridge attached to HTTP server');
  }

  stop(): void {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  /** Broadcast a push event to all connected remote clients */
  broadcastEvent(channel: string, payload: unknown): void {
    const message: WSEvent = { channel, payload };
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Handle an incoming request by forwarding it to Electron's ipcMain handlers.
   *
   * Electron's ipcMain.handle() registers handlers that return Promises. We
   * simulate an invoke by finding the registered handler and calling it with a
   * fake IpcMainInvokeEvent.  This reuses all existing handler logic without
   * duplicating it.
   */
  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let request: WSRequest;
    try {
      request = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ id: '?', error: 'Invalid JSON' }));
      return;
    }

    // Window operations are no-ops for remote clients
    if (request.channel.startsWith('window:')) {
      const response: WSResponse = { id: request.id, result: null };
      ws.send(JSON.stringify(response));
      return;
    }

    // Directory select requires a native dialog — not supported remotely
    if (request.channel === 'directory:select') {
      const response: WSResponse = { id: request.id, error: 'Directory selection is not supported from remote clients' };
      ws.send(JSON.stringify(response));
      return;
    }

    // Remote clients must not control the remote server (tailscale) settings
    if (request.channel === 'tailscale:restart' || request.channel === 'tailscale:status') {
      const response: WSResponse = { id: request.id, error: 'Remote server settings cannot be changed from a remote client' };
      ws.send(JSON.stringify(response));
      return;
    }

    // Strip tailscale fields from settings updates by remote clients
    if (request.channel === 'settings:update' && request.payload && typeof request.payload === 'object') {
      const sanitized = { ...(request.payload as Record<string, unknown>) };
      delete sanitized['tailscaleEnabled'];
      delete sanitized['tailscalePort'];
      request = { ...request, payload: sanitized };
    }

    try {
      // Use Electron's internal handler registry.
      // ipcMain._invokeHandlers is not public API, but we can emit a
      // synthetic invoke via a helper.  Instead, we use a well-known
      // workaround: register a one-time listener pair.
      const result = await this.invokeHandler(request.channel, request.payload);
      const response: WSResponse = { id: request.id, result };
      ws.send(JSON.stringify(response));
    } catch (err: unknown) {
      const response: WSResponse = {
        id: request.id,
        error: err instanceof Error ? err.message : String(err),
      };
      ws.send(JSON.stringify(response));
    }
  }

  private invokeHandler(channel: string, payload: unknown): Promise<unknown> {
    const handler = this.handlerRegistry.get(channel);
    if (!handler) {
      return Promise.reject(new Error(`No handler for channel: ${channel}`));
    }
    return handler(payload);
  }
}
