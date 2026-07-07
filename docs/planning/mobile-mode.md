# Mobile Mode — implementation plan (persisted)

> Persisted 2026-07-07 from the approved planning session. Companion docs:
> **ADR-0038** (`docs/adrs/0038-mobile-mode-transparent-user-proxy.md`) — the decision;
> **UI spec** (`docs/specs/mobile-mode-ui.md`) — how/when the surfaces look & behave;
> **Reference mock** (`src/public/mobile-proto.html`) — the clickable prototype.
> Status: approved; **Phase 0 (de-risking) gates the build.** Empirical hook-spike results are recorded in ADR-0038 (timeout fails open under `-p`; two interactive unknowns remain).

---

## Context

ai-or-die's mobile web hand-drives a raw terminal. **North-star:** the user treats the terminal as read-only and interacts through structured surfaces — a **conversation view**, an **input panel**, a **decision panel**, and the **artifact/plan panel** — and it all "just works" without the Claude instance ever orchestrating a panel or being able to tell a phone from a terminal user.

**Unifying principle — the transparent user proxy.** `npx github-router claude` is *always* the launcher, so github-router (hooks) + ai-or-die (sidecar) sit around Claude and impersonate the terminal user. Claude only ever sees its **native channels** — a tool result, or terminal stdin. The panels are client-side renders of state the infra already holds; the human's action returns through two channels:

- **Channel 1 — Hook-return (blocking, structured).** For decisions Claude is paused on (tool-permission, `ExitPlanMode`, `AskUserQuestion`). A `PreToolUse`/`PermissionRequest` hook holds the tool, the panel pops, the human answers, the hook returns `allow`/`deny`/the choice.
- **Channel 2 — Idle-gated PTY injection ("typed as the user").** For the input panel + non-blocking artifact comments. Injected into stdin gated on `detectTurnState → idle_at_prompt` (reuse `_pushArtifactFeedbackToAgent`), queued while busy. **Interrupt (Ctrl-C/Esc) injects immediately.**

This replaces the earlier screen-scrape + `y\n` design that a 3-lab peer review + 3 code audits rejected, and removes Claude from the panel lifecycle (no `artifact_open`/`await` MCP calls for the transparent path).

## The four surfaces (how it pops, how it returns — all transparent)
| Surface | Pops (out-of-band trigger) | Returns to Claude | Blocking? |
|---|---|---|---|
| Decision (tool-permission / plan / question) | `PreToolUse`/`PermissionRequest` hook with structured `tool_input` | Channel 1 — `allow`/`deny`/choice | Yes |
| Artifact / plan panel | a hook detects a reviewable artifact and opens it via `ArtifactClient` (not Claude) | approve/reject → Ch.1; comments → Ch.2 | Optional |
| Input panel | FAB tap / `waiting_input` | Channel 2 (interrupt immediate) | No |
| Conversation view | live via SSE/`/events` | — read-only | No |

## Architecture — decision round-trip (Channel 1)
- **github-router**: new blocking `internal-decision-hook` (template = `internal-worker-guard` + `internal-artifact-open` + `ArtifactClient`), registered on `PreToolUse`/`PermissionRequest` for `Bash|Write|Edit|ExitPlanMode|AskUserQuestion` (generous `timeoutSec`, gated on `AIORDIE_SESSION_ID`).
- **ai-or-die**: `POST /api/control/sessions/:id/decision` (register + long-poll) returns a structured `{choice,optionValue}` *directly to the hook*; render via artifact SSE/panel/`data-aod` with a **trusted** decision-packet component (not arbitrary agent HTML).
- **Channel 2** reuses `{type:'input'}`/control `/message` + the `idle_at_prompt` gate + a queue.

## Sharp risks (design + verify)
1. **Wait for the human by default; fail closed, never open.** High host `timeout` (hours) so a present human answers in time. Guards: (i) only hold when a human client is connected — else apply a safe default (deny destructive), so unattended runs never wedge; (ii) on true absence, emit **`deny`** before the host ceiling. The current fallback silently **auto-allows** under `--dangerously-skip-permissions` — that becomes fail-closed. *(Phase-0: confirmed timeout fails open in `-p`; interactive unverified.)*
2. `"allow"` doesn't override `ask`/`deny` rules — audit github-router's rule set.
3. Exact `tool_input` field names — *resolved:* `ExitPlanMode.{plan, planFilePath, allowedPrompts?}`, `AskUserQuestion.questions[].{question, header, multiSelect, options[{label, description}]}`.
4. Channel-2 injection strictly `idle_at_prompt`-gated + queued; interrupt is the only immediate injection; a pending Ch.1 decision preempts queued input.
5. Auth/Origin/CSRF on the phone-facing routes + WS (none today; `?token=` widens leakage). Header bearer for mobile.
6. Conversation READ view is a new stateful layer — `readNewTurns` is a lossy byte-tailer; need durable cursor+epoch, semantic items, dedup, reset-on-`/compact`·`/resume`.
7. Coverage: folder-trust + in-shell sub-prompts not hook-interceptable → raw-terminal fallback (rare).

## Phasing
- **Phase 0 — De-risking (gates the build).** Hook spike (mostly done — see ADR-0038; **needs a true interactive-PTY follow-up** for timeout-fail-open + plan/question event routing) + a clickable UI prototype on the real iPhone (done: `src/public/mobile-proto.html`).
- **MVP.** Channel-1 decision round-trip (tool-permission + plan + question) with fail-closed budget + trusted decision cards; Channel-2 input panel + immediate interrupt (idle-gated); conversation read view; Origin/CSRF hardening.
- **Fast-follow.** Artifact/plan panel hook-popped + comment injection; single-FAB IA; async local-inference *enrichment* (never decisions).

## Critical files
- **github-router**: new `src/internal-decision-hook.ts` + `buildDecisionHookCommand` (`src/lib/orchestration/stop-gate-hook.ts`) + registration in `src/claude.ts`; reuse `worker-dispatch.ts` contract, `plan-html.ts`/`first-mate/decision-packet.ts`, `ArtifactClient`.
- **ai-or-die**: `POST /decision` (`src/control/routes.js`/`src/artifact-review.js`); reuse artifact SSE/panel/`data-aod`; Channel-2 reuse `_pushArtifactFeedbackToAgent` + `detectTurnState`; Origin/CSRF in `src/server.js`; new turn-stream module + `GET /sessions/:id/messages` (`sticky-note-jsonl.js` `readNewTurns` = raw-line source only).
- **Client** (gated on `body.is-mobile`/`detectMobile()`): decision cards, input panel, conversation view, mobile IA (`src/public/index.html` + `mobile-mode.css`); reuse `artifact-panel.js` SSE/`data-aod`, `key-encoder.js`, `session-manager.js`.

## Verification
- Playwright WebKit (real backend + PTY): decision card shows exact command → Approve→`allow`→runs; Reject→`deny`→cancelled; timeout → **fail-closed, never auto-allow**; phone+desktop → first-answer-wins; input injects only when idle; interrupt immediate; turns render with stable ids + collapsible tool cards.
- Security: cross-origin POST to `/decision` rejected; WS foreign Origin rejected.
- Turn stream: cursor epoch/reset on `/compact`; partial-JSONL replay; offline-past-window catch-up.
- **iOS from Windows** (no simulator exists): real iPhone over mesh/tunnel (primary dimension loop) + real-device cloud (BrowserStack/LambdaTest) regression + Playwright WebKit (logic). Dimension strategy: demote the terminal; `viewport-fit=cover` + `env(safe-area-inset-*)` + `100dvh/svh` + `visualViewport` + `interactive-widget=resizes-content`.
- Cross-lab re-review of the blocking-hook + timeout design before shipping.

## Out of scope / deferred
- Native iOS app (same API ⇒ future re-skin). Happy integration (`.docs/research/happy/`). Background push (installed-PWA web-push). Local inference as a synchronous structurer.

## Tangential
- **Artifact panel — remove the height cap** (`components/artifact-panel.css:12` `max-height:80vh`; phone `:305-306`; resize clamp `artifact-panel.js:211-212`) → grow to full viewport height, `_clampToBounds`-fitted, keep `MIN_W`/`MIN_H`.
