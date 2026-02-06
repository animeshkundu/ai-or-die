# ADR-0003: Multi-Tool Architecture

## Status

**Accepted**

## Date

2025-07-01

## Context

ai-or-die started as a single-purpose web frontend for the Claude Code CLI. Over time, support was added for OpenAI Codex and Cursor Agent, each via a dedicated bridge class and hardcoded UI elements. The roadmap now includes Copilot CLI, Gemini Code Assist, and a generic terminal mode, which means:

1. **Hardcoded tool lists do not scale.** Every new tool requires edits in the server constructor, the WebSocket message handler, the REST API routes, and the client-side UI (tool cards, session tabs, icons).
2. **The client must know about every tool at build time.** Adding a tool that is not installed on a given server should not break the UI or require a code change -- the card should simply not appear.
3. **Each tool has different "dangerous" command patterns** that the plan-approval UI needs to intercept (e.g. `rm -rf` for a generic terminal, `--dangerously-skip-permissions` for Claude).

## Decision

Adopt a tool-agnostic architecture with the following components:

### Server-side: Tool Registry

The server maintains a `toolRegistry` -- an ordered list of tool descriptors built at startup by probing which CLI binaries are available:

```js
{
  id: 'claude',
  name: 'Claude',
  bridge: claudeBridge,        // BaseBridge subclass instance
  available: true,             // binary was found on this machine
  dangerousPatterns: [/--dangerously-skip-permissions/],
  icon: 'claude',              // maps to a client-side icon set
  description: 'Anthropic Claude Code'
}
```

A new `/api/tools` REST endpoint returns the list of available tools (minus internal fields like `bridge`), so the client can render the UI dynamically.

### Client-side: Dynamic UI Card Generation

The landing page fetches `/api/tools` on load and generates one "Start" card per available tool. No tool-specific markup exists in `index.html` -- all cards are built from the same template in `app.js`. Tool icons are resolved from a shared sprite or CSS class map.

### WebSocket Protocol: Unified Messages

The existing WebSocket messages (`create_session`, `start_claude`, `input`, `resize`, `stop`) are generalized:

- `start_claude` becomes `start_tool` with a `toolId` field.
- Session objects carry a `toolId` so the server routes messages to the correct bridge.
- All other messages (`input`, `resize`, `stop`, `join_session`, `leave_session`) remain unchanged -- they operate on sessions, not tools.

## Consequences

### Positive

- Adding a new tool requires only a `BaseBridge` subclass and a registry entry -- no client code changes.
- The UI stays clean regardless of how many tools are registered; unavailable tools simply do not render.
- Each tool can declare its own dangerous-command patterns, which the plan-detector evaluates at runtime.
- Server operators can disable tools via environment variables or config without touching code.

### Negative

- The `/api/tools` endpoint is a new network request on page load, adding a small latency hit before the UI renders.
- Dynamic card generation is slightly harder to debug than static HTML.
- Tool icons/branding must be managed as a shared asset set rather than inline SVGs.

### Neutral

- Backward compatibility is maintained: existing `start_claude` messages are internally aliased to `start_tool { toolId: 'claude' }` so older clients continue to work during the transition.
- Session persistence format gains a `toolId` field; sessions without one default to `'claude'` for migration.
