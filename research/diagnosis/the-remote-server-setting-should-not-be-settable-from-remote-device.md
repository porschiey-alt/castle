# Bug: The remote server setting should not be settable from remote device

## Diagnosis and Suggested Fix

### Symptoms

When a user accesses Castle from a remote browser (over the Tailscale/HTTP server), the Settings UI displays the **Remote Access** section—including the "Enable remote access" toggle, the port field, and the Apply button—exactly as it appears on the local Electron app. A remote user can:

1. **Toggle remote access off** — which persists `tailscaleEnabled: false` to the database and could prevent the HTTP server from starting on next launch, locking out all remote clients.
2. **Change the port** — which triggers `tailscale:restart` on a different port, immediately disconnecting the remote user (and all others) with no way to reconnect unless they know the new port.
3. **Restart the Tailscale server** — the `tailscale:restart` IPC channel is not blocked in the WebSocket bridge, so the remote client can invoke it freely.

In short, a remote client can modify the very infrastructure that allows it to connect, creating a self-destructive feedback loop.

### Root Cause Analysis

The bug has **two layers**—one on the backend (WS bridge) and one on the frontend (Angular components):

#### 1. Backend: `ws-bridge.service.ts` does not block tailscale-related channels

**File:** `src/main/services/ws-bridge.service.ts` (lines 116–128)

The WebSocket bridge already blocks certain channels from remote clients:
- `window:*` channels → no-op
- `directory:select` → error response

However, **no blocking exists** for:
- `tailscale:restart` — allows remote clients to restart/stop the HTTP server
- `tailscale:status` — less dangerous, but exposes server internals
- `settings:update` with `tailscaleEnabled` or `tailscalePort` fields — allows remote clients to persist changes that disable remote access

The `settings:update` channel is fully open, so even if `tailscale:restart` were blocked, a remote client could still flip `tailscaleEnabled` to `false` in the database, which would prevent the server from starting on the next app launch.

#### 2. Frontend: Settings components don't check `isElectron`

**Files:**
- `src/app/features/settings/settings-page.component.ts`
- `src/app/features/settings/settings-page.component.html`
- `src/app/shared/components/settings-dialog/settings-dialog.component.ts`
- `src/app/shared/components/settings-dialog/settings-dialog.component.html`

Both settings components unconditionally render the "Remote Access" section. The `ElectronService` exposes an `isElectron` getter (line 103 of `electron.service.ts`) that returns `false` when running over WebSocket, but neither component uses it to conditionally hide the remote access controls.

The `ApiService` (line 17–26 of `api.service.ts`) sets `isElectron = true` only when `window.electronAPI` exists (i.e., running inside Electron). Remote browser clients get `isElectron = false` since they use the `WebSocketAPI` class.

### Suggested Fix

Apply a **defense-in-depth** strategy with changes at both backend and frontend:

#### Fix 1 (Backend — required): Block tailscale channels and strip tailscale fields from settings updates in `ws-bridge.service.ts`

In `src/main/services/ws-bridge.service.ts`, add blocking rules after the existing `directory:select` block (after line 128):

```typescript
// Tailscale operations must not be invokable from remote clients
if (request.channel.startsWith('tailscale:')) {
  const response: WSResponse = {
    id: request.id,
    error: 'Tailscale operations are not supported from remote clients',
  };
  ws.send(JSON.stringify(response));
  return;
}

// Strip tailscale-related fields from remote settings updates
if (request.channel === 'settings:update' && request.payload) {
  const payload = request.payload as Record<string, unknown>;
  delete payload.tailscaleEnabled;
  delete payload.tailscalePort;
}
```

This ensures that even if the frontend is compromised or a raw WebSocket message is crafted, remote clients cannot modify remote access settings or restart/stop the server.

#### Fix 2 (Frontend — recommended): Hide the Remote Access section when not running in Electron

In both `settings-page.component.ts` and `settings-dialog.component.ts`, expose the `isElectron` flag:

```typescript
isElectron = inject(ElectronService).isElectron;
```

Then in both HTML templates, wrap the Remote Access `<section>` with:

```html
@if (isElectron) {
  <!-- existing Remote Access section -->
}
```

**`settings-page.component.html`**: Wrap lines 31–82 (the Remote Access `<section>` and the `<mat-divider />` above it) in `@if (isElectron) { ... }`.

**`settings-dialog.component.html`**: Wrap lines 8–59 (the Remote Access `<div class="settings-section">`) in `@if (isElectron) { ... }`.

This hides the setting entirely from remote users, so they won't see a toggle they can't use.

### Verification Steps

1. **Backend blocking test**: Connect a WebSocket client directly to the server and send:
   - `{ id: "1", channel: "tailscale:restart", payload: { port: 39417 } }` → expect an error response
   - `{ id: "2", channel: "tailscale:status", payload: null }` → expect an error response
   - `{ id: "3", channel: "settings:update", payload: { tailscaleEnabled: false } }` → expect success but verify `tailscaleEnabled` was **not** changed in the database
   - `{ id: "4", channel: "settings:update", payload: { theme: "dark" } }` → expect success (non-tailscale fields still work)

2. **Frontend hiding test**: Open the app from a remote browser:
   - Navigate to Settings → verify the "Remote Access" section is **not visible**
   - Other settings (Theme, About) should still appear and function normally

3. **Local app still works**: Open the Electron app locally:
   - Navigate to Settings → verify the "Remote Access" section **is visible** and fully functional
   - Toggle remote access on/off, change port, apply → all should work as before

4. **Edge case**: A remote client that was already viewing settings when the fix is deployed should not see the remote access section after a page refresh.
