# ADR-0057: Copy keeps selection on failure; UTF-8 locale fallback; boundary-aware batching + opt-in cache-bypass rejoin

Status: Accepted
Date: 2026-09-16

## Context

Two separate user-facing issues, one shared theme (remote + Linux reliability):

1. **Copy loss:** `Ctrl/Cmd+C` did fire-and-forget `writeText()` + synchronous `clearSelection()`. On remote `http://`, denied permission, or unfocused doc the promise rejected after the highlight was gone; the next `Ctrl+C` sent `SIGINT` into the TUI. Under opencode SGR mouse-mode, plain drags never create an xterm selection at all (only `Shift+drag` bypasses).
2. **Persistent garble on Linux/Codespaces via devtunnel surviving reload:** a replay defect, not a render defect. Reload replays the same bytes from server `outputBuffer`/`_ctlTranscript`, client IndexedDB `cc-terminal-cache` (`paintCached` before join, `capture` re-saves corrupt frame), and persisted geometry. Contributors: mid-ESC/UTF-8 budget cuts, missing `LANG` (`C/POSIX` width mismatch), stale WebGL atlas.

## Decisions

1. **Copy clears only on success (Option A).** `copySelectionKeepOnFailure()` awaits `writeText`; success → `clearSelection + Copied`; failure/missing API → keep selection + `Clipboard denied — selection kept` badge + distinct `srAnnounce`. Keyboard handler returns `false` synchronously whenever a selection existed at keydown, so failure never degrades to `SIGINT`. Rejected Option B (failure → `return true`/SIGINT) as turn-killing.
2. **Document `Shift+drag`, reuse `TerminalCopy.copyVisible`.** Context-menu Copy `title` hint + palette description; existing keys-panel `Copy screen` covers mobile/Canvas. No change to paste/drop/voice paths or detector precedence.
3. **Locale fallback, non-Windows only.** `applyLocaleFallback()` sets `LANG=C.UTF-8` only when `LANG`/`LC_ALL` (env or process) are unset; never overrides explicit `LANG`/`LC_ALL`/`LANGUAGE`; no-op on `win32`; silent best-effort.
4. **Boundary-aware batching, tail-only.** `trailingHoldbackLength()` holds ≤16B trailing partial ESC/CSI/OSC/UTF-8 for the next frame; never stalls (hold < frame length); budget invariant kept; CRLF-safe byte scan.
5. **Opt-in cache-bypass rejoin, no verdict change.** `switchToTab({skipCachePaint, evictCache})` + `Clear Terminal Cache & Rejoin` palette action. Skips `paintCached`, optionally evicts that session, still clears pending frames/decoder and re-captures post-replay. Rejects force-`clear` verdict (regresses #131/ghost fix) and pre-replay `resize` (violates ADR-0052 ownership; use `FitCoordinator` only).

## Consequences

- Copy/palette/batch/cache paths gain unit tests (clipboard conditional-clear + SIGINT routing, batcher boundary, locale precedence); existing `join-repaint`, `join-replay-buffer`, `snapshot-cache`, `repaint-assist/wiring`, geometry, font, throttle suites stay green.
- `http://` LAN behavior changes for palette `copy-output` (async clipboard unavailable → legacy `execCommand` fallback retained).
- Bypass rejoin trades instant paint for correctness on demand; default tab-switch path unchanged.

## References

- `src/public/clipboard-handler.js`, `src/public/command-palette.js`, `src/public/index.html`, `src/public/session-manager.js`, `src/public/output-frame-batcher.js`, `src/base-bridge.js`
- Prior: ADR-0009/0010/0046/0047/0052/0055, #131 join-repaint, tab-switch-alt-screen-ghost, nerd-font tofu, `docs/specs/client-app.md` Clipboard section.
