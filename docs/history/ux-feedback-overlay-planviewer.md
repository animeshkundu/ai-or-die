# UX Feedback System, Input Overlay, Plan Viewer

## Date
2026-03-01

## Problem

The codebase had 6+ fragmented notification patterns (clipboard-toast, mobile-notification, notif-permission-prompt, sw-update-banner, memory warning, voice feedback) each with different CSS, positioning, animations, and lifecycle. Users had no way to compose input while AI agents streamed output. The plan viewer used a rudimentary regex-based markdown renderer that missed code blocks, tables, and nested lists, and only worked with Claude (not Copilot, Codex, or Gemini).

## Solution

Three features implemented across 23 files (+2,164/-545 lines):

### Feature 1: Three-Layer Feedback System
- **Micro-feedback**: Inline "Copied" badge via callback pattern (`clipboard-handler.js` calls `window.showCopiedFeedback()`)
- **Toasts**: `FeedbackManager` singleton at `src/public/feedback-manager.js` (~99 lines) with `info/success/warning/error` methods, action buttons, dedup, queue
- **Banners**: Shared `banner-base.css`, status indicator buttons (24x24px, 44x44px touch), WCAG 2.2.1 compliant auto-dismiss

Architecture decision documented in `docs/adrs/0014-notification-taxonomy.md`.

### Feature 2: Type-Ahead Input Overlay
- `Ctrl+Shift+Space` toggle via capture-phase listener (NOT `attachCustomKeyEventHandler` — that slot is occupied by clipboard handler)
- Insert (Ctrl+Enter) vs Send (Ctrl+Shift+Enter) with bracketed paste wrapping
- Voice via singleton redirect (`_voiceTarget` flag), split pane routing (`_lastFocusedPaneIndex`)

Spec at `docs/specs/input-overlay.md`.

### Feature 3: Multi-Tool Plan Viewer
- marked.js + DOMPurify rendering (lazy-loaded, fallback to escaped pre-formatted text)
- Tool-aware detection for Claude, Copilot, Codex, Gemini — only distinctive keywords (no false-positive-prone `Plan:` or `Step `)
- `/api/plans/content` + `/api/plans/list` endpoints with layered path traversal defense
- File-based polling (3s, mtime stability) + terminal output parsing (universal fallback)

Spec at `docs/specs/plan-viewer.md`.

## Key Decisions

1. **No notification center** — dropped as overkill for single-user app (both adversarial review rounds flagged it)
2. **Tunnel banners keep their own DOM/lifecycle** — too complex for a generic BannerManager (auth flows, install panels, progress bars)
3. **Plan indicator does NOT auto-open** — just pulses, user clicks to view
4. **Copilot plans are terminal-parsed only** — confirmed Copilot CLI stores plans in session state JSON, not standalone files
5. **`attachCustomKeyEventHandler` is a singleton** — can't use for input overlay shortcut since clipboard handler already occupies it

## Traps and Pitfalls

- **`normalizeLineEndings()` converts `\n` to `\r`** — safe inside bracketed paste, but in raw mode Insert it would execute each line. Fix: collapse to spaces in non-bracketed Insert mode.
- **Two `VoiceInputController` instances cause silent failures** — browser enforces single SpeechRecognition. Must use singleton pattern with callback redirection.
- **`_deliverVoiceTranscription()` is the delivery point for local-mode transcription** (server round-trip bypasses controller callbacks) — must intercept there, not just on the controller.
- **`marked.js` does NOT sanitize HTML** — must always pair with DOMPurify. The old regex renderer also had this XSS.
- **`'Plan:'` as a trigger keyword causes false positives** — common in conversation ("Here's the plan:") and code comments.

## Files Changed

### New (8)
- `src/public/feedback-manager.js` — Toast system
- `src/public/input-overlay.js` — Input overlay
- `src/public/components/feedback.css` — Toast styles
- `src/public/components/input-overlay.css` — Overlay styles
- `src/public/components/banner-base.css` — Shared banner CSS
- `src/public/vendor/marked.min.js` — Markdown parser
- `src/public/vendor/purify.min.js` — HTML sanitizer
- `scripts/update-vendor.sh` — Re-vendor script

### Modified (15)
- `src/public/app.js` — All features: init, modal mutex, voice redirect, overlay, plan rendering, polling
- `src/public/index.html` — Scripts, CSS, HTML elements, overflow menu
- `src/server.js` — `/api/plans` endpoints
- `src/public/plan-detector.js` — Multi-tool support, tool-awareness, suppression
- `src/public/clipboard-handler.js` — Callback pattern for micro-feedback
- `src/public/session-manager.js` — Migrated to FeedbackManager
- `src/public/vscode-tunnel.js` — Status indicators, WCAG auto-dismiss
- `src/public/app-tunnel.js` — Status indicators
- `src/public/splits.js` — `_lastFocusedPaneIndex` tracking
- `src/public/tokens.css` — Z-index scale tokens
- `src/public/auth.js` — Token-based z-index
- `src/public/components/menus.css` — Token-based z-index
- `src/public/components/tabs.css` — Overflow menu, badge styles
- `src/public/components/modals.css` — Plan markdown styles
- `src/public/components/notifications.css` — Removed deprecated classes

## Review Process

Two rounds of adversarial review (10 expert reviewers: Architect, Principal Engineer, Systems Engineer, Lead AI Engineer, UX/A11y Specialist x2, Frontend Architect, Terminal UX, Server Security, Integration Engineer). 193 plan items verified. 3 critical bugs found and fixed during review (split pane tracking, plan tool awareness, symlink in list endpoint).
