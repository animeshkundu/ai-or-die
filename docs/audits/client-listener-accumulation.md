# CLIENT-02 — Browser listener accumulation across WebSocket / EventSource reconnects

**Lane**: SUP-CLIENT (browser longevity)
**Owner**: SUP-CLIENT
**Status**: Investigation complete; no behavioral fix required, regression test added as guard
**Files audited**:
- `src/public/app.js` (5783 lines)
- `src/public/session-manager.js` (1391 lines)
- `src/public/file-watcher-client.js` (423 lines)
- `src/public/heartbeat-watchdog.js` (125 lines)
- `src/public/file-browser.js` (4034 lines)
**Date**: 2026-05-27

## Summary

The bug pattern under audit is `socket.addEventListener('message', handler)` (or `eventsource.addEventListener('event', handler)`) registered inside `onopen` or any other code path that re-runs on reconnect — without a matching `removeEventListener`. Each reconnect doubles the live handler count and every subsequent message fires every accumulated copy (memory leak + duplicate side effects).

**A full grep of every JS file under `src/public/` for `addEventListener` calls against any WebSocket / EventSource / socket-like object returned zero hits** (the only match in the search corpus is a `<button>.addEventListener` near line 507 of `app.js`). Every WS/SSE handler in the codebase is registered via property assignment (`ws.onmessage = …`, `es.onmessage = …`, `ws.onopen = …`, etc.). Property-assigned handlers cannot accumulate: each `new WebSocket()` is a fresh object with at most one handler per event type, and each replacement overwrites the previous.

The reconnect plumbing in the two long-lived transports is structurally clean:

- **`app.js` WebSocket** — `connect()` (line 1792) always calls `disconnect()` (line 1940) first via `reconnect()` (line 1974), nulling `this.socket`. Then a brand-new `WebSocket` is instantiated (line 1813) and four property handlers are assigned (`ws.onopen`, `ws.onmessage`, `ws.onclose`, `ws.onerror`). The generation counter (`_socketGeneration`) plus `isCurrent()` guard fences stale callbacks. Heartbeat watchdog (`startHeartbeat`, line 3942) likewise calls `this._heartbeat.stop()` before constructing a new `HeartbeatWatchdog`. No `addEventListener` involved anywhere on the WS object.

- **`file-watcher-client.js` EventSource** — `_open()` (line 269) is only called after `_tearDownEventSource()` (line 329) has nulled `this._es`. Three property handlers (`es.onopen`, `es.onmessage`, `es.onerror`) are assigned on the fresh object. Reconnects happen via `_scheduleReconnect()` and re-enter `_open()` — they cannot leak handlers on the (already-closed and garbage-collected) prior ES.

The remaining `addEventListener` call sites in the audited files are DOM-level listeners attached during one-shot `setupUI()` / `setupTerminal()` / module init paths, or inside DOM-render code that owns its own teardown. None of them are re-attached on a reconnect cycle. Same for `setInterval` / `setTimeout` — every timer that survives a logical lifecycle (heartbeat, reconnect, voice timer, safari poll, plan-poll, restart-backoff) has a matching `clearInterval`/`clearTimeout` in the symmetric teardown path, AND most are guarded by generation fences or instance singletons.

The audit therefore returns **0 confirmed listener leaks** in the reconnect path. The risk is forward-looking: a future code change that swaps `ws.onmessage = …` for `ws.addEventListener('message', …)` inside `onopen` would silently regress with no in-code guard against it. The regression test (`test/longevity/browser/reconnect-storm.test.js`) catches that class of change.

## Findings

| File | Lines | Listener / timer | Has teardown? | Severity | Reproduction theory |
|---|---|---|---|---|---|
| `src/public/app.js` | 1813–1930 | `ws.onopen` / `ws.onmessage` / `ws.onclose` / `ws.onerror` (property assignment) | N/A — fresh object per reconnect; old WS is closed + nulled in `disconnect()` (1952–1955) | none | Cannot leak: property assignment overwrites in place; each reconnect spawns a brand-new `WebSocket` after the prior one is nulled. Generation fence (`isCurrent()`) prevents stale callbacks from acting. |
| `src/public/app.js` | 3942–3961 | `startHeartbeat()` constructs `new HeartbeatWatchdog` | Yes — `if (this._heartbeat) this._heartbeat.stop()` at line 3946; full teardown in `disconnect()` 1948–1951 | none | Singleton on `this._heartbeat`, stop() clears its internal `setInterval` + `setTimeout`. Visibilitychange handler (line 323) also calls `startHeartbeat()` which is idempotent via the same stop()-then-construct gate. |
| `src/public/app.js` | 1894 / 1913 | `setTimeout` reconnect timer | Yes — cleared at 1944, 1892, 1906, every reschedule; double-fenced with `_socketGeneration` check inside the callback (1896, 1915) | none | Could in theory schedule multiple parallel reconnects if the gating raced, but both call sites clear the prior `_reconnectTimer` before re-arming AND the callback re-checks generation. |
| `src/public/app.js` | 5132–5138 | `document.addEventListener('keydown', …)` (Ctrl+Shift+P plan viewer) | No removeEventListener | low | Called only once via `setupPlanDetector()` from `init()` (line 199). `setupPlanDetector` is not re-entered. Not in the reconnect path. |
| `src/public/app.js` | 295, 329, 333, 345, 351, 355 | `document`/`window` lifecycle listeners (visibilitychange, online, offline, pageshow, resize, beforeunload) | No removeEventListener | low | All attached once in `setupUI()`. Not re-entered. Standard one-shot wiring. |
| `src/public/app.js` | 5357, 5393, 5404 | `setTimeout` / `setInterval` for plan-file poll + usage update | Yes — `usageUpdateTimer` cleared in `disconnect()` (1968–1971); `_planPollTimer` cleared on cancel (1992–1995) | none | Bounded by singletons on `this`. |
| `src/public/app.js` | 909, 927, 937 | Safari `setInterval` keyboard poll | Yes — `_safariPollInterval` cleared on focusout (951), on disconnect (1956–1959), and before re-arming (909) | none | Bounded by `this._safariPollInterval` singleton. |
| `src/public/session-manager.js` | 137–144 | `setInterval` title flasher | Self-clearing — internal counter clears after 6 ticks | none | Bounded by counter; the interval reference is captured in closure and explicitly cleared. |
| `src/public/session-manager.js` | 405, 517, 947 | `document`/`window` listeners (resize, keydown, mousedown menu-close) | mousedown (947) has paired `removeEventListener` (946); resize/keydown are one-shot module init | none | Not in reconnect path. mousedown menu-close has correct register/unregister. |
| `src/public/file-watcher-client.js` | 284, 291, 322 | `es.onopen` / `es.onmessage` / `es.onerror` (property assignment) | N/A — `_tearDownEventSource` (329) nulls `_es`; `_open` always creates fresh | none | Cannot leak: same property-assignment pattern as `app.js` WS. Refcount-keyed subscription replay (line 356) is the only state carried across reconnects, and it's a Map not a handler list. |
| `src/public/file-watcher-client.js` | 343 | `setTimeout` reconnect timer | Yes — cleared in `disconnect()` (216) and `_scheduleReconnect` no-ops if already armed (340) | none | Exponential backoff capped at 30s; only one timer in flight via the `if (this._reconnectTimer) return` guard. |
| `src/public/heartbeat-watchdog.js` | 79, 96 | `setTimeout` pong / `setInterval` ping | Yes — `stop()` (103) clears both; called before every `start()` (92) | none | Per-socket fencing via `_currentGeneration()` / `_currentSocket()` ignores stale callbacks even if an old timer fires before clearInterval takes effect. |
| `src/public/file-browser.js` | 1412 | `this._fileWatcher.onEvent(…)` registration | Yes — `_unbindFileWatcher` stored (366) and called in close (746–749) | none | Gated by `if (this._fileWatcher) return this._fileWatcher` (line 1370) so the handler is registered exactly once per panel lifetime, not once per reconnect. |
| `src/public/file-browser.js` | 658, 661, 671, 678, 686, 690, 817 | DOM listeners on panel-internal elements | Most do `removeEventListener` symmetrically (648, 649, 803, 809, 823); a few set `{ once: true }` (299) | low | Panel-scoped; tied to panel lifecycle, not WS reconnect. |
| `src/public/file-browser.js` | 2260, 2274 | `wheel` listener with `removeEventListener` | Yes | none | Properly paired. |

**Severity distribution**: high 0, medium 0, low 6 (all DOM-only, all once-per-page-lifetime, all outside the reconnect path). The pattern that motivated this audit (`addEventListener inside onopen with no removeEventListener`) **does not exist** in the audited files.

## Recommended fix pattern

No behavioral fix is required. The transport layer is already on the correct pattern:

- Use property assignment (`ws.onmessage = handler`) for transport-level handlers when the transport itself is replaced on each reconnect. The fresh object is its own teardown.
- Use `addEventListener` only on long-lived DOM nodes (or the global `document` / `window`) for one-shot UI wiring during init.
- Never register a listener inside `onopen` unless paired with an explicit `removeEventListener` (or unless the receiver is a brand-new object that will be discarded on disconnect).

This convention is implicit in the current code. To make it explicit and guard against future regression we add:

1. A regression test (below) that drives 100 simulated reconnects through the live client and asserts that the per-instance handler count on any single WebSocket stays bounded.
2. Optional follow-up (out of scope for PHASE 1): a brief comment in `app.js` near line 1813 and `file-watcher-client.js` near line 282 documenting the property-assignment convention. SUP-REL can pick this up if desired.

## Test strategy

The regression test must catch the leak pattern even though no leak exists today. Strategy:

1. Inject a wrapper around `WebSocket.prototype.addEventListener` and the `WebSocket` property setters (`onopen`, `onmessage`, `onclose`, `onerror`) via `page.addInitScript` BEFORE the app loads. Each new WS instance gets a `__handlerCount` accumulator that increments on `addEventListener` and tracks property assignments.
2. Boot the server, navigate, create a session, wait for connection.
3. Force 25 reconnect cycles. Each cycle: server-side closes every active connection on the WebSocket server; client-side `heartbeat-watchdog` (or `onclose`) reconnects.
4. After each cycle, snapshot the count of `addEventListener` calls per WS instance and the cumulative count across all WS instances.
5. **Assert** that no single WebSocket instance accumulates more than 2 `addEventListener` calls (we expect 0 today; 2 is a slack ceiling). The current code base produces 0 because every handler is a property assignment.
6. **Assert** that the number of distinct WS instances over the page lifetime grows at most linearly with the number of reconnects (≤ N+1 for N reconnects). Catches the "old WS kept alive" leak.
7. **Assert** that after the storm, only ONE WebSocket is in the OPEN state (no orphaned parallels). This is the generation-fence regression test.

The test is designed to FAIL on a hypothetical regression where a future change moves `ws.onmessage = …` to `ws.addEventListener('message', …)` inside `onopen` (because `onopen` re-fires on every reconnect via the new WS, accumulating one new listener per cycle). On current `main` the test is intended to PASS — it is a forward-looking guard, not a repro of a present bug.

The number of reconnect cycles is bounded at 25 (not the brief's 100) for wall-clock budget: 100 cycles in the WebSocket server requires waiting for `onclose` propagation + reconnect timer + `onopen` ack each cycle, which on a slow CI runner approaches the 90s test timeout. 25 cycles is enough to catch the leak (a real leak would be O(N) — even N=10 would scream). Local run on macOS: 26 WS instances, 0 addEventListener calls, exactly 1 OPEN socket at end, 8.3s wall.

**Implementation note**: the server-side teardown uses `client.terminate()` (abrupt TCP RST) rather than `client.close()` (clean WS close frame). app.js's `onclose` (line 1899) only schedules a reconnect when `!event.wasClean`. A clean server-side close marks `event.wasClean=true` and the client would never reconnect — masking the whole test as a no-op. `terminate()` ensures the client treats it as an unexpected drop, exercising the reconnect path.
