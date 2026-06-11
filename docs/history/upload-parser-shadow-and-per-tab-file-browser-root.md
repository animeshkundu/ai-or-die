# Non-image drag-drop uploads + per-tab file-browser root — 2026-06-10

## Symptoms (reported)

1. **Non-image files could not be uploaded by drag-and-drop onto a tab.** Images worked; PDFs, docs, etc. silently failed.
2. **The file browser did not root at the tab's working directory.** It opened at / stayed on the server's launch directory (or a previously viewed tab's directory) instead of the directory where that tab's agent was started.

## Root causes

### #1 — global body-parser shadowed the upload route
`src/server.js` mounted `app.use(express.json())` globally with the Express default ~100 KB limit, which ran *before* the upload route's own `express.json({ limit: '10mb' })`. base64 inflates a file ~33%, so any non-image file over ~75 KB produced a body the global parser rejected with `PayloadTooLargeError` (HTTP 413) before the route ran. There was no custom Express error handler, so the client only saw a non-OK response and toasted "upload failed". Images were unaffected because they upload over a WebSocket `image_upload` frame, never touching `/api/files/upload`. That asymmetry was the whole symptom — confirmed by the existing `test/upload-generic.test.js` (a 1 MB upload asserted 413 with a comment documenting the shadowing), and by the happy-path test where a ~23-byte PDF returned 200.

### #2 — file-browser root: server ignored the session, and the singleton panel never re-rooted
Three compounding causes:
- `GET /api/files` defaulted to `req.query.path || this.baseFolder` and accepted no session context — with no `path` it listed the server launch dir.
- The client sent no `path` when its session→cwd cache was cold (e.g. right after a page reload, before `loadSessions()` resolved), so it fell into the `baseFolder` default.
- The file-browser panel is a singleton whose `open()` short-circuits when already open. Switching tabs while it was open left it showing the previous tab's directory, and further navigation sent an explicit `path`, so any server default never applied. This was the most visible day-to-day form of the bug.

## Fix

- **`src/server.js`** — wrapped the global `express.json()` to exempt `/api/files/upload` (trailing-slash normalized, so `/api/files/upload/` — which Express still routes to the handler — is exempt too); bumped the route parser to `20mb` (fits base64 of the 10 MB decoded cap); added a trailing 4-arg error handler keyed on body-parser's `err.type` that returns JSON `{ error }` for oversize/malformed bodies. The route stays *after* the auth + rate-limit middleware (moving it above `express.json()` would have bypassed auth).
- **`src/server.js` `GET /api/files`** — when no `path`, resolve the default root from `req.query.session` → `session.liveCwd || session.workingDir` (mirrors the existing `/api/files/find` pattern), validated, falling back to `baseFolder` (with a warn) for unknown/stale sessions so the browser never 403s. Response `home` now reflects the session root; `baseFolder` stays the sandbox floor.
- **Client (`src/public/file-browser.js`, `app.js`)** — `FileBrowserPanel` gained a `getSessionId` option (wired to `currentClaudeSessionId`); `navigateTo` always forwards `?session` (used by the server only when `path` is absent) and, on each response, stores `home` and reconnects the fs-watcher to the server-resolved `currentPath`; `navigateHome` targets the stored session `home`; new `notifyActiveSessionChanged(sessionId)` re-roots an open panel path-lessly on tab switch, wired from the `session_joined` handler.

## Interpretation / non-goals
"Root directory for that tab" = the **default open location and Home target** for that tab's browser (editor-style, like a VS Code workspace root). The `baseFolder` sandbox floor and up-navigation are unchanged — users can still navigate above the session dir up to the server base. Session working dirs are always validated within `baseFolder` at creation, so the sandbox floor is always an ancestor of the session root.

## Tests
- `test/upload-generic.test.js`: >100 KB-and-<10 MB → 200 (regression guard); trailing-slash route → 200; decoded >10 MB → 413; >20 MB body → 413 JSON; malformed JSON → 400 JSON.
- `test/file-browser-api.test.js`: `?session` defaults to `workingDir`/`liveCwd`; explicit `path` overrides; unknown / no-cwd sessions fall back to `baseFolder` (no 403); `home` vs `baseFolder`.
- `test/file-browser-session-root.test.js` (new): client `navigateTo` session-param forwarding, `home` storage, watcher reconnect, `navigateHome`, and `notifyActiveSessionChanged` re-root / no-op.

## Review
Plan and implementation were hardened through adversarial review, which surfaced the trailing-slash / case-insensitive exemption bypass, the missing body-parser error handler, the singleton re-root gap, and the size-vs-type scope question (resolved by the diagnostic gate above).
