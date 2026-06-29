# Mesh transport (`--mesh`)

Permanent, userspace mesh reachability for an ai-or-die instance via a Tailscale
tailnet. Only the instance's own port joins the mesh — no kernel TUN driver, no
admin, no system service. devtunnel remains the fallback for unowned browsers.
See ADR-0034 for rationale and the alternatives that were tested and rejected.

## Components

- **`mesh/main.go`** — the `aiordie-mesh` sidecar. A `tsnet` node (in-process
  userspace WireGuard) that enrolls via `TS_AUTHKEY`, reverse-proxies the tailnet
  listener to `127.0.0.1:<port>`, and prints a stdout protocol:
  `MESH-URL https://<name>`, `MESH-NEEDLOGIN <url>`, `MESH-ERR <msg>`.
- **`src/mesh-manager.js`** — supervises the sidecar like `TunnelManager`
  (detect/fetch → spawn → backoff/restart → stop). Scrubs the key from the
  parent env and forwards it to the child only as `TS_AUTHKEY`.
- **`src/utils/sidecar-installer.js`** — downloads the platform binary from the
  matching GitHub release and verifies it against the release's SHA-256
  checksums before first use.

## Install flow (zero manual steps)

1. `ai-or-die --mesh` checks `%LOCALAPPDATA%\ai-or-die\bin\aiordie-mesh.exe`
   (`~/.ai-or-die/bin/aiordie-mesh` on POSIX).
2. If missing, it fetches `aiordie-mesh-<plat>-<arch>[.exe]` from
   `https://github.com/animeshkundu/ai-or-die/releases/download/v<version>/`,
   verifies its SHA-256 against `aiordie-mesh-checksums.txt`, and stores it.
3. If `AIORDIE_TS_AUTHKEY` is set (reusable + tagged), it enrolls; otherwise it
   prints a copy-paste enroll block. The node identity persists in the state
   dir, so the key is needed only once.

The binaries and checksums are published per release by the
`build-mesh-sidecar` job in `.github/workflows/release-on-main.yml`
(Go cross-compiles all platforms from one runner). Build locally with
`bash scripts/build-mesh-sidecar.sh`.

**Trust model:** the binary and its `aiordie-mesh-checksums.txt` are fetched over
HTTPS from the same GitHub release, so verification is TOFU against the release
origin (a compromised release could replace both). The checksum still defends
against transport corruption and a wrong/truncated download; the binary is
verified before it is ever placed at the runnable path, and an existing file is
re-verified rather than trusted blindly. A signed manifest (Sigstore/GPG) is the
follow-up for end-to-end provenance.

## Auth

`--mesh` keeps the Bearer token ON (mesh ACL + token, layered), overriding the
anonymous default of `--tunnel`. With both flags the tunnel URL carries
`?token=` so it still works. Ship the default-deny `tag:aiordie` ACL from
`docs/mesh-acl.example.hujson`.

## Verified

Built + run on Windows with no admin/driver; an internet-tagged (MOTW) binary
executed unblocked; two userspace nodes enrolled and a remote node fetched the
live app E2E over WireGuard.
