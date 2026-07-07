# 0038 — Mobile Mode as a transparent "user proxy" (hook-intercepted decisions)

## Status

**Proposed** (2026-07-07). Interactive-PTY gate **RESOLVED** (2026-07-07) — safe to build with a self-deadline, fail-closed hook (see Consequences → Resolved). Supersedes nothing; extends ADR-0037 (mobile input). Depends on ADR-0026 (Claude bind hook), ADR-0032 (control plane), ADR-0033 (artifact panel). Full plan: `docs/planning/mobile-mode.md`. UI spec: `docs/specs/mobile-mode-ui.md`.

## Context

ai-or-die's mobile web is a responsive collapse of a desktop terminal toolbar — the user hand-drives a raw xterm by touch (ADR-0037). We want a phone experience where the user treats the terminal as *read-only* and interacts through structured surfaces (conversation, decisions, input).

The naive approach — **screen-scrape Claude's rendered prompt and inject `y\n`** — was reviewed by 3 cross-lab peers + 3 code audits and **rejected**: it races a moving PTY (a tap can answer the *wrong/stale* prompt), can mis-parse a wrapped/ANSI-mangled destructive command, and the JSONL carries no structured tool-approval (a pending `Bash` is indistinguishable from a running one). So a structured, *deterministic* interception is required.

Key enabler: **`npx github-router claude` is always the launcher**, so github-router controls Claude Code's hooks.

## Decision

**ai-or-die + github-router act as a transparent "user proxy" around Claude.** Claude only ever sees its *native* channels (a tool result, or terminal stdin); it calls no panel API, spends no turn/token on panel lifecycle, and cannot tell a phone tap from a terminal keystroke. Surfaces pop **out-of-band** (hooks + sidecar render them) and human actions return via exactly two channels:

1. **Channel 1 — hook-return (blocking, structured).** github-router installs a blocking `PreToolUse`/`PermissionRequest` decision hook for `Bash|Write|Edit|ExitPlanMode|AskUserQuestion`. It captures the exact structured `tool_input`, registers a decision with ai-or-die (`POST /api/control/sessions/:id/decision`), **long-polls** while the human answers on a rendered surface (reuse `ArtifactClient.awaitEvents` + the artifact SSE/`data-aod` panel), and returns `permissionDecision: allow|deny` (or the chosen option). The tool is *paused* until it returns — no race, no screen-scrape, no keystroke replay.
2. **Channel 2 — idle-gated PTY injection.** Free-form input (composer, slash/mode) and non-blocking artifact comments are injected into stdin *as if typed*, gated on `detectTurnState → idle_at_prompt` (reuse `_pushArtifactFeedbackToAgent`), queued while busy; **interrupt is the one immediate injection**.

The conversation *read* surface is a new durable turn-stream over the JSONL (`readNewTurns` is a lossy tailer — a new cursor+epoch layer is required, not a thin reuse). Delivered as a **PWA** (reuses the existing Playwright/WebKit CI; native deferred as a same-API re-skin). **Wait for the human by default** (high hook `timeout`); only hold when a human client is connected; on true absence **fail closed (deny)**, never auto-allow.

## Consequences

**Positive**
- Deterministic + safe: the hook holds the exact command; no stale-prompt race, no mis-parsed approval, no `y\n` double-inject; plans render from structured `input.plan` in a *trusted* component (sidesteps the artifact-XSS/forged-approval path). Local inference is off the decision path entirely.
- Transparent: Claude spends zero orchestration tokens; the same API contract backs a future native shell.
- Mostly assembled: reuses github-router's hook-inject + allow/deny contract + `ArtifactClient`, and ai-or-die's `/await`+`/actions`+mobile panel + idle-gated PTY push.

**Empirical results (Phase-0 spike, `claude -p` + scratch proxy; interactive PTY NOT driven):**
- **Timeout fails OPEN** — a `PreToolUse` hook that overran its `timeout` was cancelled and the tool *still ran*. This confirms the design requirement: set `timeout` high (7200s was accepted) and **emit `deny` before the ceiling** — the host default is fail-open.
- **`permissionDecision:"ask"` under `--dangerously-skip-permissions` did not surface a prompt** (tool didn't run, error result) — so "fall back to the terminal prompt" is unreliable under bypass; prefer explicit `deny`.
- Multiple `PreToolUse` hooks **coexist, deny-wins, no deadlock**; a long `timeout` holds the tool cleanly (65s tested).
- Exact `tool_input` fields: `ExitPlanMode` → `{plan, planFilePath, allowedPrompts?}` (field is **`plan`**, not `planText`); `AskUserQuestion` → `{questions:[{question, header, multiSelect, options:[{label, description}]}]}` (options are **`{label, description}`**, no `value`). JSONL is append-only; auto-compact writes a same-file `compact_boundary` + summary continuation (no rotation in the sample).

**Resolved (interactive-PTY spike, 2026-07-07):**
- **Timeout fails open interactively too (confirmed).** A `PreToolUse` hook killed at its `timeout` lets the tool run. ⇒ the blocking hook MUST run its own watchdog and **self-return `deny` before the host ceiling** (and deny immediately when no viewer is connected) — never let Claude's timeout end the wait, since that ends it in *allow*. A high `timeout` (7200 accepted) buys the human time; the hook owns the deadline.
- **`ExitPlanMode` + `AskUserQuestion` each fire `PreToolUse` THEN `PermissionRequest`** with identical `tool_input` (`plan`; `questions[].{question,header,options[{label,description}],multiSelect}`). **Bind on `PreToolUse`** (earliest, before the decision UI).

**Negative / risks**
- Depends on Claude Code hook semantics (undocumented timeout ceiling; cross-repo github-router coupling).
- New durable turn-stream layer + auth/Origin/CSRF hardening on the phone-facing routes are real work (not reuse).
- Coverage gap: folder-trust and in-shell sub-prompts aren't hook-interceptable → raw-terminal fallback (rare).
