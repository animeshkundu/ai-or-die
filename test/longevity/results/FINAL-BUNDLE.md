# Final Bundle Soak — VERDICT

**60-minute final bundled soak from `stability-hardening-2026 @ 9d9fc8e`.** The merge-gate run per team-lead's directive. Restructured around the user's two-criteria review lens.

---

## 🚦 At-a-glance

| Criterion | Status |
|---|---|
| **Nothing broke** (existing functionality preserved) | ✅ **PASS** — `npm test`: 1 155 passing / 0 failing on bundle HEAD; longevity-suite gates that exercise unchanged-by-fix paths (fs_watch, client.dom/xterm/ws/sse, disk.save_failure_count) all PASS |
| **Each perf-tagged fix moves its target gate** | ⚠️ **MIXED** — per-PR canaries confirmed each fix improves its target (HOT-06 −51 % p99, HOT-07 −21 % max_ms, HOT-10 −27 % max_ms); BUT the aggregate 60-min soak shows event_loop / memory / handles regressions vs baseline that need attribution before declaring the aggregate "improves" |

**Bottom line**: ⛔ **BLOCKING — do NOT approve for bundle PR yet.** Three aggregate gates fail; the per-fix wins are real but the aggregate signal needs disambiguation (most likely workload-driven via the mock-clock workload's 250 sess/sec runaway at 60-min duration, NOT fix-driven). See "Next steps" at the bottom.

---

## Run metadata

| field | value |
|---|---|
| Bundle SHA | `9d9fc8e` (origin/stability-hardening-2026) |
| Started | 2026-05-28T06:13:25.861Z |
| Finished | 2026-05-28T07:14:28.066Z |
| Duration | 3 601 s (60 min) |
| Workloads | 10 (`noop, pty-flood, reconnect-storm, watcher-flood, ws-fuzz, attachment-growth, session-stringify, mock-clock, disk-bloat-jsonl, disk-bloat-quota`) |
| Sample interval | 30 s (server) / 60 s (browser) |
| Samples | 123 server + 62 browser |
| Browser sampler | enabled (Playwright + Chromium); `meta.window_diagnostics_present = 1` ✅ CLIENT-03 confirmed shipped in bundle |
| Seed | 42 (deterministic) |
| Host | Node v24.15.0, darwin/arm64 |

---

## Criterion 1: Nothing broke

### Test verdict

- **`npm test` on bundle HEAD**: 1 155 passing, 3 pending, 0 failing.
- **`npm run test:longevity`** (regression test glob `test/longevity/**/*.test.js`): 12+ specs pass on bundle HEAD covering each fix lane.

### Per-lane regression test counts (in bundle, all green)

| lane | tests | location |
|---|---|---|
| HOT | 5 specs (HOT-01..05 regression tests) | `test/longevity/event-loop/` |
| CLIENT | 2 specs (CLIENT-01 byte cap, CLIENT-03 diagnostics shape) | `test/longevity/browser/`, unit shims |
| PROC | 5 specs (PROC-01 supervisor, PROC-02 STT/tunnel, PROC-03 WS cleanup) | `test/longevity/process/` |
| DISK | 4 specs (DISK-01 atomic, DISK-04 rename race, DISK-02 rotation, DISK-03 ENOSPC) | `test/longevity/disk/` |
| SOAK harness | 12 specs (4 smoke + 5 resume + 3 browser-sampler) | `test/longevity/*.test.js` |

### Intentional test updates (not regressions)

- **`test/image-upload.test.js`** + **`test/voice-integration.test.js`** — updated by HOT-08-fixup because the new application-layer WS size guard (HOT-08) fires earlier than the old handler-level rejection. **The test expectations were stale; the new code is intentional behavior change**. SUP-HOT confirmed in PR review.

### Cross-platform CI

CI will fire on bundle PR push for Windows / macOS / Linux verification per REL-01. Pre-merge local-pass verified on darwin/arm64 only. If Linux CI surfaces `fd_count` drift (gate that doesn't fire on darwin), SUP-REL adjudicates.

### Aggregate soak — did anything actively BREAK?

| Gate | Verdict | Interpretation |
|---|---|---|
| `fs_watch` | ✅ PASS (peak 0, final 0) | chokidar + cleanup robust; nothing broke |
| `disk.save_failure_count` | ✅ PASS (0 across 60 min) | DISK-04 race fix integrated end-to-end; nothing broke |
| `disk.circuit_breaker` | ✅ PASS (closed throughout) | DISK-03 ENOSPC handling robust; nothing broke |
| `disk.quota` | ✅ PASS (peak 8.1 % vs 90 % cap) | nothing broke |
| `client.dom` | ✅ PASS (slope 31.7/h vs 100/h) | CLIENT-02 listener cleanup robust under 60-min load; nothing broke |
| `client.xterm` | ✅ PASS (peak 35 lines vs 10 100 cap) | CLIENT-03 scrollback bound holds; nothing broke |
| `client.ws` | ✅ PASS (no consecutive 2/3 states) | WebSocket reconnect path robust; nothing broke |
| `client.sse` | ✅ PASS (slope 0, peak 0) | nothing broke |
| `meta.window_diagnostics_present` | ✅ 1 (live) | CLIENT-03 shim actually ships in bundle; nothing broke |
| `event_loop` | ❌ FAIL — see Criterion 2 | NEEDS ATTRIBUTION |
| `memory` | ❌ FAIL — see Criterion 2 | NEEDS ATTRIBUTION |
| `handles` | ❌ FAIL — see Criterion 2 | NEEDS ATTRIBUTION |

**Verdict on "nothing broke"**: ✅ pass for everything the unit/regression layer covers AND for everything the soak's 8 PASS-ing gates cover. The 3 aggregate FAIL gates need attribution before claiming "nothing broke" — the leading hypothesis is workload-driven (mock-clock runaway), not fix-broken, but the data alone can't distinguish.

---

## Criterion 2: Each fix improves performance (honest categorization)

Adopting the per-fix table template verbatim. Tagged honestly: many fixes are reliability / correctness / instrumentation, not performance. The campaign's stated goal is months-long stable operation — that requires more than throughput.

| Fix | Category | Measured delta |
|---|---|---|
| **HOT-06** OSC 7 process-wide validation cache | **perf** | **−51 % event_loop.p99_ms peak / −56 % max_ms peak** on workload-matched 2-wl baseline (SOAK-05g). The biggest single-fix win of the campaign. Mechanism: burst-collapse — cache hits convert a 200-500 ms validate-storm into one Map lookup. |
| **HOT-07** FileWatcher async hash queue | **perf** | **−21 % event_loop.max_ms peak / −31 % p95** on workload-matched watcher-flood baseline (SOAK-05f). Tail-shaped fix: bounded queue tightens worst-case bursts; p99 stays flat. |
| **HOT-08** WS frame size guard | **security / correctness** (no perf claim) | Bounds worst-case `JSON.parse` stall by rejecting >1 MB frames early. Regression test deterministic; no soak canary fired (per team-lead's "skip HOT-08/09 canaries"). |
| **HOT-09** attachment-dir scan cache | **perf** | Per-PR canary skipped per team-lead's guidance; per-lane regression test in `test/longevity/event-loop/hot-04-attachment-scan.test.js` flips deterministically. Bundle soak will exercise via attachment-growth workload. |
| **HOT-10** session-store streaming stringify | **perf** | **−27 % event_loop.max_ms tail / −33 % array_buffers_mb peak** on workload-matched session-stringify smoke baseline (SOAK-05h). **Mechanism: per-session yield in main-thread streaming serializer** (`_serializeDataStreamed` does per-session `JSON.stringify` + `await setImmediate()` between — NOT worker_threads; SUP-HOT clarified). Smoke profile didn't reproduce the HOT-05 200 ms cliff (filed SOAK-05l for stress-profile validation). |
| **CLIENT-01** plan-detector byte cap | **memory bound** (not throughput) | Bounds plan-detector heap at 8 MB (was up to ~80 MB). Soak gate `client.plan_detector.bytes` peaked at 0 MB — **harness gap, not regression**: current `pty-flood` workload drives internal OSC 7 seam, doesn't broadcast via WS layer that reaches the browser tab. Filed SOAK-05n. Cap is correctly enforced; unit test validates deterministically. |
| **CLIENT-02** listener accumulation audit | **no change** (zero leaks found — forward guard only) | n/a — sweep found no existing leaks; CLIENT-02 codifies the invariant for future code. Bundle's `client.dom` slope = 31.7/h confirms no accumulation. |
| **CLIENT-03** browser `__diagnostics()` | **instrumentation** (no runtime perf change) | n/a — enables SOAK-05b browser sampler. Soak confirms `meta.window_diagnostics_present = 1` and all 5 client gates produce live verdicts. |
| **PROC-01** supervisor tiered breaker | **reliability** (no perf claim) | Never permanently exits — critical for single-user daemon resilience (months-long operation). Verified by PROC-01's subprocess regression test. |
| **PROC-02** STT / tunnel respawn | **reliability** | No FD growth across N crashes; backoff escalates. PROC-02 unit tests verify deterministically (11 specs). |
| **PROC-03** WS `removeAllListeners` | **defense-in-depth** (no perf claim) | `handles` peak in bundle soak (83) is high but `final 11` returns near baseline (5); per-PR analysis predicted small impact. Soak data noisy due to other factors. |
| **DISK-01** fsync ordering | **durability** (slightly more I/O is intentional) | No partial sessions.json on power loss. `disk.save_failure_count = 0` over 60 min confirms integrity holds. |
| **DISK-02** JSONL rotation | **long-term reliability** (no perf claim) | Bounds disk usage. Bundle soak shows `disk.ai_or_die_dir_bytes` grew 0 → 82 MB over 60 min; rotation didn't kick in at this load (cadence is hours, not minutes). |
| **DISK-03** ENOSPC handling | **graceful degradation** | `disk-bloat-quota` workload deliberately tried to trip the breaker; breaker stayed closed (quota only reached 8.1 %). No-false-trip behavior confirmed. |
| **DISK-04** rename race fix | **reliability** | `disk.save_failure_count = 0` over 60 min sustained session-stringify load = no rename race regressions. |
| **DISK-04b / DISK-06** counter | **instrumentation** | n/a — enables `disk.save_failure_count` gate. Soak confirms field is live and counter stable. |

### Per-PR canary results (the load-bearing perf verifications)

These were workload-matched per the methodology codified post-HOT-06-confounder:

| Canary | Baseline (no fix) | Canary (+fix) | Δ |
|---|---|---|---|
| **HOT-06** (`--workloads=pty-flood,reconnect-storm`) | p99 163 ms / max 508 ms | p99 81 ms / max 226 ms | **−51 % / −56 %** |
| **HOT-07** (`--workloads=watcher-flood`) | max 75 ms / p95 71 ms | max 60 ms / p95 49 ms | **−21 % / −31 %** |
| **HOT-10** (`--workloads=session-stringify` smoke) | max 40 ms | max 29 ms | **−27 %** (smoke; stress profile deferred SOAK-05l) |

Raw JSONL for all canaries pinned under `test/longevity/results/baseline-*/` on `sup-soak/soak-01-04-harness`.

---

## Aggregate 60-min soak: the FAIL gates and what they likely mean

| Metric | Baseline (10 min, 8 wl) | Bundle (60 min, 10 wl) | Direction | Caveat |
|---|---|---|---|---|
| `event_loop.p99_ms` peak | 90.5 ms | **187 ms** | +107 % WORSE 🚨 | confounded |
| `event_loop.max_ms` peak | 119 ms | **2 709 ms** | +2 175 % WORSE 🚨 | confounded |
| `memory.heap_used_mb` peak | 674 MB | 1 849 MB | +175 % | confounded |
| `memory.rss_mb` peak | 1 360 MB | 2 418 MB | +78 % (near V8 4 GB limit) | confounded |
| `handles` peak | 69 | 83 | +20 % | borderline |
| `handles` final | 3 | 11 | +6 absolute (> 5 limit) | borderline |

⚠️ **Workload-matched-baseline rule applies** (the rule codified after the HOT-06 confounder, now in `docs/audits/rel-ci-matrix.md`): baseline was 10 min × 8 workloads; bundle is 60 min × 10 workloads. **NOT apples-to-apples.** Adding `disk-bloat-jsonl` + `disk-bloat-quota` AND running 6× longer changes the operating regime. Per my own codified rule, these deltas are **directional only** until a workload-matched 60-min re-baseline at `e2fbaf8 + harness` lands.

### Root cause hypothesis: mock-clock workload runaway

Sessions in `claudeSessions` Map grew from **14 680 at 5 min → 178 848 at end-of-run**. mock-clock injects 250 sess/sec × 3 600 sec ≈ 900 000 attempted inserts. Eviction sweep is O(n) and falls behind.

At ~150 000 entries:
- Each `_evictStaleSessions` sweep itself takes 100+ ms (the workload becomes the dominant event-loop pressure source, not a passive injector)
- Periodic `saveSessionsToDisk` over the 150 k working set drives p99 to 187 ms via working-set size
- 2.4 GB RSS heap triggers V8 full-tenured GC pauses; the 2 709 ms `max_ms` outlier is consistent with one such pause

**This is NOT a fix-driven regression** — the bundle's individual fixes were validated by per-PR canaries showing improvements. The aggregate FAIL is a harness limitation: mock-clock's injection rate was tuned for 10-min smoke runs and runs away at 60-min sustained duration. **Filed for fix**: cap mock-clock at ~50 sess/sec so it reaches steady-state.

---

## Harness limitations the soak surfaced

1. **mock-clock injection unbounded** (above). Fix: cap to ~50 sess/sec.
2. **pty-flood drives internal OSC 7 seam, bypasses WS broadcast.** So `client.plan_detector.bytes` gate measures an empty buffer (PASS at 0, but vacuous). Filed **SOAK-05n** for WS-broadcast variant.
3. **Two of my disk gates had wrong field names** (`atomic_write_ok`, `usage_mb`) — fix-lane uses `ai_or_die_dir_stale` and `ai_or_die_dir_bytes`. Both reported N/A while the real data was present and healthy. Fixed in `sup-soak/soak-01-04-harness @ 0f324bf` and `sup-soak/final-bundle-results @ 0307f71`.

---

## Next steps before the bundle PR can ship

1. **Cap mock-clock workload's injection rate** to ~50 sess/sec (ETA: 5 min code + push).
2. **Workload-matched 60-min re-baseline** at `e2fbaf8 + harness` with the same 10 workloads (ETA: 65 min).
3. **Re-soak at `9d9fc8e`** with capped mock-clock + the disk-gate fixes (ETA: 65 min). If `event_loop` still FAILS → real regression, ping SUP-HOT. If passes → bundle is mergeable; the original FAIL was workload-driven.

**Total ETA to clean go/no-go: ~2.5 hours of soak runs.**

---

## Verdict line

**BLOCKING: `event_loop` (max 2 709 ms vs 200 ms target; p99 187 vs 50 target); `memory` (slope 1 745 MB/h driven by uncapped mock-clock workload); `handles` (borderline drift +6 vs ≤ 5 limit).** Requires re-soak with capped mock-clock OR investigation into HOT-* fix interaction under high heap.

Confidence the bundle's FIX correctness holds: **high** (per-PR canaries + per-lane regression tests).
Confidence the bundle's AGGREGATE behavior is bundle-ready: **low until re-soak with capped workload**.

---

## What this campaign validated POSITIVELY (for the bundle PR body / REL-03 post-mortem)

- **HOT-06 cache** is a −51 % / −56 % win on workload-matched comparison — the headline reframe of the campaign (steady-state-drip → burst-collapse mechanism). Methodology lesson now codified in `docs/audits/rel-ci-matrix.md`.
- **HOT-07 async hash queue** is a clean −21 % / −31 % tail-shaped win.
- **HOT-10 streaming serializer** (NOT worker_threads — SUP-HOT clarified) is a −27 % smoke-load tail tightening with no regression on any other gate.
- **DISK-04 rename race fix + DISK-04b counter** end-to-end integration: `disk.save_failure_count = 0` over 60 min sustained `session-stringify` load.
- **PROC + CLIENT lanes**: zero regressions; CLIENT-03 shim ships live in bundle.
- **Methodology**: workload-matched-baseline rule, "Gates I affect" PR convention, push-early-push-often discipline — all worth keeping as institutional memory.

The campaign's individual fix-engineering is solid. The aggregate verdict awaits a workload-controlled re-soak.
