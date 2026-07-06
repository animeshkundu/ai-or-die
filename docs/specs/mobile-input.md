# Spec: Mobile input for Claude Code (key matrix + two-mode model)

Status: active. Owner: mobile. Related: ADR-0037. Tests: `test/key-encoder.test.js` (executable source of truth), `test/extra-keys-sequences.test.js`, `e2e/tests/77-mobile-input-completeness.spec.js`.

## Goal
A user on an iPhone (installed PWA, Edge on iOS = WebKit) must fully drive the Claude Code TUI by touch with no desktop fallback. Every key the TUI needs is reachable; anything the soft keyboard lacks is presented in the on-screen keys bar or the keys panel.

## Two modes
- **Compose** (soft keyboard up): free prompt text via the native composer (autocorrect/IME off). Inline extra-keys bar rides above the keyboard for specials. Focus retention matters here.
- **Control** (keyboard down, full screen): read output + drive the TUI via the keys panel. Panel taps `app.send({type:'input'})` reach the pty without needing textarea focus, so no keyboard-dismiss flicker.

## Mode-aware encoding (critical)
Key bytes depend on terminal state, read from `terminal.modes`:
- **Cursor keys** (arrows, Home, End) are **SS3** (`\x1bO<final>`) when `applicationCursorKeysMode` is true, else **CSI** (`\x1b[<final>`). Any modifier forces CSI with a modifier param (`\x1b[1;<m><final>`), never SS3.
- **Paste** is wrapped in bracketed-paste (`\x1b[200~`..`\x1b[201~`) when `bracketedPasteMode` is true.
- Do not hardcode raw bytes in the key definitions; go through `key-encoder.js`.

Modifier param `m = 1 + (shift?1) + (alt?2) + (ctrl?4)`, emitted only when `m > 1`.

## Key matrix

| Key | Base (normal) | Application-cursor mode | With modifier (m>1) |
|-----|---------------|-------------------------|---------------------|
| Up / Down / Right / Left | `\x1b[A` / `B` / `C` / `D` | `\x1bOA` / `OB` / `OC` / `OD` | `\x1b[1;mA..D` |
| Home / End | `\x1b[H` / `\x1b[F` | `\x1bOH` / `\x1bOF` | `\x1b[1;mH` / `F` |
| Insert / Delete | `\x1b[2~` / `\x1b[3~` | (same) | `\x1b[2;m~` / `\x1b[3;m~` |
| PgUp / PgDn | `\x1b[5~` / `\x1b[6~` | (same) | `\x1b[5;m~` / `\x1b[6;m~` |
| F1–F4 | `\x1bOP` / `OQ` / `OR` / `OS` | (same) | `\x1b[1;mP..S` |
| F5–F12 | `\x1b[15~`,`17~`,`18~`,`19~`,`20~`,`21~`,`23~`,`24~` | (same) | `\x1b[<n>;m~` |
| Tab | `\t` | | Shift+Tab → `\x1b[Z` |
| Esc | `\x1b` | | Alt → `\x1b\x1b` |
| Enter | `\r` | | Alt → `\x1b\r` |
| Backspace | `\x7f` | | |
| Ctrl+`<a-z>` | control code (`c`→`\x03`) | | |
| Ctrl+`[` `\` `]` `^` `_` `@` `?` Space | `\x1b` `\x1c` `\x1d` `\x1e` `\x1f` `\x00` `\x7f` `\x00` | | |
| Alt+`<char>` | `\x1b` + char | | |
| printable / symbols (`/ @ # ! | \ ~ { } [ ] ( ) ; : = + &` …) | literal | | |

Readline word-ops surfaced in the panel: Alt+B / Alt+F / Alt+D / Alt+Backspace, Ctrl+A / Ctrl+E / Ctrl+U / Ctrl+K / Ctrl+W.

## Reachability requirement
Every row above must map to a reachable affordance (soft keyboard, extra-keys bar, or keys panel). Enforced by the completeness unit test. Critical keys (Esc, one-tap Ctrl+C, Shift+Tab, arrows, Enter) emit a **complete sequence directly** — they must not depend on the sticky-modifier + soft-keyboard-letter path (sticky modifiers are convenience only).

## Composer
The native composer is the existing **InputOverlay** (`src/public/input-overlay.js`), reused rather than duplicated. Its `<textarea id="inputOverlayText">` carries `autocorrect="off" autocapitalize="none" autocomplete="off" spellcheck="false" inputmode="text"` so iOS text mutation never reaches the pty. Multi-line editing; Insert/Send modes; Send wraps in bracketed paste (when `bracketedPasteMode`) and appends CR. The existing STT/voice pipeline dictates into it via `app._voiceTarget = 'overlay'` (set on show, restored to `'terminal'` on hide). Reachable on mobile via the tab-actions composer button (`#inputOverlayBtn`, not in the mobile-hidden set). Tests: `test/input-overlay-composer.test.js`.
