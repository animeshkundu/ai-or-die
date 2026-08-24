# Terminal context-menu copy fallback

## What Happened

The terminal context menu showed `Copy` grayed out for Claude and Copilot
sessions whenever no xterm text selection was active. Their full-screen TUI
output made that state common, so users could not copy visible output from
the menu.

## Root Cause

`src/public/app.js` disabled the shared `Copy` item whenever
`activeTerminal.hasSelection()` was false, and its click handler only wrote
`activeTerminal.getSelection()`. The check was shared by every CLI because all
agent output is rendered by the same xterm terminal.

## Fix

The context-menu action now uses `terminal-copy.js`, which prefers an active
selection and falls back to the visible terminal buffer. The menu remains
enabled without a selection, reports empty-terminal and clipboard failures,
and retains the existing `Ctrl+C` selection/SIGINT behavior. A browser
regression test covers copying visible output with no selection.

## Watch For

Do not gate a general terminal copy affordance on `hasSelection()`. If a new
terminal surface is added, route its copy action through `TerminalCopy.copyVisible`
so selection precedence and visible-screen fallback stay consistent.
