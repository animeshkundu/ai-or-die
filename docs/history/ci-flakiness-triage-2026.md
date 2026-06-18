# CI flakiness triage on the Windows keep-awake PR (2026-06)

Context for the next agent. While landing the Windows keep-awake feature (PR #123),
several CI checks went red. None were caused by the feature; this records the
diagnosis and the holistic fixes, per the "address all failing checks, even
pre-existing flakes" rule (CLAUDE.md rule 8).

## What was red, and why

- **`smoke (windows)`, `test-browser-sticky-notes (windows)`**: the underlying
  tests PASSED (`5 passed`, `7 passed`); the jobs were killed by the **12-minute
  job wall-clock cap**. The longevity soak actually validated keep-awake on
  Windows: `active_handles 5 → 5` stable over 5 minutes (no leak).
- **`test-browser-power-user (ubuntu)`**: canceled during the *Playwright install*
  step, before any test ran — pure runner slowness hitting the 12m cap (keep-awake
  is a no-op on Linux).
- **`test-browser-new-features (windows)`**: `44 passed, 1 failed` — a flaky
  **nerd-font terminal-rendering** test (`e2e/tests/14-nerd-font-rendering.spec.js`),
  where asynchronous shell-prompt output races a direct `term.write` on a
  contended runner.
- **`test (ubuntu)`** (after a re-trigger): `1428 passing, 1 failing` — a flaky
  **image-upload WebSocket** round-trip (`test/image-upload.test.js`) whose
  `image_upload_complete` exceeded the 10s `waitForMessage` bound at the tail of a
  5-minute run. Passed on the immediately prior run with only a docs change
  between them → load-sensitive timing flake, not a regression.

Common thread: the runners (especially Windows browser jobs) run near their
limits, so timing-sensitive tests flake and whole jobs occasionally exceed the
12-minute cap.

## Fixes applied

- **image-upload**: raised the `waitForMessage` default bound 10s → 20s and the
  per-test timeouts to 30s. These are wait bounds, not correctness assertions —
  the upload genuinely completes; it just needs headroom under CI load.
- **12-minute job cap → 20** (`.github/workflows/ci.yml`): the `test`, the 16
  `test-browser-*`, and `build-binary` jobs were capped at `timeout-minutes: 12`,
  but they genuinely run ~12-14 min (checkout + `npm ci` + build + Playwright
  browser install + tests) on slower runners. Several were cancelled mid-run with
  their tests already passing (e.g. `test-browser-integrations (windows)` printed
  `67 passed (7.4m)` then "operation was canceled"). Raised to 20, matching the
  pre-existing `prewarm-models` job. This fits the real work; it does not mask a
  failing test (the tests pass) and `fail-fast: false` means no sibling-failure
  cancellation was involved.

## Still to watch (not papered over)

- The nerd-font test (`e2e/tests/14-nerd-font-rendering.spec.js`) flaked once
  under contention but passed on re-run. If it recurs deterministically, deflake
  it at the source: gate the clear+`term.write` on terminal idle so the shell
  prompt cannot race it.
- If the browser jobs start brushing the new 20-min cap too, the real fix is to
  cut per-job setup cost (cache `npm ci` / the Playwright browser download, or
  split the suites further) rather than raise the cap again — raise that with the
  maintainer.
