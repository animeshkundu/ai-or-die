# ADR-0009: Output Throttling via Coalesced Broadcasting

## Status

**Accepted**

## Date

2026-02-07

## Context

When an AI agent (Claude, Gemini, etc.) generates heavy terminal output, the server broadcasts every PTY output batch immediately to all connected clients via `ws.send(JSON.stringify(...))`. During active code generation, this can mean hundreds of WebSocket sends per second per client.

Combined with `perMessageDeflate` using `serverNoContextTakeover: true` (which created/destroyed a zlib context on every message), this saturated the Node.js event loop. User input messages (keystrokes) queued behind output broadcasts, causing typing to become very slow during active agent output.

Through a DevTunnel, the problem was amplified by added per-send latency.

## Decision

We introduce coalesced output broadcasting at the server level:

1. **Adaptive WebSocket compression**: Changed `perMessageDeflate` to reuse the zlib context across messages (`serverNoContextTakeover: false`), skip compression for messages under 1KB (`threshold: 1024`), and use level 1 for larger payloads. Level 1 is ~5-10x faster than level 6 with only ~10-20% larger frames — for ephemeral terminal output consumed once, speed matters far more than compression ratio. This also frees the 4-worker Node.js thread pool for incoming message decompression.

2. **16ms output coalescing**: Instead of broadcasting each PTY batch immediately, output is accumulated per-session and flushed every 16ms (~60fps). This matches xterm.js's rendering cadence — sending more frequently is wasted since the client cannot render faster.

3. **Pre-serialized messages**: Output is JSON-serialized once per flush, not once per client, eliminating redundant serialization.

4. **Flush-before-exit contract**: All code paths that stop a session or clear the flush timer must flush pending output first. This is encapsulated in `_flushAndClearOutputTimer()`.

5. **Idle session skip**: Sessions with zero connected clients skip the broadcast (output still accumulates in the reconnection buffer).

6. **Backpressure via `ws.bufferedAmount`**: Before sending to each client, the server checks the WebSocket's buffered amount. Clients with >256KB of unsent data are skipped — the output remains in `outputBuffer` for replay on reconnection. This prevents slow clients (e.g., via DevTunnel) from accumulating unbounded send buffers.

7. **Max coalesce size cap (32KB)**: When accumulated pending output exceeds 32KB, the server flushes immediately rather than waiting for the 16ms timer. This bounds the maximum event loop blocking time per flush and provides natural yield points for input processing during heavy output.

8. **Fire-and-forget input handling**: The `await` on `inputBridge.sendInput()` in the WebSocket message handler was removed. Input writes are still serialized via the per-session `writeQueue` promise chain in `sendInput`, but the message handler no longer suspends waiting for the PTY write to complete. This ensures the next incoming WebSocket message (e.g., the next keystroke) can be processed immediately.

## Consequences

### Positive

- Typing remains responsive during heavy agent output (~500 sends/sec reduced to ~60)
- Fire-and-forget input unblocks the message handler, eliminating keystroke serialization delays
- CPU usage drops significantly from zlib context reuse, reduced send frequency, and compression level 1
- Pre-serialization eliminates O(N) redundant JSON.stringify calls for N clients
- Backpressure prevents memory growth from slow clients
- Max coalesce cap bounds worst-case event loop blocking

### Negative

- Output has up to 16ms added latency (imperceptible — within a single animation frame)
- New client joining mid-coalescing window may see brief duplicated output on reconnect
- Flush-before-exit invariant must be maintained across all session cleanup paths
- Fire-and-forget input loses error feedback to the client when `sendInput` fails (mitigated by pre-checks and `.catch()` logging)
- Backpressure skip means slow clients may miss some output during heavy streaming (data is in outputBuffer for replay)

### Neutral

- The `outputBuffer` for reconnection replay is still populated immediately (not throttled)
- Non-output messages (exit, error, session events) bypass the throttle entirely

## Notes

- The base-bridge layer (`setImmediate` coalescing) handles PTY-level fragment batching. The server-level 16ms throttle handles network-level send frequency. These are complementary concerns at different timescales.
- Backpressure via `ws.bufferedAmount` is now implemented. Note from the `ws` library: `bufferedAmount` can be 0 on fast networks (localhost) since data writes synchronously. For DevTunnel/remote clients where backpressure matters most, it works correctly.
- The `session.writeQueue` promise chain in `sendInput` is the sole mechanism for write ordering — it works identically whether the caller `await`s or not, because the queue chaining is synchronous.
