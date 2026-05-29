# Client Longevity Spec (CLIENT-03)

**Status**: Draft
**Owner**: SUP-CLIENT, stability-hardening-2026
**Related**: `docs/audits/client-diagnostics-scrollback.md`,
`docs/specs/client-app.md`, `docs/specs/server.md` (server `/api/diagnostics`)

This spec covers browser-side longevity instrumentation and the bounded
state that backs it. It is the canonical reference for `window.__diagnostics`
and the bounds on the long-lived buffers the diagnostics function
introspects. SUP-SOAK MUST use this surface for sampling; PR reviewers MUST
update this doc when changing the surface.

---

## 1. xterm.js scrollback (bound)

### Main terminal — `src/public/app.js`

The primary terminal is constructed in
`ClaudeCodeWebInterface.setupTerminal()` with an explicit cap:

```js
this.terminal = new Terminal({
  ...,
  scrollback: 10000,
  ...
});
```

- **Bound**: 10000 lines (10x xterm.js default of 1000).
- **Memory ceiling**: bounded; xterm.js evicts oldest lines once the buffer
  exceeds `scrollback + rows`.
- **Why this number**: matches the server-side output buffer cap (~1000
  lines per spec) plus a generous user-scroll headroom for long Claude
  responses. Empirically large enough that users rarely lose context, small
  enough that 10 concurrent sessions in one tab fit comfortably in <100 MB.
- **Do not remove this option**: omitting `scrollback` reverts to xterm's
  default of 1000, which is too small for the Claude UX. Increasing past
  ~50000 starts to matter on low-RAM devices.

### Split-pane terminal — `src/public/splits.js`

`SplitPaneManager` constructs additional terminals without specifying
`scrollback`. These fall back to xterm.js's default of 1000 lines. This is
**inconsistent** with the main terminal but **not a leak**. Future cleanup
(out of scope for CLIENT-03): align to `scrollback: 10000`.

---

## 2. Plan-detector buffer (bound — defer to CLIENT-01)

`src/public/plan-detector.js` maintains `this.outputBuffer` of
`{timestamp, data}` chunks with `this.maxBufferSize = 10000` entries. The
trim-on-overflow halves the buffer (line 69-71).

CLIENT-01 owns adding an explicit **byte cap** and an observable
`bufferBytes` getter. Until that lands, `__diagnostics()` computes the byte
estimate inline as `sum(entry.data.length)`.

**Shape contract for CLIENT-01**: a `bufferBytes` getter or property on
`PlanDetector` that returns the current sum of entry byte sizes. When
CLIENT-01 lands, `__diagnostics()` will prefer the getter and fall back to
the inline sum only if it is missing.

---

## 3. `window.__diagnostics()` — contract

### Signature

```ts
window.__diagnostics(): Promise<{
  ts: number,                      // Date.now()
  dom: {
    total_nodes: number,           // document.querySelectorAll('*').length
    listeners_tracked?: number,    // only when a tracker exists; omitted otherwise
  },
  buffers: {
    plan_detector_bytes: number,   // 0 if plan detector not initialized
    xterm_scrollback_lines: number // 0 if terminal not initialized
  },
  ws: {
    state: 0 | 1 | 2 | 3 | null,   // socket.readyState, null if no socket
    url: string | null,            // socket.url, null if no socket
  },
  sse: {
    connected: boolean,            // any active EventSource we can observe
    streams: number,               // count of observable EventSource handles
  },
  memory: object | null            // measureUserAgentSpecificMemory() result, or navigator.deviceMemory snapshot, or null
}>
```

### Guarantees

1. **Always returns** — never throws. Errors inside any sub-collector
   degrade gracefully to a sensible default (`null` / `0` / `false`) for
   that field.
2. **JSON-serializable** — the returned object is safe to pass through
   `JSON.stringify` (no `undefined`, no functions, no circular refs).
3. **Cheap** — synchronous-ish; the only `await` is the optional
   `measureUserAgentSpecificMemory()` call. Total wall-clock under 50ms on
   a modern laptop with a 10k-line scrollback.
4. **No side effects** — does not open sockets, does not touch DOM, does
   not write to storage.
5. **Pre-session safe** — callable from the moment `app.js` finishes
   loading, even before `window.app` is constructed or any session is
   joined. Returns sensible defaults (nulls, zeros) in that state.
6. **Idempotent install** — re-loading `app.js` (e.g. via HMR) overwrites
   the previous `window.__diagnostics`; last loader wins.

### Field-by-field semantics

- `ts` — `Date.now()` at the moment the diagnostics object is constructed
  (not at the moment the Promise resolves; the async memory call may add a
  few ms after this).
- `dom.total_nodes` — `document.querySelectorAll('*').length`. Cheap proxy
  for DOM growth.
- `dom.listeners_tracked` — **omitted** unless a global listener-tracker
  exists. No tracker today, so this field is not present in v1. SUP-SOAK
  must tolerate its absence.
- `buffers.plan_detector_bytes` — `window.app.planDetector.bufferBytes`
  when available; otherwise computed inline as the sum of
  `entry.data.length` over `planDetector.outputBuffer`. `0` if the plan
  detector is not initialized.
- `buffers.xterm_scrollback_lines` —
  `window.app.terminal.buffer.active.length` (xterm.js exposes the buffer
  line count). `0` if the terminal is not initialized.
- `ws.state` — `window.app.socket.readyState`, raw numeric code
  (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED). `null` if no socket.
- `ws.url` — `window.app.socket.url` if exposed, else `null`.
- `sse.connected` — `true` if any observable EventSource is open.
- `sse.streams` — count of observable EventSource handles. Best-effort:
  walks known holders on `window.app` (file browser panel watcher, search
  panel). Browser does not expose a global count of open EventSources, so
  this is a lower bound, not an authoritative total.
- `memory` — `await performance.measureUserAgentSpecificMemory()` when the
  page is cross-origin isolated and the API is present (Chrome). On
  `SecurityError` / `TypeError` / `null` API, falls back to
  `{ deviceMemoryGB: navigator.deviceMemory }`. If even that is
  unavailable, returns `null`.

### Versioning

This is **v1** of the shape. Additive fields are allowed without a major
bump. Renaming or removing a field requires a new spec revision and a
coordinated SUP-SOAK update.

---

## 4. Installation site

`window.__diagnostics` is installed at the **bottom of
`src/public/app.js`**, alongside the existing `DOMContentLoaded` handler
that constructs `window.app`. The install is a module-level statement so it
is available immediately on script load — independent of when (or whether)
`window.app` is constructed.

Rationale:
- Avoids a new `<script>` tag (no service-worker precache change).
- Available before session open; safe to call from soak harness as soon as
  the page loads.
- Last-loader-wins: if `app.js` is reloaded (HMR / cache bust), the
  reassignment is the active version.

---

## 5. Sampling guidance for SUP-SOAK

### When to call

- **Baseline**: immediately after page load and again ~30s after first
  session open (lets the terminal, WebSocket, and any panel-mount SSEs
  settle).
- **Steady-state**: every 60s for at least 30 minutes per soak run.
- **Post-stress**: after any synthetic burst (large output, many session
  open/close cycles), wait 5s for GC, then sample.

### What to alert on

- `buffers.plan_detector_bytes` growing without trim across consecutive
  samples once it crosses the CLIENT-01 cap.
- `buffers.xterm_scrollback_lines` exceeding ~10100 (scrollback + viewport
  rows) — that is the natural ceiling; values above it indicate xterm.js
  or our buffer math is wrong.
- `dom.total_nodes` growing monotonically across samples taken at the same
  idle state. A few hundred nodes drift is normal; thousands per minute is
  a leak.
- `ws.state` flipping to 2/3 and staying there for more than one sample
  period — reconnect failure.
- `sse.streams` growing without bound while sessions are stable.
- `memory.bytes` (when present) doubling between baseline and 30-minute
  steady-state.

### How to call from Playwright

```js
const snap = await page.evaluate(() => window.__diagnostics());
expect(snap.ts).toBeGreaterThan(0);
expect(typeof snap.dom.total_nodes).toBe('number');
// ...
```

Always `await` the result — `__diagnostics` returns a Promise.

### Storage

SUP-SOAK persists samples as JSONL (one snapshot per line) under
`test-results/longevity/<session-id>/diagnostics.jsonl`. Snapshots from the
same run are append-only; comparison across runs is by file diff.

---

## 6. Cross-platform notes

`__diagnostics` is pure browser API (no Node, no shell, no FS). It runs
identically on Windows 11 + Chromium, macOS + WebKit/Chromium, and Linux +
Chromium. The optional `measureUserAgentSpecificMemory` is Chrome-only and
gated on cross-origin isolation; the fallback path covers every other
browser.
