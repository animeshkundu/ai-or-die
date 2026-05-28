# PROC-03 — WebSocket `removeAllListeners` on close (defense-in-depth)

**Lane**: SUP-PROC (process-lifecycle / external dependencies)
**Owner**: SUP-PROC
**Status**: Investigation complete; fix landed in same change-set
**Files**: `src/server.js:2855–2898` (handler attachment), `src/server.js:3828–3847` (`cleanupWebSocketConnection`)
**Test**: `test/longevity/process/ws-listener-cleanup.test.js`
**Date**: 2026-05-27

## Symptom (latent)

`handleWebSocketConnection` attaches three event listeners on each
WebSocket — `message`, `close`, `error` — via `ws.on(...)`. The cleanup
path in `cleanupWebSocketConnection` (line 3828) removes the wsInfo from
`webSocketConnections` and dissociates the WS from any joined Claude
session, but it **never explicitly detaches the three listeners**. The
code relies on the closed WebSocket being garbage-collected once the
last reference (the Map entry) is dropped.

In practice this is fine today — `ws` (the Node `ws` library) emits
`close` exactly once per socket, and the runtime drops the underlying TCP
handle before our `close` handler runs. There is no observed leak on
master. **The risk is latent**:

1. **Stale callback execution.** If any future code path adds a
   `setImmediate` / `process.nextTick` send into the `close` callback
   before the Map entry is dropped, an in-flight delayed `message` (e.g.
   one queued behind a heavy `JSON.parse`, then surfacing after close)
   can still execute. With `removeAllListeners` after delete, those
   delayed callbacks are guaranteed to be inert.
2. **Defensive symmetry with PTY teardown.** `base-bridge.js` uses an
   explicit `_ptyDisposables` drain on every PTY exit path (lines
   251–378, 498–565). The WS lifecycle should mirror that pattern — own
   the listeners explicitly, drop them explicitly. The PR #99 fs-watch
   leak (now fixed in `_cleanupFsWatchSession`) is the same shape: a
   listener / handle owned but not centrally drained on the close path.
3. **Future-proofing against handler-list churn.** If a downstream
   change adds a fourth or fifth `ws.on(...)` (e.g. `ws.on('ping', ...)`
   for granular liveness, or `ws.on('upgrade', ...)`), it inherits the
   teardown automatically. The current code requires every new listener
   to remember to teardown — and the audit grep confirms no central
   teardown exists today.
4. **GC pressure under reconnect storm.** Under a sustained
   reconnect-storm workload (SUP-SOAK SOAK-02 workload #2: 50 tabs ×
   1Hz connect/disconnect = 50 WS objects/sec entering the GC root set
   via their listener closures, even after the Map entry is dropped),
   the listener-closure graph can keep the underlying `ws` object alive
   one extra GC cycle longer than necessary. Order-of-magnitude small;
   measurable on a 4h soak.

None of these are bug-class today. All four become real if the codebase
moves, which it will over a months-long campaign.

## Repro

`test/longevity/process/ws-listener-cleanup.test.js` instantiates a real
`ClaudeCodeWebServer` on a random port > 11000, opens a real WebSocket
client, lets `handleWebSocketConnection` attach the three production
listeners, and asserts:

- **Pre-cleanup**: `listenerCount('message') ≥ 1`,
  `listenerCount('close') ≥ 1`, `listenerCount('error') ≥ 1`.
- **Post-cleanup** (after directly calling
  `server.cleanupWebSocketConnection(wsId)`):
  `listenerCount('message') === 0`,
  `listenerCount('close') === 0`,
  `listenerCount('error') === 0`.

On `main` HEAD the post-cleanup assertions fail (the listeners persist
until the underlying `ws` is GC'd). With the fix below they pass.

## Fix

Add a single line to `cleanupWebSocketConnection`:

```js
cleanupWebSocketConnection(wsId) {
  const wsInfo = this.webSocketConnections.get(wsId);
  if (!wsInfo) return;

  // Remove from Claude session if joined
  if (wsInfo.claudeSessionId) {
    // … (unchanged) …
  }

  // Defense-in-depth: drop our handlers explicitly so any delayed
  // message/close/error callback that fires after the Map entry is
  // dropped cannot re-enter handleMessage on a half-torn-down WS.
  // Mirrors the explicit teardown pattern used by _ptyDisposables
  // (base-bridge.js) and _cleanupFsWatchSession (server.js).
  try { wsInfo.ws.removeAllListeners(); } catch (_) { /* never throw from cleanup */ }

  this.webSocketConnections.delete(wsId);
}
```

The `try` block is defensive: if `wsInfo.ws` was already nulled (e.g. by
a future code path that calls cleanup twice), `removeAllListeners`
throws `TypeError`. Cleanup must never throw — it runs from inside `ws.on('close')`
and `ws.on('error')` callbacks where a throw would abort the rest of the
teardown.

### Why not `ws.off('message', handler)` etc.?

The original handlers are anonymous closures attached inline in
`handleWebSocketConnection`. Capturing references just to off them later
would require storing four function references on wsInfo, which adds
state for no gain. `removeAllListeners()` on a soon-to-be-discarded
socket is correct and idiomatic. We own the socket; nobody else attaches
listeners to it.

### Edge cases

- **`ws` library internal listeners**: the `ws` library does add its own
  internal listeners on the underlying TCP socket (not on the WS object
  itself). `removeAllListeners` on the WebSocket instance only removes
  what we attached — it does not interfere with the library's internal
  TCP-socket bookkeeping. Verified by reading
  `node_modules/ws/lib/websocket.js`: WebSocket extends EventEmitter and
  manages its underlying `_socket` separately; our `removeAllListeners`
  only touches the user-facing events.
- **Double cleanup**: `cleanupWebSocketConnection` is called from both
  `ws.on('close')` and `ws.on('error')`. After the first call deletes
  the Map entry, the second call returns early on `!wsInfo` — the
  `removeAllListeners` line is never reached twice. Safe.
- **Cleanup during teardown ordering**: `removeAllListeners` is called
  AFTER the session dissociation but BEFORE the Map delete. The order
  doesn't matter for correctness (the listeners cannot fire again
  meaningfully on a closed WS), but the chosen order matches the
  intuitive read: "do your work, then drop the references."

## Risks of the fix

Functionally zero. `removeAllListeners` is idempotent, throws only on
non-EventEmitter inputs (caught), and has no side effects beyond
clearing internal arrays. The change is six characters of added
behaviour (one method call); regression surface is minimal.

## Impact on diagnostics

`_collectDiagnostics` (`src/server.js:3791–3826`) reports
`process.active_handles` and `sessions.ws_connections`. Neither should
change measurably from this fix in steady state — but under a
reconnect-storm soak (SOAK-02 workload #2), `active_handles` should
return to baseline strictly faster after disconnect because the listener
closures no longer pin GC roots through to the next cycle. SUP-SOAK will
confirm.

## References

- `src/server.js:2855–2898` — `handleWebSocketConnection` listener attachment
- `src/server.js:3828–3847` — `cleanupWebSocketConnection` (target of the fix)
- `src/base-bridge.js:251–378` — `_ptyDisposables` pattern (model for explicit listener ownership)
- `src/server.js:3716–3746` — `_cleanupFsWatchSession` (model for centralized resource teardown)
- `test/longevity/process/ws-listener-cleanup.test.js` — regression test
