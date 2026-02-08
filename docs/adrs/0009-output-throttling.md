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

1. **Adaptive WebSocket compression**: Changed `perMessageDeflate` to reuse the zlib context across messages (`serverNoContextTakeover: false`), skip compression for messages under 1KB (`threshold: 1024`), and keep level 6 for larger payloads.

2. **16ms output coalescing**: Instead of broadcasting each PTY batch immediately, output is accumulated per-session and flushed every 16ms (~60fps). This matches xterm.js's rendering cadence — sending more frequently is wasted since the client cannot render faster.

3. **Pre-serialized messages**: Output is JSON-serialized once per flush, not once per client, eliminating redundant serialization.

4. **Flush-before-exit contract**: All code paths that stop a session or clear the flush timer must flush pending output first. This is encapsulated in `_flushAndClearOutputTimer()`.

5. **Idle session skip**: Sessions with zero connected clients skip the broadcast (output still accumulates in the reconnection buffer).

## Consequences

### Positive

- Typing remains responsive during heavy agent output (~500 sends/sec reduced to ~60)
- CPU usage drops significantly from zlib context reuse and reduced send frequency
- Pre-serialization eliminates O(N) redundant JSON.stringify calls for N clients

### Negative

- Output has up to 16ms added latency (imperceptible — within a single animation frame)
- New client joining mid-coalescing window may see brief duplicated output on reconnect
- Flush-before-exit invariant must be maintained across all session cleanup paths

### Neutral

- The `outputBuffer` for reconnection replay is still populated immediately (not throttled)
- Non-output messages (exit, error, session events) bypass the throttle entirely

## Notes

- The base-bridge layer (`setImmediate` coalescing) handles PTY-level fragment batching. The server-level 16ms throttle handles network-level send frequency. These are complementary concerns at different timescales.
- Backpressure checks (`ws.bufferedAmount`) were considered but deferred — the compression fix and coalescing should eliminate the need. Can be added later if real-world data shows clients falling behind.
