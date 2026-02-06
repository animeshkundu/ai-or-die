# ADR-0002: Replace ngrok with Microsoft Dev Tunnels

## Status

**Accepted**

## Date

2025-06-15

## Context

The project uses the `@ngrok/ngrok` npm package (v1.4.0) to expose the local server to the internet for remote access. This approach has several drawbacks:

1. **Third-party npm dependency** -- `@ngrok/ngrok` pulls in native binaries via postinstall scripts, which complicates installs on locked-down machines and adds supply-chain surface area.
2. **Security posture** -- traffic routes through ngrok's infrastructure, which is a third-party tunnel provider outside the user's control. Enterprise environments often block ngrok domains outright.
3. **Cost** -- ngrok's free tier has bandwidth and connection limits; paid tiers add ongoing cost for a feature that many users need only occasionally.
4. **Platform inconsistency** -- the npm package handles its own binary management, which has led to intermittent install failures on Windows and ARM Linux.

Microsoft Dev Tunnels (`devtunnel` CLI) is a free alternative backed by Azure infrastructure. It supports persistent tunnel names, access control via Microsoft/GitHub accounts, and is pre-installed in GitHub Codespaces and VS Code remote environments.

## Decision

Replace the `@ngrok/ngrok` npm dependency with a shell-out to the `devtunnel` CLI:

```
devtunnel host -p <port> --allow-anonymous
```

Key implementation details:

- **No npm dependency** -- spawn `devtunnel` as a child process rather than importing an npm package. This removes `@ngrok/ngrok` from `package.json` entirely.
- **CLI discovery** -- use the same platform-aware discovery pattern from `BaseBridge` to locate `devtunnel` (or `devtunnel.exe` on Windows) in PATH.
- **Output parsing** -- parse the tunnel URL from the CLI's stdout (it prints `Connect via browser: https://<id>.devtunnels.ms`).
- **Lifecycle management** -- the tunnel process is tied to the server's lifecycle; it is killed on SIGINT/SIGTERM alongside the Express server.
- **Fallback messaging** -- if `devtunnel` is not found, log a clear message with install instructions rather than crashing.

## Consequences

### Positive

- Removes the `@ngrok/ngrok` npm dependency and its native binary postinstall step.
- Traffic routes through Microsoft/Azure infrastructure, which is more acceptable in enterprise environments.
- Free tier has generous limits (no bandwidth cap for anonymous tunnels).
- Cross-platform: `devtunnel` CLI ships for Windows, macOS, and Linux (x64 and ARM64).

### Negative

- Requires the user to install the `devtunnel` CLI separately (`winget install Microsoft.devtunnel`, `brew install devtunnel`, or direct download). This is an external prerequisite that the app cannot auto-install.
- Microsoft account or GitHub sign-in is required for first-time `devtunnel` setup (one-time `devtunnel user login`).
- Less programmatic control compared to an in-process SDK -- we rely on parsing CLI output, which could break if the output format changes.

### Neutral

- The tunnel feature remains opt-in (activated via `--tunnel` flag); users who do not need remote access are unaffected.
- The WebSocket protocol and client code require no changes -- the tunnel is transparent at the HTTP/WS layer.
