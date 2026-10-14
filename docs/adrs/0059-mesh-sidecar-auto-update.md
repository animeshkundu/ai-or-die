# ADR-0059: Mesh Sidecar Auto-Update with Sidecar-Only Recycle

**Status:** Accepted (implemented)
**Date:** 2026-10-14
**Supersedes:** nothing (extends ADR-0036 stable-path, ADR-0054 never-quit)

## Context

The mesh sidecar (`mesh/main.go`, `src/mesh-manager.js`) was pinned by
`mesh-sidecar.lock.json` but `MeshManager.start()` only fetched when the
stable file was missing (`src/mesh-manager.js:79-81` pre-change). A stale
binary survived `npm i -g ai-or-die@latest` + restart, and long-lived daemons
(upgraded underneath via npm) never converged. The primary target is Win11,
where a running `.exe` cannot be renamed — in-place hot-swap is impossible.

## Decision

1. **Verify on every start**: promote a staged (`.new`) build while the image
   is free, then unconditionally `ensureSidecar` (no network on match).
2. **24h poll** (±15m jitter, `unref`d, on by default): on lock/stable drift,
   stage the verified download to a `.new` sibling, then recycle **only the
   sidecar** — stop child, promote `.new` → stable (single `.prev` backup),
   respawn. No server restart, no session loss; identity persists via
   `stateDir`, so the same tailnet URL is re-established with no re-enroll.
3. **Fail safe**: any staging failure keeps the old sidecar for the next
   cycle; a build yielding no `MESH-URL` rolls back to `.prev` once and is
   quarantined in-process. Trust stays npm-anchored (checksums from the
   installed lock only — never newer-than-lock from the network).
4. Kill-switches: `AIORDIE_MESH_AUTO_UPDATE=0`, `AIORDIE_AUTO_UPDATE=0`.

## Consequences

* Crash-restart (`_shouldAutoRestart`) is additionally gated on `_updating`
  so the backoff loop cannot double-spawn one `stateDir`.
* Egress bearer rotates per sidecar process; consumers re-read `egress.json`
  on mtime and retry on 407.
* A lock-pinned but runtime-broken build is quarantined only in-process; a
  process restart re-attempts it (bounded by the existing never-quit backoff).
* Multi-instance hosts sharing one stable path converge via the same
  stage/promote primitives; redundant stages self-clean on the next tick.

## Follow-up (not in this change)

* **Persistent quarantine**: a rolled-back version is quarantined in-process
  only (`_failedUpdateVersions`); a process restart re-attempts it, bounded by
  the never-quit backoff. Persist the quarantine (e.g. `mesh/quarantine.json`
  under the app base, keyed by contentHash with a timestamp) so a
  lock-pinned but runtime-broken build stays stood down across restarts until
  a *newer* contentHash appears. Small, self-contained; do it next.
