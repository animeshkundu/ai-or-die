# Longevity Harness

The verification fabric for the **stability-hardening-2026** campaign.

This harness boots a real `ClaudeCodeWebServer`, drives synthetic workloads
against it, samples the in-process diagnostics endpoint plus the Node
event-loop histogram every 30 seconds, and writes a JSONL stream of metrics
that the per-supervisor lanes (SUP-HOT, SUP-CLIENT, SUP-PROC, SUP-DISK) use
to validate their fixes against a frozen baseline.

> **Owner**: SUP-SOAK lane of the campaign. See the approved plan at
> `plans/this-app-needs-to-partitioned-horizon.md`.

## TL;DR

```bash
# 60-second smoke (default — exercises only the noop workload)
npm run soak

# 4-hour full soak with all 7 plan-spec workloads, JSON verdict to stdout
npm run soak -- --duration=4h --workloads=all --label=full --json

# Re-run only specific gates against a PR (SUP-REL fix-validation workflow)
npm run soak -- --duration=10m --gates=memory,handles,event_loop --pr=124 --label=hot-06-rerun
```

## Smoke test

```bash
# Harness self-test (≈10s, asserts JSONL schema + gate-result shape)
npm run test:longevity-smoke

# Full longevity test suite (includes per-gap regression tests under
# test/longevity/event-loop/, test/longevity/disk/, test/longevity/process/,
# test/longevity/browser/ — added by SUP-HOT, SUP-DISK, SUP-PROC, SUP-CLIENT)
npm run test:longevity
```

The `test/longevity/**/*.test.js` glob pattern catches every per-gap
regression test added under any sub-lane, including the HOT-01..05 tests
landed at `test/longevity/event-loop/` on `main` (commits 7b5be04..2c0c0ee).
The default `npm test` (pattern `test/*.test.js`) does NOT recurse into
subdirectories — `npm run test:longevity` is the right entry point for
the campaign's regression suite.

## Layout

```
test/longevity/
├── README.md                      ← this file
├── smoke.test.js                  ← mocha test that smoke-runs the harness
├── harness/
│   ├── cli.js                     ← `npm run soak` entry point
│   ├── runner.js                  ← orchestrator (server + workloads + sampler)
│   ├── server-controller.js       ← boots ClaudeCodeWebServer on a high port
│   ├── diagnostics-sampler.js     ← polls /api/diagnostics + perf_hooks
│   ├── gates.js                   ← gate registry + thresholds
│   ├── gate-evaluator.js          ← end-of-run verdict computation
│   ├── jsonl-writer.js            ← append-only JSONL with periodic flush
│   ├── rng.js                     ← seeded RNG (mulberry32) for determinism
│   ├── workload.js                ← abstract Workload base class
│   └── workloads/
│       ├── index.js               ← registry: name → class
│       ├── _net.js                ← shared HTTP/WS helpers
│       ├── noop-workload.js
│       ├── pty-flood-workload.js
│       ├── reconnect-storm-workload.js
│       ├── watcher-flood-workload.js
│       ├── ws-fuzz-workload.js
│       ├── attachment-growth-workload.js
│       ├── session-stringify-workload.js
│       └── mock-clock-workload.js
└── results/                       ← per-run output (gitignored except baseline/)
    └── baseline-<utc>/            ← reference run on main HEAD; do not overwrite
```

## CLI flags

| Flag                | Default            | Notes |
|---------------------|--------------------|-------|
| `--duration=<n><u>` | `60s`              | Units: `ms`, `s`, `m`, `h` |
| `--workloads=a,b,c` | `noop`             | Comma-separated; see registry below |
| `--gates=a,b,c`     | all                | Restrict evaluation; sampling is unchanged |
| `--interval=<n><u>` | `min(30s, ⌊duration/6⌋)` | Diagnostics sample cadence |
| `--seed=<int>`      | `42`               | Deterministic RNG seed for every workload |
| `--pr=<tag>`        | _none_             | Embedded in `metadata.json` for SUP-REL diffs |
| `--label=<slug>`    | _none_             | Appended to results dir name |
| `--out=<dir>`       | `results/<utc>[-<label>]` | Override results dir entirely |
| `--resume`          | off                | Continue an existing run dir (12h split-chunk soak) |
| `--json`            | off                | Print verdict JSON to stdout (CI scraping) |

**Exit code**: `0` on overall pass or indeterminate verdict, `1` on any
decidable gate failing or on abnormal abort, `2` on unhandled scaffolding
exception.

## Per-run output

Each soak invocation creates a directory `results/<utc>[-<label>]/`:

| File              | Purpose |
|-------------------|---------|
| `metadata.json`   | Soak params + sampler stats + node/platform fingerprint |
| `samples.jsonl`   | One row per (gate, metric) per sample tick |
| `events.jsonl`    | Soak/workload/sampler lifecycle markers |
| `gate-result.json`| Final pass/fail verdict per gate |

### `samples.jsonl` schema

Append-only, one JSON object per line:

```json
{
  "ts": "2026-05-27T18:42:13.451Z",
  "gate": "memory",
  "metric": "heap_used_mb",
  "value": 87.3,
  "threshold": null,
  "pass": null
}
```

| Field       | Type                  | Notes |
|-------------|-----------------------|-------|
| `ts`        | ISO-8601 UTC string   | Sample-tick time |
| `gate`      | string                | Gate category — see registry below |
| `metric`    | string                | Specific reading within the gate |
| `value`     | number \| string \| null | Sampled value; string only for `meta.sampler_error` |
| `threshold` | number \| null        | Spot-check threshold if any |
| `pass`      | boolean \| null       | Per-sample verdict for spot-checked metrics; `null` if the gate is trend-based and evaluated only at end-of-run |

### `gate-result.json` schema

```json
{
  "overall": true,
  "gate_count": 7,
  "decidable_count": 5,
  "thresholds": { "heap_slope_mb_per_hour": 2.5, "...": "..." },
  "gates": [
    {
      "name": "memory",
      "description": "Heap and RSS — must not grow unboundedly over the soak window.",
      "pass": true,
      "summary": "heap slope 0.214 MB/h (threshold 2.5) over 480 samples",
      "slope_mb_per_hour": 0.214,
      "threshold": 2.5,
      "samples": 480
    },
    "..."
  ]
}
```

`overall` is `true` if every decidable gate passes; `false` if any decidable
gate fails; `null` if no gate is decidable (e.g. all under their minimum
sample count).

## Gate registry

Single source of truth: `harness/gates.js`. The plan-spec thresholds are
hard-coded as defaults; override via `--thresholds` (TODO future flag) or
by editing `DEFAULT_THRESHOLDS` in `gate-evaluator.js`.

| Gate         | Metrics                                                                 | Verdict pattern                            | Default threshold                |
|--------------|-------------------------------------------------------------------------|--------------------------------------------|----------------------------------|
| `memory`     | `heap_used_mb`, `heap_total_mb`, `rss_mb`, `external_mb`, `array_buffers_mb` | linear-regression slope on heap_used        | < 2.5 MB/h (= 10 MB / 4h)        |
| `handles`    | `active_handles`                                                        | drift (last − first)                       | ≤ 5 absolute OR ≤ 2% relative    |
| `requests`   | `active_requests`                                                       | informational (caller asserts)             | —                                |
| `fd`         | `fd_count` (Linux only)                                                 | drift (last − first)                       | ≤ 1% relative                    |
| `ws`         | `ws_connections`                                                        | informational (caller asserts)             | —                                |
| `fs_watch`   | `fs_watch_sessions`                                                     | final value                                | ≤ 0 at end-of-run                |
| `event_loop` | `p50_ms`, `p99_ms`, `max_ms`, `mean_ms`                                 | spot-check every sample                    | p99 < 50 ms, max < 200 ms        |

**Verdict patterns:**
- **spot-check** — per-sample `pass` boolean is the verdict; gate fails if any sample fails.
- **slope** — ordinary-least-squares slope over the window; gate fails if slope exceeds threshold.
- **drift** — `last − first` over the window; gate fails if outside abs+pct bounds.
- **final value** — single threshold against the last sampled value.
- **informational** — `pass: null`; not gating, but recorded for diagnosis. The caller (e.g. a regression test) asserts on the reported peak/final.

## Workload registry

`harness/workloads/index.js`. Each workload is deterministic-seeded
(`new Ctor({ rng: masterRng.fork(name) })`) so a `--seed=X` invocation is
bit-for-bit reproducible.

| Name                | Stresses                          | Default profile                        | Plan-spec stress profile (opt-in)         |
|---------------------|-----------------------------------|----------------------------------------|-------------------------------------------|
| `noop`              | scaffolding smoke only            | n/a                                    | n/a                                       |
| `pty-flood`         | OSC 7 path validation (HOT-01)    | 8 tabs × 1 MB/s × 4 cwd rotation       | 8 tabs × 5 MB/s                            |
| `reconnect-storm`   | WS map + listener cleanup (PROC-03)| 50 tabs @ 1 Hz                         | same                                       |
| `watcher-flood`     | sync hashing on watcher (HOT-02)  | 100 ops/s × 5 dirs, hash mix on/off    | same                                       |
| `ws-fuzz`           | WS binary-frame parse (HOT-03)    | sizes 1 KB / 100 KB / 1 MB @ 10 Hz     | add 4 MB + 10 MB frames                    |
| `attachment-growth` | dir-bytes sync scan (HOT-04)      | 100-file dir × 5 probes/s              | 1000-file dir                              |
| `session-stringify` | shutdown stringify (HOT-05)       | 50 sessions × 50 KB × 6 saves/min      | 500 sessions × 200 KB                      |
| `mock-clock`        | 7-day eviction sweep              | 50/sweep × 5 sweeps/s × 90 d-old       | same                                       |

### Stress profiles

The defaults are smoke-friendly so the harness never OOMs in a 60-second
CI invocation. To run the plan-spec stress profile, edit the workload
options in a thin driver script — the harness exports `runSoak` from
`harness/runner.js`:

```js
const { runSoak } = require('./test/longevity/harness/runner');
const { SessionStringifyWorkload } = require('./test/longevity/harness/workloads/session-stringify-workload');
// future: a CLI flag for `--workload-opts=session-stringify.sessionCount=500`.
```

(`--workload-opts=name.key=value` is a planned follow-up; for now the
smoke-default profile is what `--workloads=` selects.)

## Split-chunk soaks (`--resume`)

GitHub-hosted runners cap a single job at 6 hours, so the 12-hour weekly
soak (plan §"Verification" item 4) is run as two consecutive 6-hour
chunks. The second chunk continues into the **same `--out=` directory**
with `--resume`, which:

- Appends to `samples.jsonl` and `events.jsonl` rather than truncating
  (`JsonlWriter` already opens with `'a'`).
- Preserves the original `started_at` in `metadata.json` and adds a new
  entry to `metadata.chunks[]` with `chunk_index: N`.
- Re-ingests prior samples into the `GateEvaluator` so the final verdict
  (`gate-result.json`) spans **every chunk that wrote into the dir**.
- Stamps `soak_resume` / `soak_resume_end` markers in `events.jsonl`
  with a `chunk` field on every event so the timeline is unambiguous.

```bash
# Chunk 0: 6 hours — fresh run, creates results/<utc>-12h-soak/
npm run soak -- --duration=6h --out=results/12h-soak --workloads=all --label=12h-soak

# Chunk 1: another 6 hours into the same dir
npm run soak -- --duration=6h --out=results/12h-soak --resume --workloads=all
```

Note: `--resume` requires `--out=<existing dir>` — the harness can't infer
which run to continue. A workload-set change across chunks is allowed (a
soft warning is logged) so an operator can run e.g. `pty-flood` for chunk
0 and `session-stringify` for chunk 1 in the same soak window if needed.

The roll-up fields `total_duration_ms`, `chunk_count`, and
`sampler_stats.{samples,errors}` (summed across chunks) appear at the
top of `metadata.json` so `summarize.js` and SUP-REL's diff workflow
keep working without walking `chunks[]`.

When SUP-HOT lands a PR that affects gate `memory` or `event_loop`, they
ping SUP-SOAK with:

> Rerun gates memory,event_loop for PR #124

SUP-SOAK runs:

```bash
npm run soak -- --duration=30m --workloads=<workloads-touching-that-gap> --gates=memory,event_loop --pr=124 --label=hot-06
```

The resulting `gate-result.json` is attached to the PR. SUP-REL diffs it
against `results/baseline-<utc>/gate-result.json` and blocks merge if any
gate regressed.

PR descriptions for fix supervisors **must include a "Gates I affect"
line** so SUP-SOAK can pick the right `--gates=` set without re-reading
the diff:

> Gates I affect: memory, event_loop

## Determinism

- **Sampling cadence**: fixed by `--interval` (default min(30s, ⌊duration/6⌋)).
- **Workload behavior**: every random choice derives from `--seed` via
  `Rng#fork(workload-name)`.
- **Wall-clock vs harness clock**: workloads use real `setTimeout` /
  `Date.now()`. The `mock-clock` workload lies to the eviction logic via
  per-session `lastActivity` rather than monkey-patching `Date`, so it
  never desyncs JSONL timestamps for the other workloads running in
  parallel.

## Baseline policy

- Baselines live in `results/baseline-<utc>/`. They are **pinned** —
  removing or overwriting one invalidates every PR re-run computed against
  it.
- A new baseline is captured only when a *non-fix* change to the server
  lands on main (e.g. major refactor, dependency bump).
- The summary stats and threshold confirmation for each baseline are
  recorded in `results/BASELINE.md`.

## What this harness does NOT cover

These are intentionally out of scope and owned by other lanes:

- **Client-side gates**: DOM-node growth, xterm scrollback bytes,
  `plan-detector` byte cap. SUP-CLIENT owns those via the browser
  `__diagnostics()` shim (CLIENT-03).
- **Cross-OS validation**: this harness runs on whichever host invokes it.
  SUP-REL ensures the same harness runs in CI on Windows + macOS + Linux
  (REL-01).
- **Real PTY scheduling**: `pty-flood` drives the server-side OSC 7 seam
  directly rather than spawning shells. A spawn-based variant would
  bottleneck on shell scheduling, not on the parse pipeline the audit
  flagged.
