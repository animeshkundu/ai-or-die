# VS Code Tunnel Specification

The VS Code Tunnel feature enables users to launch a browser-based VS Code editing experience connected to the server's filesystem. It uses a two-process architecture: a local `code serve-web` HTTP server for the IDE, and a `devtunnel host` process that forwards the local port to a public URL.

---

## Architecture Overview

The feature spans three layers:

1. **Client UI** (`src/public/vscode-tunnel.js`) -- toolbar button, status banners, user interaction
2. **Server manager** (`src/vscode-tunnel.js`) -- two-process lifecycle, binary discovery, auth flow, port allocation
3. **WebSocket protocol** -- bidirectional events between client and server

### Two-Process Model

Each session gets two independent child processes:

| Process | Command | Purpose |
|---------|---------|---------|
| **VS Code Server** | `code serve-web --host 127.0.0.1 --port <port> --connection-token <token> --accept-server-license-terms` | Local HTTP server hosting the VS Code web IDE |
| **Dev Tunnel** | `devtunnel host <tunnelId> -p <port>` | Forwards the local port to a `*.devtunnels.ms` public URL |

The server process binds to `127.0.0.1` on an allocated port. The tunnel process makes that port reachable from the internet. A connection token (`crypto.randomBytes(32).toString('hex')`) is appended as `?tkn=<token>` to both the local and public URLs for access control.

---

## Client: VSCodeTunnelUI

Source: `src/public/vscode-tunnel.js`

### Constructor

| Property | Type | Description |
|----------|------|-------------|
| `app` | Object | Reference to `ClaudeCodeWebInterface` (provides `send()` for WebSocket) |
| `button` | HTMLElement | `#vscodeTunnelBtn` toolbar button |
| `banner` | HTMLElement | `#vscodeTunnelBanner` status banner container |
| `status` | string | `'stopped'` \| `'starting'` \| `'running'` \| `'degraded'` \| `'error'` |
| `url` | string \| null | Primary URL (public if available, otherwise local) |
| `localUrl` | string \| null | Local URL (e.g., `http://localhost:9100/?tkn=<token>`) |
| `publicUrl` | string \| null | Public URL (e.g., `https://<id>.devtunnels.ms/?tkn=<token>`) |
| `authUrl` | string \| null | Authentication URL for device code flow |
| `deviceCode` | string \| null | Device code for authentication |
| `_bannerDismissed` | boolean | Whether the user has dismissed the banner |

### Public API

| Method | Description |
|--------|-------------|
| `toggle()` | Start if stopped/error, show banner if running/starting/degraded |
| `start()` | Send `start_vscode_tunnel` via `this.app.send()`, show starting banner |
| `stop()` | Send `stop_vscode_tunnel` via `this.app.send()`, reset all URL state |
| `copyUrl()` | Copy `this.url` to clipboard with visual feedback |
| `openUrl()` | Open `this.url` in new browser tab |
| `handleMessage(data)` | Route incoming WebSocket events to update state and banner |
| `dismiss()` | Hide banner without stopping the tunnel |

The `start()` and `stop()` methods use `this.app.send()` (not direct WebSocket access). The `send()` method on `ClaudeCodeWebInterface` (`app.js`) handles JSON serialization and WebSocket readyState checking.

### Banner States

| State | Trigger | Content |
|-------|---------|---------|
| Starting | `start()` called | Spinner + "Starting VS Code Tunnel..." + Cancel button |
| Auth | `vscode_tunnel_auth` received | Auth URL + device code + "Open Auth Page" button |
| Running | `vscode_tunnel_started` received | Tunnel URL (stripped of protocol/query) + Copy/Open/Stop buttons |
| Degraded | `vscode_tunnel_status` with `status: 'degraded'` | Spinner + "VS Code Tunnel reconnecting... Server running locally." + Stop button |
| Restarting | `vscode_tunnel_status` with `status: 'restarting'` | Spinner + "Reconnecting VS Code Tunnel..." + Cancel button |
| Error | `vscode_tunnel_error` received | Error message + Retry button (+ install methods if not found) |
| Dismissed | User clicks X | Banner hidden, tunnel continues running |

The running banner displays the URL in a generic format (protocol and query string stripped), not tied to any specific domain pattern. The `_renderRunningBanner` method strips `https?://` prefix and `?...` suffix for display.

### Toolbar Button CSS Classes

| Class | Meaning |
|-------|---------|
| (none) | Stopped, default gray |
| `.starting` | Orange, spinning animation (also used for `restarting` and `degraded`) |
| `.running` | Green with dot indicator |
| `.error` | Red with dot indicator |

The `_updateButton()` method maps `degraded` and `restarting` statuses to the `.starting` CSS class.

---

## Server: VSCodeTunnelManager

Source: `src/vscode-tunnel.js`

### Constructor Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dev` | boolean | `false` | Enable verbose stdout logging |
| `onEvent` | function | `() => {}` | Callback for tunnel events: `(sessionId, event)` |

### Constructor Behavior

At construction time, two parallel async discovery operations are kicked off:

1. `_findCommand()` -- locates the `code` CLI executable
2. `_findDevtunnelCommand()` -- locates the `devtunnel` CLI executable

Both resolve into `this._initPromise` (a `Promise.all`). The instance properties `_command`, `_commandChecked`, `_available` track the VS Code CLI. The properties `_devtunnelCommand`, `_devtunnelChecked`, `_devtunnelAvailable` track the devtunnel CLI.

Additionally, the constructor initializes `_reservedPorts` (a `Set`) for tracking allocated ports across sessions.

### Public API

| Method | Description |
|--------|-------------|
| `async isAvailable()` | Check if both `code` and `devtunnel` CLIs exist (waits for discovery) |
| `isAvailableSync()` | Cached availability (returns `this._available && this._devtunnelAvailable`) |
| `async start(sessionId, workingDir)` | Start server + tunnel for a session |
| `async stop(sessionId)` | Sequenced teardown: kill tunnel, delete devtunnel, kill server, release port |
| `getStatus(sessionId)` | Get tunnel status, localUrl, publicUrl, PIDs |
| `async stopAll()` | Stop all tunnels (server shutdown) |
| `clearAvailabilityCache()` | Re-run both CLI discovery operations |

### Binary Discovery

#### VS Code CLI (`_findCommand`)

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

Candidate paths are tested with `fs.accessSync(candidate, fs.constants.X_OK)`.

#### Dev Tunnel CLI (`_findDevtunnelCommand`)

Uses PATH-only discovery: `where devtunnel` (Windows) or `which devtunnel` (macOS/Linux) with a 5-second timeout. No fixed candidate paths.

### Authentication Flow

Authentication uses the `devtunnel` CLI's OS-level credential store (Microsoft/GitHub device-code flow). There is no direct GitHub auth.

| Step | Command | Behavior |
|------|---------|----------|
| Auth check | `devtunnel user show` | 10s timeout. Exit code 0 = authenticated. |
| Login | `devtunnel user login` | Spawned as child process. Stdout/stderr parsed for device code URLs. |

**Device code detection** parses output for:
- `https://microsoft.com/devicelogin` with code pattern `[A-Z0-9]{6,9}` (primary)
- `https://github.com/login/device` with code pattern `[A-Z0-9]{4}-[A-Z0-9]{4}` (fallback)

Both stdout and stderr are checked (devtunnel may output to either stream). When a device code URL is detected, a `vscode_tunnel_auth` event is emitted so the client can display the auth banner.

Login timeout: 2 minutes (`LOGIN_TIMEOUT_MS`). If exceeded, the login process is killed and authentication is reported as failed.

Cancellation: the user can click Cancel during login; `stop()` kills the login process via `tunnel._loginProcess`.

### Process Lifecycle

The tunnel start is a four-phase process:

**Phase 1 -- Authentication:**
1. Run `devtunnel user show` to check existing credentials
2. If not authenticated, run `devtunnel user login` (device-code flow)
3. Emit `vscode_tunnel_auth` events as device code URLs appear in output
4. Wait for login to complete (exit code 0) or timeout/cancel

**Phase 2 -- Server Spawn:**
1. Spawn `code serve-web --host 127.0.0.1 --port <port> --connection-token <token> --accept-server-license-terms`
2. On Windows, `shell: true` is set (required for `.cmd`/`.bat` files)
3. Parse stdout for `http://localhost` or "Web UI available at" to detect readiness
4. Fallback: after `URL_TIMEOUT_MS` (30s), set `localUrl` optimistically and continue
5. On EADDRINUSE in stderr, release the port, allocate the next one, retry (up to `PORT_RETRY_MAX` = 3 times)

**Phase 3 -- TCP Readiness Wait:**
1. `_waitForPort(port, PORT_WAIT_TIMEOUT_MS)` polls TCP connect to `127.0.0.1:<port>`
2. Polls every 200ms until a connection succeeds or `PORT_WAIT_TIMEOUT_MS` (10s) expires

**Phase 4 -- Tunnel Setup:**
1. `devtunnel create <tunnelId> --allow-anonymous` (idempotent; "Conflict" = already exists)
2. `devtunnel port create <tunnelId> -p <localPort>` (best-effort, idempotent; may fail with GitHub auth due to limited scopes — this is non-fatal)
3. `devtunnel host <tunnelId> -p <localPort>` spawned as long-running child process (the `-p` flag ensures port forwarding works even when step 2 fails)
4. Stdout parsed for `https://<id>.devtunnels.ms` URL
5. Connection token appended: `<baseUrl>?tkn=<token>` (or `&tkn=<token>` if URL already has query params)
6. On URL detection, status set to `running`, emit `vscode_tunnel_started`

### Tunnel ID Format

`aiordie-vscode-<first 12 chars of sessionId, non-alphanumeric stripped>`

### Port Allocation

| Parameter | Value | Description |
|-----------|-------|-------------|
| `VSCODE_BASE_PORT` | `9100` (configurable via `VSCODE_BASE_PORT` env var) | Start of port range |
| `VSCODE_PORT_RANGE` | `100` | Number of ports in range (9100-9199) |
| `PORT_RETRY_MAX` | `3` | Max EADDRINUSE retries per server spawn |
| `PORT_WAIT_TIMEOUT_MS` | `10000` | Max wait for TCP readiness (10 seconds) |

`_allocatePort()` scans from `VSCODE_BASE_PORT` to `VSCODE_BASE_PORT + VSCODE_PORT_RANGE - 1`, returning the first port not in `_reservedPorts`. Returns `null` if all ports are exhausted.

### Connection Token

Generated via `crypto.randomBytes(32).toString('hex')` -- a 64-character hex string. Appended as `?tkn=<token>` to both local and public URLs. The token is set once per tunnel lifecycle and reused across restarts.

### Tunnel State

Each session's tunnel is tracked in `this.tunnels` (a `Map<string, Object>`). The state object fields:

| Field | Type | Description |
|-------|------|-------------|
| `serverProcess` | ChildProcess \| null | The `code serve-web` process |
| `tunnelProcess` | ChildProcess \| null | The `devtunnel host` process |
| `_loginProcess` | ChildProcess \| null | The `devtunnel user login` process (during auth) |
| `localPort` | number | Allocated port from the range |
| `connectionToken` | string | 64-char hex token |
| `localUrl` | string \| null | `http://localhost:<port>/?tkn=<token>` |
| `publicUrl` | string \| null | `https://<id>.devtunnels.ms/?tkn=<token>` |
| `tunnelId` | string | `aiordie-vscode-<sessionPrefix>` |
| `status` | string | `'starting'` \| `'running'` \| `'degraded'` \| `'restarting'` \| `'error'` |
| `sessionId` | string | The associated session ID |
| `workingDir` | string | Working directory for the VS Code server |
| `retryCount` | number | Current crash retry counter (resets after stability threshold) |
| `stopping` | boolean | Whether stop has been requested |
| `_lastSpawnTime` | number \| null | Timestamp of last server spawn |
| `_totalRestarts` | number | Lifetime restart count |
| `_stabilityTimer` | Timeout \| null | Timer for retry counter reset |
| `_restartDelayTimer` | Timeout \| null | Timer for backoff delay |
| `_restartDelayResolve` | function \| null | Resolve function to abort backoff wait |
| `_whichDied` | `'server'` \| `'tunnel'` \| null | Which process exited, drives restart strategy |

### Status Values

| Status | Meaning |
|--------|---------|
| `starting` | Server or tunnel is being spawned |
| `running` | Both server and tunnel processes are alive, public URL available |
| `degraded` | Tunnel process died but server is still alive; local URL still works |
| `restarting` | Server died, both processes being restarted |
| `error` | Fatal failure, retry budget exhausted |
| `stopped` | No processes running (after `stop()` or before `start()`) |

### Restart Behavior

Auto-restart uses capped exponential backoff: `2^(retryCount-1) * 1s`, capped at 30s, max 10 retries.

**Restart strategy depends on `_whichDied`:**

| Died | Behavior |
|------|----------|
| `tunnel` (server still alive) | Set status to `degraded`, clear `publicUrl`, restart tunnel only (`_ensureDevtunnel` + `_spawnTunnel`). Local URL remains available. |
| `server` | Kill tunnel process too, clear both URLs, set status to `restarting`, restart both (`_spawnServer` + `_waitForPort` + `_ensureDevtunnel` + `_spawnTunnel`). |

After `STABILITY_THRESHOLD_MS` (60s) of stable uptime, the retry counter resets to 0 so future crashes get a fresh retry budget.

### Stop Sequence

`stop(sessionId)` performs a sequenced teardown:

1. Set `stopping = true`, clear stability timer
2. Kill login process if in-progress
3. Abort any pending restart backoff delay
4. Kill tunnel process (`SIGTERM`, escalate to `SIGKILL` after 5s)
5. Delete the devtunnel: `devtunnel delete <tunnelId> -y` (fire-and-forget, 10s timeout)
6. Kill server process (`SIGTERM`, escalate to `SIGKILL` after 5s)
7. Release port from `_reservedPorts`, remove tunnel state from map
8. Emit `vscode_tunnel_status` with `status: 'stopped'`

### Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `MAX_VSCODE_TUNNELS` | `5` | Max concurrent tunnels server-wide |
| `VSCODE_BASE_PORT` | `9100` | Start of the local port range |

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_RETRIES` | `10` | Crash retry budget before giving up |
| `URL_TIMEOUT_MS` | `30000` | Max wait for URL after spawn (30s) |
| `HEALTH_CHECK_INTERVAL_MS` | `60000` | Health check interval (60s) |
| `STABILITY_THRESHOLD_MS` | `60000` | Uptime before retry counter resets (60s) |
| `MIN_RESTART_DELAY_MS` | `1000` | Minimum restart backoff (1s) |
| `MAX_RESTART_DELAY_MS` | `30000` | Maximum restart backoff cap (30s) |
| `LOGIN_TIMEOUT_MS` | `120000` | Max time for device-code auth (2 minutes) |
| `VSCODE_BASE_PORT` | `9100` | Start of port range (overridable via env var) |
| `VSCODE_PORT_RANGE` | `100` | Number of ports in range |
| `PORT_RETRY_MAX` | `3` | Max EADDRINUSE retries per server spawn |
| `PORT_WAIT_TIMEOUT_MS` | `10000` | Max wait for TCP readiness (10s) |
| `DEFAULT_MAX_TUNNELS` | `5` | Default max concurrent tunnels |

### Health Check

Every 60s (`HEALTH_CHECK_INTERVAL_MS`), the health check interval inspects all active tunnels:

- If the server process is dead and status is `running` or `degraded`: set `_whichDied = 'server'`, trigger restart
- If the tunnel process is dead and status is `running`: set `_whichDied = 'tunnel'`, trigger restart
- When no tunnels remain, the health check interval is cleared

The health check is started lazily on the first `start()` call via `_ensureHealthCheck()`.

---

## WebSocket Protocol

### Client -> Server

| Message Type | Fields | Description |
|-------------|--------|-------------|
| `start_vscode_tunnel` | (none) | Start server + tunnel for current session |
| `stop_vscode_tunnel` | `sessionId?` | Stop tunnel (defaults to current session) |
| `vscode_tunnel_status` | (none) | Query tunnel status |

### Server -> Client (broadcast to session)

| Message Type | Fields | Description |
|-------------|--------|-------------|
| `vscode_tunnel_started` | `url`, `localUrl`, `publicUrl` | Both processes running, URLs available |
| `vscode_tunnel_status` | `status`, `localUrl?`, `publicUrl?`, `url?`, `pid?`, `tunnelPid?`, `attempt?`, `maxRetries?` | Status update (includes URLs when applicable) |
| `vscode_tunnel_auth` | `authUrl`, `deviceCode` | Authentication required (device code flow) |
| `vscode_tunnel_error` | `message`, `error?`, `fatal?`, `install?` | Error occurred |

**Notes on `vscode_tunnel_started`:**
- `url` is set to `publicUrl` (the public devtunnel URL with token)
- `localUrl` is `http://localhost:<port>/?tkn=<token>`
- `publicUrl` is `https://<id>.devtunnels.ms/?tkn=<token>` (or `null` if tunnel setup failed but server is running)

**Notes on `vscode_tunnel_status`:**
- When `status` is `degraded`, `localUrl` is included (server still running) but `publicUrl` is absent
- When `status` is `restarting`, both `localUrl` and `publicUrl` are absent
- When `status` is `stopped`, all URL fields are null on the client side
- The `attempt` and `maxRetries` fields are included during `degraded` and `restarting` states

### Server Guards

- `start_vscode_tunnel` requires `wsInfo.claudeSessionId` -- client must join a session first
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
- `handleStartVSCodeTunnel(wsId, data)` -- validates session, starts tunnel via `vscodeTunnel.start()`
- `handleStopVSCodeTunnel(wsId, data)` -- stops tunnel via `vscodeTunnel.stop()`
- `handleVSCodeTunnelStatus(wsId)` -- returns current status via `vscodeTunnel.getStatus()`
- `handleVSCodeTunnelEvent(sessionId, event)` -- broadcasts events to session connections via `broadcastToSession()`

### /api/config

The config endpoint includes tunnel availability under the `vscodeTunnel` key:

```json
{
  "vscodeTunnel": {
    "available": true,
    "devtunnelAvailable": true
  }
}
```

- `available`: `true` when both `code` and `devtunnel` CLIs are found (via `isAvailableSync()`)
- `devtunnelAvailable`: `true` when the `devtunnel` CLI specifically is found (via `_devtunnelAvailable`)
- When `available` is `false`, an `install` object with install methods is included (from `InstallAdvisor`)

---

## Styling

Source: `src/public/components/vscode-tunnel.css`

The banner and button use dedicated CSS with responsive layout. Mobile viewports stack banner content vertically. The degraded state reuses the starting banner's spinner animation.
