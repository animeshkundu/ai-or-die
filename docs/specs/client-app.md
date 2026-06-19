# Client Application Specification

The frontend is a single-page application served from `src/public/`. It runs entirely in the browser with no build step -- all JavaScript is loaded directly via `<script>` tags.

---

## Dependencies

| Library | Version | Source | Purpose |
|---------|---------|--------|---------|
| xterm.js | 5.3.0 | unpkg CDN | Terminal emulator component |
| xterm-addon-fit | 0.8.0 | unpkg CDN | Auto-fit terminal to container |
| xterm-addon-web-links | 0.9.0 | unpkg CDN | Clickable URLs in terminal output |
| xterm-addon-unicode11 | 0.6.0 | unpkg CDN | Unicode 11 character width support for Nerd Font / powerline glyphs |
| marked.js | 15.x | Vendored (`src/public/vendor/marked.min.js`) | Markdown parser for plan viewer |
| DOMPurify | 3.x | Vendored (`src/public/vendor/purify.min.js`) | HTML sanitizer for plan viewer |
| JetBrains Mono | -- | Google Fonts | Monospace font for terminal (fallback) |
| MesloLGS Nerd Font | v3.3.0 | Self-hosted WOFF2 + jsDelivr CDN fallback | Primary terminal font with Nerd Font glyphs |
| Inter | -- | Google Fonts | UI font for headers, tabs, controls |
| clipboard-handler.js | -- | Local | Keyboard shortcuts (Ctrl+C/V) and clipboard utility functions |
| feedback-manager.js | -- | Local | Toast notification system (FeedbackManager singleton) |
| app-identity.js | -- | Local | Shared per-machine app identity formatter (`window.AppIdentity`) |
| input-overlay.js | -- | Local | Type-ahead input overlay with voice integration |

---

## Design Token System

Source: `src/public/tokens.css`

Three-tier token architecture loaded before `base.css`, component styles, and `style.css`:

1. **Primitive tokens** — raw color/size values (e.g., `--color-gray-200`, `--space-4`)
2. **Semantic tokens** — role-based references (e.g., `--surface-primary`, `--accent-default`)
3. **Component tokens** — sparing, named values for component identity that should not follow the active theme accent

Theme overrides use `[data-theme="name"]` blocks and override semantic tokens only.

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

### Token Groups

Primitive tokens include the raw palettes, spacing scale, typography scale, elevation scale, z-index scale, safe-area values, and theme-independent overlay scrims:

| Token | Purpose |
|-------|---------|
| `--overlay-backdrop` | Standard blocking modal/dialog scrim (`rgba(0, 0, 0, 0.70)`) |
| `--overlay-backdrop-light` | Non-blocking dim layer for type-ahead overlays (`rgba(0, 0, 0, 0.40)`) |
| `--overlay-backdrop-strong` | Strong terminal/auth blocking overlay (`rgba(0, 0, 0, 0.92)`) |

The overlay scrims intentionally stay black and theme-independent so modal darkness is consistent across all themes.

Semantic border tokens include `--border-default`, `--border-hover`, `--border-focus`, and `--border-subtle`. `--border-subtle` is defined in every theme block: dark themes use `rgba(255, 255, 255, 0.08)` and light themes use `rgba(0, 0, 0, 0.08)`. Use it for quiet separators and low-emphasis outlines that must not disappear in light themes.

Component tool-identity tokens carry stable assistant colors that are shared by tab badges and tool-card tints:

| Tool | Color token | RGB token |
|------|-------------|-----------|
| Claude | `--tool-claude` | `--tool-claude-rgb` |
| Codex | `--tool-codex` | `--tool-codex-rgb` |
| Copilot | `--tool-copilot` | `--tool-copilot-rgb` |
| Gemini | `--tool-gemini` | `--tool-gemini-rgb` |
| Terminal | `--tool-terminal` | `--tool-terminal-rgb` |

The `-rgb` triples are for `rgba(var(--tool-*-rgb), <alpha>)` tints. These brand colors are component identity, not theme accents; see [ADR-0029](../adrs/0029-overlay-and-tool-identity-tokens.md).

### Backward Compatibility

`base.css` defines aliases mapping old variable names to new semantic tokens:
- `--bg-primary` → `var(--surface-primary)`
- `--bg-secondary` → `var(--surface-secondary)`
- `--bg-tertiary` → `var(--surface-tertiary)`
- `--accent` → `var(--accent-default)`
- `--success` → `var(--status-success)`
- `--error` → `var(--status-error)`
- `--warning` → `var(--status-warning)`
- `--border` → `var(--border-default)`

---

## ClaudeCodeWebInterface

Source: `src/public/app.js` (~6100 lines)

The main application controller. Instantiated once on page load.

### Constructor Properties

| Property | Type | Description |
|----------|------|-------------|
| `terminal` | Terminal | xterm.js instance |
| `fitAddon` | FitAddon | Auto-resize addon |
| `webLinksAddon` | WebLinksAddon | Clickable URL addon |
| `socket` | WebSocket | Active WebSocket connection |
| `_socketGeneration` | number | Monotonic counter incremented each `connect()` call. Used to fence stale callbacks (heartbeat ticks, pong-timers, onclose handlers) from prior sockets so they cannot affect the current socket. |
| `_heartbeat` | HeartbeatWatchdog | Active heartbeat watchdog instance (see `heartbeat-watchdog.js`). |
| `connectionId` | string | Server-assigned connection UUID |
| `currentClaudeSessionId` | string | Currently joined session ID |
| `currentClaudeSessionName` | string | Currently joined session name |
| `reconnectAttempts` | number | Counter for exponential backoff |
| `maxReconnectAttempts` | number | 10 |
| `reconnectDelay` | number | 1000ms base delay (used in exponential formula for attempts ≥ 1; first attempt is a fixed 250ms) |
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
| `extraKeys` | ExtraKeys | Mobile extra key row instance (Tab/Ctrl/Esc/arrows) |
| `voiceMode` | string \| null | Active voice method: `'local'`, `'cloud'`, or `null` |
| `_inputBuffer` | string | Accumulated keystrokes awaiting flush |

### Initialization Flow

`init()` performs these steps in order:

1. Call `window.authManager.initialize()`. If it returns `false`, the login prompt is displayed and initialization halts.
2. Fetch `/api/config` to get folder mode, aliases, base folder, tool availability, voice config, prerequisites, and `hostname`.
3. Compute the app identity with `window.AppIdentity.formatAppIdentity({ hostname })` and apply it with `applyAppIdentity()` before the first notification title flash. This updates `document.title`, `#mobileMenuTitle`, `#app`'s `aria-label`, the `apple-mobile-web-app-title` and `application-name` meta tags, and the start screen identity chip (`#startPromptIdentity`) to `[HOST] ai-or-die`. Empty hostnames degrade to `ai-or-die`.
4. Set up the terminal, mobile extra keys, orientation/PWA handlers, UI event handlers, voice input (when configured), plan detection, and type-ahead input overlay.
5. Apply saved settings (font, theme, cursor, padding, notification preferences, sticky-note toggle) via `applySettings(loadSettings())`.
6. Establish the WebSocket connection.
7. Initialize `SessionTabManager` and load sessions.
8. Initialize per-tab sticky-note state and the remaining session/usage UI.

### WebSocket Management

- **Connection:** Constructs the URL with the session token via `authManager.getWebSocketUrl()`. Reconnects automatically with exponential backoff up to `maxReconnectAttempts`.
- **Message handling:** Routes incoming messages by `type` field to appropriate handlers (output rendering, session state updates, usage updates, etc.).
- **Output rendering:** Writes raw terminal data directly to xterm.js via `terminal.write(data)`. Also feeds data to `planDetector.processOutput(data)` and `sessionTabManager.markSessionActivity()`.
- **Background session events:** Handles `session_activity`, `session_exit`, `session_error`, `session_started`, and `session_stopped` messages for sessions the client is not actively joined to. These update tab status indicators and feed the notification idle timer. These handlers never modify the terminal or show overlays — they only interact with `SessionTabManager`.

### Reconnection & Liveness

The client treats a "fast reconnect" as a hard requirement. The relevant pieces:

- **Heartbeat watchdog** (`src/public/heartbeat-watchdog.js`, shared with `splits.js`): every 25s sends `{type:'ping'}`; if no `{type:'pong'}` arrives within 10s, force-closes the socket with code 4000/`pong-timeout`, which in turn triggers the normal reconnect path. Detects silently-dead connections (NAT rebind, mobile sleep, captive portal) within ~10s instead of waiting for the browser TCP timeout (often 30+ seconds on cellular).
- **Per-socket fencing:** every `connect()` increments `_socketGeneration`. The watchdog and `connect()`'s on{open,message,close,error} handlers each capture `(ws, gen)` at construction and bail if those no longer match `this.socket` / `this._socketGeneration`. This is required because `clearInterval`/`clearTimeout` do NOT cancel an already-queued callback — without the fence, a stale tick from an old socket can close the freshly-opened new one.
- **Heartbeat is restarted on every (re)connect:** `startHeartbeat()` is called at the top of `socket.onopen` (before `loadSessions()` or any other await). Previously the heartbeat was started once at init and died after the first reconnect.
- **First-attempt backoff is 250ms** (covers a server-process restart window without being user-perceptible). Attempts ≥ 1 use the existing exponential-with-jitter formula. The 1000ms fixed wait inside `reconnect()` was removed.
- **Trigger-driven reconnect:**
  - `online` event → reconnect if socket not OPEN.
  - `pageshow` event (bfcache restore on mobile back/forward) → reconnect if `e.persisted` or socket not OPEN.
  - `visibilitychange→visible` → if socket is `CLOSED`, reconnect; if `OPEN`, restart the heartbeat so a ping fires immediately (proves liveness within ~10s instead of waiting up to 25s for the next interval). A separate, tighter probe-window was deliberately rejected — cellular radio wake-up is 1.5–3s, and a separate timer races with any in-flight pong from before tab-hide.
- **Splits** (`src/public/splits.js`) maintain their own watchdog and reconnect logic with the same parameters (mirrors main pane). A `_closing` flag on `Split` distinguishes user-initiated `disconnect()` from an unexpected drop, so re-targeting a split to a new session does not trigger an auto-reconnect to the old one.

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
  fontFamily: "reads from CSS --font-mono token; defaults to 'MesloLGS Nerd Font', 'JetBrains Mono NF', 'Fira Code NF', 'Cascadia Code NF', monospace",
  fontSize: 14,          // 13 on mobile
  lineHeight: 1.2,
  scrollback: 10000,
  allowProposedApi: true
}
```

The terminal auto-resizes via `FitAddon` triggered by a `ResizeObserver` on the terminal container, debounced to prevent excessive resize messages.

### Input Buffering

Terminal input uses a breather-flush pattern to batch keystrokes per animation frame rather than sending each keystroke individually:

1. Each `onData` event appends to `_inputBuffer` instead of sending immediately.
2. A `requestAnimationFrame` callback calls `_flushInput()`, which sends the entire buffer as a single `input` message.
3. If the buffer exceeds `_INPUT_BUFFER_MAX`, it flushes immediately without waiting for the next frame.
4. The buffer is cleared on WebSocket reconnect to prevent ghost keystrokes.

This reduces WebSocket message volume during fast typing and improves perceived responsiveness during heavy output.

### Font Loading Strategy

Font declarations live in `src/public/fonts.css` with a three-tier source strategy per family:

1. **`local()`** — user's installed font (v3 naming preferred; v2 "MesloLGS NF" deprioritized after self-hosted WOFF2)
2. **Self-hosted WOFF2** — `src/public/fonts/` (14 files across 4 families)
3. **CDN fallback** — jsDelivr CDN pinned to `mshaugh/nerdfont-webfonts@v3.3.0`

**Supported Nerd Font families:**
| CSS Family Name | WOFF2 Prefix | Variants |
|---|---|---|
| `'MesloLGS Nerd Font'` | MesloLGSNerdFont | Regular, Bold, Italic, BoldItalic |
| `'JetBrains Mono NF'` | JetBrainsMonoNerdFont | Regular, Bold, Italic, BoldItalic |
| `'Fira Code NF'` | FiraCodeNerdFont | Regular, Bold |
| `'Cascadia Code NF'` | CaskaydiaCoveNerdFont | Regular, Bold, Italic, BoldItalic |

Every font option in the settings dropdown appends `'MesloLGS Nerd Font'` as a CSS fallback to ensure PUA glyphs render even for fonts without Nerd Font variants (Consolas, System Monospace).

MesloLGS Regular + Bold are preloaded via `<link rel="preload">`. Other fonts load on-demand when selected.

### Font Load Refresh

When fonts finish loading, the terminal must rebuild its canvas glyph atlas:

```js
document.fonts.ready.then(() => {
    this.terminal.clearTextureAtlas(); // invalidate cached glyph bitmaps
    this.terminal.refresh(0, this.terminal.rows - 1);
    this.fitTerminal();
});
document.fonts.addEventListener('loadingdone', () => {
    this.terminal.clearTextureAtlas();
    this.terminal.refresh(0, this.terminal.rows - 1);
    this.fitTerminal();
});
```

`clearTextureAtlas()` is required because `refresh()` alone reuses stale atlas bitmaps rasterized before the web font loaded. Both main terminal (`app.js`) and split pane terminals (`splits.js`) implement this pattern.

### Settings Modal

The settings modal (`#settingsModal`) is a two-pane dialog, not a collapsible stack. The left rail (`.settings-nav`) is an ARIA tablist (`role="tablist"`, `aria-orientation="vertical"`) with six `.settings-tab` buttons. The right side (`.settings-panes`) contains six `.settings-pane` tabpanels. One pane is visible at a time; inactive panes stay in the DOM with `[hidden]` so existing control IDs and JavaScript references remain stable.

| Tab / pane | Settings |
|------------|----------|
| Terminal | Theme, font family, font size, cursor style/blink, scrollback, terminal padding |
| Voice Input | Recording mode (push-to-talk default, toggle), input method (auto/cloud/local), mic sounds |
| Notifications | Sound toggle, volume slider, desktop alerts toggle |
| Display | Token stats toggle, session sticky notes & auto-titles toggle |
| Advanced | Autonomous mode toggle and warning copy |
| Install | Install availability status, install button, iOS Add-to-Home-Screen instructions |

Keyboard handling in `setupSettingsModal()` implements roving `tabindex` plus Arrow Up/Down/Left/Right, Home, and End navigation. The Install tab and pane are hidden when `_isInstalled` indicates the app is already running as an installed PWA. The install state machine still owns `#installStatus`, `#settingsInstallBtn`, and `#installIOSInstructions`.

`src/public/components/controls.css` scopes the redesign under `.settings-modal`. It provides the two-pane layout and restyles the native controls without changing their JavaScript contract:

- Checkboxes keep native `<input type="checkbox">` elements and IDs, but add `.switch-input` for toggle-switch styling; `.checked` and `change` events are unchanged.
- `<select>` elements remain native selects with a token-backed closed-control style and chevron.
- Range controls are wrapped in `.range-field` and show a `.range-value` pill (`#fontSizeValue`, `#terminalPaddingValue`, `#notifVolumeValue`) updated by existing input handlers.
- Forced-colors and `prefers-reduced-motion` rules keep selected tabs, switches, sliders, and selects usable in high-contrast and reduced-motion environments.

Settings are persisted to `localStorage` under the `cc-web-settings` key. `loadSettings()` returns defaults merged with stored values. `saveSettings()` still reads `.value` / `.checked` from the preserved IDs, and `applySettings()` applies all values to the terminal and UI, including terminal padding.

Default settings include `voiceRecordingMode: 'push-to-talk'`, `voiceMethod: 'auto'`, `micSounds: true`, `terminalPadding: 8`, `notifSound: true`, `notifVolume: 30`, `notifDesktop: true`, and `enableSessionStickyNotes: true`.

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
- Sends desktop `Notification` when the page is **not visible** and the event is for a background tab.
- When the page **is visible** but the event is for a different session tab, shows an in-app toast notification instead of a desktop notification.
- Falls back to in-page toast notifications + vibration on mobile.
- Notifications auto-close after 5 seconds.
- Clicking a notification switches to the relevant tab and focuses the window.
- Receives lightweight `session_activity` events from the server for sessions the client is not joined to, enabling idle detection and notifications for background tabs without requiring full terminal output.

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

## App Identity (Client)

Source: `src/public/app-identity.js`

`app-identity.js` is loaded before `session-manager.js` and `app.js` and exposes `window.AppIdentity` in the browser. It is also a CommonJS module for the server-side dynamic manifest path.

The shared display format is `[HOST] ai-or-die`; when the sanitized hostname is empty, the identity falls back to `ai-or-die`. `sanitizeHostnameForDisplay()` removes control, bidi, and zero-width characters, collapses whitespace, uses the first DNS label by default, and ellipsizes long host labels. `formatNotificationTitle(title, hostname)` uses the same prefix and is idempotent so notifications are never double-prefixed.

After authenticated `loadConfig()` populates `this.hostname`, `init()` calls `formatAppIdentity()` and `applyAppIdentity()`. The application identity updates `document.title`, the mobile menu title, the app `aria-label`, PWA title meta tags, and the start screen live-status chip.

---

## PWA Support

### Service Worker

Source: `src/public/service-worker.js`

- **Cache name:** `ai-or-die-v10` (bump on every cache-shape change).
- **Precached resources:** root paths (`/`, `/index.html`), core stylesheets (tokens, base, component CSS including `components/controls.css`, mobile, main), JS modules (including `app-identity.js`, app, command-palette, clipboard-handler, session-manager, plan-detector, splits, icons, voice-handler, image-handler, input-overlay, feedback-manager, file-browser, file-editor, extra-keys), and the MesloLGS Nerd Font WOFF2 variants (other Nerd Font families are cached on demand).
- **Strategy for API/WebSocket/manifest routes:** Network only, with a 503 offline fallback for `/api/*`. `/manifest.json` is network-only because it is built per-machine and must not be served stale from the service-worker cache.
- **Strategy for versioned CDN assets** (unpkg, cdnjs, jsdelivr, Google Fonts): Cache-first.
- **Strategy for static assets:** Network first, cache on success, fall back to cache when offline. Navigations fall back to `/index.html` when offline.
- Activates immediately via `skipWaiting()` + `clients.claim()`.
- Cleans up old caches on activation.
- Handles `SKIP_WAITING` postMessage from the client to roll out new versions without waiting.
- Routes notification clicks to existing windows or opens a new tab with session context.

### Manifest

Source: `src/public/manifest.json` plus the dynamic `GET /manifest.json` route in `src/server.js`

`src/public/manifest.json` is the neutral base manifest (`name` and `short_name` are `ai-or-die`). The server serves `/manifest.json` with `Content-Type: application/manifest+json` and `Cache-Control: no-cache`, parses the base manifest in memory, and injects per-machine install metadata only when doing so is safe:

- In normal filesystem mode, the base manifest is read from `src/public/manifest.json`.
- In SEA mode, the base manifest is read via `sea.getRawAsset('public/manifest.json')`.
- When auth is **not** enforced (`this.noAuth || !this.auth`), `name` becomes `[HOST] ai-or-die` via `formatAppIdentity()` and `short_name` becomes the hard-truncated host via `formatShortName()`.
- When auth **is** enforced, the pre-auth manifest remains neutral (`ai-or-die`) so `os.hostname()` is not leaked to unauthenticated clients. After authenticated `/api/config`, the in-session title and UI still show `[HOST] ai-or-die`.
- On any dynamic-build error, the route falls back to the static/base manifest.

Icons are static PNG files in `src/public/` (`/icon-{16,32,144,180,192,512}.png`) so the served `Content-Type` matches the manifest's declared `image/png`. Screenshots at `/screenshot-wide.png` and `/screenshot-narrow.png` are pre-built SVG screenshot assets served from `.png` URLs for manifest compatibility.

### Installability requirements

PWA install is gated by the browser, not by the server. Chrome / Edge / Samsung Internet require **all** of:

- A web app manifest with `name`, `short_name` / `name`, `start_url`, `display`, and an icon ≥ 192×192.
- A registered service worker with a `fetch` handler (covered above).
- A **secure context**. This means one of:
  - `http://localhost` / `http://127.0.0.1` / `http://[::1]` (treated as secure regardless of cert)
  - HTTPS with a certificate signed by a CA in the device's trust store

The `--https` flag generates a self-signed certificate. **Connections from another device on the LAN to that cert (e.g. `https://10.0.0.9:7777`) are not considered a secure context for installability**, even after the user clicks through Chrome's interstitial. `window.isSecureContext` still returns `true`, but Chromium internally rejects the origin with `not-from-secure-origin` and refuses to register the service worker or fire `beforeinstallprompt`.

Workarounds for LAN testing: use `--tunnel` (Microsoft Dev Tunnels supplies a CA-signed cert), trust the self-signed cert manually on each device, or supply a real cert via `--cert`/`--key`. See [docs/history/pwa-install-lan-self-signed-cert.md](../history/pwa-install-lan-self-signed-cert.md) for the device-by-device procedure.

### Install state machine

Source: `src/public/app.js` (`_installState`, `_setInstallState`, `_updateInstallSection`, `_triggerInstall`).

Single `_installState` property drives both the floating Install button and the Settings → Install pane. States:

| State | Trigger | UI |
|---|---|---|
| `checking` | Initial; resolves within 3s | "Checking install availability..." |
| `available` | `beforeinstallprompt` fired and was preventDefault'd | "Ready to install as a standalone app." + button |
| `prompting` | User clicked install; awaiting `userChoice` | "Installing..." (button disabled) |
| `installed` | `appinstalled` fired or `_isInstalledPWA()` returns true on init | Section hidden |
| `unavailable-ios` | iOS device detected | iOS Share/Add-to-Home instructions |
| `unavailable-https` | `window.isSecureContext === false` | "Requires a secure connection. Use localhost or restart with --https." |
| `unavailable-browser` | Firefox or Samsung Internet | "Use your browser's menu to add this app to your home screen." |
| `unavailable` | 3-second timer expired with no other condition matching | "If no install button appears, use your browser menu → \"Install this site as an app\"." |
| `dismissed` | User rejected the install prompt | "Install was cancelled. Reload the page to try again." |

The 3-second fallback timer is a heuristic — `beforeinstallprompt` typically fires within a few hundred ms of page load on real hardware once criteria are met. The listener overrides the late-arriving event if the timer fires first.

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

---

## FileBrowserPanel

Source: `src/public/file-browser.js`

The file navigation panel, rendered as a right-docked side panel on desktop or a full-screen overlay on mobile. Displays directory listings, handles file selection, and manages upload input.

### Public API

| Method | Description |
|--------|-------------|
| `open(startPath)` | Open panel to a directory path |
| `close()` | Close panel, restore terminal width via `fitAddon.fit()` |
| `toggle()` | Toggle open/closed |
| `isOpen()` | Returns boolean |
| `openToFile(filePath)` | Navigate to parent directory, auto-select and preview the file |
| `navigateTo(path)` | Fetch listing from `GET /api/files` and render |
| `navigateUp()` | Navigate to parent directory |
| `navigateHome()` | Navigate to session working directory |

The panel auto-switches to overlay mode when the terminal would be squeezed below 80 columns (`ensureMinTerminalWidth()`).

File list uses ARIA tree pattern (`role="tree"`, `role="treeitem"`, `aria-expanded`, `aria-selected`) with full W3C arrow-key navigation.

Upload is handled via three methods: file picker button, drag-and-drop (full-panel overlay on drag-enter), and clipboard paste. Uploads go to `POST /api/files/upload` as base64 JSON with a 10 MB limit.

### FilePreviewPanel

Also in `src/public/file-browser.js`. Renders file previews dispatched by MIME category:

| Category | Rendering |
|----------|-----------|
| Image | `<img>` via `/api/files/download?inline=1` |
| Text/Code | Monospace `<pre>` with line numbers, hover-reveal "Edit" button |
| JSON | Pretty-printed `<pre>` |
| CSV | HTML `<table>` (max 100 rows) |
| PDF | `<iframe>` via `/api/files/download?inline=1` |
| Binary | Metadata + download button |

### TerminalPathDetector

Also in `src/public/file-browser.js`. Hooks into xterm.js right-click to detect file paths (Unix, Windows, and relative) in terminal output. Shows context menu items ("Open in File Browser", "Open in Editor", "Download") with async stat-based enabling. Reuses the existing `#termContextMenu`.

---

## FileEditorPanel

Source: `src/public/file-editor.js`

Ace Editor integration for in-browser text file editing. Ace is lazy-loaded from CDN on first editor open with a loading spinner and 5-second timeout.

### Public API

| Method | Description |
|--------|-------------|
| `openEditor(filePath, content, fileHash)` | Initialize Ace with content, store hash for conflict detection |
| `save()` | `PUT /api/files/content` with current content and stored hash |
| `toggleAutoSave()` | Enable/disable auto-save (default: ON, 3s debounce) |
| `onClose()` | Prompt for unsaved changes, prevent Escape from bubbling |
| `saveDraft()` | Backup to `localStorage` on every change for crash recovery |

### Conflict Handling

On 409 from the server, a conflict dialog offers: **Keep** (force-save editor content), **Reload** (discard editor changes), **Compare Changes** (show both versions).

### Theme Mapping

Ace themes map to the application's design token themes: midnight/classic-dark use `tomorrow_night`, classic-light uses `tomorrow`, monokai/nord/solarized themes use their Ace equivalents.

---

## File Browser Integration in app.js

Source: `src/public/app.js`

### New Methods

| Method | Description |
|--------|-------------|
| `toggleFileBrowser()` | Lazy-initialize `FileBrowserPanel` on first call, then toggle open/closed. Opens to the current session's working directory. |
| `openFileInViewer(filePath)` | Open the file browser panel navigated to a specific file path. Called by `TerminalPathDetector` and command palette. |
| `getCurrentWorkingDir()` | Returns the working directory of the current session, used by the file browser as its root path. |

### Keyboard Shortcut

`Ctrl+B` is registered in the global keydown handler. It calls `toggleFileBrowser()` and prevents the default browser bookmark action.

### UI Integration

- A "Files" button (`#browseFilesBtn`) is added to the session tab bar actions area. Clicking it calls `toggleFileBrowser()`. The button is disabled when no session is joined.
- Terminal resize: `fitAddon.fit()` is called when the file browser panel opens, closes, or is resized (via `transitionend` listener).
- Screen reader announcements for file browser state changes use the existing `#srAnnounce` live region.

### Command Palette Actions

Three new actions registered in `src/public/command-palette.js`:

| Action | Shortcut | Description |
|--------|----------|-------------|
| Toggle File Browser | `Ctrl+B` | Open/close file browser panel |
| Open File by Path... | `Ctrl+Shift+O` | Prompt for a file path, open directly in the file browser |
| Upload File | -- | Open the file picker for upload |

See the [File Browser Specification](file-browser.md) for the complete feature documentation including server API, security model, preview types, and testing requirements.

---

## VS Code Tunnel Integration

Source: `src/public/vscode-tunnel.js` (UI), `src/vscode-tunnel.js` (server manager)

### app.js Integration

| Property/Method | Description |
|----------------|-------------|
| `_vscodeTunnelUI` | Lazy-initialized `VSCodeTunnelUI` instance (created on first toggle or incoming event) |
| `toggleVSCodeTunnel()` | Create UI if needed, call `toggle()` — starts tunnel if stopped, shows banner if running |
| `stopVSCodeTunnel()` | Delegate to `_vscodeTunnelUI.stop()` |
| `copyVSCodeTunnelUrl()` | Delegate to `_vscodeTunnelUI.copyUrl()` |

### Keyboard Shortcut

`Ctrl+Shift+V` triggers `toggleVSCodeTunnel()`. Registered in the global keydown handler alongside `Ctrl+B` (file browser).

### UI Elements

- Toolbar button: `#vscodeTunnelBtn` with visual state classes (`.starting`, `.running`, `.error`)
- Status banner: `#vscodeTunnelBanner` with `.visible` class toggle. Auto-collapses after 5 seconds when status is `running` via `_scheduleAutoCollapse()`. The timer is cancelled if the status changes before firing.

### WebSocket Message Routing

Events `vscode_tunnel_started`, `vscode_tunnel_status`, `vscode_tunnel_auth`, and `vscode_tunnel_error` are forwarded from the `handleMessage` switch to `_vscodeTunnelUI.handleMessage()`. If the UI instance doesn't exist, it is created on-demand.

### Command Palette Actions

| Action | Shortcut | Description |
|--------|----------|-------------|
| Start VS Code Tunnel | `Ctrl+Shift+V` | Toggle tunnel on/off |
| Stop VS Code Tunnel | -- | Stop running tunnel |
| Copy VS Code Tunnel URL | -- | Copy URL to clipboard |

See the [VS Code Tunnel Specification](vscode-tunnel.md) for the complete feature documentation including server manager, binary discovery, auth flow, and WebSocket protocol.
