# Mesh transport (`--mesh`)

Permanent, userspace mesh reachability for an ai-or-die instance via a Tailscale
tailnet. Only the instance's own port joins the mesh — no kernel TUN driver, no
admin, no system service. devtunnel remains the fallback for unowned browsers.
See ADR-0034 for rationale and the alternatives that were tested and rejected.

## Components

- **`mesh/main.go`** — the `aiordie-mesh` sidecar. A `tsnet` node (in-process
  userspace WireGuard) that enrolls via `TS_AUTHKEY` and reverse-proxies the
  tailnet listener to the loopback backend (`--backend http://127.0.0.1:<port>`,
  validated loopback-only). When the tailnet has HTTPS certificates enabled it
  terminates real `<host>.ts.net` TLS at the edge (`ListenTLS :443`, no admin)
  and advertises `https://`; otherwise it degrades to `:80` and advertises
  `http://`. Stdout protocol: `MESH-URL https://<name>` / `MESH-URL http://<name>`,
  `MESH-NOCERT`, `MESH-NEEDLOGIN <url>`, `MESH-ERR <msg>`. The scheme is decided
  **before** the URL is advertised (a cert pre-check), never after, so a lazy
  ACME failure can't hang the first browser request.
- **`src/mesh-manager.js`** — supervises the sidecar like `TunnelManager`
  (detect/fetch → spawn → backoff/restart → stop). Scrubs the key from the
  parent env and forwards it to the child only as `TS_AUTHKEY`. Prints an honest
  cause when the sidecar can't be installed (network / 404 / checksum / locked).
- **`src/utils/sidecar-installer.js`** — downloads the platform binary for the
  pinned content hash and verifies it against a SHA-256 that ships **inside this
  npm package** (`mesh-sidecar.lock.json`), not one fetched from the release.
- **`mesh-sidecar.lock.json`** + **`scripts/mesh-lock.js`** — the sidecar's
  identity (`contentHash`, derived Go-free from the source) and integrity
  (per-asset checksums). `contentHash` keys the release tag and CI build-skip.

## Install flow (zero manual steps)

1. `ai-or-die --mesh` checks `%LOCALAPPDATA%\ai-or-die\bin\aiordie-mesh-<hash>.exe`
   (`~/.ai-or-die/bin/aiordie-mesh-<hash>` on POSIX). The path is content-addressed,
   so a new build installs alongside the old one (never overwrites a running `.exe`).
2. If missing, it fetches `aiordie-mesh-<plat>-<arch>[.exe]` from
   `https://github.com/animeshkundu/ai-or-die/releases/download/mesh-<contentHash>/`
   and verifies its SHA-256 against the checksum embedded in `mesh-sidecar.lock.json`.
3. If `AIORDIE_TS_AUTHKEY` is set (reusable + tagged), it enrolls; otherwise it
   prints a copy-paste enroll block. The node identity persists in the state
   dir, so the key is needed only once.

`AIORDIE_MESH_REF` (or `AIORDIE_MESH_VERSION`) overrides the release tag for
dev/testing (announced loudly).

## Versioning & publishing (content-addressed)

The sidecar is versioned **independently** of the npm package by a content hash
over its source (`mesh/*.go`, `mesh/go.mod`, `scripts/build-mesh-sidecar.sh`).
Each unique source publishes **once** to a dedicated `mesh-<contentHash>` GitHub
release; many ai-or-die versions reuse the same sidecar. The `mesh-sidecar` job
in `.github/workflows/release-on-main.yml`:

- recomputes the hash and asserts the committed lock is current (`mesh-lock.js
  --check`, also enforced on every PR — the un-bypassable build signal);
- **skips** the Go build when `mesh-<hash>` already exists with all six binaries
  + checksums (and is not a leftover draft);
- otherwise cross-builds all platforms, uploads to a **draft** release, verifies
  every expected asset is present, then **finalizes** it (the atomic ready
  marker — a partial upload can never look "published");
- runs **before** `npm publish` (`release` `needs: mesh-sidecar`), and the
  release job embeds the freshly-built checksums into the lock that ships in the
  tarball — so npm never advertises a version whose sidecar isn't fully published.

Build locally with `bash scripts/build-mesh-sidecar.sh` (regenerates the lock's
asset checksums); run `npm run mesh:lock` after changing `mesh/` source.

> **Dev note:** the in-repo lock keeps `assets: {}` — CI embeds the per-platform
> checksums into the lock at publish, so they ship only in the npm tarball.
> Running `--mesh` from a raw `git` checkout (no published `mesh-<hash>` release
> for your local source yet) therefore prints a clear `lock-unfinalized` /
> `assets-missing` message; build the sidecar locally with
> `bash scripts/build-mesh-sidecar.sh` (requires Go) to populate it.

**Trust model:** the per-platform SHA-256 ships inside the signed npm package, so
the binary is verified against a checksum the release **cannot** tamper with
(unlike fetching `checksums.txt` from the same release). The binary is verified
before it is ever placed at the runnable path, and an existing file is
re-verified rather than trusted blindly. A signed manifest (Sigstore/GPG) is the
follow-up for end-to-end provenance.

## HTTPS & secure context

The mesh is for **remote** access, and ai-or-die's microphone (STT) and PWA
service worker require a browser **secure context** — which `http://*.ts.net` is
**not**. So the mesh edge must serve real HTTPS:

- **Edge:** the sidecar serves `<host>.ts.net` TLS via `tsnet.ListenTLS(:443)`
  using Tailscale's auto-issued cert (userspace, no admin). This requires
  **HTTPS Certificates** to be enabled once in the tailnet admin
  (`login.tailscale.com/admin/dns`). When unavailable, the sidecar degrades to
  `http://` and prints `MESH-NOCERT`; the manager surfaces a hint. The scheme is
  decided up front (a cert pre-check + bounded warm), never downgraded after the
  URL is advertised.
- **Backend:** in mesh mode the local server stays **plain HTTP on the loopback
  bind** regardless of `--https` (`bin/ai-or-die.js` sets `https=false` when
  `--mesh`). Mesh already forces a loopback-only bind, so `--https`'s LAN role
  does not apply; this avoids redundant double-TLS and the plaintext-into-TLS bug.
  `--https` **without** `--mesh` is unchanged (self-signed LAN listener).

Why STT/PWA still work with a plaintext backend: the secure context is the URL
the **browser** loads — `https://<host>.ts.net` remotely (edge TLS) and
`http://localhost` locally (localhost exemption). The sidecar→loopback hop is
invisible to the browser, and the terminal client derives `ws`/`wss` from
`window.location`, so `wss` is used on the https page. The edge also sets
`X-Forwarded-Proto: https` for any absolute URL the app generates.

## Auth

`--mesh` keeps the Bearer token ON (mesh ACL + token, layered), overriding the
anonymous default of `--tunnel`. With both flags the tunnel URL carries
`?token=` so it still works. Ship the default-deny `tag:aiordie` ACL from
`docs/mesh-acl.example.hujson`.

## Verified

Built + run on Windows with no admin/driver; an internet-tagged (MOTW) binary
executed unblocked; two userspace nodes enrolled and a remote node fetched the
live app E2E over WireGuard.
