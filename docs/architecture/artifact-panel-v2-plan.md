# Artifact Panel v2 — Unified Implementation Plan

Status: active. Pairs with the FROZEN contract `docs/architecture/artifact-panel-v2-contract.md` (v2.0).
Two instances implement in parallel: **CONSUMER** = ai-or-die (this instance), **PRODUCER** = github-router
(other instance). **No source file is shared across the two repos.** The contract is the only coupling.

Ordering principle: **P0 = reliability + security FIRST** (the loop must be correct and safe before it gets
richer), then **P1 = structured push + interactivity**, then **P2 = polish + real presence + full e2e**.
Each phase lists CONSUMER tasks, PRODUCER tasks, acceptance criteria (how we verify), and the tests to add.

File-ownership map (no overlap):
- CONSUMER writes: `src/public/artifact-panel.js`, `src/artifact-sdk-client.js`, `src/artifact-review.js`,
  `src/server.js` (push gate + endpoints),
  `src/public/components/artifact-panel.css`, `src/control/jsonl-awaiting.js` (idle classification),
  `test/control/artifact-routes.test.js`, `test/**` new unit tests, `e2e/tests/56-artifact-panel-v2.spec.js`.
- PRODUCER writes: `src/lib/**/artifact*` MCP tools + client, plan→HTML renderer, `internal-artifact-open`
  hook, `gh-artifact-review` skill, `CLAUDE.md` directive, github-router tests.

---

## Phase P0 — reliability + security (blocking; ship before P1)

### CONSUMER (ai-or-die)
- **C-P0-1 Kill the double agent-reply render.** Remove the WS render path; make SSE the sole render path
  (contract §5). WS keeps only `artifact_review_opened|reload|dismissed|ended` lifecycle nudges. Touch:
  `artifact-panel.js:375-385` (agentReply → stop appending chat), `server.js:1068`
  (`agent-reply` broadcast → drop or demote to a non-render nudge).
- **C-P0-2 Per-session queue + chat; stop dropping on tab switch.** Move `_queue` and chat into the
  `reviews` Map (per sessionId). `notifyActiveSessionChanged` (`artifact-panel.js:387-393`) must NOT
  `_clearQueue()`; `_show` (`402-417`) must NOT wipe `_chatLog` — instead rehydrate from `GET /history`.
- **C-P0-3 Dismiss re-open affordance.** Wire × to `POST /:id/dismiss` (server-authoritative visibility)
  and add a re-open badge → `expand()` (`artifact-panel.js:104,108,422-427`).
- **C-P0-4 SSE reconnect replay.** Consume the SSE `id:`/`Last-Event-ID` replay; on (re)connect, call
  `GET /history` and repaint chat + apply undelivered events. Server: add the bounded replay buffer +
  `id:` on SSE frames + `GET /:id/history` (`artifact-review.js` store + `events` route).
- **C-P0-5 SECURITY: DROPPED (v2.2).** The view-ticket/HMAC item is removed — the security boundary is the
  mesh + existing transport auth, not a home-rolled token (contract §7). `/view` keeps today's auth; no
  ticket, no auth.js change, no sandbox change required for security. (Slot kept for numbering stability.)
- **C-P0-6 Idle-gate hardening (contract §6).** In `_pushArtifactFeedbackToAgent` (`server.js:4138`),
  make `detectAwaiting` the PRIMARY gate: hard-decline free-text push when a user-facing tool is pending;
  positive-push only on `idleAtPrompt`; keep `msSinceLastOutput` secondary + no-binding fallback. Add the
  `idleAtPrompt`/`turnComplete` classification to `jsonl-awaiting.js`; cache the read (~1s).
- **C-P0-7 Note composer failure recovery.** `_submitNote` (`artifact-panel.js:615-621`) must restore the
  note + surface a retry on POST failure, mirroring `_sendQueue` (`600-612`).

### PRODUCER (github-router)
- **P-P0-1 Client retry/backoff.** ArtifactClient: retry transient `UNREACHABLE`/`TIMEOUT` on
  `open`/`reply`/`end` (and future `update`) — close the single-shot gap.
- **P-P0-2 Client unit tests.** Error taxonomy, timeout, `allowEmptyJson`, `artifact_reply` (currently
  untested), real-payload tolerance.

### P0 acceptance criteria (verify, don't assert)
- Unit (consumer, `test/control/artifact-routes.test.js` + new `test/artifact-panel.test.js` via jsdom):
  - Idle gate: with a mocked binding whose `detectAwaiting` returns a pending `ExitPlanMode`,
    `_pushArtifactFeedbackToAgent` returns false (declined) even when PTY is quiet; with `idleAtPrompt`
    it injects. **(C-P0-6)**
  - `GET /history` returns prior chat + undelivered events + `cursor`; `artifact_await`/`poll` after an
    ack does not re-deliver. Reconnect via `Last-Event-ID` yields exactly the gap. **(C-P0-4)**
  - Panel unit: two tab switches preserve the per-session queue and chat; dismiss then re-open restores the
    same review; a single agent reply renders once (SSE path only). **(C-P0-1,2,3)**
- Unit (producer): retry succeeds after one transient failure; `artifact_reply` happy + error paths.
- **One e2e (`e2e/tests/56-artifact-panel-v2.spec.js`, P0 slice):** open a static artifact → annotate a
  block → Send → agent drains via `/await` → `artifact_reply` → assert chat shows the reply **once** →
  dismiss → assert hidden + re-open badge → re-open → chat history intact.
- Gate: `npm test` green on Windows + Linux.

---

## Phase P1 — structured push + interactivity

### CONSUMER (ai-or-die)
- **C-P1-1 Endpoints + typed events.** Add `POST /:id/actions`, `POST /:id/update` (typed body + tagged-400
  `INVALID_REQUEST`, contract §3.1/§3.2), `POST /:id/refresh`, `POST /:id/dismiss`, `GET /:id/await`
  (typed), `GET /:id/history` (browser-only), `artifact-event` SSE frames with `id:`; keep `GET /:id/poll`
  legacy (old shape). Add per-session `idempotencyKey` dedupe for `/update` + `/end`, and make end-after-end
  return `{ok:true,status:"ended"}` (never 404). Refactor the store: `queuePrompts`→ enqueue typed `comment`
  events; add `enqueueAction`; `takeFeedback`/drain returns `ArtifactEvent[]` + cursor; legacy `/poll`
  projects `comment` events back to the old `prompts` shape. Touch: `artifact-review.js` store + routes.
- **C-P1-2 SDK `data-aod-*` capture (contract §4).** Add the scoped capture-phase listener for
  `[data-aod-action]` (click/change), require `data-aod-id`, post `artifact-action`; leave non-`data-aod`
  native controls exactly as today. Touch: `artifact-sdk-client.js:209-221,479-511`.
- **C-P1-3 Panel action forwarding + state.** Handle `artifact-action` → optimistic `plan-state` →
  `POST /:id/actions`; render the pill/step affordance. Touch: `artifact-panel.js:458-515,536-613`.
- **C-P1-4 Structured-approval routing.** When an `action` maps to a pending user-facing tool, route via
  the existing `_controlRespond` path instead of the queue/push. Touch: `server.js` `/actions` handler.
- **C-P1-5 `artifact_update` server side.** `POST /:id/update`: `file` (validatePath) re-read, or `html`
  written to the review's sandboxed file then reload-broadcast. Touch: `artifact-review.js`, `server.js`.

### PRODUCER (github-router)
- **P-P1-1 New MCP tools.** `artifact_open({mode})`, `artifact_update`, `artifact_refresh`,
  `artifact_await` (+ `artifact_poll` alias), `artifact_dismiss` (keep `artifact_reply`/`artifact_end`).
  Typed `ArtifactEvent` handling in the client + a drain loop that acks by cursor. Per contract §1.1:
  auto-retry only `open`/`update`/`end`/`await` (with `idempotencyKey` on update+end); `reply`/`refresh`/
  `dismiss` are single-shot. `mode` is NOT sent to the server (renderer hint only). `mapHttpError` gains
  the tagged-400 → `INVALID_REQUEST` mapping (§3.1). No `/history` client method (agent resync = await with
  an old/absent cursor, §3.3).
- **P-P1-2 Interactive plan renderer.** Emit `data-aod-action`/`data-aod-id`/`data-aod-value` + `aod-step`
  markup for `mode:"interactive"`; keep `data-source-line`; keep the existing HTML-escaping /
  `javascript:`-neutralizing safety. Static mode unchanged.
- **P-P1-3 Skill + directive.** Update `gh-artifact-review`: document push arrival, structured-vs-free-text
  drain, the new verbs (dismiss/refresh/update), and `data-aod-*` authoring. Update the CLAUDE.md directive
  that currently names open/poll/reply/end to add await/update/refresh/dismiss.

### P1 acceptance criteria
- Unit (consumer): `POST /:id/actions` → `artifact_await` returns a `{kind:"action", action, elementId,
  value?}` event with a monotonic `id`; SDK unit (jsdom) posts `artifact-action` for a `data-aod-*` button
  and does NOT for a plain button; `artifact_update({html})` writes only within the sandbox (out-of-base or
  html-without-file → INVALID_REQUEST); an `approve` action with a pending `ExitPlanMode` calls the respond
  path (mock), not the PTY.
- Unit (producer): renderer emits well-formed `data-aod-*`; drain loop acks and does not double-process an
  event id; `artifact_dismiss`/`artifact_refresh` happy paths.
- **e2e (extend `56-…`, P1 slice):** open an **interactive** plan → click an `Approve` button in the iframe
  → assert the agent's `artifact_await` returns the `action` event once → agent acks → click again →
  assert single delivery per activation.

---

## Phase P2 — polish + real presence + full e2e

- **C-P2-1** Real presence over SSE (`presence.state` from the transcript signal, contract §6); panel
  reflects `working|idle_at_prompt|awaiting_input` instead of the client-optimistic guess.
- **C-P2-2** Maximize a11y (focus into composer), plan-state visual polish, background-tab reply badge.
- **P-P2-1** `internal-artifact-open` hook: **stays STATIC** (contract §9 / OQ6). Auto-open on ExitPlanMode
  keeps rendering plan markdown to a static sibling artifact — it does NOT emit interactive `data-aod-*`
  markup in v2. Interactive is opt-in via explicit `artifact_open({mode:"interactive"})`/`artifact_update`.
  Task here is just a regression test that auto-open still works and is unaffected by the v2 changes.
- **AC:** presence flips to `working` when the transcript shows an in-progress turn and `awaiting_input`
  on a pending tool; full e2e covers open→annotate→action→reply→update→refresh→dismiss→re-open→end with
  chat/queue integrity across a simulated SSE drop.

---

## Integration / cross-repo verification (run after each phase)

Both repos are already checked out on this host (`C:\Users\anikundu\Software\ai-or-die` and
`…\github-router`). The producer instance implements its half; the consumer instance implements this half;
integration is driven HERE:

1. Build/install consumer: `npm ci` in ai-or-die; run the unit gate (`npm test`) on Windows + Linux.
2. Point the launcher at the local github-router build (the bridge already launches claude via
   `npx github-router` — use the local checkout instead) so the new MCP tools are live.
3. Launch an ai-or-die session; have the agent call `artifact_open({mode:"interactive"})` on a rendered
   plan; drive the panel with Playwright (`e2e/tests/56-artifact-panel-v2.spec.js`): annotate, click a
   `data-aod-*` control, assert the agent's `artifact_await` sees the typed event, assert `artifact_reply`
   renders once, exercise dismiss/re-open/update/refresh/end.
4. Multi-select check in situ: render an interactive artifact with a `data-aod-group` of checks + a
   `submit`; toggle a subset, click submit, and assert the agent's `artifact_await` sees ONE `action`
   event whose `selected[]` is exactly the toggled set (and `check` toggles emitted no events).
5. Attest the contract invariants (§11) hold end to end before declaring a phase done; consult the advisor
   on the P0 idle-gate change before merge (mandatory per project rules: input paths).

## Risks / watch-items
- The `idleAtPrompt` classification must not regress `detectAwaiting`'s existing control/session-status
  callers (`server.js:4303,5045`) — extend, don't repurpose.
- Legacy `/poll` projection must losslessly represent `comment` events or old agents regress — cover with a
  back-compat test.
- Multi-select: the SDK's per-group checked set must reset correctly on artifact reload/update so a stale
  selection can't be submitted against re-rendered ids — cover in the SDK unit test.
- Producer/consumer must land SSE-only render together enough that a mixed build never renders replies
  twice; sequence C-P0-1 with the producer's client build.
