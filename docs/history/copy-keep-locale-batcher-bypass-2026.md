# Copy loss + Linux garble — fix notes (2026-09-16)

## Symptoms

1. opencode running inside ai-or-die over remote: selecting text appeared to copy then immediately unselected, leaving nothing pasteable.
2. ai-or-die on a Linux host (GitHub Codespaces) viewed via devtunnel showed fragmented leaders (`, o a m-`), duplicated status lines, overlapped status bar, truncated right side — surviving reload/refresh/hard-refresh.

## Root causes

1. Keyboard copy cleared the highlight synchronously before the async clipboard promise settled; failures (non-secure-context `http://`, denials) lost the selection. Separately, opencode SGR mouse-mode eats plain drags (only `Shift+drag` selects).
2. Stale replay: server tail-only `outputBuffer` + client IDB snapshot (`paintCached` → `capture` loop) + persisted geometry re-applied every reload; mid-sequence budget cuts, `C/POSIX` locale width mismatch, stale atlas.

## Changes

- `clipboard-handler.js`: `copySelectionKeepOnFailure()` (clear-on-success only), sync `return false` on selection (never SIGINT-on-failure), `showCopyErrorToast()`.
- `command-palette.js`: `copy-output` via same helper + insecure-context `execCommand` fallback; new `Clear Terminal Cache & Rejoin` action.
- `index.html`: Copy menu `title` = Shift+drag hint.
- `base-bridge.js`: `applyLocaleFallback()` (`LANG=C.UTF-8` iff unset, non-Windows).
- `output-frame-batcher.js`: `trailingHoldbackLength()` tail-only ESC/UTF-8 hold, stall-free.
- `session-manager.js`: `switchToTab({skipCachePaint, evictCache})` opt-in bypass.
- Docs: `docs/specs/client-app.md` Clipboard section, ADR-0057.

## Regression tests

- `test/clipboard-handler.test.js`: success-clears / reject-keeps / missing-API-keeps; Ctrl+C with-selection→`false`, without→`true`; Shift+C→`false`; keyup→`true`.
- `test/output-frame-batcher.test.js`: partial-CSI hold with byte preservation, partial-UTF-8 hold, no-stall, zero-holdback on complete frames.
- `test/base-bridge-locale.test.js`: fallback-only, explicit-LANG/LC_ALL precedence, LANGUAGE untouched.
- Existing guards green: join-repaint, join-replay-buffer, snapshot-cache, repaint-assist/wiring, geometry, fit, font, chunked-write, throttle, terminal-copy (164 passing), control tests.

## Verification

- Targeted mocha suites above; `node scripts/run-control-tests.js`.
- Manual matrix still required: Win Chrome + Linux Codespaces Edge via devtunnel (opencode Shift+drag copy, garble + cache-clear recovery, SIGINT, paste, splits, path-menu, mobile copy-visible).
