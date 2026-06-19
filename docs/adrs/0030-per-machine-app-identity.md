# ADR-0030: Per-Machine App Identity

## Status

**Accepted**

## Date

2026-06-19

## Context

ai-or-die is often opened from multiple machines through browser tabs, PWAs, or
remote tunnels. The old neutral title (`ai-or-die`) made those instances hard to
distinguish. Desktop notifications already used a bracketed hostname prefix, so
the window title, installed-app name, and notifications could disagree about
which machine produced an event.

At the same time, the PWA manifest is fetched before the app is authenticated.
Embedding `os.hostname()` there unconditionally would leak a machine name to any
unauthenticated client that can request `/manifest.json`.

The app also has an existing orange PWA icon/brand mark while the default
Midnight theme uses a blue accent. We considered aligning them but chose to keep
that split: the icon is product brand, the default theme accent is UI chrome.

## Decision

Use the shared display format:

```text
[HOST] ai-or-die
```

If the hostname is empty after sanitization, fall back to plain `ai-or-die`.
The host label is sanitized for display before use: unsafe invisible/control
characters are removed, whitespace is collapsed, the first DNS label is used by
default, and long labels are shortened for title contexts.

Add `src/public/app-identity.js` as a no-build UMD module shared by browser and
server code:

- Browser: exposes `window.AppIdentity` before `session-manager.js` and `app.js`.
- Server: exports through `module.exports` for the dynamic manifest route.
- Formatting helpers stay pure and DOM-free; only `applyAppIdentity()` touches
  the DOM and no-ops when no `document` exists.

After authenticated `/api/config` populates `hostname`, `app.js` applies the
identity to `document.title`, the mobile menu title, the app `aria-label`, the
PWA title meta tags, and the start-screen identity chip. `session-manager.js`
uses `formatNotificationTitle()` so notifications and titles share the same
bracketed prefix; the formatter is idempotent and will not double-prefix.

Build `/manifest.json` dynamically in memory from the neutral base manifest:

- In SEA mode, read `public/manifest.json` via `sea.getRawAsset()`.
- Otherwise, read it from the filesystem.
- When auth is not enforced, inject `name: "[HOST] ai-or-die"` and a short,
  hard-truncated host label for `short_name`.
- When auth is enforced, leave the manifest neutral (`ai-or-die`) because the
  route is pre-auth and must not leak `os.hostname()`.
- On error, fall back to the static/base manifest.

The service worker treats `/manifest.json` as network-only so the per-machine
manifest is not served stale from the PWA cache.

## Consequences

### Positive

- Browser tabs, mobile/PWA title surfaces, the start screen, and desktop
  notifications identify the host consistently.
- The formatter is shared across browser and server paths, avoiding drift between
  the UI, notifications, and manifest.
- Authenticated sessions still show the machine identity, while the pre-auth
  manifest keeps the privacy-safe neutral default.

### Negative

- The manifest name can differ before and after authentication: auth-protected
  installs stay neutral, while in-session UI shows the host after `/api/config`.
- Installed PWA launchers have limited `short_name` space, so the manifest uses a
  hard-truncated host label rather than the full `[HOST] ai-or-die` identity.

### Neutral

- Empty or unusable hostnames intentionally degrade to `ai-or-die`.
- The orange PWA icon and the blue default Midnight UI accent remain separate
  brand/UI choices.

## Notes

- Implementation: `src/public/app-identity.js`, `src/server.js` `/manifest.json`,
  `src/public/app.js` initialization, `src/public/session-manager.js`, and
  `src/public/service-worker.js`.
