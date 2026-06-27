# ADR-0032: Fleet session-control plane (`/api/control/*`)

## Status

Accepted (implemented on branch `feat/fleet-session-control`).

## Context

A single client-side LLM (Claude Code on a user's laptop) needs to enumerate, read, steer, and supervise the
live AI-CLI sessions inside **many** ai-or-die instances across different machines — generalizing firstmate's
single-host tmux fleet model across the network. ai-or-die already manages multiple PTY-backed sessions per
machine and is already reachable over an authed Microsoft Dev Tunnel (ADR-0002) + single Bearer token, but its
session surface was browser-oriented (a WebSocket protocol streaming raw ANSI) with no clean programmatic
control API and no notion of remote control.

The control surface must be drivable by an LLM, not just a browser: structured status (not raw ANSI), an
event/notification channel (so the client is woken on a turn ending rather than polling bytes), and idempotent
mutations (a retried network call must not double-spawn or double-submit). The cross-machine aggregation /
federation lives in github-router's `fleet` MCP group (ADR in that repo); this ADR covers only ai-or-die's
per-instance HTTP control plane that the fleet group calls over each instance's tunnel.

## Decision

Add a thin REST/JSON control plane under **`/api/control/*`**, mounted **after** the existing Bearer-token auth
middleware in `src/server.js` (so every route is token-gated), built from injected deps for testability:

- `src/control/session-status.js` — `deriveStatus()` maps the signals ai-or-die already computes to
  `{ lifecycle, interactionState, canAcceptInput, confidence, blockReason?, awaiting?, lastTurnEndedAt }`.
  Reliability is agent-dependent and surfaced via `confidence`: **high** when read from the claude JSONL
  transcript (ADR-0026 binding), **medium** from a busy-footer regex over the rendered terminal, **low**
  otherwise. We never fake certainty.
- `src/control/event-bus.js` — an in-process bounded monotonic event ring (the network-safe generalization of
  firstmate's durable wake-queue). It is **epoch-aware** (an instance restart mints a new epoch so a stale
  cursor gets a `restart` gap, not a silent reset) and reports an explicit `overflow` gap when the ring rolls
  past a consumer's cursor. Cursor = `{ epoch, seq }`.
- `src/control/jsonl-awaiting.js` — detects a pending user-facing tool_use (`ExitPlanMode` → plan_approval,
  `AskUserQuestion` → choice_question, a permission prompt → tool_approval) so the client knows it must
  `respond` rather than `send_message`.
- `src/control/routes.js` — `GET /sessions`, `/sessions/:id/{status,read}`, `POST /sessions/{create,:id/stop,
  :id/message,:id/keys,:id/respond}`, `GET /events` (long-poll). Steering: `send_message` (multiline via
  bracketed paste + Enter, idempotent, awaits a `turn_ended` for honest confirmation, LOUD failure on
  unconfirmed delivery rather than a buried flag), `send_keys` (named-key table), `respond` (server-side
  best-effort keystroke map for the agent + a `keys` override). All mutations take an `idempotencyKey`; the
  instance caches last-N outcomes and returns the prior result with `duplicated:true` on a retry. The control
  routes are rate-limited per token.

The primitives map 1:1 to firstmate (`fm-spawn`→create, `fm-send`→send_message/send_keys, `fm-peek`→read,
`fm-watch`→events); the additions (idempotency, epoch/gap cursor, honest confidence) are exactly the cost of
crossing a network that firstmate's local tmux gave it for free.

Auth reuses ai-or-die's existing Bearer token over the tunnel (HTTPS authenticates the server, not the caller;
an anonymous Dev Tunnel is URL-as-secret, so the token is the real access control, and ai-or-die already ships
it). No new scoped tokens; this is the same authority the user's browser already holds.

## Consequences

- A remote LLM can drive sessions structurally and be event-woken without scraping ANSI; turn detection is
  reliable for claude (JSONL) and honestly best-effort for other agents.
- `respond`'s exact keystrokes for claude's plan/tool/question TUIs are best-effort and need live calibration;
  a `keys` override is always available as the escape hatch.
- `create_session(start:true)` records the session but headless agent spawn is a follow-up (the WS start path
  needs a no-socket variant); until then the e2e uses an already-started session or the terminal path.
- The control plane is HTTP/JSON only (no bash/tmux), so it runs identically on Windows and any remote OS.
