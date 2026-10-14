# ADR-0060: Mesh Sidecar Auto-Refresh (newer Tailscale client)

**Status:** Accepted (implemented)
**Date:** 2026-10-14
**Extends:** mesh content-addressed publishing (`docs/specs/mesh.md`),
ADR-0036 (stable path + strip)

## Context

The `ai-or-die-mesh` sidecar embeds the Tailscale client (`mesh/go.mod` pins
`tailscale.com`; currently v1.104.1). A Tailscale bump flips the sidecar
content hash and publishes a new `mesh-<hash>` release, but long-lived
deployments (notably the Win11 login service) kept running the old binary
until the next manual restart: no runtime check, no refresh, no reconnect.

## Decision

Refresh the sidecar in place on a slow cadence, reusing the existing
never-quit supervision for recovery:

1. **Build identity:** stamp the pinned client version alongside the content
   hash (`-X main.tsVersion=…` from `go.mod` in `build-mesh-sidecar.sh`);
   the sidecar prints `MESH-VERSION <tsVersion> <contentHash>` first at
   startup (even on `NEEDLOGIN`), and `--version` reports both lines.
2. **Provenance:** `ensureSidecar` records `mesh/sidecar.json`
   (`{ ref, contentHash, sha256 }`) on every verified install; the manager
   falls back to the shipped lock for pre-feature installs.
3. **Poll (default 6h, floor 30min, opt-out `AIORDIE_MESH_NO_REFRESH=1`):**
   newest published non-draft `mesh-*` release; skip under dev ref pinning.
4. **Verify-then-swap:** download to temp, check against the release's
   checksums manifest (must cover the full matrix); stop → atomic rename
   (`.prev` kept) → provenance update → respawn with the persisted tailnet
   identity (no new key). Exit-handler restarts are held during the swap.
5. **Rollback once, then latch off:** dead child + no URL → restore `.prev`,
   revert provenance, respawn, pause refresh for the session. A live child
   without a URL is left alone (needs enrollment, not a rollback).
6. **Trust (explicit):** the refresh manifest shares the binary's origin, so
   it proves integrity-in-transit, not pipeline compromise — documented in
   `docs/specs/mesh.md`. The shipped-lock startup path stays the strict
   anchor; signed manifests (Sigstore/GPG) are the recorded follow-up.

## Consequences

- Long-lived `--mesh` deployments pick up Tailscale/security fixes within
  hours with zero operator action and no re-enrollment.
- A bad sidecar build self-heals (rollback + latch) instead of flapping.
- `getStatus()` gains an additive `sidecar` block (`ref`, `tsVersion`,
  `contentHash`, `refreshDisabled`).
- Tests: `test/mesh-refresh.test.js` (14), `meshVersionLine` Go test,
  updated `getStatus` assertions. Go `vet`/`test` clean.

## References

- `docs/specs/mesh.md` (Auto-refresh), `src/mesh-manager.js`,
  `src/utils/sidecar-installer.js`, `mesh/main.go`
