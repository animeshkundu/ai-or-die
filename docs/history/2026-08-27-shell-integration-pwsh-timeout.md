# PowerShell Shell-Integration Test Timeout

## What Happened

The Ubuntu `test (ubuntu-latest)` job in PR #162 failed during `npm test` while running `test/shell-integration.test.js`. The PowerShell URI-builder case reported Mocha's default 5-second timeout after the suite had already completed 2,115 tests. The case passed on Windows and had previously passed on Ubuntu, where it took 4.257 seconds.

## Root Cause

The regression case intentionally starts a real `pwsh` process with `spawnSync` so the generated URI is parsed and executed by PowerShell. A cold PowerShell startup on the hosted Ubuntu runner took 7.344 seconds in the failing run. Because `npm run test:core` applies Mocha's 5-second per-test default, Mocha reported a test timeout even though the child process had a 10-second bound and the URI assertions themselves were correct. The timeout was in the test harness budget, not in `src/shell-integration.js`.

## Fix

Give only this external-process regression case a 15-second Mocha timeout. The child-process timeout remains 10 seconds, so a hung PowerShell invocation still fails boundedly, while cold startup no longer collides with the unrelated 5-second unit-test default. The whole core suite keeps its existing timeout.

## Watch For

Tests that launch real external tools need a test-level timeout larger than the tool's startup and execution bound. Keep that allowance scoped to the test and retain a shorter child-process timeout so a genuine hang remains actionable.

## Evidence

The failing Ubuntu run took 7.344 seconds for this case and then reported `Timeout of 5000ms exceeded`. A prior successful Ubuntu run took 4.257 seconds. On the current macOS machine, `pwsh` is unavailable, so the conditional case is skipped locally; the rest of the shell-integration file runs successfully.
