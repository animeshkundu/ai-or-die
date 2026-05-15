# Instant WebSocket Reconnect

**Date:** 2026-05-10
**Files:** `src/public/app.js`, `src/public/splits.js`, `src/public/heartbeat-watchdog.js` (new), `src/public/index.html`
**Tests:** `test/heartbeat-watchdog.test.js`
**Spec:** `docs/specs/client-app.md` § "Reconnection & Liveness"

## Problem

When the browser tab returned from background or the network blipped and came back, reconnection took multiple seconds — often 30+ on cellular. The terminal sat frozen and users couldn't tell if the app was still working.

## Two root causes

1. **Slow dead-socket detection.** The client sent a `ping` every 30s but never checked if `pong` came back. A silently-killed connection (NAT rebind, mobile sleep, captive portal) was only discovered when the browser eventually fired `onclose` — often 30+ seconds later on mobile. The pong was just acked and ignored.
2. **Built-in artificial delays.** `reconnect()` waited a hard-coded 1000ms before even attempting `connect()`, AND `onclose` scheduled a 700–1300ms backoff before calling `reconnect()`. Even a clean reconnect on the first attempt ate ~1.7s of dead air.

Plus three pre-existing latent bugs surfaced during exploration:
- No `pageshow` handler — bfcache restores (mobile back/forward) missed reconnect entirely.
- `startHeartbeat()` was called once at init only; `disconnect()` cleared the timer; `reconnect()` never re-armed it. **The heartbeat died after the first reconnect.**
- Splits had no auto-reconnect — they went dead after any drop.

## Solution

Five surgical, additive changes. No new dependencies. No protocol/server changes.

1. **Pong-timeout watchdog** (`heartbeat-watchdog.js`): 25s ping interval, 10s pong window, force-close socket on miss. The 10s window is generous on purpose — cellular/train Wi-Fi routinely has 6–8s latency spikes without dropping the TCP connection (Discord uses ~10s for the same reason).
2. **Restart heartbeat in `socket.onopen`** (top of handler, before any awaited work) — fixes the existing bug where heartbeat died after the first reconnect.
3. **Eliminate the 1000ms fixed wait in `reconnect()`** and reduce first-attempt `onclose` backoff to 250ms. Subsequent attempts keep the existing exponential-with-jitter formula.
4. **`pageshow` handler** (bfcache restore) and on `visibilitychange→visible` with OPEN socket: restart the heartbeat so a ping fires immediately. Liveness validated within ~10s instead of up to 25s.
5. **Splits get their own watchdog** with the same parameters and the same auto-reconnect pattern as the main pane. A `_closing` flag distinguishes user-initiated close from drop.

## Per-socket fencing — the subtle bug we caught in review

`clearInterval()` and `clearTimeout()` do NOT cancel an already-queued callback that has been pulled off the timer queue but not yet invoked. Without a guard, a leftover heartbeat tick or pong-timer from an old socket can call `socket.close()` on the freshly-opened new socket, causing immediate disconnect-on-reconnect.

Fix: `_socketGeneration` is incremented in `connect()` before `new WebSocket(...)`. Each handler closure (`onopen`, `onmessage`, `onclose`, `onerror`) and each watchdog callback captures `(ws, gen)` at construction time and bails if those no longer match `this.socket` / `this._socketGeneration`. The `HeartbeatWatchdog` class takes `currentGeneration` and `currentSocket` accessor closures so it can fence its own ticks the same way.

## A second race we caught in code review (post-implementation)

After implementation, gemini-3.1-pro-preview's code review caught a related race that the in-handler fence did NOT cover: the `setTimeout(reconnect, delay)` scheduled inside `onclose` itself. Sequence:

1. Transient error closes the socket. `ws.onclose` schedules `setTimeout(() => this.reconnect(), 2000)`.
2. T+500ms — user calls `setSession(newId)`, which calls `disconnect()` then `connect()`. `connect()` increments `_socketGeneration` and opens a new socket.
3. T+2000ms — the original timer fires. The `_reconnecting` guard is no longer set (connect resolved), so `reconnect()` proceeds, increments `_socketGeneration` AGAIN, and opens a third socket — orphaning the active one.

Fix: store the timer id in `_reconnectTimer`, clear it in `disconnect()`, AND fence the deferred callback with the captured `_socketGeneration` so a stale timer firing late is a no-op. Same pattern in `splits.js`.

## Why we didn't…

- **…hash-skip the 200-line replay to avoid the visible flash on reconnect.** Initially considered. Rejected because xterm.js terminal state includes the alt-screen buffer (vim/htop/less), cursor position, SGR attributes, and character sets. Identical text content does NOT mean identical terminal state — skipping `terminal.clear()` based on a payload hash can corrupt the alt-buffer and cursor. The proper fix is server-side incremental replay using a monotonic sequence cursor (`lastSeenSeq`) — left for a v2 follow-up.
- **…force-close-and-reopen on every visibility change.** Causes reconnect storms when users tab-switch rapidly, drops in-flight terminal input, and triggers the 200-line replay flash unnecessarily. The pong-timeout from the immediate-ping covers the same ground without these costs.
- **…use a tighter (e.g., 1.5s) probe window on visibility return.** Mobile cellular radio wake-up is 1.5–3s and would generate constant false positives. A separate timer also races with any in-flight pong from before tab-hide that arrives moments after focus.
- **…skip the pong-timer when the tab is hidden.** Browsers throttle `setInterval` to ≥1Hz when hidden, which provides natural pacing. Skipping detection in hidden tabs defeats the purpose — the whole point is to know the connection died *before* the user comes back.
- **…use `WebTransport`/QUIC.** Real connection-migration win (survives Wi-Fi → cellular mid-session) but ~75% browser support and a large refactor. Worth re-evaluating when support is universal.

## Peer review

Plan was reviewed by both **gemini-3.1-pro-preview** (Google) and **gpt-5.5-codex** (OpenAI) before implementation. Both caught real issues that changed the design:

- Gemini caught: hash-skip would corrupt alt-screen state; skipping pong-timer in hidden tabs defeats the goal; 5s pong window too tight for cellular; splits without heartbeat are vulnerable to silent NAT timeouts even when main pane is alive.
- Codex caught: per-socket fencing is required because `clearInterval` doesn't cancel queued callbacks; `startHeartbeat()` must run before any awaited work in `onopen`.

Both rounds of feedback were folded into the plan before any code was written.

## Verification

Unit tests in `test/heartbeat-watchdog.test.js` cover: immediate-ping on start, recurring interval, pong-timeout force-close, no-close-when-pong-arrives-in-time, idempotent restart, per-socket generation fence (stale ticks must not send pings), per-socket socket-replacement fence (stale callbacks must not close the new socket), `stop()` cancels both timers.

Manual end-to-end checks recommended on a draft PR via CI (per `06-local-first-then-ci.md`):
1. Tab-switch idle return after 60s — terminal responsive within ~1.5s.
2. Network drop for 15s + restore — "Reconnecting" appears within 10s of drop, "Connected" within ~250ms of network return.
3. Mobile back-button (bfcache) — reconnects without manual refresh.
4. Server restart — existing `_serverRestarting` flow keeps its 1.5× backoff (untouched).
5. Splits survive a drop — both main and split reconnect (today only main does).
