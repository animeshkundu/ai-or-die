# Artifact Panel v2 — FROZEN Wire Contract

Status: **FROZEN v2.2** (2026-07-02). Contract architect: consumer instance (ai-or-die owns the
interaction model). Reconciles `docs/research/artifact-panel-v2-consumer-brief.md` (consumer) and the
producer brief (github-router). Both repos implement in parallel against THIS document. Breaking changes
require a new version header + a superseding ADR.

Changelog: **v2.2** — human review: (a) DROPPED the view-ticket/HMAC item — the security boundary is the
Tailscale/devtunnel mesh + proven transport, not a home-rolled token; artifacts are agent-authored/trusted
and the bearer in the iframe URL grants an on-mesh reader nothing it lacks. (b) MULTI-SELECT made explicit:
`choose` (one) vs `check`+`submit` (a set), carried by a `data-aod-group` aggregation.

Changelog: **v2.1** — ratified with notes: added `POST /:id/refresh`; typed `/update` schema + tagged-400
`INVALID_REQUEST` wire signal; `mode` is a producer-only renderer hint (no `/open` wire change);
`idempotencyKey` dedupe for retried non-idempotent POSTs; single-shot dismiss/refresh; auto-open stays
static; `/history` is browser-only (agent resync via `artifact_await` with an old/absent cursor);
`next_step` is an allowed additive field on every tool result.

Baseline: ai-or-die main @ `68ef947`. Repos: **consumer** = ai-or-die (panel, SDK, `/api/artifact/*`,
bridge); **producer** = github-router (MCP `artifact_*` tools, plan→HTML renderer, `internal-artifact-open`
hook, `gh-artifact-review` skill). No source file is shared across the two repos.

Forward-compat rule (applies everywhere): **unknown ArtifactEvent `kind`s, unknown MCP params, and unknown
SSE event names MUST be ignored, never error.** This is what lets us extend the frozen surface later.

---

## 1. MCP tool surface (producer-exposed, agent-facing)

Final set = **7 tools**. All remain gated on the `AIORDIE_BASE_URL` / `AIORDIE_TOKEN` / `AIORDIE_SESSION_ID`
env trio (unchanged). `artifact_poll` is retained as a **frozen back-compat alias** (8th name, old shape).

```ts
// --- lifecycle ---------------------------------------------------------------
artifact_open({ file: string, mode?: "static" | "interactive" })
  -> { viewUrl: string, sessionId: string, key: string }
  // mode defaults to "static". mode is a PRODUCER-ONLY renderer hint: it selects whether the plan->HTML
  // renderer EMITS data-aod-* controls. It is NOT sent to the server — POST /:id/open body stays {file}
  // (§3 Unchanged). The panel/SDK wire ANY data-aod-* markup they find regardless of mode, so an
  // interactive artifact works in any panel and static artifacts stay annotate-only. (OQ item 3.)

artifact_update({ file?: string, html?: string, idempotencyKey?: string })
  -> { ok: true, viewUrl: string }
  // Replace the CURRENT review's content. `file` must pass validatePath (sandbox). `html`, if given,
  // is WRITTEN BY THE SERVER to the review's existing sandboxed file path, then reloaded — it is NEVER
  // rendered from an unsandboxed over-the-wire blob (see OQ3). Exactly one of file|html. Violations
  // (both, neither, html without an existing review file, out-of-base file) return the tagged-400
  // INVALID_REQUEST wire signal (§3.1). idempotencyKey dedupes a retried write (§1.1).

artifact_refresh({})
  -> { ok: true }
  // Force a content reload from disk (re-read + broadcast reload) with no content change. For when the
  // agent edited the file out-of-band and does not want to rely on the chokidar watcher. Single-shot
  // (not auto-retried, §1.1) — a lost refresh is harmless; the agent may simply call it again.

artifact_dismiss({})
  -> { ok: true }
  // Hide the panel UI; the review stays ALIVE (feedback channel open, queue preserved). Distinct from
  // end. The human sees a re-open affordance. Idempotent (dismiss-after-dismiss is ok:true). Single-shot
  // (not auto-retried, §1.1).

artifact_end({ idempotencyKey?: string })
  -> { ok: true, status: "ended" }
  // Terminate the review: status=ended, watcher stopped, final `ended` event emitted. Any human feedback
  // still queued at end time is delivered on the agent's NEXT drain, FOLLOWED by the `ended` event
  // (end never silently drops unsent feedback). end-after-end (or end on an already-ended review) returns
  // { ok:true, status:"ended" }, NOT NOT_FOUND, so a retried end is safe (§1.1).

// --- messaging ---------------------------------------------------------------
artifact_await({ cursor?: string, timeoutMs?: number })
  -> { events: ArtifactEvent[], status: ReviewStatus, cursor: string }
  // Typed drain (supersedes poll). Long-holds up to timeoutMs (server cap DEFAULT_POLL_HOLD_MS, ~25s;
  // client budgets multiple attempts as today). Returns events > cursor; echoes the new high-water
  // `cursor` the agent passes next call. Delivery is idempotent by (cursor, event.id): re-passing an
  // old cursor re-delivers (safe); the server marks events delivered but keeps a bounded replay buffer.

artifact_reply({ text: string })
  -> { ok: true }
  // Free-text agent->human message. Rendered in panel chat (SSE). NOT auto-retried (§1.1).

// --- back-compat alias (FROZEN, do not extend) -------------------------------
artifact_poll({ timeoutMs?: number })
  -> { status, prompts, next_step, layout_warnings?, dom_snapshot? }   // OLD payload, unchanged
  // Serves existing skill/CLAUDE.md. Returns only `comment`-equivalent free-text prompts (NOT actions).
  // New agents MUST use artifact_await.
```

`ReviewStatus = "open" | "ended" | "missing"`.

Every tool result MAY additionally carry a `next_step: string` guidance field (the producer appends one
today). It is an ALLOWED ADDITIVE field under the forward-compat rule — consumers/clients MUST preserve
and never reject it. (OQ item 8.)

### 1.1 Retry + idempotency (non-idempotent POSTs)

Retry/backoff on transient `UNREACHABLE`/`TIMEOUT` is applied **only** to POSTs made safe against
double-apply:

| Tool | Auto-retry? | Duplicate prevention |
|---|---|---|
| `artifact_open` | yes | naturally idempotent (re-open of the same file returns the same review) |
| `artifact_update` | yes | `idempotencyKey` — server dedupes; a repeat key is a no-op returning the first result |
| `artifact_end` | yes | `idempotencyKey` **and** end-after-end returns `{ok:true,status:"ended"}` (never NOT_FOUND) |
| `artifact_reply` | **no** | not auto-retried (a duplicate is a visible chat bubble); model re-sends if needed |
| `artifact_refresh` | **no** | single-shot; a lost refresh is harmless, call again |
| `artifact_dismiss` | **no** | single-shot; idempotent server-side, so a manual repeat is safe anyway |
| `artifact_await` / `artifact_poll` | yes (long-poll re-arm) | cursor-idempotent: re-passing a cursor re-delivers safely (no side effect) |

`idempotencyKey` is client-generated, unique per logical operation (fleet client has precedent), sent in
the POST body; the server remembers recent keys per session and returns the original result for a repeat.

Error taxonomy: `UNREACHABLE | AUTH_FAILED | NOT_FOUND | TIMEOUT | UPSTREAM_ERROR | INVALID_RESPONSE |
INVALID_REQUEST`. `INVALID_REQUEST` is carried by the tagged-400 wire signal (§3.1).

---

## 2. `ArtifactEvent` — the discriminated union (SSE push + `artifact_await` drain)

ONE schema serves both channels. Every event carries a stable per-session monotonic `id` (string of an
integer, gap-free, starts at "1") for single-delivery ack.

```ts
type ArtifactEvent =
  | { kind: "comment"; id: string; prompt: string; text: string;
      selector: string; sourceLine?: number; target?: TextRangeTarget }
  | { kind: "action";  id: string; action: string; value?: string;
      elementId: string; group?: string; selected?: SelectedItem[];
      selector?: string; sourceLine?: number }
  | { kind: "ended";   id: string };

type SelectedItem = { elementId: string; value?: string };  // members of a submitted multi-select set

type TextRangeTarget = {                     // unchanged from today's SDK (artifact-sdk-client.js:180-188)
  type: "text-range"; text: string; selector: string; commonAncestorSelector: string;
  start: { selector: string; path: number[]; offset: number };
  end:   { selector: string; path: number[]; offset: number };
};
```

- `comment` = today's free-text annotation (a clicked block or selected text + a prompt). Bare-string
  composer notes map to `{kind:"comment", prompt:<text>, text:"", selector:""}`.
- `action` = a `data-aod-*` control activation (§4). `action` = the `data-aod-action` verb;
  `elementId` = the `data-aod-id`; `value` = `data-aod-value` (or a checkbox's checked state as
  `"true"`/`"false"`). **Multi-select:** a `submit` action carries `group` (the `data-aod-group` it
  submits) and `selected` (the currently-checked members of that group, each `{elementId, value?}`); a
  single `choose` fires one action event with no `selected`. `check` toggles are UI-local and do NOT emit
  their own event — only the `submit` does (see §4).
- `ended` = the review terminated; always the LAST event.
- **Reserved future kinds** (`dismissed`, `presence`, …) — not required in v2.1; both sides ignore
  unknown kinds.

Single-delivery contract: the server assigns `id` at enqueue, keeps a bounded replay buffer
(≥200 events/session). `artifact_await` returns events with `id > cursor` and echoes the max `id` as the
new `cursor`. SSE emits each event with the SSE `id:` field so `EventSource` `Last-Event-ID` replays the
gap on reconnect.

---

## 3. HTTP endpoints — `/api/artifact/:sessionId/*`

New (**N**) / Changed (**C**) / Unchanged (**U**). All sit behind ai-or-die's existing auth on the mesh
origin (§7).

| Method | Path | Status | Purpose |
|---|---|---|---|
| POST | `/:id/open` | U | agent opens; body `{file}` only — `mode` is NOT sent (producer-only hint, §1) |
| GET  | `/:id/view` | U | serves SDK-injected HTML (existing auth — see §7) |
| GET  | `/:id/sdk.js` | U | injected SDK |
| GET  | `/:id/asset/_auth/<assetToken>/*` | U | sandboxed sibling assets (path-token, already safe) |
| POST | `/:id/prompts` | U | free-text/annotation feedback (human→agent); idle-push applies |
| POST | `/:id/actions` | **N** | structured action feedback (human→agent); idle-push/respond routing applies |
| POST | `/:id/layout-warnings` | U | legacy layout warnings |
| POST | `/:id/update` | **N** | agent replaces content (§3.2); tagged-400 on invalid input (§3.1) |
| POST | `/:id/refresh` | **N** | force content reload from disk, no content change → `{ ok: true }` |
| POST | `/:id/dismiss` | **N** | hide panel, keep review alive (server-authoritative visibility) → `{ ok: true }` |
| POST | `/:id/end` | U | terminate review; end-after-end → `{ ok:true, status:"ended" }` (never 404) |
| POST | `/:id/agent-reply` | U | agent→human free text (SSE render only — see §5) |
| GET  | `/:id/await?cursor=&timeoutMs=` | **N** | typed drain → `{ events, status, cursor }` |
| GET  | `/:id/poll` | U (frozen) | legacy long-poll, OLD payload |
| GET  | `/:id/history` | **N** | **browser-only** replay for reconnect/rehydrate; NOT an MCP tool (§3.3) |
| GET  | `/:id/events` | **C** | SSE; adds typed `artifact-event` messages with `id:` + real `presence.state` |

### 3.1 Tagged-400 `INVALID_REQUEST` wire signal
Any endpoint that rejects a well-formed-but-invalid request returns **HTTP 400** with body
`{ error: { code: "INVALID_REQUEST", message: string } }`. The producer client maps `status===400 &&
body.error.code==="INVALID_REQUEST"` → the `INVALID_REQUEST` taxonomy value (today `mapHttpError` keys only
on status and would mis-map 400→UPSTREAM_ERROR). This convention applies everywhere INVALID_REQUEST can
arise (currently `/update`; any future validation). Other 4xx/5xx keep today's status-based mapping.

### 3.2 `POST /:id/update`
```ts
// body — exactly one of file|html:
{ file?: string, html?: string, idempotencyKey?: string }
-> 200 { ok: true, viewUrl: string }
// 400 { error: { code: "INVALID_REQUEST", message } }  when: both file+html, neither, out-of-base file,
//     or html with no existing review file. `html` is written by the server to the review's sandboxed
//     file path (never rendered from an unsandboxed blob), then a reload is broadcast (same path as a
//     file-watch change). A repeated idempotencyKey returns the first result without re-writing.
```

`POST /:id/actions` body:
```ts
{ actions: Array<{ action: string; elementId: string; value?: string;
                   group?: string; selected?: Array<{ elementId: string; value?: string }>;
                   selector?: string; sourceLine?: number }>,
  domSnapshot?: object }
-> { ok: true, pushed: boolean, queued: number }   // same shape as /prompts
```

### 3.3 `GET /:id/history` — browser-only
```ts
{ chat: Array<{ role: "you" | "agent"; text: string; at: string; id: string }>,
  events: ArtifactEvent[],          // replay buffer (undelivered + recent)
  status: ReviewStatus, cursor: string, visibility: "shown" | "dismissed" }
```
This endpoint exists for the PANEL only (reconnect/rehydrate). It is **not** exposed as an MCP tool and the
producer builds no history client method: a post-compaction agent that lost its cursor resyncs by calling
`artifact_await` with an absent/old `cursor`, which replays the bounded buffer (§2). (OQ item 7.)

`GET /:id/events` SSE frames (each `data:` is JSON):
```
event: artifact-event   id: <n>   data: <ArtifactEvent>          # NEW typed push
event: agent-reply                data: { text, reply }          # unchanged (SSE is the SOLE render path)
event: presence                   data: { state, connected, lastSeen, pendingTool? }   # state now REAL
event: ended                      data: { status: "ended" }      # unchanged
```
`presence.state = "idle_at_prompt" | "working" | "awaiting_input"` derived from the transcript (§6).

---

## 4. Declarative interactive vocabulary + SDK behavior

Producer renderer emits (no JS inside the artifact; the injected SDK wires everything):

```html
<!-- choose-one (radio / decision): a single click emits one action event -->
<button data-aod-action="approve" data-aod-id="plan-step-3">Approve</button>
<button data-aod-action="reject"  data-aod-id="plan-step-3">Reject</button>
<a data-aod-action="choose" data-aod-value="option-b" data-aod-id="decision-1">Option B</a>
<li class="aod-step" data-aod-id="plan-step-3" data-source-line="42"> … </li>

<!-- choose-multiple: toggle N checks in a group, then ONE submit emits the selected set -->
<input type="checkbox" data-aod-action="check" data-aod-group="tasks" data-aod-id="task-7" data-aod-value="retry">
<input type="checkbox" data-aod-action="check" data-aod-group="tasks" data-aod-id="task-9" data-aod-value="cache">
<button data-aod-action="submit" data-aod-group="tasks" data-aod-id="tasks-go">Apply selected</button>
```

Attribute namespace (**SIGNED OFF**):
- `data-aod-action` — **required**. The verb (`approve`|`reject`|`choose`|`check`|`submit`|`edit`|custom).
- `data-aod-id` — **required, stable**. Echoed as `elementId`. The producer MUST keep it stable across
  re-renders so acks/state map correctly.
- `data-aod-value` — optional. Echoed as `value`.
- `data-aod-group` — **required on `check` and `submit`**, ignored elsewhere. Ties a set of `check`
  controls to the `submit` that harvests them. A `check` MUST share its group's exact string with its
  `submit`.
- `data-source-line` — **kept** (unchanged source-map anchor).

**Choose-one vs choose-multiple (explicit):**
- **Choose-one** (`approve`/`reject`/`choose`/custom, no group): the click emits ONE `action` event
  immediately with `{action, elementId, value?}` and no `selected`.
- **Choose-multiple**: `check` toggles are **UI-local only** — the SDK tracks checked state per
  `data-aod-group` and emits **no event on toggle**. When the group's `submit` is clicked, the SDK emits a
  single `action` event `{action:"submit", elementId:<submit's id>, group:<data-aod-group>, selected:
  [{elementId, value?}, …]}` containing the currently-checked members of that group. An empty set is
  allowed (emits `selected: []`) so "none selected" is expressible. The server does NOT aggregate loose
  `check` events (there are none); the `submit` event is the whole, atomic set.

**SDK capture change (scoped to `data-aod-*` ONLY):** today `isInteractiveControl`
(`artifact-sdk-client.js:209-221`) makes native controls behave natively and the SDK forwards nothing.
v2 adds a dedicated capture-phase listener:
- An element matching `[data-aod-action]` (or an ancestor within it): on `click` (buttons/anchors) or
  `change` (checkboxes/inputs). For `check` the SDK only updates its internal per-group set (no post). For
  every other verb — including `submit` — it **posts `artifact-action`** (§8) and, for anchors/submit
  buttons only, `preventDefault()`s the native navigation/submit. It does NOT open the annotation card.
- Native controls WITHOUT `data-aod-action` keep today's behavior exactly (behave natively, no forward,
  annotation suppressed). No regression for ordinary artifact chrome.
- The SDK MUST require `data-aod-action` and `data-aod-id`, and additionally `data-aod-group` for
  `check`/`submit`; a control missing a required attribute is ignored (dev error, never posted).

Panel receives `artifact-action`, optimistically reflects step/selection state, and POSTs `/:id/actions`.

---

## 5. Push, both directions

### agent → human — SSE is the SINGLE render path (fixes the double-render)
`agent_reply` and typed `artifact-event`s render **only** via `GET /:id/events` (SSE). The WS
`broadcastToSession('artifact_agent_reply', …)` render path is **REMOVED**; WS retains only the lifecycle
nudges the panel needs when it is NOT SSE-connected: `artifact_review_opened`, `artifact_review_reload`,
`artifact_review_dismissed` (new), `artifact_review_ended`. Chat/event rendering never comes over WS.

### human → agent — durable drain + hardened idle push
- Durable: `artifact_await` (typed) / `artifact_poll` (legacy) drain the queue; destructive-read acked on
  response finish, backed by the replay buffer.
- Idle push (ADR-0035, default ON): free-text `comment` feedback may be injected into an idle CLI as a new
  turn. **Hardened idle gate (§6).**
- Structured `action` feedback is **never bracketed-paste-injected as free text**. When it corresponds to a
  pending user-facing tool (e.g. an `approve` while the transcript shows a pending `ExitPlanMode`), it is
  routed through the existing structured **respond** path (`_controlRespond`), which maps a choice to the
  pending tool. Otherwise it is delivered via the drain (and may wake the agent via the idle-push nudge if
  the transcript says the agent is idle at a free-text prompt).

---

## 6. Idle-gate hardening (transcript = PRIMARY gate)

`_pushArtifactFeedbackToAgent` (consumer, `server.js:4138`) MUST gate on the transcript BEFORE any PTY
injection, using the already-present `detectAwaiting` (`src/control/jsonl-awaiting.js`) over the session's
`AIORDIE_CLAUDE_BIND` JSONL binding (same lookup as `server.js:5044`):

1. Resolve the session's JSONL binding. If `detectAwaiting(binding.file)` returns **non-null** → a
   user-facing tool (ExitPlanMode / AskUserQuestion / permission) is pending → **HARD-DECLINE** any
   free-text push. It stays queued for `artifact_await`; a matching structured action routes to respond
   (§5). Rationale: a quiet PTY is exactly the menu case — bracketed-paste + CR would answer the menu.
2. Positive idle signal: only allow a free-text push when the transcript's last non-sidechain event is a
   completed assistant turn with **no** unresolved `tool_use` (turn done, CLI at the free-text prompt).
   This is a small extension of `detectAwaiting` (add an `idleAtPrompt`/`turnComplete` classification).
3. Secondary guard (kept): `msSinceLastOutput > AIORDIE_ARTIFACT_PUSH_QUIET_MS` (default 1500ms), covering
   the render-in-progress window and the **no-binding fallback** (raw `claude.exe` whose slug doesn't
   resolve — degrade to today's PTY-quiet-only behavior).
4. Cache the transcript read (~1s, mirroring `_controlDetectAwaitingCached`) so per-`/prompts` cost is
   bounded.

`presence.state` on SSE is derived from the same signal: `awaiting_input` (pending user-facing tool),
`idle_at_prompt` (turn complete), else `working`.

---

## 7. Security posture — mesh is the boundary, not a home-rolled token

**Decision (human review, v2.2):** the security boundary is the **Tailscale / devtunnel mesh + the proven
authenticated transport**, NOT a token we invent. We do NOT roll our own capability/token system for the
artifact panel. Artifacts are **agent-authored and trusted**, served over a mesh-authenticated origin, so
artifact JS reading the bearer from the iframe URL grants an on-mesh reader nothing an on-mesh actor lacks.
The earlier "view ticket / HMAC" item is **DROPPED** — no `viewTicket`, no per-session HMAC for `/view`.

- `/view` and `/sdk.js` keep today's existing auth (the panel builds the iframe URL with the same token it
  already uses for the rest of ai-or-die). No new endpoint auth, no new secret.
- Free hygiene only (do not gratuitously widen exposure): keep the existing sandbox attributes and the
  existing sibling-asset path scoping as-is; do not add new ways for an artifact to reach outside its
  directory. Introduce NO new token/capability surface.
- The existing sandboxed-asset path token (`artifact-review.js:34-55, 569-575`) is unchanged — it predates
  this contract and stays as the sibling-asset scoping mechanism; v2 adds nothing to it.

---

## 8. postMessage additions (iframe ⇄ panel)

Sources unchanged: iframe→panel `source:"ai-or-die-artifact-sdk"`; panel→iframe
`source:"ai-or-die-artifact-host"`. Existing types (ready/annotation-queued/annotations-send/snapshot/
scroll/legacy prompts+warnings; set-annotation-mode/request-snapshot/restore-scroll/agent-reply/presence)
are unchanged. New:

```ts
// iframe -> panel
{ type: "artifact-action",
  payload: { action: string, elementId: string, value?: string,
             group?: string, selected?: Array<{ elementId: string, value?: string }>,
             context: { selector?: string, sourceLine?: number, text?: string },
             domSnapshot?: object } }

// panel -> iframe
{ type: "plan-state", payload: { steps: Array<{ elementId: string,
             state: "pending" | "approved" | "rejected" | "done" }> } }   // optional affordance sync
```

---

## 9. Lifecycle semantics — refresh vs dismiss vs end

| Verb | Backing route | Review status | Panel | Queued feedback | Feedback channel |
|---|---|---|---|---|---|
| **refresh** | `POST /:id/refresh` | unchanged (`open`) | content reloads (iframe cache-bust) | preserved | open |
| **dismiss** | `POST /:id/dismiss` | unchanged (`open`), `visibility="dismissed"` | hidden; re-open affordance shown | **preserved** | **open** (agent may update/await/reply) |
| **end** | `POST /:id/end` | `ended` | closes | delivered on the next drain, THEN `ended` | closed after `ended` |

Dismiss is server-authoritative (`POST /:id/dismiss` + `visibility` in `/history`) so a reconnecting panel
and the `artifact_dismiss` tool agree. The human × triggers `POST /:id/dismiss` (not a client-only hide)
and gets a re-open badge wired to the existing `expand()`. `refresh` is a distinct route from `update`
(update changes content; refresh re-reads the same file) so `artifact_refresh` never needs an empty-body
`update`.

**Auto-open stays STATIC in v2.** The producer's `internal-artifact-open` PostToolUse hook (fires on
ExitPlanMode) renders plan markdown to a sibling `.aiordie.html` and opens it as a **static** artifact —
there is no typed step model there. Interactive mode is **opt-in only**, via an explicit
`artifact_open({mode:"interactive"})` or `artifact_update` with model-authored `data-aod-*` HTML. The hook
is not required to emit interactive markup in v2. (OQ item 6.)

---

## 10. Resolution of the producer's 5 open questions

1. **SSE vs typed-poll vs both → BOTH.** `artifact_await` (typed drain, cursor-acked) is the agent's
   PRIMARY, simplest, reconnect-safe path and what the skill uses; SSE `/events` is the panel's instant
   push and MAY also be consumed by the agent client for low latency. One `ArtifactEvent` schema serves
   both. Rationale: drain is the durable source of truth; SSE is the latency layer.
2. **dismiss = new endpoint (not client-only).** `POST /:id/dismiss` + server `visibility`. Rationale: a
   client-only hide cannot back the `artifact_dismiss` tool or survive a reconnect; it also reproduces the
   current dead-end bug.
3. **artifact_update: file-on-disk is source of truth; `html` is server-written to the sandboxed file.**
   Rationale: preserves the `validatePath` sandbox and the single file-watch reload path; never render an
   unsandboxed over-the-wire blob. `html` without an existing review file → `INVALID_REQUEST`.
4. **Attribute namespace + event schema: SIGNED OFF.** `data-aod-action` (req), `data-aod-id`
   (req, stable, → `elementId`), `data-aod-value` (opt), keep `data-source-line`. `ArtifactEvent` =
   `comment | action | ended`; unknown kinds ignored.
5. **Migration: additive, no flag-day.** Keep `artifact_poll` + `GET /poll` frozen (old shape); add
   `artifact_await` + `GET /await` (typed). `/events` gains `artifact-event` frames without removing
   `agent-reply`/`presence`/`ended`. Version via the forward-compat ignore rule (unknown kinds/params/SSE
   names ignored). The `gh-artifact-review` skill + CLAUDE.md directive are updated to the new verbs but
   the old names keep resolving.

---

## 11. Frozen invariants (do not violate without a new version)
- One `ArtifactEvent` schema across SSE + drain; every event has a gap-free per-session `id`.
- SSE is the SOLE agent→human render path (no WS double-render).
- Security boundary is the mesh + existing transport auth; no new artifact-panel token/capability system.
- Multi-select is carried by a `submit` action's `{group, selected[]}`; `check` toggles emit no event.
- Free-text push is transcript-gated; structured actions route to respond, never bracketed-paste.
- `html` content is always written to the sandboxed file before render; no unsandboxed blob rendering.
- Unknown kinds / params / event names are ignored, never fatal.
