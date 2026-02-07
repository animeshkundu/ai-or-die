# Client Application Specification

The frontend is a single-page application served from `src/public/`. It runs entirely in the browser with no build step -- all JavaScript is loaded directly via `<script>` tags.

---

## Dependencies

| Library | Version | Source | Purpose |
|---------|---------|--------|---------|
| xterm.js | 5.3.0 | unpkg CDN | Terminal emulator component |
| xterm-addon-fit | 0.8.0 | unpkg CDN | Auto-fit terminal to container |
| xterm-addon-web-links | 0.9.0 | unpkg CDN | Clickable URLs in terminal output |
| JetBrains Mono | -- | Google Fonts | Monospace font for terminal (fallback) |
| MesloLGS Nerd Font | -- | jsDelivr CDN | Primary terminal font with Nerd Font glyphs |
| Inter | -- | Google Fonts | UI font for headers, tabs, controls |
| clipboard-handler.js | -- | Local | Keyboard shortcuts (Ctrl+C/V) and clipboard utility functions |

---

## Design Token System

Source: `src/public/tokens.css`

Three-tier architecture loaded before `style.css`:

1. **Primitive tokens** — raw color/size values (e.g., `--color-gray-200`, `--space-4`)
2. **Semantic tokens** — role-based references (e.g., `--surface-primary`, `--accent-default`)
3. **Theme overrides** — `[data-theme="name"]` blocks override semantic tokens only

### Available Themes

| Theme | `data-theme` value | Default? |
|-------|-------------------|----------|
| Midnight | (none / omit attribute) | Yes |
| Classic Dark | `classic-dark` | No |
| Classic Light | `classic-light` or `light` | No |
| Monokai | `monokai` | No |
| Nord | `nord` | No |
| Solarized Dark | `solarized-dark` | No |
| Solarized Light | `solarized-light` | No |

### Backward Compatibility

`style.css` defines aliases mapping old variable names to new semantic tokens:
- `--bg-primary` → `var(--surface-primary)`
- `--accent` → `var(--accent-default)`
- `--success` → `var(--status-success)`
- `--error` → `var(--status-error)`
- `--border` → `var(--border-default)`

---

## ClaudeCodeWebInterface

Source: `src/public/app.js` (~2100 lines)

The main application controller. Instantiated once on page load.

### Constructor Properties

| Property | Type | Description |
|----------|------|-------------|
| `terminal` | Terminal | xterm.js instance |
| `fitAddon` | FitAddon | Auto-resize addon |
| `webLinksAddon` | WebLinksAddon | Clickable URL addon |
| `socket` | WebSocket | Active WebSocket connection |
| `connectionId` | string | Server-assigned connection UUID |
| `currentClaudeSessionId` | string | Currently joined session ID |
| `currentClaudeSessionName` | string | Currently joined session name |
| `reconnectAttempts` | number | Counter for exponential backoff |
| `maxReconnectAttempts` | number | 5 |
| `reconnectDelay` | number | 1000ms base delay |
| `folderMode` | boolean | Always `true` |
| `currentFolderPath` | string | Current path in folder browser |
| `claudeSessions` | Array | Cached session list from server |
| `isCreatingNewSession` | boolean | Flag for new-session folder picker flow |
| `isMobile` | boolean | Detected via `detectMobile()` |
| `currentMode` | string | `'chat'` |
| `planDetector` | PlanDetector | Plan mode detection instance |
| `aliases` | Object | `{ claude: 'Claude', codex: 'Codex' }` -- populated from `/api/config` |
| `sessionTabManager` | SessionTabManager | Tab bar controller |
| `usageStats` | Object | Latest usage data |
| `sessionTimer` | Object | Session timer data from server |
| `sessionTimerInterval` | Interval | Client-side timer tick |
| `splitContainer` | Object | Split/tile view controller |

### Initialization Flow

`init()` performs these steps in order:

1. Call `window.authManager.initialize()`. If it returns `false`, the login prompt is displayed and initialization halts.
2. Fetch `/api/config` to get folder mode, aliases, and base folder.
3. Set up the terminal (xterm.js with fit addon and web links addon).
4. Establish WebSocket connection.
5. Set up UI event handlers (folder browser, session controls, resize observer).
6. Initialize `SessionTabManager`.
7. Initialize `PlanDetector`.
8. Load existing sessions from the server.
9. Start usage polling interval.

### WebSocket Management

- **Connection:** Constructs the URL with the session token via `authManager.getWebSocketUrl()`. Reconnects automatically with exponential backoff up to `maxReconnectAttempts`.
- **Message handling:** Routes incoming messages by `type` field to appropriate handlers (output rendering, session state updates, usage updates, etc.).
- **Output rendering:** Writes raw terminal data directly to xterm.js via `terminal.write(data)`. Also feeds data to `planDetector.processOutput(data)` and `sessionTabManager.markSessionActivity()`.

### Terminal Configuration

```js
{
  cursorBlink: true,
  theme: {
    background: '#0d1117',
    foreground: '#f0f6fc',
    cursor: '#f0f6fc',
    // Full 16-color ANSI palette configured
  },
  fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
  fontSize: 14,          // 13 on mobile
  lineHeight: 1.2,
  scrollback: 10000,
  allowProposedApi: true
}
```

The terminal auto-resizes via `FitAddon` triggered by a `ResizeObserver` on the terminal container, debounced to prevent excessive resize messages.

### Folder Browser

A modal dialog for selecting working directories:
- Fetches directory listings from `GET /api/folders?path=...`.
- Supports navigating up to parent (within `baseFolder` bounds).
- Supports creating new folders via `POST /api/create-folder`.
- On selection, either creates a new session or sets the working directory.

### Agent Start Controls

When a session has no running agent, the UI presents buttons to start:
- **Claude** -- sends `{ type: "start_claude" }`
- **Codex** -- sends `{ type: "start_codex" }`
- **Copilot** -- sends `{ type: "start_copilot" }`
- **Gemini** -- sends `{ type: "start_gemini" }`
- **Terminal** -- sends `{ type: "start_terminal" }`

Each button's label uses the configured alias from `/api/config`. Buttons are disabled for tools that are not available on the server.

A 45-second client-side timeout acts as a safety net: if no `_started`, `error`, or `exit` message arrives from the server within that window, the loading spinner is replaced with an error message. This prevents the UI from getting permanently stuck if the server fails to respond (e.g., due to a process hang on Windows).

### Usage Dashboard

Polls usage data via the WebSocket `get_usage` message at regular intervals. Displays:
- Session timer (elapsed/remaining in the current session window)
- Token consumption (input, output, cache)
- Cost tracking
- Burn rate and depletion predictions
- Plan information

### Authenticated Fetch

`authFetch(url, options)` wraps `fetch()` to automatically include auth headers:
```js
const authHeaders = window.authManager.getAuthHeaders();
const mergedOptions = {
  ...options,
  headers: { ...authHeaders, ...(options.headers || {}) }
};
return fetch(url, mergedOptions);
```

---

## SessionTabManager

Source: `src/public/session-manager.js` (~1125 lines)

Manages the browser-style tab bar for multi-session support.

### State

| Property | Type | Description |
|----------|------|-------------|
| `tabs` | `Map<sessionId, HTMLElement>` | Tab DOM elements |
| `activeSessions` | `Map<sessionId, SessionData>` | Session metadata |
| `activeTabId` | string | Currently active tab's session ID |
| `tabOrder` | Array | Visual ordering of tab IDs |
| `tabHistory` | Array | Most-recently-used ordering (max 50 entries) |
| `notificationsEnabled` | boolean | Whether desktop notifications are permitted |

### Tab Operations

| Operation | Trigger |
|-----------|---------|
| Create | "New Tab" button, Ctrl/Cmd+T |
| Close | Close button, Ctrl/Cmd+W, middle-click |
| Switch | Tab click, Ctrl/Cmd+Tab (next), Ctrl/Cmd+Shift+Tab (prev), Alt+1-9 |
| Rename | Double-click tab |
| Reorder | Drag and drop |
| Close Others | Right-click context menu |

### Tab Display Name Resolution

1. If the session name is customized (does not start with "Session " containing ":"), use it.
2. Otherwise, extract the last path component of `workingDir` as the folder name.
3. Fall back to the default session name.

### Drag and Drop

Tabs are `draggable="true"`. Reordering uses these events:
- `dragstart` -- stores the session ID and adds a `.dragging` class.
- `dragover` -- calculates insertion point via `getDragAfterElement()` (finds the closest tab element based on mouse X position).
- `dragend` -- syncs the visual order to `tabOrder` and updates overflow menus.

### Mobile Behavior

On viewports <= 768px wide:
- Only the first 2 tabs are visible.
- An overflow dropdown shows remaining tabs with a count badge.
- Tabs are automatically reordered by `lastAccessed` timestamp so the most recently used tabs are always visible.

### Status Indicators

Each tab has a status dot with states:
- **idle** -- default, no activity
- **active** -- agent is producing output (adds `.pulse` animation)
- **error** -- an error occurred in the session
- **unread** -- output completed in a background tab (blue indicator)

### Unread Detection

When a session transitions from `active` to `idle` in a background tab (not the currently viewed tab), it is marked as unread. This happens via two mechanisms:

1. **Work completion timeout (90s):** If no new output arrives for 90 seconds while the status was `active`, the tab is marked as unread and a notification is sent.
2. **Command completion patterns:** Output is checked against regex patterns for common completion indicators:
   - `build successful`, `compilation finished`, `tests passed`
   - `deployment complete`, `npm install completed`
   - `successfully compiled`, `Done in X.Xs`

### Desktop Notifications

- Requests permission on first load (deferred by 2 seconds).
- Shows a prompt banner if permission is `"default"`.
- Sends `Notification` when the page is not visible and the event is for a background tab.
- Falls back to in-page toast notifications + vibration on mobile.
- Notifications auto-close after 5 seconds.
- Clicking a notification switches to the relevant tab and focuses the window.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl/Cmd + T | New tab |
| Ctrl/Cmd + W | Close current tab |
| Ctrl/Cmd + Tab | Next tab (uses MRU history first, falls back to visual order) |
| Ctrl/Cmd + Shift + Tab | Previous tab (visual order) |
| Alt + 1-9 | Switch to tab by index |

---

## PlanDetector

Source: `src/public/plan-detector.js` (~186 lines)

Monitors terminal output for plan mode activation and plan content.

### Detection Markers

**Plan mode start indicators:**
- `"Plan mode is active"`
- `"you MUST NOT make any edits"`
- `"present your plan by calling the ExitPlanMode tool"`
- `"Starting plan mode"`

**Completed plan patterns:**
- `## Implementation Plan:`
- `### <number>. ` (numbered sections)
- `## Plan:`
- `### Plan Overview`
- `## Proposed Solution:`

**Plan mode end indicators:**
- `"User has approved your plan"`
- `"You can now start coding"`
- `"Plan mode exited"`
- `"Exiting plan mode"`

### Processing Flow

1. Raw output is appended to an internal buffer (max 10,000 entries, trimmed to 5,000).
2. Recent text is extracted with ANSI codes stripped.
3. Checks are performed in order: plan start, completed plan content, plan end.
4. Callbacks `onPlanModeChange(isActive)` and `onPlanDetected(plan)` fire on state changes.

### Plan Extraction

Three strategies are attempted in order:
1. Match `## Implementation Plan:` to a terminal prompt indicator.
2. Match a structured plan header with 2+ `###` subsections.
3. Match any plan-like content in the last 5,000 characters.

The extracted plan text is cleaned of ANSI codes and normalized line endings.

---

## AuthManager (Client)

Source: `src/public/auth.js` (~245 lines)

See the [Authentication Specification](authentication.md) for full details. Key points:

- Global singleton at `window.authManager`.
- Token persisted in `sessionStorage` (per-tab, cleared on browser close).
- Full-screen login overlay with password input.
- `getAuthHeaders()` returns `{ Authorization: "Bearer <token>" }`.
- `getWebSocketUrl(baseUrl)` appends `?token=<token>` to WebSocket URLs.

---

## PWA Support

### Service Worker

Source: `src/public/service-worker.js`

- **Cache name:** `claude-code-web-v1`
- **Precached resources:** `/`, `/index.html`, `/style.css`, `/app.js`, `/session-manager.js`, `/plan-detector.js`
- **Strategy for API/WebSocket routes:** Network only, with a 503 offline fallback.
- **Strategy for static assets:** Network first, cache on success, fall back to cache when offline.
- Activates immediately via `skipWaiting()` + `clients.claim()`.
- Cleans up old caches on activation.

### Manifest

Source: `src/public/manifest.json`

Provides installable PWA metadata. Icons are dynamically generated SVGs served by the Express server at `/icon-{size}.png`.

### Dynamic Icon Generation

The server generates SVG icons at sizes 16, 32, 144, 180, 192, and 512 pixels:
- Dark background (`#1a1a1a`) with rounded corners.
- Monospace "CC" text in orange (`#ff6b00`).
- Served as `image/svg+xml` with a 1-year `Cache-Control`.

---

## Clipboard & Keyboard Shortcuts

Implemented in `src/public/clipboard-handler.js` and `src/public/app.js`.

### Keyboard Shortcuts

`attachClipboardHandler(terminal, sendFn)` attaches an `attachCustomKeyEventHandler` to the xterm.js terminal:

| Shortcut | Behavior |
|----------|----------|
| Ctrl+C / Cmd+C | Copy selection to clipboard (or send SIGINT if no selection) |
| Ctrl+V / Cmd+V | Browser native paste → xterm handles bracketed paste → `onData` |
| Ctrl+Shift+C | Copy selection (Linux convention) |
| Ctrl+Shift+V | Paste (Linux convention) |

Uses `(e.ctrlKey \|\| e.metaKey)` directly for cross-platform Mac/Windows/Linux support.

### Utility Functions

- `attachClipboardHandler.normalizeLineEndings(text)` — converts `\r\n` → `\r` and `\n` → `\r`
- `attachClipboardHandler.wrapBracketedPaste(text)` — wraps in `ESC[200~` ... `ESC[201~`

### Context Menu

A shared `#termContextMenu` element lives in `<main>` (not inside the terminal wrapper) so it can serve both the main terminal and split panes via event delegation.

**Menu items:**

| Action | Label | Shortcut Hint |
|--------|-------|---------------|
| copy | Copy | Ctrl+C |
| paste | Paste | Ctrl+V |
| pastePlain | Paste as Plain Text | -- |
| selectAll | Select All | -- |
| clear | Clear | -- |

**Accessibility:** ARIA `role="menu"` / `role="menuitem"` / `role="separator"`, `aria-disabled`, `tabindex="-1"`, arrow key navigation, Enter to activate, Escape to close.

**Split pane support:** The context menu uses `resolveTerminal(target)` to determine which terminal (main or split pane) triggered the right-click, and operates on that terminal instance.

**Error handling:** Clipboard API failures show a toast notification ("Clipboard access denied. Use Ctrl+V to paste.") that auto-dismisses after 3 seconds.

---

## ImageHandler

Source: `src/public/image-handler.js`

Handles image paste, drag-and-drop, and file picker input for uploading images to the server and injecting their file paths into the terminal. Images are sent as base64 over the WebSocket `image_upload` message, written to a server-side temp directory, and the returned path is injected into the terminal as bracketed paste text. The module also adds "Paste Image" and "Attach Image" items to the context menu and an "Attach Image" button to the toolbar. A preview modal is shown before upload for confirmation.

See the [Image Paste Specification](image-paste.md) for the full protocol, security constraints, rate limits, and cleanup behavior.
