# QoL-2 Handoff Notes

## Original Intent

The goal was to dramatically improve mobile/tablet terminal UX without degrading desktop.
The full spec is at `docs/audits/SUMMARY.md` (synthesized from 8 Copilot agent audits +
expert review). The implementation plan is at `.claude/plans/generic-puzzling-dream.md`.

Key deliverables:
- P0 (9 critical fixes): viewport meta, keyboard detection, install button, touch targets, etc.
- P1 (9 high impact): auto-hide chrome on keyboard, extra keys overhaul, orientation handler, etc.
- P2 (8 polish): swipe gestures, haptic feedback, CSS cleanup, etc.
- Documentation: testing methodology guides, Copilot agent testing pattern
- CI: restructured pipeline with sharding for parallelism

## Branch: fix/qol-2 (PR #59)
## Status: CI failing — E2E tests timeout
## Date: 2026-02-13

## What Was Done

### Sprint 1 (P0 — 9 critical fixes): DONE, CI-validated green
- Install button z-index overlap fixed
- Viewport meta (viewport-fit=cover, interactive-widget, max-scale=5)
- text-size-adjust: 100%
- Keyboard detection: proportional threshold, thrashing guard, Safari fallback, debounce
- Context menu: bottom sheet on mobile, z-index raised to --z-modal
- fitTerminal: mobile-conditional row/col adjustments, recursion guard
- Network: online/offline listeners, reconnect 10 attempts, 30s cap, race guard
- Clipboard: permission error handling
- New session button: 44px touch targets via pointer:coarse

### Sprint 2 (P1 — 9 high impact): DONE, needs CI validation
- Auto-hide bottom nav/tab bar/mode switcher on keyboard-open (CSS)
- Keyboard dismiss button in extra keys
- Multi-row extra keys (2 rows, 44px targets, Alt modifier, Ctrl+Arrow CSI)
- Orientation change handler
- Dynamic font sizing (12/13/14px by viewport width)
- Modal overflow with keyboard (--visual-viewport-height CSS prop)
- Overlay no longer blocks tab bar (z-index 301)
- iPad Mini breakpoint moved to 820px
- File browser aria-labels

### Sprint 3 (P2 — partial): DONE
- Swipe between sessions
- Haptic feedback on extra keys
- Settings modal stacked at 480px
- Pull-to-refresh skip xterm-viewport/modal
- Tab close CSS width:auto
- Overflow button 44px + visual prominence
- Ctrl modifier 5s timeout, Alt 5s timeout

### Other
- Voice input: session tracking, validation before insert
- Auto-start terminal when no AI tools (skip overlay)
- CI: restructured to 11 E2E jobs with Playwright sharding (~15 tests/job)
- CI: npm + Playwright browser caching, separate concurrency groups
- Test timeout audit: 40 blind waits replaced in test files
- 2 new E2E test files (48, 49)
- Documentation: testing hierarchy, Copilot agent testing guide, deferrals

## The Current Problem

**E2E tests timeout on CI.** Tests that use `joinSessionAndStartTerminal` fail with 60-second timeouts. The issue has been through many iterations of debugging:

### Root causes identified and fixed:
1. SyntaxError in _setupDarkModeListener (stray `});`) — FIXED (commit 9254892)
2. fullyParallel:true caused 3x redundant server instances — FIXED (set to false)
3. Test helper timeouts reduced too aggressively (30s→10s) — REVERTED to main
4. 20s blocking from sync execFileSync in isAvailable() — FIXED (async cache + Promise.allSettled)
5. _initComplete flag never set (auth blocks init) — REVERTED wait condition
6. Over-complicated joinSessionAndStartTerminal — REVERTED to main's simple version

### Remaining suspected issue:
**The `_hasAiToolsAvailable()` auto-start terminal feature (commit 0d37247) may race with the test helper's `startToolSession('terminal')` call.**

On CI (no AI tools installed), when a session is joined:
1. The `session_joined` handler sees `!_hasAiToolsAvailable()` → calls `startToolSession('terminal')` automatically
2. The test helper ALSO calls `startToolSession('terminal')`
3. Two terminal starts race — the second may fail or re-show the overlay

The helper was reverted to main's version (commit f346e16) which always calls `startToolSession('terminal')`. If the auto-start already started it, the helper's call may cause issues.

**Potential fix**: Make `startToolSession` idempotent — if the session already has an active tool, return early instead of trying to start another. OR disable auto-start in test environments.

### What's different from main in server code:
- `src/base-bridge.js`: initCommand wraps in try/catch, pre-populates availability cache
- `src/server.js`: Promise.allSettled in /api/config, session.active set before spawn, await _commandReady in startToolSession
- `src/public/app.js`: ~500 lines of changes (keyboard detection, voice input, extra keys overhaul, network handling, auto-start terminal, swipe gestures, orientation handler, etc.)

### Files to investigate:
- `src/public/app.js` lines 1689-1707: `_hasAiToolsAvailable()` auto-start logic
- `src/server.js` lines 1726-1737: session.active set before spawn
- `src/server.js` startToolSession: what happens if called twice for same session?
- `e2e/helpers/terminal-helpers.js`: now identical to main

### CI Configuration:
- 48 total jobs (11 E2E × 2 OS × shards + unit + binary)
- 12-minute timeout per job
- fullyParallel: false, workers: 3
- npm + Playwright browser caching
- fail-fast: false on all jobs

### Test counts per project:
- functional-core: 15, functional-extended: 28, mobile-iphone: 7, mobile-pixel: 7
- mobile-flows: 8, mobile-sprint1: 21, mobile-sprint23: 42
- visual: 9, new-features: 47, integrations: 54, power-user: 14, ui-features: 51

### Commit count: 31 commits on fix/qol-2

### Expert/adversary review findings addressed:
- 3 Criticals from expert (typo, thrashing latch, reconnect guard)
- 2 Criticals from adversary (sprint23 not in CI, dark mode no-op)
- Context menu z-index, breakpoint alignment, dynamic extra keys height
- Alt timeout, Ctrl+Arrow CSI sequences
- Windows Playwright cache path

### What was green:
Sprint 1 (commit fd621cd) passed CI fully — all 14 jobs green. Everything after that (Sprint 2+3 + CI restructuring) has not been CI-validated.
