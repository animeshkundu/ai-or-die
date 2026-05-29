# CI trigger architecture — taxonomy, label-gated workflows, branch protection

**Lane**: SUP-REL (release QA / integration)
**Author**: Engineer (working under SUP-REL's prior `rel-ci-matrix.md`)
**Status**: Design + atomic implementation. Extends `docs/audits/rel-ci-matrix.md`; does not supersede it.
**Date**: 2026-05-28
**User directive (verbatim, 2026-05-27)**:
> "Address the CI build. Have pipelines to run on trigger, not on push. CI passing is mandatory for PR to be checked in. There might also be action workflows which are only required once in a while, they should have an easy path to trigger on a PR."

## 1. Why this doc exists

`dfe95c0` already partially addressed the user's first sentence by narrowing
`ci.yml` and `test-voice.yml` to `pull_request` + `workflow_dispatch`. That
commit left three things unfinished:

1. **A complete trigger taxonomy** — not all workflows have been audited. In
   particular, `build-binaries.yml` still fires on every `release: published`
   event (duplicating work that `release-on-main.yml` already does), and
   `pages.yml` still fires on every push to `main` touching `site/**`. Both
   may be correct as-is, but neither has been explicitly justified against
   the user's directive.
2. **An "easy path to trigger on a PR"** for the rare-but-occasionally-needed
   workflows (the user's second sentence). Right now those workflows can only
   be fired via `workflow_dispatch` from the Actions UI on a branch — they
   cannot be attached to a specific PR's review cycle without leaving the
   PR. The user explicitly asked for a PR-attached trigger.
3. **A merge-gate definition**: which check names branch protection should
   require for "CI passing is mandatory for PR to be checked in." Today
   there is no `gh api branch protection` rule on `main`; merges rely on
   reviewer discipline, not the platform.

This doc closes those gaps. The implementation (deliverable 2) lands in the
same commit as this memo on the existing `stability-hardening-2026`
integration branch (rationale §10).

## 2. Trigger taxonomy

| Workflow | Current trigger | Target trigger | Rationale |
|---|---|---|---|
| `ci.yml` | `pull_request` + `workflow_dispatch` | **unchanged** (+ explicit `name:` fields per job) | Already PR-only post-`dfe95c0`. Add job names so branch protection can reliably reference them. |
| `release-on-main.yml` | `push: branches: [main]` | **unchanged** | INTENTIONAL exception. The bump-tag-publish-build path is the one allowed auto-trigger. `concurrency: cancel-in-progress: false` already preserved (a release-in-flight must complete). |
| `pages.yml` | `push: main` paths-scoped to `site/**` + `workflow_dispatch` | **unchanged** | Path-scoped deploy trigger (`paths: [site/**]`) means it does NOT fan out on every push — it fires only when `site/**` actually changes. Pages is a deploy path (like release), so the auto-trigger is justified. Documented as the second intentional exception. |
| `test-voice.yml` | `pull_request` + `workflow_dispatch` | **label-gated**: `pull_request: types: [labeled]` + `workflow_dispatch`. Label name: `run-voice`. | The voice suite includes `voice-real-inference` which downloads a 670 MB Parakeet V3 model and runs ~20 min per OS (~40 min wall-clock total per PR). Most PRs do not touch voice/STT code. Today this runs on EVERY PR. Move to opt-in via `run-voice` label. |
| `longevity-smoke.yml` | `pull_request` + `workflow_dispatch` | **unchanged** + add explicit `name: smoke (${{ matrix.os }})` to job. | This IS the PR-blocking smoke gate (5-min soak tri-platform). Mandatory on every PR. Comment "Runs on every PR + push to main" is stale (it's PR-only post-`dfe95c0`) — fix it. |
| `longevity-nightly.yml` | `schedule: cron '7 3 * * *'` + `workflow_dispatch` | **unchanged** + add `pull_request: types: [labeled]` opt-in. Label: `run-longevity-nightly`. | Nightly schedule + manual dispatch is correct for the recurring cadence. Adding a label trigger gives the user the "easy path to trigger on a PR" for the 4-hour soak when a specific PR needs deeper validation than the smoke can give. |
| `longevity-weekly.yml` | `schedule: cron '13 4 * * 0'` + `workflow_dispatch` | **unchanged** + add `pull_request: types: [labeled]` opt-in. Label: `run-longevity-weekly`. | Same logic as nightly. 12-hour soak on a PR is rare but valuable for major refactors that touch the supervisor/disk/PTY hot paths. |
| `build-binaries.yml` | `release: types: [published]` + `workflow_dispatch` | **REPLACE**: drop the `release:` trigger (it's redundant — `release-on-main.yml` already builds + uploads the SEA binaries to the release in its own `build-binaries` job). Add `pull_request: types: [labeled]` with label `run-binaries` + keep `workflow_dispatch`. Also widen the artifact-upload `if:` so PR-label runs actually produce a downloadable binary. | Currently the `release:` trigger duplicates work that `release-on-main.yml` already does after publishing. Removing it eliminates a daily-noise fan-out without losing functionality. The PR-label trigger gives reviewers a way to download a built binary for a specific PR before it merges. |

**Net effect:** on a typical PR, ONLY `ci.yml` + `longevity-smoke.yml` run.
Voice + nightly + weekly + binary builds are explicit opt-in. On a push to
`main`, ONLY `release-on-main.yml` (always) + `pages.yml` (if `site/**`
changed) run. No surprise fan-out.

## 3. On-demand trigger pattern — label vs. comment

I considered both `pull_request: types: [labeled]` (label-based) and
`issue_comment: types: [created]` (slash-command) for the on-demand path.

**Decision: label-based, exclusively.** Rationale:

- **Discoverability**: GitHub's PR UI shows applied labels in the right
  sidebar. A reviewer can see at a glance that `run-longevity-nightly` is
  attached. A `/run-longevity-nightly` comment is buried in the conversation
  thread.
- **Zero custom-action surface**: `pull_request: types: [labeled]` is a
  native event. The slash-command pattern needs either `actions/github-script`
  (custom JS) or a third-party action (`khan/pull-request-comment-trigger`,
  `peter-evans/slash-command-dispatch`). For a single-user repo, the
  external-action dependency cost is not justified.
- **Idempotent**: removing and re-applying a label re-fires the workflow.
  Equivalent to "re-run" with no comment-history noise.
- **Single source of truth**: when SUP-REL or the user looks at a PR
  in the Actions tab, the trigger source is unambiguous ("triggered by label
  `run-binaries`" vs. "by comment by user X").

**Suggested label catalog** (apply via `gh pr edit <N> --add-label <label>`):

| Label | Workflow fired | Use when |
|---|---|---|
| `run-voice` | `test-voice.yml` | PR touches `src/voice/`, `src/stt/`, `src/models/`, or any code path that interacts with the STT pipeline. |
| `run-longevity-nightly` | `longevity-nightly.yml` | PR touches PTY lifecycle, supervisor, disk circuit breaker, WS protocol, or any code in `src/utils/` that handles unbounded growth. 4h soak validates slope gates. |
| `run-longevity-weekly` | `longevity-weekly.yml` | PR is a major refactor that warrants 12h validation. Rare. |
| `run-binaries` | `build-binaries.yml` | Reviewer wants to download a built SEA binary for the PR's HEAD (manual smoke test of the Win/Linux binary before merge). |

**Implementation detail (critical)**: every label-gated workflow needs a
job-level `if:` guard to filter the label NAME, because
`pull_request: types: [labeled]` fires on ANY label being applied. Without
the guard, applying `bug` would trigger the workflow. Pattern:

```yaml
on:
  pull_request:
    types: [labeled]
  workflow_dispatch:

jobs:
  voice-unit:
    if: github.event_name != 'pull_request' || github.event.label.name == 'run-voice'
    ...
```

The `github.event_name != 'pull_request'` clause is what lets
`workflow_dispatch` and (in the longevity-{nightly,weekly} cases) `schedule`
still fire without a label check.

## 4. Branch protection — mandatory CI for merge

The user's directive: "CI passing is mandatory for PR to be checked in."
This requires GitHub branch protection on `main` with required status
checks.

**Problem with the current YAML**: GitHub Actions reports a matrix job's
status-check name as `<workflow-name> / <job-key> (<matrix-value>)` UNLESS
the job has an explicit `name:` field. `ci.yml`'s `test` job today has no
`name:`, so the check shows as `CI / test (ubuntu-latest)` — usable, but
fragile (reformat the matrix and the name shifts). Same for
`longevity-smoke.yml`'s `longevity-smoke` job.

**Fix landing in this PR**: add explicit `name:` to the jobs that branch
protection will require:

- `ci.yml` `test`: `name: test (${{ matrix.os }})`
- `ci.yml` `test-package`: `name: test-package (${{ matrix.os }})`
- `ci.yml` `build-binary`: `name: build-binary (${{ matrix.platform }})`
- `longevity-smoke.yml` `longevity-smoke`: `name: smoke (${{ matrix.os }})`

The Playwright per-project jobs (`test-browser-*`) are PR-blocking but
their check names already follow a stable pattern (`CI / test-browser-golden
(ubuntu-latest)`). They can be referenced as-is in branch protection without
modification.

**The mandatory check list** for `main` branch protection (exact strings):

| Required check | Source |
|---|---|
| `CI / test (ubuntu-latest)` | `ci.yml` job `test` |
| `CI / test (windows-latest)` | `ci.yml` job `test` |
| `CI / test-browser-golden (ubuntu-latest)` | `ci.yml` job `test-browser-golden` |
| `CI / test-browser-golden (windows-latest)` | `ci.yml` job `test-browser-golden` |
| `CI / test-browser-functional-core (ubuntu-latest)` | `ci.yml` job |
| `CI / test-browser-functional-core (windows-latest)` | `ci.yml` job |
| `CI / test-package (ubuntu-latest)` | `ci.yml` job |
| `CI / test-package (windows-latest)` | `ci.yml` job |
| `CI / build-binary (linux)` | `ci.yml` job |
| `CI / build-binary (win32)` | `ci.yml` job |
| `Longevity Smoke (PR-blocking) / smoke (ubuntu-latest)` | `longevity-smoke.yml` |
| `Longevity Smoke (PR-blocking) / smoke (windows-latest)` | `longevity-smoke.yml` |
| `Longevity Smoke (PR-blocking) / smoke (macos-latest)` | `longevity-smoke.yml` |

**Not required** (still run on every PR, treated as informational):
the 12+ secondary `test-browser-*` jobs (`functional-extended`,
`new-features`, `integrations`, `visual`, mobile flavors, etc.). They run on
every PR and a failure is visible, but blocking on every one would make the
gate brittle to flaky non-core surfaces. SUP-REL can promote any of them to
required after a stable-flake-rate period.

**macOS gap (explicit)**: `ci.yml`'s 18-job browser matrix is `[ubuntu,
windows]` only. `longevity-smoke.yml` IS tri-platform (`[ubuntu, windows,
macos]`). The north-star says "CI covers all three" — that's true only at
the longevity-smoke tier. Adding macOS to the 18 `ci.yml` browser jobs is a
costed follow-up (GitHub macOS runner minutes are 10× Linux). The required-
checks list above closes the gap intentionally: `longevity-smoke` is the
tri-platform required gate; `ci.yml` browser is the dual-platform required
gate. That's documented here rather than left as unspoken drift.

**Interaction with `release-on-main.yml`**: the release workflow pushes a
`chore: bump version` commit directly to `main` via `github-actions[bot]`.
Branch protection with "Require status checks to pass before merging"
applied to `main` would block this push UNLESS one of:

- (a) `enforce_admins: false` on the protection rule (admins can bypass).
- (b) The `github-actions[bot]` account is added to a bypass-allowances
  list on the protection rule.
- (c) The release workflow uses a deploy key / PAT that has bypass.

**Recommended: (a)** — `enforce_admins: false`. Rationale: this is a
single-user repo; the user is the only admin, the release bot is using
`GITHUB_TOKEN` (which has admin equivalents for repo-scoped writes), and
(b) requires per-bot ACL plumbing that GitHub's API does not expose cleanly
for the `github-actions[bot]` pseudo-account. Setting `enforce_admins: false`
documents the carve-out: humans must merge via PR, but the release bot
(and only the release bot, gated by the workflow being merge-able only via
PR) can push directly. The full `gh api` recipe is in the checklist doc.

## 5. Concurrency controls

All workflows already have `concurrency:` blocks. Audit:

| Workflow | Group | `cancel-in-progress` | Verdict |
|---|---|---|---|
| `ci.yml` | `ci-main-${{ PR # OR SHA }}` | `true` | OK. Force-pushes / rapid PR sync cancel the prior run. |
| `release-on-main.yml` | `release-on-main` | `false` | **PRESERVE.** A release-in-flight (publishing to npm) must complete; cancellation mid-publish risks partial state. Known invariant. |
| `pages.yml` | `pages` | `true` | OK. |
| `test-voice.yml` | `voice-${{ PR # OR SHA }}` | `true` | OK; will need to be re-keyed slightly for label triggers (see below). |
| `longevity-smoke.yml` | `longevity-smoke-${{ PR # OR SHA }}` | `true` | OK. |
| `longevity-nightly.yml` | `longevity-nightly` | `false` | OK. Scheduled-overlap rare; if it happens (4h soak overruns), don't cancel. |
| `longevity-weekly.yml` | `longevity-weekly` | `false` | OK. Same logic. |
| `build-binaries.yml` | `build-binaries-${{ release tag OR input version }}` | `false` | Will need to handle the new `pull_request` shape — extend group key to also accept PR #. |

**For label-gated workflows** (voice, nightly, weekly, binaries), the
concurrency key should incorporate the PR number so that rapid label-cycle
("apply, undo, re-apply") cancels the prior run instead of queuing. The
pattern:

```yaml
concurrency:
  group: voice-${{ github.event.pull_request.number || github.event.workflow_dispatch.inputs.version || github.sha }}
  cancel-in-progress: true
```

## 6. Implementation plan (ordered)

| # | File | Edit | Diff size |
|---|---|---|---|
| 1 | `.github/workflows/ci.yml` | Add explicit `name:` to `test`, `test-package`, `build-binary` jobs. | ~3 LOC |
| 2 | `.github/workflows/longevity-smoke.yml` | Add explicit `name: smoke (${{ matrix.os }})` to job. Fix stale comment "Runs on every PR + push to main" → "Runs on every PR". | ~3 LOC |
| 3 | `.github/workflows/test-voice.yml` | Replace `pull_request: branches: [main]` with `pull_request: types: [labeled]`. Add `if:` guard to each job. Update top-of-file comment. | ~10 LOC |
| 4 | `.github/workflows/longevity-nightly.yml` | Add `pull_request: types: [labeled]` to existing trigger set. Add `if:` guard to the job. Update top-of-file comment. | ~5 LOC |
| 5 | `.github/workflows/longevity-weekly.yml` | Same shape as #4 (label `run-longevity-weekly`). The two chunked jobs need the same `if:` guard. | ~6 LOC |
| 6 | `.github/workflows/build-binaries.yml` | Remove `release: types: [published]`. Add `pull_request: types: [labeled]` (label `run-binaries`). Add `if:` guard. Widen the artifact-upload step's `if:` to fire on PR runs too. Extend concurrency group to handle PR shape. | ~10 LOC |
| 7 | `.github/workflows/pages.yml` | No code change. (Comment-only update to flag it as the second intentional exception.) | ~3 LOC comment |
| 8 | `.github/workflows/release-on-main.yml` | No change. Comment already explains the exception. | 0 LOC |

**Cross-file dependency**: REL-01's `longevity-*.yml` files already exist on
`stability-hardening-2026` (the integration branch). Branch protection's
required-checks list (deliverable 3) references their job names; those
names land in this same commit, so they're available the moment protection
is enabled.

**Validation**: after edits, run

```bash
python3 -c "import yaml, glob; [yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]"
```

to confirm every YAML still parses. Then `git diff --check` for whitespace.

## 7. Rollback plan

All edits land in **one commit** with subject
`ci: trigger taxonomy + on-demand label triggers + concurrency controls (per user directive)`
on `stability-hardening-2026`.

If after merge a workflow stops firing when it should (most likely:
someone forgets to add the label to a PR that needs `run-voice`), the
recovery is:

1. **Immediate**: `gh pr edit <N> --add-label run-voice` — fires the
   workflow on the PR. No code change needed.
2. **If a class of PRs needs the workflow auto-fired** (e.g. "all PRs that
   touch `src/voice/**` should get voice tests"): add a `paths:` filter +
   add `pull_request: types: [opened, synchronize]` back to the workflow,
   restricted via `paths:` to the relevant subtree. This is a forward fix,
   not a rollback.
3. **Full rollback** (if the whole taxonomy is rejected):
   `git revert <commit-sha>` reverts the implementation in a single commit.
   This puts every workflow back to its pre-design trigger shape.
4. **Branch protection rollback** (if branch protection itself breaks the
   release flow): `gh api -X DELETE
   repos/animeshkundu/ai-or-die/branches/main/protection` removes the rule
   entirely. The release workflow's push-to-main works immediately after.

## 8. Pre-existing invariants to preserve

- `release-on-main.yml` trigger and `concurrency.cancel-in-progress: false`
  — do not touch.
- `pages.yml`'s `paths: [site/**]` scope — this is what keeps it from being
  a fan-out trigger; without it the workflow would fire on every push.
- `longevity-nightly.yml`'s `failure() && github.event_name == 'schedule'`
  guard on the "Open regression issue" step — issues should NOT be opened
  when the nightly is fired via label or dispatch (those are intentional,
  not a regression signal). The same guard exists in
  `longevity-weekly.yml`. Preserve both.
- `longevity-smoke.yml`'s pre-soak `npm run test:longevity` step — fast
  regression-test gate; SUP-HOT explicitly defended this. Keep the order
  (regression tests BEFORE soak).
- `build-binaries.yml`'s `release:` trigger interaction with
  `release-on-main.yml`'s `build-binaries` job: removing the `release:`
  trigger is safe ONLY because `release-on-main.yml` already builds and
  uploads the same artifacts to the same release tag (verified in
  `release-on-main.yml` lines 152-207). If `release-on-main.yml` ever
  drops its `build-binaries` matrix, `build-binaries.yml`'s `release:`
  trigger must be restored or release binaries vanish.

## 9. Open items / decisions for the user

- **Required-status-check list scope (§4)**. The proposal lists 13 required
  checks. SUP-REL may want to add the secondary `test-browser-*` jobs as
  required once their flake rate is below 1%. Not blocking today.
- **macOS expansion to `ci.yml`** (§4). Currently macOS is required only at
  the `longevity-smoke` tier. Bringing it into the 18 `ci.yml` browser jobs
  is a separate cost/benefit conversation. Not addressed by this design.
- **Auto-label-on-path-change** (e.g. "auto-apply `run-voice` to PRs
  touching `src/voice/**`"). This is the next logical evolution — pair the
  label trigger with a path-watcher workflow that applies the label. Out
  of scope for this design; can ship later as a `pull_request` trigger
  with a `paths:` filter that calls `gh pr edit --add-label`.

## 10. Branch choice

The implementation rides `stability-hardening-2026` (the existing
integration branch with PR #114 open as draft). Justification:

- The longevity-{smoke,nightly,weekly} workflow files this design modifies
  only exist on `stability-hardening-2026`; they have not landed on `main`
  yet. Landing the trigger fixes on a separate branch and then merging
  would create a sequencing knot (which lands first? does the secondary
  branch get rebased on PR #114's bundle?).
- The user's directive was explicit and lane-agnostic ("Address the CI
  build"). It is a campaign-wide concern, not a separate feature stream.
- PR #114 is currently DRAFT, so adding this commit does not disrupt a
  reviewable PR — it goes into the bundle that the user will review as a
  whole.

If the user later prefers to land the CI changes on `main` ahead of the
campaign bundle, the commit can be cherry-picked cleanly (it touches only
`.github/workflows/*` and `docs/audits/*` — zero source-code overlap with
the campaign).

## 11. References

- `docs/audits/rel-ci-matrix.md` — SUP-REL's prior CI audit; this doc
  extends it.
- `docs/architecture/north-star.md §2` — Windows-first, CI-covers-all-three
  rule.
- `CLAUDE.md §"Primary deployment target"` — the Windows-first invariant.
- `dfe95c0` — the user-directive commit that started the trigger narrowing.
- `docs/audits/ci-branch-protection-checklist.md` — the `gh api`
  copy-paste-ready commands the user runs to enable branch protection
  after this lands.
