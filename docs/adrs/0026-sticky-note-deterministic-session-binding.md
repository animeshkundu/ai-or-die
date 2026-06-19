# 0026 - Sticky-Note Deterministic Session Binding via github-router's SessionStart hook

## Status

Accepted (2026-06). Supersedes the deferred `--session-id` consequence of
[ADR-0024](0024-sticky-note-binding-resume.md). ADR-0024's newest-mtime inference is
retained as a FALLBACK only; the primary binding is now deterministic.

## Context

ADR-0024 bound each tab to a claude transcript by scanning the tab's project dir
(`~/.claude/projects/<cwd-slug>/`) and choosing the newest-mtime, unowned `.jsonl`. The
project dir is derived from `cwd = session.liveCwd || session.workingDir`.

In the primary real-world setup the user runs `npx github-router@latest claude` inside an
ai-or-die **Terminal** tab (github-router launches the real claude CLI against GitHub
Copilot APIs). For terminal tabs `liveCwd` is populated only from OSC 7, which `cmd.exe`
cannot emit and which otherwise needs a prompt hook. When `liveCwd` is null, every tab
falls back to the same folder-mode `workingDir` base, all scan one project dir, and the
newest-mtime heuristic hands every tab whichever single session is actively growing — so
multiple tabs surface the same session's note/title (the reported bug). ADR-0024 itself
named the fix and deferred it: "`--session-id` if ai-or-die ever launches claude". ai-or-die
still doesn't launch claude on this path, but github-router does, and the user owns it.

The user also relies on in-session `/resume` frequently and `/clear` occasionally, so any
binding must be auto-maintained across those transitions, not frozen at launch.

## Decision

Make **claude itself** the authoritative source of the active session, surfaced over a
per-tab **sidecar file**, and bind by exact transcript path:

- **github-router** registers a Claude Code `SessionStart`/`SessionEnd` hook (reusing its
  existing `injectStopHookIntoSettingsFile` machinery) whenever `AIORDIE_CLAUDE_BIND` (a
  per-tab sidecar path) is present in its env. The hook (`internal-session-bind`) reads the
  hook payload and atomically writes `{schema, claudeSessionId, transcriptPath, cwd, event,
  source?, reason?, at}` to that sidecar on every startup / `/resume` / `/clear` / `/compact`.
  `transcriptPath` is realpath-resolved to the real `~/.claude/projects/...`. The hook
  **skips subagent/teammate payloads** (`agent_id`/`agent_type`) so only the tab's top-level
  session drives the binding. github-router **strips `AIORDIE_CLAUDE_BIND`** from the env it
  passes to claude (the sidecar path is baked into the hook command, not the env), so a
  nested `github-router claude` can't hijack the parent tab.
- **ai-or-die** sets `AIORDIE_CLAUDE_BIND` = `<dataDir>/claude-bindings/<sessionId>.json` in
  every Terminal tab's shell env (via a new `base-bridge` `extraEnv` option). In
  `_pumpStickyJsonl`, when a sidecar exists it is AUTHORITATIVE: bind the tab directly to
  `transcriptPath` by exact path (no cwd, no mtime), rebinding when `claudeSessionId` changes.
  A stale sidecar is cleared on each terminal (re)start; pinned ids are reserved in
  `_ownedClaudeSessions`; `claudePinnedSessionId` is persisted; orphan sidecars are swept on
  startup and removed on tab close.
- **Fallback:** tabs with no sidecar (claude launched without github-router) keep ADR-0024's
  newest-mtime inference, so that path is regression-free.

The cross-repo contract is one env var (`AIORDIE_CLAUDE_BIND`) plus the versioned sidecar
JSON `schema`.

## Consequences

- The reported bug is fixed structurally: each tab binds the exact transcript its own claude
  reports, independent of cwd, mtime, shell, or OSC 7 availability (works on `cmd.exe`).
- `/resume`, `/clear`, `/compact`, and exit→relaunch are first-class (the hook fires on each,
  reporting the now-active session). No `--session-id` forcing, so no argv-grammar fragility.
- No phantom pin: a tab is bound only after claude actually reports a session, so a failed
  launch or an old claude without SessionStart simply leaves the tab on the fallback.
- Depends on github-router's `projects` mirror entry staying SHARED (a junction to the real
  `~/.claude/projects`); if it ever becomes ISOLATED, ai-or-die's reads would need the mirror
  path. The hook realpath's the transcript so reads don't depend on the per-launch junction
  surviving github-router shutdown.
- Two binding codepaths (sidecar + inference fallback) are maintained; both are unit-tested.
- Load-bearing assumption verified against Claude Code docs and tested: subagent/teammate
  SessionStart payloads carry `agent_id`/`agent_type` (env-strip is the backstop).
