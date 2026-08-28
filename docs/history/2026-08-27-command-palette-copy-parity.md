# Command-palette copy parity with right-click copy

## What Happened

The latest GitHub Copilot CLI session copied and pasted correctly through the
right-click terminal flow, but the application menu copy action returned
different content from the same terminal. The discrepancy was visible with the
real Copilot 1.0.81 route; it was not a browser clipboard or Copilot bridge
failure.

## Root Cause

The right-click `Copy` action used `TerminalCopy.copyVisible()`: it preferred a
live selection and otherwise copied the visible xterm viewport. The command
palette `Copy Terminal Output` action used `TerminalCopy.copyBuffer()`, which
copied the entire active buffer, including scrollback. The difference had been
documented and unit-tested as intentional, so the existing regression suite
protected the mismatch instead of comparing the two user-facing copy surfaces.

## Fix

The command palette now uses the same selection-first `copyVisible()` operation
as right-click copy. Its description and current client/mobile/E2E specifications
describe the shared content contract. The CLI-copy Playwright regression seeds
scrollback outside the viewport, compares right-click and command-palette output
byte-for-byte, and retains the Copilot route and active-split coverage.

## Evidence

A real Copilot 1.0.81 session was started through `start_copilot`; a Chrome
diagnostic run showed successful Clipboard API writes, xterm extraction, and
right-click paste input frames. Brave was not installed in the diagnostic
environment, but the reported failure was reproduced at the content-contract
level in the code and is independent of browser policy. CI continues to use the
deterministic fixture for cross-platform coverage and does not claim a real
provider installation.

## Watch For

All explicit copy controls should use `TerminalCopy.copyVisible()` when they are
expected to match right-click copy. Keep `copyBuffer()` only for a separately
named, explicitly full-scrollback operation. Do not infer a provider-specific
clipboard defect from differences between copy surfaces.
