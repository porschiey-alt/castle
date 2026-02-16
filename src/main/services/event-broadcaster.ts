/**
 * Event Broadcaster - Centralized event fan-out
 *
 * Routes push events to both the local Electron renderer (via webContents.send)
 * and all connected remote WebSocket clients.
 */

import { BrowserWindow } from 'electron';

export interface EventSink {
  broadcastEvent(channel: string, payload: unknown): void;
}

export class EventBroadcaster {
  private mainWindow: BrowserWindow;
  private remoteSink: EventSink | null = null;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  /** Register a remote event sink (e.g., WsBridgeService), or null to clear */
  setRemoteSink(sink: EventSink | null): void {
    this.remoteSink = sink;
  }

  /** Send an event to the local Electron renderer and all remote clients */
  send(channel: string, payload: unknown): void {
    // Local Electron renderer
    this.mainWindow.webContents.send(channel, payload);
    // Remote WebSocket clients
    if (this.remoteSink) {
      this.remoteSink.broadcastEvent(channel, payload);
    }
  }
}
