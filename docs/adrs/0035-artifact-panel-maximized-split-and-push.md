# ADR-0035: Artifact panel maximized split + idle-gated push to the agent

## Status

Accepted. Extends ADR-0033 (remote artifact-review loop). Push injection ships
**default OFF** behind `AIORDIE_ARTIFACT_PUSH`.

## Context

ADR-0033 built the remote artifact-review loop: the agent opens an HTML artifact,
the human annotates it, and feedback reaches the agent. Two follow-ups remained.

1. **Layout.** The review panel stacked chat under the artifact even when
   maximized (maximize only changed the panel bounds). Maximizing is a request for
   content width, so a wide artifact ended up in a short letterbox with chat
   wasting horizontal space.

2. **Messaging asymmetry.** agent to human is already push (agent-reply, SSE, the
   panel chat updates instantly). human to agent is pull: feedback only reaches
   the agent when it calls `artifact_poll`. If the agent finished its turn and is
   idle at the prompt, panel feedback sits queued until the agent happens to poll
   again, which it will not do on its own. `lavish-axi` has the same limit (it is
   purely poll-based). ai-or-die can do better because it owns the terminal.

## Decision

### Maximized layout (CSS only)

When `.artifact-panel--maximized` is set, the panel body becomes a CSS grid:
artifact content as the large flexible left pane, chat as a fixed 360px right rail
(pills bar at the rail top, chat log in the middle, composer at the bottom).
Placement is by grid row/column, so no JS reparent is needed. Under a 1024px
viewport the layout reverts to the original vertical stack, where a narrow window
reads better stacked. The non-maximized floating panel is unchanged.

### Idle-gated push (default off)

The artifact review `sessionId` (the value github-router posts to
`/api/artifact/<sessionId>/...`, sourced from `AIORDIE_SESSION_ID`) is identical
to the bridge PTY session id (`bridge.sendInput(sessionId, ...)`), so a push needs
no reverse-map. When `AIORDIE_ARTIFACT_PUSH` is enabled the server passes a
`pushToAgent(sessionId, text)` hook into `createArtifactReviewRouter`. On
`POST /prompts`:

- If an `artifact_poll` is in flight for the session (the router tracks an
  active-poll count), the queue path delivers the feedback. Do NOT inject.
- Otherwise the agent is not waiting on a poll, so format the queued prompts into
  one message and call `pushToAgent`. The server hook applies a second gate
  (`bridge.msSinceLastOutput(sessionId)` must exceed a quiet window, default
  1500ms, a proxy for "not mid-render"), then injects via bracketed paste
  (`ESC[200~ ... ESC[201~`) followed by a carriage return so multi-line feedback
  enters the composer atomically and submits as one turn. On a successful write
  the router consumes (acks) the queued prompts so a later poll does not
  double-deliver. On decline or failure the queue is left intact for the poll
  path.

Bracketed-paste markers are stripped from the human text and the injection is
size-capped so the text cannot break out of the paste envelope.

## Consequences

- An idle agent now reacts to panel feedback without the human switching to the
  terminal: bidirectional push for the common case, with poll retained as the
  fallback for the busy/mid-turn case, for non-ai-or-die agents (curl/poll), and
  as the durable source of truth.
- **Residual risk (why default off):** the idle gate is a heuristic. "No active
  poll" plus "PTY quiet for N ms" does not prove the agent is idle at the prompt;
  an agent that is mid-turn but silent (thinking) could still receive an injection
  that races its TUI input. The conservative gate makes this unlikely, not
  impossible, so the feature is opt-in. The robust signal is the transcript
  "awaiting user input" state (ai-or-die already binds the tab to the Claude
  transcript via the `AIORDIE_CLAUDE_BIND` sidecar); wiring that as the primary
  idle gate is the follow-up that would let this default on.
- PTY injection itself is not unit-testable; the router gate, the consume-on-push
  behaviour, and the formatter are covered in `test/control/artifact-routes.test.js`
  with a mocked `pushToAgent`. Real injection needs manual / e2e verification.
- Reuses the existing 1:1 session identity and bridge `sendInput`; no new id
  plumbing.
