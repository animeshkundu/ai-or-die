# ADR-0038: Browser xterm.js 6.0 upgrade and trackpad wheel-scroll policy

## Status
Accepted (2026-07-09).

## Context
Scrolling the trackpad inside a full-screen TUI (the Claude Code interface) did
not scroll — it visibly jumped menus/history, as if pressing the on-screen ↑/↓
keys. Root cause, verified against xterm.js source: when a full-screen app is on
the **alternate screen buffer** (`buffer.hasScrollback === false`), xterm.js
unconditionally converts each scrolled line into cursor-key bytes
(`ESC O A`/`ESC O B` or `ESC [ A`/`ESC [ B`) and cancels native scroll. Those are
byte-identical to the on-screen arrows, so wheel scrolling drives the TUI's
selection instead of scrolling. In a normal shell (normal buffer) wheel scroll
already worked; the issue was alt-buffer-only. This is xterm library behavior,
not app code — there was no custom wheel handler in the repo. xterm 5.3.0 exposed
no option to disable it.

Confirmed against the shipped xterm 6.0.0 bundle: the alt-buffer wheel→arrow
translation **still exists** in 6.0 (now gated behind a `_customWheelEventHandler`
check added in 5.4). So the fix must actively preempt it.

Separately, the browser xterm was pinned to the CDN **5.3.0** (deprecated
`xterm`/`xterm-addon-*` packages) while the server already ran
`@xterm/headless@^6.0.0`. Upgrading the browser aligns both on xterm 6 and picks
up two years of fixes.

### Why not just fully automate "scroll pagers but never hijack Claude Code"
In the alt buffer, the Claude Code TUI and a pager like `less` are
**indistinguishable** to the terminal: both are alt-screen, neither enables mouse
tracking, neither emits DEC private mode 1007 (alternate scroll). There is no
reliable automatic signal to tell them apart, so a user-facing toggle is the
honest control, with a default tuned for the Claude-Code-primary workflow.

## Decision
1. **Preempt the wheel translation.** New `src/public/terminal-wheel.js`. On
   xterm >= 5.4 it uses the official `terminal.attachCustomWheelEventHandler`
   (returning `false` cancels xterm's own wheel processing — both scrollback
   scroll and the arrow translation); on older xterm it falls back to a
   capture-phase `wheel` listener on the terminal container (an ancestor of
   `.xterm`) that `stopImmediatePropagation()`s. Wired into both the main
   terminal (`app.js setupTerminal`) and split panes (`splits.js createTerminal`).
2. **Policy** (`decideWheelAction`).
   - Normal buffer → passthrough (xterm scrolls scrollback natively).
   - Alt buffer + mouse tracking on → passthrough (xterm reports mouse events).
   - Alt buffer, no mouse → governed by the `wheelScrollMode` setting:
     `dontHijack` (default) suppresses arrows; `altScroll` lets xterm send arrows
     so pagers scroll.
   - An app that explicitly sets DEC 1007 overrides the default for that app
     (`1007h` → passthrough, `1007l` → suppress), observed via the xterm parser.
     The 1007 preference is **per-alt-screen-app**: it is cleared on alt-buffer
     enter/exit (1049/1047/47) and on RIS (ESC c), so a stale 1007 from a prior
     app (e.g. tmux) cannot hijack the next one (e.g. the Claude Code TUI).
3. **Settings toggle** `wheelScrollMode` (`dontHijack` | `altScroll`) in the
   Terminal settings pane; default `dontHijack` (best for the Claude Code TUI).
4. **Upgrade browser xterm 5.3.0 → 6.0.0** and its addons to the scoped
   `@xterm/*@6` packages (fit 0.11, web-links 0.12, search 0.16, unicode11 0.9,
   webgl 0.19, serialize 0.14). UMD globals are unchanged (`Terminal`,
   `FitAddon`, ...); only package names + `lib/` file paths changed. The assets
   are **self-hosted** under `src/public/vendor/xterm/` (not a CDN) — same
   rationale as the self-hosted fonts: deterministic, offline-capable, fast
   page-loads with no third-party runtime dependency. (Loading them from unpkg
   made cold page-loads slow enough to tip the marginal WebKit-on-Windows E2E
   terminal-join over its 60s timeout.) The vendored assets are served locally and
   cached by the runtime service-worker fetch handler on first load (offline works
   after the first online visit); they are deliberately NOT in the SW precache, so
   the install step stays lean. The SEA build already bundles `src/public/`
   recursively.
5. **Drop the Canvas renderer.** The canvas addon was removed in xterm 6.0 (its
   6.x line peers only `@xterm/xterm@^5`). Desktop uses WebGL and falls back to the
   **default DOM renderer** on WebGL failure/context-loss; **mobile now uses the
   DOM renderer** (previously Canvas "for reliability"). This supersedes the
   Canvas-on-mobile renderer choice implied by prior terminal-rendering work.
6. **Theme key fix.** The initial theme used the long-removed `selection` key;
   corrected to `selectionBackground` (which `syncTerminalTheme()` already sets
   dynamically from `--terminal-selection`).

## Consequences
- New module `src/public/terminal-wheel.js` (+ `test/terminal-wheel.test.js` unit
  matrix and `e2e/tests/34-terminal-wheel-scroll.spec.js` driving a real wheel).
- `@xterm/headless` (server, `sticky-note-transcript.js`) is unchanged — already
  on v6 and decoupled from the browser build.
- `node-pty` (`@lydell/node-pty`) is intentionally **not** touched: the fork's
  `latest` dist-tag is a beta and its only non-beta (`1.1.0`) is older than the
  pinned `1.2.0-beta.10`, so "latest stable" would be a downgrade.
- Limitation: in the alt buffer with `dontHijack`, the wheel does nothing (there
  is nothing to scroll and we refuse to hijack); pagers need `altScroll` or their
  own mouse support. This is the honest consequence of Claude Code and pagers
  being indistinguishable there.
- Verification gate: unit suite, the new Playwright spec (power-user-flows
  project, chromium + WebKit, Windows + Linux), plus the existing terminal/link-
  provider/serialize suites that exercise the xterm-6 upgrade.
