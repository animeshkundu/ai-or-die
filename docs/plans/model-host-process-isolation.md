# Process isolation: shrink the core, make heavy subsystems independently restartable

> Status: revised after cross-lab adversarial review (Google + OpenAI). One earlier recommendation was **withdrawn** — see "Correction" below.

## Context

The service is used all day for agentic coding on Windows 11 and grows past 4 GB RSS. A factory `cheap-fast-feature` diagnosis produced eight ranked JS-heap retention findings; I verified all eight as real, and **none of them explain the symptom**.

The live instance settled it. `GET /api/diagnostics` on PID 15640 (8.9 days uptime, `ai-or-die --mesh --tunnel`):

```
rss 2236.9 MB   heap_used 20 MB   heap_total 26.7 MB
external 6.3 MB   array_buffers 3.6 MB
```

The JS heap is 20 MB after nine days. ~30 MB of a 2237 MB process is JavaScript; **98.6% of RSS is native memory**, matching the models on disk:

| Model | Purpose | On disk | Loaded via |
|---|---|---|---|
| LFM2-2.6B-Q4_K_M | sticky-note summaries | 1.46 GB | `worker_threads` (`sticky-note-engine.js:62`) |
| sherpa parakeet int8 | STT | 0.64 GB | `worker_threads` (`stt-engine.js:302`) |

`worker_threads` share the parent's address space, so both models are resident **inside** the server process. Not a leak — a floor. Restarting subprocesses never helped because the weights reload every time.

Two drivers:

1. **No fault isolation.** A native N-API abort or V8 OOM in either thread kills the whole server and every PTY. The codebase already admits this: `sticky-note-engine.js` notes loading node-llama-cpp's addon under Bun "would take the whole server down." Both engines refuse `worker.terminate()` (`sticky-note-engine.js:351-359`, `stt-engine.js:498-506`) because force-killing a thread inside ggml/sherpa aborts the process with SIGABRT/134. A thread is not a fault boundary.
2. **No memory reclaim.** Terminating a thread does not return native allocator pages to the OS. Killing a process returns 100%.

Both models load **eagerly at boot** (`server.js:3405`, `:3411`), before the HTTP server exists. Neither has idle-unload, refcount, or LRU.

## Correction: automatic core restart is withdrawn

I previously recommended wiring `RestartManager._checkMemory()` to `initiateRestart()` above a memory ceiling. **That was wrong for this service and is removed from the plan.** Adversarial review blocked it, correctly:

- `initiateRestart()` → `handleShutdown()` → `close()` → `bridge.stopSession()` for every active session. It **kills every live PTY**. For a tool whose whole purpose is long-running agentic coding, silently destroying a running session mid-task is the worst outcome the system can produce, and it would be triggered by a heuristic.
- The thresholds are already wrong: healthy baseline today is ~2.2 GB against a 2 GB warn threshold, so the condition is effectively always true.
- After extraction it gets worse, not better: core `process.memoryUsage().rss` **excludes** child-host RSS, so the monitor becomes blind to precisely the memory it was introduced to manage.

**Replacement:** memory pressure retires a **model host**, never the core. Extraction is what makes this possible — the correct lever only exists after the split. Putting the supervisor in the installed path (crash respawn, Job Object guard, `--expose-gc`) is independently good and stays; only the automatic core restart is dropped.

## Target topology

```
bin/supervisor.js       tiny: spawn, backoff, job guard, IPC shutdown
└── core server         PTY bridges, WS, HTTP, control plane, JSONL turn-detection,
    │                   tunnel/mesh managers
    ├── sticky-note host   LFM2 1.46 GB   killable, respawns, idle-unloads
    └── stt host           sherpa 0.64 GB  killable, respawns, idle-unloads

already separate child processes: mesh sidecar, devtunnel, code serve-web, powershell keepalive
```

**Stays in core:** PTY bridges (master fd not transferable; per-PTY `KILL_ON_JOB_CLOSE` handle; `onOutput` at `server.js:5489-5514` is a five-way synchronous fan-out). The sticky-note JSONL binding `_stickyJsonl` (always-on control-plane infra read synchronously by `_controlIsTurnAgent` `:5013`, artifact-push idle gate `:4202-4210`, `_controlAwaitSubmission` `:5038`, readiness `:5088`/`:5153`). `_stickyActive` (keyed by live WebSocket ids). Mesh/devtunnel/vscode-tunnel managers — their heavy work is *already* an external binary child (`mesh-manager.js:152`, `tunnel-manager.js:301`, `vscode-tunnel.js:631`); moving the thin manager adds ~40-90 MB node baseline each for no isolation gain. (The real bug there is `vscode-tunnel.js:647` concatenating stdout unbounded — fix the string, not the topology.)

**Hosts are children of the core, not the supervisor.** Supervisor ownership would centralise retained handles and reap-on-core-death, but it contradicts the explicit goal of keeping the supervisor minimal and adds an IPC hop to every inference. Rejected deliberately; the orphan window it would have closed is handled by the startup sweep below.

**Hard requirement:** neither native addon may be `require`d in the core — not in `model-host.js`, not in a preflight hook, not transitively. Otherwise the boundary is decorative. Assert with a test that greps the core's loaded module list.

## Host generations — the core lifecycle primitive

A per-child "retirement guard" is insufficient: it stops double-handling one child but not an **old child mutating a newer child's state**. Concrete race: idle timer starts unloading host A and sets a global `_intentionalStop`; a demand arrives during the 2 s grace; work routes to dying A or spawns B while A still holds 1.46 GB; A's later `exit` clears `_worker`, flips status to `idle`, clears `_intentionalStop`, or rejects B's request.

Every spawn creates an **immutable generation object**: child identity + retained handle, intentional-stop reason, readiness promise and deadline, owned request, finalization state, backoff/shutdown timers. **Every handler and timer epoch-checks its generation before touching engine-global state.** `demand`, `unload`, crash-restart, manual retry and cooloff all go through one serialized transition function. A replacement does not spawn until the prior host's exit has been **observed**.

### States

`disabled` (terminal) · `downloading` · `idle` (no child) · `loading` · `ready` · `unloading` · `restarting` · `failed`

`unloading` is required: reporting `idle` while a child is still exiting violates the definition of `idle` and is what allows the overlap race. Write the full transition table and assert **totality** in `test/model-host.test.js` — every (state × event) pair has a defined outcome.

`unload()` acts only from `ready`. From every other state it is a no-op; the idle timer arms on entry to `ready` and disarms on exit. Without this, firing during `restarting` forces `idle` without cancelling the pending backoff timer, which then spawns into `ready` against an empty refcount so the timer never re-arms and 1.46 GB is stranded permanently; firing during `failed` bypasses the cooloff.

### One finalizer, order-independent

There is **no documented Node guarantee that `disconnect` precedes `exit`** — my measurements are evidence, not a contract, so nothing may depend on the ordering. A single finalizer consumes `error`, `disconnect`, binary-pipe EOF/error, readiness-deadline expiry and `exit`, idempotently per generation.

A control-channel `disconnect` must mean: mark that generation unhealthy → stop accepting writes → settle its owned request → **terminate that exact process** → wait for observed exit → only then apply the crash budget and consider a replacement. "Never respawn on disconnect alone" was half right: not respawning is correct, but leaving the process alive is not — a host that calls `process.disconnect()` or corrupts fd 3 without exiting would otherwise sit resident forever holding 1.46 GB.

**Readiness needs a deadline.** A host that connects but hangs during model load stays `loading` forever, and the idle timer explicitly refuses to unload `loading`. That is a permanent strand. Bound it and retire on expiry.

## Crash budget

Two separate mechanisms, because one cannot do both jobs:

- **A rolling crash ring that success does not erase** — N crashes in a window, full stop. Clearing the ring on a successful inference (my earlier design) permits an unbounded `success → crash → success → crash` loop, each cycle paying a 1.46 GB load.
- **A consecutive-failure counter** that success may reset, driving backoff.

Classify failures — startup failure, inference crash, protocol violation, hard timeout, forced retirement, intentional unload, permanent configuration error — and budget them differently. Intentional unloads record nothing.

**Permanent failures stay permanent.** `MODULE_NOT_FOUND` must not become retryable because a 30-minute cooloff elapsed; only transient classes participate in cooloff, and cooloff and manual Retry are themselves rate-limited and generation-checked.

**Timeouts retire the host.** Today a timeout rejects and leaves the worker running, which either blocks the queue forever (if `_currentRequest` stays set) or sends later requests to a host still executing the timed-out native call (if cleared). A blown 60 s / 300 s deadline means wedged; retire it. Late completions need an explicit tombstone policy, not "silently drop mismatched ids."

## IPC

`stdio: ['ignore','inherit','inherit','ipc','pipe','pipe']` — fd 3 control, fd 4 payload, fd 5 liveness.

`serialization:'advanced'` is not an option: measured, it delivers **no messages at all** under bun 1.3.14 (even `{x:42}` times out), and STT is the engine documented to support Bun. Default JSON IPC destroys typed arrays. Hence a separate binary pipe — on Windows, stdio pipes already *are* named pipes, so this is the native mechanism with no extra namespace or cleanup.

**Correlation:** a generation nonce plus a per-generation sequence number, not a bare monotonic id. An f64 postpones reuse rather than fixing it, and admits NaN/±Infinity/non-integers/−0. Mismatches must be classified as expected-late-tombstone or protocol-violation, never silently dropped.

**Framing must be specified, not left to the implementer:** magic prefix; one frame per single `write()` (never split header from payload); hard maximum length validated *before* allocation; valid dtype set with dtype/length agreement; control metadata must agree with frame length and type; duplicate ids and duplicate metadata rejected; orphan metadata or orphan frame expired from a bounded pending map; EOF mid-frame retires the generation; `write()` backpressure, `drain`, callback errors and EPIPE all handled; parser state reset when a generation retires. Benchmarks at 320 KB / 1.92 MB / 3.84 MB are not a protocol limit unless the parser enforces one.

Test specifically on Windows and Bun with six stdio entries, long-blocked readers, pipe backpressure, termination mid-frame, and repeated spawn/kill cycles.

## Kill and reap

**Windows (primary).** "Same synchronous tick" is *not* a PID-reuse contract — the child can exit and its PID be reused before `assignPid` runs, assigning an unrelated process to a kill-on-close job. The correct fix is create-suspended plus assignment by retained `HANDLE` before resume, which needs a native launcher (koffi is already a dependency for `job-guard.js`). Until that exists: treat any job creation or assignment failure as **fatal for that child** (terminate it; never report it loading or ready), make the job handle **non-inheritable** so host inheritance cannot defeat `KILL_ON_JOB_CLOSE`, and add a **startup orphan sweep** — hosts carry a marker env var and identifying argv, so a fresh core enumerates and kills any host that is not its own. Verify behaviour when the core is already inside a restrictive enterprise/CI/terminal job. Note `_attachPtyJob` has always had this same window; do not propagate it *and* claim a guarantee.

**POSIX.** Node offers no synchronous `waitpid` from an `exit`/`uncaughtException` handler, and complex work in `uncaughtException` is itself unsafe — so "synchronous reap" is not a guarantee and will not be claimed. Define **reaped = observed exit**. Layers: host `process.on('disconnect', () => process.exit(0))`; a pure-JS worker thread in the host blocking on `fs.readSync(fd 5)` so core death closes the write end and the watchdog SIGKILLs itself (this covers the ~160 s window where a CPU-backend summary is inside a synchronous native call and `disconnect` cannot be delivered); best-effort tree kill on core death paths. The watchdog needs an **armed handshake before the model may load** — otherwise the host can enter native code before the watchdog is blocking — plus explicit pipe ownership so GC or accidental closure cannot cause a false kill, and handling for a descendant inheriting the endpoint and delaying EOF. Uncovered: SIGSTOP and uninterruptible kernel waits. Document, do not hand-wave.

## Client compatibility

Shipping a tolerant client first is **not sufficient** — old pages stay connected across a server upgrade, and third-party clients exist. `getStatus() === 'ready'` is literally what makes affordances exist today (`voice-handler.js:74`, `app.js:2658`, `:3029` → `_refreshStickyNoteBtnVisibility` at `:1500`), so a stale page would hide the sticky button and grey the mic, leaving the user unable to perform the gesture that warms the model.

Therefore: **keep the legacy status field emitting legacy values, and add the lifecycle state as a separate field** behind capability negotiation. Old clients keep working unchanged; new clients opt in. Same for `voice_warm` — old clients never send it, so the server must have a cold-client path, plus server-side rate limiting and bounded hold extension so repeated or hostile warms cannot pin 640 MB indefinitely.

**UI refcounts are not reliable liveness signals.** WebSocket expand/collapse messages can duplicate, reorder or be lost; half-open connections retain references indefinitely; a reconnecting page does not restore expanded state. Use idempotent boolean ownership keyed by connection epoch and card identity, full resync after reconnect, and **expiring leases with heartbeats** rather than arithmetic increments.

## Idle policy

**Sticky-note — 90 s after the last card collapses.** Being wrong is cheap: it is background work nobody watches. Timer firing is permission to *check*: refuse and re-arm on re-expand, in-flight request, non-empty queue, or any state other than `ready`. `pendingText` survives unload (it lives in the summariser, `sticky-note-summarizer.js:86`, and `needsSummary` stays true). `_attempt`'s not-ready branch must treat `idle` as "call `demand()` and return" — polling a demand-only state spins forever. Warm on expand: `_handleSetStickyActive(true)` (`server.js:6323`) calls `demand()`, hiding cold start behind reading time while the card shows the last persisted note with a "refreshing" affordance.

**STT — 10 min, with prefetch, or not at all.** `onRecordingStart` (`app.js:1618`) fires 2-15 s before audio arrives; `voice_warm` calls `demand()` and sets a bounded arm-hold. On a cold request, block bounded (25 s) rather than fail fast — the user has already spoken. Acknowledged: the cap still discards audio on a slow machine, it only delays the failure. External-endpoint mode (`stt-engine.js:50-53`) reports ready with no child and must never be unloaded.

**Prerequisite (correctness fix in its own right):** `summarizer.feed()` is called on every PTY chunk (`server.js:4814`, `:5502`) gated only on `isEnabled(sessionId)` — no expand check. It arms timers reaching `infer()`, and self-disables only once `jsonlMode` flips inside `feedTurns`, downstream of the gate. So a plain terminal tab runs inference while collapsed, and the refcount cannot be trusted as an idle signal until this is closed. ADR-0025 already claims this behaviour holds.

## Lazy start

Split download from load. `ensureDownloaded()` → `downloading` then `idle`, spawns nothing. `demand()` idempotent, dedupes concurrent callers onto one in-flight spawn. `unload({intentional:true})` → cooperative shutdown, SIGKILL backstop, `unloading` until exit observed. `initialize()` retained as `ensureDownloaded().then(demand)`. Boot call sites (`server.js:3405`, `:3411`, `:5745`) become download-only.

## Extraction mechanics

Shared `ModelHost` base both engines extend. **Reconsider the "keep every private name" shortcut:** it was chosen so the existing tests keep passing, but those tests reach into private worker state and are actively driving the lifecycle design in the wrong direction. Prefer black-box process tests (below) and let the private surface change where generations require it.

Per-engine hooks: enable gate, preflight, model prep, entry path, request framing, ready info. The enable gates genuinely differ — sticky is `!_enabled` (`sticky-note-engine.js:89`), STT is `!_enabled && !_sttEndpoint` (`stt-engine.js:44`), and a generic base check would silently break external-endpoint STT.

## Sequencing

All phases land on **one branch, in order** (decided). Live instance stays unsupervised until it merges.

- **Phase 0 — supervisor into the installed path** (`package.json:6-9`): crash respawn, Job Object guard, `--expose-gc`. **No automatic memory-triggered core restart** (withdrawn above).
- **Phase 1 — process extraction.** Base class + runtime including generations, the finalizer, both budget mechanisms, readiness deadline and timeout-retires-host — these are engine-internal and must **not** wait for a later phase, or the interim state is an unbounded crash/respawn loop. Then STT atomically, then sticky-note atomically, then Windows job attach + orphan sweep, then disconnect/watchdog/signals with the armed handshake, then diagnostics. *Fault isolation is real once both engines are converted and containment is proven before native execution.*
- **Phase 2 — compatibility and correctness.** Additive lifecycle status field behind capability negotiation (legacy field unchanged); close the ungated scrape path.
- **Phase 3 — lifecycle.** Lazy start, idle timers, leases, warm prefetch with rate limiting and cold-client path, UI states. Split this: it currently bundles API, process state, crash policy, timers, client protocol and UI into one release with no narrow rollback boundary.
- **Phase 4 — docs.** Specs `voice-input.md`, `sticky-notes.md`, `process-shutdown.md`; ADR superseding the eager-init rationale in ADR-0022/0025; `docs/history/` entry.

### Out of scope
The JSONL control plane stays in core. SEA is already broken for both features (the esbuild bundle contains no `parentPort`/`OfflineRecognizer`, and there is no `node_modules` at SEA runtime, so `new Worker(...)` cannot resolve) — this neither fixes nor worsens it, and the fix is a re-entry hazard; track separately. `RestartManager` thresholds retune after the move against real numbers. The eight JS-heap findings are hygiene.

## Verification

**Black-box process tests are the deliverable**, not private-field pokes:

- abort during model load; abort during inference
- `disconnect` without `exit`; `exit` without `disconnect`
- partial frame then exit; EOF mid-frame; coalesced frames; oversized length header
- timeout while inside synchronous native code
- **stale old-child exit arriving after its replacement is live** (the generation race)
- Windows job-assignment failure → child terminated, never reported ready
- parent SIGKILL → no orphaned host survives (`Get-Process node`)
- sleep/resume, and multi-day id/timer behaviour
- **no native addon loaded in the core** (assert against the module list)

Plus `test/longevity/process/model-host-isolation.test.js`: SIGKILL the host pid, assert the core survives, PTYs keep running, a new host appears after backoff, the old pid is gone. This fails before the change and is the point of it.

Preserve existing behaviour: `stt-worker-respawn.test.js` backoff `[1000,2000,4000,8000,15000]`, listener counts, `MODULE_NOT_FOUND`, give-up; all 17 in `sticky-note-engine.test.js`. `terminate() is never called` stays untouched — `ChildProcess` has no such API and nothing should shim it.

Then by hand on the real instance:

```sh
npm test && npm run test:integration && npm run test:longevity:server
curl -s http://127.0.0.1:7777/api/diagnostics    # rss vs heap, model_hosts[]
```

Boot with nothing expanded → ~150 MB, `model_hosts` empty. Expand a card → host appears, RSS rises ~1.5 GB. Collapse, wait 90 s → gone. `taskkill /F` the host mid-session → **PTYs keep running**, card shows reconnecting, new pid appears. Kill the core → no orphans.

**Honest expectation:** ~150 MB requires *both* models unloaded simultaneously. With a card expanded, RSS stays near 1.6 GB by design. 2237 → 150 is the floor, not the average.

---

## Also in scope: the pre-existing red suite

`main` is red before any of this work: **15 failing / 1880 passing**. Two unrelated classes, both must be driven to green. Do NOT paper over either with a retry, a skip, a relaxed assertion, or a raised `--timeout`.

**Class A — two genuine e2e assertion failures** in `test/e2e.test.js`: `should deliver broadcasts to a reconnected client` and `should send activity to a client that left a session (lobby state)`. These reproduce outside the full suite, so they are real defects.

**Class B — nine control-plane timeouts** in `test/control/routes.test.js` and `test/control/steering-helpers.test.js`, all `Timeout of 2000ms exceeded`. Diagnostic evidence gathered so far:

- `routes.test.js` alone: 22 passing in 520 ms.
- `e2e.test.js` + `routes.test.js`: routes still passes. So e2e is not the polluter.
- Full suite: every routes test times out.
- `npm test` passes no `--timeout`, so these inherit mocha's 2000 ms default (`test:integration` uses 60000).
- **Removing eager model loading dropped suite wall-clock 13m → 12m and turned three of these green with no change to the control code.**

That last point is the lead. It is cumulative resource accumulation across ~40 test files degrading the process until tests that take 520 ms miss a 2000 ms budget — the suite exhibiting in 13 minutes what the service exhibits over 9 days. Root-cause the accumulation. It is plausibly the same retention family as the eight verified JS-heap findings listed under "out of scope" above; if so, fix the shared cause.

## Also in scope: STT default scrutiny

Local STT is ON by default and eagerly loads 0.64 GB of sherpa weights at boot (`server.js:3405`), before the HTTP server exists. The equivalent question asked of sticky notes has never been asked of it: is the always-on default earning its cost? Measure and decide with evidence.

## Product bar

The result must be reliable, consistent, performant and frictionless, and must look and feel elegant on **both mobile and desktop browsers**. Verify like a user would — drive a real browser, capture screenshots on both viewports, and confirm the actual rendered experience rather than asserting it from code. Regressions in visual polish count as failures.
