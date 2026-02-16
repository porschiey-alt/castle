/**
 * API Service - Abstraction layer for Electron IPC vs WebSocket
 *
 * Detects whether the app is running inside Electron (window.electronAPI exists)
 * or in a remote browser, and provides the appropriate API implementation.
 */

import { Injectable } from '@angular/core';
import type { ElectronAPI } from '../../../preload/index';
import { WebSocketAPI } from './websocket-api';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private _api: ElectronAPI;

  /** True when running inside the Electron shell */
  readonly isElectron: boolean;

  constructor() {
    if (typeof window !== 'undefined' && window.electronAPI) {
      this._api = window.electronAPI;
      this.isElectron = true;
    } else {
      this._api = new WebSocketAPI();
      this.isElectron = false;
    }
  }

  get api(): ElectronAPI {
    return this._api;
  }

  get directory() { return this._api.directory; }
  get agents() { return this._api.agents; }
  get chat() { return this._api.chat; }
  get permissions() { return this._api.permissions; }
  get settings() { return this._api.settings; }
  get tailscale() { return this._api.tailscale; }
  get window() { return this._api.window; }
  get app() { return this._api.app; }
  get tasks() { return this._api.tasks; }
  get sync() { return this._api.sync; }
}
