# ADR-0008: File Browser Architecture

## Status

**Accepted**

## Date

2026-02-07

## Context

Users access ai-or-die remotely over devtunnels and similar tunnel services. In this environment there is no way to view visual content (images, PDFs), edit files with syntax highlighting, or upload/download files without native desktop tools -- which are not available through the tunnel. The existing `/api/folders` endpoint only lists directories for the working-directory selector and does not expose file contents or metadata.

The application needs a web-based file manager that supports browsing, previewing, editing, uploading, and downloading files directly within the terminal UI, without requiring users to install additional software or leave the browser.

## Decision

We introduce a file browser feature built on these architectural choices:

### REST API (not WebSocket) for file operations

File operations (list, read, write, upload, download) follow a request-response pattern. REST is a natural fit: clients send a request, wait for the response, and render the result. WebSocket would add unnecessary complexity for operations that do not require real-time streaming. The six new endpoints are:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/files` | GET | List directory contents (files + directories), paginated |
| `/api/files/stat` | GET | File metadata (size, modified, MIME category, hash) |
| `/api/files/content` | GET | Read text file content in a JSON envelope with hash |
| `/api/files/content` | PUT | Save text file content with optimistic concurrency (hash) |
| `/api/files/upload` | POST | Upload file as base64 JSON (10 MB limit) |
| `/api/files/download` | GET | Stream file for download or inline preview |

### Right-docked side panel (not modal)

The file browser opens as a docked panel on the right side of the viewport. The terminal remains visible and interactive alongside it. A modal would block terminal access, which defeats the purpose of a file browser in a terminal application. The panel auto-switches to a full-screen overlay on mobile viewports or when the terminal would be squeezed below 80 columns.

### Ace Editor from CDN (not bundled)

Text editing uses the Ace Editor loaded from cdnjs, matching the existing pattern of loading xterm.js from unpkg CDN. This avoids adding npm dependencies for a frontend-only library and keeps the server-side `node_modules` minimal. Ace is lazy-loaded on first editor open, with a loading spinner and a 5-second timeout with fallback error.

### Hash-based optimistic concurrency for file saves

Every text file response includes an MD5 hash computed via streaming (`crypto.createHash` + `fs.createReadStream`). When saving, the client sends the original hash; the server recomputes and returns 409 Conflict if the file was modified externally. This prevents silent overwrites in multi-user or multi-tab scenarios.

### Extension-based MIME detection with binary heuristic

File type detection uses a built-in extension-to-MIME map for known types, supplemented by a null-byte heuristic (reading the first 512 bytes) for unknown extensions. This avoids depending on system-level `file` commands or npm packages like `mime-types`.

### Enhanced validatePath() with symlink resolution

The existing `validatePath()` function is extended to resolve symlinks via `fs.realpathSync()` before the `startsWith` check. This eliminates TOCTOU (time-of-check-to-time-of-use) race conditions where a symlink could be swapped between validation and access.

### File utilities extracted to src/utils/file-utils.js

File-related utility functions (`getFileInfo`, `computeFileHash`, `isBinaryFile`, `sanitizeFileName`) are extracted into a dedicated module rather than being added inline to `server.js` (already 1507 lines). This keeps the server file focused on routing and makes the utilities independently testable.

### No delete or rename in initial release

Destructive file operations are excluded from the MVP to limit the security surface area. Users can still delete or rename files through the terminal. These operations may be added in a follow-up phase.

## Consequences

### Positive

- Visual file preview (images, PDFs, JSON, CSV) works over tunnels without native tools
- Code editing with syntax highlighting and auto-save directly in the browser
- Drag-drop, file picker, and clipboard paste upload for getting files onto the remote machine
- Hash-based conflict detection prevents accidental data loss
- Extracted file utilities are independently testable

### Negative

- No real-time file watching -- directory listings are point-in-time snapshots (would require WebSocket, deferred to Phase 2)
- Ace Editor introduces a CDN dependency for the editing feature (editing is degraded if CDN is unreachable)
- 10 MB upload limit may be insufficient for large assets (chunked upload deferred to Phase 2)

### Neutral

- `/api/folders` and `/api/files` coexist: `/api/folders` lists only directories for the working-directory selector, `/api/files` lists both files and directories for the file browser
- The same `validatePath()` function secures both old and new endpoints
- No new npm dependencies are introduced
