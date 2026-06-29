# ADR-0034: Permanent mesh reachability via Tailscale userspace, devtunnel as fallback

Date: 2026-06-28
Status: Accepted

## Context

ai-or-die instances are reachable only through a Microsoft Dev Tunnel (ADR-0002): `devtunnel host` publishes `https://<id>.devtunnels.ms`, gated by a Bearer token. The tunnel's device auth lapses, the URL churns on restart, and a single tunnel failure drops the whole instance off the network. Fleet reachability hangs on an expiring tunnel.

Goal: instances reachable permanently and securely, with **only ai-or-die's port** exposed (no host VPN, no full-tunnel routing), minimal per-machine setup.

Rejected alternatives: a host-level mesh (NetBird/ZeroTier) needs a kernel TUN driver + admin (blocked in our environment); stock Tailscale's MSI is the same wall and its `tailscale serve` requires the admin service on Windows (tailscale#2791); a STUN/TURN+WASM build rebuilds Tailscale. Tested on the target box: tsnet enrolls userspace (no driver/admin), runs MOTW-tagged unblocked, and a remote node fetched the live app E2E.

## Decision

Ship a small **tsnet sidecar** (`mesh/`, Go) supervised like `TunnelManager`. It joins the tailnet fully in userspace — no driver, no admin, no service — and reverse-proxies the tailnet listener to ai-or-die's own port; only that port is exposed at `https://<host>.ts.net`. `src/mesh-manager.js` spawns it with `--port/--hostname/--statedir`, enrolls once via `AIORDIE_TS_AUTHKEY` (reusable+tagged, scrubbed from env, dropped after), parses `MESH-URL`/`MESH-NEEDLOGIN`, prints a copy-paste enroll block when unenrolled. `--mesh` coexists with `--tunnel` (fallback for unowned browsers). Server binds `127.0.0.1` in mesh mode; Bearer auth stays on; WS ping every 15s defeats DERP idle-drop. Self-signed for fleet reputation. Ship a default-deny `tag:aiordie` ACL.

## Consequences

- Reachable only to tailnet peers; devtunnel covers borrowed devices. Free tier (3 users / 100 devices) is own-fleet scale.
- Stable name depends on persisted state; loss mutates the name, so the UI shows the live one. Key is a high-value secret — env only, revoke post-enroll.
- Control plane (ADR-0032) unchanged. Supersedes the tunnel-only reachability assumption in ADR-0002 / ADR-0011.
