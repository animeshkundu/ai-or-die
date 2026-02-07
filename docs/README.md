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
- [Image Paste](specs/image-paste.md)
- [File Browser](specs/file-browser.md)
- [E2E Testing](specs/e2e-testing.md)

## Architecture Decision Records

- [ADR Template](adrs/0000-template.md)
- [ADR-0001: Bridge Base Class](adrs/0001-bridge-base-class.md)
- [ADR-0002: DevTunnels over ngrok](adrs/0002-devtunnels-over-ngrok.md)
- [ADR-0003: Multi-Tool Architecture](adrs/0003-multi-tool-architecture.md)
- [ADR-0004: Cross-Platform Support](adrs/0004-cross-platform-support.md)
- [ADR-0005: Single Binary Distribution](adrs/0005-single-binary-distribution.md)
- [ADR-0006: Test-Driven Bug Fixes](adrs/0006-test-driven-bug-fixes.md)
- [ADR-0007: Design Token System](adrs/0007-design-token-system.md)
- [ADR-0008: E2E Parallelization](adrs/0008-e2e-parallelization.md)
- [ADR-0008: File Browser Architecture](adrs/0008-file-browser-architecture.md)

## Agent Instructions

- [Philosophy](agent-instructions/00-philosophy.md)
- [Research & Web](agent-instructions/01-research-and-web.md)
- [Testing & Validation](agent-instructions/02-testing-and-validation.md)
- [Tooling & Pipelines](agent-instructions/03-tooling-and-pipelines.md)
- [Handoff Protocol](agent-instructions/04-handoff-protocol.md)
- [Defensive Coding](agent-instructions/05-defensive-coding.md)
- [CI-First Testing](agent-instructions/06-ci-first-testing.md)
- [Documentation Hygiene](agent-instructions/07-docs-hygiene.md)
- [Multi-Agent Consultation](agent-instructions/08-multi-agent-consultation.md)

## History

- [Changelog](history/README.md)
- [File Browser Bugs](history/file-browser-bugs.md)
