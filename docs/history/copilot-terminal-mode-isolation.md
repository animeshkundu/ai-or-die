# Copilot CLI terminal mode interference across tabs

## Symptom

When a full-screen/interactive CLI (such as GitHub Copilot CLI flows that enable terminal mouse handling) ran in one session tab, users could observe broken scroll-wheel and copy-selection behavior after switching to another tab.

## Root Cause

xterm.js VT modes (including mouse tracking modes) are stateful on the terminal instance. The app reuses a single xterm instance across tabs and replays output on `session_joined`, so mode state needed to be reset during tab switches.

## Fix

Reset terminal state on `session_joined` before output buffer replay:

- `src/public/app.js`: call `this.terminal.reset()` immediately before replaying `message.outputBuffer`.
- For inactive sessions, strip replayed mouse tracking mode toggles (`ESC[?1000/1001/1002/1003/1005/1006/1015/1016 h/l`) so stale historical output cannot re-enable mouse capture.

This keeps behavior isolated between tabs while preserving per-session output replay.

## Validation

- Added regression test in `e2e/tests/05-tab-switching.spec.js`:
  - enables mouse reporting in tab A,
  - switches to tab B,
  - asserts `window.app.terminal.modes.mouseTrackingMode === 'none'`.
- Ran targeted Playwright spec and full `npm test`.
