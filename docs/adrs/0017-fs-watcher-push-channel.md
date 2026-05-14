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
  "type": "change" | "add" | "unlink",
  "path": "<absolute, normalised>",
  "mtime": 1715692800123,
  "hash": "<md5, optional>"
}
```

- `mtime` lets clients quickly detect ordering / staleness without
  re-fetching content.
- `hash` is included for `change` events on text files ≤ 5 MB
  (matches `/api/files/stat` behaviour). Omitted for binary / large
  files. Lets the client skip the round-trip if the new hash matches the
  in-buffer content (rare, but cheap).
- Paths are normalised to forward slashes before emission (matches the
  `/api/files/*` convention).

### Event coalescing

A 100 ms debounce per file path. Save bursts (mid-edit autosaves,
multi-write tools, agent batch edits, IDE-style "format on save" plus
"save"} collapse into one SSE event per file per 100 ms. Without
coalescing, a typical agent batch refactor (50 files, 200 events) would
flood the SSE channel and force the client into a Monaco-thrash loop.

100 ms balances: small enough that the user perceives instant sync;
large enough that file-write bursts collapse cleanly. Tunable via
`FS_WATCHER_DEBOUNCE_MS` if real-world tuning shows it should change.

### Client-side reaction lifecycle

`TabManager` opens one `EventSource` per session at panel mount,
subscribed to `session.workingDir`. Per event:

- **`change` event matching an open path**:
  - **Tab is clean** (Monaco model value === `_lastSavedContent`):
    silently `GET /api/files/content`, swap the new content into the
    Monaco model, **preserve cursor position + scroll offset + selection**.
    Update `_lastSavedContent` to the new content.
  - **Tab is dirty**: surface a non-blocking toast on the tab strip:
    > `agent modified <path>`
    > [ Reload (discard) ] [ Compare ] [ Keep mine ]
    Don't force a modal mid-typing — only the existing 409 modal fires
    if the user hits Save with stale content. The toast is purely
    informational + offers escape hatches.
- **`add` / `unlink` event matching the panel's current dir**: refresh
  the directory listing without user F5.
- **WebSocket reconnect**: assume the SSE may have dropped events
  during the gap; mark all open tabs as needing a `mtime` re-check on
  next focus. Don't re-fetch content speculatively (would thrash on
  every reconnect); use mtime drift as the staleness signal.

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

Per-session limit on event emission. Coalescing at 100 ms already serves
as natural backpressure for normal file-write bursts; an explicit cap
(e.g. 100 events/min/session) protects against pathological cases like
a user running `find /large-dir -exec touch {} \;` in the working tree.
Reuses the existing per-IP rate-limiter pattern from `/api/search`.

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
