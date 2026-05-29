# Client Diagnostics & xterm Scrollback Audit (CLIENT-03)

**Date**: 2026-05-27
**Scope**: `src/public/app.js` Terminal construction + browser-side leak
inspection surface for SUP-SOAK.
**Campaign**: stability-hardening-2026 / SUP-CLIENT
**Status**: Findings only — see `docs/specs/client-longevity.md` for the spec
material derived from this audit.

## 1. xterm.js scrollback configuration

### Finding (main terminal)

`src/public/app.js:572` — the primary `new Terminal({...})` invocation inside
`ClaudeCodeWebInterface.setupTerminal()` sets:

```js
this.terminal = new Terminal({
  ...,
  allowProposedApi: true,
  scrollback: 10000,
  ...
});
```

**Verdict: bounded, sane.** The value is 10x the xterm.js default of 1000
lines but still capped — it cannot grow unbounded. At ~80 cols of ASCII this
is on the order of 0.8 MB of buffered text per terminal in the worst case
(xterm.js stores cells, not raw strings, so the real figure is higher but
still finite). No leak.

### Finding (split-pane terminal)

`src/public/splits.js:42` — a secondary `new Terminal({...})` is constructed
by `SplitPaneManager` for split panes:

```js
this.terminal = new Terminal({
  fontFamily: this.app?.terminal?.options?.fontFamily || ...,
  // NO scrollback option specified
});
```

**Verdict: implicit xterm.js default of 1000 lines** — bounded but
inconsistent with the main terminal's 10000. Not a leak, but a UX
discrepancy: scrollback content disappears 10x sooner in split panes than in
the primary terminal. Flagged for cleanup; not in scope for CLIENT-03.

### Recommendation

No change required for SUP-CLIENT — both terminals are bounded. Future
cleanup: align `splits.js` to the same `scrollback: 10000` for parity.
Tracking in spec but no PR opened from CLIENT-03.

## 2. Plan-detector buffer

`src/public/plan-detector.js:10` — `this.maxBufferSize = 10000` (entries,
not bytes). Buffer is trimmed to `maxBufferSize / 2` when the cap is hit
(line 69-71). Per-entry shape is `{timestamp, data}` where `data` is the raw
chunk string from the WebSocket. There is no explicit byte cap.

**Verdict: bounded by entry count but unbounded per-entry bytes.** A single
giant chunk could theoretically inflate one buffer slot to multi-MB. CLIENT-01
owns the byte-cap fix; this audit only notes the missing `bufferBytes`
accessor that `__diagnostics()` would like to read. We work around this by
computing the byte estimate at diagnostics time (sum of `data.length`).

## 3. WebSocket / SSE topology

- **Single primary WebSocket** at `window.app.socket` — readyState/url
  exposed directly on the socket object.
- **Per-search SSE** at `src/public/file-search.js:347` (`new EventSource`)
  — short-lived, one per active search panel, closed on dispose.
- **Single fs-watcher SSE** per panel (`src/public/file-browser.js:1357`
  comment block) — multiplexes per-path subscriptions over one EventSource
  per session to avoid Chromium's 6-EventSource-per-origin cap.

No native browser introspection API counts open EventSources, so
`__diagnostics().sse.streams` is best-effort: it reads observable handles on
`window.app` and the file-browser panel where available, otherwise returns 0.

## 4. Listener tracker

No global listener tracker exists today (no `window.__listenerCount` or
similar). `__diagnostics().dom.listeners_tracked` is therefore omitted (not
emitted as `null`) per the spec's `<if a listener tracker exists, otherwise
omit>` rule.

## 5. Memory introspection

`performance.measureUserAgentSpecificMemory()` requires cross-origin
isolation (COOP+COEP headers) and is Chrome-only. The dev server does not
set those headers today, so the call will reject with `SecurityError` in
most environments. `__diagnostics()` catches and returns `null` for
`.memory` in that case, then falls back to a `navigator.deviceMemory`
snapshot (a coarse GB-resolution device-class hint, not actual usage).

## 6. Risks / non-findings

- No unbounded buffer found on the client side beyond the per-entry size
  question already owned by CLIENT-01.
- `service-worker.js` precaches `app.js` itself, so the new global is
  delivered alongside the existing app code — no precache list change
  needed.
- Function is idempotent (assigning `window.__diagnostics` overwrites);
  page refresh cleanly replaces it.
