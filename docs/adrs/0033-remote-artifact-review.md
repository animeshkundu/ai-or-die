# ADR-0033: Remote artifact-review loop (`/api/artifact/*`)

## Status

Accepted (backend implemented; client panel A3 + agent env-injection are follow-ups).

## Context

`lavish-axi` pioneered an interactive HTML-artifact review loop: an agent writes a rich HTML artifact, a local
browser opens it, the human annotates DOM elements / selected text and queues feedback, and the agent receives
that feedback through a long-poll. lavish binds to loopback and is explicitly unauthenticated when exposed.
We want the same human-in-the-loop loop, but available to a **remote** user over ai-or-die's existing authed
Dev Tunnel / HTTPS — i.e. the agent runs inside an ai-or-die session and the reviewer is at the ai-or-die web
UI on another machine.

## Decision

Build the loop **natively** into ai-or-die (not a reverse-proxy of lavish-axi, which would mean rewriting
root-absolute URLs, running a second loopback process, and would not solve agent-side feedback delivery), and
ride ai-or-die's existing auth + tunnel + file-watch SSE:

- `src/artifact-review.js` — `ArtifactReviewStore` (keyed by ai-or-die session id) with a **destructive-read**
  `takeFeedback` (lavish semantics) + an `EventEmitter`; a `createArtifactReviewRouter(deps)` mounting
  `/api/artifact/:sessionId/*` **after** the auth middleware: browser↔server (`view` SDK-injected,
  `asset/*`, `prompts`, `layout-warnings`, `events` SSE, `end`) and agent↔server (`open`, `poll` long-poll,
  `agent-reply`).
- Every artifact + sibling-asset path goes through `validatePath()` (the `baseFolder` sandbox) PLUS a
  `path.relative` traversal guard PLUS a `..`-segment reject — defense in depth; a traversal or out-of-base
  request is a 403, never served. (lavish's unsandboxed `canonicalFile` is deliberately NOT used.)
- Sandboxed-iframe sub-resources cannot set an Authorization header or inherit `?token=`, so the artifact
  `<base href>` embeds the auth token in the asset PATH (`/asset/_auth/<token>/<relpath>`);
  `_artifactAssetTokenFromPath` extracts it in the auth middleware and the asset route strips the prefix
  before resolving. The token is the same secret the browser already carries in URLs.
- The injected SDK (`src/artifact-sdk-client.js`) talks ONLY via `postMessage`, so it is origin-agnostic and
  ports from lavish near-verbatim.

Agent-side feedback delivery: github-router exposes `artifact_open` / `artifact_poll` / `artifact_reply` MCP
tools (gated on an `AIORDIE_BASE_URL`/`AIORDIE_TOKEN`/`AIORDIE_SESSION_ID` env trio present only inside an
ai-or-die tab) so the in-session agent receives feedback as a structured tool result. A curl/poll fallback
works for non-github-router agents.

## Consequences

- The remote user reviews + annotates artifacts over the same authed tunnel as the rest of ai-or-die; no second
  process, no loopback, no URL rewriting.
- The client panel (per-tab `artifact-panel.js` + `session-manager.js` mount) and ai-or-die setting the agent
  env trio at launch are follow-ups; the backend + the github-router tools are in place and tested
  (store destructive-read, SDK injection, traversal/out-of-base 403, long-poll).
- Reuses the hardened, Windows-tuned chokidar file-watcher for reload.
