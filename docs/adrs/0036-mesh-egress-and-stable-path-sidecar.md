# ADR-0036: Userspace mesh egress + trustable stable-path sidecar

Date: 2026-07-01
Status: Accepted

## Context

The mesh sidecar (ADR-0034/0035) makes an ai-or-die instance *reachable* on the tailnet, but a
userspace `tsnet` node only serves **inbound** — it creates no host `tailscale0` interface and gives
the host OS no outbound tailnet routing. So a *separate* same-box process (the github-router
"conductor" that drives the fleet) cannot resolve MagicDNS or route to `.ts.net` peers: every mesh
instance shows `UNREACHABLE` (NXDOMAIN / no route). Installing full Tailscale on the conductor was
rejected (admin/driver friction — the whole reason `tsnet` was chosen).

Two other defects surfaced with `--mesh`: the content-addressed binary filename forces re-trusting
the unsigned sidecar per version on locked-down Windows (WDAC/AppLocker/SmartScreen), and an
untagged enrollment produced a **silent** empty peer list with no diagnostic.

A cross-lab review (gpt-5.5 / gemini-3.1-pro / Opus) added: undici `ProxyAgent`'s `token` option is
Basic-only (a Bearer must ride the `headers` option, never a URI, or it leaks in socket errors); an
egress credential does not belong in the discovery snapshot; the CONNECT allowlist must exact-match
`DNSName` (no suffix / no IP literals); and the sidecar's existing bearer-injection is ambient
authority bounded only by the tailnet ACL.

## Decision

**Userspace egress proxy.** The sidecar runs a loopback (`127.0.0.1:0`) HTTP CONNECT proxy backed by
`tsnet.Server.Dial` (which resolves MagicDNS over WireGuard). It is gated by a random per-process
`Proxy-Authorization: Bearer` token and an allowlist that permits CONNECT **only** to a
`tag:aiordie`-tagged peer whose `DNSName` exactly matches `Status().Peer` on ports 443/7777 (IP
literals rejected). The endpoint + token are announced on stdout (`MESH-EGRESS <url> <token>`) and
persisted by the manager to a **separate 0600 file** `~/.ai-or-die/mesh/egress.json`
(`{version,pid,updatedAt,url,token}`), rewritten each spawn (fresh port/pid — no stale-port hole)
and re-stamped every 30s while the sidecar lives (the write-once file would otherwise be rejected by
the consumer's ~120s freshness TTL after ~2 min of uptime — a bug the live drive caught);
`peers.json` stays credential-free. github-router reads it, treats it stale on a dead pid / expired
TTL, and routes mesh requests through an undici `ProxyAgent` with the token in the
`Proxy-Authorization` header only. Origin-pinning + `redirect:"error"` are unchanged.

**Trust: stable path + strip.** Rename `aiordie-mesh` → `ai-or-die-mesh`. The manager LAUNCHES a
stable, hash-free path (`bin/ai-or-die-mesh[.exe]`) so a single-file WDAC/AppLocker rule matches the
executed image across versions; the installer verifies the download's SHA-256 (vs the checksum in
the signed npm package) and replaces the stable file in place. Because the stable file is free at
process start (the prior ai-or-die and its sidecar have exited), no mid-process hot-swap is needed —
the upgrade lands on the next launch. After the verify, the MOTW (`Zone.Identifier`) / macOS
`com.apple.quarantine` mark is stripped so a re-download is not re-gated. Code signing is deferred.

**Diagnostic.** When tailnet peers exist but none carry `tag:aiordie`, the sidecar emits
`MESH-UNTAGGED <selfTagged> <total> <tagged>` and the manager prints a one-shot actionable hint.

## Consequences

- The no-admin conductor can drive the fleet over the tailnet. The egress runs on every `--mesh` box
  (loopback-only, token-gated) but only the conductor consumes it.
- Launching the stable path trades ADR-0035's zero-downtime install-alongside for WDAC single-file
  rule compatibility; a `--mesh` upgrade now applies at the next process start (brief gap; the
  MagicDNS name persists via `--statedir`). A directory allow-list (`bin\*`) also works and avoids
  even that, where the environment permits it.
- **Required precondition:** the tailnet ACL must deny instance→instance and allow the conductor →
  `tag:aiordie` on the served ports (see `docs/mesh-acl.example.hujson`). The sidecar injects the app
  bearer for any ACL-permitted caller (no per-caller identity check), so the ACL + the
  loopback/token/allowlist are what bound the egress token's authority. A stronger
  end-to-end-per-peer-bearer model (sidecar as pure L4) is a deferred hardening.
- MOTW-strip removes SmartScreen/Gatekeeper prompts but does NOT satisfy an enforced-WDAC
  unsigned-binary block — signing remains the durable fix. Extends ADR-0034/0035.

## Residual risks (cross-lab reviewed, accepted/bounded)

- **Stale-egress port squat (bounded).** The egress binds an ephemeral loopback port and publishes it
  in `egress.json`; on an ungraceful sidecar death (kill -9/OOM) the file can outlive the port. A
  local process could squat the freed port and, if a consumer routed to it, receive the Bearer token
  + traffic. Bounded by: the consumer checks the pid is alive + a 120 s `updatedAt` TTL, and the
  manager deletes `egress.json` on start (before respawn) and on stop/exit/NEEDLOGIN. The narrow
  residual is pid-REUSE inside the TTL window. A Unix-domain-socket (0600, auto-revoked on death) is
  the stronger future design; the token no-leak boundary already keeps the secret out of model/log
  surfaces.
- **Stable-path tamper (same-user).** Launching a hash-free path and stripping MOTW trades some
  tamper-evidence: a local attacker who can WRITE `~/.ai-or-die/bin/` could plant a binary the next
  launch runs. That attacker already has the user's privileges (game-over regardless), so this is
  accepted for the no-admin/no-signing posture; signing is the durable fix. The installer still
  SHA-verifies every download it fetches.
- The CONNECT splice half-closes each write end on EOF (not a hard both-close) so request/response and
  keep-alive survive; consumer-side `localhost` is rejected (numeric loopback only) to avoid a
  rebinding of the proxy endpoint.
