# ADR-0011: Decouple VS Code Server from Dev Tunnel

## Status

**Accepted**

## Date

2026-02-09

## Context

The VS Code tunnel feature (`src/vscode-tunnel.js`) currently uses `code tunnel`, which bundles both the VS Code Server backend and a Microsoft Dev Tunnel into a single process. This tight coupling causes several issues:

1. **Single point of failure** -- if the tunnel component crashes, the entire VS Code Server dies with it. There is no way to keep the server running on localhost while the tunnel reconnects.
2. **GitHub-specific auth** -- `code tunnel` requires GitHub device-code authentication (`code tunnel login --provider github`), which is separate from the `devtunnel` auth used by the server-wide tunnel feature (ADR-0002). Users must authenticate twice with different providers.
3. **No local-only mode** -- the server cannot run without a tunnel. Users who only want local VS Code editing on the same machine are forced through the full tunnel setup.
4. **Limited tunnel provider choice** -- `code tunnel` hardwires Microsoft's tunnel infrastructure. The server-wide tunnel (ADR-0002) already uses `devtunnel` directly, giving more control over tunnel lifecycle.

The project already has a working `devtunnel` integration in `src/tunnel-manager.js` with CLI discovery, auth, tunnel creation, and resilient hosting with exponential backoff.

## Decision

Replace `code tunnel` with two independent processes per session:

1. **VS Code Server**: `code serve-web --host 127.0.0.1 --port <port> --connection-token <token> --accept-server-license-terms` -- runs a local HTTP server serving the VS Code web UI. No tunnel, no GitHub auth required.
2. **Dev Tunnel**: `devtunnel create` + `devtunnel port create` + `devtunnel host` -- independently forwards the local port to the internet via a `*.devtunnels.ms` URL. Lifecycle patterns copied from the existing `TunnelManager`.

Key implementation details:

- **Both CLIs required** -- `code` and `devtunnel` must both be installed. The feature fails with install instructions if either is missing.
- **Port allocation** -- each session gets a unique localhost port from a configurable range (base 9100, range 100). Ports are reserved atomically and validated with a TCP bind probe.
- **Connection token** -- a random 32-byte hex token is generated per session and passed to both the local URL and the public tunnel URL for access control.
- **Auth reuse** -- the `devtunnel` CLI persists auth at the OS level (`~/.devtunnels/`). If the server-wide tunnel or any prior session has already authenticated, no additional user interaction is needed.
- **Sequenced startup** -- server starts first, TCP readiness is verified, then tunnel connects.
- **Sequenced teardown** -- tunnel is killed first, then cleaned up via `devtunnel delete`, then server is killed.
- **Independent failure domains** -- if only the tunnel dies at runtime, the server stays alive on localhost while the tunnel restarts with backoff (degraded state). If the server dies, both are restarted.

## Consequences

### Positive

- Independent failure domains: tunnel crash no longer kills the VS Code Server.
- Unified auth: uses `devtunnel` auth (same as server-wide tunnel) instead of a separate GitHub device-code flow.
- The connection token provides per-session access control regardless of tunnel access policy.
- Clearer separation of concerns: server lifecycle vs. tunnel lifecycle are independently managed.

### Negative

- Two processes per session increases resource usage slightly.
- Port allocation adds complexity (range management, EADDRINUSE retries).
- The devtunnel lifecycle logic is copied from `TunnelManager` rather than extracted into a shared module, creating two maintenance points for the same CLI interaction patterns.

### Neutral

- The WebSocket protocol message types remain unchanged (`vscode_tunnel_started`, `vscode_tunnel_status`, `vscode_tunnel_auth`, `vscode_tunnel_error`). Payloads gain `localUrl` and `publicUrl` fields alongside the existing `url` field for backward compatibility.
- The public URL domain changes from `vscode.dev/tunnel/<name>` to `<id>.devtunnels.ms`.
- The `devtunnel` CLI is already a prerequisite for the server-wide tunnel feature (ADR-0002), so no new external dependency is introduced for users who already have it installed.

## Notes

- Supersedes the `code tunnel` approach introduced in the `feat/vscode-tunnel` branch.
- Related: ADR-0002 (devtunnels over ngrok) established `devtunnel` as the standard tunnel provider.
