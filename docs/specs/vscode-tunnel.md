# VS Code Tunnel Specification

The VS Code Tunnel feature enables users to launch a VS Code Remote Tunnel directly from the web UI, providing a browser-based VS Code editing experience connected to the server's filesystem.

---

## Architecture Overview

The feature spans three layers:

1. **Client UI** (`src/public/vscode-tunnel.js`) — toolbar button, status banners, user interaction
2. **Server manager** (`src/vscode-tunnel.js`) — process lifecycle, binary discovery, auth flow
3. **WebSocket protocol** — bidirectional events between client and server

---

## Client: VSCodeTunnelUI

Source: `src/public/vscode-tunnel.js` (~307 lines)

### Constructor

| Property | Type | Description |
|----------|------|-------------|
| `app` | Object | Reference to `ClaudeCodeWebInterface` (provides `send()` for WebSocket) |
| `button` | HTMLElement | `#vscodeTunnelBtn` toolbar button |
| `banner` | HTMLElement | `#vscodeTunnelBanner` status banner container |
| `status` | string | `'stopped'` \| `'starting'` \| `'running'` \| `'error'` |
| `url` | string \| null | Tunnel URL (e.g., `https://vscode.dev/tunnel/<name>`) |
| `authUrl` | string \| null | Authentication URL for device code flow |
| `deviceCode` | string \| null | Device code for authentication |

### Public API

| Method | Description |
|--------|-------------|
| `toggle()` | Start if stopped/error, show banner if running/starting |
| `start()` | Send `start_vscode_tunnel` via `this.app.send()`, show starting banner |
| `stop()` | Send `stop_vscode_tunnel` via `this.app.send()`, reset state |
| `copyUrl()` | Copy tunnel URL to clipboard with visual feedback |
| `openUrl()` | Open tunnel URL in new browser tab |
| `handleMessage(data)` | Route incoming WebSocket events to update state and banner |
| `dismiss()` | Hide banner without stopping the tunnel |

**Important:** The `start()` and `stop()` methods use `this.app.send()` (not direct WebSocket access). The `send()` method on `ClaudeCodeWebInterface` (`app.js:715`) handles JSON serialization and WebSocket readyState checking. This is the established pattern used throughout the codebase.

### Banner States

| State | Trigger | Content |
|-------|---------|---------|
| Starting | `start()` called | Spinner + "Starting VS Code Tunnel..." + Cancel button |
| Auth | `vscode_tunnel_auth` received | Auth URL + device code + "Open Auth Page" button |
| Running | `vscode_tunnel_started` received | Tunnel URL + Copy/Open/Stop buttons |
| Error | `vscode_tunnel_error` received | Error message + Retry button (+ install link if not found) |
| Dismissed | User clicks X | Banner hidden, tunnel continues running |

### Toolbar Button CSS Classes

| Class | Meaning |
|-------|---------|
| (none) | Stopped, default gray |
| `.starting` | Orange, spinning animation |
| `.running` | Green with dot indicator |
| `.error` | Red with dot indicator |

---

## Server: VSCodeTunnelManager

Source: `src/vscode-tunnel.js` (~520 lines)

### Constructor Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dev` | boolean | `false` | Enable verbose stdout logging |
| `onEvent` | function | `() => {}` | Callback for tunnel events: `(sessionId, event)` |

### Public API

| Method | Description |
|--------|-------------|
| `async isAvailable()` | Check if `code` CLI exists (waits for discovery) |
| `isAvailableSync()` | Cached availability (safe after init) |
| `async start(sessionId, workingDir)` | Start a tunnel for a session |
| `async stop(sessionId)` | Stop a session's tunnel |
| `getStatus(sessionId)` | Get tunnel status/URL/PID |
| `async stopAll()` | Stop all tunnels (server shutdown) |

### Binary Discovery (`_findCommand`)

Platform-specific candidate paths checked in order:

**Windows:**
1. `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd`
2. `%ProgramFiles%\Microsoft VS Code\bin\code.cmd`
3. `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code`
4. PATH fallback via `where code`

**macOS:**
1. `/usr/local/bin/code`
2. `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`
3. `~/.local/bin/code`
4. PATH fallback via `which code`

**Linux:**
1. `/usr/bin/code`
2. `/usr/local/bin/code`
3. `/snap/bin/code`
4. `~/.local/bin/code`
5. PATH fallback via `which code`

### Process Lifecycle

1. **Spawn:** `code tunnel --accept-server-license-terms --no-sleep --name <name>`
2. **Stdout parsing:** Detects auth URLs, device codes, and tunnel URLs via regex
3. **URL timeout:** 30s warning if no URL appears (process kept alive for auth flow)
4. **Health check:** Every 60s, verifies tunnel process is still running
5. **Auto-restart:** On non-zero exit, exponential backoff (1s → 30s cap, max 10 retries)
6. **Stability reset:** After 60s stable uptime, retry counter resets to 0

### Tunnel Name Format

`aiordie-<first 12 chars of sessionId, alphanumeric only>`

### Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `MAX_VSCODE_TUNNELS` | 5 | Max concurrent tunnels server-wide |

---

## WebSocket Protocol

### Client → Server

| Message Type | Fields | Description |
|-------------|--------|-------------|
| `start_vscode_tunnel` | (none) | Start tunnel for current session |
| `stop_vscode_tunnel` | `sessionId?` | Stop tunnel (defaults to current session) |
| `vscode_tunnel_status` | (none) | Query tunnel status |

### Server → Client (broadcast to session)

| Message Type | Fields | Description |
|-------------|--------|-------------|
| `vscode_tunnel_started` | `url` | Tunnel is running, URL available |
| `vscode_tunnel_status` | `status`, `url?`, `pid?` | Status update |
| `vscode_tunnel_auth` | `authUrl`, `deviceCode` | Authentication required |
| `vscode_tunnel_error` | `message`, `error?`, `fatal?` | Error occurred |

### Server Guards

- `start_vscode_tunnel` requires `wsInfo.claudeSessionId` — client must join a session first
- If no session joined, responds with `vscode_tunnel_error: "Join a session first"`

---

## Integration Points

### app.js

| Property/Method | Description |
|----------------|-------------|
| `_vscodeTunnelUI` | Lazy-initialized `VSCodeTunnelUI` instance |
| `toggleVSCodeTunnel()` | Create UI if needed, call `toggle()` |
| `stopVSCodeTunnel()` | Delegate to `_vscodeTunnelUI.stop()` |
| `copyVSCodeTunnelUrl()` | Delegate to `_vscodeTunnelUI.copyUrl()` |

WebSocket message routing (in `handleMessage`): events `vscode_tunnel_started`, `vscode_tunnel_status`, `vscode_tunnel_auth`, `vscode_tunnel_error` are forwarded to `_vscodeTunnelUI.handleMessage()`.

### Command Palette

| Action | Shortcut | Description |
|--------|----------|-------------|
| Start VS Code Tunnel | Ctrl+Shift+V | Toggle tunnel on/off |
| Stop VS Code Tunnel | -- | Stop running tunnel |
| Copy VS Code Tunnel URL | -- | Copy URL to clipboard |

### server.js

Server-side handlers in `ClaudeCodeWebServer`:
- `handleStartVSCodeTunnel(wsId, data)` — validates session, starts tunnel
- `handleStopVSCodeTunnel(wsId, data)` — stops tunnel
- `handleVSCodeTunnelStatus(wsId)` — returns current status
- `handleVSCodeTunnelEvent(sessionId, event)` — broadcasts events to session connections

### /api/config

The config endpoint includes tunnel availability:
```json
{
  "tools": {
    "vscodeTunnel": { "available": true }
  }
}
```

---

## Styling

Source: `src/public/components/vscode-tunnel.css` (~237 lines)

The banner and button use dedicated CSS with responsive layout. Mobile viewports stack banner content vertically.
