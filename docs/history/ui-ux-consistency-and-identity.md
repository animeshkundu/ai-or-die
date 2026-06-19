# UI/UX consistency and per-machine identity

## Date
2026-06-19

## Problem

Several UI surfaces had drifted just enough to confuse users or expose theme bugs:

- Multiple ai-or-die instances looked identical in browser tabs, installed PWAs,
  and notification surfaces.
- Overlay scrims, tool colors, subtle borders, and shadows were repeated as
  one-off values across components, which made light-theme bugs easy to miss.
- Settings had grown into a long settings form instead of a navigable dialog.
- Pre-auth screens needed to stay identity-neutral while authenticated screens
  needed to identify the machine.

## Solution

The pass standardized identity and UI primitives without changing the app's no-build frontend model:

- Added a shared UMD `app-identity.js` formatter used by both browser code and
  the server. Authenticated UI surfaces now use `[HOST] ai-or-die`, while empty
  hostnames degrade to `ai-or-die`.
- Built `/manifest.json` dynamically from the neutral base manifest. The server
  injects the host only when auth is not enforced; auth-protected manifests stay
  neutral so the pre-auth route does not leak `os.hostname()`.
- Kept pre-auth auth copy neutral ("This instance requires authentication.")
  because it renders before `/api/config` can provide the hostname.
- Reworked Settings into a two-pane tablist with preserved input IDs and native
  checkbox/select/range semantics, so `saveSettings()` / `applySettings()` and
  the Install state machine keep the same contract.
- Added overlay scrim tokens, tool-identity tokens, and `--border-subtle` across
  all themes. Tab badges and tool-card hover tints now share the same tool color
  source, and overlays use consistent darkness levels.
- Documented the file-editor 409 conflict UI as an intentional Layer-3 inline
  banner: the conflict is persistent and scoped to the editor, not an app-level
  modal.

## Why it matters

Multi-machine clarity now comes from a single formatter, not duplicated title and
notification logic. Privacy is preserved on pre-auth manifest requests. Theme
fixes are captured as tokens instead of one-off CSS patches, reducing future
light-theme regressions. Settings remains more accessible and easier to scan
without breaking existing stored settings or JavaScript contracts.

## Follow-up notes

- The orange app icon/brand mark and the blue default Midnight theme accent are
  intentionally separate choices.
- `/manifest.json` is network-only in the service worker so per-machine install
  metadata is not served stale from the PWA cache.
