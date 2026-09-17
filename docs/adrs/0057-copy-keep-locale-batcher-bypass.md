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

## Addendum (2026-09-17): OSC 52 bridge

User testing showed the keep-on-failure fix was insufficient for opencode:
opencode's own copy action reports "copied to clipboard" after emitting OSC 52,
which sets only the *remote host* clipboard — unreachable from the browser
machine. Decision: client-side OSC 52 → `navigator.clipboard` bridge
(`src/public/osc52-handler.js`, wired in `app.js`/`splits.js` live-output
paths only). Only `c`/empty Pc honored, queries never answered, 512KiB cap,
failures via existing error badge. Covered by `test/osc52-handler.test.js`
(19 cases). This is standard emulator behavior (xterm/VS Code/iTerm all
bridge OSC 52); the browser permission gate remains the backstop.

## Addendum 2 (2026-09-17): per-TUI verification (opencode/Copilot/Claude)

Researched upstream implementations rather than assuming one OSC 52 shape:

- **opencode** (`tui/util/clipboard.ts`): always writes `ESC ] 52 ; c ; <b64> BEL`
  on copy when stdout is a TTY, plus native host tools; wraps in tmux DCS
  passthrough (`ESC P tmux ; … ESC \`, ESCs doubled) under `$TMUX`/`$STY`.
- **Copilot CLI** (Bubble Tea `SetClipboard`, copy-on-select since v1.0.20):
  OSC 52 writes for clipboard operations.
- **Claude Code fullscreen TUI** (docs: `/tui fullscreen`): native tools on
  local sessions, tmux paste buffer under tmux, **OSC 52 only over SSH**
  (SSH-env-gated), screen clipboard for long selections; toast names the path.

Decisions from this:
1. Parser unwraps tmux DCS passthrough with a precise scanner (a lazy regex
   truncates ST-terminated inner sequences whose doubled `ESC ESC \` mimics
   the wrap terminator); non-tmux DCS (sixel) passes through untouched and
   carries nothing. Pc `p` mapped onto the system clipboard.
2. `BaseBridge` sets loopback `SSH_CONNECTION`/`SSH_CLIENT` when no SSH vars
   exist (opt-out `AIORDIE_NO_SSH_CLIPBOARD_HINT=1`). The display genuinely is
   remote, so this is a topology hint, not a spoof; it steers SSH-gated apps
   onto the bridged path. Vars are informational-only (nothing dials out on
   them); real SSH sessions and explicit config always win.
3. Paste direction unchanged: queries never answered; native/browser paste
   remains the paste path.

Covered by `test/osc52-handler.test.js` (25 cases incl. tmux wrap/split/ST-inner/sixel)
and `test/base-bridge-ssh-hint.test.js` (5 cases).

## References

- `src/public/clipboard-handler.js`, `src/public/command-palette.js`, `src/public/index.html`, `src/public/session-manager.js`, `src/public/output-frame-batcher.js`, `src/base-bridge.js`
- Prior: ADR-0009/0010/0046/0047/0052/0055, #131 join-repaint, tab-switch-alt-screen-ghost, nerd-font tofu, `docs/specs/client-app.md` Clipboard section.
