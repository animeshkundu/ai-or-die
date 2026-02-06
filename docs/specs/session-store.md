# SessionStore Specification

Source: `src/utils/session-store.js`

## Overview

`SessionStore` provides atomic, file-based persistence for session data. It serializes the server's in-memory `Map<sessionId, Session>` to JSON on disk and restores it on startup.

---

## Storage Path

```
~/.claude-code-web/sessions.json
```

The directory `~/.claude-code-web/` is created on initialization (`mkdir -p` equivalent) if it does not exist. Future versions will migrate to `~/.cortex/sessions.json`.

---

## Constructor

```js
new SessionStore()
```

- Sets `this.storageDir` to `path.join(os.homedir(), '.claude-code-web')`.
- Sets `this.sessionsFile` to `path.join(this.storageDir, 'sessions.json')`.
- Calls `initializeStorage()` to ensure the directory exists.

---

## Methods

### `saveSessions(sessions: Map) => Promise<boolean>`

Serializes the session Map to disk.

**Process:**

1. Ensures `storageDir` exists via `fs.mkdir(recursive: true)`.
2. Converts the `Map` to an array of plain objects, applying these transformations:
   - `active` is always set to `false` (processes cannot survive restarts).
   - `connections` is serialized as an empty array (WebSocket references are not persistable).
   - `outputBuffer` is truncated to the **last 100 lines** to limit file size.
   - `sessionStartTime` and `sessionUsage` are preserved if present, otherwise default values are used.
3. Wraps the array in an envelope:
   ```json
   {
     "version": "1.0",
     "savedAt": "2026-02-05T10:00:00.000Z",
     "sessions": [ ... ]
   }
   ```
4. Writes to a temp file (`sessions.json.tmp`) first.
5. Renames temp file to `sessions.json` (atomic write to prevent corruption on crash).

**Returns:** `true` on success, `false` on error.

### `loadSessions() => Promise<Map>`

Restores sessions from disk into an in-memory `Map`.

**Process:**

1. Checks file existence via `fs.access`.
2. Reads file contents as UTF-8.
3. Handles empty/whitespace-only files by returning an empty `Map`.
4. Parses JSON with error recovery:
   - On parse failure, renames the corrupted file to `sessions.json.corrupted.<timestamp>` for forensics, then returns an empty `Map`.
5. Validates the parsed structure:
   - Must be a non-null object with a `sessions` array property.
   - Returns an empty `Map` if the structure is invalid.
6. Checks the `savedAt` timestamp -- if older than **7 days**, the data is considered stale and an empty `Map` is returned.
7. For each session entry:
   - Skips entries without an `id` field.
   - Deserializes `created` and `lastActivity` back to `Date` objects.
   - Forces `active = false`.
   - Converts `connections` back to an empty `Set`.
   - Restores `outputBuffer` (defaults to `[]`).
   - Sets `maxBufferSize` to `1000`.
   - Restores `usageData` if available.

**Returns:** `Map<sessionId, Session>`.

**Error handling:** If the file does not exist (`ENOENT`), silently returns an empty `Map`. Other errors are logged to stderr.

### `clearOldSessions() => Promise<boolean>`

Deletes the `sessions.json` file entirely.

### `getSessionMetadata() => Promise<Object>`

Returns metadata about the persistence file without loading full session data.

**Success response:**
```json
{
  "exists": true,
  "savedAt": "2026-02-05T10:00:00.000Z",
  "sessionCount": 5,
  "fileSize": 12345,
  "version": "1.0"
}
```

**Failure response:**
```json
{
  "exists": false,
  "error": "ENOENT: no such file or directory"
}
```

---

## Serialized Session Schema

Each session in the `sessions` array has this shape:

```json
{
  "id": "uuid",
  "name": "Session 2/5/2026, 10:30:00 AM",
  "created": "2026-02-05T10:30:00.000Z",
  "lastActivity": "2026-02-05T11:00:00.000Z",
  "workingDir": "/home/user/project",
  "active": false,
  "outputBuffer": ["line1", "line2", "...up to 100"],
  "connections": [],
  "lastAccessed": 1738750800000,
  "sessionStartTime": "2026-02-05T10:30:00.000Z",
  "sessionUsage": {
    "requests": 0,
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheTokens": 0,
    "totalCost": 0,
    "models": {}
  }
}
```

---

## Integration with Server

The server calls `SessionStore` in these contexts:

| Trigger | Method |
|---------|--------|
| Server startup | `loadSessions()` -- restores sessions into `claudeSessions` Map |
| Every 30 seconds | `saveSessions()` via `setInterval` |
| After session create | `saveSessions()` |
| After session delete | `saveSessions()` |
| On `SIGINT` / `SIGTERM` | `saveSessions()` via `handleShutdown()` |
| On `beforeExit` | `saveSessions()` |
| `GET /api/sessions/persistence` | `getSessionMetadata()` |

---

## Corruption Recovery

The store handles corruption gracefully:

1. **Empty file** -- Detected by checking `!data || !data.trim()`. Returns empty Map.
2. **Invalid JSON** -- Caught by `JSON.parse` try/catch. The corrupted file is renamed with a `.corrupted.<timestamp>` suffix for manual inspection, then returns empty Map.
3. **Invalid structure** -- If parsed data is not an object or lacks a `sessions` array, returns empty Map.
4. **Stale data** -- Sessions older than 7 days are discarded entirely.
5. **Invalid session entries** -- Individual entries without an `id` field are silently skipped.
