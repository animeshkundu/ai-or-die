# PROC-02 — Child-process crash / respawn discipline

**Lane**: SUP-PROC (process-lifecycle / external dependencies)
**Owner**: SUP-PROC
**Status**: Investigation complete; fixes deferred (this memo + regression tests are the deliverable)
**Files audited**:
- `src/stt-engine.js` (346 LOC) — owns a `worker_threads` Worker for sherpa-onnx-node STT
- `src/stt-worker.js` (100 LOC) — the worker that loads the native module
- `src/tunnel-manager.js` (448 LOC) — owns a `devtunnel host` child via `child_process.spawn`
- `src/vscode-tunnel.js` (1082 LOC) — owns `code serve-web` + `devtunnel host` per-session
**Tests**:
- `test/longevity/process/stt-worker-respawn.test.js`
- `test/longevity/process/tunnel-restart-backoff.test.js`
- `test/longevity/process/vscode-tunnel-respawn.test.js`
**Date**: 2026-05-27

## Summary

All three child-process owners share a generally sound respawn shape:
exponential backoff with a cap, an upper retry bound, and a stability
timer that resets the retry counter after a configurable uptime. None of
them accumulate listeners across crash-respawn cycles because each
respawn allocates a **fresh** child (`new Worker(...)` / `spawn(...)`)
and attaches its handlers to that new object — the old handler closures
fall out of GC with the old child reference.

The real risks are narrower and concentrated in three places:

1. **`SttEngine._onWorkerExit` runs even on intentional shutdown** —
   `shutdown()` calls `worker.terminate()` but never sets a `stopping`
   flag, so the exit handler attached at spawn time still fires, sees
   no `lastSpawnError === 'MODULE_NOT_FOUND'`, sees
   `_restartAttempts < MAX_RESTART_ATTEMPTS`, and **schedules a fresh
   restart of an engine the caller asked to die.** Practically harmless
   today only because callers do not invoke `transcribe()` after
   `shutdown()` — but the restart timer fires and a new worker process
   gets created post-shutdown, retaining FDs + a 4-thread CPU pool for
   nothing.

2. **`vscode-tunnel.js` `_restart` has a double-fire race** between the
   natural `exit` handler (line 831 / 695) and the health-check sweep
   (line 994) when a process dies. Both call paths set `_whichDied` and
   invoke `_restart(sessionId)` — last writer wins on `_whichDied`,
   and `retryCount` increments twice for a single death. The
   `_restarting` guard used in `tunnel-manager.js:96` does not exist
   here.

3. **`vscode-tunnel.js` lacks the `_stabilityThresholdMs` test override**
   that `tunnel-manager.js` exposes (line 36). The stability timer
   constant is baked into `_startStabilityTimer` (line 862) so no test
   can shrink it to assert reset-on-stable-uptime within a sensible
   wall-clock budget. This is the reason the per-test fix in
   `vscode-tunnel-respawn.test.js` cannot cover that path on `main`.

None of these are corruption-class today. All three become real once
the codebase enters sustained-soak territory or once a caller adopts the
shutdown/restart APIs in earnest.

## Per-child summary

### STT engine (`src/stt-engine.js` + `src/stt-worker.js`)

1. **Spawn**: `_spawnWorker()` (line 197) constructs `new Worker(workerPath, { workerData: {...} })`. The worker is a `worker_threads.Worker`, not a separate OS process — stdio is shared with the parent, env is inherited from `process.env` (the parent sets `PATH` / `LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH` inside the worker itself, lines 19–29 of `stt-worker.js`). Not detached.
2. **Listeners**: per spawn cycle, the engine attaches:
   - one transient `worker.on('message', onReady)` (line 240) — explicitly removed on first message (lines 210, 224)
   - one transient `worker.on('error', onError)` (line 241) — explicitly removed on first message or error (lines 211, 225, 231)
   - one permanent `worker.on('message', (m) => this._onWorkerMessage(m))` (line 217) — anonymous arrow; tied to the fresh Worker
   - one permanent `worker.on('exit', (c) => this._onWorkerExit(c))` (line 218) — anonymous arrow; tied to the fresh Worker

   **No accumulation across crash cycles** — the prior Worker reference is
   nulled at line 159 (`this._worker = null`) inside `_onWorkerExit`, so
   the old Worker (and its listener arrays) becomes GC-eligible.
   `worker.listenerCount('message')` on the live worker should equal 1
   in steady state and 2 only during the transient handshake window.
3. **Crash handling**: `_onWorkerExit(code)` rejects every queued
   request with `'STT worker crashed'`, nulls `_currentRequest` and
   `_worker`, then decides:
   - if `_lastSpawnError === 'MODULE_NOT_FOUND'` → set status
     `'unavailable'`, do not retry. (Correct.)
   - else if `_restartAttempts >= MAX_RESTART_ATTEMPTS` (5) → give up.
   - else: increment `_restartAttempts`, schedule `_restartWorker(delay)`.
4. **Backoff**: `delay = min(1000 * 2^restartAttempts, 15000)`
   (lines 178–181). Exponential. Capped at 15 s. Reset to 0 on `'ready'`
   message (line 114 and line 214). **Reset is correct.**
5. **FD / memory drift potential**: low. The Worker object is replaced
   on each crash; queued requests are drained on exit (lines 152–155);
   `_currentRequest.timer` is cleared (line 153). The only thing that
   can drift is `_requestIdCounter` (monotonic) — but it is a JS Number,
   not a leak vector.
6. **Zombie risk**: `worker_threads.Worker` is not a separate OS process
   (no `wait()` needed at the OS level). `terminate()` returns a Promise
   that resolves when the worker thread has exited. **However**, see
   gap (1) above: `terminate()` triggers the same `'exit'` handler, and
   the handler schedules a respawn because no `stopping` flag exists.
7. **Cleanup contract**: `shutdown()` (line 328) rejects queued
   requests, clears `_currentRequest`, awaits `worker.terminate()`,
   nulls `_worker`, sets status `'unavailable'`. **Gap**: the exit
   handler fires AFTER status is set to `'unavailable'`, then re-enters
   the restart-decision branch which only checks for `MODULE_NOT_FOUND`
   — it does NOT check that the caller explicitly requested shutdown.
   So the engine respawns itself post-`shutdown()`. The fix is one
   line: set `this._stopping = true` in `shutdown()`, check it at the
   top of `_onWorkerExit`.

### Tunnel manager (`src/tunnel-manager.js`)

1. **Spawn**: `_spawn()` (line 296) calls
   `spawn('devtunnel', ['host', this.tunnelId], { stdio: ['pipe', 'pipe', 'pipe'] })`.
   Not detached. Inherits env. PATH lookup for `devtunnel` is a free
   call (no `shell: true` — `devtunnel` is a standalone binary even on
   Windows; see CLAUDE.md primary-target note).
2. **Listeners**: per spawn cycle, four event handlers are attached:
   - `process.stdout.on('data', ...)` (line 317)
   - `process.stderr.on('data', ...)` (line 332)
   - `process.on('error', ...)` (line 340)
   - `process.on('exit', ...)` (line 349)

   Each spawn produces a fresh `ChildProcess`, so listener arrays start
   empty and never accumulate. `stop()` and `restart()` use `once('exit')`
   listeners (lines 81, 118), so even the teardown path does not leak.
3. **Crash handling**: in the natural-exit branch (line 349), if not
   intentionally stopped and not already restarting and exit code ≠ 0,
   `_restart()` is called (line 361). `_restart()` is guarded by neither
   `_restarting` (that flag covers only user-initiated `restart()`)
   nor a re-entry mutex of its own — but since `_restart` is called
   only from the `exit` handler of the **current** process, and that
   handler fires exactly once per process lifetime, there is no
   re-entry hazard in practice.
4. **Backoff**: `delay = min(2^(retryCount-1) * 1000, 30000)`
   (lines 417–420). Exponential. Capped at 30 s.
   `retryCount` resets on stable uptime via `_startStabilityTimer`
   (lines 371–383) — fires `STABILITY_THRESHOLD_MS` after the public
   URL is detected. Test override: `_stabilityThresholdMs` constructor
   option (line 36). **Reset is correct.**
5. **FD / memory drift potential**: low. Process reference is nulled
   in the exit handler (line 352), stdio pipes are owned by the
   `ChildProcess` and freed when it GCs. `_totalRestarts` is monotonic
   (Number; bounded by `MAX_RETRIES` per session-lifetime burst).
6. **Zombie risk**: `stop()` (line 61) sends SIGTERM, then SIGKILL
   after 5 s, then `once('exit')` resolves the wait. POSIX `wait()` is
   handled implicitly by Node's `ChildProcess` reaper. **Safe**.
   `restart()` (line 95) mirrors the same teardown shape.
7. **Cleanup contract**: `stop()` is sound — sets `stopping`, clears
   the stability timer, aborts the pending restart-delay timer, awaits
   process exit with SIGKILL escalation. The only minor gap: when
   `_restart()` is mid-flight inside its `setTimeout` delay window and
   `stop()` aborts the timer, `_restart` re-enters at line 438 with
   `stopping === true` and exits cleanly. Correct.

   **Minor gap**: `retryCount` is incremented at line 398 BEFORE the
   backoff delay is awaited. If `stop()` aborts the delay, the
   increment is cosmetic (the engine never spawns again) — but a
   subsequent `restart()` resets `retryCount = 0` (line 130), so no
   user-visible drift.

### VS Code tunnel (`src/vscode-tunnel.js`)

1. **Spawn**: two children per session.
   - `_spawnServer` (line 601) spawns `code serve-web --port <p> --connection-token <t> --accept-server-license-terms`. `stdio: ['pipe', 'pipe', 'pipe']`. `shell: true` on Windows only (`.cmd` stub). `cwd: tunnel.workingDir`. Full env inherited.
   - `_spawnTunnel` (line 766) spawns `devtunnel host <id>`. Same stdio. `shell: true` on Windows only (note: comment claims devtunnel is a standalone binary in `tunnel-manager.js`, but `vscode-tunnel.js` adds `shell: true` on Windows anyway — minor inconsistency, out of scope for this audit).
2. **Listeners**: per spawn cycle (server OR tunnel), four event handlers
   are attached: `stdout.on('data')`, `stderr.on('data')`, `on('error')`,
   `on('exit')`. Same fresh-child argument as `tunnel-manager.js` —
   no accumulation.

   Login flow adds a fifth: `_loginProcess` attaches `stdout`/`stderr`/`error`/`exit`
   handlers (lines 523, 553, 572, 582). Login is one-shot per tunnel,
   so no accumulation here either.
3. **Crash handling**: both `_spawnServer.on('exit')` (line 695) and
   `_spawnTunnel.on('exit')` (line 831) call `_restart(sessionId)` with
   `tunnel._whichDied` set. Periodically, `_ensureHealthCheck` (line 991)
   also checks for externally killed processes and calls `_restart`.
4. **Backoff**: same shape as `tunnel-manager.js` — exponential,
   capped at 30 s, with stability-timer reset (lines 855–873). MAX_RETRIES
   honored at line 897. **However** the stability threshold is hardcoded
   (line 862 references the module-level `STABILITY_THRESHOLD_MS`
   constant), with no per-instance override. This is the load-bearing
   gap for testability — see gap (3) in the summary.
5. **FD / memory drift potential**: medium. Each tunnel state object
   (~12 fields) lives in `this.tunnels` Map keyed by `sessionId`.
   `_cleanupTunnel` (line 316) deletes the Map entry AND the
   `_reservedPorts` Set entry. **However**, on the
   `retryCount > MAX_RETRIES` fatal branch (line 897), `_cleanupTunnel`
   IS called (line 908) — good. But on the `_restart` happy path,
   the previous `tunnel.serverProcess` / `tunnel.tunnelProcess` are
   simply overwritten without an explicit kill on the prior reference
   if `_whichDied === 'server'` (line 932) — the `if (tunnel.tunnelProcess)`
   check kills the tunnel sibling but the server process reference was
   already nulled by its own exit handler before `_restart` ran. **Safe.**
6. **Zombie risk**: `_killProcess` (line 327) sends SIGTERM, escalates
   to SIGKILL after 5 s, awaits via `once('exit')`. The `_loginProcess`
   teardown at `stop()` (line 233) uses raw `kill()` with NO follow-up
   wait — if the login process is unresponsive, this returns
   immediately and leaves an unwaited child. Minor; login processes
   are short-lived (auth or timeout). Out of scope for this PR.
7. **Cleanup contract**: `stop()` (line 224) is well-sequenced:
   kill login if any → kill tunnelProcess via `_killProcess` →
   fire-and-forget `devtunnel delete <id>` → kill serverProcess →
   `_cleanupTunnel`. **`stopAll()`** (line 289) clears the health
   interval and parallels `stop()` across all sessions — correct.

   **Real gap (gap 2 in summary)**: there is no `_restarting` guard
   on `_restart`. If a process dies at the exact moment the health
   check sweeps the dead PID, both code paths invoke `_restart(sessionId)`,
   which double-increments `retryCount`, double-emits
   `vscode_tunnel_status`, and races on `_whichDied`. The window is
   small but real: `HEALTH_CHECK_INTERVAL_MS = 60000`, so on a normal
   crash the natural exit handler will fire first and set
   `tunnel.serverProcess = null` (line 697) before the next sweep —
   the sweep's `!tunnel.serverProcess` short-circuit (line 998) means
   the race is normally won by the exit handler. But on a process that
   was reaped by an external `kill -9` from outside our control, the
   sweep can fire first. The fix is to add a `tunnel._restarting`
   flag, mirroring `tunnel-manager.js:96`.

## Severity table

| File | Concern | Severity | Fix recommendation |
|---|---|---|---|
| `src/stt-engine.js` | `_onWorkerExit` respawns the worker even after `shutdown()` (no `stopping` flag) | **medium** | Set `this._stopping = true` in `shutdown()`; short-circuit `_onWorkerExit` if `_stopping`. One-line fix. |
| `src/stt-engine.js` | Listener accumulation across crash cycles | none | Already correct — fresh Worker per spawn, no accumulation. Test added as guard. |
| `src/stt-engine.js` | Backoff escalation + reset on success | none | Already correct — `2^restartAttempts * 1000`, capped at 15 s, reset on `'ready'`. |
| `src/stt-engine.js` | FD / memory drift across crash cycles | low | None — Worker GC reclaims listener arrays. Monitor under SOAK-02. |
| `src/tunnel-manager.js` | Backoff escalation + reset on stable uptime | none | Already correct — `_stabilityThresholdMs` test hook exists at line 36. |
| `src/tunnel-manager.js` | `retryCount` increment before delay (cosmetic if `stop()` races) | low | Out of scope. Subsequent `restart()` resets the counter. |
| `src/tunnel-manager.js` | Zombie risk on SIGKILL | none | `once('exit')` always awaits. Correct. |
| `src/vscode-tunnel.js` | Health-check sweep + natural exit handler can both call `_restart`, double-incrementing `retryCount` | **medium** | Add `tunnel._restarting` flag, mirror `tunnel-manager.js:96` pattern. |
| `src/vscode-tunnel.js` | Stability threshold is hardcoded; no per-instance test override | low | Add `_stabilityThresholdMs` constructor option, mirror `tunnel-manager.js:36`. Required to fully test reset-on-stable-uptime; the gap is called out by the regression test. |
| `src/vscode-tunnel.js` | `_loginProcess.kill()` in `stop()` has no follow-up wait | low | Wrap in `_killProcess` for symmetry. Login process is short-lived; impact is bounded. |
| `src/vscode-tunnel.js` | Backoff escalation + retry cap honored | none | Already correct (lines 897–915). |

## Gaps that warrant a fix

1. **`stt-engine.js` — shutdown / respawn race.** Add a `_stopping`
   flag set in `shutdown()` and checked at the top of `_onWorkerExit`.
   The regression test
   `test/longevity/process/stt-worker-respawn.test.js` (test 4) drives
   this scenario without requiring the native module — it instruments
   the engine via `await engine.shutdown()` and asserts no
   `setTimeout`-driven respawn fires. **Today this test fails on
   `main` HEAD** (the engine's status is `'unavailable'` post-shutdown
   but `_restartAttempts` increments and a setTimeout is scheduled).
2. **`vscode-tunnel.js` — `_restart` re-entrancy guard.** Add a
   per-tunnel `_restarting` flag. Set it at the top of `_restart`,
   clear it at the bottom (in a `try { } finally { }`). The regression
   test `test/longevity/process/vscode-tunnel-respawn.test.js` (test 2)
   triggers `_restart` twice concurrently and asserts `retryCount`
   advances by 1, not 2. **Today this test fails on `main` HEAD.**
3. **`vscode-tunnel.js` — `_stabilityThresholdMs` test hook.** Mirror
   the constructor-option pattern from `tunnel-manager.js:36`. The
   regression test
   `test/longevity/process/vscode-tunnel-respawn.test.js` (test 3)
   asserts the reset-on-stable-uptime path; without the hook the test
   would have to wait 60 s of wall-clock per crash cycle. The test is
   `it.skip`'d with a load-bearing TODO comment pointing at this memo,
   so it FAILS-as-skipped today and PASSES once both the override and
   the corresponding behavior are wired.

## Out of scope

- The `_loginProcess.kill()` zombie risk (low severity, short-lived
  child, low blast radius). Roll into the next vscode-tunnel-hardening
  PR.
- The `shell: true` inconsistency between `tunnel-manager.js` and
  `vscode-tunnel.js` on Windows for the `devtunnel` binary —
  `tunnel-manager.js` is correct (no shell needed), `vscode-tunnel.js`
  is conservative (shell wrap on Windows for compatibility with
  PowerShell vs cmd.exe lookup paths). Both work; consolidate later.
- The `_requestIdCounter` monotonic growth in `stt-engine.js` — Number
  precision-loss does not occur until 2^53 transcriptions, which is
  not a realistic concern.
- The `_voiceUploadCounts` Map in `server.js` — not in this audit's
  scope (covered by `fs-watch-cleanup.test.js` test 3).
- Refactoring the four similar `if (this.process)` then-kill-then-await
  blocks (`tunnel-manager.js:74–87` and `:113–123`,
  `vscode-tunnel.js:327–346` and the login teardown at `:232–235`)
  into a single helper. Pure code-hygiene; no behavior change.

## Update (2026-06-19): deterministic shutdown / PTY-grandchild gap closed

This memo audited the app's OWN child-process owners (STT worker, tunnels, vscode-tunnel).
A separate, larger gap — the CLI's `node`/`bun` MCP **grandchildren** spawned *inside* a PTY,
which node-pty's Windows `kill()` does not reap — is now addressed by the deterministic-shutdown
work in **ADR-0031** / `docs/specs/process-shutdown.md`:

- Windows: a kill-on-close Job Object held in-process by the supervisor (whole tree dies with
  it) plus per-PTY nested jobs (`src/job-guard.js`, `src/base-bridge.js`).
- POSIX: process-group escalation, best-effort (`src/utils/process-tree.js`); honest `setsid`
  crash-path limitation documented in the spec.
- Cross-cutting: the server's IPC `disconnect` handler now reaps + exits on supervisor death
  (was "continue standalone"), `uncaughtException` reaps PTY subtrees, and the supervisor
  shutdown timeout (20s) was ordered above the server force-exit (15s).

The `_loginProcess.kill()` no-follow-up-wait item below remains open (low severity).

## References

- `src/stt-engine.js:148–195` — `_onWorkerExit` and `_restartWorker`
- `src/stt-engine.js:197–243` — `_spawnWorker` (transient + permanent listener attachment)
- `src/stt-engine.js:328–343` — `shutdown` (missing `_stopping` flag)
- `src/stt-worker.js:32–41` — module load with `MODULE_NOT_FOUND` short-circuit
- `src/tunnel-manager.js:296–365` — `_spawn` (listener attachment, exit-driven respawn)
- `src/tunnel-manager.js:371–383` — `_startStabilityTimer` (reset on stable uptime)
- `src/tunnel-manager.js:396–442` — `_restart` (backoff math, MAX_RETRIES bound)
- `src/vscode-tunnel.js:695–710` — `serverProcess.on('exit')` calls `_restart`
- `src/vscode-tunnel.js:831–846` — `tunnelProcess.on('exit')` calls `_restart`
- `src/vscode-tunnel.js:881–986` — `_restart` (no `_restarting` guard)
- `src/vscode-tunnel.js:991–1018` — `_ensureHealthCheck` (sweeps externally killed PIDs; second `_restart` caller)
- `test/longevity/process/stt-worker-respawn.test.js` — regression test
- `test/longevity/process/tunnel-restart-backoff.test.js` — regression test
- `test/longevity/process/vscode-tunnel-respawn.test.js` — regression test
- `docs/audits/proc-ws-listener-cleanup.md` — sister PROC-lane memo
- `docs/audits/SUMMARY.md` — campaign index
