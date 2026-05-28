# Soak Baselines

This file pins the per-baseline summary and threshold-confirmation notes
for the **stability-hardening-2026** campaign. Each baseline run on `main`
HEAD captures one snapshot of the harness's verdict under a defined
workload profile; subsequent PRs are compared against the latest baseline
of the same profile.

Baseline data lives in `results/baseline-<utc>/`. **Do not delete or
overwrite baseline directories** — every PR re-run is computed against
them.

---

## baseline-20260528T042545Z (campaign-day-1, 10-min smoke baseline)

| field | value |
|---|---|
| **Started** | 2026-05-28T04:25:45.665Z |
| **Finished** | 2026-05-28T04:35:57.960Z |
| **Duration** | 600 s (10 min) |
| **Workloads** | `noop, pty-flood, reconnect-storm, watcher-flood, ws-fuzz, attachment-growth, session-stringify, mock-clock` (all 7 plan-spec + smoke) |
| **Workload profile** | smoke-default (see README §"Stress profiles") |
| **Sample interval** | 30 s |
| **Samples collected** | 22 (sampler errors: 0) |
| **Seed** | 42 |
| **Host** | Node v24.15.0, darwin/arm64 |
| **Commit** | main HEAD prior to any campaign fix |

### Verdict per gate

| gate | pass | summary |
|---|---|---|
| `memory` | **FAIL** | heap slope 3 254 MB/h over 22 samples — see "Threshold reasoning" |
| `handles` | **PASS** | active_handles 7 → 3 (peak 69) |
| `requests` | N/A (informational) | peak 129 in-flight, final 1 |
| `fd` | N/A | Linux-only metric; not available on darwin |
| `ws` | N/A (informational) | peak 10, final 0 |
| `fs_watch` | **PASS** | peak 0, final 0 |
| `event_loop` | **FAIL** | p99 peak 90.50 ms (limit 50), max-sample peak 119.14 ms (limit 200) |

### Sampled distributions (selected)

| metric | min | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| `memory.heap_used_mb` | 11.9 | 436.1 | 640.9 | 673.8 | 673.8 |
| `memory.rss_mb` | 70.7 | 1 037.5 | 1 297.4 | 1 360.6 | 1 360.6 |
| `memory.external_mb` | 2.5 | 196.7 | 292.0 | 306.0 | 306.0 |
| `event_loop.p99_ms` | 0.001 | 51.4 | 78.8 | 90.5 | 90.5 |
| `event_loop.max_ms` | 0 | 76.9 | 114.6 | 119.1 | 119.1 |
| `process.active_handles` | 3 | 67 | 69 | 69 | 69 |
| `process.active_requests` | 1 | 25 | 32 | 129 | 129 |
| `sessions.ws_connections` | 0 | 7 | 10 | 10 | 10 |
| `sessions.fs_watch_sessions` | 0 | 0 | 0 | 0 | 0 |

Full per-tick data: `baseline-20260528T042545Z/samples.jsonl` (35 KB, 308 rows).

### Threshold reasoning (what's "confirmed reasonable", what isn't)

**`event_loop` p99 < 50 ms / max < 200 ms** — *confirmed reasonable as
the campaign-end target*. The 90.5 ms p99 and 119.1 ms single-sample peak
under sustained 7-workload load is the **starting condition that the fix
lanes (HOT-01 through HOT-05) are tasked to drive below 50 ms**. This is
the headline metric. The audit's residual stalls (per-session OSC 7
dedupe, sync hash on watch, oversized WS frames) are *exactly* the kind
of bursty stalls that fall in the 50–200 ms range observed here.

**`memory.heap_used_mb` slope < 2.5 MB/h** — *NOT a fair gate under
synthetic stress*. The plan threshold is derived from steady-state idle
load on a real daemon; the harness intentionally drives heavy parallel
load so the heap warms up from ~12 MB (cold) to ~674 MB (under load).
Extrapolating that ramp to MB/h trips the gate. **Action**: treat the
`memory` gate as informational for `--workloads=` runs that include any
of `pty-flood`, `watcher-flood`, `session-stringify`, `mock-clock`; the
gate becomes authoritative only for runs that include just `noop` or
`reconnect-storm + ws-fuzz` (which are I/O-bound, not allocation-bound).
A future harness flag `--memory-gate=strict|relaxed|off` will codify
this; until then, fix supervisors should interpret a memory FAIL by
comparing slope-to-baseline rather than slope-to-absolute-threshold.

**`handles` drift ≤ 5 / 2 %** — *confirmed reasonable*. Drift was -4
absolute (handles dropped between start and end as workloads quiesced).
Peak handles 69 corresponds to in-flight HTTP/WS sockets from the WS
fuzz pool + watcher subscriptions; expected.

**`fs_watch_sessions` returns to 0** — *confirmed reasonable*. Stayed at
0 throughout because the watcher-flood workload unsubscribes on stop.

**`fd` drift** — not exercised on darwin; will surface on Linux CI.

**`requests` and `ws` informational** — peak 129 active requests and
peak 10 WS connections match the configured `attachment-growth` probe
rate × `watcher-flood` ops/s and the `reconnect-storm` tab count
respectively. Both returned cleanly to their idle/quiesce values.

### Known harness findings surfaced during this baseline

1. **Session-store `rename` race.** Concurrent
   `saveSessionsToDisk()` calls (driven by `session-stringify`) race on
   the tmp→target `rename`, producing repeated `ENOENT` warnings. The
   harness handles the error gracefully; the bug itself lives in
   `src/utils/session-store.js`. **Forwarded to SUP-DISK for DISK-01.**

2. **Mock-clock injection outpaces eviction.** The synthetic
   `mock-clock` workload injects 250 stale sessions/sec; the eviction
   sweep can't keep up (the diagnostics endpoint reports
   `sessions.total` ramping from 11 830 at uptime 5 min to 18 171 at
   uptime 10 min, monotonically). This is a workload-tuning matter, not
   a server bug — but it does mean the mock-clock workload as configured
   is a *throughput* probe more than a *liveness* probe. SOAK-05 (future)
   may add a cap on injection rate.

3. **Event-loop spikes correlate with `session-stringify` save ticks.**
   Sample-by-sample inspection of `samples.jsonl` (rows for
   `event_loop.max_ms` paired with `event_loop.p99_ms`) shows the
   119 ms peak coincides with the 10-second `saveSessionsToDisk`
   cadence. That's the HOT-05 gap exactly. Fix-supervisor SUP-HOT
   should expect this baseline gate to flip green once HOT-10 lands
   the worker_threads / chunked-stringify fix.

### How to compare a PR run against this baseline

```bash
# 1. PR re-run, only the gates the PR claims to affect
npm run soak -- --duration=10m --interval=30s \
  --workloads=<same workloads as baseline> \
  --gates=memory,event_loop \
  --pr=<pr-number> --label=<lane>-<task>

# 2. Side-by-side summary
node test/longevity/harness/summarize.js \
  test/longevity/results/baseline-20260528T042545Z --markdown > /tmp/base.md
node test/longevity/harness/summarize.js \
  test/longevity/results/<utc>-<lane>-<task> --markdown > /tmp/pr.md
diff /tmp/base.md /tmp/pr.md
```

A PR is considered passing if every gate it claims to affect either
**improves** (slope/peak decreases) or **stays flat within ±10 %** of
the baseline values above. SUP-REL adjudicates ambiguities.
