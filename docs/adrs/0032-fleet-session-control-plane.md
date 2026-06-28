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
  otherwise. We never fake certainty. Two cross-checks tighten the busy/idle call:
  - **F8 (bound footer cross-check):** the polled JSONL transcript LAGS the rendered screen, so a
    just-submitted message can momentarily look settled (`endsOnAssistant`, not `growing`) while claude is
    already mid-turn. Before returning idle on a bound session, the live busy footer (`esc to interrupt` /
    spinner gerund) is cross-checked; if it shows a running turn the state is **busy** at **medium**
    confidence (screen disagrees with JSONL). The footer may only RAISE busy — it is never an authoritative
    idle gate and never the sole signal that blocks a send (deadlock risk); JSONL turn state stays
    authoritative.
  - **F12 (coarse unbound recency):** for an active session with NO JSONL binding (e.g. claude launched
    inside a `terminal` PTY), busy/idle is derived from PTY-output recency (`lastOutputAt` within a LARGE
    quiet window → busy, else idle) at **low** confidence, and the server emits coarse `became_busy` /
    `became_idle` edges (debounced on the session) so `await_turn` returns SOMETHING. This is a courtesy,
    not a turn oracle: it NEVER emits `turn_ended` and is never presented as real turn completion — the
    supported path for real turn detection is `agent:"claude"` (bound), and an unbound driver should be
    surfaced as `NO_TURN_BINDING`.
- `src/control/event-bus.js` — an in-process bounded monotonic event ring (the network-safe generalization of
  firstmate's durable wake-queue). It is **epoch-aware** (an instance restart mints a new epoch so a stale
  cursor gets a `restart` gap, not a silent reset) and reports an explicit `overflow` gap when retention rolls
  past a consumer's cursor. Cursor = `{ epoch, seq }`. **Retention is PER SESSION (F15):** each session keeps
  its own bounded ring (default 256 events), so one chatty session evicts only its own old events and can
  never roll another session's last `turn_ended` out of the buffer. A global monotonic `seq` still orders
  events across sessions, and `_maxEvictedSeq` (the highest seq dropped from any ring, incl. whole-bucket LRU
  eviction past the session cap) drives overflow detection — a drop is never silent. Cursors are **per-watcher
  (F22):** `since()`/`waitFor()` are pure reads parameterised by the caller's cursor with no shared global
  position, so many concurrent watchers each resume from their own `{epoch,seq}` independently.
- `src/control/jsonl-awaiting.js` — detects a pending user-facing tool_use (`ExitPlanMode` → plan_approval,
  `AskUserQuestion` → choice_question, a permission prompt → tool_approval) so the client knows it must
  `respond` rather than `send_message`.
- `src/control/routes.js` — `GET /sessions`, `/sessions/:id/{status,read}`, `POST /sessions/{create,:id/stop,
  :id/message,:id/keys,:id/respond}`, `GET /events` (long-poll), **`GET /snapshot`** and **`GET /capabilities`**
  (below). Steering: `send_message` (multiline via
  bracketed paste + Enter, idempotent, awaits a `turn_ended` for honest confirmation, LOUD failure on
  unconfirmed delivery rather than a buried flag; the cold-boot dropped-Enter reaper re-sends only when no
  NEW user entry (bound, F18) / no NEW activity edge after the pre-send cursor (unbound, F13) is observed,
  so a lingering prior-turn busy never suppresses a genuinely dropped submit, and the per-session writeQueue
  + idempotency make the retry duplicate-safe), `send_keys` (named-key table incl. Shift+Tab → CSI Z), `respond` (server-side
  best-effort keystroke map for the agent + a `keys` override). All steering ops on one session also pass
  through a **per-session steering mutex (F16)** — a logical-command queue distinct from the byte-level
  writeQueue — so two concurrent DISTINCT ops can't interleave bytes (the mutex wraps delivery+submission and
  releases before any long turn-await, so it never blocks a `respond` behind a slow `send_message`). All
  mutations take an `idempotencyKey`; the
  instance caches last-N outcomes and returns the prior result with `duplicated:true` on a retry. The control
  routes are rate-limited per token; a throttled call returns a **classifiable 429 (F21)** — stable
  `error.code='RATE_LIMITED'` + `retryAfterMs`/`retryAfterSec` body + standard `Retry-After` header — so the
  client backs off precisely instead of hammering.

### Scale endpoints (Cluster 4)

**`GET /api/control/snapshot` (F15)** — atomic O(1) reconnect after a cursor gap. Returns every session's
derived status PLUS the event cursor, captured atomically (cursor FIRST, then statuses), so the controller
resyncs in ONE call and resumes the long-poll from the returned cursor with **zero lost events** (a boundary
event already reflected in a status may be redelivered on resume — harmless/idempotent — but is never
dropped). Shape:

```json
{
  "sessions": [
    {
      "sessionId": "…", "name": "…", "agent": "claude|terminal|…", "workingDir": "…",
      "lifecycle": "created|starting|running|exited|crashed",
      "interactionState": "busy|idle|waiting_input|exited|unknown",
      "canAcceptInput": true,
      "confidence": "high|medium|low",
      "lastTurnEndedAt": 1719500000000,
      "awaiting": { "kind": "next_message|plan_approval|tool_approval|choice_question|trust_prompt" },
      "sessionStateSeq": 7,
      "bound": true,
      "lastActivity": "2026-06-27T…"
    }
  ],
  "cursor": "<epoch>:<seq>",
  "capturedAt": 1719500000000
}
```

**Reconnect protocol:** on a `gap` (`overflow`/`restart`) marker from `GET /events`, call `GET /snapshot`,
reconcile each session from `sessions[]`, then resume the long-poll from `snapshot.cursor`.

**`GET /api/control/capabilities` (F19)** — cross-repo capability negotiation, read ONCE per instance; the
client fails closed (or degrades explicitly) on a missing capability, so a newer client never silently
assumes an older instance supports a field/event. Shape:

```json
{
  "contractVersion": 1,
  "capabilities": {
    "permissionMode": true, "agentArgs": true, "turnBinding": true, "snapshot": true,
    "perSessionRetention": true, "structuredConfirmation": true, "steeringMutex": true,
    "coarseUnboundStatus": true, "rateLimitClassification": true
  },
  "permissionModes": ["plan", "acceptEdits", "default", "bypassPermissions"],
  "events": ["turn_ended","became_idle","became_busy","waiting_input","exited","crashed","session_created","session_deleted"],
  "limits": { "eventsPerSession": 256, "maxReadLines": 2000, "eventsLongPollMaxMs": 60000 }
}
```

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
