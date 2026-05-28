# PROC Supervisor — Tiered Restart, Native-Child Crash Discipline, WS Listener Hygiene

**Date:** 2026-05-27
**Campaign:** stability-hardening-2026 (SUP-PROC lane)
**Files:** `bin/supervisor.js`, `src/server.js` (cleanupWebSocketConnection), `src/stt-engine.js`, `src/vscode-tunnel.js`
**Branches:** `sup-proc/proc-03-ws-cleanup` (`889bcf7`), `sup-proc/proc-01-supervisor-breaker` (`0887043`+`5813e71`), `sup-proc/proc-02-stt-stopping` (`534d7ca`), `sup-proc/proc-02-vscode-tunnel-guards` (`1f4179c`)
**Memos:** `docs/audits/proc-supervisor-breaker.md`, `docs/audits/proc-ws-listener-cleanup.md`, `docs/audits/proc-child-processes.md`
**Tests:** `test/longevity/process/{ws-listener-cleanup,supervisor-slow-crash,stt-worker-respawn,tunnel-restart-backoff,vscode-tunnel-respawn}.test.js` (21 tests, ~21 s total)

## Problem

The campaign-wide audit found `ai-or-die` already heavily hardened on the resource-lifecycle front (explicit `_ptyDisposables` drainage, centralized `_cleanupFsWatchSession`, four background intervals all cleared on shutdown). The residual PROC-lane gaps were narrow but real for a daemon that must stay up for months on a single user's machine:

1. **The supervisor's circuit breaker is the wrong shape for a single-user deployment.** `bin/supervisor.js:11-13` hard-exited after 3 crashes in 30s. Two failure modes both bad: (a) a transient flap (network blip, EADDRINUSE) hits the breaker and the user has no daemon until they SSH in, (b) a slow-steady crash (one per 31s) bypasses the 30s window forever and respawns at 3s cadence indefinitely — 28,800 respawns/day burning CPU, masking the underlying defect.
2. **`SttEngine.shutdown()` races its own `_onWorkerExit` handler.** `worker.terminate()` fires the exit listener synchronously; the listener has no `_stopping` flag, so it enters the restart branch and schedules a `setTimeout`-driven respawn of an engine the caller asked to die. Net: one extra Worker thread (4-thread CPU pool, ~150 MB resident) per shutdown.
3. **`VSCodeTunnelManager._restart` has no re-entrancy guard.** Both the natural exit handler and the periodic health-check sweep can call `_restart(sessionId)` for the *same* death event. Without a guard, `_totalRestarts` and `retryCount` double-increment, chewing through MAX_RETRIES (10) in half the time.
4. **`vscode-tunnel.js` hardcodes `STABILITY_THRESHOLD_MS = 60000`** with no per-instance override — testing the reset-on-stable-uptime path would need 60s of wall-clock per cycle.
5. **`cleanupWebSocketConnection` (`src/server.js:3828-3847`) never explicitly drops the message/close/error listeners it attached** in `handleWebSocketConnection`. Today GC reclaims them once the Map entry is dropped, but the discipline departs from the explicit-teardown pattern used everywhere else (`_ptyDisposables`, `_cleanupFsWatchSession`) and is one delayed-callback / one new-handler-addition away from a real leak.

## Three fixes shipped

### Fix 1 — Tiered supervisor circuit breaker (PROC-01)

Replace the single-tier hard exit with two windows, both env-overridable, neither permanently fatal:

| Tier | Trigger | Restart delay | Action |
|---|---|---|---|
| 0 (normal) | <3 crashes / 30s | 3 s | log + respawn |
| 1 (tight loop) | ≥3 crashes / 30s | **60 s** | loud `TIER 1 ESCALATION` log + respawn |
| 2 (sustained churn) | ≥5 crashes / 1h | **5 min** | loud log + queue `supervisor_warning` IPC for the next child + respawn |

Higher tier wins (a tight loop nested inside an already-elevated tier-2 window stays at tier 2). The supervisor never calls `process.exit(1)` from the crash-classification path. If the server is genuinely unrecoverable (corrupted state, missing native dep), tier-2's 5-min cadence drops respawn volume from 28,800/day to 288/day while keeping the daemon technically alive — so the user can recover via the browser the moment the underlying defect is fixed, without SSHing in.

The `supervisor_warning` IPC payload is queued via `child.once('spawn', ...)` (not the immediately-after-spawn `child.connected` check, which is always false because the IPC handshake hasn't completed yet) so the next-spawned child receives it deterministically — future CLIENT-04 wiring will read it and surface a "supervisor is throttling restarts; check server logs" banner in the browser.

Defence-in-depth cap on the `crashTimestamps` array (1024 entries, env-overridable) protects against any pathological window that the time-trim alone couldn't bound.

### Fix 2 — Child-process crash recovery (PROC-02)

Three small surgical changes, all mirroring patterns already established elsewhere in the codebase:

- **`src/stt-engine.js` — `_stopping` flag.** Set `this._stopping = true` at the top of `shutdown()` BEFORE `worker.terminate()` (which synchronously fires `_onWorkerExit`). Short-circuit at the top of `_onWorkerExit` when `_stopping`. Three new lines. Closes the shutdown-vs-respawn race.
- **`src/vscode-tunnel.js` — `_restarting` re-entrancy guard.** Per-tunnel flag set at the top of `_restart`, cleared in a `try { … } finally { }` block at the bottom. Mirrors `tunnel-manager.js:96`. Re-entrant calls (exit handler + health-check sweep) now no-op the second invocation.
- **`src/vscode-tunnel.js` — `_stabilityThresholdMs` constructor option.** Mirrors `tunnel-manager.js:36`. Tests can now shrink the threshold from 60s to ms; production behaviour unchanged.

### Fix 3 — WS listener cleanup discipline (PROC-03)

One line added to `cleanupWebSocketConnection`:

```js
try {
  if (wsInfo.ws && typeof wsInfo.ws.removeAllListeners === 'function') {
    wsInfo.ws.removeAllListeners();
  }
} catch (_) { /* cleanup must never throw */ }
```

`removeAllListeners` is idempotent and inert on a discarded socket. The try/catch is mandatory — cleanup runs from inside `ws.on('close')` / `ws.on('error')` callbacks where a throw would abort the rest of the teardown. Mirrors the explicit teardown discipline of `_ptyDisposables` (base-bridge.js) and `_cleanupFsWatchSession` (server.js). Not a leak fix today — defence-in-depth against future delayed-callback execution, future handler additions that forget teardown, and listener-closure GC pressure under reconnect storms.

## Lessons

### Supervisor circuit breakers for single-user daemons are different

Server-fleet circuit breakers can hard-exit because systemd / Kubernetes / a paging operator notices and restarts externally. **There is no such orchestrator on a single-user machine.** The supervisor IS the orchestrator. The right shape is tiered escalation that throttles loudly but never permanently gives up — the user's only recovery channel is the browser, and the browser is only useful if there's a daemon to talk to. The "give up after N crashes" pattern is a fleet-thinking import that doesn't transfer.

### Synchronous-firing crash handlers race their own caller

`Worker.terminate()` fires the exit listener synchronously, before `await terminate()` resolves. Any handler that schedules a respawn via `setTimeout` therefore races the caller that asked for shutdown — the shutdown completes, but a respawn has already been queued and will fire after the caller has moved on. The fix is unconditional: set the stopping flag BEFORE the terminate call. Same shape applies to any child-process owner with an exit listener that has restart logic.

### Health-check sweeps + exit handlers compose poorly without an explicit guard

`vscode-tunnel.js` had two independent code paths that detect a dead process — the natural exit handler and the periodic health-check sweep — and both call `_restart` for the same death event. Without a re-entrancy guard, the counters double-increment and the retry budget halves. The fix is a per-resource `_restarting` flag set in a `try { … } finally { }`, mirroring `tunnel-manager.js:96`. **`tunnel-manager.js` already had this pattern**; `vscode-tunnel.js` was the same author, two months apart, and the pattern wasn't carried over. Pattern-discipline-via-code-review only works when the reviewer remembers the precedent file.

### Defence-in-depth listener cleanup is cheap insurance

`cleanupWebSocketConnection` had no observed leak — GC reclaimed listeners once the Map entry was dropped. Adding `removeAllListeners()` cost 6 lines (with the try/catch) and removes one entire class of future bug: a downstream change that wires `ws.once('pong', ...)` inside `onopen` doesn't have to remember to add a matching teardown, because the central cleanup catches it. **Mirror the patterns elsewhere in the codebase** rather than relying on each future contributor to remember.

### Env-overridable tunables decouple test wall-clock from production semantics

Every tunable in `bin/supervisor.js` (the two windows, the three delays, the timestamps cap) is `parseInt(process.env.X, 10) || DEFAULT`. The regression test shrinks 30s → 200ms, 1h → 2s, 60s → 120ms, 5min → 240ms, and runs four scenarios in 5s of wall-clock. Production defaults remain the human-scale values. Same pattern for `_stabilityThresholdMs` (constructor option for VSCodeTunnelManager). The cost is one line of `parseInt` per knob; the benefit is regression tests that can verify multi-minute behaviour without taking multi-minute test runtime.

## Why we didn't…

- **…delete the supervisor's `process.exit(1)` entirely on cleanup paths.** The clean-shutdown path (code 0) and the explicit `RESTART_EXIT_CODE` path (75) still call `process.exit(0)` — what the fix removed was the *crash-classification* path's exit. Clean shutdowns and explicit restarts deserve their direct-exit semantics; only unexpected-crash classification needed the tier-everything behaviour.
- **…wire the in-process server to read `supervisor_warning` IPC and broadcast to the browser.** That's CLIENT-04 — future scope. The supervisor's job is to queue the warning deterministically (via `child.once('spawn', ...)`); the consumer side is independently owned by SUP-CLIENT. Decoupling lets PROC-01 ship without blocking on UI design for the banner.
- **…unify the three `_killProcess`-then-await blocks in `tunnel-manager.js` and `vscode-tunnel.js` into a single helper.** Pure code-hygiene; no behaviour change; out of scope for the stability campaign.
- **…test STT crash recovery against a real `sherpa-onnx-node` install.** The native module isn't required in CI, and the engine's `MODULE_NOT_FOUND` short-circuit path is the same code path the gap-1 fix protects. Tests assert the bookkeeping (queue drained, status transitions, `_restartAttempts` incremented, no respawn after shutdown) without requiring the native dep — the test runs in 6ms instead of seconds.
- **…fix the documented low-severity `_loginProcess.kill()` in `vscode-tunnel.js#stop()` that has no follow-up wait.** Short-lived login child, bounded blast radius, captured as out-of-scope in the memo for a future hardening cycle.
- **…audit the third tier (15min) or fourth tier (30min).** The two-tier scheme covers every observed failure pattern; a third tier would just be a marginal improvement at the cost of cognitive complexity. Tier 2's 5-min cadence is already sufficient throttling — 288/day vs the original 28,800/day is two orders of magnitude.

## Peer review

SUP-REL diff-reviewed the 5-commit stack and signed off with two non-blocking observations, both of which landed pre-PR in commit `5813e71`:

- `crashTimestamps` array is bounded only by time window, not by count — a pathological 100/sec crash loop could grow it to 360k entries over an hour. Cheap for Node but worth a cap. → Added `CRASH_TIMESTAMPS_CAP = 1024` (env-overridable), trimming oldest-first.
- `child.connected` check inside the immediately-after-spawn block was always false because the IPC handshake hadn't completed — the `supervisor_warning` IPC silently dropped. → Deferred the send via `child.once('spawn', ...)`, which Node fires AFTER spawn has succeeded and the IPC channel is wired.

SUP-DISK confirmed clean composition: PROC-01's tier-2 cadence + future `supervisor_warning` IPC reinforces DISK-03's `disk_full` breaker by surfacing the recurrence pattern to the user once CLIENT-04 lands. Three layers (in-process breaker, supervisor cadence, user-visible banner) without explicit coordination.

SUP-SOAK accepted the per-PR gate-affected matrix: PROC-03 + PROC-02-STT touch the `handles` gate (reconnect-storm workload); PROC-01 + PROC-02-vscode are subprocess-isolated and gated entirely by the longevity regression tests.

## Verification

21 PROC longevity tests in `test/longevity/process/` (combined runtime ~21 s):

- **2 tests** — `ws-listener-cleanup.test.js`: post-cleanup `listenerCount('message'|'close'|'error') === 0`; idempotent double-call safety.
- **4 tests** — `supervisor-slow-crash.test.js`: tier-1 escalation + alive invariant; tier-2 + IPC warning delivery; never-give-up under sustained churn; below-threshold quiet (no misfire). All tunables shrunk via env vars.
- **6 tests** — `stt-worker-respawn.test.js`: listener accumulation bounded across crash cycles; backoff formula `[1000,2000,4000,8000,15000]` + reset-on-ready; queue/_currentRequest/_restartAttempts bookkeeping on crash; the gap-1 shutdown race; `MODULE_NOT_FOUND` short-circuit; `MAX_RESTART_ATTEMPTS` cap.
- **5 tests** — `tunnel-restart-backoff.test.js`: `_totalRestarts` per crash; backoff doubles to 30s cap; `retryCount` resets after stable uptime; `MAX_RETRIES` honoured; `stop()` during in-flight backoff aborts.
- **4 tests** — `vscode-tunnel-respawn.test.js`: backoff escalation; gap-2 concurrent-`_restart` no double-increment; gap-3 stability-threshold reset with `_stabilityThresholdMs=50ms` override; MAX_RETRIES + `_cleanupTunnel`.

Plus 19 existing tests verified clean: `supervisor-integration` (1), `restart-manager` (12), `fs-watch-cleanup` (6) — all green pre- and post-fix.

Bundle merge order recommended: `sup-proc/proc-02-stt-stopping` → `sup-proc/proc-02-vscode-tunnel-guards` → `sup-proc/proc-01-supervisor-breaker` → `sup-proc/proc-03-ws-cleanup`. The PROC-02 ordering is load-bearing: the shared audit memo `docs/audits/proc-child-processes.md` ships with the STT branch; merging vscode-tunnel first leaves dangling memo references in the vscode test's comments until STT lands (cosmetic, not functional).
