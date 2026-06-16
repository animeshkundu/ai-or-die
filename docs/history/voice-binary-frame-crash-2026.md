# Voice recording crashes the page after ~25-45 s (2026-06)

## Symptom

Recording with the mic crashed the page after ~30-45 s of speech: it showed the
"Disconnected — refresh the page" banner and the session had to be re-established.
Short recordings were fine.

## Root cause

Local-mode audio was buffered in the browser during recording and sent as **one
base64-JSON `voice_upload` WebSocket frame on stop** (not streamed). The server
rejects any frame over `MAX_WS_MESSAGE_BYTES = 1 MiB` (`src/server.js`, the HOT-08
guard) with `ws.close(1009)` **before** `JSON.parse`.

base64 inflates 16 kHz / 16-bit / mono PCM by 33%:

```
32,000 raw bytes/s × 4/3 (base64) ≈ 42,667 bytes/s on the wire
1,048,576 / 42,667 ≈ 24.6 s
```

So any clip longer than ~24.6 s produced an over-1 MiB frame on stop -> `1009`.
The "30-45 s" the user reported was just the loose clip length; the crash fired
the instant they stopped.

Two things made it worse and hid it:

1. A server-initiated `close(1009)` is a **clean** close, so the browser sets
   `CloseEvent.wasClean === true`. The client `onclose` only branched on
   `!event.wasClean`, so it **skipped reconnect** and dead-ended on
   "refresh the page" — an immediate dead-end on the first `1009`.
2. The server voice handler and client both advertised a **120 s** cap, but the
   1 MiB wire guard made anything past ~24.6 s unreachable. The existing oversized
   test used a 120 s clip "to be obviously over" and never noticed a normal ~25 s
   recording also crossed the line.

A secondary, *unconfirmed-but-plausible* path was identified and guarded: the
client heartbeat pong-timeout (25 s ping + 10 s window) fires on the **client**
main thread, and capture is not fully off-thread (the ScriptProcessor fallback is
main-thread). A long recording under main-thread pressure could miss a pong ->
`close(4000)` mid-recording. The close code is now logged to distinguish it.

## Fix

Switched the local-mode transport to a single **binary** WebSocket frame
(`"VUP1"` + version + type + raw Int16 PCM), routed past the 1 MiB JSON guard to a
dedicated `MAX_VOICE_BINARY_FRAME_BYTES` bound (oversize -> 1009, bad header ->
1003). The base64 `voice_upload` handler is kept as a thin shim over a shared
`_processVoicePcm` core. See ADR-0026 for the full decision and the robustness
changes (onclose code handling, heartbeat pause during recording, worker-side
int16->float32 conversion, session-scoped rate limit, send-on-closed-socket
fail-fast). 

## How it was found

A review across security, cross-platform, protocol, browser-audio, and QA
dimensions over the *plan*:

- The browser-audio review caught that the heartbeat theory was wrongly declared
  "refuted" and that capture is partly main-thread.
- The protocol review established the `wasClean === true` dead-end (the original
  analysis assumed it fell into the reconnect path).
- The QA review caught that STT is force-disabled under test
  (`server.js` `underTest`), so success-path tests would false-green without a
  ready-stub injection seam (`server.sttEngine` is reassigned in tests).
- The cross-platform review flagged the ws `Buffer[]` fragmented-frame path as
  the one genuine platform risk, now covered by a unit test.

## Tests

- `test/voice-frame.test.js` — pure units: client `buildVoiceFrame`,
  `classifyVoiceClose`; server `normalizeBinaryMessage`/`classifyVoiceFrame`
  (incl. the `Buffer[]` fragmented case); `pcm16ToFloat32`.
- `test/voice-binary.test.js` — integration: a ~30 s binary frame transcribes and
  the socket stays open (the case that crashed); oversize -> 1009; bad/short
  header -> 1003; zero-PCM -> "too short" (open); odd-length -> "invalid" (open);
  binary-path rate limit.
- Regression kept green: `test/voice-integration.test.js` (base64 shim paths),
  `test/longevity/event-loop/hot-03-ws-frame-size.test.js` (text 1 MiB guard),
  `test/heartbeat-watchdog.test.js`.
