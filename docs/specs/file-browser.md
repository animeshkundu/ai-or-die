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

### Data Flow

```
Browse:   GET /api/files?path=<dir>                    -> file/folder listing
Preview:  GET /api/files/content?path=<file>           -> text in JSON envelope with hash
Serve:    GET /api/files/download?path=<file>&inline=1 -> stream binary (images, PDF) inline
Edit:     GET content -> Monaco Editor -> PUT /api/files/content -> save with hash
Upload:   drag-drop / picker / paste -> POST /api/files/upload (base64 JSON, 10MB)
Download: GET /api/files/download?path=<file>          -> Content-Disposition: attachment
```

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
| `path` | string | `baseFolder` | Directory to list |
| `showHidden` | string | `"false"` | `"true"` to include dotfiles |
| `offset` | number | `0` | Pagination offset |
| `limit` | number | `500` | Max items per page (cap: 1000) |

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

Upload a file as base64-encoded JSON. Uses route-specific `express.json({ limit: '10mb' })`.

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

---

## Client Architecture

### Files

| File | Source | Description |
|------|--------|-------------|
| `file-browser.js` | `src/public/file-browser.js` | `FileBrowserPanel`, `FilePreviewPanel`, `TerminalPathDetector`, `attachLinkProvider` |
| `file-editor.js` | `src/public/file-editor.js` | `FileEditorPanel` (Monaco-based; ADR-0016) |
| `file-viewer-monaco.js` | `src/public/file-viewer-monaco.js` | `loadMonaco()`, `createCodeViewer()`, `getMonacoLanguage()`, `resolveMonacoTheme()`, `applyThemeToAll()`, `renderPlainTextFallback()` |
| `markdown-render.js` | `src/public/markdown-render.js` | `marked` + `DOMPurify` hook + lazy mermaid + lazy KaTeX |
| `file-tabs.js` | `src/public/file-tabs.js` | `TabManager` — multi-file tab strip, per-tab Monaco models, localStorage persistence keyed by session id |
| `file-diff.js` | `src/public/file-diff.js` | `DiffViewerPanel` — `monaco.editor.createDiffEditor` wrapper. Side-by-side read-only diff with intra-line highlighting. Convenience helpers `openHeadVsWorking(path)` / `openRefVsWorking(path, ref)` / `openFileVsFile(a, b)`. Mounted by TabManager mode `'diff'`. |
| `notebook-render.js` | `src/public/notebook-render.js` | Read-only Jupyter `.ipynb` viewer. Lazy-loads kokes/nbviewer.js (~50 KB) on first use, parses + renders into a scratch DIV, then sanitises through DOMPurify (same FORBID_ATTR/FORBID_TAGS profile as `markdown-render.js`) before inserting into the live DOM. |
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
| `navigateHome()` | Navigate to session working directory |

**Constructor options:**

| Option | Type | Description |
|--------|------|-------------|
| `app` | object | Host app instance — gives access to terminals, sessions, fitAddon |
| `authFetch` | function | Authenticated fetch wrapper (`(url, opts) => Promise<Response>`) |
| `initialPath` | string \| null | Captured at construction. Used as a final fallback in `open()`; kept for tests and tooling that don't have a session context |
| `getCwd` | function \| null | Optional callback returning the active session's working directory. **Invoked on every `open()`** so a session switch between opens picks up the new cwd. A throwing or null-returning callback falls through to `initialPath`. |

**`open(startPath)` resolution order:**

1. Explicit `startPath` argument from the caller (e.g. `openToFile`).
2. `getCwd()` return value, if `getCwd` is configured and returns a truthy string.
3. `initialPath` captured at construction.
4. `null` — `navigateTo` falls back to the server's default base folder.

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
- Regex matches Unix paths (`/home/user/file.js`), Windows paths (`C:\Users\file.js`), relative paths (`./src/index.js`), and bare relative paths with a known extension (`src/foo.js`). `path:line` and `path:line:col` suffixes (Claude/Codex emit these) are captured separately and used for cursor placement.
- Context menu items: "Open in File Browser", "Open in Editor", "Download".
- Reuses the existing `#termContextMenu` and `.ctx-item` CSS patterns.

**`attachLinkProvider` — hover-and-click on every emitted line.**
- Wires `xterm.registerLinkProvider({ provideLinks(bufferLineNumber, callback) { ... } })`. **No network I/O happens inside `provideLinks`** — every visible line gets scanned on every render. Validation against `/api/files/stat` is deferred to the click handler. Without this, an `npm install` log scrolling hundreds of lines per second would saturate the browser's six-connection-per-host cap and freeze the terminal (peer-review HIGH-1).
- Same regex as `TerminalPathDetector` plus an extension allowlist precondition that excludes version-shaped tokens (`1.2.3`), npm specifiers without an extension (`react/jsx-runtime`), and CLI flags (`--foo=bar/baz`).
- `WebLinksAddon` continues to handle URL detection; this provider is additive (paths only).
- Click handler: resolve relatives against the active session cwd, call `/api/files/stat`; on 200 → `app.openFileInViewer(path, line, col)`; on 404 → small toast.

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

Server: `GET /api/search?q=<term>&regex=0|1&caseSensitive=0|1&glob=<pattern>` (SSE-streamed) shells out to `rg --json --max-count 50 --max-filesize 10M`, falling back to `grep -rIn` on systems without ripgrep. Respects `.gitignore`. Rate-limited 10 searches/min/IP. Path-validated to baseFolder; rejects globs that escape.

Client: `src/public/file-search.js` (TBD — task #9 still pending). Plan: `Cmd/Ctrl + Shift + F` opens a panel above the tab strip; consumes the SSE stream via `EventSource`; each result row is `path:line` + matched-line context; click opens the file in a tab and jumps via `editor.revealLineInCenter` + `setSelection`. Cancels the previous EventSource on each new query.

---

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
- **Mismatch (409):** Conflict dialog with three options:
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
| `Ctrl+Shift+F` | File browser focused | Open cross-file search panel (TBD — task #9) |
| `Ctrl/Cmd+1..9` | File browser focused | Switch to tab N |
| `Ctrl/Cmd+W` | File browser focused | Close current tab |
| `Ctrl/Cmd+Tab` | File browser focused | Next tab |
| `Ctrl/Cmd+Shift+Tab` | File browser focused | Previous tab |
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
| `test/file-browser-getcwd.test.js` | `FileBrowserPanel.open()` resolution order (`startPath > getCwd() > initialPath > null`); `getCwd` invoked per-`open()` (not memoised); throwing-callback fallthrough |
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

---

## Limitations

- **No real-time file watching.** Directory listings are point-in-time snapshots. Manual refresh is required to see external changes. File watching via WebSocket is deferred to Phase 2.
- **No delete or rename.** Destructive operations are excluded to limit security exposure. Users can use the terminal for these operations.
- **10 MB upload limit.** Chunked upload for larger files is deferred to Phase 2.
- **Monaco Editor requires CDN.** If `cdn.jsdelivr.net` is unreachable, code preview falls back to a monospace `<pre>` with line numbers (`renderPlainTextFallback`); the editor pane shows an actionable error inside its toolbar; the Compare-Changes diff falls back to a twin-`<pre>` view. Browsing and previewing of non-code files still works.
- **Monaco custom theme palettes deferred.** v1 maps every accent theme onto Monaco's built-in `vs` / `vs-dark`. Real syntax-token rules per theme (~200 LOC of vendored data via the `monaco-themes` package) is a follow-up; the chrome stays themed via `tokens.css`. See [ADR-0016](../adrs/0016-monaco-based-file-browser-editor.md) Consequences→Negative.
- **No LSP-style IntelliSense for non-built-in languages.** Monaco ships hovers/completions/diagnostics for JS/TS/JSON/CSS/HTML/Markdown out of the box. Python/Go/Rust IntelliSense would need a real language server.
- **CSV preview cap is 1000 parsed rows.** Beyond that a "showing first 1000 of N" notice surfaces and the user is expected to filter/edit the file in a real spreadsheet tool. Multi-line quoted CSV fields are also not supported in v1.
- **Notebook (`.ipynb`) preview** falls through to JSON until `nbviewer.js` integration lands (task #3).
