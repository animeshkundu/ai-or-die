# Spec: Per-Tab Sticky Notes & Auto Tab Titles

Local-LLM session summaries. See ADR-0022 for rationale.

## Components

| File | Role |
|------|------|
| `src/sticky-note-engine.js` | Lazy model download + worker-thread inference; serialised request queue; graceful degrade (`MODULE_NOT_FOUND` / missing model / crash → `unavailable`). Mirrors `stt-engine.js`. |
| `src/sticky-note-worker.js` | Worker thread. Dynamic-imports ESM `node-llama-cpp`, loads the GGUF, answers `{type:'infer'}` with JSON-schema-grammar-constrained output. |
| `src/sticky-note-summarizer.js` | Off-hot-path scheduler. Per-session headless transcript + deterministic triggers + guards. Emits results via `onResult`. |
| `src/sticky-note-transcript.js` | Per-session `@xterm/headless` wrapper. `write()` raw PTY bytes, `snapshot()` the recent rendered lines. |
| `src/sticky-note-prompt.js` | `SYSTEM_PROMPT`, `NOTE_SCHEMA`, `buildPrompt()`, `parseNote()` (clamp + sanitise). |
| `src/utils/secret-redact.js` | `redactSecrets()` — ReDoS-safe (linear); strips keys/tokens/PEM/env/long-blobs from BOTH the model input and the model output. |
| `src/utils/gguf-model-manager.js` | Single-file GGUF download (resume, size/sha verify, disk precheck). |
| `src/public/sticky-note-card.js` | Floating per-tab card; `textContent`-only rendering. |
| `src/public/components/sticky-note.css` | Card styling. |

## Data flow

```
PTY bytes → server onOutput → summarizer.feed(sessionId, chunk)   [hot path: buffer + timers only]
  → @xterm/headless (per session) → snapshot recent rendered lines → redactSecrets
  → engine.infer(prompt) [worker] → JSON {title,goal,progress[],waitingOn[]}
  → session.stickyNote (persisted) → broadcastToSession('sticky_note_update') → client card + tab title
```

## Update triggers (deterministic)

An update = one inference, attempted only when ALL gates hold: feature enabled
for the session · eligible tab (AI-agent OR terminal — `_isStickyEligible`) ·
model `ready` · breaker closed · new committed output since last summary ·
`minInterval` satisfied · not already running.

Triggers: **quiet** (~4s idle), **volume** (~80 committed lines / ~6 KB),
**max-staleness** (~90s pending), **session-exit** (final flush, bypasses
minInterval), **initial**, **focus** (foreground transition, gated). Tab switch
/ reconnect are render-only.

Guards: `minInterval = max(20s, 3 × lastInferenceMs)`; single-flight + dirty-bit
(timeout clears the bit + backs off — no retry-storm); circuit breaker after N
failures; foreground-first fair dispatch over one shared worker; thread cap
`min(4, cores-2)`.

## Data shapes (v2)

```js
session.stickyNote = {
  title,                       // ai-title (claude) or derived from goal
  goal,                        // refined each turn
  done[/*≤5*/], remaining[/*≤5*/],   // refined each turn (was progress/waitingOn)
  updates: [ { text, at } ],   // APPEND-ONLY, newest-first, cap 25
  updatedAt, rev, status, error
}
session.autoTitle = string|null        // last title (suppressed once user renames)
session.nameIsUserSet = boolean         // manual rename pins the tab name
session.stickyNotesEnabled = boolean    // server-authoritative; persisted
```

Input source: claude's session JSONL (`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`,
read via `src/sticky-note-jsonl.js`, bound per-tab by a 2s poll in `server.js`) — clean
user/assistant turns, not the Ink-TUI scrape. Plain shells fall back to the rendered-output
scrape (`@xterm/headless`). Legacy notes migrate on load (`progress→done`, `waitingOn→remaining`).

### Binding & resume (`_pumpStickyJsonl`, ADR-0024)

A tab binds to the claude session transcript for its `cwd`, keyed by **claude
sessionId** (the JSONL basename / `--resume` key), so notes are durable and resume:

- **Skips `agent-*.jsonl`** subagent logs (`findActiveSessions`).
- **Per-tab ownership:** a tab never binds a session already owned by another tab,
  so two claude tabs in one project keep separate notes.
- **No theft:** a tab stays on its session while it is being written; it only
  follows an in-session `/resume` to a newer session after its own has been quiet
  for `_stickyResumeIdleTicks` (default 8) — incomplete trailing lines count as
  quiet so a killed session can still yield.
- **Durable notes** live in `_claudeNotes` (claudeSessionId → note, capped 300),
  mirrored on every result and rebuilt from persisted `session.stickyClaudeSessionId`
  on restart. Binding a session with a stored note resumes it (seeded into the
  summariser + card) and continues from the cached read offset (`_claudeOffsets`).
- **Mid-inference rebind safety:** the summariser tags each result with the
  sessionId captured at inference start; a result that arrives after a rebind is
  persisted to the OUTGOING session's note, never the new one.

The toolbar toggle (`#stickyNoteBtn`) is shown only once the engine reports
`ready` (not merely when enabled), so it never appears when the model can't run.

## WebSocket protocol

Server → client:
- `sticky_note_update { sessionId, stickyNote, autoTitle }` — `autoTitle` is null when the user renamed the tab. Client drops updates with `rev` ≤ last applied.
- `sticky_notes_model_progress { file, downloaded, total, percent }` — drives the download banner.
- `sticky_notes_status { status, progress }`.
- `session_joined` carries `stickyNote`, `autoTitle`, `stickyNotesEnabled` for hydration.

Client → server:
- `set_sticky_notes { sessionId, enabled }` — server-authoritative enable/disable.
- `set_tab_name { sessionId, name }` — sets `nameIsUserSet` so auto-titles stop overriding.

## Configuration

| Flag / env | Effect |
|------------|--------|
| `--no-sticky-notes` / `STICKY_NOTES_DISABLED=1` | Disable globally. |
| `--sticky-notes-model-dir <path>` / `STICKY_NOTES_MODEL_DIR` | Model cache dir. |
| `--sticky-notes-model <url>` / `STICKY_NOTES_MODEL` | Override the GGUF URL (e.g. the lighter `LFM2-1.2B-Q4_K_M.gguf`). |
| `--sticky-notes-threads <n>` / `STICKY_NOTES_THREADS` | Inference CPU threads. |
| Settings → Display → "Session sticky notes & auto-titles" | Per-client on/off (sent to server). |

## Model

Default: `LiquidAI/LFM2-2.6B-GGUF` → `LFM2-2.6B-Q4_K_M.gguf` (~1.56 GB,
**SHA-256-pinned** — refuses a swapped same-size file), `contextSize` 8192. The
cache (`~/.ai-or-die/models/`) is excluded from the disk-quota breaker. Same
file on Windows + macOS. Chosen by a bake-off over real claude JSONL transcripts
(see ADR-0023): it produces concrete, forward-looking Goal/Done/Remaining with
zero empty updates, where Gemma 3 1B gave snake_case/frozen bullets and ~35%
empty updates. `LFM2-1.2B` is the lighter ungated alternative (~731 MB, ~half the
latency) via `--sticky-notes-model`.

## Degradation

If `node-llama-cpp` is absent, the model fails to download, or the arch is
unsupported, the engine reports `unavailable`, no card appears, and the terminal
path is unaffected. Inference errors/timeouts never propagate into the PTY path;
a failed summary is retried after backoff (never stranded) and repeated failures
open a per-session circuit breaker.

**Runtime: Node.js only.** The feature is force-disabled under Bun
(`server.js` `!isBun()` + `StickyNoteEngine._doInitialize` self-gate →
`unavailable` / `_lastSpawnError='BUN_UNSUPPORTED'`), because node-llama-cpp's
native N-API addon crashes Bun (exit 133). Bun runs with **limited support** for
the app overall — it continues to run, but node-pty can't read the PTY master
under Bun (oven-sh/bun#25822) so the terminal may hang; `bin/ai-or-die.js` prints
a startup notice (continuing with sticky-notes disabled) recommending `node` for
a working terminal. STT still runs under Bun. See ADR-0022 +
`docs/history/sticky-notes-2026.md`.

Known limitation: cancelling a session (tab close / eviction) while an inference
is in flight does not abort the native call — the worker finishes that one
inference and the summariser discards the result (the session state is gone).
node-llama-cpp has no cooperative cancel wired in; this wastes at most one
inference cycle on the single shared worker.
