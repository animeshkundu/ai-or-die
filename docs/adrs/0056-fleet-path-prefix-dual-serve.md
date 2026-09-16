# ADR-0056: Zero-Config Fleet Path Prefix (`/m/<id>/` Dual-Serve)

## Status

Accepted

## Date

2026-09-16

## Context

Fleet machines must be reachable as `base-url/m/<machine-name>` on the
gateway apex, while the same `ai-or-die` process keeps working standalone
(root `/`, including `--tunnel`) with **no different startup flags** — the
machine name is unknown beforehand (assigned via mesh discovery at the
gateway). The app previously assumed root (`express.static` at `/`, ~40
root-absolute `fetch`/WS/vendor/SW/manifest URLs).

## Decision

1. **Server strips per request, not per boot.** First middleware in
   `setupExpress()` matches `^/m/[^/?#]+(?=/|\\?|$)`; on match it stores
   `req._fleetPrefix` and rewrites `req.url` (never `req.originalUrl`).
   Every existing route (static, SEA, manifest, auth, `/api/*`, `GET /`)
   dual-serves unchanged. Empty prefix = today's root behavior.
2. **Prefix-aware responses only where URLs are minted:** dynamic
   `/manifest.json` (`id/scope/start_url/icons/shortcuts/screenshots`),
   `artifactPath()` + artifact `<base href>` + markdown shell script URL,
   WS `viewUrl` broadcast (WS upgrades bypass Express, so the prefix is
   re-derived from the raw upgrade URL into `wsInfo.fleetPrefix`).
3. **Client derives the prefix at runtime.** New first-loaded
   `fleet-base.js` (`getBasePrefix()/withBase()/scopedAuthKey()`);
   absolute-URL sites call through it. `authFetch` also prefixes centrally
   as a safety net. Token storage is scoped per prefix
   (`cc-web-token:/m/<id>`) so two machines on one origin don't collide.
   SW registers relatively (`scope: './'`) with worker-relative precache;
   manifest/icons/vendor refs are relative.
4. **Gateway proxies verbatim** (`/m/<id>/...` → backend `/m/<id>/...`),
   no `Location`/`Set-Cookie` rewriting (no cookies exist; only HTTPS 307
   emits `Location` and already preserves the path).

## Consequences

- One binary/behavior for standalone, tunnel, and fleet; no env/flag skew.
- Contract: gateway and backend agree on the `/m/<id>` spelling; labels
  stay `[a-z0-9-]` (both sides reject anything else → 404, never proxy).
- Tests: `test/fleet-path-prefix.test.js` (live dual-serve + helper unit +
  no-root-absolute-refs guard); holistic gateway↔backend E2E verified.
