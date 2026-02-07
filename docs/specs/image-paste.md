# Image Paste Specification

Allows users to paste, drag-drop, or attach images directly into the terminal. Images are saved as temporary files on the server and their paths are injected into the terminal input, enabling Claude (and other agents that support image arguments) to process them.

---

## Architecture

The feature uses a file-based bridge:

1. **Browser** -- user pastes/drops/selects an image.
2. **Client (`image-handler.js`)** -- reads the file as a data URL, shows a preview modal, and sends it over WebSocket as an `image_upload` message.
3. **Server (`server.js`)** -- validates the payload, writes the image to a temp directory, and responds with the file path.
4. **Client** -- injects the file path into the terminal input as bracketed paste text so the agent can reference it.

```
Browser  -->  WebSocket (image_upload)  -->  Server writes temp file
                                              |
Client  <--  WebSocket (image_uploaded) <-----+
  |
  v
Terminal input: bracketed paste with file path
```

---

## Client Side

### Module: `image-handler.js`

Source: `src/public/image-handler.js`

A standalone module that attaches to the terminal container and intercepts image input from three sources.

#### Input Sources

| Source | Trigger | Notes |
|--------|---------|-------|
| Clipboard paste | `paste` event on `document` | Filters for `image/*` MIME types from `clipboardData.items` |
| Drag and drop | `drop` event on terminal container | Filters for `image/*` files from `dataTransfer.files` |
| File picker | Click on "Attach Image" button or context menu item | Opens a hidden `<input type="file" accept="image/*">` |

#### Preview Modal

Before uploading, a modal is displayed with:
- Thumbnail preview of the image (max 300x300 CSS pixels).
- File name and size.
- "Send" and "Cancel" buttons.
- Escape key and overlay click dismiss the modal.

#### Upload Flow

1. Read the file as an `ArrayBuffer`.
2. Convert to base64.
3. Send a WebSocket message:

```json
{
  "type": "image_upload",
  "sessionId": "<current-session-id>",
  "data": "<base64-encoded-image>",
  "mimeType": "image/png",
  "fileName": "screenshot.png"
}
```

4. On receiving the `image_uploaded` response, inject the returned file path into the terminal.

#### Path Injection

The file path returned by the server is normalized and injected into the terminal:

- **Forward-slash normalization:** backslashes are converted to forward slashes for consistent cross-platform behavior in CLI arguments.
- **Quoting:** the path is wrapped in double quotes to handle spaces.
- **Bracketed paste:** the quoted path is wrapped in `ESC[200~` ... `ESC[201~` so the terminal treats it as pasted text.

### Context Menu Additions

Two new items are added to the existing `#termContextMenu`:

| Action | Label | Position |
|--------|-------|----------|
| `pasteImage` | Paste Image | After "Paste as Plain Text" |
| `attachImage` | Attach Image | After "Paste Image" |

"Paste Image" reads image data from the clipboard. "Attach Image" opens the file picker. Both items follow the same ARIA patterns as existing menu items (`role="menuitem"`, keyboard navigation).

### Toolbar Button

An "Attach Image" button is added to the terminal toolbar (the bar containing session controls). It uses a paperclip or image icon and triggers the file picker on click. The button is disabled when no session is joined or no agent is running.

---

## Server Side

### WebSocket Message: `image_upload`

**Inbound message:**

```json
{
  "type": "image_upload",
  "sessionId": "uuid",
  "data": "<base64-string>",
  "mimeType": "image/png",
  "fileName": "screenshot.png"
}
```

**Processing steps:**

1. Validate the session exists and the sender is joined to it.
2. Validate `mimeType` against the allowlist (see Security below).
3. Validate `data` length against the size limit.
4. Decode base64 and write to the temp directory.
5. Respond with `image_uploaded` to the sender only (not broadcast).

**Outbound message:**

```json
{
  "type": "image_uploaded",
  "sessionId": "uuid",
  "filePath": "/tmp/claude-code-web/images/<session-id>/<uuid>.png",
  "fileName": "screenshot.png"
}
```

**Error response:**

```json
{
  "type": "error",
  "message": "Image upload failed: <reason>"
}
```

### Temp File Management

**Directory structure:**

```
<os-tmpdir>/claude-code-web/images/<session-id>/
  <uuid>.<ext>
  <uuid>.<ext>
```

- On Windows: `%TEMP%\claude-code-web\images\<session-id>\`
- On Linux: `/tmp/claude-code-web/images/<session-id>/`

The directory for each session is created on demand when the first image is uploaded.

**File naming:** each file receives a UUID v4 name with the original extension (derived from MIME type, not from the user-supplied filename) to prevent collisions and path traversal via crafted filenames.

### Cleanup

Images are cleaned up in four situations:

| Trigger | Scope | Mechanism |
|---------|-------|-----------|
| Session deletion | Per-session | `DELETE /api/sessions/:id` and WebSocket `session_deleted` handler remove the session's image directory recursively |
| Server shutdown | All sessions | `handleShutdown()` removes the entire `claude-code-web/images/` directory |
| Server startup | Stale files | `loadPersistedSessions()` sweeps the images directory and removes subdirectories that do not correspond to a known session ID |
| Periodic timer | Stale files | A 30-minute interval scans for image directories with no corresponding active session and removes them |

### FIFO Cap

Each session maintains a counter of uploaded images. When the count reaches **1000**, the oldest file in the session's image directory is deleted before writing the new one (first-in, first-out). This prevents unbounded disk growth from long-running sessions.

---

## Security

### MIME Allowlist

Only the following MIME types are accepted:

| MIME Type | Extension |
|-----------|-----------|
| `image/png` | `.png` |
| `image/jpeg` | `.jpg` |
| `image/gif` | `.gif` |
| `image/webp` | `.webp` |

**SVG (`image/svg+xml`) is explicitly rejected** because SVG files can contain embedded scripts and are a common XSS vector.

### Size Limit

Maximum encoded payload size: **10 MB** (base64-encoded). This corresponds to roughly 7.5 MB of raw image data. Payloads exceeding this limit receive an error response without writing to disk.

### Path Traversal Prevention

- Filenames are generated server-side (UUID) -- the user-supplied `fileName` is used only for display in the client UI.
- The file extension is derived from the validated MIME type, not from user input.
- The session directory is validated to be within the temp base path.

### Rate Limiting

Image uploads are rate-limited to **5 per minute per session**. Excess uploads receive an error:

```json
{
  "type": "error",
  "message": "Image upload rate limit exceeded. Try again in a moment."
}
```

This is tracked in-memory per session using a sliding window counter, independent of the global HTTP rate limiter.

---

## Testing

### Unit Tests

- MIME type validation (accept valid, reject invalid, reject SVG).
- Size limit enforcement.
- File path generation (UUID naming, correct extension from MIME type).
- Rate limit counter logic.
- FIFO cap enforcement.
- Path normalization (backslash to forward slash, quoting).

### Server Integration Tests

- `image_upload` WebSocket message end-to-end: send base64, verify file written to disk, verify response message.
- Cleanup on session deletion: upload image, delete session, verify directory removed.
- Reject oversized payloads.
- Reject disallowed MIME types.
- Rate limit enforcement across multiple rapid uploads.

### Playwright E2E Tests

- Paste an image via clipboard simulation and verify the file path appears in terminal input.
- Drag-and-drop an image onto the terminal and verify upload.
- Use the "Attach Image" button / file picker and verify upload.
- Verify the preview modal appears and can be dismissed.
- Verify context menu "Paste Image" and "Attach Image" items function.

---

## Limitations

- **Gemini CLI does not support image input.** When the active agent is Gemini, the image paste feature is disabled and the toolbar button / context menu items are hidden or grayed out with a tooltip explaining the limitation.
- **Terminal CLI sessions** (raw shell) do not benefit from image paths since there is no AI agent to interpret them. The feature remains available but the injected path is simply text in the shell.
- **Maximum file size** may need tuning based on deployment constraints. The 10 MB base64 limit is a starting point.
