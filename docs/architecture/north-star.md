# North Star — Architectural Intent for ai-or-die

**Owner:** SUP-ARCH (stability-hardening-2026 advisory lane)
**Status:** Living document — first cut after the stability-hardening-2026 campaign.
**Audience:** every supervisor, every contributor, every reviewer touching the daemon.

This document codifies the architectural intent of `ai-or-die` so that
ongoing fix lanes, future campaigns, and incoming contributors all
optimize toward the same long-term shape. It does not replace ADRs
(which record specific decisions) or specs (which define current
behavior). It is the lens through which an ADR or spec should be read.

When this doc disagrees with reality, fix the code OR fix the doc — but
do not let the gap silently widen.

---

## 1. Mission

`ai-or-die` is the **single-user, months-uptime, browser-tab-as-client
daemon** that wraps AI-coding CLIs (Claude, Codex, Copilot, Gemini, plus
a generic Terminal bridge) in `node-pty` and serves them through a
WebSocket-backed xterm.js front-end with a first-class file browser.

The product promise to its single user is **"start it once on Monday,
walk away, come back two months later, and it is still in the same
state — same sessions, same scrollback, same tabs, same flat heap."**
Anything that grows monotonically, leaks a handle, stalls the event
loop, corrupts on a crash, or breaks under Windows + PowerShell is a
breach of that promise.

It is **not** a hosted multi-tenant service, not a collaboration
platform, not a Claude-CLI replacement. It is the browser-quality
front-end for a single developer's local AI tooling, and the
**Windows-first cross-platform daemon** that runs underneath it.

---

## 2. Operating mode

- **Single user, one machine.** The daemon owns one user's filesystem;
  there is no per-request authorization beyond an optional shared
  bearer token, and there is no row-level access control.
- **Months-long uptime.** The cadence of restart should be measured in
  weeks at worst, not days. Every cache, every Map, every buffer must
  survive a 60-day idle horizon without monotonic growth.
- **Browser tab as canonical client.** Multiple tabs may attach to the
  same session over time; the server is the source of truth for
  scrollback, session state, and CWD. The client is durable but
  reload-tolerant.
- **Windows 11 + PowerShell 7 is the primary deployment target.**
  macOS and Linux are first-class secondaries (CI covers all three).
  Anywhere a tradeoff arises, Windows wins by default. See
  [`CLAUDE.md`](../../CLAUDE.md) for the full Windows-first rulebook —
  this doc does not restate it, only points to it.
- **Local-first; CI is the cross-platform gate, not the unit-test
  gate.** See `docs/agent-instructions/06-local-first-then-ci.md`.

---

## 3. Layering

The daemon decomposes into four layers. The rule of layering is
**what crosses what** — not just where the files live.

```
┌─────────────────────────────────────────────────────────────┐
│ Client (src/public/)                                        │
│   app.js, plan-detector.js, session-manager.js,             │
│   file-browser.js, file-watcher-client.js,                  │
│   heartbeat-watchdog.js, splits.js                          │
│   ↑ Talks to Server via WebSocket + REST + SSE only.        │
└──────────────────────────────┬──────────────────────────────┘
                               │  (network boundary)
┌──────────────────────────────┴──────────────────────────────┐
│ Server (src/server.js, bin/supervisor.js)                   │
│   Express + ws + REST handlers + Tool Registry +            │
│   RestartManager + diagnostics + disk circuit breaker.      │
│   Owns the WS protocol contract; serializes cross-cutting   │
│   concerns (auth, rate limit, validatePath, OSC 7 dispatch).│
└──────────┬────────────────────────────────┬─────────────────┘
           │                                │
┌──────────┴──────────┐         ┌───────────┴────────────────┐
│ Bridges (src/*-bridge.js)     │ Persistence (src/utils/)   │
│   BaseBridge + ClaudeBridge   │   SessionStore (atomic     │
│   + CodexBridge + CopilotB.   │   write + DISK-01 fsync),  │
│   + GeminiBridge + Terminal.  │   UsageReader (.jsonl[.gz]),│
│   Owns node-pty lifecycle,    │   CircularBuffer,          │
│   per-session output buffer,  │   log-rotator,             │
│   _ptyDisposables, OSC 7      │   file-watcher (chokidar). │
│   parser.                     │                            │
└─────────────────────┘         └────────────────────────────┘
```

**Rules that bind the layers:**

1. **Client never reaches into Server internals.** Communication is
   through the documented WS frames + REST endpoints. New client
   capabilities require server-side protocol changes, not server-state
   poking.
2. **Bridges never import Persistence.** A bridge's job is "spawn,
   stream, kill"; it does not save sessions. The server-level
   `SessionStore` periodically snapshots the bridge's bounded
   `outputBuffer` via the bridge's public API.
3. **Persistence never imports Bridges.** `SessionStore` and
   `UsageReader` work on serialized state; they do not understand PTY
   lifecycle.
4. **Server is the only cross-layer orchestrator.** Cross-cutting
   work — diagnostics, disk_full broadcast, session eviction, restart
   policy — lives at the server layer or in dedicated utilities the
   server composes.
5. **Cross-platform shims live in utilities, not in callers.** Path
   canonicalization, `realpathSync.native` + `\\?\` strip,
   `where.exe` vs `which`, ConPTY vs xterm-256color — all one-shop
   helpers. Bridges and routes don't branch on `process.platform`.

When a new feature wants to violate one of these rules, write a new
ADR; do not silently widen the seam.

---

## 4. The bounded-structure invariant

**Every long-lived server-side container — every cache, buffer, Map,
queue, array — must be bounded.** This is the single most important
invariant for months-long uptime, and the campaign demonstrated
exactly what happens when it is violated: the SOAK-05m run drove the
mock-clock workload into a 178k-entry `claudeSessions` Map that
dominated the event-loop, the working-set heap, and the GC pause
distribution.

**Canonical bounded-structure patterns:**

| Pattern | Lives in | Use when |
|---|---|---|
| `CircularBuffer` (80 LOC) | `src/utils/circular-buffer.js` | Fixed item-count ring buffer with O(1) push and O(k) `slice(-k)`. PTY output, message history, plan trigger windows. |
| `_capBufferByBytes` byte-cap discipline | `src/base-bridge.js`, `src/public/plan-detector.js` | When per-item size is unbounded. Cap on bytes, never on item count — `PlanDetector` learned this the hard way at 10000 × 8 KB ≈ 80 MB. |
| `log-rotator.js` (DISK-02) | `src/utils/log-rotator.js` | Bounded JSONL on disk: size + age + preserve-N-newest + atomic gzip + Windows EBUSY fallback. Use for any new append-only on-disk surface. |
| `_inFlightSave` promise-chain mutex | `src/utils/session-store.js` (DISK-04) | Serialize concurrent overlapping writers to the same shared resource without admitting unbounded work. |
| Time-windowed array + `_CAP_TIMESTAMPS` belt-and-braces | `bin/supervisor.js` (PROC-01) | When a buffer is bounded by a sliding wall-clock window, ALSO cap absolute count — pathological flap rates can exhaust the window-trim alone. |
| Diagnostics with **wall-clock budget + result cache + stale flag** | `_sampleDiskUsage` in `src/server.js` (DISK-03) | When an observation walk could exceed event-loop budgets. 50 ms wall-clock budget + 60 s cache + `*_stale: true` on timeout. |

**The rule:** if you are about to introduce a Map, Set, array, queue,
or cache that is appended to from any code path that runs for the
process lifetime, you must:

1. Pick a bound (count, bytes, age, or some composition of these).
2. Pick an eviction policy (FIFO, LRU, byte-cap-shift, age-prune,
   preserve-N-newest).
3. Decide whether the eviction is **bounded-step or sub-linear**.
   Linear sweeps are an architectural smell at scale — PROC-04 is
   the long-tail of fixing this everywhere.
4. Surface the size in `_collectDiagnostics()` so the soak harness
   can graph it.

The campaign's audit showed that **the codebase already gets this
right in most places** (output buffer, plan-detector, supervisor
timestamps, fs-watch handles, `_ptyDisposables`). The north-star
direction is to keep new structures inside the invariant, and to
gradually move the linear-eviction outliers to sub-linear shapes.

---

## 5. Resource lifetime contract

**Every spawned process, file descriptor, listener, timer, watcher, and
socket is paired with its disposal.** The disposal site is named, is
called from every exit path including error paths, and is idempotent.

**Canonical disposal patterns:**

- **`_ptyDisposables` array** (`src/base-bridge.js`). Every listener
  attached to a PTY pushes its `Disposable` into the per-session
  array; `_drainDisposables` runs on every exit path. New PTY
  listener? It MUST be registered here.
- **`_cleanupFsWatchSession(sessionId, reason)`** (`src/server.js`).
  Single chokidar-watcher teardown function with a `reason` tag for
  diagnostics. Called from session deletion, replacement, eviction,
  and full server close. Mutating the watcher Map elsewhere is a bug.
- **`removeAllListeners()` in `cleanupWebSocketConnection`**
  (`src/server.js`, PROC-03). Defense-in-depth: catches future
  contributors who attach a one-off `ws.once('pong', ...)` and forget
  the matching teardown. Idempotent + try/catch-wrapped because it
  runs inside `ws.on('close')`.
- **`setupAutoSave`-style interval + shutdown clear pair**
  (`src/server.js`). Every `setInterval` / `setTimeout` that lives
  longer than a single request is held in a named instance field and
  cleared explicitly in `close()`.
- **`SessionStore._inFlightSave` finalizer** (DISK-04). The
  promise-chain mutex always `release()`s in `finally`, even on
  failure, so a failed save never deadlocks the queue.

**Test for "is this disposal complete":** can you run 1000 cycles of
attach-then-detach in a loop and watch `_collectDiagnostics()` return
to baseline (handles, FDs, listener counts, watcher entries) within
30s of the loop ending? CLIENT-02's 25-cycle reconnect-storm test is
the codified shape; new lifetime contracts should follow it.

**The rule:** for every `new X()` / `spawn()` / `addListener()` /
`watch()` / `createReadStream()` / `setInterval()` you write, the same
PR adds the matching disposal in a named cleanup function reachable
from `close()`. If you cannot reach that disposal from a top-level
shutdown, the lifetime is wrong.

---

## 6. Event-loop budget

The event loop is the daemon's only thread of work that matters. Every
piece of code competing for it must respect the same budget.

**Steady-state targets** (the bar a healthy soak passes):
- `event_loop.p99_ms` < **50 ms**
- `event_loop.max_ms` single-sample < **200 ms**
- Recovery to within 5 ms of idle baseline within 5 s of any synthetic
  burst ending.

**Synthetic-stress envelope** (the bar SUP-SOAK reports against — the
bar at which fixes are CANARIED, not the bar at which the daemon ships
broken):
- Workload-matched per-fix canaries: the fix must show measurable
  improvement on its declared gate vs a baseline run with the same
  workload mix and duration. Cross-workload-mix comparisons are
  confounded (SOAK-05g lesson, codified in
  `docs/audits/rel-ci-matrix.md`).

**Instrumentation:**
- Server diagnostics endpoint (`_collectDiagnostics`) is the
  authoritative observation surface. Logged every 5 minutes by
  default, served over REST on `/api/diagnostics`.
- `perf_hooks.monitorEventLoopDelay` histogram drives the longevity
  harness's `event_loop.p99_ms` / `event_loop.max_ms` gates. Lives
  in `test/longevity/harness/diagnostics-sampler.js`.
- Per-fix lanes wire their target metric into the diagnostics block
  before shipping the fix — instrumentation is part of the change,
  not an afterthought.

**Patterns that keep us inside the budget:**

- **Output coalescing (16 ms / 60 fps) + 32 KB max coalesce cap**
  (ADR-0009 + ADR-0011). Bounded worst-case stringify/send cost.
- **Binary WS frames for terminal output**, with compression
  explicitly disabled to avoid zlib thread-pool contention
  (ADR-0011 D).
- **`process.nextTick` input priority** so keystrokes preempt output
  flush timers under load (ADR-0011 C).
- **Cached-and-budgeted disk walks** (DISK-03 `_sampleDiskUsage`)
  rather than synchronous `readdirSync` storms (HOT-04 lesson).
- **Async hashing with a bounded queue** in `file-watcher.js`
  (HOT-07) rather than sync hash on the watcher hot path.
- **Process-wide validation cache** for OSC 7 `validatePath` results
  (HOT-06) — the biggest single win of the campaign at −51 % p99.
- **Streaming per-session JSON.stringify with `setImmediate` yields**
  (HOT-10) rather than a single all-sessions stringify cliff.
- **WS frame size guard** rejecting >1 MB at the application layer
  before `JSON.parse` (HOT-08).

**Anti-pattern (do not introduce):** any synchronous `readFileSync`,
`readdirSync`, sync hash, sync stringify of unbounded size, or
unyielded loop over a Map whose growth model is "however much the
caller does." The HOT lane catalogued five of these; the next
campaign should find zero new ones.

---

## 7. Failure-mode discipline

The daemon's resilience comes from **three layers of compensating
machinery**, each operating at a different timescale. Each layer is
independently useful; the composition is what gives the single-user
deployment its survivability.

| Layer | Timescale | Code | What it does |
|---|---|---|---|
| **Process-level — supervisor tiered breaker** | minutes–hours | `bin/supervisor.js` (PROC-01) | Tier-1 (≥3 crashes/30s → 60s delay) and Tier-2 (≥5/1h → 5min + IPC warning). **Never `process.exit(1)` from the crash path** — the single-user deployment has no orchestrator above us; if the supervisor gives up, the user has nothing to talk to. |
| **In-process — RestartManager + per-child guards** | seconds–minutes | `src/restart-manager.js`, `src/stt-engine.js` (`_stopping`), `src/vscode-tunnel.js` (`_restarting`) | RSS-based GC threshold, 5-minute restart rate-limit, per-child re-entrancy guards, shutdown-vs-respawn race protection. |
| **Operation-level — disk + listener + breaker broadcast** | per-operation | `src/server.js` (`_enterDiskFull`, `_broadcastDiskFull`, `cleanupWebSocketConnection`) | Edge-triggered `disk_full` WS broadcast with hysteresis; structured `{type:'error',code:'disk_full'}` on session-create refusal; idempotent listener teardown. |

**The PROC-01 rule** is the load-bearing one and worth repeating: a
single-user daemon's supervisor must never permanently exit. Fleet
patterns ("hard exit after N crashes, let systemd / k8s / pager
restart externally") **do not transfer**. Tier-2's 5-min cadence drops
worst-case respawn volume by two orders of magnitude (28 800/day →
288/day) while keeping the daemon technically alive so the user's
browser has something to talk to whenever the underlying defect is
fixed.

**The cross-layer composition** (DISK-03 + PROC-01 + future
CLIENT-04) demonstrates the pattern works without explicit
coordination: each layer reacts to its own signal; the union of their
behaviors gives the user a recoverable system without a paging
operator. New failure-class work should fit into one of the three
layers, not invent a fourth.

---

## 8. Cross-platform invariants

**Windows-first.** See [`CLAUDE.md`](../../CLAUDE.md) for the full
rulebook. The architectural shape that flows from it:

- **All path canonicalization through one place.** `validatePath()`
  runs `realpathSync.native` (handles 8.3 short names) and strips
  `\\?\` long-path prefix BEFORE lexical compare, on both sides.
  Bridges and routes do not re-implement this.
- **Native subprocess discovery through the platform-detection
  helper** in `BaseBridge` — `where.exe` vs `which`, ConPTY vs
  xterm-256color, `pwsh.exe` vs `powershell.exe` vs `cmd.exe`.
  Subclasses pass `binaryNames` arrays that include both Unix and
  Windows variants; the discovery loop silently skips non-existent
  paths.
- **OSC 7 graceful degradation.** OSC 7 ships for shells that emit it;
  `cmd.exe` (which cannot emit OSC 7 from `prompt`) surfaces a
  switch-to-PowerShell hint rather than a missing-feature error.
  CLI bridges (Claude/Codex/Gemini) report `liveCwd === null` —
  documented in `docs/specs/bridges.md`.
- **Atomic-write recipe with platform fork.** DISK-01's six-step
  recipe (open → write → fsync(fd) → close → rename → fsync(dir))
  skips dir-fsync on Windows (NTFS journal +
  `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` provide the equivalent
  guarantee). The fork lives in `session-store.js` /
  `log-rotator.js`; callers don't branch.
- **Output paths returned to the client are normalized to forward
  slashes for consistency;** storage form is whatever the platform
  produces.

**The rule:** if a new code path needs a platform branch, it belongs
in a helper (or a Bridge subclass `buildArgs`), not at the call site.
A diff that adds `if (process.platform === 'win32')` inside a route
handler is a refactoring opportunity, not a feature.

---

## 9. Verification fabric

`test/longevity/` is the long-running-validation surface. It is more
than a test directory — it is the **observation layer that backs every
load-bearing claim in this doc**.

```
test/longevity/
  harness/         # Workload runner, gates, samplers
  event-loop/      # HOT-01..05 regression tests
  process/         # PROC-01..03 regression tests
  disk/            # DISK-01..04 regression tests
  browser/         # CLIENT-01..03 Playwright specs
  results/         # JSONL output, per-run timestamped dir
```

**Cadence (codified by REL-01):**

- **Per-PR** — affected gates re-run via the workload-matched canary
  pattern. SUP-REL adjudicates regressions. Gate set declared by the
  fix lane in the PR body ("gates I affect: X, Y").
- **Bundled merge gate** — full ~60-min soak across all 10 workloads
  with capped mock-clock injection (SOAK-05o). This is the
  stability-hardening campaign's exit criterion.
- **Nightly** — Linux smoke (4 h subset) optional after first stable
  bundle.
- **Weekly** — 12-h overnight on Linux, confirmatory. Not blocking on
  any single PR but blocking on a campaign exit.
- **Cross-OS** — full CI matrix (Windows + macOS + Linux) on every PR
  for unit + integration; longevity suites in their own CI job.

**The rule:** any new gate-worthy invariant (a new bounded structure,
a new listener type, a new background tick) ships with both a unit
test (deterministic, ≤ 1 s) AND a longevity test (mid-time-scale,
60 s–10 min) AND a sample in `_collectDiagnostics()`. The trio is the
contract; missing any one means the invariant cannot be enforced.

---

## 10. North-star directional bets

Where the codebase wants to go over the next two to four campaigns.
Each bet has a horizon and a triggering condition; none is "fix
tomorrow." These are the directional commitments that future ADRs and
specs should harmonize with.

### Bet 1 — Typed `BoundedX<T>` family in `src/utils/`

**Horizon:** 2 campaigns.

Today the codebase has `CircularBuffer` (ring + count cap),
`_capBufferByBytes` (byte cap shifting), the `log-rotator` primitives
(size/age/preserve-N), the supervisor's `crashTimestamps` (window + cap
belt-and-braces), and `_inFlightSave` (mutex). Each is correct in
isolation but each is its own ad-hoc shape.

Direction: extract these into a typed `BoundedX<T>` family (count,
bytes, age, multi-axis, mutex-queue) with a uniform diagnostics hook so
new bounded structures pick the right shape off the shelf instead of
ad-hoc-ing it. CLIENT-04 / DISK-05+ are the natural first consumers.

### Bet 2 — Sub-linear eviction across all evictable Maps (PROC-04 reified)

**Horizon:** 1–2 campaigns; **trigger:** real-user session count
crosses ~10 K.

The campaign uncovered that `_evictStaleSessions` is O(n) per sweep.
At realistic single-user counts (≤ 500) this is invisible; at the
synthetic 178 k that SOAK-05m drove it to, it dominates the event
loop. The right shape long-term is a time-indexed expiry heap or
sub-linear sweep that scales with eviction count, not Map size.

Direction: codify a "no linear eviction in long-lived loops" rule as
soon as one Map's eviction cost is ever observed on the production
diagnostics tick — and apply it across every evictable Map at once,
not one-off-per-Map.

### Bet 3 — Diagnostics endpoint is the operator's primary observation surface

**Horizon:** ongoing; **direction:** every PR adds to the diagnostics
shape; no PR should ever introduce a long-lived structure that is
invisible to `/api/diagnostics`.

Direction: **never log+grep first.** If a new metric matters to
debugging, it goes into `_collectDiagnostics()` AND the diagnostics
spec AND the longevity harness's gate evaluator. The 5-minute
heartbeat log line is already a working surface; future polish is a
small built-in `/diagnostics` HTML view so the operator doesn't curl
+ jq.

### Bet 4 — Generalized Bridge so adding a CLI is 50 lines, not a fork

**Horizon:** 1 campaign; **trigger:** the next CLI (likely Copilot
expansion, or whatever Anthropic ships).

`BaseBridge` already gets most of the way (ADR-0001). The remaining
fork pressure is: tool-specific "dangerous command" patterns, custom
argv shapes, OSC 7 vs no-OSC-7 bridges. Direction: push every
remaining branching point into the subclass-customization surface
(`buildArgs`, `dangerousPatterns`, `supportsLiveCwd`, etc.) so the
next bridge is *truly* a 50-line subclass.

### Bet 5 — Cross-lane integration brief / review pattern as institutional muscle

**Horizon:** ongoing; **trigger:** every multi-supervisor effort.

DISK ↔ HOT-10 and DISK ↔ SOAK both validated the
publisher-posts-brief / consumer-implements / publisher-reviews-seam
pattern (codified in `docs/history/disk-hygiene-2026.md` § "Cross-lane
integration pattern"). Direction: treat this as the default
coordination shape for any cross-lane work; SUP-REL flags PRs that
touch a seam without one.

---

## 11. What we deliberately do NOT do

The temptations to resist. Each of these would make `ai-or-die` a
different product; pursuing any of them in an evolutionary fashion
would warp the daemon's coherence.

- **Multi-user.** No per-user identity, no per-user sandbox, no
  per-user auth model. The optional bearer token is a "is this my
  local browser, or a stranger on the LAN" check, not an identity
  system. If multi-user ever becomes a real product direction,
  it needs a clean break, not an incremental retrofit.
- **Real-time collaboration.** Multiple tabs may attach to the same
  session, but the model is one-user-many-tabs, not many-users-one-doc.
  No CRDT, no operational transform, no presence cursors.
- **Server-side workflow state machine.** The server proxies CLI
  output and persists session metadata; it does not interpret the
  agent's reasoning, sequence tool calls, or implement business
  workflows. Anything that walks toward "ai-or-die orchestrates the
  agent" belongs in a different product.
- **Auto-modifying the user's shell rc files.** ADR-0019 made this
  explicit for OSC 7; the principle generalizes — user environment is
  sacrosanct. Wrappers and transient injections are okay (ADR-0021);
  silent persistent rc edits are not.
- **Hosted / SaaS variant.** Every architectural choice in this doc
  assumes "runs on the user's machine." A hosted version would need
  to revisit at minimum: persistence, auth, sandboxing, rate
  limiting, disk quota, restart policy, and bridge child-process
  isolation.
- **Plugin / extension system.** Sounds friendly; expands the
  trusted surface to "anything the user installed." If a capability
  is worth shipping, it ships as a Bridge subclass or a server route
  in the main repo.
- **JS bundlers, build systems, transpilers.** Node CommonJS, no
  build step. Per `CLAUDE.md`. Adding a bundler crosses a
  one-way door — defer until forced.
- **Replacing CLI tools with API clients.** `ai-or-die` proxies the
  user's installed CLIs precisely so the user controls auth, billing,
  model version, system prompts, and tool capabilities at the CLI
  layer. Reimplementing that against a vendor API loses everything.

---

## 12. Decision rules

When in doubt — and a fast reviewer prompt for any PR that touches
the daemon — prefer:

1. **The smaller blast radius.** A 5-line fix in one file beats a
   30-line refactor across three. Re-evaluate the broader refactor as
   its own ADR if needed.
2. **The bounded structure over the unbounded one.** Cap on bytes,
   cap on age, cap on preserved-N — pick at least one. "It's normally
   small" is not a bound.
3. **The explicit disposal over the GC-will-eventually-handle-it.**
   Mirror the named pattern in the codebase (`_ptyDisposables`,
   `_cleanupFsWatchSession`, `removeAllListeners`,
   `clearInterval(...)`). Idempotent. Inside try/catch on shutdown
   paths.
4. **The diagnostics-instrumented metric over the
   you'll-just-have-to-grep-the-log signal.** New invariant → new
   diagnostics field → new gate. The trio.
5. **The regression test that fails before and passes after.**
   ADR-0006 is the canonical decision; every fix-lane in
   stability-hardening-2026 honored it. Don't break the streak.
6. **The cross-platform shim over the call-site `process.platform`
   branch.** If you find yourself writing `if (process.platform ===
   'win32')` more than once, the shim is missing.
7. **The Windows-correct path over the Unix-correct path** when they
   conflict. macOS and Linux are first-class; Windows is primary.
   `realpathSync.native` + `\\?\` strip + 8.3 expansion are not
   optional.
8. **The supervisor-survives over the supervisor-gives-up.** Never
   `process.exit(1)` from a crash-classification path. Tier and
   throttle.
9. **The brief-and-seam-review over the no-coordination handoff** for
   any cross-lane work. See the DISK ↔ HOT-10 pattern.
10. **The doc that gets updated in the same PR as the code.**
    Specs in `docs/specs/`, ADRs for direction changes, history notes
    for solved problems, this doc when the architecture itself
    shifts. Memory is in the docs, not the LLMs.

---

## References

- [`CLAUDE.md`](../../CLAUDE.md) — project conventions; Windows-first
  cross-platform rule.
- [`docs/agent-instructions/00-philosophy.md`](../agent-instructions/00-philosophy.md)
  through `08-multi-agent-consultation.md` — the workflow rules this
  doc presumes.
- [`docs/adrs/`](../adrs/) — every accepted ADR. **Never contradict;
  supersede.**
- [`docs/specs/disk-budget.md`](../specs/disk-budget.md) — canonical
  disk-surface spec.
- [`docs/specs/client-longevity.md`](../specs/client-longevity.md) —
  browser-side longevity instrumentation contract.
- [`docs/specs/bridges.md`](../specs/bridges.md) — bridge contract
  (live CWD, OSC 7 opt-in, etc.).
- [`docs/history/disk-hygiene-2026.md`](../history/disk-hygiene-2026.md)
  — DISK lane post-mortem (includes the cross-lane integration
  pattern).
- [`docs/history/proc-supervisor-2026.md`](../history/proc-supervisor-2026.md)
  — PROC lane post-mortem (tiered supervisor lesson).
- `docs/history/stability-hardening-2026-sup-client.md` — CLIENT lane
  post-mortem (bounded-by-bytes lesson, audit-by-grep limits).
- [`docs/architecture/overview.md`](overview.md) — current
  component-relationship map (Mermaid).
- [`docs/architecture/bridge-pattern.md`](bridge-pattern.md) — bridge
  layer mechanics.
- [`docs/architecture/websocket-protocol.md`](websocket-protocol.md) —
  WS frame catalog.
- `test/longevity/README.md` — verification fabric usage.
- `docs/architecture/deferred-from-stability-hardening-2026.md` —
  open architectural questions the campaign deferred.
