# Strategic proposal: re-found execution on the Claude Agent SDK (structured control plane)

> Status: **Proposal — awaiting decision** (2026-07-07). Supersedes the *decision plane* of ADR-0038 (the github-router hook + PTY-inject approach); keeps ADR-0038's surface/UX design. If accepted, becomes a new ADR that supersedes ADR-0038's mechanism.

## TL;DR

Swap ai-or-die's execution substrate from **node-pty running the Claude Code TUI** to the **Claude Agent SDK `query()` Streaming Input Mode with a `canUseTool` permission callback**. Structured becomes the **default**; the current pty/xterm becomes an opt-in `--tui` fallback. This retires the entire hook / screen-scrape / keystroke-inject plane (and eliminates the C1/I1/I2 race class by construction), and it re-founds ai-or-die's existing `/api/control` as the **unified control plane** of a first-class Claude Code web stack: **github-router (Copilot→Anthropic proxy + GitHub auth + tunnel) + Agent SDK engine + unified control plane + web portal**.

## How we got here

The mobile-mode effort built structured surfaces (conversation view, decision cards) over the terminal by intercepting decisions with a github-router hook and answering them by **injecting keystrokes into the PTY**. A 3-lab adversarial review confirmed a **Critical** in that mechanism (C1): the desktop answers out-of-band, so a phone tap can inject a keystroke into an already-advanced terminal and approve a command the user never saw. Raw injection is not a deterministic write. The user chose "structured card everywhere (default), `--tui` opt-out" and asked whether a structured agent mode (`--acp`/SDK) is the better foundation, and whether the result is really a unified control plane rather than a terminal wrapper.

## What the research found (3 independent streams, convergent)

1. **Claude Code capability (docs).** The **Agent SDK** `query()` Streaming Input Mode is the officially-documented interactive path: long-lived, multi-turn, free-form typing, `interrupt()`, `setPermissionMode()`, structured message stream. **`canUseTool(toolName, input, {toolUseID, suggestions, ...}) → {behavior:'allow', updatedInput, updatedPermissions?} | {behavior:'deny', message}`** is a structured permission callback that **pauses execution until resolved** — no terminal, no keystrokes. **ACP is a third-party wrapper over this same SDK** (no Anthropic `--acp`); skip it, use the SDK directly.
2. **ai-or-die architecture.** The conversation view (`turn-stream.js`, `/messages`), the decision store, and all of `/api/control/*` are **already structured and pty-independent**. Only the *execution/permission/input* path is terminal-coupled. Swapping it is a **bounded add** (~400–800 lines: a new `ClaudeSdkBridge` + a `canUseTool`→decision-store bridge) with a clean single-seam `--tui` fallback at `getBridgeForAgent('claude')`.
3. **claudecodeui (production proof).** `server/claude-sdk.js` uses **`canUseTool` in production** with a request-id/Promise-map → WebSocket round-trip → approve/deny cards. No pty, no injection, no `--permission-prompt-tool`, no MCP. It also proves: **refresh survival** (`chat.subscribe {sessionId, lastSeq}` replays a seq-ring **and returns pending permission requests**), a provider-agnostic `NormalizedMessage` schema, plan mode, "always allow" via `updatedPermissions`, and — decisively — that **`ANTHROPIC_BASE_URL` is forwarded to the SDK**, so a Copilot→Anthropic proxy (github-router) works unmodified.

## Proposed decision

Re-found the default execution path on the Agent SDK; keep pty as `--tui`.

- **Engine:** `@anthropic-ai/claude-agent-sdk` `query()` Streaming Input Mode, in-process in ai-or-die, one long-lived session per tab (mirrors the current per-tab model).
- **Permissions:** `canUseTool` → register a decision in the existing `decision-store` → the existing card renders on **every** surface (desktop + mobile) → first human answer resolves the promise with `{behavior}`. Deterministic; no PTY; **C1/I1/I2 cannot occur**. `suggestions`/`updatedPermissions` back "always allow"; `AskUserQuestion` routes through the same callback.
- **Events:** normalize the SDK `SDKMessage` stream (assistant text deltas, `tool_use`/`tool_result`, `thinking`, `system/init`) into the structured event stream the cards + conversation view already consume.
- **Model access / unified stack:** SDK → `ANTHROPIC_BASE_URL` = **github-router** proxy → Copilot. github-router stays as auth + proxy + tunnel. ai-or-die's `/api/control` is the **unified control plane** every surface (web, mobile, future native) speaks.
- **Retire:** the github-router decision/permission/tool-ran hooks and the PTY keystroke-inject answer path (superseded by `canUseTool`).

## Reuse vs. rebuild

| Reuse as-is | Build / change |
|---|---|
| `turn-stream.js`, `/messages`, decision-store, decision cards, all `/api/control/*` | New `ClaudeSdkBridge` (SDK `query()` session runtime) |
| Mobile-mode UI + surfaces, Origin hardening | `canUseTool` → decision-store bridge (pending-promise map keyed by `toolUseID`) |
| Sessions/persistence, devtunnel, Tailscale mesh, keep-awake, Windows ops | SDKMessage → normalized-event translation |
| github-router (now purely proxy + auth + tunnel) | Refresh-survival: `subscribe {sessionId, lastSeq}` + seq-ring + return-pending-permissions |
| Desktop app shell, WS gateway | Desktop structured card rendering (today desktop is xterm-only) + `--tui` bridge seam |

## Phasing

- **Phase 0 — de-risk (must pass before build):** confirm the SDK routes through github-router via `ANTHROPIC_BASE_URL` (Copilot auth intact); confirm the SDK session still writes/enables the structured transcript the conversation view reads (or feed SDK messages directly); fetch `agent-sdk/typescript.md` for exact `SDKMessage`/`PermissionResult` field shapes.
- **Phase 1 — MVP:** `ClaudeSdkBridge` + `canUseTool`→decision-store + normalized events → cards on desktop + mobile; free-form chat input; interrupt.
- **Phase 2 — parity + durability:** refresh survival (subscribe + seq-ring + pending-permission replay), "always allow" (`updatedPermissions`), plan mode, `AskUserQuestion`.
- **Phase 3 — `--tui` fallback + cleanup:** pty bridge behind `--tui`; delete the hook/inject plane; docs/ADRs.

## Risks / open questions

- **github-router ↔ SDK wiring (Phase-0 gate):** must confirm `ANTHROPIC_BASE_URL` + auth flow through github-router for the SDK exactly as for the CLI.
- **Transcript source:** does an SDK session still populate `~/.claude/projects/*.jsonl` (so `turn-stream` is reused), or must we drive the conversation view from the in-process SDK stream? Either works; decides the events wiring.
- **Permissive modes skip `canUseTool`:** in `auto`/`bypassPermissions`, `AskUserQuestion`/`ExitPlanMode` never reach the callback (SDK resolves earlier). If we want them under those modes, add a `PreToolUse` hook. Also: keep `default` mode as our default so cards actually fire; don't inherit a one-click "skip permissions" that silently bypasses the whole structured story.
- **Claude-only:** structured approval is an Agent-SDK capability, not a cross-CLI pattern (fine — we're Claude-first).
- **Feature deltas vs TUI:** the terminal's own permission menu + `/login` dialog go away (replaced by our cards = feature transfer); `AskUserQuestion` is unavailable inside subagents.

## What happens to the in-flight mobile-mode PRs

- **Carries forward:** decision-store, decision cards, `/api/control`, turn-stream, mobile UI, the Origin hardening, the artifact-panel height fix.
- **Superseded / retired:** the github-router `PermissionRequest`/`PostToolUse`/decision hooks and the ai-or-die PTY keystroke-inject answer path (the uncommitted increment-2 work). Not wasted — it built the decision store + cards and mapped the exact requirements; the substrate was wrong.

## Consequences

- **Positive:** eliminates the injection-race class; deterministic structured permissions; refresh-durable; simpler (no hook/scrape/inject); re-founds `/api/control` as a real unified control plane; a coherent "first-class Claude Code web" stack; native + desktop clients can speak the same contract later.
- **Negative:** a bounded but real new execution runtime; two execution paths to maintain (SDK default + pty `--tui`); Phase-0 unknowns must clear first; structured approval is Claude-specific.
