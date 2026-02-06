# Cortex Project History

This document records major architectural decisions, intended as a handoff reference for new contributors.

---

## Cortex v0.1.0

Cortex is a universal AI coding terminal providing browser-based access to multiple CLI tools through a unified interface.

### Architecture

- **BaseBridge pattern**: All CLI tools extend a shared `BaseBridge` base class with cross-platform command discovery, session lifecycle, and process management. See [ADR-0001](../adrs/0001-bridge-base-class.md).

- **Multi-tool support**: Claude, Codex, Copilot, Gemini, and Terminal are supported via the bridge pattern. New tools can be added with a bridge subclass — no client code changes required. See [ADR-0003](../adrs/0003-multi-tool-architecture.md).

- **Dev Tunnels**: Remote access uses Microsoft Dev Tunnels (`devtunnel` CLI) instead of third-party tunnel providers. See [ADR-0002](../adrs/0002-devtunnels-over-ngrok.md).

- **Cross-platform**: Platform-specific code is centralized in `BaseBridge` using `os.homedir()`, `where`/`which` detection, and ConPTY on Windows. See [ADR-0004](../adrs/0004-cross-platform-support.md).

### Key Design Decisions

- Session persistence to `~/.cortex/sessions.json` with atomic writes
- Dynamic UI card generation from server-reported tool availability
- Token-based auth enabled by default (auto-generated on startup)
- Express + WebSocket on a single port (default 7777)
