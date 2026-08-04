# Input Overlay Specification

## Overview

The Type-Ahead Input Overlay allows users to compose text while an AI agent is actively streaming output. It provides a floating textarea with Insert (place at cursor) and Send (place + Enter) modes, voice input integration, and split pane awareness.

## Trigger

| Method | Shortcut | Notes |
|--------|----------|-------|
| Button | Click `#inputOverlayBtn` in header | Primary trigger, always discoverable |
| Keyboard | `Ctrl+Shift+Space` | Capture-phase `document.addEventListener` — does NOT use `attachCustomKeyEventHandler` (which is occupied by clipboard handler) |

## Modes

| Mode | Shortcut | Button | Behavior |
|------|----------|--------|----------|
| **Insert** | `Ctrl+Enter` | `.input-overlay-insert` (primary) | Places text at terminal cursor without pressing Enter |
| **Send** | `Ctrl+Shift+Enter` | `.input-overlay-send` (secondary) | Places text at cursor + sends Enter (`\r`) |
| **Cancel** | `Escape` | `.input-overlay-cancel` | Closes overlay without action |

Insert is the primary (safer) action — accidental Insert is harmless; accidental Send could execute a command.

## Multi-Line Handling

| `bracketedPasteMode` | Insert Mode | Send Mode |
|----------------------|-------------|-----------|
| `true` | `normalizeLineEndings()` + `wrapBracketedPaste()` | Same + append `\r` |
| `false` | Collapse `\n` to spaces (raw newlines would execute as separate commands) | `normalizeLineEndings()` + append `\r` |

Uses `attachClipboardHandler.normalizeLineEndings()` and `attachClipboardHandler.wrapBracketedPaste()` from `clipboard-handler.js`.

## Voice Integration

Reuses the existing singleton `VoiceInputController` from `voice-handler.js` — does NOT create a second instance (browser enforces single SpeechRecognition / getUserMedia stream).

- `app._voiceTarget` flag (`'terminal'` | `'overlay'`) controls where transcription is delivered
- When overlay opens: `_voiceTarget = 'overlay'`; `_deliverVoiceTranscription()` inserts at textarea cursor
- When overlay closes: `_voiceTarget = 'terminal'` (restore normal path)
- Edge case: transcription arrives after overlay closes → delivered to terminal with info toast

## Split Pane Support

- `app._lastFocusedPaneIndex` tracks the most recently focused split pane (updated by `splits.js:focusSplit()`)
- Target (terminal + socket) captured at overlay **open** time via `_captureTarget()` — retained until close
- If user clicks a different pane while overlay is open, the original target is preserved

## Plan Detection Suppression

While overlay is open, `planDetector._suppressDetection = true` to prevent echoed overlay text (containing words like "plan" or "step") from triggering false positives.

## UI Layout

```
┌─────────────────────────────────────┐
│ Type-Ahead Input        Esc to cancel│
├─────────────────────────────────────┤
│                                      │
│  [textarea]                          │
│                                      │
├─────────────────────────────────────┤
│ 0  🎤  ·····  [Cancel] [Insert] [Send]│
└─────────────────────────────────────┘
```

- Backdrop: semi-transparent overlay dims terminal, prevents click-through
- Character count: displays in footer, warns at 200KB (yellow, bold)
- Textarea: monospace font, auto-resize up to max-height 200px
- The panel consumes left, right, and bottom safe-area tokens, including
  landscape side insets, without changing the terminal rectangle.
- Motion resolves through shared duration/easing tokens and reduced-motion
  removes non-essential animation.

## CSS

- `z-index: var(--z-input-overlay)` (550 — above tooltips)
- Backdrop: `rgba(0, 0, 0, 0.4)`, covers entire terminal container
- `@media (prefers-reduced-motion: reduce)`: no slide animations

## Files

| File | Role |
|------|------|
| `src/public/input-overlay.js` | `InputOverlay` class (~280 lines) |
| `src/public/components/input-overlay.css` | Styling (~168 lines) |
| `src/public/app.js` | Init, `_voiceTarget` redirect, `_lastFocusedPaneIndex`, modal mutex |
| `src/public/splits.js` | Updates `_lastFocusedPaneIndex` in `focusSplit()` |
| `src/public/index.html` | HTML for overlay, backdrop, trigger button |

## Accessibility

- `aria-label="Type-ahead input for terminal"` on textarea
- Insert/Send buttons have `title` attributes explaining behavior
- 16px+ gap between Insert and Send prevents mis-clicks
- Escape key always closes (keyboard accessible)
- Focus trapped within overlay while open
