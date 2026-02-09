# ADR-0011: WebSocket I/O Performance Optimizations

## Status

**Accepted**

## Date

2026-02-09

## Context

ADR-0009 introduced output coalescing (16ms windows), backpressure, and fire-and-forget input to address event loop saturation during heavy agent output. These changes reduced WebSocket sends from ~500/sec to ~60/sec and made typing responsive.

However, a controlled POC (`poc/ws-perf/`) revealed further bottlenecks under sustained heavy output (~625KB/sec), particularly over high-latency links (DevTunnel, 120-200ms RTT with jitter and spikes):

1. The output history buffer uses `Array.shift()`, which is O(n) per eviction at 1000 entries with 60 evictions/sec.
2. Keystroke processing competes with output flush timers in the event loop with no priority differentiation.
3. JSON serialization of ANSI-rich terminal output inflates payload size by 10-50% (escape sequences like `\x1b` become `\u001b` in JSON).
4. The client-side PlanDetector performs a full-buffer join + ANSI-strip + regex scan (~50KB) on every output chunk (~60/sec), causing frame drops and input lag.

The POC tested each optimization individually and in combination across multiple simulated network conditions (localhost, regional 40ms RTT, DevTunnel 120ms+jitter, DevTunnel-bad 200ms+spikes). The winning combination achieved significant improvements in server processing time and total round-trip latency.

## Decision

We implement four optimizations (building on ADR-0009's foundation):

### B. Circular buffer for output history

Replace the `outputBuffer` array with a fixed-capacity `CircularBuffer` (`src/utils/circular-buffer.js`) providing O(1) `push()` and O(k) `slice(-k)`. The buffer implements `.toJSON()` and `[Symbol.iterator]` for transparent JSON serialization and iteration. `SessionStore` is updated to handle both CircularBuffer instances (via duck-typed `.slice()`) and plain arrays (for backward compatibility with existing session files).

### C. Input priority scheduling

Dispatch input messages (`type: 'input'`) via `process.nextTick()` so they run before output-related timers (`setTimeout`, `setImmediate`) in the event loop. The MAX_COALESCE_BYTES immediate flush is deferred to `setImmediate()` (instead of synchronous) to yield to pending input. This creates a clear priority hierarchy: `nextTick (input) > setImmediate (deferred flush) > setTimeout (coalesce timer)`.

### D. Binary WebSocket frames for terminal output

Terminal output is sent as raw UTF-8 binary frames (`Buffer.from(pending, 'utf-8')`) with `{ compress: false }` instead of JSON-wrapped text frames. Control messages (session events, errors, exit codes) remain JSON text frames. The client distinguishes frame types by checking `event.data instanceof ArrayBuffer` (with `socket.binaryType = 'arraybuffer'`). Compression is explicitly disabled for binary output frames to avoid zlib thread pool contention under heavy load (identified as a performance regression in the POC when binary + perMessageDeflate were combined).

### E. Plan detector trigger-scan

The PlanDetector checks only the new output chunk (plus a 64-character overlap window from the previous chunk) for trigger keywords before performing the expensive full-buffer scan. The full scan only runs when a trigger is found in the new data, reducing per-chunk cost from O(n) to O(k) on the fast path (~99% of chunks).

### Not implemented: TCP_NODELAY (A)

Explicitly setting `socket.setNoDelay(true)` was found to be redundant — the `ws` library already calls `setNoDelay()` during WebSocket setup. Additionally, DevTunnel terminates TCP connections at the relay, so server-side Nagle settings do not propagate end-to-end.

## Consequences

### Positive

- Output history operations reduced from O(n) to O(1) per push
- Keystrokes jump ahead of output flushes in the event loop under load
- Terminal output bandwidth reduced by 10-50% (no JSON escaping of ANSI sequences)
- PlanDetector CPU usage reduced by >95% on the fast path (no triggers in chunk)
- Binary frames bypass zlib compression entirely, avoiding thread pool contention

### Negative

- Binary output frames are not human-readable in browser DevTools network panel (use binary decode view)
- CircularBuffer is a new internal class to maintain (80 lines)
- `process.nextTick` input priority could theoretically starve I/O under extreme input flood (not realistic for terminal input rates; bounded by WebSocket TCP flow control)
- Disabling compression for binary output increases bandwidth vs. compressed JSON; mitigated by eliminating JSON escaping overhead
- PlanDetector trigger-scan has a theoretical chunk-boundary split risk, mitigated by the 64-character overlap window

### Neutral

- ADR-0009's coalescing, backpressure, and fire-and-forget patterns are unchanged
- Session persistence format is unchanged (CircularBuffer serializes to the same JSON array via `.toJSON()`)
- The WebSocket protocol is now mixed-mode: binary frames for output, text frames for control
- Test helpers updated to skip binary frames when parsing JSON control messages

## Notes

- The 16ms coalescing window (ADR-0009) remains the fundamental output batching mechanism. These optimizations reduce per-flush cost, not flush frequency.
- Worker threads (optimization F in the POC) showed less benefit than B+C+D+E combined and carry COM threading risk on Windows. Deferred pending multi-session isolation needs.
- The event loop priority hierarchy is: `process.nextTick` (input) > `setImmediate` (deferred output flush) > `setTimeout` (coalescing timer).
