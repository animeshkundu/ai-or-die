# 0025 - Sticky Notes: expand-gated summarisation + ai-title tailing

## Status

Accepted (2026-06). Extends [ADR-0022](0022-local-llm-sticky-notes.md) /
[ADR-0024](0024-sticky-note-binding-resume.md). No conflict; it changes *when*
the model runs and *where* the tab title comes from.

## Context

ADR-0022/0024 summarised every eligible tab in the background regardless of
whether anyone was looking at the card. With LFM2-2.6B at ~7 s/inference on a
single shared worker and the feature on for terminal tabs too, that burns CPU /
battery for notes nobody is reading. We also wanted the card collapsed by
default and the tab title to stay fresh without flicker.

A three-lab review (gpt-5.5, gemini-3.1-pro, opus-4.7) of an initial
"expand=activate / collapse=freeze-the-binding" proposal converged on three
corrections that this ADR adopts:

1. Collapse is **per-browser** but the note is **server-side and shared** across
   viewers — so visibility must drive processing via a **reference count**, tied
   to connection presence (not just the UI toggle) to avoid a dropped browser
   leaking a forever-running inference loop.
2. "Freeze the binding on collapse" is wrong (opus): if claude `/resume`s while
   collapsed, a frozen binding re-summarises the *old* session on re-expand. The
   correct primitive is **collapsed = inert for inference; re-resolve the binding
   normally**. Per-tab isolation is already guaranteed by the ownership rule.
3. The **5/15/30-min title schedule is unnecessary** — claude already writes an
   `ai-title` into the JSONL; tail it (zero inference, restart-safe) instead.

## Decision

- **Card starts collapsed.** Expanding is a deliberate "activate".
- **Note inference runs only while ≥1 connected viewer is expanded.** Clients send
  `set_sticky_active {sessionId, active}` on expand/collapse, on active-tab
  switch, and on reconnect. The server keeps `_stickyActive: Map<sessionId,
  Set<wsId>>`; `_isStickyExpandedActive` gates the note path; the set is purged
  per-socket on disconnect (`_clearStickyActiveForWs` in
  `cleanupWebSocketConnection`). A collapsed tab freezes the note at
  `binding.offset`; on re-expand the next poll catches up in one bounded read.
  The activation auth accepts the socket's joined session OR connection
  membership (so a reconnect isn't dropped before the new socket re-joins).
- **The tab title is claude's `ai-title`, tailed with no model.**
  `StickyNoteJsonl.readNewAiTitle(file, offset)` walks the file with a SEPARATE
  always-advancing `binding.titleOffset` (forward-chunk, never skipping), and
  `_applyAiTitle` broadcasts it. This runs every poll regardless of collapse, so
  even a never-expanded tab keeps a fresh, self-describing title. Non-claude tabs
  (no `ai-title`) fall back to the note-derived title (expanded only).
- **Truncation safety.** If the bound file shrinks (truncated / rotated /
  recreated), the binding is dropped and re-resolved rather than freezing.

## Consequences

- No LLM inference burns for tabs nobody is viewing; titles stay fresh for every
  tab at ~zero cost. Per-tab isolation is unchanged (validated by a real-engine
  two-tab test: a quiet tab stays clean while the other session is the only one
  being appended).
- Two offsets per binding (`offset` for the note, `titleOffset` for the title).
  When expanded and synced they read the same delta twice (cheap file I/O, no
  double inference).
- The note can lag while collapsed and catches up on re-expand; a very long
  collapse is bounded by the recent-window read, so the catch-up is a single
  inference, not a replay.
- `set_sticky_active` is best-effort: a misbehaving client can at most cause a
  session it's connected to to summarise (bounded by the one shared worker); it
  cannot corrupt or cross-bind notes.
