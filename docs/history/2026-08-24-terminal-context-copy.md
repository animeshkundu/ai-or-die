# Terminal context-menu copy fallback

## What Happened

The terminal context menu showed `Copy` grayed out for Claude and Copilot
sessions whenever no xterm text selection was active. Their full-screen TUI
output made that state common, so users could not copy visible output from the
menu. This was not a provider-specific clipboard implementation: every CLI
renders through the same xterm surface.

## Root Cause

`src/public/app.js` disabled the shared `Copy` item whenever
`activeTerminal.hasSelection()` was false, and its click handler only wrote
`activeTerminal.getSelection()`. The provider/CLI label was incidental. A
full-screen TUI commonly has output in xterm without a browser selection, so
the shared gate hid a valid operation and the handler had no visible-screen
fallback.

## Fix

The context-menu action now uses `terminal-copy.js`, which prefers an active
selection and otherwise reads the active xterm viewport. It rejoins `isWrapped`
continuations into logical lines, trims trailing blank logical rows, preserves
internal blank rows, and writes through `navigator.clipboard.writeText`.
Success reports `{ ok: true, source: 'selection' | 'screen' }`; failures report
`{ ok: false, reason: 'empty' | 'unavailable' | 'denied' | 'error' }`. The menu
remains enabled without a selection and retains the existing `Ctrl+C`
selection/SIGINT behavior.

The same helper powers the mobile Control-mode `Copy screen` action. It is
visible-screen copy, not full scrollback export. The command-palette `Copy
Terminal Output` action remains deliberately separate: it selects the entire
xterm buffer, invokes browser copy, and clears the selection. Split context
menus resolve the pane that received the event.

The client ships xterm 6.0.0. Because xterm 6 removed the Canvas renderer,
mobile uses the default DOM renderer; the helper reads xterm's buffer API and
therefore remains renderer-independent. The mobile keys panel does not focus
xterm, raise the soft keyboard, or alter terminal geometry. Playwright's default
`serviceWorkers: 'block'` isolates browser assertions from stale PWA assets,
while PWA-specific projects explicitly allow service workers. The production
worker's current cache name is `ai-or-die-v13`; that fact is not copy evidence.

## Evidence boundary

`e2e/tests/04-context-menu.spec.js` covers the generic visible-output fallback.
`e2e/tests/86-cli-copy.spec.js` covers both production `start_claude` and
`start_copilot` routes with `e2e/fixtures/fake-cli-copy.js`, a deterministic
cross-platform Node fixture. It proves bridge routing, PTY/WebSocket delivery,
xterm buffer extraction, and UI copy behavior without claiming that the latest
real Claude or Copilot CLI was installed or authenticated. Real-latest-CLI and
physical-device checks are separate evidence and must name their environment.

Manual evidence should record device and OS/browser versions, provider and
route, fixture versus real CLI, viewport/orientation, copy surface, selection
state, marker/text result, keyboard/geometry state, service-worker mode,
artifact path, observer/date, and pass/fail.

## Watch For

Do not gate a general terminal copy affordance on `hasSelection()`. If a new
terminal surface is added, route its copy action through `TerminalCopy.copyVisible`
so selection precedence and visible-screen fallback stay consistent. Do not
call a fixture pass real-provider or latest-CLI evidence, and do not link a
missing screenshot.

## Verification

The deterministic browser regression and pure helper tests are the executable
checks for this contract. Evidence files are attached by the test runner; only
tracked screenshots that exist after a passing run may be linked from history.

## Status

The generic Claude screenshot is present at
`docs/history/2026-08-24-cli-copy/claude-copy.png`. The previously referenced
Copilot screenshot is absent, so this entry intentionally does not link it.

## Fix verification

The documentation is aligned with the current source and test boundaries. No
production behavior or test code was changed in this documentation update.
