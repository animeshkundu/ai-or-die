# ADR-0047: Client output frame batching

## Status

Accepted (2026-08-04).

## Context

The server already coalesces burst output effectively. WebKit can still deliver sustained output as many small WebSocket frames. Per-frame activity tracking, plan detection, and snapshot scheduling amplified that delivery pattern on the browser main thread.

## Decision

The WebSocket binary handler only queues bytes and schedules one animation-frame flush. Each flush writes at most 96 KiB, decodes once with a streaming `TextDecoder`, and performs activity, plan, and snapshot bookkeeping once for that batch.

Server coalescing, binary framing, flow control, and protocol messages are unchanged.

If a backgrounded page accumulates more than 1 MiB because animation frames are suspended, a visibility-scoped watchdog uses the existing flow-control pause message. Because the server intentionally skips paused connections while retaining recent output in the bounded session replay buffer, resume performs an authoritative same-session rejoin after preserving scroll and selection. The animation-frame drain resumes below 128 KiB. Recovery is bounded by the server's retained replay window; longer suspensions can retain only that window and must be reported honestly. Plan-detection staging is independently flushed at 256 KiB so continuous output cannot defer its idle timer indefinitely.

The client retains a bounded raw-text tail for diagnostics and reconnect checks.
On a same-session reconnect, the server replay is authoritative; the client
resets and replays it instead of guessing an overlap from terminal content.

## Consequences

Small inbound frames have constant scheduling overhead per rendered frame rather than per WebSocket event. UTF-8 decoder state is preserved across both network and animation-frame boundaries.
