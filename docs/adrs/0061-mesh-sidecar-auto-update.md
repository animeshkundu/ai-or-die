# ADR-0061: Mesh Sidecar Auto-Update (two tiers, sidecar-only recycle)

**Status:** Accepted (implemented)
**Date:** 2026-10-14
**Supersedes:** unmerged drafts `0059-mesh-sidecar-auto-update` and `0060-mesh-sidecar-auto-refresh` (both folded here; the `0059` number collided with the merged Win11 service ADR and is not reused)
**Extends:** ADR-0036 (stable path + strip), ADR-0054 (never-quit)

## Context

The mesh sidecar (`mesh/main.go`, `src/mesh-manager.js`) embeds the Tailscale
client (`mesh/go.mod` pins `tailscale.com`; v1.104.1 at the time of writing).
It was pinned by `mesh-sidecar.lock.json`, but `MeshManager.start()` only
fetched when the stable file was missing: a stale binary survived
`npm i -g ai-or-die@latest` + restart, and long-lived daemons (the Win11 login
service, upgraded underneath via npm) never converged. Two PRs (#173, #174)
attacked this from opposite ends — release freshness vs lock convergence —
with complementary lifecycle designs. This ADR records the merged outcome.

## Decision

Refresh the sidecar in place on a slow cadence through the existing
never-quit supervision, in two tiers on one tick (24h ± 15m jitter, on by
default; `AIORDIE_MESH_AUTO_UPDATE=0` / `AIORDIE_AUTO_UPDATE=0` opt out):

1. **Verify on every start**: promote a staged (`.new`) build while the image
   is free, then unconditionally `ensureSidecar` (no network on match). A
   restart-persisted `<staged>.sha256` file carries the expected hash across
   exec so a release-tier stage promotes instead of being deleted as
   lock-mismatched.
2. **Tier 1 — lock convergence.** On stable-vs-lock drift, stage the verified
   download to a `.new` sibling and recycle. Convergence rule: a stable image
   matching the provenance-recorded build is intentional (newer-than-lock
   steady state) and is never reverted — without this the tiers would flap
   daily. The recycle verdict (not an unconditional success) propagates to
   the tick result.
3. **Tier 2 — release freshness** (only when tier 1 is current). The newest
   published, non-draft `mesh-*` release is checked — a Tailscale bump always
   publishes one. The asset is downloaded to the `.new` path and checked
   against that release's checksums manifest, which must name EXACTLY the
   six-asset platform matrix (a count check would pass victim+filler). It then
   flows through the same pre-flight → recycle path, with the manifest hash
   overriding the lock comparison at promote time. Skipped under dev ref
   pinning (`AIORDIE_MESH_REF`/`_VERSION`) and without the installer
   capability (never silent real-network from stubs).
4. **Pre-flight before killing the good child**: `<staged> --version` must
   exit 0 with the expected content hash (30s timeout). Failure deletes the
   stage and quarantines the version; the old child is untouched. Synchronous
   by design: it runs at most once a day, and ordering it before the
   destructive swap off-thread would complicate the lifecycle for no gain.
5. **Build identity**: `go list -m tailscale.com` stamps `-X main.tsVersion`
   at build; the sidecar prints `MESH-VERSION <tsVersion> <contentHash>`
   first at startup (even on `NEEDLOGIN`), and `--version` reports both.
   Install provenance (`mesh/sidecar.json`: ref, contentHash, sha256, never
   written outside a `bin/` install) records what the bytes were verified
   against; unknown bytes force one check, never an assumption of currency.
6. **Fail safe**: any staging/download failure keeps the old sidecar. A
   **dead** child with no URL rolls back to `.prev` once (provenance reverted
   truthfully, restore accounted as `rolled_back` vs `rollback_failed`) —
   while a **live** child without a URL (e.g. `NEEDLOGIN` during enrollment)
   is left alone. Crash-restarts stand down during updates and never
   double-spawn over a live child; every await in the recycle path re-checks
   `stopping`, and ticks are mutex-guarded.
7. **Quarantine, persisted**: rolled-back and pre-flight-rejected builds are
   quarantined per content hash in `mesh/quarantine.json` (30-day TTL; any
   successful recycle clears the slate), so a bad build stays stood down
   across restarts even after its only `.prev` backup was consumed.
8. **Trust (explicit, layered)**: tier 1 is npm-anchored (a release cannot
   tamper with the shipped checksum). Tier 2's manifest shares the binary's
   origin (GitHub TLS): integrity-in-transit, not pipeline compromise — the
   same attacker could ship a malicious npm tarball, so the shipped-lock
   startup path stays the strict anchor. Signed manifests (Sigstore/GPG) are
   the recorded follow-up.

## Consequences

- Long-lived `--mesh` deployments pick up Tailscale/security fixes within a
  day with zero operator action and no re-enrollment; `npm i -g` upgrades
  converge on the next restart at the latest.
- A bad build self-heals (pre-flight reject or one rollback + quarantine)
  instead of flapping; per-version quarantine (not a session latch) lets a
  subsequent good build through.
- `getStatus()` gains `activeVersion`, `stagedVersion`, `updateAvailable`,
  `lastUpdateCheck`, `lastUpdateResult`, `tsVersion`, `sidecarRef`.
- Crash-restart additionally gates on live `proc`, so a backoff restart can
  never double-spawn one `stateDir`.

## Follow-up (not in this change)

- Release pagination past 100 tags, ETag/rate-limit handling for large fleets
  behind one egress, and real-tsnet + Win11 soak E2E.

## References

- `docs/specs/mesh.md` (Auto-update), `src/mesh-manager.js`,
  `src/utils/sidecar-installer.js`, `mesh/main.go`
- PR #173 (release tier, identity, provenance) + PR #174 (lock tier,
  stage/promote/rollback primitives, recycle)
