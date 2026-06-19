# File Browser Specification

A web-based file manager that provides browsing, previewing, editing, uploading, and downloading of files within the terminal UI. Designed for remote access scenarios (devtunnels) where native desktop tools are unavailable.

---

## Overview

### User Entry Points

| Entry Point | Trigger | Behavior |
|-------------|---------|----------|
| Keyboard shortcut | `Ctrl+B` | Toggle file browser panel open/closed |
| Tab bar button | Click "Files" button | Toggle file browser panel |
| Command palette | `Ctrl+K` then "Toggle File Browser" | Toggle file browser panel |
| Terminal context menu | Right-click on a file path in terminal output | Open file browser navigated to that file |
| Open by path | `Ctrl+Shift+O` or command palette "Open File by Path..." | Prompt for a file path, open directly |
| Fuzzy file-find | `Ctrl/Cmd+P` | Open the "Go to File" panel; type to filter, Enter to open in preview tab |
| Click any path in terminal output | Single-click on a detected path token | Resolve via the candidate chain (absolute → liveCwd → workingDir → repoRoot); on a single hit open in preview tab; on multiple hits show an inline picker. See [Universal terminal-path detection](#terminalpathdetector-and-xterm-link-provider). |
| Drop *any* file onto the page | Drag-drop a non-image file onto the terminal | Upload to `<workingDir>/.claude-attachments/`; inject `@<absolute-path>` into the terminal as bracketed paste. See [Generic file drop](#generic-file-drop). |

### Data Flow

```
Browse:   GET /api/files?path=<dir>                    -> file/folder listing
Preview:  GET /api/files/content?path=<file>           -> text in JSON envelope with hash
Serve:    GET /api/files/download?path=<file>&inline=1 -> stream binary (images, PDF) inline
Edit:     GET content -> Monaco Editor -> PUT /api/files/content -> save with hash
Upload:   drag-drop / picker / paste -> POST /api/files/upload (base64 JSON, 10MB)
Download: GET /api/files/download?path=<file>          -> Content-Disposition: attachment
Watch:    GET /api/files/watch?session=<id>            -> SSE stream of {type,path,relPath,mtime,hash?,prevPath?}
          POST /api/files/watch/subscribe?path=<abs>   -> add path to active set
          POST /api/files/watch/unsubscribe?path=<abs> -> remove from active set
Find:     GET /api/files/find?q=&path=&limit=          -> fuzzy filename search; rg --files + fuzzysort
RepoRoot: GET /api/sessions/:id/repo-root              -> { root: <abs|null> } (git rev-parse --show-toplevel, cached per session)
LiveCwd:  WebSocket frame {type:'cwd_changed',sessionId,cwd,prev,source:'osc7'}
          (Terminal-bridge sessions only; emitted by the OSC 7 parser)
```

Reactive sync (the Watch channel) keeps open editor tabs and the directory listing in step with on-disk reality without user-driven refresh — the central architectural piece for an AI-driven coding UI where the agent edits files concurrently with the user. See "Reactive file-system sync" below and [ADR-0017](../adrs/0017-fs-watcher-push-channel.md).

---

## Server API

Source: `src/server.js` (endpoints registered in `setupExpress()`) and `src/utils/file-utils.js` (utilities).

All endpoints are behind the auth middleware when authentication is enabled. All paths are validated by `validatePath()` with symlink resolution.

### Endpoints

#### `GET /api/files`

List directory contents (files and directories).

**Query params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | session root, else `baseFolder` | Directory to list. When omitted, the default root is resolved from `session` (see below). |
| `session` | string | — | Active session id. When `path` is omitted, the root defaults to that session's `liveCwd ?? workingDir` (the dir the tab's agent was started in), so the browser opens at the tab's directory rather than the server's launch dir. Ignored when `path` is present. Unknown/stale session ids or sessions without a working dir fall back to `baseFolder` (never 403). |
| `showHidden` | string | `"false"` | `"true"` to include dotfiles |
| `offset` | number | `0` | Pagination offset |
| `limit` | number | `500` | Max items per page (cap: 1000) |

The response `home` field reflects the resolved session root (so the client's "Home" button returns to the tab's dir), while `baseFolder` remains the server sandbox floor — they differ for any session rooted in a subdirectory of `baseFolder`.

**Response (200):**

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

**Errors:** 403 (path outside base), 404 (directory not found).

#### `GET /api/files/stat`

Get metadata for a single file or directory.

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | File or directory path |

**Response (200):**

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

**Errors:** 403, 404.

#### `GET /api/files/content`

Read text file content in a JSON envelope.

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | File path |

**Response (200):**

```json
{
  "content": "const express = require('express');\n...",
  "hash": "a1b2c3d4e5f6...",
  "truncated": false,
  "totalSize": 2048
}
```

Text files up to 5 MB are served. Files exceeding this limit return `truncated: true` with partial content. Binary files are rejected with 415 Unsupported Media Type.

**Errors:** 403, 404, 415 (binary file).

#### `PUT /api/files/content`

Save text file content with optimistic concurrency.

**Request body:**

```json
{
  "path": "/home/user/project/index.js",
  "content": "const express = require('express');\n...",
  "hash": "a1b2c3d4e5f6..."
}
```

**Response (200):**

```json
{
  "hash": "f6e5d4c3b2a1...",
  "size": 2100
}
```

**Conflict (409):** The file was modified externally since the hash was obtained.

```json
{
  "error": "File has been modified externally",
  "currentHash": "new-hash-value"
}
```

**Errors:** 403, 404, 409 (hash mismatch), 413 (content > 5 MB), 507 (disk full).

**Rate limit:** 30 write operations per minute per IP.

#### `POST /api/files/upload`

Upload a file as base64-encoded JSON. Uses route-specific `express.json({ limit: '20mb' })`.

> **Body-parser ordering (important):** the global `app.use(express.json())` (Express default ~100 KB limit) is mounted with an exemption that skips `/api/files/upload` (trailing-slash normalized), so this route's own 20 MB parser is the only one that runs. Without the exemption the ~100 KB global limit rejected any base64 body over ~75 KB with a 413 *before* the route, which silently broke non-image drag-drop uploads (images upload over a separate WebSocket frame and were unaffected). The route parser is sized for base64 of the 10 MB decoded cap (~14 MB); the `buffer.length > 10 MB` check remains the real per-file cap. Body-parser rejections (oversize/malformed) are translated to a JSON `{ error }` response by a trailing error-handling middleware (keyed on `err.type`), not Express's default HTML.

**Request body:**

```json
{
  "targetDir": "/home/user/project",
  "fileName": "data.csv",
  "content": "<base64-encoded>",
  "overwrite": false
}
```

**Response (201):**

```json
{
  "name": "data.csv",
  "path": "/home/user/project/data.csv",
  "size": 4096
}
```

When `overwrite` is `false` and the file exists, returns 409 with options to overwrite or keep both.

**Errors:** 403, 409 (file exists, overwrite=false), 413 (> 10 MB), 422 (blocked extension), 507 (disk full).

**Blocked extensions:** `.exe`, `.bat`, `.cmd`, `.com`, `.msi`, `.dll`, `.ps1`, `.vbs`, `.wsf`, `.scr`, `.pif`, `.reg`, `.inf`, `.hta`, `.cpl`, `.jar`.

**Rate limit:** 30 write operations per minute per IP.

#### `GET /api/files/download`

Stream a file for download or inline preview.

**Query params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | -- | File path (required) |
| `inline` | string | `"0"` | `"1"` to serve with inline Content-Disposition (for image/PDF preview) |

**Response:** Raw file stream with appropriate `Content-Type` header.

- Default: `Content-Disposition: attachment; filename="name.ext"` (triggers download).
- With `inline=1`: `Content-Disposition: inline` (renders in browser for images, PDFs).

**Security headers on all content responses:**

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `Cache-Control` | `no-store` |
| `Content-Security-Policy` | `sandbox` |

**Errors:** 403, 404.

**Read limit:** 100 MB max download size.

#### `GET /api/files/watch`

Open a Server-Sent Events (SSE) stream of file-system change events for the active session. **One stream per session, multiplexed via the subscribe/unsubscribe control endpoints below.** Per [ADR-0017](../adrs/0017-fs-watcher-push-channel.md).

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `session` | string | Required. Claude session id; the watcher is rooted at the session's `workingDir`. |
| `token` | string | Auth token (when auth is enabled). EventSource cannot carry custom headers, so the token rides via `?token=` per `AuthManager#appendAuthToUrl`. Same pattern as `<img>` / `<iframe>` / PDF.js worker URLs (#96). |

**Response:** SSE stream. Each event has `data:` containing a JSON object:

```json
{
  "type": "change" | "add" | "unlink" | "rename",
  "path": "/abs/path/to/file.js",
  "relPath": "src/file.js",
  "mtime": 1715692800123,
  "hash": "<md5, only on `change` for text ≤5MB>",
  "prevPath": "/abs/old/path.js (only on `rename`)"
}
```

- `add` / `unlink` for file creation / deletion.
- `change` for content modification of an existing file.
- `rename` for same-inode `add` + `unlink` pairs that occur within a 50ms server-side coalescing window (chokidar's `alwaysStat: true` provides the inode). Falls back to separate `add` + `unlink` if the window misses.

The watcher runs with `chokidar`'s `awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 }` (~110ms latency, suppresses mid-write false positives) plus a 100ms per-path debounce (collapses agent batch refactors) plus a 50ms server-side `add+change` dedup (collapses atomic-rename save). All three thresholds are tunable via `FS_WATCHER_STABILITY_MS`, `FS_WATCHER_POLL_MS`, and `FS_WATCHER_DEBOUNCE_MS` env vars.

**Ignored directories:** mirrors `/api/search`'s `EXCLUDE_DIRS` — `node_modules`, `.git`, `dist`, `build`, `target`, `.next`, `.cache`, `__pycache__`, `.venv`, `venv`, `.tox`, `.gradle`. Configurable via `FS_WATCHER_IGNORE` env var (comma-separated). `.gitignore` parsing deferred.

**Initial state:** the stream emits ONLY changes, never an initial snapshot. Clients use `GET /api/files?path=<dir>` for the initial directory listing.

**Concurrent-watcher cap:** state-based, **5 open watchers per IP**. The 6th `GET /api/files/watch` with a different session id rejected with 429. Decrements on `req.on('close')`.

**Per-session event-emission cap:** ~100 events/min (rate-based) on top of the three coalescing layers, as a final backpressure.

**Errors:** 401 (no token in auth mode), 403 (validatePath rejects `<dir>`), 429 (concurrent-watcher cap exceeded).

#### `POST /api/files/watch/subscribe`

Add a path to the active subscription set for a session's open SSE stream.

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `session` | string | Required. Must match an open SSE stream. |
| `path` | string | Required. Absolute path. validatePath() funneled. |
| `token` | string | Auth token (when auth enabled). |

**Response:** 204 No Content on success.

The server's chokidar watcher watches the SUPERSET of all subscribed paths' parent directories — narrower than the entire `workingDir`, broader than per-file. Subsequent SSE events for `path` will arrive on the open EventSource for that session.

**Errors:** 401, 403, 404 (no open SSE stream for that session id), 409 (subscription already active for this path).

#### `POST /api/files/watch/unsubscribe`

Remove a path from the active subscription set.

**Query params:** same shape as `/subscribe`.

**Response:** 204 No Content on success (idempotent — unsubscribing an already-unsubscribed path returns 204).

**Errors:** 401, 403, 404 (no open SSE stream for that session).

#### `GET /api/files/find`

Fuzzy filename search over the active root. Backs the Cmd-P "Go to File" panel.

**Query params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `q` | string | required | Fuzzy query string. Empty / whitespace-only returns 400. |
| `path` | string | `liveCwd ?? session.workingDir` | Directory to enumerate. Funnelled through `validatePath()`. |
| `limit` | number | `50` | Max matches returned. Cap: `200`. |
| `session` | string | required | Session id; used for per-session rate limiting and live-CWD lookup. |

**Pipeline:**

1. Run `rg --files --hidden --glob '!.git'` rooted at `path` (via the same backend selected in [ADR-0018](../adrs/0018-bundled-ripgrep-search-backend.md): system `rg` → bundled `@vscode/ripgrep` → Linux `grep -rIn` → hard-error). On a 50k-file repo `rg --files` returns in ~50–150 ms. **No cache** — cache invalidation under chokidar + cd-induced root changes is more complexity than the round-trip cost justifies for v1.
2. Score the candidate list with [`fuzzysort`](https://github.com/farzher/fuzzysort) (~5 KB MIT runtime dep). Acronym matches, contiguous bonuses, basename boosts, case folding all come out of the box; this is the deliberate trade against a custom 60-LOC ranker.
3. Hard cap: enumerate up to **10,000 files**. Above that, return `{ truncated: true, totalFound }` so the UI can render a "Refine your search — N files in this tree" hint instead of blocking the event loop on a giant fuzzysort sweep.
4. Sort by score desc; limit; return.

**Response (200):**

```json
{
  "matches": [
    { "path": "/abs/src/app.js", "basename": "app.js", "score": -120, "mtimeMs": 1715692800123 }
  ],
  "truncated": false,
  "totalFound": 4231,
  "queryMs": 87
}
```

`score` is `fuzzysort`'s native score (higher is better; negative when partial). `truncated` is `true` only when enumeration hit the 10k cap.

**Errors:** 400 (empty `q`), 403 (`validatePath` rejects `path`), 429 (per-session rate limit exceeded), 503 (search backend unavailable per ADR-0018).

**Rate limit:** **5 queries / second / session** (state-based, sliding window). Per-session — not per-IP — because IP rate limiting is the wrong granularity behind reverse proxies and shared deployments. Excess returns 429 immediately.

#### `GET /api/sessions/:id/repo-root`

Resolve the git repository root for a session's working directory. Used by the client-side path resolver chain (see [Universal terminal-path detection](#terminalpathdetector-and-xterm-link-provider)) so that paths like `src/app.js` inside a stack trace can be tried against the repo root in addition to `liveCwd` and `workingDir`.

**Response (200):**

```json
{ "root": "/abs/path/to/repo" }
```

If the session's `workingDir` is not inside a git repo, returns `{ "root": null }`.

**Implementation:** `git rev-parse --show-toplevel` rooted at `session.workingDir`, with stdout trimmed and the result cached per session for the session's lifetime (invalidated only on session delete; the repo root does not move during a session). Output goes through `validatePath()` before the response is sent.

**Errors:** 403 (session's workingDir not inside the sandbox), 404 (no such session id), 503 (`git` binary not available).

#### WebSocket frame: `cwd_changed`

Terminal-bridge sessions only. Emitted by the OSC 7 parser whenever `session.liveCwd` changes (post-validation). Subscribers update their `_liveCwd` map and, for the panel that owns the session, optionally re-root.

```json
{
  "type": "cwd_changed",
  "sessionId": "uuid",
  "cwd": "/Users/foo/code/other-repo",
  "prev": "/Users/foo/code",
  "source": "osc7"
}
```

`source` is reserved for future signal types (`'cli-protocol'`, `'manual'`, ...); v1 only ever emits `'osc7'`. See [ADR-0019](../adrs/0019-osc7-cwd-tracking.md) for the parser contract, the `_followsTerminal` toggle UX, and the cross-platform path-handling rationale.

---

## Client Architecture

### Files

| File | Source | Description |
|------|--------|-------------|
| `file-browser.js` | `src/public/file-browser.js` | `FileBrowserPanel`, `FilePreviewPanel`, `TerminalPathDetector`, `attachLinkProvider` |
| `file-editor.js` | `src/public/file-editor.js` | `FileEditorPanel` (Monaco-based; ADR-0016) |
| `file-viewer-monaco.js` | `src/public/file-viewer-monaco.js` | `loadMonaco()`, `createCodeViewer()`, `getMonacoLanguage()`, `resolveMonacoTheme()`, `applyThemeToAll()`, `renderPlainTextFallback()` |
| `markdown-render.js` | `src/public/markdown-render.js` | `marked` + `DOMPurify` hook + lazy mermaid + lazy KaTeX |
| `file-tabs.js` | `src/public/file-tabs.js` | `TabManager` — multi-file tab strip, per-tab Monaco models, localStorage persistence keyed by session id, fs-watcher subscription lifecycle (per ADR-0017) |
| `file-diff.js` | `src/public/file-diff.js` | `DiffViewerPanel` — `monaco.editor.createDiffEditor` wrapper. Side-by-side read-only diff with intra-line highlighting. Convenience helpers `openHeadVsWorking(path)` / `openRefVsWorking(path, ref)` / `openFileVsFile(a, b)` / `openMemoryVsFile(memContent, diskPath)` (the last entry point for the dirty-tab toast's Compare button per ADR-0017). Mounted by TabManager mode `'diff'`. |
| `notebook-render.js` | `src/public/notebook-render.js` | Read-only Jupyter `.ipynb` viewer. Lazy-loads kokes/nbviewer.js (~50 KB) on first use, parses + renders into a scratch DIV, then sanitises through DOMPurify (same FORBID_ATTR/FORBID_TAGS profile as `markdown-render.js`) before inserting into the live DOM. |
| `file-search.js` | `src/public/file-search.js` | `SearchPanel` — cross-file search panel toggled via `Cmd/Ctrl+Shift+F`. Streams matches from `GET /api/search` (SSE; ripgrep via system PATH or bundled `@vscode/ripgrep` per [ADR-0018](../adrs/0018-bundled-ripgrep-search-backend.md), grep belt-and-suspenders on Linux). Result-row click routes through `app.openFileInViewer(path, line, col)` → `_pendingJumpTo` → Monaco preview tab at the matched line. |
| `file-find.js` | `src/public/file-find.js` | `FindPanel` — Cmd-P "Go to File" fuzzy filename picker. Reuses `SearchPanel`'s shell (input, results list, keyboard nav). Calls `GET /api/files/find` with 120 ms debounce + `AbortController` on every keystroke. Enter opens preview tab; Cmd/Ctrl+Enter opens editor tab. Basename bold + parent dimmed (VS Code convention). |
| `generic-drop-handler.js` | `src/public/generic-drop-handler.js` | Non-image drop pipeline. Sibling to `image-handler.js` (the image flow stays as-is per [ADR-0016](../adrs/0016-monaco-based-file-browser-editor.md)'s just-shipped surface). Dispatches by MIME at the terminal container; image MIMEs delegate to `attachImageHandler`, all others upload to `<workingDir>/.claude-attachments/` and inject `@<absolute-path>` as bracketed paste. See [Generic file drop](#generic-file-drop). |
| `file-pdf-viewer.js` | `src/public/file-pdf-viewer.js` | PDF.js wrapper with thin viewer chrome (prev/next/zoom/fit) |
| `monaco-worker-shim.js` | `src/public/vendor/monaco-worker-shim.js` | Same-origin Web Worker; bootstraps Monaco's CDN worker via `importScripts` (gated by exact-prefix base-URL allowlist; ADR-0016) |
| `panzoom.min.js` | `src/public/vendor/panzoom.min.js` | Vendored `@panzoom/panzoom` 4.6.0 (~10 KB MIT) |
| `pdfjs/` | `src/public/vendor/pdfjs/` | Vendored PDF.js 4.x distribution (~600 KB gz) |
| `file-browser.css` | `src/public/components/file-browser.css` | Panel layout, file list, preview, editor, tabs, viewers |

### FileBrowserPanel

The navigation panel that displays directory listings and handles file selection.

**Public API:**

| Method | Description |
|--------|-------------|
| `open(startPath)` | Open panel to a directory path |
| `close()` | Close panel, restore terminal width |
| `toggle()` | Toggle open/closed |
| `isOpen()` | Returns boolean |
| `openToFile(filePath)` | Navigate to parent directory, auto-select the file |
| `navigateTo(path)` | Fetch directory listing from `GET /api/files` and render |
| `navigateUp()` | Navigate to parent directory |
| `navigateHome()` | Navigate to the active session's working dir (server-reported `home`), falling back to the sandbox base before the first listing loads |
| `notifyActiveSessionChanged(sessionId)` | Re-root an open panel to a newly active tab's session. The panel is a singleton across tabs and `open()` short-circuits when already open, so a tab switch must call this to re-navigate (path-lessly, so the server resolves the new session's root). No-op when closed or the session is unchanged. Wired from the `session_joined` handler in `app.js`. |

**Constructor options:**

| Option | Type | Description |
|--------|------|-------------|
| `app` | object | Host app instance — gives access to terminals, sessions, fitAddon |
| `authFetch` | function | Authenticated fetch wrapper (`(url, opts) => Promise<Response>`) |
| `initialPath` | string \| null | Captured at construction. Used as a final fallback in `open()`; kept for tests and tooling that don't have a session context |
| `getCwd` | function \| null | Optional callback returning the active session's effective working directory. **Invoked on every `open()`** so a session switch between opens picks up the new cwd. The callback resolves `liveCwd ?? session.workingDir`, where `liveCwd` is the OSC 7-tracked CWD for Terminal-bridge sessions (per [ADR-0019](../adrs/0019-osc7-cwd-tracking.md)) and is `null` for AI CLI bridges. A throwing or null-returning callback falls through to `initialPath`. |
| `getSessionId` | function \| null | Optional callback returning the active session id. Sent as the `session` query param on every `GET /api/files` so the **server** can resolve the default root even when the client cwd cache is cold (e.g. right after a page reload). Tolerant of falsy/throwing callbacks. |

**`open(startPath)` resolution order:**

1. Explicit `startPath` argument from the caller (e.g. `openToFile`).
2. `getCwd()` return value, if `getCwd` is configured and returns a truthy string. This already encodes the `liveCwd ?? session.workingDir` precedence — see ADR-0019 for the live-CWD contract.
3. `initialPath` captured at construction.
4. `null` — `navigateTo` sends no `path` but still sends `session`, so the **server** resolves the root from the session (its `liveCwd ?? workingDir`), falling back to the default base folder only when the session is unknown. This closes the cold-cache race where the client couldn't supply a path yet.

After each listing response, the panel stores `home` (used by `navigateHome()`) and reconnects the fs-watcher to the server-resolved `currentPath` (covering the path-less / cold-cache open where `open()` couldn't connect a watcher up front).

**Live CWD follow-toggle (per [ADR-0019](../adrs/0019-osc7-cwd-tracking.md)):**

`FileBrowserPanel` maintains a per-session `_followsTerminal` boolean (default `true`). Behaviour:

- On WebSocket `cwd_changed` for the panel's active session:
  - `_followsTerminal === true` → `navigateTo(cwd)` immediately (re-roots the panel).
  - `_followsTerminal === false` → update `_liveCwd` map silently; refresh the toggle button's tooltip (`"📍 follow terminal — currently at <cwd>"`).
- Any manual breadcrumb navigation flips `_followsTerminal` to `false` for that session.
- A small "📍 follow terminal" toggle button in the panel header (highlighted when `true`, dimmed when `false`):
  - Click when `false` → flips to `true` and immediately `navigateTo(_liveCwd)`.
  - Click when `true` → flips to `false`; panel stops re-rooting on `cwd_changed`.
- Hidden (or shown disabled) for sessions whose bridge type does not emit OSC 7 (Claude/Codex/Gemini).

**File list rendering:**
- Directories listed first, then files, alphabetically within each group.
- Each item shows an icon (color-coded by category), name, and size (files only).
- Clicking a directory navigates into it.
- Clicking a file opens the preview panel.
- Hover reveals an edit button (pencil icon) for editable files.

**Breadcrumbs:**
- Merged into the 40px header row: `[<] /home > user > project [Search] [Upload] [+] [Refresh] [x]`
- Each breadcrumb segment is clickable for quick navigation.
- Back button navigates to parent directory.

**Search:**
- Collapsible search input toggled by a search icon.
- Client-side filter on the current directory listing.
- Filters both file and directory names.

**Upload handling:**
- See the [Upload](#upload) section below for all three upload methods.

### FilePreviewPanel

Renders file previews based on MIME category. Displayed within the file browser panel area.

**Public API:**

| Method | Description |
|--------|-------------|
| `showPreview(fileInfo)` | Dispatch to the appropriate renderer based on `mimeCategory` |

### TerminalPathDetector and xterm Link Provider

Two parallel mechanisms surface file paths inside terminal output as actionable affordances. They share the same regex and click handler so behaviour is consistent.

**`TerminalPathDetector` — right-click on selected text.**
- Hooks the xterm.js `contextmenu` event. On right-click, the context menu appears immediately with grayed-out file items; an async `GET /api/files/stat` enables them once the path is validated.
- Regex covers the patterns enumerated in [Detection patterns](#detection-patterns) below. `path:line` and `path:line:col` suffixes (Claude/Codex/Node/Python/V8 stack traces all emit these) are captured separately and used for cursor placement.
- Context menu items: "Open in File Browser", "Open in Editor", "Download".
- Reuses the existing `#termContextMenu` and `.ctx-item` CSS patterns.

**`attachLinkProvider` — hover-and-click on every emitted line.**
- Wires `xterm.registerLinkProvider({ provideLinks(bufferLineNumber, callback) { ... } })`. **No network I/O happens inside `provideLinks`** — every visible line gets scanned on every render. Validation against `/api/files/stat` is deferred to the click handler. Without this, an `npm install` log scrolling hundreds of lines per second would saturate the browser's six-connection-per-host cap and freeze the terminal (peer-review HIGH-1).
- Same regex coverage as `TerminalPathDetector` (see [Detection patterns](#detection-patterns) below) plus an extension allowlist precondition that excludes version-shaped tokens (`1.2.3`), npm specifiers without an extension (`react/jsx-runtime`), and CLI flags (`--foo=bar/baz`).
- `WebLinksAddon` continues to handle URL detection; this provider is additive (paths only).
- Click handler: walk the [Resolver chain](#client-side-resolver-chain) below; on a single resolved hit, call `app.openFileInViewer(path, line, col)`; on multiple hits, surface the [Ambiguity picker](#ambiguity-picker) inline near the click site; on zero hits, surface a small "no match — try Cmd-P" toast.

#### Detection patterns

`provideLinks` runs **regex only** (no I/O). The patterns below are all matched against each visible line; resolution happens on click.

| # | Pattern | Examples | Notes |
|---|---------|----------|-------|
| 1 | Absolute paths | `/Users/foo/file.js`, `C:\Users\foo\file.js`, `\\server\share\file.js` | Both POSIX and Windows drive + UNC. |
| 2 | Explicit relative | `./src/index.js`, `../shared/util.go` | Marked relative by the leading `./` or `../`. |
| 3 | Bare relative paths with allowlisted extension | `src/app.js`, `package.json`, `Cargo.toml` | Matched only when the extension is in the existing allowlist. |
| 4 | Stack-trace formats | Node `at Function (path:line:col)`, Python `File "path", line N`, V8 `at path:line:col`, Rust/Go `path:line:col` | Captures `:line[:col]` separately for cursor placement. |
| 5 | Quoted paths | `"src/app.js"`, `'src/app.js'` | Quotes stripped on capture. |
| 6 | Markdown links | `[text](path)`, `[text](path:line)` | Text label discarded; path captured. |
| 7 | Git-diff `a/`, `b/` prefixes | `a/src/app.js`, `b/src/app.js` | Stripped during resolution; the working-tree file is the open target. |

**Out of scope (cut after adversarial review):** dotless basenames like `Makefile`, `Dockerfile`, `Jenkinsfile`. The false-positive rate in real logs is too high (`Dockerfile` matches `Dockerfile.production.staging`-shaped log noise, prose mentions, etc.). Users who need these can use Cmd-P.

#### Client-side resolver chain

Resolution runs on **click**, not in `provideLinks` (per the I/O-free guarantee above). The handler walks the candidate chain in order, calling the existing `GET /api/files/stat?path=<abs>` for each (which already runs through `validatePath()` server-side, so existence is the only remaining question):

1. `path.isAbsolute(hint)` → `stat(hint)` → exists?
2. `stat(path.join(liveCwd, hint))` → exists? (`liveCwd` from the OSC 7-tracked map; falls back to `session.workingDir` if `null`.)
3. `stat(path.join(workingDir, hint))` → exists? (Always tried even when `liveCwd` is set, to catch paths emitted by tools that haven't followed `cd`.)
4. `stat(path.join(repoRoot, hint))` → exists? (`repoRoot` cached per session, fetched once via `GET /api/sessions/:id/repo-root`. Skipped silently when the repo root is `null`.)

Each step caches its 200/404 result in a small per-session resolution cache (LRU, 256 entries) so re-clicking a path emitted in many log lines doesn't re-spam `/api/files/stat`.

**Why client-side, not a new endpoint:** the existing `/api/files/stat` already runs through `validatePath()`, so trust is preserved. Saves an endpoint, its rate limiter, its tests, and its failure-mode permutations. (Codex's exact recommendation in adversarial review.)

#### Per-session workingDir cache (`_sessionWorkingDirs`)

`workingDir` for step 3 is supplied by a per-session client cache (`app._sessionWorkingDirs`, keyed by sessionId), populated synchronously by the WebSocket handlers for `session_created`, `session_joined`, and the `*_started` family (`claude_started`, `codex_started`, `gemini_started`, `copilot_started`, `terminal_started`, `agent_started`). The async `loadSessions()` call additionally back-fills the cache for sessions that pre-date this client (page reload after a session was created in another tab).

Two race / correctness windows this closes:

- **`claudeSessions[]` race.** `loadSessions()` is async. A click between `session_joined` and the list-refresh used to fall through to `currentFolderPath` (the global folder picker) — a silent wrong-dir resolution that could 404 in the best case and open a coincidentally-same-relative-path file in the worst case. The cache is populated *before* `loadSessions()` is called, so the click sees the right value immediately.
- **Split-pane sessionId mismatch.** The link-provider callbacks accept a `sessionIdSource` parameter. The main terminal passes `() => this.currentClaudeSessionId` (follows the foreground tab). Split panes pass `() => this.sessionId` so a click in a backgrounded split resolves against THAT pane's session id — not whatever tab is foregrounded. Without this, clicks in a split bound to session B while session A was foregrounded would resolve against A's workingDir.

`app.getSessionWorkingDir(sid)` is the single helper both `getCurrentWorkingDir()` (panel default, with the global `currentFolderPath` fallback) and the resolver-chain `getWorkingDir` callback (no fallback — returns null on miss) consume. It walks `_liveCwd → _sessionWorkingDirs → claudeSessions[]` and back-fills the cache from `claudeSessions[]` on a fallthrough hit so future calls short-circuit.

> **Known limitation.** `_sessionWorkingDirs` entries are not garbage-collected when a session is deleted. De minimis at typical scale (a few dozen sessions per page lifetime); a delete-handler hooking into the existing session-deletion message flow is a follow-up if long-running tabs surface memory drift.

**Layer 2 — back-compat fallback gate.** `attachLinkProvider` historically fell through to the legacy `getCwd` callback (mapped to `app.getCurrentWorkingDir()`, which carries the `currentFolderPath` global-fallback) whenever both `getLiveCwd` and `getWorkingDir` returned null. Hosts that wire the new chain (our app does) now SKIP this fallback — the resolver surfaces "could not resolve" rather than silently joining against the global folder picker. The legacy fallback survives only for callers that supply neither new callback (e.g. unit tests that wire just `getCwd`). The app's own `_setupTerminalLinking` no longer passes a `getCwd` option at all (architect "rip" sign-off) so the legacy path is now strictly test-shim territory.

#### TerminalPathDetector resolver-chain audit

The right-click selection menu (`TerminalPathDetector`, `Open in File Viewer` / `Edit` / `Download`) was audited as part of the same fix. Previously the detector statted the bare selection text (e.g. `src/app.js`), which server-side `validatePath()` resolved against `process.cwd()` (the server's baseFolder) — NOT the session's working directory. For any session whose workingDir was a subdirectory of baseFolder (i.e. all Claude/Codex/Gemini sessions opened in a project folder), a relative-path right-click silently disabled the menu.

The detector now accepts an optional `getSessionId` callback (mirroring the link provider's `sessionIdSource`) and walks the same `resolveCandidates()` chain at menu time. The first candidate that 200s wins; menu actions bind the RESOLVED absolute path. Splits pass their own `() => this.sessionId` so a right-click in a split resolves against THAT pane's session.

No ambiguity picker for the right-click flow — the user has selected a specific path token, so showing a picker after a context-menu invocation would be jarring UX. (The link-provider click flow keeps the ambiguity picker because the user clicked a single underlined link, not selected explicit text.)

#### Ambiguity picker

When more than one step in the resolver chain returns 200 — or when step 4's `repoRoot` enumeration finds multiple basename matches for a path that survived steps 1-3 with no hit — the click handler renders an inline lozenge near the click site:

```
3 matches — pick one
  ./src/utils.js
  ./packages/shared/utils.js
  ./test/fixtures/utils.js
```

- Keyboard-navigable (Up/Down + Enter); Esc cancels.
- Each row shows the basename + the directory dimmed (same VS Code convention as the file-find panel).
- **Never silently auto-pick.** This is the explicit anti-footgun rule from adversarial review: a wrong silent open trains users to distrust the link provider.
- Open path: same `app.openFileInViewer(path, line, col)` entry point as the single-hit path.

When the chosen path carries a `:line[:col]` suffix, the open call passes line + col through to Monaco's `editor.revealLineInCenter(line)` + `editor.setPosition({ lineNumber: line, column: col })`.

#### Resolver failure behavior (Layer 5)

When the resolver chain finds NO candidate that exists, `attachLinkProvider.activate()` surfaces a STRUCTURED failure toast via `window.feedback.resolverFailure(failure)` rather than the generic `.error(message)` one-liner. This closes the silent-failure UX class — the user always sees WHY a click didn't open, with WHAT was tried, and (when applicable) actionable next steps.

**Failure object shape:**

```js
{
  hint: 'src/server.js',                         // the clicked text
  candidates: [
    { path: '/Users/foo/src/server.js', source: 'workingDir' },
    // 'source' is one of: 'absolute' | 'liveCwd' | 'workingDir' | 'repoRoot'
  ],
  context: {
    liveCwd: null,
    workingDir: '/Users/foo',
    repoRoot: null,
    bridgeType: 'terminal',  // 'terminal' | 'claude' | 'codex' | 'gemini' | 'copilot' | 'agent' | null
  },
}
```

`FeedbackManager.resolverFailure` picks one of four copy blocks based on `(bridgeType, liveCwd, candidates)`:

- **Block A** — Terminal bridge, `liveCwd === null`. The user-reported failure mode (shell + cd, no OSC 7 hook). Body: "Live directory tracking isn't active in this terminal. Clicks resolve against where the session started (`<workingDir>`), not where you've cd'd." CTA: "Show me how →" (links to shell-hook docs).
- **Block B** — Terminal bridge, `liveCwd` set, still no hit. Body: enumerated candidate list annotated by source (e.g. "`<path>` — not found (current shell directory)"). No OSC 7 hint (liveCwd is already tracked).
- **Block C** — AI CLI bridge (claude / codex / gemini / copilot / agent). Body: "AI assistants don't track `cd` operations — the file is resolved relative to where the session started." CTA: "Open file browser →".
- **Block D** — No candidates at all. Body: "No active session — open or create one to enable file-path clicks." No CTA.

**Single-stack contract.** Subsequent failures REPLACE prior toast — clicking another path immediately surfaces THAT path's diagnosis, not a stack. Auto-dismiss after 12s **only when no CTA is present**; CTA-bearing toasts (Blocks A + C) are PERSISTENT and require explicit user action or dismissal (round-2 review: WCAG 2.2 SC 2.2.1 — interactive content must not auto-dismiss mid-read). User-dismiss via the close button works for either. `console.debug` logs the same structured object for post-mortem inspection.

**Accessibility (ARIA roles).** Toasts use `role="alertdialog"` when a CTA is present (captures focus, requires explicit dismiss, focuses the action button on display) and `role="status"` when no CTA (polite live region, doesn't interrupt screen-reader users mid-task). `role="alert"` is NOT used — it forces immediate interruption + reads the full body, which combined with auto-dismiss penalized non-sighted users.

**Bounds.** The candidate list is capped at 3 entries with an `…and N more` overflow indicator (prevents layout explosion from a 12-permutation chain or a base64-shaped accidental click). The clicked hint is truncated to 60 chars in the title; the full hint still appears in the body's candidate paths and in the `console.debug` log.

**Source tagging.** `resolveCandidatesWithSource(hint, ctx)` (sibling to `resolveCandidates`) returns each entry as `{ path, source }`. The activate flow uses the source-tagged form so Block B can annotate; `resolveCandidates` (string-array form) remains for back-compat with tests / e2e specs. Unknown `source` values fall back to `'candidate path'` annotation (no `"(undefined)"` leakage).

**bridgeType plumbing.** Read at click-time from `app.claudeSessions[].agent` (populated by `/api/sessions/list` + WebSocket session-event messages). The enum is STRICT: `'terminal' | 'claude' | 'codex' | 'gemini' | 'copilot' | 'agent' | null`. Non-canonical values (e.g. a future `'claude-3-opus'`) do NOT route to Block C — they fall through to a defensive default (Block B without source annotations) so the toast never silently misclassifies. Null is acceptable — treated as Block C (educational AI-CLI copy) which is the least-bad default. The `test/feedback-resolver-failure.test.js` "bridgeType enum contract" assertion pins the canonical set so upstream changes surface a test failure.

**Open-file-browser CTA (Block C).** Calls `app.openFileBrowser()` — an IDEMPOTENT API that guarantees the panel is open afterward, never toggles it closed. The legacy `toggleFileBrowser()` would have closed the panel for users who already had it open (round-2 review: footgun under "Open file browser →" wording). Hosts that haven't migrated to `openFileBrowser` fall back to `toggleFileBrowser` as a defensive measure.

**"Show me how →" CTA (Block A).** Opens `/docs/specs/file-browser.md#live-cwd-tracking-osc-7` in a new tab. The server statically serves the repo's `docs/` tree at `/docs` (mounted in `src/server.js`) so the link resolves in dev + production. In SEA-packaged builds where `docs/` isn't bundled, the CTA 404s gracefully — the toast body still carries the actionable copy ("install the OSC 7 hook for your shell").

**Legacy fallback.** Hosts that don't supply `feedback.resolverFailure` (test shims, external embedders) fall through to `feedback.error('Could not open: <hint>')`. Strictly worse UX than the structured toast, but better than silent failure.

---

## Preview Types

Renderer dispatch is by `mimeCategory` inside `FilePreviewPanel.showPreview()`. Each renderer that wires document-level event listeners (Panzoom, Monaco, PDF.js, mermaid containers) registers a teardown function on `FilePreviewPanel._activeDisposers[]`; `showPreview()` drains them on every preview switch so listeners do not accumulate.

| Category | File Extensions | Rendering Method |
|----------|----------------|------------------|
| Image | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico` | `<img>` inside `.fb-img-viewport`, with [Panzoom](https://timmywil.com/panzoom/) (~10 KB, vendored at `/vendor/panzoom.min.js`, lazy-loaded) wired for pan + wheel-zoom + pinch. Header buttons: Fit, 100%, Reset. Native browser image-drag is suppressed so the pan gesture wins. Panzoom failure degrades to a static `<img>` with no controls. |
| Markdown | `.md`, `.mdx`, `.markdown` | `marked` + `DOMPurify` (both already vendored). Source/Rendered toggle in the preview header. The DOMPurify `afterSanitizeAttributes` hook rewrites relative `<img src="./...">` to `/api/files/download?path=<resolved>&inline=1` and tags relative `<a href="./...">` with `data-fb-internal-path` for click-to-open inside the panel. **Mermaid** code fences trigger a lazy import of mermaid from CDN (~500 KB, only on detect). **KaTeX** math (`$...$` / `$$...$$`) triggers a lazy import of KaTeX (~70 KB, only on detect). Both gracefully badge "preview unavailable" if the import fails. |
| HTML | `.html`, `.htm`, `.xhtml` | Sandboxed `<iframe sandbox="" referrerpolicy="no-referrer">` with srcdoc, plus a CSP `<meta>` (`default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:;`). `<base>` and `<meta http-equiv="refresh">` tags are stripped before render. Header offers a Source⇄Rendered toggle backed by Monaco read-only. Files > 1 MB disable rendered view and show source only. |
| Code / Text | `.js`, `.ts`, `.py`, `.go`, `.rs`, `.java`, `.css`, `.sh`, `.yml`, `.toml`, `Dockerfile`, `Makefile`, etc. | Read-only Monaco editor (line numbers, syntax highlighting, find/replace with regex, minimap-on-hover, virtualised) via `window.fileViewerMonaco.createCodeViewer({ readOnly: true })`. Built-in language services for JS/TS/JSON/CSS/HTML/Markdown; tokenisation for the rest of the supported extensions. Falls back to a monospace `<pre>` with line numbers when Monaco is unreachable (`renderPlainTextFallback`). |
| JSON | `.json`, `.json5`, `.jsonc` | Same Monaco read-only viewer; language id `json` enables the JSON language service (hover, validation). |
| CSV | `.csv`, `.tsv` | RFC-4180-ish parser (handles quoted fields, embedded separators, `""` escape). Sticky header (click to sort asc → desc → unsorted; numeric columns sort numerically; locale-aware otherwise; empty cells sink to the bottom). IntersectionObserver windowing — 50 rows mounted on first paint, next 50 on scroll. Cap: 1000 parsed rows (above that a "showing first 1000 of N" notice). TSV (`\t`) is auto-detected from the first line. BOM-stripped. |
| PDF | `.pdf` | [PDF.js](https://mozilla.github.io/pdf.js/) v4 (vendored at `/vendor/pdfjs/`, ~600 KB gz worker + core, lazy-loaded). Custom thin viewer chrome: prev/next, zoom in/out, fit-to-width, page N of M. Replaces the iOS-Safari-broken `<iframe>` PDF preview. |
| Notebook | `.ipynb` | (TBD — task #3 still pending — currently falls through to JSON viewer.) |
| Binary | All other / detected binary | File metadata (name, size, modified date) + download button. |

Text/code/markdown files are fetched via `GET /api/files/content` (JSON envelope). Binary-category files (images, PDFs) are served via `GET /api/files/download?inline=1` (raw stream).

### Code Preview Pane

`FilePreviewPanel._renderCode` calls `window.fileViewerMonaco.createCodeViewer(container, { content, language: getMonacoLanguage(ext), readOnly: true })`. The factory:

1. Lazily loads Monaco from CDN on first call (promise-memoised).
2. Sweeps any prior Monaco editor mounted in the container before re-creating, disposing model + editor + ResizeObserver. Without this the dominant flow ("user clicks file A then file B") would leak an editor per click.
3. Resolves the current theme via `resolveMonacoTheme()`.
4. Returns `{ editor, monaco, dispose }`. The caller registers `dispose` on the preview panel's `_activeDisposers[]`.

The preview header shows the file's resolved Monaco language id alongside an "Edit" button (for editable files) and a "Copy" button.

---

## Multi-File Tabs

Source: `src/public/file-tabs.js` -- class `TabManager`. A horizontal tab strip above the preview/editor area lets multiple files stay open simultaneously.

| Method | Description |
|--------|-------------|
| `openFile(path, mode)` | `mode` ∈ `'preview' \| 'editor'`. If file is already open, switch to its tab. Otherwise create a new tab with its own `monaco.editor.createModel(content, language, uri)`. |
| `closeTab(id)` | Tear down the tab's model + editor; warn on unsaved dirty state. |
| `switchTo(id)` | Activate a tab. Cursor / scroll / undo history are preserved across switches because each tab owns its model. |
| `reorder(fromIdx, toIdx)` | HTML5 drag-reorder. |

**Persistence**: open tabs are saved to `localStorage` keyed by session id; restored on reload (closed tabs are forgotten). Dirty state survives a refresh via the existing `localStorage` draft mechanism in `FileEditorPanel`.

**Keyboard shortcuts** (active when the file browser panel is focused):

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + 1..9` | Switch to tab N |
| `Ctrl/Cmd + W` | Close current tab |
| `Ctrl/Cmd + Tab` | Next tab |
| `Ctrl/Cmd + Shift + Tab` | Previous tab |

`FileBrowserPanel.openToFile(path)` becomes `tabManager.openFile(path, 'preview')`. The right-click "Edit in Editor" path becomes `tabManager.openFile(path, 'editor')`.

---

## Cross-File Search

**Server**: `GET /api/search?q=<term>&regex=0|1&caseSensitive=0|1&glob=<pattern>` (SSE-streamed) shells out to ripgrep with `--json --max-count 50 --max-filesize 10M`, respects `.gitignore`, rate-limited 10 searches/min/IP, path-validated to baseFolder (rejects globs that escape).

**Backend selection** (per [ADR-0018](../adrs/0018-bundled-ripgrep-search-backend.md)) follows a four-step detection chain on first server start, cached behind a `_detectionDone` flag for the process lifetime:

1. **System `rg`** — if `which rg` (or `where rg` on Windows) returns an executable in PATH. Lets users with a newer or custom-built ripgrep keep their environment.
2. **Bundled `@vscode/ripgrep`** — `require('@vscode/ripgrep').rgPath` resolves to the platform-appropriate binary downloaded by npm during the postinstall step (~2 MB). Same package VS Code, Cursor, Theia, and GitHub Copilot Workspace use; MIT-licensed wrapper around the MIT/Unlicense rg binary.
3. **`grep -rIn` belt-and-suspenders on Linux** — used only when neither rg path is executable (e.g. Windows Defender quarantine, `noexec` mount, corp permission strip). Slower, no `.gitignore` respect, no structured `--json`. Explicitly NOT a primary path; future maintainers should not use its existence as license to half-support rg features.
4. **Hard error at server startup** elsewhere, with three-line user-actionable guidance:
   ```
   ai-or-die: search backend unavailable.
   The bundled ripgrep binary is not present at <path>.
   Either:
     - reinstall: rm -rf node_modules && npm ci
     - install ripgrep manually:
         macOS:   brew install ripgrep
         Windows: choco install ripgrep   (or scoop install ripgrep)
     - then restart the server
   ```

The SSE wire contract is unchanged regardless of which backend is selected: same `start` event with `backend: 'rg' | 'grep' | null` field, same `match` event payload, same `end` event with `droppedLines` count. Clients and tests treat the backend choice as implementation-internal — the e2e regression net at scenario `(j)` in `15-file-browser-rich-viewers.spec.js` asserts `start.backend === 'rg'` on every supported platform now that the bundled binary is always present.

**Opt-out: `AI_OR_DIE_NO_BUNDLED_RG=1`** — when set, `_detectBackend()` skips the bundled step and falls back directly to the Linux grep path or hard-error. For users who want "system rg only" (corp-policy-blocked postinstall network calls, security-conscious `--ignore-scripts` installs, air-gapped deployments) without disabling postinstall hooks for the entire dependency tree.

**Postinstall failure mode**: if `@vscode/ripgrep`'s postinstall download fails (corporate proxy blocking the Microsoft CDN, offline install, `--ignore-scripts`, network outage during install), Linux soft-degrades to grep with a clear startup warning; macOS / Windows hard-error per the message above. Linux's behaviour preserves backward compatibility with the pre-ADR-0018 grep-only fallback. CI verifies the bundled binary is present + executable via a small `node -e accessSync(rgPath, X_OK)` step after `npm ci`, so install-time failures are caught fast on both `ubuntu-latest` and `windows-latest` rather than producing a cascade of spec failures downstream.

**Client**: `src/public/file-search.js` — `Cmd/Ctrl + Shift + F` opens a panel above the tab strip; consumes the SSE stream via `EventSource`; each result row is `path:line` + matched-line context; click opens the file in a tab and jumps via `editor.revealLineInCenter` + `setSelection`. Cancels the previous EventSource on each new query. Surfaces the `droppedLines` count from the `end` event when matched-line truncation hit the per-line cap.

---

## Fuzzy file-find (Cmd-P)

A "Go to File" picker that opens with `Cmd/Ctrl+P` and lets the user type a partial filename to jump to a file inside the active root. Modeled on VS Code / Sublime Text's Cmd-P. Backed by `GET /api/files/find` (see Server API above).

### Activation + UX

- **Keybinding**: `Cmd/Ctrl+P` (avoids the existing `Ctrl+Shift+O` "open by path" prompt; both stay available).
- **Panel surface**: reuses `SearchPanel`'s shell layout (input, scrollable results list, keyboard nav). If markup duplication grows, extract a shared `result-row.js` helper covering both panels.
- **Active root**: the panel queries with `path = liveCwd ?? session.workingDir`, so on Terminal sessions Cmd-P follows the user's `cd` automatically (per [ADR-0019](../adrs/0019-osc7-cwd-tracking.md)).
- **Result rendering**: basename **bold**, parent directory dimmed (VS Code convention). Score not surfaced in v1.
- **Empty input**: empty-state hint about gitignore-respecting behaviour ("Hidden by `.gitignore` — toggle in settings (TBD)").
- **Truncation banner**: when the response sets `truncated: true`, render a sticky top banner: `"Showing top 50 of 50000 files — refine your search to narrow."`
- **Latency / cancellation**: 120 ms debounce on input; in-flight `fetch` is aborted on each new keystroke via `AbortController` so the panel never renders stale results.

### Open semantics

| Trigger | Action |
|---------|--------|
| `Enter` | Open selected match in the **preview** tab (`tabManager.openFile(path, 'preview')`). |
| `Cmd/Ctrl+Enter` | Open selected match in the **editor** tab (`tabManager.openFile(path, 'editor')`). |
| `Esc` | Close the panel without opening anything. |
| `Up`/`Down` | Move selection. |
| Click on a row | Same as `Enter`. |

These match the existing `TabManager` open-mode contract used by `SearchPanel` and the right-click "Open in Editor" path on terminal-detected paths.

### Server-side notes

See `GET /api/files/find` under [Server API](#endpoints) for the wire shape, the rg + fuzzysort pipeline, the 10k file enumeration cap, and the per-session 5 queries/sec rate limit. No new ADR — the design is straightforward and the `@vscode/ripgrep` backend choice is already covered by [ADR-0018](../adrs/0018-bundled-ripgrep-search-backend.md).

---

## Reactive file-system sync

Per [ADR-0017](../adrs/0017-fs-watcher-push-channel.md). The architectural piece that makes the file browser first-class for an AI-driven coding UI: **open editor tabs and the directory listing reflect on-disk reality in near-real-time, without user-driven refresh.** When the agent (Claude / Codex / Gemini) edits a file the user has open, the user sees the new content within ~100-200ms instead of finding out at save time via the existing 409-Conflict modal.

The hash-based 409-Conflict-on-save flow from [ADR-0012](../adrs/0012-file-browser-architecture.md) stays active as a backstop for events the watcher missed (network drops, EventSource reconnects, coalescing-window edge cases, platform watcher gaps). The two layers compose: fs-watcher = proactive UX win, OCC = correctness guarantee.

### Wire shape

- **`GET /api/files/watch?session=<id>`** opens an SSE stream rooted at the session's `workingDir`. ONE EventSource per session.
- **`POST /api/files/watch/subscribe?session=<id>&path=<abs>`** adds a path to the active subscription set. Subsequent SSE events for that path arrive on the open EventSource.
- **`POST /api/files/watch/unsubscribe?session=<id>&path=<abs>`** removes a path.

Single EventSource (not per open file) avoids the browser SSE-per-origin cap (Chromium 6); subscribe/unsubscribe is cheap and lets the server's chokidar watcher track only the paths anyone cares about.

Event shape: `{type, path, relPath, mtime, hash?, prevPath?}`. Types: `change` (modify), `add` (create), `unlink` (delete), `rename` (server-coalesced same-inode add+unlink within 50ms). See "GET /api/files/watch" in the Server API section above for the full payload contract + cap + tunable env vars.

### Client lifecycle

`TabManager` owns the EventSource per session:

- On panel mount: open `EventSource('/api/files/watch?session=<id>&token=<t>')`.
- On `openFile(path)`: `POST /subscribe`. Add to local subscription map.
- On `closeTab(id)`: `POST /unsubscribe` for that tab's path.
- On panel unmount or session switch: close EventSource; subscriptions clear server-side via `req.on('close')` cleanup.

`FileBrowserPanel` shares the same EventSource:

- On `navigateTo(newDir)`: `POST /unsubscribe` for the old dir + `POST /subscribe` for the new.

### Per-event reactions

| Event | Tab state | Reaction |
|-------|-----------|----------|
| `change` matching open path | clean (Monaco model value === `_lastSavedContent`) | **Silent reload**. `GET /api/files/content`, swap content into Monaco model, **preserve cursor + scroll + selection** via `getPosition()` → `setValue()` → `setPosition(saved)` with bounds-check. Reuses the `_suppressContentChange` flag from the existing `_reloadFile` path. Update `_lastSavedContent` to the new content. |
| `change` matching open path | dirty | **Non-blocking toast** on the tab strip: `agent modified <path>` with three buttons — **Reload (discard)** / **Compare** / **Keep mine**. Don't force a modal mid-typing. The 409 save backstop still renders as an editor-local inline banner if the user hits Save. |
| `add` / `unlink` matching panel's current dir | — | Refresh directory listing without user F5. |
| `rename` matching open tab path | — | Tab's path metadata updates in-place. Subsequent saves go to `path`, not `prevPath`. Listing refresh treats it as `unlink(prevPath) + add(path)`. |
| Any event after EventSource reconnect | open tabs | Mark all open tabs as needing an `mtime` re-check on next focus. Don't speculatively re-fetch (would thrash); use mtime drift as the staleness signal. |

### Compare-with-memory

The dirty-tab toast's "Compare" button needs to diff the user's in-memory buffer against the new disk content. `DiffViewerPanel` (#6) gains a new entry point `openMemoryVsFile(memContent, diskPath)` that takes the user's current Monaco buffer value (string) and the absolute disk path; the panel fetches via `/api/files/content` and renders the diff in the same diff-tab surface as `openFileVsFile()`, with visible labels distinguishing "memory" vs "disk."

### CSS

`.fb-tab-toast` chrome on the tab strip — non-blocking inline banner with the three action buttons. Positioned over the tab to which the toast applies; auto-dismisses on user action or after 30s.

---

## Live CWD tracking (OSC 7)

Per [ADR-0019](../adrs/0019-osc7-cwd-tracking.md). Terminal-bridge sessions emit OSC 7 escape sequences from the shell prompt; the bridge parses them, validates, and pushes a `cwd_changed` WebSocket frame so the file browser panel can re-root automatically when the user `cd`s to a new directory.

### Bridge contract

| Bridge | Live CWD source | Notes |
|--------|-----------------|-------|
| `TerminalBridge` (raw shell) | OSC 7 parser on the PTY data stream | Emits `cwd_changed` on each post-validated change. `session.liveCwd` reflects the latest. |
| `ClaudeBridge`, `CodexBridge`, `CopilotBridge`, `GeminiBridge` | none | These CLIs don't `chdir` — they manage "current directory" as application state. `session.liveCwd === null`; no `cwd_changed` frames emitted. Documented in [`bridges.md`](bridges.md). |

### Parser

Inside the Terminal bridge's `onData` hook (per the `processOutput` extension point in `base-bridge.js`):

1. Append the chunk to a small per-session pending buffer (cap 4 KB; flushed on terminator or buffer-full so a sequence split across PTY chunks resolves correctly).
2. Match `\x1b]7;file://[^/]*(/[^\x07\x1b]+)(?:\x07|\x1b\\)`. Both `BEL` (`\x07`) and `ST` (`\x1b\\`) terminators accepted per the spec.
3. Pass the full `file://host/path` URI to Node's [`url.fileURLToPath()`](https://nodejs.org/api/url.html#urlfileurltopathurl). Wrap in try/catch; treat malformed as "no update" (silent drop, optional `DEBUG=1` log).
4. Run the resolved path through `validatePath()` (`src/server.js:260`); reject anything outside the sandbox silently.
5. If the resolved path differs from `session.liveCwd`, update and broadcast `{ type: 'cwd_changed', sessionId, cwd, prev, source: 'osc7' }` to all WebSocket clients joined to the session.

**Do not strip OSC 7 from the output forwarded to xterm.js** — the byte sequence is preserved for parity with native terminals and so client-side addons (e.g., a future "show CWD in terminal title" overlay) can re-parse it. xterm.js silently ignores unknown OSC sequences by default.

### Cross-platform path handling

`url.fileURLToPath()` is the reference implementation, with a host-strip fallback on POSIX (see below). Test fixtures cover:

| Input URI | Platform | Expected output |
|-----------|----------|-----------------|
| `file:///Users/foo/code` | POSIX | `/Users/foo/code` |
| `file://localhost/Users/foo` | POSIX | `/Users/foo` |
| `file://my-mac/Users/foo` | POSIX | `/Users/foo` (host stripped — see below) |
| `file:///C:/Users/foo` | Windows | `C:\Users\foo` |
| `file://server/share/foo` | Windows | `\\server\share\foo` (UNC — host kept) |
| `file:///Users/foo/my%20code` | any | `/Users/foo/my code` (percent decode) |

**Host-strip fallback (POSIX only).** Node's [`url.fileURLToPath()`](https://nodejs.org/api/url.html#urlfileurltopathurl) throws `ERR_INVALID_FILE_URL_HOST` on POSIX for any host segment that isn't exactly empty or `localhost`. But every documented shell hook above emits the local machine's hostname (`$HOSTNAME` / `$HOST` / `$env:COMPUTERNAME`) — `file://my-mac/Users/foo`, not `file:///Users/foo` — because that's what the OSC 7 protocol historically encodes (the URI carries the host so consumers can distinguish local vs remote SSH sessions). Without compensation, the parser would silently reject every emit from the documented setup.

The parser (`src/osc7-parser.js`) handles this transparently:

1. Try `url.fileURLToPath(body)` first. Succeeds when the URI is `file:///path` or `file://localhost/path` (or, on Windows, a valid UNC).
2. On POSIX, when that throws `ERR_INVALID_FILE_URL_HOST`, strip the host segment (`file://my-mac/Users/foo` → `file:///Users/foo`) and re-parse. The hostname is treated as informational and discarded — the same posture iTerm2, GNOME Terminal, and WezTerm take.
3. On Windows, the host segment is meaningful (UNC paths). It is **never** stripped; a non-localhost host on Windows continues to mean a UNC server name.

This makes the documented bash/zsh/pwsh hooks work out of the box on macOS / Linux without users having to know about the `$HOSTNAME` vs `localhost` mismatch.

No platform-specific branches in production code beyond this single fallback — the heavy lifting is in `url.fileURLToPath()`.

### Shell hooks — manual install (v1)

ai-or-die's terminal bridge listens for OSC 7. Modern terminals speak it; users get click-to-open the moment OSC 7 starts firing in the shell. **In v1, OSC 7 hook install is MANUAL for all shells** — one-line copy-paste into the user's shell rc file. Auto-install (per the deferred [ADR-0021](../adrs/0021-osc7-shell-hook-auto-install.md)) is planned for a future version but not shipped in v1.

**Per-shell status (v1):**

| Shell | v1 status | What user does |
|---|---|---|
| **bash** | Manual install | Paste the one-line snippet below into `~/.bashrc`. |
| **zsh** | Manual install | Paste the one-line snippet below into `~/.zshrc`. |
| **fish** | Native | Nothing. fish emits OSC 7 unconditionally. |
| **pwsh (PowerShell 7 + Windows PowerShell 5.1)** | Manual install | Paste the snippet below into `$PROFILE`. |
| **cmd.exe (Windows)** | Not supported | cmd.exe's `prompt` definition can't run arbitrary commands per prompt. Switch to PowerShell: `winget install Microsoft.PowerShell` or use Microsoft Store. |

**Why manual in v1** (deferred from auto-install): four cross-lab review rounds on the auto-install wrapper design surfaced ~50 substantive items including a fatal Homebrew break on macOS zsh under naive ZDOTDIR restore. The wrapper design surface is more dynamic than the v1 critic cycle can clear safely. Manual install ships as the v1 baseline; auto-install may be revisited in a future ADR once Layer 5 + manual install has run in prod for ≥6 weeks and we have real usage data. See [ADR-0021](../adrs/0021-osc7-shell-hook-auto-install.md) Status header for the engineering history.

**When click-to-open silently fails** in any shell, [Layer 5 toast](#resolver-failure-toast) Block A surfaces a copy-paste-friendly reference to the snippets below, contextually on the first failed click. Users don't need to read this spec; the toast tells them exactly what to do.

#### Manual install snippets

**bash** (paste in `~/.bashrc`):

```bash
PROMPT_COMMAND='printf "\e]7;file://%s%s\e\\" "$HOSTNAME" "$PWD"'
```

If you already have a `PROMPT_COMMAND`, append with a semicolon (bash <5.1) or as an array element (bash ≥5.1):

```bash
# bash <5.1 (scalar PROMPT_COMMAND):
PROMPT_COMMAND="$PROMPT_COMMAND;"'printf "\e]7;file://%s%s\e\\" "$HOSTNAME" "$PWD"'

# bash ≥5.1 (PROMPT_COMMAND can be an array):
PROMPT_COMMAND+=('printf "\e]7;file://%s%s\e\\" "$HOSTNAME" "$PWD"')
```

**zsh** (paste in `~/.zshrc`):

Bare zsh 5.x does NOT emit OSC 7 natively. Many distros and frameworks (Oh My Zsh, prezto, zsh-newuser-install on Fedora/Ubuntu desktop, macOS Terminal.app's default profile) ship a `chpwd` hook by default. To add manually:

```zsh
autoload -Uz add-zsh-hook
_emit_osc7() { printf '\e]7;file://%s%s\e\\' "${HOST:-localhost}" "$PWD" }
add-zsh-hook precmd _emit_osc7
```

`add-zsh-hook precmd` is additive — coexists with starship, powerlevel10k, oh-my-zsh's existing prompt hooks.

**fish:** no setup needed. fish emits OSC 7 unconditionally on every prompt.

**pwsh (PowerShell 7 + Windows PowerShell 5.1; works on Windows + Linux + macOS):**

Paste in `$PROFILE` (whichever location pwsh shows when you run `echo $PROFILE`):

```powershell
$_aiordie_orig = $function:prompt
function prompt {
    $orig = & $_aiordie_orig
    $loc = $executionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -eq 'FileSystem') {
        $p = $loc.ProviderPath -replace '\\','/'
        # Drive paths: use file:/// empty-host form (cleanest round-trip).
        # On Linux/macOS pwsh, paths already use forward slashes.
        [Console]::Write("$([char]27)]7;file://$p$([char]7)")
    }
    $orig
}
```

The `file:///` empty-host form (note three slashes after `file:`) is what the bridge parser canonicalizes to a clean drive path on Windows (`C:\Users\foo`) or POSIX path on Unix (`/Users/foo`). This is the same wire shape the v2 auto-install wrapper would produce when it ships — no spec-vs-wrapper drift to worry about.

**Windows cmd.exe:** not supported. cmd.exe's `prompt` definition takes only static text + small variable substitutions ($P, $G, $T, etc.); no command-execution mechanism per prompt cycle. Switch to PowerShell — install pwsh 7 via:

```cmd
winget install --id Microsoft.PowerShell --source winget
```

or via [Microsoft Store](https://aka.ms/PSWindows). Then re-open the ai-or-die terminal session with `--shell pwsh` (or change your terminal default in settings).

#### Distro defaults that already emit OSC 7

Many environments emit OSC 7 by default — check before adding the hook:

- Fedora: `/etc/profile.d/vte.sh` adds the bash hook globally.
- Ubuntu desktop: gnome-terminal's VTE library emits via its own profile snippet.
- macOS Terminal.app: the system-default `~/.zshrc` template includes the chpwd snippet.
- Git Bash on Windows: emits when configured (varies by Git for Windows version).
- iTerm2, WezTerm, Konsole, Windows Terminal: terminal-emulator-side emission for shells running inside them — but our `node-pty` bridge is a separate PTY, so the emitting-side has to be in the shell itself (the snippets above), not the outer terminal emulator.

If your distro already emits, the snippets above are harmless duplicates (the parser dedupes on `cwd === prev`).

#### Why hooks aren't auto-injected into user rc files

ai-or-die does NOT modify `~/.bashrc`, `~/.zshrc`, or `$PROFILE` files. User shell configuration is sacrosanct; persistent edits to user dotfiles would interact unpredictably with existing customizations, dotfile managers (chezmoi, yadm), and the user's next non-ai-or-die shell session.

The pwsh wrapper (per ADR-0021) is **transient** — it creates a per-session tempfile shim that lives only for the spawned shell instance. Nothing is written to `$HOME`. Bash + zsh users get manual install snippets above; v2 may add the same kind of transient wrapper for bash + zsh after the design matures.

**Note on `$HOSTNAME` / `$HOST`**: the bash/zsh snippets emit the local machine's hostname (`file://my-mac/Users/foo/...`). The bridge parser handles this transparently — see [Cross-platform path handling](#cross-platform-path-handling) above for the host-strip fallback. The pwsh snippet uses `file:///` (empty host) directly to skip the host-strip altogether — cleaner round-trip on Windows.

### Client integration

Per the [FileBrowserPanel "Live CWD follow-toggle"](#filebrowserpanel) section above. In short:

- `app.js` keeps a `_liveCwd` map keyed by session id, populated by the WebSocket `cwd_changed` handler.
- `FileBrowserPanel._followsTerminal` (per-session boolean, default `true`) governs whether incoming `cwd_changed` re-roots the panel.
- A "📍 follow terminal" toggle button in the panel header lets the user re-engage following after manual navigation.

### Why not PID polling

Adversarial review (gemini, codex, opus) converged on rejecting PID polling for three independent reasons:

1. **Useless for AI CLI bridges.** Claude/Codex/Gemini don't `chdir` their host process; `/proc/<pid>/cwd` returns the static start dir forever.
2. **Real CPU cost on macOS.** `lsof -p <pid>` is ~120–180 ms per call (subprocess fork + per-process file table scan); ~1.5 cores burned at N=20 sessions × 0.5 Hz polling.
3. **Polling latency is user-visible.** OSC 7 is event-driven (re-roots in the prompt-render cycle); a 500 ms poll lags 0–500 ms behind every `cd`.

OSC 7 has none of these failure modes. See [ADR-0019](../adrs/0019-osc7-cwd-tracking.md) for the full tradeoff record.

### Out of scope

- Live CWD for AI CLI bridges (Claude/Codex/Gemini) — they don't `chdir`; concept doesn't map.
- Auto-injecting OSC 7 hooks into user shell rc files.
- Windows `cmd.exe` support.
- **tmux / screen — OSC 7 is swallowed.** Confirmed against tmux 3.x on macOS: tmux intercepts OSC 7 from the inner shell and does **not** forward it to the outer PTY. tmux runs its own multiplexer protocol (it advertises `OSC 1337 ; CurrentDir` as its own channel) but does not re-emit standard OSC 7 outbound. Result: a Terminal session running inside tmux gets `liveCwd === undefined` and stays there. Parsing tmux's `OSC 1337 ; CurrentDir` extension is deferred — users who want live-CWD in tmux should run their shell directly in the bridge for now.
- **UI feedback when OSC 7 is rejected by `validatePath()`.** When the user `cd`s outside the `--folder` sandbox, the emit is silently dropped (correct per ADR-0019's security rule) and the panel freezes at the last in-sandbox CWD with no visible signal. v1 ships the silent-reject behaviour as-documented; a Phase 2 follow-up could surface a toast or a hint near the "📍 follow terminal" toggle (e.g., `"OSC 7 emit for /etc rejected — outside sandbox"`). See the matching Limitations bullet in this spec.
- Re-rooting the chokidar fs-watcher on `cd` (the watcher stays pinned to `session.workingDir`; only the panel display moves).

## Editor

Source: `src/public/file-editor.js` -- class `FileEditorPanel`. Per ADR-0016
the editor is built on Monaco Editor; the previous Ace-based implementation
has been superseded.

### Monaco Editor Integration

- Loaded lazily via the shared `window.fileViewerMonaco.createCodeViewer(...)`
  factory on first editor open. The factory in turn invokes `loadMonaco()`,
  which fetches Monaco's AMD loader from `cdn.jsdelivr.net/npm/monaco-editor`
  (version pinned in `file-viewer-monaco.js`).
- Loading spinner displayed during CDN fetch; a 15-second loader timeout
  produces an actionable error inside the editor pane ("Editor could not be
  loaded ... use the terminal to edit this file"). The promise cache resets
  on rejection so a transient CDN blip is recoverable on retry.
- Built-in language services for JavaScript / TypeScript / JSON / CSS / HTML
  / Markdown ship with the core; tokenization for the rest of the supported
  extensions (Python, Go, Rust, Java, etc.) ships in the same bundle.
- Workers are loaded from a same-origin shim
  (`/vendor/monaco-worker-shim.js`) which `importScripts` the actual worker
  from the CDN. The shim's `?label=` query parameter is constrained by an
  allowlist in the loader so it cannot be coerced into loading code from an
  arbitrary origin.

### Public API

| Method | Description |
|--------|-------------|
| `openEditor(filePath, content, fileHash)` | Initialize Monaco with content, store hash for conflict detection |
| `save()` | `PUT /api/files/content` with current content and stored hash |
| `toggleAutoSave()` | Enable/disable auto-save (default: ON) |
| `isDirty()` | True when the editor's value diverges from the last saved content |
| `close()` | Prompt for unsaved changes, then `destroy()` |
| `destroy()` | Dispose Monaco editor + listeners, clear draft, fire `onClose` |

### Auto-Save

- Default: enabled.
- Debounce interval: 3 seconds after last keystroke.
- Status indicator in toolbar: "Editing" (dirty) -> "Saving..." -> "Saved".
- Dirty state shown immediately with a 6px warning-colored dot next to the filename.

### Conflict Detection

On save, the server compares the submitted hash with the current file hash:
- **Match:** File saved, new hash returned.
- **Mismatch (409):** The editor renders an inline `.file-browser-conflict-banner` above the Monaco editor. This is an intentional Layer-3 inline banner: the conflict is a persistent state scoped to the current editor, so it stays contextual instead of opening an app-level modal. The banner has three actions:
  - **Keep My Changes** -- discard server changes, force-save the editor content.
  - **Reload File** -- discard editor changes, reload from server.
  - **Compare Changes** -- open a `monaco.editor.createDiffEditor` modal showing
    server (original) vs editor (modified) side-by-side with intra-line
    highlighting. Falls back to a hand-rolled twin-`<pre>` view when Monaco
    is unreachable.

### Theme Mapping

Application themes (`data-theme` on the document element) are mapped to
Monaco themes by `resolveMonacoTheme()` in `file-viewer-monaco.js`. v1
maps every app accent theme onto Monaco's two built-in themes — the
chrome (panel surface, terminal, sidebar) stays themed via `tokens.css`,
and only Monaco's editor surface uses its built-in palette. Real
Monaco token-rule data per accent theme (~200 LOC of vendored data via
`monaco-themes`) is a deferred follow-up; see
[ADR-0016](../adrs/0016-monaco-based-file-browser-editor.md)
Consequences→Negative for the rationale.

| App Theme | Monaco Theme |
|-----------|--------------|
| Midnight (default) | `vs-dark` |
| Classic Dark | `vs-dark` |
| Classic Light | `vs` |
| Monokai | `vs-dark` |
| Nord | `vs-dark` |
| Solarized Dark | `vs-dark` |
| Solarized Light | `vs` |

When the user switches themes via the settings UI, the
`MutationObserver` on `<html>[data-theme]` calls
`window.fileViewerMonaco.applyThemeToAll()` which re-themes every live
Monaco instance via `monaco.editor.setTheme(resolveMonacoTheme())`.

### Editor Toolbar

Single 40px row:
```
[<] Editing: file.js    [Auto-save: ON] [Save] [x]
```

Status bar (24px) at the bottom: "Saved" / language mode / UTF-8 / Ln:Col.

---

## Upload

### Three Input Methods

| Method | Trigger | Notes |
|--------|---------|-------|
| File picker | Click "Upload" button in header or command palette "Upload File" | Opens native file dialog, supports multiple selection |
| Drag and drop | Drag files or directories onto the file browser panel | Full-panel overlay with dashed border on drag-enter. Directory upload uses `webkitGetAsEntry()` for recursive traversal |
| Clipboard paste | `Ctrl+V` while file browser is focused | Handles image paste from clipboard |

### Overwrite Handling

When uploading a file that already exists:
- Inline banner (not modal) with three options:
  - **Overwrite** -- replace the existing file (danger-styled button).
  - **Keep Both** -- rename to `file (1).ext`.
  - **Skip** -- cancel the upload.

### Limits

| Constraint | Value |
|------------|-------|
| Max file size (base64 payload) | 10 MB |
| Blocked extensions | `.exe`, `.bat`, `.cmd`, `.com`, `.msi`, `.dll`, `.ps1`, `.vbs`, `.wsf`, `.scr`, `.pif`, `.reg`, `.inf`, `.hta`, `.cpl`, `.jar` |
| Write rate limit | 30 operations/minute/IP |

---

## Generic file drop

A page-wide attachment pipeline that accepts **any** file MIME type (not just images), reachable from **four surfaces**: drag-drop, the attach button, the context-menu "Attach File…" item, and OS paste of files. Cross-link with [`image-paste.md`](image-paste.md) — the image flow is unchanged; this section adds the generic flow that runs alongside it.

### Dispatcher

`app.js` wires a single `drop` handler at the terminal container that dispatches by MIME on the dropped file(s):

| MIME prefix | Pipeline |
|-------------|----------|
| `image/*` | Existing `attachImageHandler` flow (preview modal → WebSocket `image_upload` → temp dir → bracketed paste of quoted path). Unchanged from [`image-paste.md`](image-paste.md). |
| Anything else | New generic flow (below). |

`image-handler.js` is **not renamed** — the image flow just shipped, the rename buys nothing functional, and adversarial review (codex) flagged the rename as unjustified blast radius. The new code lives in a sibling module `generic-drop-handler.js` that exports an `attachGenericDropHandler` and an internal `_isImageMime(file)` helper used by the dispatcher.

### Non-drop surfaces (attach button + paste)

The same partition→upload→inject pipeline is reused — never duplicated — by the non-drop surfaces:

- `attachGenericDropHandler(...)` returns a **`dispatchFiles(fileList)`** method (the internal drop dispatcher, surfaced) so any caller can feed it files and get identical routing (image → preview modal, non-image → upload + `@<path>`, same `MAX_FILES_PER_DROP` cap).
- The module also exports **`triggerFilePicker(onFiles, { multiple })`** — a hidden `<input type="file">` with **no `accept` filter** (any file type).
- `app.js` `_attachFiles(files)` partitions client-side: image files (via `imageHandler.isAcceptedImageType`) take the **existing, unchanged** image preview → `image_upload` path; everything else goes to `dispatchFiles`. The **attach button** and **context-menu "Attach File…"** open `triggerFilePicker` → `_attachFiles`.
- **Paste:** `attachImageHandler`'s paste listener keeps image precedence; *after* the image branch declines, non-image files in `clipboardData` (e.g. a file copied from the OS file manager) are surfaced via `options.onFilesPaste(files)` → `_attachFiles`. Plain text paste is untouched. (The async-clipboard context-menu "Paste Image" stays image-only — the Clipboard API cannot retrieve arbitrary files; the OS Ctrl+V path above is the non-image route.)

### Generic upload pipeline

For each non-image file dropped:

1. Upload to `path.join(session.workingDir, '.claude-attachments', '<uuid>-<sanitized-basename>')` via the existing `POST /api/files/upload` (which already enforces base64 JSON, 10 MB cap, blocked-extension list, sanitization, and `validatePath()`). The basename passes through `sanitizeFileName` (`src/utils/file-utils.js`), which is **Windows-hardened** (primary deployment target): it strips path separators, control chars, and the NTFS-forbidden set `< > : " | ? *` (the `:` also neutralizes Alternate Data Streams), trims trailing dot/space, and prefixes reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) with `_`.
2. On 201, inject **`@<absolute-path>`** into the terminal as bracketed paste — Claude's native file reference syntax. Avoids shell-quoting hazards entirely. Codex/Gemini bridges accept the same `@<path>` form (or can branch on `bridgeType` for variant syntaxes if those CLIs diverge in future).
3. On per-file failure, surface a toast with the basename + the server's error code (size / blocked / 4xx).

### Multi-file drop

| Constraint | Value |
|------------|-------|
| Max files per drop | 10 (gate against accidentally dropping a folder of thousands) |
| Concurrent uploads | 4 (`Promise.allSettled`) |
| Cancellation | A floating chip near the prompt: `"Uploading 3 files… [cancel]"`. Cancel aborts in-flight uploads via `AbortController`; already-uploaded files keep their `@<path>` injection. |
| Failure behaviour | Per-file toast + inject only successful paths in the order their uploads completed. |

### `.claude-attachments/` lifecycle

| Trigger | Action |
|---------|--------|
| First attachment write per session | If `<workingDir>/.gitignore` exists and does not already list `.claude-attachments/`, append the line. Idempotent; best-effort (no error if the file is missing or read-only). |
| Session delete | Sweep `<workingDir>/.claude-attachments/` for files older than 24 h. Files newer than 24 h are preserved (the user may still need them for an in-flight conversation). |
| Server shutdown | Same 24 h sweep across every known session. |
| Per-session size cap | **100 MB total** across the session's `.claude-attachments/` directory. New uploads exceeding the cap are refused with a toast (`"Attachment cap reached — delete some via terminal or wait for the 24 h sweep"`). |

The 24 h window is a deliberate softer policy than the image-paste flow's session-deletion-only cleanup: generic attachments live in the user's **workingDir**, not a temp dir, so they're already visible in the file browser and the user has a clearer mental model of what's there. The auto-sweep + `.gitignore` guard cover the disk-fill DoS and dirty-repo UX surfaces that adversarial review (opus) flagged.

### Why `@<path>` injection

Per the user direction (and adversarial review): `@<path>` is Claude's native file reference syntax and parses correctly downstream. Compared to alternatives:

- **Quoting + bracketed paste of bare path** (the image flow): works for image arguments because the CLI knows to interpret them as image references; doesn't generalise to "this is a file the agent should consider."
- **`@<path>` injection**: directly tells Claude (and the CLIs that copied the convention) "this is a file reference"; bypasses shell-quoting entirely; works in agent context (the only context generic drops actually target).
- **Stuffing the file's content into the prompt**: rejected — defeats the lazy-load semantics of `@<path>` and breaks for binary attachments.

### Out of scope

- A visual attachment chip near the prompt before Enter (the `@<path>` injection is sufficient signal for v1).
- Drop on directories inside the file browser panel (uploads still target `<workingDir>/.claude-attachments/`).
- Per-CLI variant injection (Codex/Gemini get the same `@<path>` form).

---

## Security

### Path Validation

- `validatePath()` resolves symlinks via `fs.realpathSync()` before the `startsWith` check, eliminating TOCTOU race conditions.
- All API responses normalize paths to forward slashes (`/`).
- Junction points on Windows are also resolved.

### Content-Serving Headers

All file content responses include:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing |
| `Cache-Control` | `no-store` | No caching of file contents |
| `Content-Security-Policy` | `sandbox` | Isolate served content |

### Executable Blocklist

Uploads with the following extensions are rejected with 422:

`.exe`, `.bat`, `.cmd`, `.com`, `.msi`, `.dll`, `.ps1`, `.vbs`, `.wsf`, `.scr`, `.pif`, `.reg`, `.inf`, `.hta`, `.cpl`, `.jar`

### Rate Limiting

Write operations (`PUT /api/files/content`, `POST /api/files/upload`) are rate-limited to 30 operations per minute per IP, tracked separately from the global HTTP rate limiter.

### Binary Detection

`isBinaryFile(filePath)` reads the first 512 bytes and checks for null bytes. This supplements extension-based detection for files with unknown or missing extensions.

### Filename Sanitization

`sanitizeFileName(name)` strips `/`, `\`, null bytes, and control characters. File names are capped at 255 characters.

---

## Keyboard Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Ctrl+B` | Global | Toggle file browser panel |
| `Ctrl+S` | Editor open | Save file |
| `Ctrl+Shift+O` | Global | Open file by path (prompt) |
| `Ctrl/Cmd+P` | Global | Open the Cmd-P fuzzy file-find panel |
| `Ctrl+Shift+F` | File browser focused | Open cross-file search panel |
| `Ctrl/Cmd+1..9` | File browser focused | Switch to tab N |
| `Ctrl/Cmd+W` | File browser focused | Close current tab |
| `Ctrl/Cmd+Tab` | File browser focused | Next tab |
| `Ctrl/Cmd+Shift+Tab` | File browser focused | Previous tab |
| `Enter` | Cmd-P panel | Open match in preview tab |
| `Ctrl/Cmd+Enter` | Cmd-P panel | Open match in editor tab |
| `Escape` | Editor popups | Close Monaco find/replace widget first |
| `Escape` | Editor | Close editor (prompts for unsaved changes) |
| `Escape` | Preview | Close preview, return to file list |
| `Escape` | File browser | Close panel |
| `Up` / `Down` | File list | Navigate items |
| `Left` | File list (on directory) | Collapse / navigate to parent |
| `Right` | File list (on directory) | Expand / navigate into |
| `Home` / `End` | File list | Jump to first / last item |
| `Enter` | File list | Open selected item |

Escape follows a cascade: Monaco find/replace widget -> editor -> preview -> file list -> close panel.

---

## Accessibility

- File list uses ARIA tree pattern: `role="tree"` on the container, `role="treeitem"` on each item, `aria-expanded` for directories, `aria-selected` for the focused item.
- Full W3C tree keyboard navigation: Up, Down, Left, Right, Home, End.
- Screen reader announcements via `#srAnnounce` live region for state changes (panel opened, file loaded, save completed, upload finished, errors).
- All interactive elements have visible focus indicators (`outline: 2px solid var(--accent-default)`).
- Context menu items use `role="menuitem"` with `aria-disabled` for items pending async validation.

---

## Mobile

- Viewports <= 768px: panel renders as a full-screen overlay instead of docked.
- Viewports 768-1024px: overlay with backdrop.
- Touch targets meet 44x44px minimum.
- Upload zone has a sticky bottom hint: "Drag files here or click Upload".
- Editor toolbar and status bar adapt to narrower layout.
- `ensureMinTerminalWidth()` auto-switches to overlay if the terminal would be squeezed below 80 columns.

---

## Panel Layout

### Desktop (docked)

- Position: right-docked, `z-index: var(--z-sticky)` (1100).
- Default width: 350px (browse/preview), auto-expands to `min(500px, 50vw)` for editor.
- Resize range: 280px to 60vw.
- Border: `1px solid var(--border-default)` with `box-shadow: -4px 0 12px rgba(0,0,0,0.15)`.
- Terminal reflows via `margin-right` change and `fitAddon.fit()` on `transitionend`.

### File Item Styles

| State | Style |
|-------|-------|
| Default | `background: transparent` |
| Hover | `background: var(--surface-tertiary)` |
| Selected | `background: var(--accent-soft); border-left: 3px solid var(--accent-default)` |
| Focus-visible | `outline: 2px solid var(--accent-default)` |

Edit button on hover: opacity `0` -> `0.6` -> `1`.

### View Transitions

Horizontal slide animation: drill-down navigates right, back navigates left.

---

## Testing

### Unit Tests

| File | Coverage |
|------|----------|
| `test/file-browser.test.js` | `getFileInfo()` MIME categorisation, `sanitizeFileName()`, `isBinaryFile()` (null-byte sniff), `computeFileHash()`, link regex precision (`path:line:col`, version-token exclusion, extension allowlist), `extractPathFromText()` |
| `test/file-browser-getcwd.test.js` | `FileBrowserPanel.open()` resolution order (`startPath > getCwd() > initialPath > null`); `getCwd` invoked per-`open()` (not memoised); throwing-callback fallthrough; `liveCwd ?? workingDir` precedence inside the `getCwd` factory |
| `test/osc7-parser.test.js` | OSC 7 parser (table-driven, no PTY): POSIX (`file:///Users/foo`, `file://localhost/Users/foo`), Windows drive (`file:///C:/Users/foo` → `C:\Users\foo`), Windows UNC (`file://server/share/foo` → `\\server\share\foo`), BEL vs ST terminators, percent-encoded paths, malformed sequences silently dropped, paths outside sandbox rejected, sequences split across PTY chunks (buffer-boundary safety). Uses `url.fileURLToPath()` semantics as the reference. |
| `test/files-find.test.js` | Populates a temp dir + `.gitignore`; asserts `rg --files` respects ignore, fuzzysort ordering matches expectations, truncation at 10k, per-session 5/sec rate limit returns 429 |
| `test/repo-root.test.js` | `git init` in a temp dir; resolves; asserts non-git dir returns `{ root: null }`; arg-injection on session id rejected |
| `test/upload-generic.test.js` | Generic-drop upload: `.pdf` (success → 201), `.exe` (blocked → 422), >10 MB (rejected → 413), at session size cap (rejected with toast-able error code), 24 h sweep deletes only files older than threshold, `.gitignore` append is idempotent |
| `test/link-provider-regex.test.js` | All 7 detection patterns (table-driven) + the rejection set (no dotless basenames, no version strings, no `http://` URLs, no CLI flags, no npm specifiers without an extension) |
| `test/link-provider-resolver-chain.test.js` | `attachLinkProvider` activate-time wiring: back-compat `getCwd` fallback fires only when neither `getLiveCwd` nor `getWorkingDir` was supplied (architect's Layer 2 silent-wrong-dir guard); `getWorkingDir` honoured over legacy `getCwd` when both wired; callbacks re-evaluated on every `activate` so split-pane session id mutations propagate without re-attachment (architect's Layer 4) |
| `test/file-browser-detector-resolver.test.js` | `TerminalPathDetector._showMenu` walks the same resolver-chain as the link provider: relative selection resolves via session workingDir (NOT global baseFolder); split-pane `getSessionId` honoured even when foreground tab points elsewhere; legacy embedders without `getSessionId` still get the raw-hint fallback path |
| `test/feedback-resolver-failure.test.js` | Layer-5 structured failure toast: Block A (Terminal + liveCwd null → OSC 7 CTA), Block B (Terminal + liveCwd → annotated candidate list), Block C (AI CLI bridges → "AI assistants don't track cd" + Open-browser CTA), Block D (no candidates → "no active session"); single-stack contract (subsequent failures REPLACE prior in DOM); defensive (null input, missing candidates) |
| `test/file-viewer-monaco.test.js` | Monaco language map (extensions + extensionless filenames + case folding + path input); theme map covers every app theme; CDN base alignment with the worker shim's `ALLOWED_BASES` (drift breaks the test); SRI hash format + script-tag wiring guard |
| `test/monaco-worker-shim.test.js` | Shim source evaluated in a sandboxed Node `vm`; positive (canonical base, trailing-slash normalisation) + 8 negative attack vectors covering HIGH-1 (attacker npm pkg, look-alike package, downgraded version, root path, cdnjs/unpkg, attacker origin, userinfo bypass) |
| `test/file-tabs.test.js` | TabManager open/close/switch/reorder; localStorage persistence; dirty-state propagation |
| `test/markdown-render.test.js` | `marked` GFM features; DOMPurify hook rewrites relative `<img>`/`<a>` to internal paths; mermaid/KaTeX detection-driven lazy-load (mocked) |
| `test/file-editor.test.js` | Editor migration smoke: autosave, conflict 409 flow, draft restore, dirty dot, language map |

### Server Integration Tests (`test/file-browser-api.test.js`)

- Directory listing with pagination, hidden file filtering.
- Text content read and write round-trip with hash validation.
- 409 conflict on hash mismatch after external modification.
- Upload with overwrite=false returns 409 when file exists.
- Path traversal attempts (`../../`, `%2e%2e%2f`, null bytes, symlinks, Windows junctions) return 403.
- Executable extension upload returns 422.
- ENOSPC conditions return 507.
- `GET /api/files/git-show?path=&ref=` returns content for known refs; 404 outside a git repo; arg-injection rejected.
- `GET /api/search` SSE roundtrip; `q` validation; `glob` validation refuses traversal; rate-limit observed.

### E2E Playwright Tests (`e2e/tests/file-browser.spec.js`)

- Panel opens with `Ctrl+B`; defaults to active session's cwd; switching session and reopening picks up new cwd.
- Terminal click on `src/public/app.js:42` opens viewer at line 42 in Monaco.
- Markdown file with mermaid fence renders the diagram (lazy-load triggers).
- Markdown file with `$x^2$` renders KaTeX (or shows fallback badge).
- HTML file renders inside sandboxed iframe; scripts are blocked.
- Image preview: pan, wheel-zoom, Fit/100%/Reset controls work.
- PDF preview: PDF.js viewer renders page 1; page nav works on iOS Safari emulation.
- Open three files in tabs → switch via `Cmd+1/2/3` → modify one → dirty dot appears → save → dot clears.
- "Compare with HEAD" opens diff editor with intra-line highlights.
- `Ctrl+Shift+F` cross-file search streams results; click opens file at matched line.
- Mobile viewport: panel auto-overlays; Monaco loads; tabs collapse to dropdown.
- **OSC 7 follow** (`test/e2e/cwd-osc7.test.js`): start a Terminal-bridge session in `/tmp/foo`; emit OSC 7 for `/tmp/bar` from the shell; assert browser re-roots when the follow toggle is on, doesn't when off; assert the toggle's hover-tooltip surfaces the latest `liveCwd` even when not following.
- **Cmd-P** (`test/e2e/cmd-p.test.js`): `Cmd/Ctrl+P` → type partial → Enter opens preview tab; `Cmd/Ctrl+Enter` opens editor tab; `Esc` cancels.
- **Click stack-trace** (`test/e2e/click-stack-trace.test.js`): print `at Function (src/app.js:42:8)` → click → opens at line 42 col 8.
- **Ambiguous click** (`test/e2e/click-ambiguous.test.js`): print `utils.js` when 3 exist on disk → click → ambiguity picker shows; Up/Down + Enter selects.
- **Generic drop — PDF** (`test/e2e/drop-pdf.test.js`): drop a PDF onto the terminal → upload toast → `@/abs/.../<uuid>-name.pdf` appears as bracketed paste in terminal input.
- **Generic drop — multi + cancel** (`test/e2e/drop-multi-cancel.test.js`): drop 5 files; cancel mid-upload via the floating chip; assert only successfully-uploaded paths got injected.
- **Click split-pane sessionId** (`e2e/tests/67-click-split-pane-sessionid.spec.js`): two sessions A and B with distinct workingDirs + non-overlapping fixtures; foreground pinned to A; verify clicks in a split bound to B resolve against B's workingDir via the split's own `sessionId` source (regression for the post-PR-108 split-pane bug). Companion assertion: `_sessionWorkingDirs` is populated synchronously on `session_joined`, no race window.
- **Click Claude-bridge happy path** (`e2e/tests/68-click-claude-bridge.spec.js`): SKIPS when the Claude CLI is not on PATH. Starts a real `startToolSession('claude')`, drives past the trust prompt, asks Claude to emit `src/app.js`, then verifies `getSessionWorkingDir` + `resolveCandidates` + `stat` resolves to the fixture file (`liveCwd === null` for Claude bridge, workingDir comes from the per-session cache).

---

## Limitations

- **No delete or rename.** Destructive operations are excluded to limit security exposure. Users can use the terminal for these operations.
- **10 MB upload limit.** Chunked upload for larger files is deferred to Phase 2.
- **Monaco Editor requires CDN.** If `cdn.jsdelivr.net` is unreachable, code preview falls back to a monospace `<pre>` with line numbers (`renderPlainTextFallback`); the editor pane shows an actionable error inside its toolbar; the Compare-Changes diff falls back to a twin-`<pre>` view. Browsing and previewing of non-code files still works.
- **Monaco custom theme palettes deferred.** v1 maps every accent theme onto Monaco's built-in `vs` / `vs-dark`. Real syntax-token rules per theme (~200 LOC of vendored data via the `monaco-themes` package) is a follow-up; the chrome stays themed via `tokens.css`. See [ADR-0016](../adrs/0016-monaco-based-file-browser-editor.md) Consequences→Negative.
- **No LSP-style IntelliSense for non-built-in languages.** Monaco ships hovers/completions/diagnostics for JS/TS/JSON/CSS/HTML/Markdown out of the box. Python/Go/Rust IntelliSense would need a real language server.
- **CSV preview cap is 1000 parsed rows.** Beyond that a "showing first 1000 of N" notice surfaces and the user is expected to filter/edit the file in a real spreadsheet tool. Multi-line quoted CSV fields are also not supported in v1.
- **Notebook (`.ipynb`) preview** falls through to JSON until `nbviewer.js` integration lands (task #3).
- **Reactive sync is best-effort, not guaranteed.** The fs-watcher channel (ADR-0017) delivers events for the common case in <200ms but can miss events on EventSource reconnect, network partitions, platform watcher gaps (network filesystems, FUSE mounts), or coalescing-window edge cases. The hash-based 409-Conflict-on-save flow (ADR-0012) remains active as the correctness backstop. `.gitignore` is not parsed by the watcher; static `EXCLUDE_DIRS` list applies (deferred follow-up).
- **Live CWD tracking only on Terminal-bridge sessions.** Per [ADR-0019](../adrs/0019-osc7-cwd-tracking.md), AI CLI bridges (Claude / Codex / Gemini) do not `chdir` their host process and so report `liveCwd === null`. Their panel stays at `session.workingDir`; users who want to navigate elsewhere use the breadcrumbs.
- **OSC 7 requires shell-side cooperation.** `bash` and `zsh` need a one-line hook (`PROMPT_COMMAND` / `chpwd`) on shells that don't ship with one; `fish` emits OSC 7 unconditionally. Bare zsh 5.x does not emit OSC 7 natively — the framework or distro provides it. Windows `cmd.exe` has no clean way to emit OSC 7 from a `prompt` definition; the recommended Windows shell for live-CWD tracking is `pwsh`. Documented snippets in the [Live CWD tracking (OSC 7)](#live-cwd-tracking-osc-7) section above.
- **tmux / screen swallow OSC 7.** Confirmed against tmux 3.x on macOS: tmux intercepts OSC 7 from the inner shell and does **not** forward it to the outer PTY (tmux speaks its own `OSC 1337 ; CurrentDir` multiplexer protocol instead). Sessions running a shell inside tmux get `liveCwd === undefined`. Workaround: run the shell directly in the Terminal bridge (don't wrap in tmux) when live-CWD matters. Parsing tmux's `OSC 1337 ; CurrentDir` extension is deferred to a future iteration.
- **`cd` outside the `--folder` sandbox is silently rejected — no UI feedback.** When the user `cd`s to a directory outside the server's `--folder` baseFolder, `validatePath()` rejects the resolved path and the bridge drops the `cwd_changed` frame on purpose (per [ADR-0019](../adrs/0019-osc7-cwd-tracking.md)'s silent-rejection rule — a malicious sequence pointing outside the sandbox must not produce a side effect). The file browser panel then **freezes** at the last in-sandbox CWD with no visible signal that an emit was rejected, so users typing a perfectly normal `cd ~/other-repo` will think OSC 7 is broken. Workaround: `cd` back inside the sandbox, OR restart the server with a wider `--folder` scope. UI feedback for rejected emits (a small toast or a hint near the "📍 follow terminal" toggle) is a **Phase 2** candidate; out of scope for v1.
- **Cmd-P fuzzy file-find is uncached.** Each query re-runs `rg --files` over the active root. Performant for repos under ~50k files (50–150 ms typical); above 50k, the response truncates at the 10k file enumeration cap and surfaces a "refine your search" hint. A real index is a follow-up only if user feedback shows pathological repos.
- **Generic file drop targets `<workingDir>/.claude-attachments/`.** Dropped files live in the user's working directory, not a temp dir. The directory is auto-`.gitignore`d on first write and swept (>24 h files only) on session delete + server shutdown; per-session cap is 100 MB. Dirty-repo or disk-fill UX gaps are bounded by the cap + sweep rather than eliminated.
