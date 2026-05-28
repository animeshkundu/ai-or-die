# HOT-03 — WebSocket binary frame parse without size guard

**Lane**: SUP-HOT (event-loop hot paths)
**Owner**: SUP-HOT
**Status**: Investigation complete; fix deferred to HOT-08 (post-baseline)
**Files**: `src/server.js:2855–2884`, `src/server.js:2800–2806` (`maxPayload`)
**Date**: 2026-05-27

## Symptom

The WebSocket message handler at `src/server.js:2855–2884` does
`JSON.parse(message)` on every incoming frame with no application-level
size check:

```js
ws.on('message', (message) => {
  try {
    const data = JSON.parse(message);  // ← unbounded synchronous parse
    if (data.type === 'input') {
      process.nextTick(() => { this.handleMessage(...); });
    } else {
      this.handleMessage(wsId, data).catch(...);
    }
  } catch (error) {
    ...
  }
});
```

The `ws` library's `maxPayload: 8 * 1024 * 1024` (`server.js:2802`) caps
incoming frame size at 8 MB at the protocol layer, but any frame up to
that 8 MB cap reaches our handler. `JSON.parse` of an 8 MB string blocks
V8 for 40–120 ms depending on payload shape (deep object trees are worse
than flat strings). Express's `express.json()` 100 KB default
(`server.js:638`) and the per-endpoint `'10mb'` cap on `/api/files/upload`
(`server.js:2529`) do NOT apply to WebSocket traffic — those are HTTP-only
middlewares.

The single 256 KB defensive cap inside `handleMessage`
(`server.js:2946–2948`) is post-`JSON.parse` and applies only to the
`data.data` string for `type === 'input'` messages — it does NOT bound
the total parse cost or other message types' payloads.

## Why this is a longevity problem

A single buggy or malicious client can repeatedly send 8 MB binary
frames at ~10 Hz, sustaining 400 ms+ of event-loop block per second on
the server. Symptoms:

- Heartbeat pongs from other tabs miss the 10 s pong window (set at
  `app.js:HEARTBEAT_WATCHDOG`); the watchdog force-closes those
  unrelated sockets at code 4000 ("pong-timeout").
- File-browser SSE streams stutter; OSC 7 broadcasts queue.
- HTTP responses (`/api/diagnostics`, `/api/sessions`) latency spikes
  the same as PTY output queues.
- The supervisor's circuit-breaker (3 crashes in 30 s in
  `bin/supervisor.js:11–13`) does NOT trip because the server doesn't
  crash — it's just unresponsive.

The threat model is "single user runs for months with a misbehaving tab
plugin / extension / dev-tools script accidentally flooding WS" — not
adversarial attack, but exactly the kind of slow burn this campaign is
designed to catch.

## Repro

`test/longevity/event-loop/hot-03-ws-frame-size.test.js`:

1. Boot the production `ClaudeCodeWebServer` on a random port >11000
   with `noAuth: true`.
2. Connect a `ws` client.
3. Send a 5 MB JSON message: `{"type":"input","data":"<5 MB ASCII>"}`.
4. Send a follow-up small `{"type":"ping"}` frame and measure RTT.

Observed on main:
- The 5 MB frame is parsed (no size guard).
- No server-side `error` response with a `message_too_large` code is
  emitted (because no such guard exists).
- During parse (40–120 ms wall on a 5 MB payload), the event loop is
  blocked; any concurrent client traffic queues.

The test asserts:
1. Within 2 s of sending the oversize frame, the server responds with
   a frame matching `{type: 'error', code: 'message_too_large'}`
   (or equivalent marker — the fix must commit to a specific code so
   the test stays meaningful).
2. The connection remains in a usable state OR is closed with a
   specific WS close code (TBD by the fix; either is acceptable).

Both assertions fail on main as required.

## Impact (production)

- 8 MB frame parse: ~40–120 ms event-loop block per frame
  (V8 internal benchmarks; varies with payload shape).
- At 10 Hz sustained: 400 ms–1.2 s of blocked event loop per real-time
  second — daemon stays alive but is effectively unresponsive.
- Pong-timeout cascade: other tabs' heartbeats miss the 10 s window
  → force-closed at WS close 4000 → client reconnects → repeat.
- Memory: each parse allocates ~`8 MB × 3` (raw buffer → string → parsed
  object) transiently; sustained 8 MB/s parse rate puts ~24 MB/s on the
  GC. Heap doesn't *leak* (parses are freed) but GC pause adds to the
  event-loop block.

## Proposed fix outline (HOT-08)

Add a `MAX_WS_MESSAGE_BYTES` constant at module scope and gate
`JSON.parse` behind a size check inside the `ws.on('message', ...)`
closure. **Sized at 1 MB** to match the only legitimate large-WS-frame
flow in the codebase today (paste-image goes through HTTP
`/api/files/upload` at 10 MB, NOT through WS — confirm this with one
final review of `app.js` paste handlers before finalizing the limit).

Sketch:

```js
const MAX_WS_MESSAGE_BYTES = 1 * 1024 * 1024; // 1 MB
...
ws.on('message', (message) => {
  // 'message' is a Buffer (binary frame) or string (text frame). Both
  // have a byte length — Buffer.byteLength handles both.
  const byteLen = Buffer.byteLength(message);
  if (byteLen > MAX_WS_MESSAGE_BYTES) {
    this.sendToWebSocket(ws, {
      type: 'error',
      code: 'message_too_large',
      message: `WebSocket message exceeds ${MAX_WS_MESSAGE_BYTES} bytes`,
      received_bytes: byteLen,
    });
    // Decision point: drop the connection (defensive) vs drop the
    // message (resilient). Recommendation: drop the connection (close
    // code 1009, "message too big") on the FIRST violation — the client
    // is either buggy or hostile, neither merits keeping the socket open.
    try { ws.close(1009, 'message_too_large'); } catch (_) {}
    return;
  }
  try {
    const data = JSON.parse(message);
    ...
```

### Also lower the ws library's `maxPayload`

The protocol-layer cap is currently 8 MB. After adding the
application-layer 1 MB guard, the ws library's `maxPayload` can stay at
8 MB for headroom (or drop to 2 MB as defense-in-depth). NOT load-bearing
— the application guard runs first regardless.

### Update the diagnostics extension

When `_collectDiagnostics()` is extended for SUP-SOAK's longevity
metrics, include a `ws.oversized_message_drops` counter so we can spot
abusive clients in long-running soaks.

## Risks of the fix

1. **Legitimate large-frame use case missed.** If a future feature
   sends real >1 MB payloads over WS (e.g. a future "stream uploaded
   audio over WS" path), the guard breaks it. Mitigation: the response
   error code is specific (`message_too_large`), so the legitimate
   sender knows to either chunk or switch to HTTP.
2. **Mid-frame close**. `ws.close(1009, ...)` after a `send` may race;
   the client may not see the error frame before connection drop.
   Acceptable — the client just sees a 1009 close and a generic
   reconnect path engages.
3. **`Buffer.byteLength(string)` cost for text frames**. Negligible
   (~O(n) byte-counting); strictly less than `JSON.parse`.

## Out of scope

- Per-client rate limiting on message frequency (oversized OR
  legitimate). Already partly addressed by `_perIpRateLimit` for
  specific endpoints; extending to WS is a separate concern.
- Streaming JSON parser (allows partial-frame processing). Not needed —
  the goal is to REJECT oversized frames, not parse them faster.

## References

- `src/server.js:2855–2884` — WS message handler (the bug site)
- `src/server.js:2800–2806` — `maxPayload: 8 * 1024 * 1024`
- `src/server.js:2946–2948` — post-parse 256 KB defensive cap on
  `data.data` (insufficient by itself)
- `src/server.js:638` — `express.json()` default 100 KB (HTTP only)
- `src/server.js:2529` — `/api/files/upload` 10 MB (HTTP only)
- `test/longevity/event-loop/hot-03-ws-frame-size.test.js` —
  regression test
