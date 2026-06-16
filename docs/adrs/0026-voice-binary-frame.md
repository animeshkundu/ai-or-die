# 0026 - Voice upload: binary WebSocket frame

## Status

Accepted (2026-06). Supersedes the base64-in-JSON `voice_upload` transport
described in `docs/specs/voice-input.md` (the base64 path is kept as a thin
back-compat shim, not removed).

## Context

Local-mode voice audio was buffered in the browser during recording and sent as
one **base64-JSON** `voice_upload` WebSocket frame on stop. The server enforces a
deliberate application-layer guard `MAX_WS_MESSAGE_BYTES = 1 MiB`
(`src/server.js`, HOT-08) that rejects any frame over 1 MiB **before** `JSON.parse`
with `ws.close(1009)` — a defense against a client stalling the event loop with
large/rapid frames.

base64 inflates 16 kHz / 16-bit / mono PCM by 33% (32 KB/s -> ~42.7 KB/s on the
wire), so a recording crossed 1 MiB at **~24.6 s**. Any clip longer than that
produced an over-1 MiB frame on stop -> `1009`. Because a server-initiated
`close(1009)` is a *clean* close (`CloseEvent.wasClean === true`), the client's
`onclose` skipped the reconnect branch and dead-ended on "Disconnected — refresh
the page". Net effect: recording for ~30-45 s crashed the page.

A masked inconsistency hid this: the server handler and client both advertise a
120 s cap, but the 1 MiB wire guard made anything past ~24.6 s unreachable.

A review across security, cross-platform, protocol, browser-audio, and QA
dimensions evaluated the options:

- **Raise the global 1 MiB guard** — rejected: weakens the event-loop-DoS
  protection for *all* frame types.
- **Chunked JSON upload** — viable but adds per-session reassembly state (cap +
  TTL + cleanup) and keeps the base64 inflation.
- **Binary WebSocket frame** — chosen: removes the base64 inflation, adds no
  server reassembly state, and leaves the 1 MiB JSON guard fully intact for text
  frames. Binary frames are already an established server->client convention
  (terminal output); this adds the reverse direction.

## Decision

Send local-mode audio as a single **binary** WebSocket frame:

```
[ "VUP1" (4) ][ version=1 (1) ][ type=0x01 PCM (1) ][ raw Int16 native-endian PCM @16kHz mono ]
```

- The server dispatcher (`ws.on('message', (message, isBinary))`) branches on
  `isBinary` **before** the 1 MiB JSON guard. The text/JSON path is unchanged
  (HOT-08 protection preserved).
- Binary frames are bounded by `MAX_VOICE_BINARY_FRAME_BYTES = 6 + 3,840,000`:
  oversize -> `message_too_large` + `close(1009)` (same as the text guard — never
  an unbounded error-reply loop, which would reopen the DoS hole); a bad/short/
  unknown header -> `close(1003)`. Framing + the `Buffer[]` fragmented-frame
  normalize live in pure, unit-tested `src/utils/ws-voice-frame.js`.
- A versioned/typed header (not a bare magic) lets future inbound-binary features
  claim their own type byte instead of forcing a wire break.
- The int16->float32 conversion is deferred to the STT **worker thread**
  (`sttEngine.transcribePcm16`, `src/utils/pcm.js`) so the event loop never runs
  the ~1.9 M-sample loop for a 120 s clip.
- Voice rate-limit state moves onto the session object (`_voiceUploadTimestamps`,
  mirroring image uploads) so it shares the session lifetime and correctly
  survives WS reconnects (resetting it on disconnect would let a client evade the
  limit). It is checked **before** the readiness gate.
- The legacy base64 `voice_upload` JSON handler is kept as a thin shim over the
  shared validation/transcribe core (the `'Missing audio data'` guard stays in
  the shim; binary has no `data.audio`).

Client robustness shipped alongside (the same review surfaced these):

- `onclose` branches on `event.code`: `1009`/`1003` (clean server rejections)
  show a specific toast and reconnect (bounded) instead of dead-ending; a close
  mid-transcription clears the mic spinner/timeout; the close code is logged so
  field data can distinguish `1009` (at stop) from `4000` (pong-timeout).
- The heartbeat **pong-timeout is suspended while recording** (`HeartbeatWatchdog.pause()`/
  `resume()`): the capture thread (esp. the ScriptProcessor fallback) can briefly
  miss a pong, which would otherwise force a spurious `close(4000)` mid-recording.
- `sendBinary` returns whether the socket was OPEN; a send on a closed socket
  fails fast (toast) instead of silently dropping and hanging the 90 s spinner.
- A new recording is refused while a transcription is still pending; a zero-sample
  recording is dropped client-side.

## Consequences

- Long recordings (up to the 120 s cap) work; the ~24.6 s crash cliff is gone.
- Two transports exist (binary + the base64 shim). The shim is dead weight once
  no client emits it; a future ADR may remove it.
- Inbound binary is now meaningful to the server. The 4-byte magic + version/type
  header namespaces it; a non-voice inbound-binary feature must add a new type.
- PCM is shipped in the browser's native endianness (unchanged from the base64
  path; little-endian on every supported target). A hypothetical big-endian client
  would need explicit LE framing — not a concern for browsers.
- **Deferred (documented, not in this change):** pre-existing tab-misrouting
  (voice exits the main socket; the server routes by `wsInfo.claudeSessionId`,
  which swaps on tab-switch) and a per-IP WebSocket connection-rate limit (the
  real backstop for a connect->bad-frame->reconnect loop, since `reconnectAttempts`
  resets on `onopen`).

## References

- Spec: `docs/specs/voice-input.md`
- History: `docs/history/voice-binary-frame-crash-2026.md`
- HOT-08 frame guard: `docs/audits/hot-03-ws-frame-size.md`
- Tests: `test/voice-frame.test.js`, `test/voice-binary.test.js`
