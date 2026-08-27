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

## Follow-up lifecycle fixes

The first hard-gate run reproduced two independent browser issues. During
`dragover`, Chromium exposed `application/x-session-id` in `DataTransfer.types`
while protecting the value returned by `getData()`. The split drop-zone listener
therefore returned before calling `preventDefault()`, so no final `drop` arrived.
The production listener now accepts the advertised session type during dragover
and still reads and validates the id at drop time.

After split creation, a short-height touch viewport exposed the extra-keys bar
under xterm's link-layer canvas. The canvas intercepted real `Cp` taps despite
the button being visible and enabled. The bar now uses the overlay stacking layer;
the E2E continues to use a real locator tap with no force or synthetic fallback.

The Ubuntu matrix later exposed a separate timing race in the same E2E. A
layout-viewport resize made the bar visible before the delayed visualViewport
callback ran. The test's one-shot `!_inKeyboardTransition` wait could therefore
finish on the pre-callback false value; the callback then set the flag while the
real `Cp` tap was in progress. Clipboard text and focus stayed correct, proving
copy did not cause the transition.

The E2E now waits for the keyboard-open/bar-visible state and a 400ms unchanged
viewport/layout sample with the transition flag clear before tapping. It keeps
the post-copy transition assertion strict, so a production transition or a new
late resize still fails rather than being hidden.

## Verification

Focused unit tests passed: 78 tests across the split drag contract, resolver,
command palette, keys panel, extra keys, tooltips, and terminal-copy suites.
JavaScript syntax checks passed for all changed source, test, and Playwright files.
The dedicated `wide-touch-split-copy` project passes both keys-panel and extra-keys
cases in 16.5 seconds with service workers blocked, touch enabled, and no force
taps or synthetic fallbacks. Each E2E test owns a fresh server so mobile tab
overflow cannot leak sessions between cases.

## Watch For

Do not use `app.terminal` as a copy source when split view is enabled. An invalid
active pane is unavailable, not permission to copy hidden main output. Keep
non-copy input and paste targets separate from this resolver. Do not weaken touch
E2E assertions with force taps or direct helper calls.

## Evidence

The local run uses fixture-backed terminal sessions and Chromium touch capability;
it does not claim a real provider CLI or physical-device result.

## Status

Follow-up implementation is ready to commit after repository review.
