# Mobile Mode — UI/UX Specification

**Status:** Design reference, approved 2026-07-07 (pre-implementation; backend wiring gated by the Phase-0 de-risking spike).
**Reference mock:** [`src/public/mobile-proto.html`](../../src/public/mobile-proto.html) — a self-contained, clickable, backend-free prototype of every surface below.
**Related:** ADR-0038 (mobile-mode architecture — the *transparent user proxy*), ADR-0037 (mobile input two-mode + flicker), ADR-0026 (Claude bind hook), ADR-0032 (control plane), ADR-0033 (artifact panel), `docs/planning/mobile-mode.md` (full plan), `docs/specs/mobile-input.md`, `docs/specs/plan-viewer.md`, `docs/specs/notifications.md`.

This spec captures **how** we want the mobile surfaces to look and behave, and **when** each one appears. It is the contract the production build implements; the mock is the visual source of truth.

---

## 1. Intent & the one rule

**North-star:** on a phone, the user treats the terminal as *read-only* and interacts through **structured surfaces** — a conversation to read, and structured controls to act. The raw xterm is demoted to a rarely-opened "raw output" tab.

**One vocabulary (do not scatter modal styles):**
- **Bottom sheet** — input, short decisions, questions. Grip handle, backdrop scrim, `dvh`-sized, safe-area padded, drag-to-dismiss, pinned above the keyboard.
- **Full-screen sheet** — long content (a plan, the raw terminal). Header with ✕, scroll body, sticky footer.
- **Right-side panel** — on iPad, sheets dock as a right panel (two-pane: conversation left) so context is preserved.
- **No center modals on phone** (out of thumb reach, fight the keyboard). Center modal is desktop-only.

---

## 2. WHEN — the trigger & return model (state machine)

Every surface is **popped out-of-band** (the infra renders it; the Claude instance never calls a panel API) and every human action returns to Claude through exactly **two channels**. See ADR-0038 for the transparent-user-proxy architecture.

| Surface | Pops when… (trigger) | Returns via | Blocking? |
|---|---|---|---|
| **Decision — tool permission** | a `PreToolUse` hook fires for `Bash`/`Write`/`Edit` (has the exact `tool_input`) | **Channel 1** — hook returns `allow`/`deny` | Yes (tool paused) |
| **Decision — plan** | `ExitPlanMode` hook (`PermissionRequest`/`PreToolUse`) | Channel 1 — `allow`/`deny` (+ comments via Ch.2) | Yes |
| **Decision — question** | `AskUserQuestion` hook (question + options) | Channel 1 — the chosen option | Yes |
| **Artifact / plan review** | a hook detects a reviewable artifact (e.g. `PostToolUse`), opens it via `ArtifactClient` — *not* Claude calling `artifact_open` | approve/reject → Ch.1; free-form comments → Ch.2 | Optional |
| **Input composer** | user taps the FAB, or a `waiting_input` event | **Channel 2** — idle-gated PTY injection (interrupt = immediate) | No |
| **Conversation view** | live via SSE/control `/events` | — (read-only) | No |
| **"Needs you" pill** | any pending blocking decision / `waiting_input` | — (affordance to open the pending surface) | No |

**The two return channels:**
- **Channel 1 — hook-return (structured, blocking):** the hook holds the tool, the human answers, the hook returns the decision. Claude sees a normal tool result.
- **Channel 2 — idle-gated PTY injection ("typed as the user"):** free-form input + non-blocking comments are injected into Claude's stdin *only when `idle_at_prompt`* (never mid-turn), queued while busy. **Interrupt (Ctrl-C/Esc) is the one immediate injection.**

**Precedence & concurrency:** one decision at a time; a pending blocking decision **preempts** queued input; if multiple stack, show a badge and resolve in order; **first client to answer wins** (phone or desktop), single resolution.

**Timeout / absence (see ADR-0038 §risks):** a present human is simply **waited for** (high hook timeout). Only hold the tool when a human client is connected; on true absence, **fail closed (deny)** — never auto-allow.

---

## 3. HOW — per-surface visual + interaction spec

### 3.1 Conversation view (primary read surface)
- **Header:** slim — `◄ session-name · mode ⋮`. Overflow `⋮` holds session actions.
- **Body:** scrollable message list: user messages; assistant text; **tool cards** that collapse to one line (`▸ Ran \`npm test\` ✓`, `▸ Edited auth.js +12/-3`) and **expand on tap** to show the full call/result. Thinking is a subtle collapsed block.
- **Status line:** `Claude idle` / `working…` / `waiting for you`.
- **Input bar:** persistent bottom bar (`Message…` + mic + send ⬆) that **expands into the composer sheet** on tap.
- **"● needs you" pill** appears when a decision is pending.

### 3.2 Decision — tool permission (bottom sheet, blocking) — *the safety-critical one*
- Slides up over a **dimmed** conversation; grip handle.
- `⚠ Claude wants to run` + the tool name.
- **Exact command** in a monospace, scrollable box (never truncated; scroll if long). `cwd` line beneath.
- **Fail-closed countdown** (`falls back in 45s`, animated) — makes the time-boxed hook legible.
- **`Show raw`** link (one tap to the raw terminal).
- Actions: **`[ Deny ]`** (safe default, left) **`[ Approve ]`** (right). For a **destructive** command, Approve is **red/destructive-styled and is not the default focus** — deliberate friction.

### 3.3 Decision — plan approval (full-screen sheet)
- Header `Plan — approve to start` + ✕.
- Scrollable **rendered plan** (headings, checklist, diff blocks) — the full plan (not a 300-char preview), from the hook's structured `input.plan`, rendered in a **trusted** component.
- Sticky footer: **`[ Reject ] [ Comment ] [ Approve ]`**. Comment routes as a Channel-2 note; Approve/Reject as Channel-1.

### 3.4 Decision — question (bottom sheet)
- The question text + **option cards**: radio (choose-one) or checkboxes + `Send` (multi-select). Options come structured from `AskUserQuestion`.

### 3.5 Input composer (bottom sheet)
- Multi-line textarea; a row of **structured controls**: slash `/`, mode toggle (plan/accept-edits), **Stop/interrupt**; mic + `Send`.
- **Keyboard-aware:** stays pinned above the soft keyboard via the `visualViewport` sync; the conversation scrolls behind.

### 3.6 Status / presence
- `● Claude needs you` pill (tappable → opens the pending surface); subtle haptic + optional chime when a decision auto-surfaces.

---

## 4. Per-screen adaptation

| Surface | Phone portrait | Phone landscape (keyboard eats height) | iPad | Desktop |
|---|---|---|---|---|
| Decision (tool/question) | bottom sheet | compact top banner + inline Approve/Deny | right-side panel | center modal (arrives via hook regardless of client) |
| Plan / artifact | full-screen sheet | slim overlay, scroll | right-side panel (two-pane) | existing artifact panel / side |
| Input composer | expanding bottom sheet | slim overlay above keyboard | docked bottom bar | terminal stays primary |
| Conversation | full-screen base | base behind overlays | left pane | mobile mode off by default |

---

## 5. iOS dimension toolkit (what makes the layout robust)

The **terminal** (fixed cols×rows, must re-fit on every keyboard/viewport change) is the worst dimension offender — demoting it is the structural fix. Primary surfaces are flow/flex HTML using:
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`.
- `env(safe-area-inset-*)` on every edge (notch / Dynamic Island / home indicator), captured as CSS vars (`--safe-top/-right/-bottom/-left`).
- `100dvh` / `100svh` for full-height containers — **never bare `100vh`** (it ignores the keyboard/toolbars on iOS).
- The **`visualViewport` API** (resize/scroll listeners → a `--keyboard-bottom` var) so bottom sheets and the composer stay above the keyboard.
- 44px min touch targets; system font stack; `prefers-reduced-motion` respected.

Validation: real iPhone over the mesh/tunnel (primary loop) + real-device cloud (BrowserStack/LambdaTest) for regression — **there is no iOS simulator on Windows**. See `docs/specs/mobile-input-verification.md` for the manual device checklist.

---

## 6. Interaction & safety principles (cross-surface)

- **Destructive friction:** red Approve, safe Deny default, Approve never the default focus; the exact command/args are **always shown** with one-tap `Show raw`. No inference/screen-scrape ever fabricates an approval target (ADR-0038).
- **Auto-surface:** a pending decision slides up on its own + a presence pill + haptic; a visible **fail-closed countdown**.
- **One at a time:** blocking decision preempts queued input; a badge if more stack.
- **Reachability:** primary actions in the bottom third; sheets are thumb-driven.
- **Accessibility:** 44px targets, dynamic type, VoiceOver labels, `role="dialog"`/`aria-modal`, focus trapping in sheets.

---

## 7. The reference mock

`src/public/mobile-proto.html` — self-contained (inline CSS/JS, no backend, no external deps). To view: serve `src/public` on a port and open on the device (LAN or over a dev tunnel / mesh) — e.g. `http://<lan-ip>:<port>/mobile-proto.html`.

A **dev trigger toolbar** (bottom, dismissible) exposes every state for on-device review:
- Permission sheet · **destructive⇄safe command** toggle · Plan sheet · Question (radio + multi-select) · Composer sheet · **iPad/desktop layout** toggle.

The mock is the **visual/interaction source of truth**; it is a design reference, not production. The production build wires these surfaces to the backend per `docs/planning/mobile-mode.md` and ADR-0038.

---

## 8. Not-yet-designed (open, to settle in the device loop)

Empty / loading / error / offline states; reconnect + stale-decision UI; landscape refinements; iPad two-pane details; light theme; exact microcopy; haptic/sound choices; multi-session switcher (mobile drawer). These are deliberately deferred to on-device iteration and the MVP phase.
