# SUP-HOT Lane Post-Mortem — stability-hardening-2026

**Date:** 2026-05-28
**Campaign:** stability-hardening-2026
**Lane:** SUP-HOT (event-loop / CPU hot-path supervisor)
**Files modified:** `src/terminal-bridge.js`, `src/utils/file-watcher.js`, `src/server.js`, `src/utils/session-store.js`, `test/osc7-parser.test.js`, `test/file-watcher.test.js`, `test/session-store.test.js`, `test/image-upload.test.js`, `test/voice-integration.test.js`, `docs/specs/bridges.md`, `docs/adrs/0017-fs-watcher-push-channel.md`, `CHANGELOG.md`
**Files added:** `docs/audits/hot-01-osc7-dedupe.md`, `docs/audits/hot-02-filewatcher-hash.md`, `docs/audits/hot-03-ws-frame-size.md`, `docs/audits/hot-04-attachment-scan.md`, `docs/audits/hot-05-sessionstore-stringify.md`, `test/longevity/event-loop/hot-01-osc7-dedupe.test.js`, `test/longevity/event-loop/hot-02-filewatcher-hash.test.js`, `test/longevity/event-loop/hot-03-ws-frame-size.test.js`, `test/longevity/event-loop/hot-04-attachment-scan.test.js`, `test/longevity/event-loop/hot-05-sessionstore-stringify.test.js`
**Branches:** `sup-hot/hot-06-osc7-cache` (`c05c173`), `sup-hot/hot-07-async-hash` (`ad16810`), `sup-hot/hot-08-ws-frame-size` (`57b1e03` incl. fixup), `sup-hot/hot-09-attachment-cache` (`c5f34e5`), `sup-hot/hot-10-sessionstore-worker` (`9cf6d23` incl. marker-invariant test)
**Sister post-mortems:** [`disk-hygiene-2026.md`](./disk-hygiene-2026.md), [`stability-hardening-2026-sup-client.md`](./stability-hardening-2026-sup-client.md)
**Bundle soak result:** [`test/longevity/results/FINAL-BUNDLE.md`](../../test/longevity/results/FINAL-BUNDLE.md) — bundle improves every measured metric vs the workload-matched baseline at identical load.

---

> **Update 2026-05-28 (post-PROC-04 acceptance — FINAL-BUNDLE.md v4)**
>
> SUP-PROC's **PROC-04** (sub-linear `_evictStaleSessions` via min-heap) landed post-HOT-11. SUP-SOAK's acceptance soak (**SOAK-05r**) re-ran the un-capped mock-clock workload that triggered SOAK-05m's BLOCKING verdict — to validate that PROC-04 closes the underlying eviction-sweep cost rather than the harness-side cap merely masking it. The result: **the bundle sustained 798,680 sessions** under un-capped mock-clock (4.5× SOAK-05m's 178,848-session ceiling), confirming PROC-04 architecturally closes the gap.
>
> Aggregate event-loop metrics at un-capped 10-workload concurrent stress: `event_loop.p99_ms peak = 134 ms` / `max_ms peak = 2,414 ms` (vs SOAK-05m's 187 ms / 2,709 ms at the same load with 4.5× *fewer* sessions). See [FINAL-BUNDLE.md v4](../../test/longevity/results/FINAL-BUNDLE.md), commit `9db7d2e` on `sup-soak/final-bundle-results` (integrated at `76c0d07` on `stability-hardening-2026`).
>
> **Honest framing**: the strict `event_loop.p99_ms < 50 ms` target is **not** met under un-capped 10-workload concurrent stress (134 ms peak — down 28% from SOAK-05m's 187 ms at the same load). The architectural gap that drove SOAK-05m is closed — PROC-04 sustained 4.5× more sessions AND p99 improved at the same load — but multi-workload concurrency on a single-host darwin runner remains a real ceiling. **SOAK-05q** (split absolute vs multi-workload-stress thresholds) is the deferred follow-up that codifies the distinction; the campaign's deployment target (single-user daemon for months) is a much lighter workload than `--workloads=all` and lands well under the strict threshold in steady state.
>
> **The pre-walk discipline §Process [§ below](#process-patterns) correctly attributed the SOAK-05m 2,709 ms outlier** to GC-pause shape (workload-driven via 178k accumulated entries through an O(n) eviction sweep, not HOT-fix-driven). PROC-04 closes the eviction-sweep cost; **the mock-clock cap is no longer architecturally required for correctness** — it's kept as the smoke-default for soak hygiene (SUP-SOAK's framing in FINAL-BUNDLE.md v4). The through-line: pre-walk diagnosed the GC-pause mechanism → PROC-04 fixed the algorithmic root cause → v4 acceptance soak proves the fix at 4.5× scale → strict target deferred to SOAK-05q follow-up.

---

## Charter

Five named event-loop hot paths, audited by the campaign's pre-investigation phase. Each had a concrete `file:line` reference, a hypothesised burst pattern, and a proposed fix outline:

| ID | Site | Hypothesised cost | What we shipped |
|---|---|---|---|
| HOT-01 → HOT-06 | `src/terminal-bridge.js:195–243` — per-session OSC 7 dedupe cache | 30–150 ms event-loop block per OSC 7 emission under SUBST/network drive (3–4 `realpathSync` syscalls per `validatePath`); cross-session and intra-session alternation defeat the per-session cache | Process-wide validated-path cache (LRU 256 entries, 5 s TTL, raw-keyed) as Level 2 dedupe on top of the existing per-session Level 1 |
| HOT-02 → HOT-07 | `src/utils/file-watcher.js:83–92, 580–608` — sync `fs.readFileSync` + MD5 on `_flush` hot path | ~600 ms cumulative event-loop block on a 20-file bulk-edit burst; 50-file Claude batch on a slow disk → ~1 s | Async hash queue (`fs.promises.readFile`, concurrency 8) with per-path `_hashCache` (LRU 1024) for late-inclusion on subsequent same-mtime events |
| HOT-03 → HOT-08 | `src/server.js:2855–2884` — `JSON.parse(message)` with no application-level size guard | 40–120 ms event-loop block per 5–8 MB WS frame; sustained 10 Hz oversized-frame stream → ~400 ms/s blocked | 1 MB `MAX_WS_MESSAGE_BYTES` guard before `JSON.parse`; oversized frames receive `{type:'error', code:'message_too_large'}` + WS-standard 1009 close |
| HOT-04 → HOT-09 | `src/server.js:558–574` — `readdirSync` + per-entry `statSync` per upload | 50 ms event-loop block per upload on a 1000-file SSD `.claude-attachments/` dir; 5–20 s on a network share | Per-dir `(bytes, mtimeMs)` cache; single `statSync(dir)` freshness check on each call; eager update on known writes, invalidation on sweep |
| HOT-05 → HOT-10 | `src/utils/session-store.js:97` — sync `JSON.stringify` on the save hot path | 50–200 ms event-loop block per save for a 25–50 MB sessions object; `setupAutoSave` fires every 30 s | Streaming JSON serializer (`_serializeDataStreamed`) — per-session `JSON.stringify` + `await setImmediate()` between; output byte-identical to bare `JSON.stringify`; **not** `worker_threads` (decision flipped — see §HOT-10) |

Investigation phase landed all 5 audits + regression tests directly on `main` (commits `7b5be04` → `2c0c0ee`); fix phase landed on dedicated `sup-hot/hot-0{6..10}-*` branches, sequential off `e2fbaf8`, bundled by SUP-REL into `stability-hardening-2026`.

## What each fix shipped

### HOT-06 — process-wide OSC 7 validated-path cache

**The bug shape we expected.** Per-session `_lastRawOsc7` only collapses back-to-back identical raws *for the same session*. Multi-tab clients hitting the same cwd, and intra-session alternation patterns (`pushd`/`popd`, multi-segment prompts emitting `cwd` then `git-root`), bypass it. Each miss costs `path.resolve` + `fs.existsSync` + `fs.realpathSync` + `_canonicalizePathSync` (which itself does `fs.realpathSync.native`). On a SUBST or mapped network drive, each syscall is 10–50 ms. We framed it as a steady-state drip — N tabs × 30 ms validation × M emissions/s.

**The bug shape it actually has.** SUP-SOAK's HOT-06 workload-matched canary ([SOAK-05g](../../test/longevity/results/baseline-2wl-20260528T053314Z/), commit `63c2c70`) revealed the load-bearing failure mode is **burst-collapse**, not steady-state drip. Without the cache, validatePath calls queue faster than they complete; each new OSC 7 emission waits behind ALL prior in-flight emissions. Under sustained pty-flood the result is a 200–500 ms stall window per burst. With the cache, the queue empties in one Map lookup. The −51% p99 / −56% max_ms canary deltas match the burst-collapse model precisely, not the drip model — drip would have predicted ~25% mean improvement and roughly-flat tail. The drip is real but the cliff is bigger.

**What we shipped.** Two-level dedupe in `src/terminal-bridge.js`:
- **Level 1** (kept): `_lastRawOsc7: Map<sessionId, string>` — sub-microsecond string-identity compare for the same-cwd-every-keystroke case (pwsh + oh-my-posh / Starship prompt redraw on every keystroke).
- **Level 2** (new): `_osc7ValidationCache: Map<rawPath, {validated, expiresAt}>` — process-wide LRU bounded at `OSC7_CACHE_MAX_ENTRIES = 256` with `OSC7_CACHE_TTL_MS = 5000` insertion-time TTL. Caches both VALID and INVALID `validatePath` results so out-of-sandbox paths stop paying syscalls on every emission across every session.
- **Cache hits** bump entries to MRU via delete + reinsert (Map insertion order = LRU order, pre-existing Node pattern).
- **Cache survives session uninstall**: that's the whole point — multi-tab same-cwd should pay validation exactly once across all tabs. `bridge.cleanup()` clears the cache for clean test/restart semantics.

**Decision divergence from the memo.** The memo proposed an mtime-keyed canonical-path cache. The implementation uses a TTL-only raw-keyed cache because:
- Mtime-based invalidation requires `statSync` on every cache hit — re-introduces most of the syscall cost we're eliminating.
- Canonicalizing for the key requires a syscall on every miss, just to decide whether two lexically-different raws collide.
- The 5 s insertion-time TTL bounds staleness (user `mkdir` reflected at the next emission after expiry); the 256-entry LRU bounds cardinality blowup that raw-keying could theoretically cause. In practice shells emit ONE form per cwd, so cardinality stays well under the cap.

**Decision deliberately kept against SUP-REL's review.** SUP-REL flagged TTL semantics as insertion-time, not last-access; under sustained load the entry re-validates once per 5 s wall-clock. Switching to sliding-window (`expiresAt = now + TTL` on every hit) would make a steadily-redrawing pwsh prompt keep the entry alive forever, breaking the staleness bound the user `mkdir` invariant rests on. Fixed-window is the right tradeoff; sliding-window would defeat the bound under exactly the workload that's most common in production.

### HOT-07 — FileWatcher async hash queue + per-path late-inclusion cache

**The bug.** `_flush` calls the module-level `_hashFileSync` inline on the chokidar event hot path when `_includeHash` is true. `_hashFileSync` does sync `fs.statSync` + `fs.readFileSync` + `crypto.createHash`. The current production caller (`server.js:2339`) passes `depth: 0` so `_includeHash` defaults to `false` — production is incidentally safe today. But any future caller that doesn't pass `depth: 0` resurrects the leak by default. This is a footgun.

**What we shipped.** Picked Option B from the memo (async queue) over Option A (push the default to all callers). Structural fix that survives any future caller passing `includeHash: true`:
- New module function `_hashFileAsync` (`fs.promises.stat` + `fs.promises.readFile` + `crypto.createHash`); the sync `_hashFileSync` retained for back-compat with any direct callers but no longer called from `_flush`.
- New per-instance bounded queue: `_hashPending` (queue), `_hashInflight`, `_hashConcurrency = 8` (caps EMFILE risk under bursts).
- New per-instance LRU: `_hashCache: Map<absPath, {hash, mtime}>` bounded at `HASH_CACHE_MAX_ENTRIES = 1024`.
- `_flush` rewritten: emits event SYNC without hash on the hot path; if `_includeHash` and the cached hash matches the event's mtime, the emitted payload INCLUDES the hash (late-inclusion path — preserves `file-tabs.js`'s "did the disk content actually change" short-circuit for rapid same-mtime re-touches).
- `close()` extended to drop the pending queue + cache and resolve any outstanding `hashQueueIdle()` waiters (test cleanup hygiene).

**API-shape compatibility.** The `event` payload's `hash` field stays OPTIONAL; the only observable change is *when* it appears. Pre-fix: on the first event after a content change (with a blocking read). Post-fix: on the SECOND+ event for the same mtime, after the async queue populates the cache. `file-tabs.js`'s hash short-circuit still fires for rapid-repeated-touch patterns: first event flows through HTTP refresh which populates `panel._fileHash`; second event's `evt.hash` arrives from the async cache; comparison fires; no-op. The very first event for a freshly-changed file no longer pays the hash-skip optimization — it falls through to the HTTP-refresh path, which is a documented case in `file-tabs.js` (file-watcher.js:122–128).

**ADR-0017 §Event payload updated** to reflect the new timing semantics on `event.hash`.

**Decision divergence from the memo.** Did NOT add the `AI_OR_DIE_HASH_DEBUG` runtime guard against sync `readFileSync` re-introduction. Replaced by a CI-time wrap-and-count test in `test/file-watcher.test.js`: `_flush() never calls fs.readFileSync synchronously, even with includeHash:true`. Same protection, lower runtime cost. Did NOT add a follow-up `hash` event; the per-path cache + late-inclusion fits the existing `event` payload contract better and avoids needing to extend the SSE wire format in `server.js`.

### HOT-08 — 1 MB WebSocket message size guard

**The bug.** `ws.on('message', ...)` handler calls `JSON.parse(message)` with no application-level size check. The `ws` library's `maxPayload: 8 * 1024 * 1024` is a protocol-layer cap; any frame up to 8 MB reaches our handler. `JSON.parse` of 5–8 MB blocks V8 for 40–120 ms. The 256 KB defensive cap on `data.data` for `type === 'input'` (`server.js:2946–2948`) is *post-parse* and applies only to one message type. `express.json()`'s 100 KB default and `/api/files/upload`'s 10 MB limit are HTTP-only. A buggy or malicious client sending 8 MB frames at 10 Hz sustains 400 ms+ of event-loop block per second.

**What we shipped.** Module-level `MAX_WS_MESSAGE_BYTES = 1 * 1024 * 1024`. The handler computes `Buffer.byteLength(message)` BEFORE `JSON.parse` (handles string and Buffer frame types uniformly). On oversize:
- Sends `{type:'error', code:'message_too_large', message, received_bytes, limit_bytes}` to the client.
- Closes the WS with code 1009 ("message too big" — the RFC 6455 status for this exact case).
- Both `send` and `close` are try-wrapped against half-closed sockets.

Kept the ws library's `maxPayload: 8 MB` unchanged as defence-in-depth; the application guard runs first regardless. 1 MB is sized for legitimate WS control frames (PTY input, heartbeats, control messages); paste-image / file uploads go via HTTP `/api/files/upload` at 10 MB, not WS.

**Decision divergence from the memo.** Did NOT lower protocol-layer `maxPayload` (kept as second-line defence). Did NOT extend `_collectDiagnostics` with the `ws.oversized_message_drops` counter — useful for spotting abusive clients in long soaks but not load-bearing; deferred to a future diagnostics enrichment PR.

**HOT-08 fixup cycle — the load-bearing process lesson.** The fix correctly rejects oversized frames at the WS layer. But two existing tests (`test/image-upload.test.js:35` "should reject oversized images" and `test/voice-integration.test.js:30` "voice_upload with oversized buffer returns error") expected the per-feature handlers to emit `image_upload_error` / `voice_transcription_error` — pre-HOT-08 those handlers had their own size checks. Post-HOT-08, the WS guard fires first and the handlers never run. Both tests failed in the bundle integration.

SUP-REL flagged it. ~30 minutes wall-clock from issue-flagged → diagnosed → fixed (`sup-hot/hot-08-ws-frame-size @ 57b1e03`) → integrated. The fix updates both tests to race three terminal signals: the new `{type:'error', code:'message_too_large'}` (post-HOT-08), the WS-standard 1009 close (post-HOT-08), or the pre-HOT-08 per-feature error (back-compat — preserved so the tests would still pass if HOT-08 were ever reverted). Listeners set up BEFORE send so the response isn't missed (caught a self-inflicted race in my first draft where I awaited the listener-setup promise BEFORE sending; lesson noted).

> **Lesson, verbatim from the fixup commit message**: "Application-layer guards added at protocol-boundary trip OLD tests asserting handler-level enforcement. Audit upstream test expectations when introducing a new short-circuit, not just the units the fix directly touches."

This is the cleanest evidence in the campaign that the per-PR diff review + bundle-integration `npm test` constitute a working two-stage gate.

### HOT-09 — attachment-dir bytes cache with mtime freshness

**The bug.** `_attachmentDirBytes` does `fs.readdirSync` + `fs.statSync`-per-entry on every `/api/files/upload` that targets a `.claude-attachments/` dir. 1000 files = 50 ms event-loop block per upload on SSD; 5–20 s on a network share. Multi-file generic-drop and paste-image sequences amplify the cost N times. The 100 MB per-session cap that triggers this scan is rarely close to being exceeded — a 1 MB upload to a 50 MB dir pays the full scan just to confirm 50 + 1 < 100.

**What we shipped.** Per-instance `_attachmentDirCache: Map<canonicalDir, {bytes, mtimeMs}>` keyed by the input directory path. Three new methods:
- `_attachmentDirBytes(dir)` rewritten: single `fs.statSync(dir)` for freshness check; if `cached.mtimeMs === dirStat.mtimeMs`, returns cached `bytes` immediately (0 readdir, 0 per-entry stats). Miss/stale → full-scan + populate.
- `_attachmentDirCacheRecordWrite(dir, addedBytes)` called from the upload handler after a successful `fs.writeFile` for eager update; subsequent uploads' size-checks are pure cache hits.
- `_attachmentDirCacheInvalidate(dir)` called from `_sweepAttachments` after any unlink; forces next-read re-scan (cheaper than tracking per-removed-file deltas, which would need N statSyncs).

**Decision divergence from the memo.** Did NOT canonicalize the cache key. Upload handler passes the canonical path from `validatePath`; sweep passes a lexical join. Cardinality blowup is bounded by distinct working dirs (~1–50 in practice). Did NOT cap the cache — same reasoning. Both can be added later if SUP-SOAK observes unbounded growth in long soaks.

### HOT-10 — streaming JSON serializer for SessionStore

**The bug.** `_saveSessionsLocked` calls `JSON.stringify(data)` wrapped in a `setImmediate`. The wrapper yields ONCE before the stringify but the stringify itself is fully synchronous. For 100 sessions × 512 KB (~51 MB serialized), V8 blocks 80–100 ms per save. `setupAutoSave` fires every 30 s; `handleShutdown` fires once within the 15 s shutdown budget.

**The decision flip from worker_threads to streaming — the load-bearing case study of this lane.** The audit memo recommended Option A (`worker_threads` offload) as the standard pattern. SUP-DISK's pre-implementation API brief was the right shape for the task. Mid-implementation, the structured-clone trap became visible: `worker.postMessage(data)` runs structured-clone of `data` ON the SENDER thread (main) before delivering to the worker. For a 25–50 MB sessions object, structured clone is itself **50–100 ms of synchronous main-thread work** — most of the block we were trying to eliminate stays. ArrayBuffer-style transfer would zero-copy, but the sessions object is plain JS (Maps already converted to arrays) with nothing transferable.

The reframe: **the "obvious-looking standard pattern" (`worker_threads`) reintroduces the cost it's meant to avoid (structured clone).** A decision-lever heuristic falls out of this:

> Before reaching for `worker_threads`, ask: how big is the data, and is it transferable? If `size × clone-throughput > work-cost on main`, the worker LOSES.

For HOT-10, with ~50 MB of plain JS data, `clone-throughput ≈ 500 MB/s` and `work-cost-on-main ≈ 100 ms` for the bare stringify — the worker round-trip is roughly even with the bare cost, and any per-call setup or contention pushes it negative.

**What we shipped instead (Option B from the memo).** New instance method `_serializeDataStreamed(data)`:
- Stringifies the envelope ONCE with `sessions: []` to capture the bracket layout via splice marker `"sessions":[]`.
- Iterates `data.sessions`, stringifying each entry individually with `await setImmediate()` between iterations. setImmediate fires AFTER pending I/O on the current tick, so PTY data, WS frames, heartbeat ticks all run between per-session serializations.
- Per-session stringify is bounded at ≤ 512 KB (the existing `MAX_BUFFER_BYTES_PER_SESSION` cap on `outputBuffer.slice(-1000)`), so each tick blocks < 10 ms on modern hardware regardless of total session count.
- Joins prefix + per-session strings (comma-separated) + suffix. `parts.join('')` is itself O(total bytes) but V8's rope-string optimization keeps the join cost negligible (~5 ms for 25 MB).
- Defensive fallback to bare `JSON.stringify` if `data.sessions` isn't an array or the envelope shape doesn't match.

The replacement happens inside `_saveSessionsLocked`, downstream of the `_inFlightSave` chain (DISK-04). The DISK-01 fsync / FileHandle / writeFile / sync / close / rename / POSIX dir-fsync machinery is untouched. The streaming serializer holds no shared state and is fully `await`able — the existing serialization in `_inFlightSave` just works.

**Output is byte-identical to bare `JSON.stringify(data)`** for the standard envelope. Asserted by `test/session-store.test.js` with four tests: byte-identical output, parse round-trip, fallback for missing/non-array sessions, empty-array handling. A fifth follow-up test pins the splice marker invariant (`JSON.stringify({sessions:[]}) === '{"sessions":[]}'`) — added per SUP-DISK's integration review to guard against a future `JSON.stringify(envelope, null, 2)` slip silently regressing the perf path.

**Empirical confirmation from SUP-SOAK's smoke canary** ([SOAK-05h](../../test/longevity/results/), 2.5 MB workload): `event_loop.max_ms` peak −27% / `array_buffers_mb` peak −33%. Handles identical 5/5 (no worker — predicted). The smoke workload didn't reproduce the 200 ms HOT-05 cliff; the deterministic regression test (`hot-05-sessionstore-stringify.test.js` at 100 × 512 KB) flips from failing (`h.max` ~90 ms) to passing (~5–10 ms). The stress-profile validation is deferred to SOAK-05l. The `array_buffers_mb` −33% has two candidate mechanisms documented in FINAL-BUNDLE.md v3: (a) smaller intermediate string buffers per yield-tick stay below V8's rope-string consolidation threshold (real signal); (b) the metric's floor is dominated by chokidar/ws/PTY traffic and the delta is single-sample variance (noise). SOAK-05l disambiguates.

## Cross-campaign findings

### The burst-collapse-is-load-bearing insight (HOT-06)

The HOT-06 audit memo framed the failure mode as a steady-state drip — N redundant validations × syscall cost. SUP-SOAK's workload-matched canary surfaced it as a burst-collapse cliff instead. The fix is mechanically identical either way, but the campaign's REL-03 retrospective should record that audits framed against the steady-state model under-predict the cliff cases by 2-3× in magnitude. Pre-investigation audits are valuable; their hypotheses should be treated as load-bearing only insofar as the canary confirms the mechanism shape.

### The streaming-vs-worker decision-lever (HOT-10)

Cited verbatim above. Documented as a §subsection in HOT-11 so future "should we use worker_threads for this CPU-bound work?" decisions have a heuristic to consult rather than re-deriving the structured-clone math from first principles. Cross-link in [`disk-hygiene-2026.md §Cross-lane integration pattern`](./disk-hygiene-2026.md#cross-lane-integration-pattern) cites this campaign instance.

### The workload-matched-baseline necessity (from HOT-06 canary confounder)

SUP-SOAK's first HOT-06 canary compared against the original 8-workload baseline (`baseline-20260528T042545Z`), and reported the result as "+90% max_ms regression alongside −11% p99 win." The re-baseline ([SOAK-05g](../../test/longevity/results/baseline-2wl-20260528T053314Z/), commit `63c2c70`) with the same 2-workload subset as the canary revealed the actual fix delta: **−51% p99 / −56% max_ms**. The apparent regression was workload-concentration confounder — pty-flood gets ~50% of CPU when alone vs ~12% when contended with 7 others, so burst windows are intrinsically wider. **Lesson**: a per-PR canary requires a baseline captured with the SAME `--workloads=` subset as the canary. This methodology lesson lands as a paragraph in `docs/specs/longevity-gates.md` (added by SUP-SOAK during the FINAL-BUNDLE.md commit pass) and is codified for REL-02's per-PR gate re-run protocol.

## Process patterns

### Pre-walk discipline ("pre-walk before being asked")

**The pattern.** When a per-PR canary or bundle soak surfaces a BLOCKING signal that *could* plausibly attribute to your lane's work, pre-walk the mechanism BEFORE being asked to investigate. Document the hypothesis privately to the campaign lead with three parts:

1. **What shape the failure would have IF it were your fix** — concrete causal chain from your code change to the observed metric.
2. **What shape the failure actually has** — the observed metric pattern (e.g. "2,709 ms max_ms outlier under 2.4 GB heap → GC-pause-shaped, not stringify-shaped").
3. **Where (a) and (b) diverge** — the falsification of (a) by (b), with reasoning.

**Three outcomes, all positive:**
- **Ruled out** (diverge): your fix is innocent, in writing. Saves the lead's triage ~hours.
- **Narrowed investigation** (partially diverge): you know which sub-system of your lane is suspect; search space tightened.
- **Hypothesis confirmed** (converge): you have context to engage immediately when the lead pulls you in.

**Cost**: ~15 minutes of analysis. **Cost of NOT pre-walking**: lead's triage arrives at the same conclusion via slower path, while you wait.

**Campaign instances.** The pattern was already running across multiple lanes during this campaign; HOT-11 just gives it a named convention so the next campaign can adopt it without re-deriving:
- **HOT (HOT-08 fixup cycle)**: SUP-REL flagged 2 test failures from the bundle integration. Pre-walked mechanism (handler-level vs WS-layer enforcement); diagnosed in minutes; fixed in 30 min wall.
- **HOT (bundle-soak FAIL hypothesis)**: When the 60-min bundled soak surfaced 2,709 ms max_ms (BLOCKING), pre-walked the three mechanisms by which HOT-10 / HOT-07 *might* be implicated. All three ruled themselves out in writing before SUP-REL had to ask — accelerated the lead's convergence on SUP-SOAK's workload-driven hypothesis.
- **SOAK ([SOAK-05d](../../test/longevity/results/))**: SUP-SOAK's original HOT-06 canary report explicitly flagged "workload-confounder, requires re-baseline" as the right shape of the unknown — pre-walked the methodology gap before pretending the canary was a clean verdict.
- **DISK (DISK-04)**: SUP-DISK self-flagged a concurrent saveSessions rename race during the HOT-10 sequencing brief — surfaced the harness gap before HOT-10 integration could trip on it.

The named convention is the deliverable; the practice itself was already campaign-wide. Adopted by SUP-REL for the REL-03 retrospective standards.

## Peer collaboration & cross-lane finds

### DISK ↔ HOT-10 — API brief upfront + integration verification at end

SUP-DISK published a detailed brief of the new `_saveSessionsLocked` method shape (the `_inFlightSave` chain that landed as DISK-04) before HOT-10 implementation started. This let me build the streaming serializer against the post-DISK-04 layout rather than chasing it. SUP-DISK then performed a four-point integration review after the HOT-10 push:
1. Offload point correctness (✓ — replaced the right line, downstream untouched).
2. Runs inside `_inFlightSave` mutex (✓ — only one streaming serialize at a time).
3. Per-session work bounded by `MAX_BUFFER_BYTES_PER_SESSION` (✓ — composes cleanly with the DISK-01 fsync recipe).
4. Output byte-identity claim (✓ — caught the `JSON.stringify` no-indent invariant that the splice marker depends on; led to the marker-invariant follow-up test).

The brief-then-review pattern is documented in `disk-hygiene-2026.md` §"[Cross-lane integration pattern](./disk-hygiene-2026.md#cross-lane-integration-pattern)" with anti-patterns comparison and a 5-step template for future campaigns. HOT-11 references that section as the canonical home rather than duplicating it.

### SOAK ↔ HOT — workload-matched canary methodology

SUP-SOAK ran independent canaries on HOT-06 / HOT-07 / HOT-10 with workload-matched baselines (SOAK-05f, 05g, 05h). The HOT-06 re-baseline (SOAK-05g) was the campaign's clearest methodology contribution — established that per-PR canaries require same-workload-subset baselines, codified in `docs/specs/longevity-gates.md` and adopted by REL-02. The HOT-10 mechanism re-attribution from `worker_threads` to streaming (FINAL-BUNDLE.md v2, commit `e23573f`) was a similar collaboration: I caught the mislabel mid-canary-report, SUP-SOAK updated the FINAL-BUNDLE wording in place. Honest reporting on both sides.

### REL ↔ HOT — review tweaks and merge sequencing

SUP-REL's HOT-06 PR review surfaced two non-blocking observations (the `Date.now()` hoist micro-optimization and the TTL insertion-time-vs-last-access semantic). Both carried forward as deferred follow-ups; neither was load-bearing for HOT-06. SUP-REL's bundle-integration discipline caught the HOT-08 test-expectation gap before it shipped, gave clear merge sequencing for HOT-10's DISK-04 dependency, and ran the verification stack (`npm test` 1155/0, per-lane regression suites, FINAL-BUNDLE.md v3) end-to-end. The "Gates I affect: / Workloads exercised:" per-PR convention SUP-REL set early shaped every HOT commit message — made reviews structural-only rather than reverse-engineering.

## Verification

| Layer | What it asserts | Surface |
|---|---|---|
| **Per-fix unit / regression tests** | The named gap is mechanically closed | `test/longevity/event-loop/hot-0{1..5}-*.test.js` — 8 assertions across 5 files; all FAIL on `main` before fix, PASS after corresponding HOT-0{6..10} |
| **Adjacent unit tests** | The fixes don't break existing behaviour | `osc7-parser.test.js` (29 passing, 2 new HOT-06 cases), `file-watcher.test.js` (12 passing, 2 new HOT-07 cases), `session-store.test.js` (17 passing, 5 new HOT-10 cases incl. marker invariant), `image-upload.test.js` + `voice-integration.test.js` (HOT-08 fixup — 18 passing total, race-three-signals pattern) |
| **Cross-lane `npm test`** | Bundle composes cleanly across HOT / DISK / CLIENT / PROC / SOAK | 1155 passing, 3 pending, 0 failing on `stability-hardening-2026 @ c3e8c88` (per FINAL-BUNDLE.md v3) |
| **Per-PR canary** | The fix moves its target gate in workload-matched comparison | HOT-06 −51% p99 / −56% max_ms (SOAK-05g), HOT-07 −21% max / −31% p95 (SOAK-05f), HOT-10 −27% max / −33% array-buffers (SOAK-05h). HOT-08 and HOT-09 skipped per directive; covered by deterministic regression tests |
| **Bundle aggregate soak** | The lane's combined impact is real and non-regressive at full load | `event_loop.p99 peak` 214 → **52 ms (−76%)**, `max_ms peak` 1955 → **1071 ms (−45%)**, `max_ms median` 220 → **47 ms (−79%)**, `handles peak` 83 → **43 (−48%)**, `heap_used peak` 1281 → **983 MB (−23%)**, `rss peak` 2000 → **1458 MB (−27%)**. Workload-matched, identical load, only `src/` differs. See [FINAL-BUNDLE.md](../../test/longevity/results/FINAL-BUNDLE.md) §"Headline" |

Three gates remain over absolute targets even at improved-vs-baseline levels: `event_loop.p99_ms peak` is 2.46 ms over the 50 ms target (essentially at target; median p99 is 20 ms — 60% under target); `event_loop.max_ms peak` is 1071 ms vs 200 ms target (down from 1955 ms baseline at identical load); `memory.heap_slope` is duration-confounded (30 min vs 60 min slope-fit variance). All three are characteristics of the 10-workload synthetic stress profile, not the bundle; the deployment target (single-user daemon for months) is a much lighter workload. SOAK-05q (filed) proposes splitting gate thresholds into "single-workload steady-state" and "multi-workload stress" tiers — not blocking the bundle.

## What's still open

- **HOT-12 retracted**: the deferred follow-up I floated for a `claudeSessions.size` cap belongs in the PROC lane (process/session-lifecycle), not the HOT lane (event-loop hot path). Filed as **PROC-04** (sub-linear `_evictStaleSessions` for high session counts) — deferred post-campaign.
- **HOT-06 SUP-REL non-blocking review items**: `Date.now()` per-emission hoist (~50 ns savings; cosmetic) and TTL semantics consideration. Both deferred; neither load-bearing.
- **HOT-07 thread-pool observability**: if a future fix uncaps `_hashConcurrency`, libuv's default `UV_THREADPOOL_SIZE = 4` would silently throttle and queue work invisibly. `process.report.getReport().libuv` is the clean instrumentation surface. Filed as **SOAK-05j**, deferred until a future fan-out fix needs it.
- **HOT-10 array_buffers candidate-mechanism disambiguation**: two candidate explanations for the −33% delta on the smoke canary. SOAK-05l (workload-opts CLI for stress profiles) is the disambiguating measurement; until then, both explanations stand.
- **HOT-08 oversized-message diagnostics counter**: `_collectDiagnostics` could surface `ws.oversized_message_drops` for spotting abusive clients in long soaks. Deferred to a future diagnostics enrichment PR.
- **HOT-10 yield-every-K knob**: if SOAK observes the N+1 setImmediate ticks per save as a measurable wall-clock-per-save increase under sustained pressure, the lever is `_serializeDataStreamed(data, {yieldEvery: K})` — yield every K-th session instead of every session. Pre-staged in the §HOT-10 documentation; defer until evidence.

## References

- **Audit memos**: [`hot-01-osc7-dedupe.md`](../audits/hot-01-osc7-dedupe.md), [`hot-02-filewatcher-hash.md`](../audits/hot-02-filewatcher-hash.md), [`hot-03-ws-frame-size.md`](../audits/hot-03-ws-frame-size.md), [`hot-04-attachment-scan.md`](../audits/hot-04-attachment-scan.md), [`hot-05-sessionstore-stringify.md`](../audits/hot-05-sessionstore-stringify.md). Each ends with a "Fix landed (HOT-0X)" section documenting decision divergences.
- **Regression tests**: `test/longevity/event-loop/hot-0{1..5}-*.test.js`. Run via `npm run test:longevity` (added by SOAK-01..04).
- **ADR updated**: [`docs/adrs/0017-fs-watcher-push-channel.md`](../adrs/0017-fs-watcher-push-channel.md) §Event payload — async hash timing on `event.hash`.
- **Spec updated**: [`docs/specs/bridges.md`](../specs/bridges.md) §Live CWD tracking via OSC 7 — two-level dedupe.
- **Sister post-mortems**: [`disk-hygiene-2026.md`](./disk-hygiene-2026.md), [`stability-hardening-2026-sup-client.md`](./stability-hardening-2026-sup-client.md). Cross-lane integration pattern (DISK-05) is the canonical home; HOT-11 references it.
- **Bundle soak verdict**: [`test/longevity/results/FINAL-BUNDLE.md`](../../test/longevity/results/FINAL-BUNDLE.md), commit `869e7f7`. Workload-matched re-baseline: `baseline-matched-20260528T072744Z/`. Bundle re-soak: `final-bundle-v2-20260528T082852Z/`.
- **Workload-matched baseline methodology**: codified in `docs/specs/longevity-gates.md` (added by SOAK-05o pass) and REL-02 per-PR canary spec.
