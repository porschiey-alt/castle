# Research: Implement Tailscale Compatibility

## Summary

This document analyzes how to make Castle accessible over a [Tailscale](https://tailscale.com/) network by exposing an HTTP server on a configurable port. When Castle is running, the built Angular UI should be servable over HTTP so that any device on the same Tailscale tailnet can access it via a browser, without needing the Electron shell.

---

## Current Behavior

### Application Architecture

Castle is an **Electron + Angular 17** desktop application:

| Layer | Technology | Location |
|-------|-----------|----------|
| Main process | Electron (Node.js) | `src/main/index.ts` |
| Preload bridge | Electron contextBridge | `src/preload/index.ts` |
| Renderer / UI | Angular 17 (standalone components) | `src/app/` |
| Shared types | TypeScript | `src/shared/` |
| Build output | `dist/renderer/browser/` (Angular), `dist/main/` (Electron) | `dist/` |

### How the UI is Currently Loaded

In **`src/main/window.ts`** (line 67–77):

- **Development mode** (`ELECTRON_DEV_SERVER=true`): The `BrowserWindow` loads from `http://localhost:4200` (Angular dev server).
- **Production mode**: The `BrowserWindow` loads from the built static files at `dist/renderer/browser/index.html` via `loadFile()`.

The built Angular output is a standard SPA with:
- `index.html` (entry point)
- Hashed JS/CSS bundles
- Static assets (`favicon.ico`, `assets/`)

### What's Missing for Remote Access

1. **No HTTP server in production** — In production builds, the Angular UI is loaded directly from disk via `file://`. There is no HTTP server exposing the content over the network.
2. **No configurable port** — There is no setting for a Tailscale/remote-access port.
3. **IPC dependency** — The Angular app communicates with the main process via Electron's IPC (`window.electronAPI`). A browser on a remote Tailscale device won't have access to Electron's `contextBridge` APIs, so the UI loaded over HTTP will not be able to perform any actions (chat, settings, agent management, etc.) without additional work.

---

## Proposed Approach

### Overview

Add an embedded HTTP server to the Electron main process that serves the built Angular static files on a user-configurable port. Tailscale devices on the same tailnet can then navigate to `http://<tailscale-ip>:<port>` and see the Castle UI.

### Phase 1: Static File Server (MVP)

The simplest and most impactful first step is to serve the production-built Angular SPA over HTTP so that a remote browser can render the UI.

#### 1.1 Create a new service: `TailscaleServerService`

**File:** `src/main/services/tailscale-server.service.ts`

This service will:
- Use Node.js's built-in `http` module (no extra dependency required).
- Serve static files from `dist/renderer/browser/`.
- Handle SPA routing by falling back to `index.html` for non-file routes.
- Listen on a configurable port (default: `39417`).
- Bind to `0.0.0.0` so Tailscale (and any local network interface) can reach it.

```typescript
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export class TailscaleServerService extends EventEmitter {
  private server: http.Server | null = null;
  private port: number;
  private staticDir: string;

  constructor(port: number = 39417) {
    super();
    this.port = port;
    // Resolve the built Angular output directory
    this.staticDir = path.join(__dirname, '../renderer/browser');
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err) => {
        console.error('[TailscaleServer] Error:', err);
        reject(err);
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[TailscaleServer] Listening on http://0.0.0.0:${this.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getPort(): number {
    return this.port;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    let filePath = path.join(this.staticDir, url.pathname);

    // Security: prevent directory traversal
    if (!filePath.startsWith(this.staticDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // If the path is a directory, look for index.html
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    // Try to serve the file, fall back to index.html for SPA routing
    if (fs.existsSync(filePath)) {
      this.serveFile(filePath, res);
    } else {
      // SPA fallback — serve index.html
      const indexPath = path.join(this.staticDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        this.serveFile(indexPath, res);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    }
  }

  private serveFile(filePath: string, res: http.ServerResponse): void {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    stream.pipe(res);
    stream.on('error', () => {
      res.writeHead(500);
      res.end('Internal Server Error');
    });
  }
}
```

#### 1.2 Integrate Into Main Process

**File:** `src/main/index.ts`

Add the Tailscale server to the existing service initialization:

```typescript
import { TailscaleServerService } from './services/tailscale-server.service';

let tailscaleServer: TailscaleServerService;

async function initializeServices(): Promise<void> {
  // ... existing initialization ...

  // Start Tailscale-compatible HTTP server
  const settings = await databaseService.getSettings();
  if (settings.tailscaleEnabled) {
    tailscaleServer = new TailscaleServerService(settings.tailscalePort || 39417);
    try {
      await tailscaleServer.start();
    } catch (error) {
      console.error('Failed to start Tailscale server:', error);
    }
  }
}
```

#### 1.3 Add Settings

**File:** `src/shared/types/settings.types.ts`

Extend `AppSettings` with two new fields:

```typescript
export interface AppSettings {
  // ... existing fields ...
  tailscaleEnabled: boolean;
  tailscalePort: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  // ... existing defaults ...
  tailscaleEnabled: false,
  tailscalePort: 39417,
};
```

#### 1.4 Add Constants

**File:** `src/shared/constants.ts`

```typescript
export const DEFAULT_TAILSCALE_PORT = 39417;
```

The port `39417` is chosen to be unlikely to conflict with common services while remaining in the unprivileged range.

#### 1.5 Angular `baseHref` Consideration

The production Angular build currently uses `"baseHref": "./"` (relative). This is compatible with serving from a subdirectory but may cause issues with the SPA fallback when served from an HTTP server. The `baseHref` should be changed to `"/"` in the production config when Tailscale mode is active, or the server should rewrite paths appropriately. The simplest fix is to set `baseHref` to `"/"` in production, which works for both `file://` loading (Electron already sets a proper base) and HTTP serving.

**Recommended approach:** Change `angular.json` production `baseHref` from `"./"` to `"/"` and update `window.ts` to use `loadURL` with a `file://` URL (using `pathToFileURL`) instead of `loadFile()`, ensuring compatibility with both modes.

---

### Phase 2: WebSocket API Bridge (Full Functionality)

Phase 1 gives remote users a **read-only view** of the UI shell. The Angular app will load but fail to function because `window.electronAPI` is undefined in a regular browser. Phase 2 bridges this gap.

#### 2.1 The Problem: Electron IPC Is Not Available Remotely

The Angular renderer communicates with the main process through the preload-exposed `window.electronAPI` object, which uses Electron's `ipcRenderer.invoke()` and `ipcRenderer.on()` under the hood. In a remote browser, none of this exists.

#### 2.2 Solution: WebSocket-Based IPC Proxy

Add a WebSocket server (on the same port or a companion port) that mirrors the IPC channel interface:

1. **WebSocket server** in the main process accepts connections from remote browsers.
2. **Client-side shim** (`tailscale-api-shim.ts`) is injected into the Angular app when `window.electronAPI` is absent. This shim provides the same `ElectronAPI` interface but routes all calls through the WebSocket.
3. The main-process WebSocket handler maps incoming messages to the same service calls the IPC handlers use.

```
Remote Browser                  Castle Main Process
┌──────────────┐    WebSocket   ┌────────────────────┐
│ Angular App  │ ◄────────────► │ WS API Bridge      │
│ + API Shim   │                │ → Same services as  │
│              │                │   IPC handlers       │
└──────────────┘                └────────────────────┘
```

**Message protocol:**

```typescript
// Client → Server
interface WSRequest {
  id: string;           // Correlation ID
  channel: string;      // IPC channel name (e.g., 'chat:sendMessage')
  payload: unknown;     // Same payload shape as IPC
}

// Server → Client
interface WSResponse {
  id: string;           // Correlation ID
  result?: unknown;     // Response data
  error?: string;       // Error message if failed
}

// Server → Client (push events)
interface WSEvent {
  channel: string;      // e.g., 'chat:streamChunk'
  payload: unknown;
}
```

#### 2.3 Implementation Outline

**New files needed:**

| File | Purpose |
|------|---------|
| `src/main/services/ws-bridge.service.ts` | WebSocket server that proxies IPC calls to services |
| `src/app/core/services/api-shim.service.ts` | Angular service that detects Electron vs. remote and provides appropriate API |
| `src/app/core/services/websocket-api.ts` | WebSocket-based implementation of `ElectronAPI` |

**Dependency:** The `ws` npm package (lightweight WebSocket implementation for Node.js). Alternatively, the built-in `http` server can be upgraded to WebSocket using Node's native support, but the `ws` package is more ergonomic.

#### 2.4 API Shim Detection

In the Angular app, create an API abstraction layer:

```typescript
// api-shim.service.ts
@Injectable({ providedIn: 'root' })
export class ApiService {
  private api: ElectronAPI;

  constructor() {
    if (window.electronAPI) {
      // Running in Electron — use native IPC
      this.api = window.electronAPI;
    } else {
      // Running in remote browser — use WebSocket bridge
      this.api = new WebSocketAPI();
    }
  }

  get directory() { return this.api.directory; }
  get agents() { return this.api.agents; }
  get chat() { return this.api.chat; }
  // ... etc.
}
```

All Angular components/services would then inject `ApiService` instead of directly referencing `window.electronAPI`.

---

### Phase 3: Settings UI

Add a section to the Castle settings panel for Tailscale configuration:

- **Enable/Disable toggle** — Controls whether the HTTP server starts.
- **Port field** — Allows the user to choose a custom port.
- **Status indicator** — Shows whether the server is currently running and on which address.
- **Restart button** — Restarts the server if settings change.

---

## Key Considerations

### Security

| Concern | Mitigation |
|---------|-----------|
| **Open port on all interfaces** | Tailscale encrypts traffic within the tailnet. The server binds to `0.0.0.0` but is only reachable through Tailscale's virtual interfaces (100.x.y.z) unless the user's firewall allows LAN access. Consider an option to restrict binding to the Tailscale interface only. |
| **No authentication** | Phase 1 has no auth. For Phase 2, consider requiring a shared secret or token that must be provided via query parameter or header. This prevents unauthorized access if the port is exposed beyond Tailscale. |
| **Directory traversal** | The static file server must validate that all resolved paths remain within `dist/renderer/browser/`. The proposed implementation does this. |
| **WebSocket origin checking** | The WS bridge should validate the `Origin` header to prevent cross-site WebSocket hijacking. |

### Network Binding

- **Tailscale interface only:** Tailscale assigns IPs in the `100.x.y.z` range. To restrict the server to Tailscale-only access, you could enumerate network interfaces and bind specifically to the Tailscale adapter. However, this adds complexity. The simpler approach (bind to `0.0.0.0` + firewall rules) is recommended for MVP.
- **Port conflicts:** The chosen port should be configurable and the server should handle `EADDRINUSE` gracefully, logging a clear error message.

### Performance

- The static file server is lightweight — it only serves the Angular bundle (~1–2 MB total). Performance is not a concern.
- WebSocket connections add negligible overhead compared to Electron IPC.

### Electron Compatibility

- The embedded HTTP server runs in the main process alongside Electron. Node.js's `http` module is fully supported in Electron's main process.
- No changes to the Electron window or preload are needed for Phase 1.
- Phase 2 requires Angular code changes (API abstraction layer) that must remain backward-compatible with the Electron IPC path.

### `baseHref` Handling

The Angular production build currently uses `"baseHref": "./"`. This causes issues when served over HTTP because relative paths resolve differently:

- **Option A:** Change to `"baseHref": "/"` globally. This is the simplest. Electron's `loadFile()` works with absolute base href when using `file://` protocol URLs.
- **Option B:** Keep `"./"` and configure the HTTP server to handle it. This is more complex.
- **Recommendation:** Option A. Update `angular.json` production `baseHref` to `"/"` and switch `window.ts` from `loadFile()` to `loadURL()` with a `file://` URL constructed via `url.pathToFileURL()`.

### Font Loading

The current `index.html` loads Google Fonts from a CDN (`fonts.googleapis.com`). This will work from a remote browser as long as it has internet access. For offline Tailscale environments, consider bundling fonts locally.

---

## Implementation Guidance

### Recommended Implementation Order

1. **Phase 1 — Static HTTP server (MVP)**
   - Create `TailscaleServerService` with Node's `http` module
   - Add `tailscaleEnabled` and `tailscalePort` to `AppSettings`
   - Integrate into `src/main/index.ts` lifecycle
   - Fix `baseHref` for HTTP compatibility
   - Test: Start Castle, navigate to `http://localhost:39417` — the UI shell should load

2. **Phase 2 — WebSocket API bridge**
   - Install `ws` package
   - Create `WsBridgeService` that wraps existing IPC service calls
   - Create Angular `ApiService` abstraction
   - Migrate all `window.electronAPI` references to use `ApiService`
   - Create `WebSocketAPI` client implementation
   - Test: Full functionality from a remote browser

3. **Phase 3 — Settings UI**
   - Add Tailscale section to settings panel
   - Wire toggle/port to the main process
   - Show server status

### Files to Create

| File | Phase | Description |
|------|-------|-------------|
| `src/main/services/tailscale-server.service.ts` | 1 | HTTP static file server |
| `src/main/services/ws-bridge.service.ts` | 2 | WebSocket API proxy |
| `src/app/core/services/api.service.ts` | 2 | Angular API abstraction layer |
| `src/app/core/services/websocket-api.ts` | 2 | WebSocket client implementation of `ElectronAPI` |

### Files to Modify

| File | Phase | Change |
|------|-------|--------|
| `src/main/index.ts` | 1 | Import and start `TailscaleServerService` |
| `src/shared/types/settings.types.ts` | 1 | Add `tailscaleEnabled`, `tailscalePort` |
| `src/shared/constants.ts` | 1 | Add `DEFAULT_TAILSCALE_PORT` |
| `angular.json` | 1 | Change production `baseHref` to `"/"` |
| `src/main/window.ts` | 1 | Switch from `loadFile` to `loadURL` with `file://` |
| `src/app/**/*.ts` (components/services) | 2 | Replace `window.electronAPI` with injected `ApiService` |
| `package.json` | 2 | Add `ws` dependency |
| Settings component | 3 | Add Tailscale configuration UI |

### Dependencies

| Package | Phase | Purpose |
|---------|-------|---------|
| (none — uses Node.js `http`) | 1 | Static file serving |
| `ws` | 2 | WebSocket server |
| `@types/ws` | 2 | TypeScript definitions |

### Port Selection Rationale

Port `39417` was chosen because:
- It is in the unprivileged range (> 1024)
- It does not conflict with well-known services
- It is above the ephemeral port range on most OSes
- The digits spell "CAST" (3=C, 9≈A+ST) loosely relating to the app name

The port should always be user-configurable in case of conflicts.

### Testing Strategy

1. **Unit test:** `TailscaleServerService` can start, serve files, and stop without error.
2. **Integration test:** Start Castle, verify `http://localhost:39417` returns the Angular `index.html`.
3. **Tailscale end-to-end:** From a different machine on the same tailnet, navigate to `http://<castle-machine-tailscale-ip>:39417` and confirm the UI loads.
4. **Phase 2 test:** From a remote browser, verify chat, agent discovery, and settings all work through the WebSocket bridge.

---

## Alternatives Considered

### 1. Electron's Built-in Protocol Handling

Electron supports custom protocols via `protocol.registerFileProtocol()`. This doesn't help with remote access since it only works within the Electron process.

### 2. Express.js or Fastify

Using a full-featured web framework instead of raw `http`. This adds unnecessary weight — the static file serving needs are simple enough for Node's built-in module. If the WebSocket bridge grows complex, Express could be reconsidered.

### 3. Separate Server Process

Running the HTTP server as a separate process instead of embedding it in Electron's main process. This adds deployment complexity with no real benefit, since Node.js in Electron's main process is fully capable.

### 4. Tailscale Serve / Funnel

Tailscale has built-in `tailscale serve` and `tailscale funnel` commands that can proxy local ports. This could be used **in addition to** the embedded server — the user would run `tailscale serve 39417` to make Castle available. However, this requires the user to configure Tailscale externally, so an embedded server is still the better developer experience.

---

## Open Questions

1. **Multi-user access:** Should the WebSocket bridge support multiple simultaneous remote connections? If so, how should state (current directory, active agent sessions) be shared or isolated?
2. **Notification routing:** Currently, events like `CHAT_STREAM_CHUNK` are sent to `mainWindow.webContents`. When a WebSocket client is also connected, should events be broadcast to all clients?
3. **Authentication:** Is a shared token sufficient, or should Tailscale's ACL/identity be leveraged for access control?
4. **HTTPS:** Tailscale provides automatic TLS certificates via `tailscale cert`. Should the HTTP server support TLS directly, or rely on Tailscale's built-in encryption?
