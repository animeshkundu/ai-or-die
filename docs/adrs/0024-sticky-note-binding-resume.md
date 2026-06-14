# 0024 - Sticky-Note Binding: sessionId-keyed durable notes, ownership & resume

## Status

Accepted (2026-06). Refines the per-tab JSONL binding introduced in
[ADR-0022](0022-local-llm-sticky-notes.md). No conflict with ADR-0022/0023; this
hardens *which* transcript a tab summarises and makes notes durable.

## Context

ADR-0022 v2 bound each tab to "the newest `*.jsonl` in the tab's project dir".
That is correct for one claude session per project but wrong otherwise, and the
note lived only on the ai-or-die tab (lost when the tab closed). Concretely:

- **Subagent logs leak in.** Subagents write `agent-*.jsonl` into the same project
  dir; "newest" could bind a tab to a subagent transcript.
- **Two tabs, one project collide.** Both tabs chase the same newest file and
  cross-contaminate each other's note.
- **No resume.** Closing/reopening a tab, `claude --resume`, an in-session
  `/resume`, or a server restart all started the note over, even though claude
  appends to the SAME `<sessionId>.jsonl` (verified: a real session spans 24.5h in
  one file across a 4.8h gap — resume continues the same log).

The durable identity is the **claude sessionId = the JSONL basename** (the
`--resume` key; also each line's `sessionId` field). Two empirical facts shaped
the design: claude keeps its JSONL handles open (so PID↔file correlation is
*possible* on POSIX) and exposes a `--session-id` flag — but ai-or-die does not
launch claude (the user types `github-router claude`), so neither is usable as
the primary mechanism. The binder therefore infers from the filesystem.

## Decision

Bind each tab to the claude session whose transcript is the active, **unowned**
writer in the tab's project dir, and key notes by claude sessionId:

- **Exclude `agent-*.jsonl`** in `findActiveSessions` (returns non-agent
  transcripts newest-mtime-first with `{file, mtimeMs, size, sessionId}`).
- **Per-tab ownership.** `_ownedClaudeSessions` is the set of sessionIds bound by
  OTHER tabs; a tab never binds an owned session. Two tabs in one project get
  distinct sessions; the poll's single-flight lock + sequential per-tab sweep make
  ownership assignment race-free within a tick.
- **Stay while active; follow `/resume` only when quiet.** A tab keeps its binding
  while the file grows. It moves to a newer unowned session only after its own has
  been quiet for `_stickyResumeIdleTicks` (default 8 ≈ 16s) — so a third, unrelated
  session can NOT steal an actively-working tab. Incomplete trailing lines (claude
  mid-write / killed) count as quiet (and never reset `idleTicks`), so a dead
  session can still yield.
- **Durable, resumable notes.** `_claudeNotes` (claudeSessionId → note, capped 300
  by `updatedAt`) is written on every result and rebuilt on load from each
  session's persisted `stickyClaudeSessionId`. Binding a session with a stored note
  resumes it (seeded into the summariser via `onRebind` + shown on the card) and
  continues from a cached byte offset (`_claudeOffsets`, in-memory) to avoid
  re-summarising the recent window.
- **Mid-inference rebind is safe.** The summariser captures the bound sessionId at
  inference start (`cidAtStart`) and tags the result. A result that lands after a
  rebind is persisted to the OUTGOING session's durable note (lossless), never the
  new session's; `onRebind` also drops the previous session's un-summarised turns
  so they can't bleed across.
- **Toolbar toggle gated on readiness.** `#stickyNoteBtn` shows only when the
  server reports engine status `ready` (not merely when the feature is enabled), so
  no dead control appears under Bun / missing-model / CI; the client requests
  status on connect so a reload learns `ready`.

## Consequences

- A foreign claude (a different *host app*) running in the SAME project dir is
  excluded only heuristically (it would appear unowned). The exact fix —
  PID-write-handle correlation (POSIX `lsof`) or `--session-id` if ai-or-die ever
  launches claude — is deferred; the active-writer + ownership heuristic covers the
  in-app cases. Concurrently resuming ONE session into two tabs is unsupported
  (claude itself conflicts).
- `_claudeOffsets` is not persisted: a server restart re-reads the recent window
  once (the update-dedup absorbs any near-duplicate).
- New per-session persisted field `stickyClaudeSessionId`; `_claudeNotes` /
  `_claudeOffsets` are capped to bound memory.
- Verified by unit tests (ownership, agent skip, resume, stale-result routing,
  no-theft / follow-on-idle, cap) and a real-engine end-to-end run that accumulates
  a note, closes the tab, resumes it in a new tab, and keeps evolving.
