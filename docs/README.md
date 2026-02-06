# ai-or-die Documentation

Central documentation for the ai-or-die project -- a Node.js web application that provides browser-based access to AI CLI tools (Claude, Codex, Copilot, Gemini, Terminal, and more) through a shared terminal emulator interface.

## Architecture

- [System Overview](architecture/overview.md)
- [WebSocket Protocol](architecture/websocket-protocol.md)
- [Bridge Pattern](architecture/bridge-pattern.md)

## Specifications

- [Server](specs/server.md)
- [CLI Bridges](specs/bridges.md)
- [Session Store](specs/session-store.md)
- [Authentication](specs/authentication.md)
- [Client Application](specs/client-app.md)
- [Usage Analytics](specs/usage-analytics.md)

## Architecture Decision Records

- [ADR Template](adrs/0000-template.md)
- [ADR-0001: Bridge Base Class](adrs/0001-bridge-base-class.md)
- [ADR-0002: DevTunnels over ngrok](adrs/0002-devtunnels-over-ngrok.md)
- [ADR-0003: Multi-Tool Architecture](adrs/0003-multi-tool-architecture.md)
- [ADR-0004: Cross-Platform Support](adrs/0004-cross-platform-support.md)

## Agent Instructions

- [Philosophy](agent-instructions/00-philosophy.md)
- [Research & Web](agent-instructions/01-research-and-web.md)
- [Testing & Validation](agent-instructions/02-testing-and-validation.md)
- [Tooling & Pipelines](agent-instructions/03-tooling-and-pipelines.md)

## History

- [Changelog](history/README.md)
