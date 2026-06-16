# 0027 - HTTP→HTTPS auto-upgrade on a single port

## Status

Accepted (2026-06).

## Context

Running with `--https`, the server listened only for TLS on `PORT`. A user who
reached `http://host:PORT` (typed the scheme, followed a bookmark from a prior
plain-HTTP run, or omitted the scheme so the browser tried HTTP first) hit the
TLS listener with a plaintext request → an opaque TLS-handshake error / hang,
not a helpful redirect. We want plaintext HTTP on the port to auto-upgrade to
HTTPS.

Options considered:

1. **Separate HTTP redirect port** (e.g. also bind 80, or `PORT-1`). Rejected:
   port 80 needs root and is often taken (IIS/`http.sys` on the Windows-first
   target); an arbitrary companion port adds CLI surface and a second thing for
   the user to know. It also doesn't help the user who typed `http://host:PORT`.
2. **Same-port byte sniffing** (chosen): one listening socket serves both. The
   user types either scheme on the one port and it works — no extra config, and
   it directly fixes the `http://host:PORT` case.

## Decision

In HTTPS mode the listening socket is a `net` server that **peeks the first
byte** of each connection: a TLS ClientHello begins with `0x16` (handshake
record), so those connections are handed (`emit('connection')`) to the real
`https` app server; any other first byte is plaintext HTTP and is handed to a
small redirect server that answers `307` with `Location: https://<host>:<port><url>`.

Key properties:

- **307** (temporary, method-preserving) rather than `301`/`308`: a POST stays a
  POST, and it is not cached as permanent — so flipping the port back to plain
  HTTP later isn't poisoned by a stale permanent redirect.
- **Open-redirect guard:** the redirect host derives from the client `Host`
  header but is validated to a bare `hostname[:port]` / `[ipv6][:port]` (userinfo
  `@`, path, control chars rejected), falling back to `localhost`. The port comes
  from `req.socket.localPort` (correct even on an ephemeral `port: 0`).
- The **WebSocket server attaches to the inner TLS server**, so a `wss://`
  upgrade still arrives over an encrypted `TLSSocket` (`req.socket.encrypted`
  stays true for the secure-context / voice checks). A plaintext `ws://` upgrade
  to the port gets the same `307` written raw instead of an abrupt reset.
- **Pre-handoff guards:** a connection that errors or sends no data within 10 s
  (port scanner / slowloris) is destroyed before routing; the timer + error
  listener are cleared on handoff so the target server owns the socket lifecycle.
- **Shutdown:** `close()` destroys the tracked proxied sockets and closes both
  inner servers (they receive connections via `emit('connection')`, which
  bypasses their internal connection tracking, so they wouldn't otherwise drain).

The non-HTTPS path is unchanged (a plain `http` server).

## Consequences

- One port, both schemes — simplest UX, no new flags or privileged ports.
- A tiny per-connection cost (one `readable` + 1-byte read + an `unshift`) and an
  extra in-process hop for every connection in HTTPS mode.
- Inbound connections are injected into the inner servers, bypassing their
  connection tracking — handled explicitly in `close()`.
- No HSTS is sent (would conflict with self-signed certs and with switching the
  port between http/https modes); the redirect alone is the upgrade mechanism.

## References

- Spec: `docs/specs/server.md` (HTTPS and HTTP→HTTPS auto-upgrade)
- Tests: `test/https-upgrade.test.js`
