# Trackpad scroll hijack fix + browser xterm.js 6.0 upgrade (2026-07)

## Symptom
"I am not able to scroll, it translates trackpad scroll to up and down buttons."
Inside the Claude Code TUI, every trackpad wheel notch moved the menu selection
up/down instead of scrolling.

## Root cause
xterm.js library behavior, not app code. When a full-screen app is on the
**alternate screen buffer** (`buffer.hasScrollback === false`), xterm converts
each scrolled line into cursor-key bytes (`ESC O A`/`ESC O B` or `ESC [ A`/`ESC [ B`)
and cancels native scroll — byte-identical to the on-screen ↑/↓ keys. Verified in
the 5.3.0 source and confirmed still present in the shipped 6.0.0 bundle
(now gated behind `_customWheelEventHandler`). Normal-buffer scrolling was never
affected. The repo had no custom wheel handler, so nothing intercepted it.

There is no automatic way to tell the Claude Code TUI from a pager (`less`) in the
alt buffer — both are alt-screen, no mouse, no DEC 1007 — so the fix is a
capture-phase preemptor plus a user toggle, defaulting to "don't hijack."

## Fix
- `src/public/terminal-wheel.js` — preempts xterm's translation. On xterm >= 5.4
  it uses the official `attachCustomWheelEventHandler` (return `false` to cancel);
  older xterm falls back to a capture-phase `wheel` listener on the terminal
  container. Policy: normal buffer → passthrough; alt+mouse → passthrough;
  alt+no-mouse → suppress (`dontHijack`, default) or passthrough (`altScroll`);
  explicit DEC 1007 overrides per app. The 1007 preference is per-alt-screen-app
  (reset on alt enter/exit 1049/1047/47 and RIS) so a stale flag from a prior app
  (tmux) can't hijack the next (Claude Code). Wired into `app.js` (main terminal)
  and `splits.js` (split panes).
- Settings toggle `wheelScrollMode` in the Terminal pane (default `dontHijack`).

## Bundled upgrade
- Browser xterm `xterm@5.3.0` (+ `xterm-addon-*`) → `@xterm/*@6`
  (xterm 6.0.0; addons fit 0.11 / web-links 0.12 / search 0.16 / unicode11 0.9 /
  webgl 0.19 / serialize 0.14). UMD globals unchanged. Aligns the browser with
  the server's existing `@xterm/headless@6`. Assets **self-hosted** under
  `src/public/vendor/xterm/` (not a CDN), like the fonts — loading them from
  unpkg made cold page-loads slow enough to tip the marginal WebKit-on-Windows
  E2E terminal-join over its 60s timeout. Served locally + cached by the SW fetch
  handler on first load (not in the SW precache, to keep the install step lean).
- **Canvas renderer dropped** (removed in xterm 6.0). Desktop: WebGL → DOM
  fallback. Mobile: DOM renderer (was Canvas). `_loadCanvasAddon` removed.
- Theme `selection` → `selectionBackground` (the removed key was already a no-op;
  `syncTerminalTheme()` sets it dynamically anyway).
- `node-pty` (`@lydell/node-pty`) left as-is on purpose (its only non-beta is a
  downgrade from the pinned beta).

## Tests
- `test/terminal-wheel.test.js` — 17-case decision matrix + wiring (buffer type ×
  mouse mode × mode × DEC 1007) and capture/dispose assertions.
- `e2e/tests/34-terminal-wheel-scroll.spec.js` — drives a real `page.mouse.wheel`
  over the terminal and observes `onData`: normal buffer and `dontHijack` emit no
  arrows; `altScroll` emits arrows.

## CI fallout from the xterm 6.0 upgrade (and how it was resolved)
The heavier xterm 6.0 page exposed a **Playwright-WebKit-on-Windows** engine bug:
after the terminal joins, WebSocket *inbound* frame delivery wedges ~15-30s in,
the heartbeat pong stops arriving, the socket is force-closed, and the close
handshake itself hangs ~30s. Verified from Playwright traces. It is NOT a product
defect — the same WebKit engine + xterm 6.0 passes on ubuntu-webkit (CI) and
macOS-webkit (local), and real Windows users run Edge (Chromium). Wrong leads
ruled out *on CI*: service worker (block probe still failed), the usage-reader
ENOENT console spam, a subpixel keys-panel assertion, and bigger timeouts
(60/120/180s). Resolution: run `test-browser-ios-webkit` on **ubuntu-latest only**
(ci.yml), keeping full WebKit/iOS coverage; Windows stays covered for the server
and all Chromium client tests.

Two real bugs surfaced by that investigation and fixed here:
- **usage-reader ENOENT spam** (`src/usage-reader.js findJsonlFiles`): a missing
  `~/.claude/projects` dir is expected (fresh machine / non-Claude tool); it now
  returns empty silently instead of `console.error`-ing on every 10s usage poll.
- **Reconnect dead-end** (`src/public/ws-reconnect.js`, wired in `app.js` onclose):
  the heartbeat force-closes with code 4000 to reconnect, but onclose gated
  reconnect on `!wasClean` — a clean 4000 close skipped reconnect, stranding the
  user on "Disconnected" after any transient pong-timeout (mobile sleep, NAT
  rebind) on ANY browser. Now code 4000 is an explicit reconnect trigger; the
  static "N attempts" message is corrected. Covered by `test/ws-reconnect.test.js`.

## Second CI fallout: `test-browser-new-features (windows-latest)` flake

After the WebKit-on-Windows job was moved to ubuntu, the `new-features` Windows
job started failing — one hard failure that rotated between
`14-file-browser.spec.js › clicking a text file shows preview` and
`14-nerd-font-rendering.spec.js` buffer-read tests, plus intermittent flakes.

**Root cause (reproduced locally, Windows):** the two nerd-font tests
(`powerline characters render at correct cursor position` and `bold text with
powerline PUA codepoints renders with correct cell widths`) read the just-written
line with `buffer.active.getLine(buffer.active.cursorY)`. `cursorY` is
**viewport-relative** (`0..rows-1`) but `getLine()` indexes the **absolute**
buffer (scrollback + viewport). Under xterm 6.0, `\x1b[2J` leaves prior shell
prompt output in scrollback, so at read time `baseY` is 2–4 (not 0). The write
itself was always correct — the cursor-advance (`delta`) and cell widths passed,
and `getLine(baseY + cursorY)` always returned the text — but `getLine(cursorY)`
read a blank scrollback line, so `translateToString(true)` was `""`. On xterm
5.3 the same tests passed (`baseY` stayed 0 here); a branch A/B under CI load
(`workers:2`, `CI=true`) measured 6/6 pass on `main` vs 1/6 on the PR branch,
confirming the upgrade exposed the latent test bug. The file-browser preview
hard-failure was CPU-contention collateral: the nerd-font retries loaded the
2-worker Windows runner enough to time out the (unrelated, Monaco-backed)
preview; it did not reproduce once the nerd-font tests passed first-try.

**Fix:** read the cursor's line at its absolute index —
`buffer.getLine(buffer.baseY + buffer.cursorY)` — in both nerd-font tests
(`e2e/tests/14-nerd-font-rendering.spec.js`). This is the canonical correct read
and is robust regardless of scrollback. No product code changed: xterm 6.0's
write/callback/buffer pipeline is byte-identical to 5.3 (verified against the
5.3.0 vs 6.0.0 `CoreTerminal.ts` / `WriteBuffer.ts` / `BufferLine.ts` sources).
Post-fix the two tests pass 8/8 in a loop and the full `new-features` project
passes 52/52 with zero flakes across repeated CI-load runs. No tests were
removed by the PR (additions only), so none needed restoring.

See ADR-0038.
