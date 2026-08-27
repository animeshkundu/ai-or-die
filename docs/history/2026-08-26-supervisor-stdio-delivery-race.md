# Supervisor Warning Stdio Delivery Race

## What Happened

The tier-2 supervisor longevity test could fail on macOS with Node.js
26.7.0 even after the supervisor had queued the `supervisor_warning` IPC
payload. The test waited a fixed 500 ms after tier-2 escalation before checking
the mock child's echoed warning, so delayed child stdio delivery could make the
assertion run before the marker reached the parent.

## Root Cause

The fixed post-event sleep assumed that the supervisor-warning echo would be
observable on the parent process's stdout within 500 ms. The race is in
asynchronous stdio delivery under the macOS Node.js 26.7.0 runtime, not in the
supervisor's IPC queueing or in the mock child. `bin/supervisor.js` and
`test/fixtures/mock-crashing-server.js` are unchanged.

## Fix

Replaced only the fixed post-event sleep before the tier-2 warning assertion
with `waitForStdio(stdio, pattern, timeoutMs)`. The helper polls every
approximately 25 ms until a bounded deadline, returns an explicit boolean, and
resets a regular expression's `lastIndex` before each test. The exact
`[mock-warning] ... "tier":2` marker assertion remains unchanged in meaning,
and a failed wait reports the final captured stdio in its diagnostic.

The active-split command-palette E2E test also now calls `captureEvidence(...)`
after its existing assertions with the stable unique name
`palette-active-split`.

## Watch For

When asserting asynchronous child-process output, wait for the exact marker
with a bounded poll rather than relying on a fixed post-event sleep. Keep the
production supervisor and mock fixture untouched when the failure is only an
observation-timing race.

## Evidence

Focused supervisor longevity runs were repeated locally on macOS with the
available Node.js v24.19.0 runtime: five runs passed, with four tests passing
in each run. Both modified JavaScript files passed `node --check`, and
`git diff --check` passed. The focused active-split CLI-copy E2E could not be
collected from this checkout because the current Playwright configuration does
not match `86-cli-copy.spec.js`; the command reported `No tests found`. CI
remains the cross-platform verification gate, including the reported macOS
Node.js 26.7.0 race environment.
