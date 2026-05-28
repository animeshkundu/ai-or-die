# Final Bundle Soak — VERDICT

**60-minute final bundled soak from `stability-hardening-2026 @ 9d9fc8e`.** The merge-gate run per team-lead's directive.

## ⛔ Overall verdict: **BLOCKING — do NOT approve for bundle PR**

Three gates FAILED, one of them catastrophically (event-loop max 2 709 ms vs 200 ms limit — a 13.5× miss). Two harness bugs in my disk-gate field-name extraction also surfaced (now fixed in a follow-up commit, not present in this run's data). **Multiple investigation paths are open before this bundle can ship**; see "Next steps" at the bottom.

## Run metadata

| field | value |
|---|---|
| Bundle SHA | `9d9fc8e` (origin/stability-hardening-2026) |
| Started | 2026-05-28T06:13:25.861Z |
| Finished | 2026-05-28T07:14:28.066Z |
| Duration | 3 601 s (60 min) |
| Workloads | `noop, pty-flood, reconnect-storm, watcher-flood, ws-fuzz, attachment-growth, session-stringify, mock-clock, disk-bloat-jsonl, disk-bloat-quota` (10) |
| Sample interval | 30 s |
| Samples (server) | 123 (errors: 0) |
| Samples (browser) | 62 (one per 60-s tick over 60 min + pre-session baseline) |
| Browser sampler | enabled (`--browser-page`); CLIENT-03 confirmed live (`meta.window_diagnostics_present = 1`) |
| Seed | 42 |
| Host | Node v24.15.0, darwin/arm64 |

## Per-gate verdict table

| gate | verdict | summary |
|---|---|---|
| `memory` | ❌ FAIL | heap slope **1 745 MB/h** (threshold 2.5); heap 39.7 → 1 849 MB; RSS 138 → 2 418 MB |
| `handles` | ❌ FAIL | active_handles 5 → 11 (Δ +6, +120 %; threshold ≤ 5); **peak 83** |
| `requests` | N/A (info) | peak 103, final 4 |
| `fd` | N/A (Linux only) | not available on darwin |
| `ws` | N/A (info) | peak 37, final 1 |
| `fs_watch` | ✅ PASS | peak 0, final 0 (target ≤ 0) |
| `event_loop` | ❌ **FAIL — catastrophic** | p99 peak **187 ms** (limit 50; **+107 % vs baseline 90.5 ms**); max peak **2 709 ms** (limit 200; **+2 175 % vs baseline 119 ms**) |
| `disk.atomic_write` | N/A | field-name bug in my gate (looked for `atomic_write_ok`; field doesn't exist; **gate fixed in follow-up to use `ai_or_die_dir_stale`**) |
| `disk.save_failure_count` | ✅ PASS | stable at 0 across 123 samples — **DISK-04 race fix confirmed under sustained load** ✅ |
| `disk.bytes_used` | N/A | field-name bug in my gate (looked for `usage_mb`; actual is `ai_or_die_dir_bytes`; **gate fixed in follow-up**) |
| `disk.circuit_breaker` | N/A (allow_trip) | breaker stayed closed throughout — no false-trip under disk-bloat-quota |
| `disk.quota` | N/A (allow_trip) | peak 8.1 %, final 8.1 % — well below 90 % threshold |
| `client.plan_detector` | ⚠️ PASS-BUT-VACUOUS | peak 0.00 MB — **the browser tab never received PTY output**; pty-flood drives the internal OSC 7 seam, NOT the WS broadcast that reaches the client. This is a **harness gap, not a fix issue**; see "Harness limitations" |
| `client.dom` | ✅ PASS | slope 31.7 nodes/h (threshold 100); 588 → 797 over 62 samples |
| `client.xterm` | ✅ PASS | peak 35 lines (cap 10 100) |
| `client.ws` | ✅ PASS | no ≥ 2 consecutive samples at state 2/3 (61 post-baseline samples) |
| `client.sse` | ✅ PASS | steady-state slope 0/h, peak 0 |

## Sampled distributions (selected)

| metric | min | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| `event_loop.p99_ms` | 0.001 | 52.6 | 117.4 | 167.5 | **187.2** |
| `event_loop.max_ms` | 0 | 81.7 | 243.8 | 340.5 | **2 709.5** |
| `event_loop.mean_ms` | 20.0 | 22.5 | 27.4 | 29.7 | 30.4 |
| `event_loop.p50_ms` | 0.001 | 20.0 | 20.0 | 20.1 | 20.1 |
| `memory.heap_used_mb` | 39.7 | 1 020.5 | 1 755.6 | 1 835.1 | 1 849.1 |
| `memory.rss_mb` | 138.4 | 1 718.4 | 2 268.3 | 2 357.5 | **2 418.3** |
| `handles.active_handles` | 5 | 23 | 49 | 78 | 83 |
| `requests.active_requests` | 1 | 2 | 4 | 5 | 103 |
| `disk.save_failure_count` | 0 | 0 | 0 | 0 | 0 |

## Comparison vs baseline-20260528T042545Z (10 min, 8 workloads)

⚠️ **Caveat (methodology rule)**: the workload-matched-baseline rule (codified after the HOT-06 confounder) says comparing 10-workload-60-min vs 8-workload-10-min is uninterpretable on a delta basis. The bundle adds two disk-bloat workloads AND runs 6× longer. So these deltas are **directional only**; absolute interpretation requires a workload-matched 60-min re-baseline against `e2fbaf8 + harness` (see "Next steps").

| metric | baseline (10 min, 8 wl) | bundle (60 min, 10 wl) | direction |
|---|---|---|---|
| `event_loop.p99_ms` peak | 90.5 ms | 187 ms | **+107 % WORSE** ⚠️ |
| `event_loop.max_ms` peak | 119 ms | **2 709 ms** | **+2 175 % WORSE** 🚨 |
| `event_loop.p99_ms` p50 | 51.4 ms | 52.6 ms | flat |
| `memory.heap_used_mb` peak | 673.8 MB | 1 849 MB | +175 % (workload + duration confounded) |
| `memory.rss_mb` peak | 1 360 MB | 2 418 MB | +78 % (approaching Node's 4 GB default V8 limit) |
| `handles` peak | 69 | 83 | +20 % |
| `handles` final | 3 | 11 | +267 % (Δ +6 > 5 absolute) |
| `disk.save_failure_count` | n/a (pre-bundle) | 0 across run | ✅ DISK-04 race fix validated |
| `client.plan_detector.bytes` | n/a (pre-bundle) | 0 (vacuous) | harness gap |

## What I think the FAIL signals mean

### `event_loop.max_ms` = 2 709 ms — the showstopper

Single-sample max 2.7 seconds of event-loop blocking. This is **enormous** and not consistent with any single fix's expected behavior. Three plausible mechanisms, in priority order:

1. **GC pause on a 2.4 GB RSS heap.** Once RSS crossed 2 GB (~25 min into the soak — see `[memory] RSS 2226.1 MB exceeds warning threshold (2048 MB). Notifying clients.` line in the soak log), full-tenured GC pauses can hit 1-3 s. The 2 709 ms outlier likely IS one of these. **This is downstream of the memory regression, not a fix bug.**

2. **mock-clock workload runaway.** Sessions accumulated from 14 680 (5 min mark) to 178 848 (end) — the mock-clock workload injects 250 sessions/sec × 3 600 sec = **900 000 attempted inserts**. Eviction can't keep up. Each `_evictStaleSessions` sweep iterates the full Map; at 178 848 entries, each sweep is O(n) and itself takes 100+ ms. **The workload is now an event-loop pressure source, not just a memory one.**

3. **session-stringify cadence at large session count.** With ~150 000 sessions in `claudeSessions`, the periodic `saveSessionsToDisk` from the workload's `markDirty` + worker-stringify cadence is operating on a much larger working set than the workload's own 50 injected sessions. The 187 ms p99 is consistent with this.

The bundle's fixes (HOT-06 cache, HOT-07 async hash, HOT-10 streaming) are likely correct AND not the regression source. The regression is workload-driven via the mock-clock workload's session-injection-vs-eviction-rate mismatch at extended duration.

### `memory.heap_slope` = 1 745 MB/h — same root cause

Same story: mock-clock injects sessions faster than eviction removes them at this duration. Heap grew from 40 MB → 1 850 MB over 60 min. **At 4 h this would OOM** at Node's default V8 limit (~4 GB).

### `handles` drift 5 → 11

Borderline (threshold is ≤ 5 absolute). Peak 83 → final 11. The +6 absolute is likely 6 lingering `ws` connections that didn't fully tear down by sample time. Not obviously a regression.

### `client.plan_detector.bytes` = 0 (PASS but meaningless)

The browser sampler joined a session and started a terminal, but the `pty-flood` workload drives the **internal** `terminalBridge._handleOsc7Chunk` seam directly — NOT through the WS broadcast pipeline that reaches a real browser client. So the browser tab's plan-detector buffer NEVER fills.

**This is a known harness limitation.** The plan-detector cap (8 MB enforcement) is correctly enforced at the client layer; this gate just doesn't exercise it. The CLIENT-01 unit test validates the cap deterministically; the soak doesn't add coverage. **Filing as SOAK-05n: WS-driven pty-flood variant for browser-side plan-detector exercise.**

## Harness limitations surfaced

1. **mock-clock injection rate is unbounded** at default 250 sess/sec × duration. At 10 min smoke this is fine; at 60 min the eviction can't keep up and the workload becomes the dominant CPU consumer. **Recommendation**: cap mock-clock injection at a steady-state-achievable rate (50/sec or so), or document that mock-clock is for short-duration runs only.

2. **pty-flood doesn't exercise client-side plan-detector** (above).

3. **Two of my disk gates had wrong field names** in their `extract` functions:
   - `disk.atomic_write` looked for `diag.disk.atomic_write_ok` (doesn't exist) → fixed to use `ai_or_die_dir_stale`
   - `disk.bytes_used` looked for `diag.disk.usage_mb` (doesn't exist) → fixed to use `ai_or_die_dir_bytes / 1048576`

Both fixes land in the same commit as this verdict. The corrected gates would have produced live verdicts in this run; the underlying data (ai_or_die_dir_bytes growing 0 → 82 MB over 60 min; never stale) was present and looked healthy.

## What WORKED ✅

- **`fs_watch`**: 0 throughout — chokidar + cleanup logic robust.
- **`disk.save_failure_count`**: 0 across 60 min of sustained `session-stringify` load — **DISK-04 rename race + DISK-04b counter combo confirmed under real load.**
- **`disk.circuit_breaker` / `disk.quota`**: breaker stayed closed; quota stayed at 8 %; `disk-bloat-quota` workload didn't accidentally false-trip.
- **`client.dom`, `client.xterm`, `client.ws`, `client.sse`**: all four PASS on the live browser page (588 → 797 DOM nodes over 60 min is a clean +200 node-count drift at slope 31.7/h, well under the 100/h threshold; xterm scrollback bounded at 35; ws state stable at 1; sse streams stable at 0). **CLIENT-02 listener cleanup + CLIENT-03 `__diagnostics` shim confirmed live under sustained load.**
- **CLIENT-03 `window.__diagnostics()` shim**: `meta.window_diagnostics_present` flipped from 0 (pre-bundle) to **1** in this bundle, exactly as designed. The graceful-degradation path is now exercised against a real CLIENT-03-bearing build.

## What's UNCLEAR

- Whether the `event_loop.max_ms` 2 709 ms outlier is a one-shot GC pause OR a sustained issue. The other p99 samples cluster around 167 ms (still over the 50 ms target but in a different regime than 2 709 ms).
- Whether ANY of the HOT-06 / HOT-07 / HOT-09 / HOT-10 fixes are individually regressing. Per-PR canaries showed all 4 improving. The bundle aggregating into a regression suggests workload-driven (mock-clock) rather than fix-driven.

## Next steps (before bundle ships)

1. **Cap the mock-clock workload's injection rate** to 50 sess/sec (or make it duration-scaled to never exceed eviction rate). Smoke runs unchanged; long soaks become steady-state.
2. **Fire a workload-matched 60-min RE-baseline** at `e2fbaf8 + harness` with the same 10 workloads. Apples-to-apples comparison. ETA: 65 min.
3. **Fire a 30-min RE-soak** at `9d9fc8e` with the capped mock-clock workload. ETA: 35 min. If event_loop FAIL persists, the regression is real and bundle ships need investigation. If it passes, the prior FAIL was workload-driven (not fix-driven) and bundle is mergeable.
4. **Optional**: fix `pty-flood` to drive a WS-broadcast variant so the browser sampler's plan-detector gate actually exercises the cap. **Filing as SOAK-05n.**

## Recommendation

**Do not merge the bundle PR yet.** Run step 1-3 of "Next steps" first. The bundle's individual fix-correctness is validated by:
- Per-PR canaries (HOT-06 −51 %/−56 %, HOT-07 −21 %/−31 %, HOT-10 −27 % at smoke load — all on origin under `test/longevity/results/baseline-*/` for re-evaluation)
- Per-lane regression tests (12 HOT, 5 DISK, 6 PROC, 3 CLIENT — all green in `npm run test:longevity`)
- `disk.save_failure_count = 0` over 60 min sustained load

But the **aggregate soak regression** at 60-min duration needs to be understood before claiming the campaign exit criteria are met. The harness's job is to surface this. The signal here is "shipping might be premature" — let's investigate, not paper over.

## Verdict line for SUP-REL

**BLOCKING: `event_loop` (max 2 709 ms vs 200 ms target); `memory` (slope 1 745 MB/h driven by uncapped mock-clock workload); `handles` (borderline drift +6 vs ≤ 5 limit).** Requires re-soak with capped mock-clock OR investigation into HOT-* fix interaction. The harness will produce a clean re-soak verdict in ~35 min once mock-clock is capped.
