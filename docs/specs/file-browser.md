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
Edit:     GET content -> Ace Editor -> PUT /api/files/content -> save with hash
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
| `file-browser.js` | `src/public/file-browser.js` | FileBrowserPanel, FilePreviewPanel, TerminalPathDetector |
| `file-editor.js` | `src/public/file-editor.js` | FileEditorPanel (Ace Editor integration) |
| `file-browser.css` | `src/public/components/file-browser.css` | Panel layout, file list, preview, editor styles |

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

### TerminalPathDetector

Hooks into the xterm.js right-click event to detect file paths in terminal output.

- Regex patterns match Unix paths (`/home/user/file.js`), Windows paths (`C:\Users\file.js`), and relative paths (`./src/index.js`).
- On right-click, the context menu appears immediately with grayed-out file items. An async `GET /api/files/stat` call enables the items once the path is validated.
- Context menu items: "Open in File Browser", "Open in Editor", "Download".
- Reuses the existing `#termContextMenu` and `.ctx-item` CSS patterns.

---

## Preview Types

| Category | File Extensions | Rendering Method |
|----------|----------------|------------------|
| Image | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico` | `<img>` element via `/api/files/download?path=...&inline=1` |
| Text / Code | `.js`, `.ts`, `.py`, `.go`, `.rs`, `.java`, `.css`, `.html`, `.sh`, `.yml`, `.toml`, etc. | Monospace `<pre>` with line numbers, hover-reveal "Edit" button |
| JSON | `.json` | Pretty-printed `<pre>` with indentation |
| CSV | `.csv`, `.tsv` | HTML `<table>`, max 100 rows displayed |
| PDF | `.pdf` | `<iframe>` embed via `/api/files/download?path=...&inline=1` |
| Binary | All other / detected binary | File metadata (name, size, modified date) + download button |

Text/code files are fetched via `GET /api/files/content` (JSON envelope). Binary-category files (images, PDFs) are served via `GET /api/files/download?inline=1` (raw stream).

---

## Editor

Source: `src/public/file-editor.js` -- class `FileEditorPanel`

### Ace Editor Integration

- Loaded lazily from CDN (`cdnjs.cloudflare.com/ajax/libs/ace/1.36.5/ace.min.js`) on first editor open.
- Loading spinner displayed during CDN fetch with a 5-second timeout and fallback error.
- Language modes auto-loaded from CDN based on file extension.
- `<link rel="preload">` in `index.html` for faster first-edit experience.

### Public API

| Method | Description |
|--------|-------------|
| `openEditor(filePath, content, fileHash)` | Initialize Ace with content, store hash for conflict detection |
| `save()` | `PUT /api/files/content` with current content and stored hash |
| `toggleAutoSave()` | Enable/disable auto-save (default: ON) |
| `onClose()` | Prompt for unsaved changes, clean up |
| `saveDraft()` | Backup to `localStorage` for crash recovery |

### Auto-Save

- Default: enabled.
- Debounce interval: 3 seconds after last keystroke.
- Status indicator in toolbar: "Editing" (dirty) -> "Saving..." -> "Saved".
- Dirty state shown immediately with a 6px warning-colored dot next to the filename.

### Conflict Detection

On save, the server compares the submitted hash with the current file hash:
- **Match:** File saved, new hash returned.
- **Mismatch (409):** Conflict dialog with three options:
  - **Keep** -- discard server changes, force-save the editor content.
  - **Reload** -- discard editor changes, reload from server.
  - **Compare Changes** -- show both versions for manual resolution.

### Theme Mapping

Ace Editor themes are mapped to the application's design token themes:

| App Theme | Ace Theme |
|-----------|-----------|
| Midnight (default) | `tomorrow_night` |
| Classic Dark | `tomorrow_night` |
| Classic Light | `tomorrow` |
| Monokai | `monokai` |
| Nord | `nord_dark` |
| Solarized Dark | `solarized_dark` |
| Solarized Light | `solarized_light` |

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
| `Escape` | Editor popups | Close Ace popups first |
| `Escape` | Editor | Close editor (prompts for unsaved changes) |
| `Escape` | Preview | Close preview, return to file list |
| `Escape` | File browser | Close panel |
| `Up` / `Down` | File list | Navigate items |
| `Left` | File list (on directory) | Collapse / navigate to parent |
| `Right` | File list (on directory) | Expand / navigate into |
| `Home` / `End` | File list | Jump to first / last item |
| `Enter` | File list | Open selected item |

Escape follows a cascade: Ace popups -> editor -> preview -> file list -> close panel.

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

### Unit Tests (`test/file-browser.test.js`)

- `getFileInfo()` returns correct MIME category and flags for known extensions.
- `sanitizeFileName()` strips dangerous characters, enforces length limit.
- `isBinaryFile()` detects null bytes in first 512 bytes.
- `computeFileHash()` returns consistent MD5 for the same file content.
- `TerminalPathDetector` regex matches Unix, Windows, and relative paths.

### Server Integration Tests (`test/file-browser-api.test.js`)

- Directory listing with pagination, hidden file filtering.
- Text content read and write round-trip with hash validation.
- 409 conflict on hash mismatch after external modification.
- Upload with overwrite=false returns 409 when file exists.
- Path traversal attempts (`../../`, `%2e%2e%2f`, null bytes, symlinks, Windows junctions) return 403.
- Executable extension upload returns 422.
- ENOSPC conditions return 507.

### E2E Playwright Tests (`e2e/tests/file-browser.spec.js`)

- Panel opens with `Ctrl+B`, directory listing renders.
- Navigate directories via clicks, breadcrumbs function.
- Click image file: preview renders inline.
- Click text file: monospace preview with line numbers.
- Click Edit: Ace Editor loads with spinner.
- Edit and auto-save: content persists.
- Upload via file picker: file appears in listing.
- Download: file received by browser.

---

## Limitations

- **No real-time file watching.** Directory listings are point-in-time snapshots. Manual refresh is required to see external changes. File watching via WebSocket is deferred to Phase 2.
- **No delete or rename.** Destructive operations are excluded from the initial release to limit security exposure. Users can use the terminal for these operations.
- **10 MB upload limit.** Chunked upload for larger files is deferred to Phase 2.
- **Ace Editor requires CDN.** If the CDN is unreachable, editing falls back to an error message. Browsing and previewing still work.
- **No syntax highlighting in preview.** Preview shows monospace text without highlighting. Syntax-highlighted preview (via highlight.js) is deferred to Phase 2.
