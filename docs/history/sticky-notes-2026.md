# Sticky Notes (local-LLM session summaries) — build notes, 2026-06

Implementation of the per-tab local-LLM "sticky note" + auto tab title feature
(ADR-0022, spec `docs/specs/sticky-notes.md`). Gotchas worth remembering:

## v2: summarize from the claude JSONL transcript, not the terminal

The v1 input (scrape the rendered terminal) produced garbage for `github-router claude`:
`claude` is an **Ink (React-for-CLI) TUI** that repaints in place, so the line-feed/quiet
triggers rarely fire and a snapshot catches the input box, not the conversation
(symptom: "Goal: Update"). The real input/output is on disk — `github-router claude` runs
the normal claude CLI with `CLAUDE_CONFIG_DIR=$HOME/.claude`, so each session writes
`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, a **complete structured** transcript
(the `--resume` source). v2 summarises THAT.

- `src/sticky-note-jsonl.js`: `findActiveSession(cwd)` (newest `.jsonl` for the cwd's
  project slug), `readNewTurns(file, offset)` (tails from a byte offset; keeps user/assistant
  `text` + `tool_use` names; skips `thinking`/`tool_result`/metadata/`isSidechain`; strips
  injected `<task-notification>`/`<system-reminder>` blocks; never advances past an incomplete
  trailing line), `ai-title` lines give the tab title for free. `AIORDIE_CLAUDE_PROJECTS_DIR`
  overrides the dir for tests.
- Correlation: a 2s poll (`server.js _pollStickyJsonl`) maps each summarising tab's
  `liveCwd||workingDir` → its active JSONL and feeds turns via `summarizer.feedTurns()`
  (JSONL mode; raw `feed()` is then ignored). Plain shells with no JSONL keep the scrape
  fallback. Bindings cleaned up on disable/exit/shutdown.
- Note model is now incremental + append-only: `{goal, done[], remaining[], updates[{text,at}]}`
  (`progress`→`done`, `waitingOn`→`remaining`). Each turn refines goal/done/remaining and
  **prepends** one `update` (newest-first, capped 25). `_onStickyNoteResult` merges (keeps the
  prior value when a weak gen returns an empty field). Legacy notes migrate on load
  (`session-store.migrateStickyNote`).

## v2 UI: minimized by default, toggle from the toolbar

The minimized card was a floating "+" chip in the terminal corner. v2: the card is **hidden
when collapsed** (default minimized) and a toolbar button (`#stickyNoteBtn` in `.tab-actions`,
by the mic) toggles it + shows a per-tab status dot (`onStateChange` → `_updateStickyNoteBtn`).
The expanded floating card is unchanged. The card renders Goal / Done / Remaining + a
scrollable Updates log (newest on top). Per-tab badge must not leak across tabs (updated in
`notifyActiveSessionChanged`). `Ctrl/Cmd+Shift+N` toggles.

## Gemma 4 is NOT loadable on the current node-llama-cpp prebuilt

We standardised on Gemma 4 E2B, then validated empirically before committing:

- `node-llama-cpp@3.18.1` (latest, published 2026-03-17) bundles llama.cpp
  **b8390**. Its `src/llama-arch.cpp` registers `gemma / gemma2 / gemma3 /
  gemma3n / gemma-embedding` — **no `gemma4`**. Gemma 4 shipped ~2026-04-02,
  after b8390.
- llama.cpp **master** *does* have `gemma4` + `gemma4-assistant`, so a future
  node-llama-cpp release will support it.
- Verdict: v1 shipped **Gemma 3 1B (Q4_K_M)**; a later bake-off (ADR-0023)
  switched the default to **Liquid LFM2-2.6B (Q4_K_M)** for much better
  Goal/Done/Remaining quality. The model stays configurable via
  `--sticky-notes-model`, so any ungated GGUF (incl. Gemma 4 E2B once the
  binding registers `gemma4`) remains a one-line swap.

How to re-check: install node-llama-cpp, `getLlama().llamaCppRelease.release`
gives the bundled tag; `curl raw.githubusercontent.com/ggml-org/llama.cpp/<tag>/src/llama-arch.cpp | grep -i gemma`.

## Google's Gemma GGUF repos are GATED

`google/gemma-3-1b-it-qat-q4_0-gguf` returns HTTP 401 anonymously (license
gate). A silent on-by-default download can't use it. We use the ungated
`ggml-org/gemma-3-1b-it-GGUF` (`Q4_K_M`, ~806 MB) instead. QAT `q4_0` would be
slightly better quality-per-byte but needs a HF token.

## Quantisation is platform-independent; avoid the dead ARM variants

One GGUF file works on Windows + macOS — node-llama-cpp ships the per-OS backend
binary (the bundled binary reports `MTL`+`NEON`+`REPACK`). Do **not** use the
deprecated `Q4_0_4_4` / `Q4_0_8_8` ARM-packed variants — removed from current
llama.cpp; plain `Q4_0`/`Q4_K_M` are runtime-repacked for the host ISA.

## Raw PTY bytes are NOT a transcript

Carriage-return spinners and alt-screen redraws mean regex-stripping ANSI leaves
duplicated garbage ("Thinking…Thinking…Thinking…"). Replay through
`@xterm/headless` and read rendered lines instead (`onLineFeed` gives a clean
committed-line count immune to CR redraws; this also fixes split multi-byte
UTF-8).

## Test determinism: don't mix a fake clock with real async

The summariser tests use a fake clock + injected timers. xterm's real
write-callback made them flaky, so the transcript is **injectable** — scheduler
tests use a synchronous `FakeTranscript`, leaving only microtask draining (one
`setImmediate` await fully drains a microtask-only chain). Engine tests inject a
`FakeWorker` (EventEmitter) so node-llama-cpp need not be installed.

## CPU-only laptops: no retry-storm

A 1B model on CPU can be slow. The scheduler measures each inference and sets
`minInterval = max(20s, 3 × lastDurationMs)`; a timeout clears the dirty bit and
backs off (never an immediate re-queue), and N consecutive failures open a
circuit breaker. Thread cap `min(4, cores-2)` keeps xterm/WebSocket responsive.

## The model cache vs the disk-quota breaker (would brick the app)

The server has a 1GB disk-quota circuit breaker on `~/.ai-or-die/` (DISK-03)
that **blocks session creation** when tripped. The model cache lives under
`~/.ai-or-die/models/` and an 800MB GGUF (or 670MB STT model) trips it — so
on-by-default model downloads would break every session. Fix: `_sampleDiskUsage`
now **excludes `models/`** from the quota (a one-time intentional download is
not the runaway session-data growth the breaker guards). STT had this latent
bug too, masked only by being off-by-default.

## Bun is not a supported runtime (terminal hangs + node-llama-cpp crashes)

Symptom reported: on the `feat/sticky-notes` branch, `bun bin/ai-or-die.js …`
boots, a terminal "starts successfully", but **no shell prompt ever appears** —
the terminal hangs. `node bin/ai-or-die.js …` works fully. It *looked* like a
feature regression. Two empirical investigations (bare-spawn probe + worktree
bisection) proved otherwise:

1. **node-pty can't read the PTY master under Bun.** A bare 5-line
   `@lydell/node-pty@1.2.0-beta.10` `pty.spawn('/bin/zsh')` — zero feature code —
   gets a *permanent* `read EAGAIN` (errno -35) under **Bun 1.3.14** and **no
   `onData` ever fires**; the same code yields output immediately under **Node
   v24.16**. This is the open Bun bug **oven-sh/bun#25822**. It hangs on `main`
   too — the "main works under Bun" belief was a **confounder**: with a large
   `~/.ai-or-die/models` cache present, `main` trips the 1GB disk-quota breaker
   (140%) and fails *before* the terminal spawns, while this branch excludes
   `models/` from the quota and so reaches the terminal and then hits the same
   Bun EAGAIN. Neutralise the breaker (`AIORDIE_DISK_QUOTA_MB=…`) and `main`
   hangs identically (4/4 runs).
2. **node-llama-cpp crashes Bun.** Running the sticky-note inference under Bun
   aborts the process: `panic: NAPI FATAL ERROR: Error::New napi_create_error` /
   "Bun has crashed. This indicates a bug in Bun, not your code." (exit 133). A
   Bun N-API bug. So the sticky-note model can **never** run under Bun.
3. **STT (sherpa-onnx) DOES work under Bun** — loads, transcribes, exits clean
   (10ms main-thread lag). So the incompatibility is specific to node-llama-cpp
   + node-pty, not all native addons.

Decision (matches user directive "keep Node, drop Bun" — implemented as
warn-and-continue, not a hard exit): **Node ≥22 is the recommended runtime; Bun
runs with limited support (sticky-notes disabled, STT works, terminal may hang).**
- `StickyNoteEngine._doInitialize` self-gates under Bun (status `unavailable`,
  `_lastSpawnError='BUN_UNSUPPORTED'`) so node-llama-cpp is **never loaded** there
  — defence-in-depth even if a caller enables the engine.
- `server.js` forces `_stickyNotesEnabledGlobally=false` under Bun (`!isBun()`).
- `bin/ai-or-die.js` prints a startup notice under Bun (continuing with
  sticky-notes disabled) + the equivalent `node …` command for a working terminal.
- `base-bridge.js` `shouldSwallowTransientEagain` **bounds** the EAGAIN swallow
  (added earlier to hide a transient Node startup blip): a persistent EAGAIN with
  no life-sign now surfaces after a ~3s grace window instead of being swallowed
  forever — so Bun's read failure is a fast visible error, not a silent 30s hang.
  The unbounded swallow was masking the symptom (it is **not** the cause; both
  agents confirmed reverting it doesn't restore output).

`isBun()` lives in `src/utils/runtime.js` (reads `process.versions.bun` at
call-time so tests can stub it). Tests: `test/base-bridge-eagain.test.js` (bounded
suppression) + the Bun-gate case in `test/sticky-note-engine.test.js`.

## Models are pulled on STARTUP, in worker threads (the "lazy" detour, reverted)

A mid-development commit (`da869c0`) made STT init lazy and deferred the sticky
engine ~12s, on the theory that eager model load "starved the event loop / CPU
and hung the terminal." **That theory was wrong** — the hang was the Bun/node-pty
bug (oven-sh/bun#25822, see above), reproducible with zero model code. A lag
probe confirmed model download+load costs only **2–10ms of main-thread lag**
(both engines run in `worker_threads` with their own event loops — STT in
`stt-worker.js`, Gemma in `sticky-note-worker.js`), so eager startup load never
blocked the terminal.

Worse, the lazy STT path was **broken**: it relied on a `voice_init` trigger that
the client never sent, so the local model never loaded → `localStatus` never went
`ready` → the mic silently fell back to the (flaky) browser cloud path. Symptom:
"STT not working; the mic timer resets to zero and increments."

Reverted to **pull-on-startup** (server `start()` calls `_ensureSttModel()` +
`_ensureStickyNoteEngine()`), each non-blocking in its worker thread, with the
**feature disabled until the model is `ready`**:
- STT: `_ensureSttModel()` is idempotent (no-ops if ready/downloading/loading),
  broadcasts `voice_model_progress` + a final `voice_status` so clients enable the
  mic the moment the model is ready. `voiceInput.localEnabled` (new field) tells
  the client "a local model is being pulled" vs "STT is off" — the mic stays
  DISABLED (with a downloading/loading hint) while pulling, ENABLED on ready, and
  uses cloud only when local isn't the configured backend. Decision logic is the
  pure, unit-tested `VoiceHandler.computeMicButtonState()`.
- Sticky (Gemma): `_ensureStickyNoteEngine()` runs at startup (Node-only;
  self-gates off under Bun/test/`--no-sticky-notes`). The per-session summariser
  only runs inference once the engine `isReady()`.

## Cross-lab review caught what self-review missed

The adversarial panel found: input-only redaction (model output reached
disk/clients unredacted — now redacted on both ends), a ReDoS in the base64
redactor (40KB → 3.7s main-thread stall, now linear `.test()` validation), a
45s-vs-60s timeout split that could run two prompts on one llama sequence (fixed
by serialising the worker), and an unpinned model hash (now SHA-256-pinned).
Also: graceful worker dispose before `terminate()` (a bare terminate with the
model loaded aborts the process / holds a Windows file lock). All fixed pre-merge.

## Windows regression: drive-letter colon broke the transcript binding (2026-06)

Symptom on Windows 11: the sticky-note card stayed empty AND the tab title never
updated — both at once, even though the model downloaded, loaded, and the engine
reached `ready`.

Root cause was the cwd→project-dir slug. claude writes transcripts under
`~/.claude/projects/<slug>/` where the slug replaces **every non-alphanumeric
char** with `-`, so `C:\Users\me\proj` → `C--Users-me-proj` (the drive-letter `:`
becomes a dash too). `slugForCwd` (`src/sticky-note-jsonl.js`) only replaced path
separators (`/[\\/]/g`), leaving `C:-Users-me-proj`. That directory never exists,
so `findActiveSessions`' `readdir` threw, `candidates` came back empty, and the
binder (`server.js _pumpStickyJsonl`) returned early without ever creating a
binding. No binding means the always-on title tail (`readNewAiTitle`) and the
expand-gated note inference both never run — hence both symptoms from one bug.
POSIX paths have no colon, so it only bit Windows (the primary target). The model,
native binding (win-x64 `llama-addon.node`), and `getLlama→loadModel→createContext`
were all verified healthy on the affected machine — the break was purely the path.

Fix: `slugForCwd` now mirrors claude exactly — `replace(/[^a-zA-Z0-9]/g, '-')`.
Separator-agnostic, so `\` and `/` cwd forms resolve identically; POSIX slugs are
unchanged. The same latent bug lived in `src/usage-reader.js`
(`getMostRecentSessionFile`, project-usage lookup) and was fixed the same way.
Regression covered by Windows drive-letter cases in
`test/sticky-note-jsonl.test.js` (slug parity + a `findActiveSession` resolve).
The rule is lossy by design (two distinct cwds can collide on one slug) — that is
claude's own folder-naming behavior, and matching it is mandatory.

## Files

Engine/worker/summarizer/transcript/prompt under `src/sticky-note-*.js`;
`src/utils/{secret-redact,gguf-model-manager}.js`; client
`src/public/sticky-note-card.js` + `components/sticky-note.css`. Tests:
`test/sticky-note-*.test.js` (78 cases, no model download — real inference is
manual).
