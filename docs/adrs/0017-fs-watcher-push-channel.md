# ADR-0017: Agent-vs-User Concurrent-Edit Sync via chokidar + SSE Push Channel

## Status

**Accepted**

## Date

2026-05-14

## Context

ADR-0016 chose Monaco as the file-browser editor and established the
multi-file tabs / diff / cross-file search surface. ADR-0012 (the editor
section of which ADR-0016 superseded) shipped a hash-based optimistic
concurrency control (OCC) flow: `GET /api/files/content` returns an MD5
hash; `PUT /api/files/content` rejects with 409 if the file's current
hash differs; the client surfaces a Keep / Reload / Compare modal.

The OCC flow protects against data loss but is **reactive** — the user
finds out about a concurrent edit only at save time. This is fine for a
classical single-user editor, but **this app is a frontend for AI coding
agents** (Claude, Codex, Gemini). The "single user" is functionally a
**human + AI agent on the same files**. The agent edits files
asynchronously while the user has them open. Without a push channel:

1. User opens `foo.js` in a Monaco tab → agent rewrites `foo.js` → user
   reads the stale buffer for minutes → user types → user is now editing
   stale code, branched from a version the agent has already replaced.
2. Save fires the 409 modal — **after** the user has reasoned about the
   wrong code. The OCC flow saves data but not user time.

Both adversarial reviews of PR #99 (`feat/file-browser-monaco`) flagged
this as the central architectural gap for an AI-driven coding UI:

- **gemini-3.1-pro-preview** scored the v1 surface 2/5 with the headline
  "renders the 'first-class IDE' unusable for its primary human-agent
  workflow" until concurrent-edit sync ships.
- **codex-critic (gpt-5.5)** scored 3/5 with "useful for the single user
  TODAY, not yet first-class. … no polling/watcher means user edits
  stale content for minutes before save-time 409 fires."

The user's stated bar is "first-class IDE support and file view/edit
support for the single user using this app." First-class in this app
requires proactive agent-aware sync, not just reactive OCC.

## Decision

We add a **proactive file-system push channel** so open tabs and
directory listings reflect on-disk reality in near-real-time:

1. **Server-side fs-watcher**: a [chokidar](https://github.com/paulmillr/chokidar)
   watcher per Claude session, rooted at the session's `workingDir`.
2. **Server-Sent Events (SSE) endpoint** `GET /api/files/watch?path=<dir>`
   streams events to subscribed clients.
3. **Client-side reactive integration** in `TabManager` and
   `FileBrowserPanel` consumes the stream and either (a) silently
   re-syncs clean Monaco models, (b) surfaces a non-blocking toast on
   dirty tabs, or (c) refreshes directory listings on add / unlink.

The existing 409-Conflict-on-save flow remains active as a backstop —
it catches anything the watcher missed (network drops, race between an
SSE event and a save in flight, etc.).

### Why chokidar (not Node's built-in `fs.watch`)

`fs.watch` is platform-inconsistent in ways that bite production code:

- **macOS**: `fs.watch` returns wrong filenames on rename in many cases;
  chokidar uses macOS's native FSEvents API which is reliable.
- **Linux**: `fs.watch` over inotify works for local filesystems but
  silently fails on FUSE mounts (sshfs, encfs) and many container
  bind-mounts; chokidar detects and falls back to polling.
- **Windows**: `fs.watch` reports rename as `add` + `unlink` pair with
  cryptic timing; chokidar normalises to `rename`.
- **WSL2**: `/mnt/c/...` paths require polling; `fs.watch` returns no
  events. chokidar detects and switches automatically.
- **Network drives**: SMB / NFS mounts may not propagate events at all;
  chokidar's `usePolling` flag with a tunable interval gives a working
  fallback without code changes.

chokidar is ~100M weekly npm downloads, used by webpack / parcel / vite /
gulp / nodemon / etc. Battle-tested across all the OS variants this app
targets. Server-only dep (~2 MB install footprint); no client bundle
impact.

### Why Server-Sent Events (not WebSocket)

The existing `/api/search` endpoint already uses SSE (`bde844f`) and we
have client + server plumbing for it (rate limit, auth integration,
cancellation via `EventSource.close()`). SSE is the right shape for
this use case:

- **One-way server → client.** No client → server messages needed; SSE
  matches.
- **Auto-reconnect.** Browser-native; survives transient drops without
  app-level retry logic.
- **HTTP/1.1 keep-alive friendly.** Reuses the existing auth-middleware
  pipeline; no protocol upgrade dance.
- **Trivial cancellation.** Closing the `EventSource` ends the
  subscription; no application-level handshake.
- **`?token=` auth via existing `AuthManager#appendAuthToUrl`.** Same
  query-param fallback used for `<img src>` / `<iframe src>` /
  PDF.js worker URLs (per #96 — `EventSource` cannot carry custom
  Authorization headers, same constraint as those).

WebSocket would add full-duplex we don't need, would force a separate
connection-management layer, and would not fit the existing
auth + SSE pattern the project already runs.

### Per-session scoping

One chokidar watcher per Claude session, rooted at `session.workingDir`.

- **Why per-session, not per-file**: kernel watch resources are bounded
  (Linux `inotify_max_user_watches` defaults to 8192). One watcher per
  open file would exhaust on a 10k-file repo. One watcher per session at
  the cwd root scales with users not files.
- **Why per-session, not project-wide**: aligns with existing
  session-scoped `/api/search` rate-limit pattern. Two sessions with
  different cwds get independent watchers.
- **Lazy creation**: watcher is created on first
  `GET /api/files/watch?path=<dir>` for a session and kept alive while at
  least one EventSource is open.
- **Path validation**: the watch root is funneled through `validatePath()`
  with realpath resolution before chokidar starts. The watcher cannot
  escape `baseFolder`.

### Event payload

```json
{
  "type": "change" | "add" | "unlink" | "rename",
  "path": "<absolute, normalised>",
  "relPath": "<relative to watch root>",
  "mtime": 1715692800123,
  "hash": "<md5, optional>",
  "prevPath": "<absolute, only on rename>"
}
```

- `path` is the absolute, forward-slash-normalised path (matches the
  `/api/files/*` convention).
- `relPath` is always present, computed against the session's watch root
  (`session.workingDir`). Lets the client render breadcrumbs / file-tree
  UI without repeated string slicing on every event. Same forward-slash
  normalisation.
- `mtime` lets clients detect ordering / staleness without re-fetching
  content.
- `hash` (MD5) is included for `change` events on text files ≤ 5 MB
  (matches `/api/files/stat` behaviour). Omitted for binary / large
  files. Lets the client skip the round-trip if the new hash matches the
  in-buffer content (rare, but cheap).
- `prevPath` is included **only on `rename` events** (server-side
  synthesis — see "Rename detection" below).

### Rename detection (server-side coalescing)

chokidar emits `unlink` then `add` for renames; the same inode appears on
both events when chokidar runs with `alwaysStat: true`. The watcher
wrapper coalesces same-inode `unlink` + `add` pairs within a 50 ms
window into a single synthetic `{type: 'rename', prevPath, path, relPath, mtime}`
event. Falls back to the separate `unlink` + `add` pair if the window
misses (network filesystems with high-latency stat calls, very large
files where the rename takes longer than 50 ms).

Why server-side: the client would otherwise have to maintain its own
inode-to-path map across two SSE events, which is error-prone and
duplicates logic across every consumer (TabManager + FileBrowserPanel
each need it). Centralising in the watcher keeps the wire contract
clean.

### Ignore patterns

chokidar runs with `depth: undefined` (unbounded subtree) but with an
explicit ignore list to avoid flooding from build-output and dependency
directories:

- `node_modules` / `.git` / `dist` / `build` / `target` / `.next` /
  `.cache` / `__pycache__` / `.venv` / `venv` / `.tox` / `.gradle`
- Mirrors the `EXCLUDE_DIRS` list `/api/search` already uses for
  ripgrep, so user expectations transfer between Search and Watch.
- chokidar does NOT natively respect `.gitignore` — adding that would
  require parsing the file at every directory boundary; deferred to a
  follow-up if user feedback warrants. The static ignore list catches
  the 95% case (large dirs that produce thousands of events on a
  `npm install` or `cargo build`).
- Configurable via `FS_WATCHER_IGNORE` env var (comma-separated) for
  unusual project structures.

### Initial state — fetch separately, no synthetic initial event

`chokidar` runs with `ignoreInitial: true`. The client is responsible
for the initial directory listing via `GET /api/files?path=<dir>` (the
same endpoint it already uses on panel mount). The watch endpoint emits
ONLY changes, never an initial snapshot.

Why: emitting a synthetic `{type:'initial', files:[...]}` event would
duplicate `/api/files`'s response shape on the wire, force the client to
handle two parallel listing surfaces (one paginated REST, one streamed
SSE), and add server-side complexity for a problem the existing endpoint
already solves cleanly. Two layers, one job each.

### Event coalescing

Two layers:

**1. chokidar `awaitWriteFinish` — read-during-write protection.**
The watcher runs with `awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 }`.
chokidar's defaults (300 ms / 100 ms) add ~400 ms of latency before any
event is emitted; tuned-down to 80/30 gives ~110 ms latency while still
collapsing the mid-write event flood that fires when an editor (vim,
emacs's atomic save, VS Code, prettier) writes via temp-file + rename
or via multiple `write()` syscalls. Without `awaitWriteFinish`, the
client would receive a `change` event mid-write, fetch incomplete
content, then receive a second `change` after the write completes —
two unnecessary round-trips and a momentary UI flicker.

systems-engineer's smoke-test confirmed 80/30 produces ~80-110 ms
end-to-end latency on a real workload while suppressing all observed
mid-write false positives. Tunable via `FS_WATCHER_STABILITY_MS` and
`FS_WATCHER_POLL_MS`.

**2. Per-path debounce — agent-batch protection.**
Beyond chokidar's per-write coalescing, a 100 ms debounce per file path
collapses agent batch operations (a 50-file `prettier --write` produces
50 events in a single tick; without debounce the client gets 50 SSE
messages and 50 Monaco model swaps). Tunable via
`FS_WATCHER_DEBOUNCE_MS`.

**3. Server-side `add` + `change` dedup.**
On some filesystems (atomic-rename save: vim's `:w`, some editors'
crash-safe save) chokidar emits `add` immediately followed by `change`
for the same path within tens of milliseconds. The server collapses
these within a 50 ms window into a single `change` event — the client
treats them identically (re-fetch content + swap model) and seeing both
just causes an extra round-trip.

### Multiplexing — single EventSource per session with subscribe/unsubscribe control

**One `EventSource` per session, NOT per open file.** Browsers cap SSE
connections at 6 per origin in Chromium and similar in Firefox/Safari.
A naïve "one EventSource per open tab" design would fail at the 7th
open tab — a routine workflow.

Wire shape:

- `GET /api/files/watch?session=<id>` opens the SSE stream. The server
  watches the session's `workingDir` and starts emitting events for any
  path the client has subscribed to.
- `POST /api/files/watch/subscribe?session=<id>&path=<absolute>` adds a
  path to the active subscription set for that session. Server responds
  204; subsequent SSE events for that path will arrive on the open
  EventSource.
- `POST /api/files/watch/unsubscribe?session=<id>&path=<absolute>`
  removes a path. Server stops emitting events for it.

The chokidar watcher itself watches the SUPERSET of all subscribed
paths' parent directories — narrower than watching the entire
`workingDir`, broader than watching individual files. This balances
kernel-watch resource cost against subscription latency.

`TabManager` is the canonical client subscriber: opens the EventSource
on first tab, calls `/subscribe` on every `openFile()`, calls
`/unsubscribe` on every `closeTab()`. `FileBrowserPanel` shares the
same EventSource and adds the panel's current dir to the subscription
set; on `navigateTo()` it `/unsubscribe`s the old dir + `/subscribe`s
the new one.

### Client-side reaction lifecycle

`TabManager` opens one `EventSource` per session at panel mount,
multiplexed via the subscribe/unsubscribe control channel above. Per event:

- **`change` event matching an open path**:
  - **Tab is clean** (Monaco model value === `_lastSavedContent`):
    silently `GET /api/files/content`, swap the new content into the
    Monaco model, **preserve cursor position + scroll offset + selection**
    (engineer's plan: `getPosition()` → `setValue()` → `setPosition(saved)`
    with bounds-check for the line-may-no-longer-exist case; reuses the
    `_suppressContentChange` flag from the existing `_reloadFile` path).
    Update `_lastSavedContent` to the new content.
  - **Tab is dirty**: surface a non-blocking toast on the tab strip:
    > `agent modified <path>`
    > [ Reload (discard) ] [ Compare ] [ Keep mine ]
    Don't force a modal mid-typing — only the existing 409 modal fires
    if the user hits Save with stale content. The toast is purely
    informational + offers escape hatches.
- **`add` / `unlink` event matching the panel's current dir**: refresh
  the directory listing without user F5.
- **`rename` event** matching either case: treated as
  unlink(prevPath) + add(path) for listing refresh; if `prevPath`
  matches an open tab, the tab's path metadata updates in-place
  (subsequent saves go to `path`, not `prevPath`).
- **WebSocket reconnect** (or EventSource drop + auto-reconnect):
  assume some events were missed during the gap; mark all open tabs as
  needing a `mtime` re-check on next focus. Don't re-fetch content
  speculatively (would thrash on every reconnect); use mtime drift as
  the staleness signal.

### Compare-with-memory action (dirty-tab toast → Compare)

The dirty-tab toast's "Compare" button needs to diff the user's
in-memory buffer against the new on-disk content — both inputs are
already known to the client. The existing `DiffViewerPanel` (#6) takes
two paths and fetches both via `/api/files/content`; we extend it with
a new entry point:

```js
DiffViewerPanel.openMemoryVsFile(memContent, diskPath)
```

- `memContent`: the user's current Monaco buffer value (string).
- `diskPath`: the absolute path on disk; the panel fetches via
  `/api/files/content` and diffs the response against `memContent`.
- Renders in the same diff-tab surface as `openFileVsFile()`, with a
  visible label distinguishing "memory" vs "disk" sides.

Engineer owns this entry point on the diff component; `TabManager`
calls it from the toast's Compare handler.

### Auth

`?token=` query-param via the existing `AuthManager#appendAuthToUrl`
(from `6beebc3`). Same constraint as `<img>` / `<iframe>` / PDF.js
worker — `EventSource` doesn't carry custom Authorization headers.
Server middleware already accepts both `Bearer <token>` header and
`?token=<token>` query param.

The HMAC-signed-token v2 (tracked in #96) will replace the query-param
fallback uniformly for all these endpoints; no special handling needed
for the watch endpoint.

### Rate limiting

Two complementary limits, both via the existing `_perIpRateLimit`
middleware:

**1. Concurrent-watcher cap (state-based): 5 open watchers per IP.**
The 6th `GET /api/files/watch?session=<id>` opens with a different
session id is rejected with 429. Cleanest mechanic for SSE — open count
directly maps to active server load (one chokidar watcher + one open
TCP connection per concurrent watcher). Tracked via a per-IP counter
that decrements on `req.on('close')`.

**2. Per-session event-emission cap (rate-based): ~100 events/min.**
On top of `awaitWriteFinish` + the 100 ms per-path debounce + the 50 ms
add+change dedup, this final cap protects against pathological cases
like `find /large-dir -exec touch {} \;` or a runaway tool emitting a
`change` per millisecond. Excess events are dropped (not queued); the
SSE consumer treats this as the same kind of event-loss the
WebSocket-reconnect path already handles via mtime-drift re-check on
focus.

### Backstop: existing 409-Conflict-on-save remains active

The fs-watcher is best-effort. SSE drops, network reconnects, coalescing
windows, browser tab backgrounding (some browsers throttle
EventSource), and platform watcher gaps mean some events will be missed.
The hash-based 409-Conflict-on-save flow from ADR-0012 stays in place
so missed events still result in correct behaviour at save time:

- Worst case with fs-watcher present: same as worst case before — user
  reasons about stale content, hits Save, sees the 409 modal.
- Best case: fs-watcher delivers the event in <100 ms, user never sees
  stale content.
- Common case: fs-watcher delivers within 200 ms; clean tabs auto-sync;
  dirty tabs get a non-blocking toast; user keeps flow.

The two layers compose: fs-watcher is the proactive UX win; OCC is the
correctness guarantee.

## Consequences

### Positive

- **First-class IDE for the agent-driven workflow.** This is the bar
  the user named; this ADR is the missing piece. After implementation,
  PR #99's "first-class IDE" framing becomes accurate without v1 / v2
  caveats.
- **Better UX for non-agent edits too.** External `git pull` /
  `git checkout`, build tools writing generated files, `prettier --write`
  on a directory, even running `make` — all surface in the file browser
  + open tabs without the user manually refreshing.
- **Reactive directory listing.** Agent creates `bar.js` → file browser
  list refreshes immediately. Removes a known papercut from the
  v1 docked-panel UX.
- **Coalescing scales.** Agent batch edits (50-file refactor) produce
  one SSE event per file per 100 ms — bounded.

### Negative

- **chokidar is a new server-side dependency.** ~2 MB install. Adds a
  CVE surface to track + maintenance overhead. Mitigated by chokidar's
  100M-downloads/week scrutiny and the `npm audit` baseline already in
  CI.
- **Per-session resource cost.** One chokidar process state + ~one
  inotify (Linux) / FSEvents (macOS) / RDC handle (Windows) per active
  session. Low for typical use (single-digit sessions); investigate if
  user reports many-session-overload.
- **Watcher gaps under failure.** Network drives and unusual file
  systems may need polling backend; chokidar's auto-detect handles most
  cases but adds CPU overhead under polling.
- **EventSource auth via `?token=`** has the same access-log /
  Referer leakage concern as the other inline-preview auth surfaces.
  Mitigated by `Cache-Control: no-store` on the watch endpoint and
  the in-flight HMAC-signed-token replacement (#96).
- **Mid-edit reload UX is subtle.** Even with cursor + scroll
  preservation, a clean-tab silent reload that changes the visible code
  while the user is reading is a momentary cognitive jolt. Will get
  user feedback after merge; can add a brief "auto-synced" toast if
  silent feels too silent.

### Neutral

- Existing 409-Conflict modal stays exactly as it is — same code, same
  three buttons, same diff editor. The watcher reduces how often it
  fires but doesn't replace it.
- The watcher is server-side only — no impact on the Monaco bundle, no
  impact on first-load time, no client dependency added beyond the
  EventSource consumer (browser-native).
- Spec impact: `docs/specs/file-browser.md` gains a "Reactive sync"
  section and the existing "Limitations" → "No real-time file watching"
  entry comes off.

## Notes

- **Supersedes** the agent-vs-user concurrent-edit deferral noted in
  ADR-0016 ("Deferrals tracked for follow-up" → "Agent-vs-user
  concurrent file edits — proactive sync"). That entry will be marked
  resolved on this PR's merge; #100 closes.
- **Related:** ADR-0012 (the OCC flow this builds on top of), ADR-0016
  (the editor surface this integrates with), `06-local-first-then-ci.md`
  (testing posture: chokidar's platform-specific backends mean CI's
  Windows + Linux runs are essential cross-platform verification).
- **Out of scope for this ADR / first ship:**
  - **Cross-session watch** (session A sees agent edits in session B).
    Each session watches its own cwd; cross-session sync is a follow-up
    if user feedback warrants.
  - **3-way merge UI** for the dirty-tab toast. v1 ships
    Reload / Compare / Keep-mine; richer merge UI is a separate scope.
  - **Auto-show inline diff on arrival** (visual highlight of what
    the agent changed). Defer to UX polish follow-up.
  - **Watch outside session.workingDir** (e.g. project ancestor). The
    sandbox is intentional; out of scope.
  - **Persistent event log** (replay missed events on reconnect). Not
    needed — backstop OCC + mtime drift detection already covers the
    correctness gap.
