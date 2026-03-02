# Notification System Specification

## Overview

The notification system uses a three-layer taxonomy (see [ADR-0014](../adrs/0014-notification-taxonomy.md)):

| Layer | Purpose | Implementation | Duration |
|-------|---------|----------------|----------|
| **Micro-feedback** | Confirm user's direct action | Inline badge at trigger point | 1.5s auto-revert |
| **Toasts** | System events needing awareness | `FeedbackManager` (`window.feedback`) | 4-8s or persistent |
| **Banners** | Ongoing conditions/states | `banner-base.css` + tunnel-specific JS | Until condition resolves |

Additionally, desktop notifications (Windows Notification Center via Service Worker) fire when the page is not visible.

## Layer 1: Micro-Feedback

### Clipboard "Copied" Badge
- `clipboard-handler.js` calls `window.showCopiedFeedback()` callback (decoupled via callback pattern)
- `app.js` wires callback to show/hide `#copyFeedbackBadge` element in terminal header
- Fades after 1.5s, accent background, `font-size: var(--text-sm)`
- Clipboard errors show in same badge location with `.error` class (red color)
- Screen reader: `#srAnnounce` element updated with "Copied to clipboard"

## Layer 2: Toasts (FeedbackManager)

Source: `src/public/feedback-manager.js` (~99 lines)

### API
```js
window.feedback.info(message, opts?)    // 4s auto-dismiss
window.feedback.success(message, opts?) // 4s auto-dismiss
window.feedback.warning(message, opts?) // 6s auto-dismiss
window.feedback.error(message, opts?)   // persistent (requires dismiss)
```

`opts`: `{ duration, action, onAction, dismissible, id }`

### Behavior
- Position: `top: 16px; right: 16px; z-index: var(--z-toast, 500)`
- Max 3 visible, overflow queued (FIFO)
- Deduplication: same-message toast already visible → skip
- Distinct SVG icon shapes per type (WCAG 1.4.1 — not color alone)
- Colored left-border: `--status-info` / `--status-success` / `--status-warning` / `--status-error`
- ARIA: `role="status"` for info/success, `role="alert"` only for errors
- `@media (prefers-reduced-motion: reduce)`: instant opacity transitions
- Mobile (<480px): full-width

### Callers
| Caller | Method | Message |
|--------|--------|---------|
| Voice transcription timeout | `feedback.error(msg)` | Transcription timed out |
| Voice recording error | `feedback.error(msg)` | Microphone access denied |
| Background session activity | `feedback.info(title + body, { action: 'Switch' })` | Session completed |
| SW update available | `feedback.info(msg, { action: 'Refresh Now' })` | New version available |
| Notification permission | `feedback.info(msg, { action: 'Enable' })` | Enable notifications? |

## Audio Chimes

Synthesized via Web Audio API (no external audio files).

### Success Chime
- Two ascending sine tones: C5 (523 Hz), E5 (659 Hz)
- 150ms per tone, 50ms gap between
- Gain: user volume setting (default 0.3)

### Error Chime
- Two descending triangle tones: E4 (330 Hz), C4 (262 Hz)
- 120ms per tone, 40ms gap between
- Gain: 67% of user volume

### Idle Chime
- Single sine tone: G5 (784 Hz)
- 200ms duration
- Gain: 50% of user volume

## User Settings

Stored in `localStorage` key `cc-web-settings`:

| Setting | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| Sound | `notifSound` | boolean | `true` | Enable/disable notification chimes |
| Volume | `notifVolume` | number (0-100) | `30` | Chime volume (maps to 0–0.3 gain) |
| Desktop | `notifDesktop` | boolean | `true` | Enable/disable desktop notifications |

Settings accessible from Settings modal under "Notifications" section.

## Suppression Rules

- Notifications are **never** sent for the active tab
- Desktop notifications only fire when `document.visibilityState !== 'visible'`
- Audio only plays if `notifSound` is `true` and `notifVolume > 0`
- Desktop only fires if `notifDesktop` is `true`

## Service Worker Integration

### `service-worker.js`
- `notificationclick` event handler focuses existing window and posts `NOTIFICATION_CLICK` message
- Falls back to `clients.openWindow('/')` if no window exists

### `app.js`
- Listens for `message` events from SW with `type: 'NOTIFICATION_CLICK'`
- Calls `sessionTabManager.switchToTab(sessionId)`

## API

### `GET /api/config`
Returns `hostname` field (`os.hostname()`) for notification title prefixing.

### `sendNotification(opts)`
Accepts object `{ title, body, sessionId, type }` or legacy positional args `(title, body, sessionId)`.

### `playNotificationChime(type)`
Plays synthesized chime for given type. Respects `notifSound` and `notifVolume` settings.

## Files

| File | Role |
|------|------|
| `src/public/feedback-manager.js` | `FeedbackManager` class — toast API (Layer 2) |
| `src/public/components/feedback.css` | Toast styles |
| `src/public/components/banner-base.css` | Shared banner base styles (Layer 3) |
| `src/public/clipboard-handler.js` | Micro-feedback callback (`showCopiedFeedback`) |
| `src/public/session-manager.js` | Notification triggering, chime synthesis, desktop notifications |
| `src/public/service-worker.js` | `notificationclick` handler, cache version |
| `src/public/app.js` | Micro-feedback wiring, modal mutex, voice redirect |
| `src/public/index.html` | Badge element, notification settings HTML, toast script tag |
| `src/public/vscode-tunnel.js` | Status indicators, WCAG auto-dismiss (Layer 3) |
| `src/public/app-tunnel.js` | Status indicators (Layer 3) |
| `src/server.js` | `hostname` in `/api/config` response |
| `src/public/components/notifications.css` | Loading patterns (deprecated toast/banner classes removed) |

## Accessibility

- All chimes are < 3 seconds (WCAG 1.4.2 compliance)
- Sound is **supplementary** — always paired with visual notification (toast or tab indicator)
- Mute toggle available in settings
- Toast uses `cursor: pointer` for click affordance
