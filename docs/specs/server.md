# Server Specification

Source: `src/server.js` -- class `ClaudeCodeWebServer`

## Constructor

```js
new ClaudeCodeWebServer(options)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | `7777` | HTTP/HTTPS listen port |
| `auth` | string | `undefined` | Bearer token for authentication; when set, all HTTP and WebSocket requests must provide it |
| `noAuth` | boolean | `false` | Disable authentication entirely (`--disable-auth`) |
| `dev` | boolean | `false` | Enable verbose console logging |
| `https` | boolean | `false` | Start an HTTPS server instead of HTTP |
| `cert` | string | -- | Path to PEM certificate file (required when `https` is true) |
| `key` | string | -- | Path to PEM private key file (required when `https` is true) |
| `folderMode` | boolean | `true` | Enable folder-selection UI (defaults to true; always enabled in current CLI) |
| `sessionHours` | number | `5` | Session window duration in hours; also read from `CLAUDE_SESSION_HOURS` env |
| `plan` | string | `'max20'` | Subscription plan type (`pro`, `max5`, `max20`, `custom`); also read from `CLAUDE_PLAN` env |
| `customCostLimit` | number | `50.00` | Dollar cost limit for custom plans; also read from `CLAUDE_COST_LIMIT` env |
| `claudeAlias` | string | `'Claude'` | UI display name for Claude agent; also read from `CLAUDE_ALIAS` env |
| `codexAlias` | string | `'Codex'` | UI display name for Codex agent; also read from `CODEX_ALIAS` env |
| `agentAlias` | string | `'Cursor'` | UI display name for the third agent; also read from `AGENT_ALIAS` env |

### Internal State

| Property | Type | Description |
|----------|------|-------------|
| `claudeSessions` | `Map<string, Session>` | All sessions keyed by UUID |
| `webSocketConnections` | `Map<string, WsInfo>` | Active WebSocket connections keyed by UUID |
| `claudeBridge` | `ClaudeBridge` | Bridge instance managing Claude CLI processes |
| `codexBridge` | `CodexBridge` | Bridge instance managing Codex CLI processes |
| `agentBridge` | `AgentBridge` | Bridge instance managing Cursor Agent processes |
| `sessionStore` | `SessionStore` | Persistence layer for session data |
| `usageReader` | `UsageReader` | Reads JSONL usage logs from `~/.claude/projects/` |
| `usageAnalytics` | `UsageAnalytics` | Calculates burn rate, predictions, plan limits |
| `activityBroadcastTimestamps` | `Map<string, number>` | Per-session throttle timestamps for activity broadcasts |
| `selectedWorkingDir` | string \| null | Currently selected working directory via folder browser |
| `baseFolder` | string | `process.cwd()` at startup -- root for path validation |
| `isShuttingDown` | boolean | Prevents duplicate shutdown sequences |

---

## REST API Endpoints

### Public (pre-auth)

#### `GET /auth-status`
Returns whether authentication is required.

**Response:**
```json
{ "authRequired": true, "authenticated": false }
```

#### `POST /auth-verify`
Validates a token against the server's configured auth token.

**Request body:** `{ "token": "..." }`
**Success:** `{ "valid": true }`
**Failure (401):** `{ "valid": false, "error": "Invalid token" }`

### Protected (behind auth middleware when auth is enabled)

#### `GET /api/health`
Health check.

**Response:**
```json
{ "status": "ok", "claudeSessions": 3, "activeConnections": 2 }
```

#### `GET /api/sessions/list`
List all sessions with metadata.

**Response:**
```json
{
  "sessions": [
    {
      "id": "uuid",
      "name": "Session 2/5/2026, 10:30:00 AM",
      "created": "2026-02-05T10:30:00.000Z",
      "active": true,
      "workingDir": "/home/user/project",
      "connectedClients": 1,
      "lastActivity": "2026-02-05T11:00:00.000Z"
    }
  ]
}
```

#### `POST /api/sessions/create`
Create a new session.

**Request body:** `{ "name": "...", "workingDir": "/path" }`
- `workingDir` is validated against `baseFolder`.
- Falls back to `selectedWorkingDir` or `baseFolder` when omitted.

**Response:**
```json
{ "success": true, "sessionId": "uuid", "session": { "id": "...", "name": "...", "workingDir": "..." } }
```

#### `GET /api/sessions/:sessionId`
Get details of a single session.

**Response:** Session object with `id`, `name`, `created`, `active`, `workingDir`, `connectedClients`, `lastActivity`.

**404** when session ID is unknown.

#### `DELETE /api/sessions/:sessionId`
Delete a session. Stops the running agent process (if any), sends `session_deleted` to all connected WebSocket clients, and removes the session from the in-memory Map and disk persistence.

**Response:** `{ "success": true, "message": "Session deleted" }`

#### `GET /api/config`
Returns server configuration relevant to the client.

**Response:**
```json
{
  "folderMode": true,
  "selectedWorkingDir": "/home/user/project",
  "baseFolder": "/home/user",
  "aliases": { "claude": "Claude", "codex": "Codex", "agent": "Cursor" }
}
```

#### `GET /api/folders`
Browse directories within `baseFolder`.

**Query params:**
- `path` -- directory to list (default: `baseFolder`)
- `showHidden` -- `"true"` to include dotfiles

**Response:**
```json
{
  "currentPath": "/home/user/projects",
  "parentPath": "/home/user",
  "folders": [ { "name": "repo", "path": "/home/user/projects/repo", "isDirectory": true } ],
  "home": "/home/user",
  "baseFolder": "/home/user"
}
```

#### `POST /api/set-working-dir`
Set the server-wide working directory for new sessions.

**Request body:** `{ "path": "/absolute/path" }`
**Response:** `{ "success": true, "workingDir": "/absolute/path" }`

#### `POST /api/folders/select`
Alias for `POST /api/set-working-dir` with identical behavior.

#### `POST /api/create-folder`
Create a new directory inside an allowed parent.

**Request body:** `{ "parentPath": "/base/path", "folderName": "new-dir" }`
- `folderName` must not contain `/` or `\`.
- Both `parentPath` and resulting path are validated.

**Response:** `{ "success": true, "path": "/base/path/new-dir", "message": "..." }`

#### `POST /api/close-session`
Clears `selectedWorkingDir` back to `null`.

**Response:** `{ "success": true, "message": "Working directory cleared" }`

#### `GET /api/sessions/persistence`
Returns persistence metadata from `SessionStore.getSessionMetadata()`.

**Response:**
```json
{
  "exists": true,
  "savedAt": "2026-02-05T10:00:00.000Z",
  "sessionCount": 3,
  "fileSize": 4096,
  "version": "1.0",
  "currentSessions": 3,
  "autoSaveEnabled": true,
  "autoSaveInterval": 30000
}
```

#### `GET /`
Serves `src/public/index.html`.

---

## WebSocket

### Setup

The WebSocket server (`ws.Server`) is attached to the same HTTP(S) server instance. A `verifyClient` callback checks the `?token=` query parameter against `this.auth` when authentication is enabled.

### Connection Lifecycle

1. Client connects. Server assigns a `wsId` (UUID), stores it in `webSocketConnections`, and sends `{ type: "connected", connectionId: wsId }`.
2. If `?sessionId=` is present in the URL and the session exists, the server auto-joins that session.
3. On close or error, the connection is removed from `webSocketConnections` and its session's `connections` Set.

### Message Protocol

All messages are JSON. The `type` field determines the handler.

| Client Message | Description |
|---------------|-------------|
| `create_session` | Create a new session and join it. Fields: `name`, `workingDir`. |
| `join_session` | Join an existing session. Fields: `sessionId`. Replays the last 200 lines of the output buffer. |
| `leave_session` | Disconnect from current session without stopping the agent. |
| `start_claude` | Launch Claude CLI in the current session. Fields: `options` (optional). Pre-checks tool availability. |
| `start_codex` | Launch Codex CLI in the current session. Fields: `options` (optional). Pre-checks tool availability. |
| `start_copilot` | Launch Copilot CLI in the current session. Fields: `options` (optional). Pre-checks tool availability. |
| `start_gemini` | Launch Gemini CLI in the current session. Fields: `options` (optional). Pre-checks tool availability. |
| `start_terminal` | Launch a terminal shell in the current session. Fields: `options` (optional). Pre-checks tool availability. |

**`start_*` Error Handling**: All tool start messages go through `startToolSession`, which sends an `error` message for every failure path:

| Condition | Error message |
|-----------|--------------|
| No session joined | "No session joined. Please create or join a session first." |
| Session not in map | "Session not found. It may have been deleted. Please create a new session." |
| Agent already running | "An agent is already running in this session" |
| Tool not available | "{tool} is not available. Please ensure the {tool} CLI is installed..." |
| Spawn failure | "Failed to start {tool}: {error}" |

| `input` | Send raw terminal input to the running agent. Fields: `data`. |
| `resize` | Resize the pty. Fields: `cols`, `rows`. |
| `stop` | Terminate the running agent process. |
| `ping` | Keep-alive. Server responds with `{ type: "pong" }`. |
| `get_usage` | Request usage statistics. Server responds with `usage_update`. |

| Server Message | Description |
|---------------|-------------|
| `connected` | Initial connection acknowledgment with `connectionId`. |
| `session_created` | Session successfully created. Fields: `sessionId`, `sessionName`, `workingDir`. |
| `session_joined` | Joined an existing session. Fields: `sessionId`, `sessionName`, `workingDir`, `active`, `outputBuffer`. |
| `session_left` | Successfully left the session. Fields: `sessionId`. |
| `session_deleted` | Session was deleted by another client or via REST API. |
| `claude_started` / `codex_started` / `agent_started` | Agent process launched. |
| `claude_stopped` / `codex_stopped` / `agent_stopped` | Agent process terminated. |
| `output` | Terminal output data from the agent. Fields: `data`. |
| `exit` | Agent process exited. Fields: `code`, `signal`. |
| `error` | Error message. Fields: `message`. |
| `info` | Informational message (e.g., "No agent is running"). |
| `pong` | Response to `ping`. |
| `usage_update` | Usage statistics payload (see Usage Analytics spec). |
| `session_activity` | Lightweight notification sent to connections NOT joined to the session, indicating new output. Fields: `sessionId`, `sessionName`. Throttled to 1/second per session. |
| `session_exit` | Sent to non-joined connections when agent exits. Fields: `sessionId`, `sessionName`, `code`, `signal`. |
| `session_error` | Sent to non-joined connections on error. Fields: `sessionId`, `sessionName`. |
| `session_started` | Sent to non-joined connections when a tool starts. Fields: `sessionId`, `sessionName`, `agent`. |
| `session_stopped` | Sent to non-joined connections when a tool stops. Fields: `sessionId`, `sessionName`, `agent`. |

### Broadcasting

`broadcastToSession(sessionId, data)` iterates the session's `connections` Set, verifies each WebSocket is open and belongs to the correct session, then sends the JSON-serialized message.

`broadcastSessionActivity(sessionId, eventType, extraData)` sends a lightweight event to all WebSocket connections that are NOT joined to the specified session. This enables clients to track activity in background sessions for notification purposes without receiving full terminal output. Events use a `session_` prefix to distinguish cross-session events from in-session events (which are unprefixed like `output`, `exit`). The `session_activity` event is throttled to at most once per second per session to avoid flooding during high-output scenarios.

---

## Session Management

### In-Memory Session Object

```js
{
  id: 'uuid',
  name: 'Session 2/5/2026, 10:30:00 AM',
  created: Date,
  lastActivity: Date,
  active: false,                // true when an agent process is running
  agent: null,                  // 'claude' | 'codex' | 'agent' | null
  workingDir: '/path',
  connections: Set<wsId>,       // WebSocket connection IDs
  outputBuffer: [],             // Rolling buffer of terminal output strings
  maxBufferSize: 1000,          // Max items in outputBuffer
  sessionStartTime: Date|null,  // Set on first agent start
  sessionUsage: {               // Aggregated token/cost tracking
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    totalCost: 0,
    models: {}
  }
}
```

### Auto-Save

Sessions are persisted to disk via `SessionStore` every 30 seconds (`setInterval`). The `saveSessionsToDisk()` method also fires:
- After session creation
- After session deletion
- On `beforeExit`
- During graceful shutdown

### Session Restoration

On startup, `loadPersistedSessions()` loads sessions from disk. All sessions are restored with `active: false` and empty `connections` Sets since pty processes do not survive restarts.

---

## Graceful Shutdown

Registered on `SIGINT` and `SIGTERM`. The `handleShutdown()` method:

1. Sets `isShuttingDown = true` to prevent re-entry.
2. Saves all sessions to disk.
3. Clears the auto-save interval.
4. Calls `close()` which:
   - Saves sessions again.
   - Closes the WebSocket server.
   - Closes the HTTP server.
   - Stops all active agent processes (routing to the correct bridge based on `session.agent`).
   - Clears `claudeSessions` and `webSocketConnections` Maps.
5. Calls `process.exit(0)`.

---

## Path Validation

Two methods enforce directory traversal prevention:

- **`isPathWithinBase(targetPath)`** -- Resolves `targetPath` and checks that it starts with the resolved `baseFolder`.
- **`validatePath(targetPath)`** -- Returns `{ valid: true, path: resolvedPath }` or `{ valid: false, error: '...' }`.

Every endpoint that accepts a filesystem path (`/api/folders`, `/api/set-working-dir`, `/api/create-folder`, `/api/sessions/create`, etc.) calls `validatePath()` before performing any I/O. The `baseFolder` is always `process.cwd()` at server startup time.

---

## Static Assets and PWA

- `express.static` serves `src/public/`.
- `manifest.json` is served with `Content-Type: application/manifest+json`.
- Dynamic SVG icons are generated at `/icon-{16,32,144,180,192,512}.png` with monospace "CC" text on a dark background, served as `image/svg+xml` with a 1-year cache header.

---

## Image Upload

The server handles `image_upload` WebSocket messages for the image paste feature. On receipt, it validates the MIME type against an allowlist (PNG, JPEG, GIF, WebP -- no SVG), enforces a 10 MB base64 payload limit and a per-session rate limit of 5 uploads per minute, then writes the decoded image to a temp directory (`<os-tmpdir>/claude-code-web/images/<session-id>/<uuid>.<ext>`). Each session is capped at 1000 images via FIFO eviction. Temp files are cleaned up on session deletion, server shutdown, server startup (stale sweep), and via a periodic 30-minute timer.

See the [Image Paste Specification](image-paste.md) for the full protocol, client-side handling, security constraints, and testing requirements.

---

## File Browser API

Six REST endpoints for browsing, previewing, editing, uploading, and downloading files. All endpoints are behind the auth middleware and validate paths via `validatePath()` with symlink resolution. File utilities are extracted to `src/utils/file-utils.js`.

See the [File Browser Specification](file-browser.md) for the full client-side handling, preview types, editor integration, and testing requirements.

### `GET /api/files`

List directory contents (both files and directories). Coexists with `GET /api/folders`, which lists only directories for the working-directory selector.

**Query params:**
- `path` -- directory to list (default: `baseFolder`)
- `showHidden` -- `"true"` to include dotfiles
- `offset` -- pagination offset (default: `0`)
- `limit` -- max items per page (default: `500`, cap: `1000`)

**Response:**
```json
{
  "currentPath": "/home/user/project",
  "parentPath": "/home/user",
  "items": [
    {
      "name": "src",
      "path": "/home/user/project/src",
      "isDirectory": true,
      "size": 0,
      "modified": "2026-02-05T10:30:00.000Z"
    },
    {
      "name": "index.js",
      "path": "/home/user/project/index.js",
      "isDirectory": false,
      "size": 2048,
      "modified": "2026-02-05T11:00:00.000Z",
      "mimeCategory": "code",
      "previewable": true,
      "editable": true
    }
  ],
  "totalCount": 42,
  "offset": 0,
  "limit": 500
}
```

### `GET /api/files/stat`

Get metadata for a single file or directory, including the streaming MD5 hash.

**Query params:** `path` -- file or directory path.

**Response:**
```json
{
  "path": "/home/user/project/index.js",
  "name": "index.js",
  "size": 2048,
  "modified": "2026-02-05T11:00:00.000Z",
  "isDirectory": false,
  "mimeCategory": "code",
  "previewable": true,
  "editable": true,
  "hash": "d41d8cd98f00b204e9800998ecf8427e"
}
```

### `GET /api/files/content`

Read text file content in a JSON envelope. Binary files are rejected with 415. Text files up to 5 MB are served; larger files return `truncated: true`.

**Query params:** `path` -- file path.

**Response:**
```json
{
  "content": "const express = require('express');\n...",
  "hash": "a1b2c3d4e5f6...",
  "truncated": false,
  "totalSize": 2048
}
```

### `PUT /api/files/content`

Save text file content with hash-based optimistic concurrency. Rate-limited to 30 writes/min/IP.

**Request body:** `{ "path": "...", "content": "...", "hash": "..." }`

**Success (200):** `{ "hash": "new-hash", "size": 2100 }`

**Conflict (409):** `{ "error": "File has been modified externally", "currentHash": "..." }` -- returned when the submitted hash does not match the current file hash.

**Other errors:** 403 (path outside base), 404, 413 (content > 5 MB), 507 (disk full).

### `POST /api/files/upload`

Upload a file as base64-encoded JSON. Uses route-specific `express.json({ limit: '10mb' })` to avoid affecting the global body limit. Rate-limited to 30 writes/min/IP.

**Request body:** `{ "targetDir": "...", "fileName": "...", "content": "<base64>", "overwrite": false }`

**Success (201):** `{ "name": "data.csv", "path": "/home/user/project/data.csv", "size": 4096 }`

**Errors:** 403 (path outside base), 409 (file exists with `overwrite: false`), 413 (> 10 MB), 422 (blocked extension), 507 (disk full).

**Blocked extensions:** `.exe`, `.bat`, `.cmd`, `.com`, `.msi`, `.dll`, `.ps1`, `.vbs`, `.wsf`, `.scr`, `.pif`, `.reg`, `.inf`, `.hta`, `.cpl`, `.jar`.

### `GET /api/files/download`

Stream a file for download or inline preview. Max download size: 100 MB.

**Query params:**
- `path` -- file path (required)
- `inline` -- `"1"` to serve with `Content-Disposition: inline` (for image/PDF preview in browser); default streams as `attachment`

**Security headers** on all content responses: `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Content-Security-Policy: sandbox`.

### Path Validation Enhancement

`validatePath()` is enhanced to resolve symlinks via `fs.realpathSync()` before the `startsWith` check, eliminating TOCTOU race conditions where a symlink could be swapped between validation and file access. This applies to all file browser endpoints as well as the existing folder endpoints.
