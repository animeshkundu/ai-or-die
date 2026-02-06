# ADR-0001: Extract BaseBridge for CLI Tool Integration

## Status

**Accepted**

## Date

2025-06-01

## Context

The project currently ships three bridge classes -- `ClaudeBridge`, `CodexBridge`, and `AgentBridge` -- that each manage CLI process spawning, session lifecycle, output buffering, and terminal resizing. Approximately 95% of the code across these three files is identical; the only meaningful differences are:

1. The CLI binary name and its search paths.
2. The default arguments passed at spawn time.
3. A handful of tool-specific flags (e.g. dangerous-command approval in Claude).

With three additional tools on the roadmap (Copilot CLI, Gemini Code, and a generic terminal bridge), duplicating this pattern further would create a maintenance burden where every cross-cutting fix (e.g. a reconnection bug, a Windows path issue) must be applied in six or more places.

## Decision

Extract a `BaseBridge` base class that encapsulates the shared behaviour:

- **Platform-aware command discovery** -- use `os.homedir()` instead of `process.env.HOME`, and call `where` on Windows / `which` on Unix to locate binaries.
- **Session lifecycle** -- `startSession`, `stopSession`, `resizeSession`, `getSessionOutput`, and the internal `sessions` Map.
- **Output buffering** -- ring-buffer of the last N lines (default 1000) for reconnection support.
- **Process management** -- `node-pty` spawn with `xterm-256color` on Unix and ConPTY on Windows.

Each concrete bridge (e.g. `ClaudeBridge extends BaseBridge`) only needs to supply:

- `toolName` -- human-readable label.
- `binaryNames` -- ordered list of binary names / paths to search.
- `buildArgs(options)` -- returns the argument array for a given session.
- (optional) `dangerousFlags` -- patterns that trigger the plan-approval UI.

## Consequences

### Positive

- Adding a new tool bridge becomes a ~30-line subclass instead of a full copy-paste of 200+ lines.
- Cross-platform fixes (Windows path handling, ConPTY quirks) are applied once in `BaseBridge`.
- Unit tests can cover the base class exhaustively; subclass tests only need to verify tool-specific argument construction.

### Negative

- Introduces an inheritance hierarchy, which can become rigid if tools diverge significantly in the future.
- Existing bridges need to be refactored, which touches stable code.

### Neutral

- No user-facing behaviour change; this is a purely internal refactor.
- The WebSocket protocol and session store remain unchanged.
