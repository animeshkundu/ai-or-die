# Wide Touch Active-Pane Copy

## What Happened

The command palette, Control-mode keys panel, and Compose-mode extra-keys `Cp`
action could read the single-pane terminal while split view displayed a
different active pane. A malformed or unavailable active split could also fall
through to hidden main output. The keys-panel copy handler did not return its
handled promise, and its comment referred to xterm's removed Canvas renderer.

## Root Cause

Each copy surface resolved `app.terminal` independently instead of using the
active pane identified by `app.splitContainer.activeSplitIndex`.

## Fix

`ClaudeCodeWebInterface.getActiveTerminal()` now returns the main terminal only
when split view is disabled. Enabled split mode accepts only a valid integer index
into an array containing a terminal; every other state returns `null` and never
falls back to hidden main output. Command-palette, keys-panel, and extra-keys
copy delegate to that resolver when present and use the same strict split-aware
fallback for isolated fixtures. Keys-panel copy returns its handled promise.
Input and paste routing are unchanged.

The wide touch-capable Chromium regression drives production session, tool, split,
and touch lifecycles, then checks right-pane copy content, hidden-main exclusion,
focus, keyboard state, and geometry. Service workers are blocked. A touch may
leave a keys-panel launcher or copy button focused; copy must not focus xterm,
reopen the keyboard, or change terminal geometry.

## Verification

Focused unit tests passed: 73 tests across the resolver, command palette, keys
panel, extra keys, tooltips, and terminal-copy suites. JavaScript syntax checks
passed for all changed source, test, and Playwright files. The targeted keys-panel
Playwright test passed in 6.2 seconds; local extra-keys runs were interrupted
with exit 144 after split setup lost its pane socket and teardown hung. Recheck
that lifecycle case on the CI matrix.

## Watch For

Do not use `app.terminal` as a copy source when split view is enabled. An invalid
active pane is unavailable, not permission to copy hidden main output. Keep
non-copy input and paste targets separate from this resolver.
