# ADR-0035: Content-addressed mesh sidecar versioning + edge-TLS termination

Date: 2026-06-29
Status: Accepted

## Context

The mesh sidecar (ADR-0034) is a prebuilt Go binary fetched at runtime from a
GitHub release. Two defects surfaced once `--mesh` shipped:

1. **Distribution.** The installer fetched strictly from
   `releases/download/v<package.version>/`. The `--mesh` flag shipped in npm
   v0.1.84 but the installer + the publishing job only in v0.1.85, so v0.1.84's
   release had no mesh assets and the fetch 404'd permanently. npm also published
   before the slower asset-upload job finished (a race), and every release
   rebuilt identical binaries to a new per-version tag.
2. **`--https` + `--mesh`.** The server served self-signed TLS on loopback while
   the sidecar reverse-proxied via `http://127.0.0.1` (plaintext into TLS) and
   advertised `https://<name>` while listening plain `:80`. Since `http://*.ts.net`
   is not a browser secure context, remote mic (STT) and the PWA broke.

A cross-lab review (gpt-5.5 / gemini-3.1-pro / Opus 4.7) added: a release-exists
check is not a completeness gate (partial uploads poison it); `tsnet.ListenTLS`
provisions the cert lazily so a post-advertise failure hangs the browser; and
already-installed versions stay broken.

## Decision

**Sidecar identity = content hash.** `mesh-sidecar.lock.json` carries a
`contentHash` derived Go-free from the sidecar source and per-platform SHA-256
checksums. The hash keys a dedicated `mesh-<hash>` release; many ai-or-die
versions reuse one sidecar. CI builds only when the hash has no complete release.
`mesh-lock.js --check` (every PR) is the un-bypassable build signal.

**Integrity = embedded checksums.** The installer verifies the download against
the checksum shipped inside the signed npm package, not a `checksums.txt` fetched
from the same mutable release.

**Completeness + ordering.** The `mesh-sidecar` job uploads to a draft release,
verifies all six assets, then finalizes (atomic ready marker). `release` /
`npm publish` `needs: mesh-sidecar`, and embeds the freshly-built checksums into
the published lock — so npm never advertises a version whose sidecar is missing.

**Versioned local path.** Installs land at `ai-or-die-mesh-<hash>[.exe]`, never
overwriting a running binary (Windows `EPERM`).

**Edge TLS, plaintext loopback backend.** The sidecar terminates real
`<host>.ts.net` TLS via `ListenTLS(:443)` (userspace, no admin) after a cert
pre-check that decides the scheme before advertising; it degrades to `http://` +
a hint when tailnet HTTPS certs are off. In mesh mode the local server serves
plain HTTP on its loopback bind regardless of `--https` (the sidecar dials
`http://127.0.0.1`, loopback-validated). `--https` without `--mesh` is unchanged.

## Consequences

- `--mesh` works reliably (the version-skew, race, and rebuild-waste classes are
  gone) and `--https --mesh` no longer breaks; the remote `https://<host>.ts.net`
  is a real secure context, so STT + PWA work over the mesh.
- New external prerequisite for remote HTTPS: HTTPS Certificates enabled in the
  tailnet admin. Without it the mesh degrades to http with a clear hint.
- Already-installed clients: v0.1.84's manager predates the auto-fetch installer
  (it never downloads a sidecar), so those users must upgrade — a backfill would
  not help them. v0.1.85/v0.1.86 keep their per-version release assets untouched,
  so existing installs on those versions continue to work; only the new client
  uses `mesh-<hash>`.
- The in-repo lock keeps `assets: {}`; the checksums are filled by CI at publish.
  Running `--mesh` from a raw git checkout without a published `mesh-<hash>`
  yields a clear `lock-unfinalized`/`assets-missing` message (build locally via
  `scripts/build-mesh-sidecar.sh`). Extends ADR-0034.
