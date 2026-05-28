# REL-01 — CI matrix current state + proposed longevity-suite shape

**Lane**: SUP-REL (release QA / integration)
**Owner**: SUP-REL
**Status**: Pre-work (current-state audit). Final ADR-grade write-up happens after SOAK-01 lands and the longevity suite ships.
**Date**: 2026-05-27
**Scope**: `.github/workflows/ci.yml` + `package.json` scripts + `docs/agent-instructions/06-local-first-then-ci.md`. Cross-references the soak harness under
`.claude/worktrees/sup-soak/test/longevity/harness/` (SOAK-01, completed).

## Purpose

Capture exactly what CI runs today, what it does NOT run, where the
`test/longevity/` suite needs to plug in, and the duration / concurrency knobs
SUP-REL will negotiate with SUP-SOAK once the harness baseline (SOAK-03) is in.
This doc exists so that when SOAK-01 + SOAK-02 land, SUP-REL can extend
`ci.yml` against a known target rather than reverse-engineering it under
merge pressure.

## Current-state snapshot

### Workflow files

| File | Purpose | Triggers |
|---|---|---|
| `.github/workflows/ci.yml` | PR + push gate (650 LOC) | `push` to `main`, `pull_request` → `main` |
| `.github/workflows/release-on-main.yml` | npm + GH release + SEA binaries | `push` to `main` (skips `chore: bump version` commits) |
| `.github/workflows/build-binaries.yml` | (separate manual binary build) | n/a — not on PR path |
| `.github/workflows/pages.yml` | docs site | n/a — not on PR path |
| `.github/workflows/test-voice.yml` | voice/STT-specific tests | n/a — not on PR path |

Only `ci.yml` is the PR / merge gate. Everything below is about `ci.yml`.

### `ci.yml` jobs (18 total, all PR-blocking on `pull_request → main`)

All jobs share: `actions/checkout@v4` → `actions/setup-node@v4` (Node 22) →
`npm ci`. All have `timeout-minutes: 12`. All run on the matrix
`os: [ubuntu-latest, windows-latest]` (×2 platforms each, so ~36 job
executions per PR).

| Job | What it runs | `needs:` | Notes |
|---|---|---|---|
| `test` | `npm test` (mocha `test/*.test.js`) + ripgrep verify + `npm audit` (non-blocking) | — | The unit suite. |
| `test-browser-golden` | `playwright … --project golden-path` | — | First-launch path. |
| `test-browser-functional-core` | `playwright … --project functional-core` | — | Specs 02–05. |
| `test-browser-functional-extended` | `playwright … --project functional-extended` | — | Specs 06–07, 09-image, 09-bg. |
| `test-browser-mobile` | `playwright … --project mobile-iphone` AND `mobile-pixel` (two `npx` calls, same job) | — | Spec 08, both viewports. |
| `test-browser-visual` | `playwright … --project visual-regression` | — | Spec 09-visual. |
| `test-browser-new-features` | `playwright … --project new-features` | — | Specs 10–14. |
| `test-browser-integrations` | `playwright … --project integrations` | — | Specs 15–16. |
| `test-browser-power-user` | `playwright … --project power-user-flows` | `test` | Sequential dep (slows pipeline). |
| `test-browser-mobile-flows` | `playwright … --project mobile-flows` | `test` | Sequential dep. |
| `test-browser-ui-features` | `playwright … --project ui-features` | `test` | Sequential dep. |
| `test-browser-mobile-sprint1` | `playwright … --project mobile-sprint1` | `test` | Sequential dep. |
| `test-browser-mobile-sprint23` | `playwright … --project mobile-sprint23` | `test` | Sequential dep. |
| `test-browser-mobile-journeys` | `playwright … --project mobile-journeys` | `test` | Sequential dep. |
| `test-browser-ux-features` | `playwright … --project ux-features` | `test` | Sequential dep. |
| `test-browser-restart` | `playwright … --project restart` | `test` | Sequential dep. |
| `test-package` | `node scripts/smoke-test-package.js` | `test` | Bundling/packaging smoke. |
| `build-binary` | `scripts/build-sea.js` + `smoke-test-binary.js` | — | SEA per OS. |

### Time budget

`docs/agent-instructions/06-local-first-then-ci.md §"Performance budget"` is
explicit: **5-minute target, 7-minute max wall-clock, 9-minute per-job
timeout safety net.** Today's `timeout-minutes: 12` is loose against that doc
(slight inconsistency — flag for cleanup but not blocking). Pipeline runs in
practice ~5–7 minutes wall-clock because most jobs are parallel.

### `package.json` scripts vs CI wiring

| Script | What it runs | In `ci.yml`? |
|---|---|---|
| `npm test` | mocha `test/*.test.js` | ✅ `test` job |
| `npm run test:integration` | mocha `test/supervisor-integration.test.js test/integration/*.test.js` (60s timeout) | ❌ **NOT WIRED** |
| `npm run test:browser` | Playwright (all projects) | Replaced piecemeal by 15 per-project jobs — fine. |
| `npm run build:bundle` / `build:sea` | esbuild + SEA | ✅ `build-binary` |
| `npm run release:pr` | release helper | n/a |

## Gaps the campaign cares about

### G1. macOS is not in the matrix today (campaign WILL add it for longevity-only)

CLAUDE.md says: *"macOS and Linux are first-class secondary targets (CI runs
both)"*. **`ci.yml` runs Ubuntu + Windows only.** No macOS runner anywhere on
the PR path — long-standing gap that predates the stability campaign.

**Updated decision (2026-05-28, per REL-01 task description "Win + macOS +
Linux"):** the new longevity-suite jobs added in this campaign **WILL**
include `macos-latest` in their matrix from the start. Adding macOS to the
existing 18 PR-blocking browser jobs is still out-of-scope (separate
follow-up), but the longevity tier MUST be tri-platform so that any
stability-relevant macOS regression (kqueue file-watching, Darwin pty
semantics, BSD `ps` vs Linux `ps` for diagnostics) is caught at the soak
layer. This matches CLAUDE.md's "first-class secondary" wording for macOS at
the surface the campaign owns.

### G2. `npm run test:integration` is not wired, AND `npm test` does NOT recurse

`test/supervisor-integration.test.js` + `test/integration/*.test.js` run
locally but never on CI. **And** `npm test` is `mocha --exit test/*.test.js`
which is a non-recursive glob — it only matches top-level `test/*.test.js`,
**so anything under `test/longevity/**/`, `test/integration/**/`, and the
new SOAK harness tests is silently skipped on every PR.**

Several SUP-PROC fixes (PROC-01 supervisor circuit breaker, PROC-02 STT/tunnel
respawn, PROC-03 ws.removeAllListeners) will live in `test/longevity/process/`
by convention — **5 process longevity test files, ~50s total** per SUP-PROC.
SUP-HOT's 5 `test/longevity/event-loop/hot-0{1..5}-*.test.js` files run ~31s.
SUP-CLIENT's 2 browser tests + DISK + SOAK harness tests round it out.

**If we don't wire `npm run test:longevity` AND an `integration` CI job, the
campaign's entire regression-test infrastructure will silently skip on
every PR.** This is the single highest-impact gap REL-01 closes.

**SUP-REL fix (per consensus with SUP-HOT and SUP-PROC):**

1. Add `npm run test:longevity` script. Exact form per SUP-HOT
   recommendation (verbatim — they've tested it):
   ```json
   "test:longevity": "mocha --exit --timeout 60000 test/longevity/**/*.test.js"
   ```
2. Add an `integration` CI job in `ci.yml` parallel with `test`, running
   `npm run test:integration`. Same OS matrix as the smoke job.
3. Add a `longevity-smoke` CI job (the Tier-1 5-min soak job defined below)
   that runs `npm run test:longevity` AS WELL AS the soak harness — the
   regression tests are a faster pre-soak gate.
4. **Land all three atomically in one PR** to avoid intermediate states
   where one is green and the other silently skips.

**One landing-side caveat (from SUP-HOT)**: the HOT-03 regression test boots a
real `ClaudeCodeWebServer` on a random port > 11000 with
`noAuth:true, folderMode:false`, which logs a few bridge-init "Found Claude
command at: ..." lines. Harmless but verbose in CI output. Quietable via an
env flag in a follow-up — not blocking.

### G3. `test/longevity/` suite has no CI job (expected — SOAK-01/02 in flight)

`test/longevity/` exists on `main` with stub files (e.g. `event-loop/smoke.test.js`,
`browser/diagnostics-shape.test.js`, the HOT-01 regression test, the
HOT-02-in-flight test, etc.) plus a `playwright.config.js`. The full soak
harness (`harness/`) lives only on the `sup-soak` worktree branch
`worktree-sup-soak`. It is NOT yet running in any CI job. **This is the
primary deliverable of REL-01.**

### G4. Sequential-`needs: test` on 9 of 15 browser jobs caps parallelism

9 browser jobs declare `needs: test`. Cause: historic — `test` job warms the
npm cache + ripgrep verification fails-fast. Effect: those jobs cannot start
until `test` finishes (~1–2 min added to wall-clock). Not stability-critical;
note for the post-campaign cleanup pass.

### G5. No artifact upload from the soak harness today

`test-browser-*` jobs upload `playwright-report/`. There is no equivalent
upload for `test/longevity/results/<utc>/*.jsonl`. SOAK harness writes
`samples.jsonl`, `events.jsonl`, `metadata.json`, `gate-result.json` — SUP-REL
needs all four uploaded as a CI artifact so the per-PR regression diff is
post-hoc reproducible. Fix lands with the longevity job.

## Proposed longevity-suite CI shape (negotiated with SUP-SOAK)

Plan §"Soak / longevity verification" defines three soak cadences:
**PR-blocking 5-min smoke, nightly 4h, weekly 12h Linux**. The shape
below is SUP-REL's strawman; final knobs negotiated when SOAK-03 baseline
exists.

### Tier 1 — PR-blocking 5-min smoke (`longevity-smoke`)

- **Trigger**: `pull_request` + `push` to `main` (same as `test`).
- **Matrix**: `[ubuntu-latest, windows-latest, macos-latest]` — tri-platform
  per the REL-01 task description ("Win + macOS + Linux"). Windows is the
  primary target so it MUST run; Linux and macOS run in parallel.
- **Steps**: `npm ci` → run `node test/longevity/harness/cli.js
  --duration=5m --workloads=<sub-set agreed with SUP-SOAK> --json
  --label=ci-smoke --out=test/longevity/results/ci`.
- **`needs:`**: none (parallel with `test`).
- **`timeout-minutes`**: 9 (5-min soak + 1-min server boot + 1-min drain +
  2-min slack).
- **Workload subset (proposal, awaits SOAK-02)**: lightweight subset that
  exercises every gate but not at full 4h amplitude — likely `noop` +
  `pty-output-flood` (at 500 KB/s instead of 5 MB/s) + `reconnect-storm`
  (5 tabs instead of 50).
- **Pass criteria**: harness exit 0. Per-gate verdict written to
  `gate-result.json`, scraped for PR comment.
- **Artifacts**: upload `test/longevity/results/ci/**/*.jsonl` +
  `gate-result.json` + `metadata.json` with `retention-days: 14`.
- **Per-PR re-run policy (REL-02)**: SUP-REL re-runs this same job on every
  PR; for PRs touching the files in `docs/audits/<lane>-*.md`'s
  affected-files lists, also re-run the targeted 1h soak (manual / `workflow_dispatch`).

### Tier 2 — Nightly 4h soak (`longevity-nightly`)

- **Trigger**: `schedule: cron: '7 3 * * *'` (off-peak, avoid round minutes).
- **Matrix**: `[ubuntu-latest, windows-latest, macos-latest]` — tri-platform
  (Windows nightly is a Windows-first hard requirement per CLAUDE.md;
  macOS catches Darwin-specific drift between weekly cycles).
- **Steps**: `node test/longevity/harness/cli.js --duration=4h
  --workloads=all --json --label=nightly --pr=$(git rev-parse HEAD)`.
- **`timeout-minutes`**: 270 (4h + 30 min buffer). GitHub-hosted runners
  cap at 6h, so we are fine. Self-hosted not required.
- **Pass criteria**: all gates green per
  `plans/this-app-needs-to-partitioned-horizon.md §"Pass/fail gates"`:
  heap slope < 2.5 MB/h, handles drift < 5 abs OR 2 %, EL p99 < 50 ms etc.
- **Failure policy**: failure opens an issue auto-tagged `regression/soak`
  (assignee SUP-REL). Does NOT block PR merges (only `longevity-smoke` does).
- **Artifacts**: full results dir, retention-days 30.

### Tier 3 — Weekly 12h soak (`longevity-weekly`)

- **Trigger**: `schedule: cron: '13 4 * * 0'` (Sunday 04:13 UTC).
- **Matrix**: `[ubuntu-latest]` only (12h × Windows-hosted runner cost is
  not justified weekly; Windows is covered by the nightly 4h cadence).
  macOS-hosted runners are also too expensive to burn for 12h weekly —
  macOS is covered by the nightly 4h cadence. **Caveat**: if a Windows-
  or macOS-specific slow drift is suspected, SUP-REL can manually trigger
  a 12h targeted run via `workflow_dispatch`.
- **`timeout-minutes`**: 780 (12h + 1h buffer; under the 6h GH-hosted cap
  for `ubuntu-latest`? **NO — 6h is the hard limit for hosted runners.**
  Resolution: split into two 6h continuous runs OR move to a self-hosted
  runner. Final call after SOAK-02 lands; default plan is split-6h-twice
  with state hand-off via JSONL append. **OPEN QUESTION FOR SUP-SOAK.**
- **Pass criteria**: same gates as nightly, but slope thresholds normalized
  to 12h window (already supported by gate evaluator — slopes are in
  per-hour units).
- **Failure policy**: same as nightly.
- **Artifacts**: full results dir, retention-days 60.

### Per-PR gate re-run coordination (REL-02 scope)

When a PR opens:
1. Identify the failure-mode lane from the PR diff (touched files) cross-
   referenced against `docs/audits/<lane>-*.md` affected-files lists.
2. SUP-REL adds a PR comment naming the gates that fix touches.
3. `longevity-smoke` runs unconditionally on every PR.
4. For event-loop-touching PRs, also `workflow_dispatch` a 1h targeted soak
   with the implicated workload(s).
5. Compare `gate-result.json` against baseline `gate-result.json` produced by
   SOAK-03. **Regression = block merge.**
6. Provide the JSONL diff in the PR comment so SUP-* author can iterate.

## Knobs negotiated with SUP-SOAK (resolved 2026-05-28)

All five open items closed via SUP-SOAK's negotiation reply:

| # | Item | Resolved value | Rationale |
|---|---|---|---|
| 1 | Smoke duration | **5 min** | 10 samples at 30s = safe floor for linear-regression slope confidence. 3 min only gives 6 samples (borderline). |
| 2 | Smoke workload subset | `noop, reconnect-storm, ws-fuzz` | Exercises WS lifecycle + handle/listener accumulation paths; broadest regression coverage for lowest cost. Skips `pty-flood`/`watcher-flood`/`attachment-growth`/`session-stringify`/`mock-clock` (high CPU/FS noise/memory pressure that warm the heap and make `memory` gate noisy in smoke). |
| 3 | Sample cadence in smoke | **20 s** | 5-min × 20s = 15 samples; 5s would 6× the `/api/diagnostics` pressure for marginal slope sensitivity. |
| 4 | 12 h weekly soak hosting | **Two consecutive 6 h chunks** with JSONL state hand-off via `--out=<same-dir>` on the second run. SUP-SOAK landing a `--resume` flag in a follow-up commit (ETA 30 min from negotiation). Self-hosted runner unnecessary. |
| 5 | `--workloads=all` alias | **Already landed** in commit `af94a8c` on branch `sup-soak/soak-01-04-harness`. README updated. |

## Bonus deliverables from SUP-SOAK (commit `af94a8c`)

Already on `sup-soak/soak-01-04-harness`:

- `"test:longevity": "mocha --exit --timeout 120000 test/longevity/**/*.test.js"` — runs ALL regression tests under `test/longevity/**/`. Picks up 12 tests as of the harness PR (8 HOT + 4 SOAK smoke). Note SUP-SOAK chose timeout 120000ms (2 min) over the SUP-HOT-recommended 60000ms — extra buffer for the slower process tests. Acceptable.
- `"test:longevity-smoke"` (existing) preserved — fast pre-soak harness self-test.
- `"soak"` (existing) preserved — `node test/longevity/harness/cli.js`.

**This means REL-01's "atomic CI wiring PR" is now smaller than I planned.** The `test:longevity` script is already in the SOAK harness PR; my follow-up PR only needs to add the `ci.yml` job(s).

## Action items (REL-01 finalization, post-SOAK-01)

- [ ] Add `longevity-smoke` job to `ci.yml` once SOAK-01/02 land on `main`.
- [ ] Add separate `longevity-nightly` / `longevity-weekly` workflow file
      (`.github/workflows/longevity-nightly.yml`, etc.) — keep `ci.yml`
      focused on PR-blocking only.
- [ ] Wire `npm run test:integration` into `ci.yml` as a separate job
      `integration` (parallel with `test`).
- [ ] Update `docs/agent-instructions/06-local-first-then-ci.md` with a
      new section "Longevity suite" describing local-run cadence (smoke
      always-on local, nightly only when relevant lane is touched).
- [ ] Add the longevity job entries to the CI job map table at the bottom
      of `06-local-first-then-ci.md`.
- [ ] Resolve the five open negotiation knobs with SUP-SOAK.
- [ ] After SOAK-03 baseline run, freeze the gate thresholds in
      `harness/gates.js` and capture the baseline JSONL under
      `test/longevity/baselines/main-<commit>.json` for SUP-REL's per-PR
      diff workflow.

## Worktree audit (snapshot 2026-05-27)

```
/Users/kundus/Software/ai-or-die                             d01a68c [sup-client/client-01-byte-cap]
/Users/kundus/Software/ai-or-die/.claude/worktrees/sup-soak  d31ead0 [worktree-sup-soak]
```

- 2 worktrees of 5 budget — well within cap.
- `sup-client/` is in-tree (the root checkout is on the `sup-client/client-01-byte-cap` branch) — visible as the d01a68c CLIENT-01 byte-cap fix in flight.
- `sup-soak/` is the permanent slot per the plan; do not rebase mid-run.
- No supervisor over the 7-day age threshold yet (campaign began 2026-05-27).
- Slot 4 (`sup-proc` or `sup-disk`) and slot 5 (spare) still free.

## References

- `plans/this-app-needs-to-partitioned-horizon.md` §"Soak / longevity
  verification" — gate thresholds, workload list, cadence policy.
- `docs/agent-instructions/06-local-first-then-ci.md` — current CI job map +
  5-min performance budget rule.
- `.claude/worktrees/sup-soak/test/longevity/harness/` — harness scaffolding
  (SOAK-01 complete, SOAK-02 in flight, SOAK-03 pending baseline).
- `CLAUDE.md §"Primary deployment target"` — Windows-first rule that drives
  the Windows-in-every-tier requirement above.
