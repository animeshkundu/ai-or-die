# Notification System Specification

## Overview

The notification system alerts users when background sessions complete tasks, encounter errors, or go idle. It supports desktop notifications (Windows Notification Center via Service Worker), in-app toast notifications, and synthesized audio chimes.

## Notification Types

| Type | Trigger | Chime | Example Title |
|------|---------|-------|---------------|
| `success` | Build/test/deploy completion pattern matched | Ascending C5→E5 | `[HOST] my-project — Build completed` |
| `error` | Session error detected | Descending E4→C4 | `[HOST] my-project — Error detected` |
| `idle` | 90 seconds of no output after activity | Single G5 | `[HOST] my-project — Claude appears finished` |

## Notification Content

### Title Format
```
[Hostname] SessionName — Event Description
```
- **Hostname**: Machine name from `os.hostname()`, exposed via `/api/config`
- Omitted if hostname is empty (e.g., local-only usage)

### Body Format
```
.../parent/workingDir
45s | Claude
```
- Working directory abbreviated to last 2 path segments
- Duration since last activity (seconds)
- Agent name (Claude, Codex, Copilot, Gemini, Terminal)

## Delivery Channels

### Desktop Notifications (page not visible)
1. **Service Worker** (preferred): `ServiceWorkerRegistration.showNotification()` — persists in Windows Notification Center / Action Center. Supports "Open Session" action button.
2. **Fallback**: `new Notification()` — transient, does not persist in Action Center. Used when SW is not available.

### In-App Toast (page visible, background tab)
- Fixed position, top center
- Slide-down animation (300ms)
- Auto-dismiss after 5 seconds
- Click to switch to session tab
- Title flashing in page title bar
- Vibration on mobile (200ms-100ms-200ms pattern)

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
| `src/public/session-manager.js` | Notification triggering, chime synthesis, toast UI |
| `src/public/service-worker.js` | `notificationclick` handler, cache version |
| `src/public/app.js` | Hostname storage, SW message listener, settings wiring |
| `src/public/index.html` | Notification settings HTML in settings modal |
| `src/server.js` | `hostname` in `/api/config` response |
| `src/public/components/modals.css` | `.setting-divider` style |

## Accessibility

- All chimes are < 3 seconds (WCAG 1.4.2 compliance)
- Sound is **supplementary** — always paired with visual notification (toast or tab indicator)
- Mute toggle available in settings
- Toast uses `cursor: pointer` for click affordance
