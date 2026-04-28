# PWA install on LAN with `--https` self-signed cert

## Symptom

Users reported the in-app Install panel (Settings → Install) shows **"Not available in this browser."** when accessing the server from another device on the local network via the auto-generated self-signed certificate (`ai-or-die --https`). The same Chrome that says "Not available" on the LAN URL will install the app cleanly when pointed at `https://localhost`.

## Investigation

Phase 0 ran a Playwright probe with full Chromium 145 against an isolated server on port 11202 and against the user's `--https` server on port 11206. Two scenarios:

| Origin | Cert trust | `installabilityErrors` | `_installState` | Settings panel text |
|---|---|---|---|---|
| `http://localhost:11202` | n/a (localhost) | `[]` | `available` | "Ready to install as a standalone app." |
| `https://localhost:11206` (self-signed cert) | localhost-secure exception | `[]` | `available` | "Ready to install as a standalone app." |
| `https://10.0.0.9:11206` (same cert, LAN IP) | untrusted | `[{"errorId":"not-from-secure-origin"}]` | `unavailable` | **"Not available in this browser."** |

The LAN scenario also shows `navigator.serviceWorker.getRegistrations()` returning `[]` — the service worker never registers because Chrome refuses SW installation on an untrusted origin.

## Root cause

Chromium's installability evaluator treats only `localhost` / `127.0.0.1` / `[::1]` as secure-by-default. Every other origin must produce an HTTPS connection with a **certificate signed by a CA in the device's trust store**. The auto-generated cert at `~/.ai-or-die/certs/server.cert` (created by `bin/ai-or-die.js` when `--https` is set without `--cert`/`--key`) is self-signed; even after the user clicks through Chrome's interstitial, the connection is treated as `not-from-secure-origin` for installability purposes. PWA install (and service-worker registration, and several other powerful-feature gates) silently refuses.

The in-app state machine (`src/public/app.js:92-125`) cannot detect this because `window.isSecureContext` returns `true` for any `https:` URL, including untrusted ones — there is no JS API that surfaces "this connection is technically HTTPS but the browser doesn't trust the cert." After the 3-second fallback timer, the state machine falls through to `'unavailable'` with the catch-all message "Not available in this browser." That message is technically wrong: the browser does support PWA install; it's the deployment that doesn't meet criteria.

## Why the prior icon-MIME hypothesis was wrong

A separate bug exists in the codebase: `src/server.js:310-337` declares icons in the manifest as `"type": "image/png"` but actually serves SVG bytes with `Content-Type: image/svg+xml`. We initially suspected this caused Chromium's icon decoder to reject the manifest. The Phase 0 probe disproved it — Chromium 145 successfully decodes the SVG and the install prompt fires anyway on a localhost-secure origin. The MIME mismatch is a real wire-protocol contract violation that may affect Safari iOS and Firefox Android, but it does not cause the user-visible "Not available on LAN" symptom.

## Workarounds for users

There are three ways to install the PWA on a LAN device:

1. **Use `--tunnel`** *(recommended)* — `ai-or-die --tunnel` exposes the server through Microsoft Dev Tunnels with a real Let's Encrypt certificate. LAN devices install via the public `*.devtunnels.ms` URL with no cert trust step.
2. **Trust the self-signed cert on each device** — copy `~/.ai-or-die/certs/server.cert` to the device and install it as a trusted root in the OS certificate store (Keychain Access on macOS, Settings → General → VPN & Device Management → Profile → enable Certificate Trust on iOS, Settings → Security → Install certificate on Android, Trusted Root Certification Authorities on Windows). Once trusted, Chrome treats the LAN HTTPS as secure and installability becomes available.
3. **Use a CA-signed cert** — provide `--cert` and `--key` pointing at a real certificate covering the LAN IP or hostname. mkcert (`mkcert localhost 10.0.0.9`) is a low-friction option for development environments.

## Future work (not committed)

Options for an in-app fix:
- When the state machine times out without `beforeinstallprompt` AND `location.protocol === 'https:'` AND `location.hostname` is not localhost, replace the generic "Not available" copy with a specific cert-trust explanation and a link to the workaround.
- Add `--tunnel` recommendation to the install-unavailable state when `location.host` looks like a private IP (RFC 1918 ranges).
- Fix the icon MIME mismatch (`src/server.js:310-337`) as a separate hardening pass for non-Chromium browsers.

None of these changes the underlying Chromium behavior; the cert trust requirement is enforced by the browser and cannot be bypassed from page JavaScript.
