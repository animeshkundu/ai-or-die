# Command Palette Active-Split Copy Resolution

## What Happened

With split view enabled, the command-palette `Copy Terminal Output` action could
copy the hidden main terminal even when the right split was active. A missing or
invalid active pane also had no explicit empty-copy behavior.

## Root Cause

`src/public/command-palette.js` resolved the command-palette copy source directly
from `app.terminal`. That is the single-pane terminal, not the active terminal
selected by `splitContainer.activeSplitIndex`. The existing full-buffer copy and
copy-result presenter were otherwise correct.

## Fix

The palette now resolves its source through `_getActiveTerminal(app)`. Split mode
uses only `splits[activeSplitIndex]?.terminal`; malformed indices and missing
panes return `null` and produce the existing `{ ok: false, reason: 'empty' }`
result without invoking the copy seam or falling back to hidden main output.
Single-pane mode continues to use `app.terminal`.

Unit coverage exercises single-pane resolution, the right sentinel at index 1,
and missing/out-of-range/non-integer active indices. The desktop-only CLI copy
regression uses the real fake bridge and palette UI, waits for distinct main and
right sentinels in both source buffers, and verifies that only the active right
sentinel reaches the clipboard. The test remains fixture-backed rather than
claiming a real provider CLI installation.

## Watch For

Any new command-palette terminal operation must resolve through
`_getActiveTerminal(app)`. When split mode is enabled, do not silently fall back
to `app.terminal` if the selected pane is unavailable; report the operation's
normal empty-source result instead.

## Evidence

Focused unit tests run with `node_modules/.bin/mocha --require
test/hooks/session-sandbox.js --exit --timeout 5000 test/command-palette.test.js`.
The targeted browser command is the `client-redesign` Chromium project filtered to
the active-split test in `e2e/tests/86-cli-copy.spec.js`; availability of the local
Playwright browser and native PTY dependencies determines whether that E2E can run.
The direct Mocha binary is intentional: npm 11 can parse `npm exec mocha` flags as
npm options instead of passing them through to Mocha.
