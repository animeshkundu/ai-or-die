# 0022 - Local-LLM Per-Tab Sticky Notes & Auto Tab Titles

## Status

Accepted (2026-06).

## Context

AI coding sessions (Claude/Codex/Gemini/Copilot) scroll fast and it is easy to
lose the thread of *what a tab is doing, what has happened, and what it is
waiting on*. We want a per-tab, always-glanceable summary plus a short
self-describing tab title, generated **locally** (no data leaves the machine).

All tool PTY output already funnels through one server choke point
(`src/server.js` `onOutput`), and the existing Sherpa-ONNX STT subsystem proves
the pattern of a worker-thread local model with a lazy, progress-reported model
download and graceful degradation. We reuse that shape.

## Decision

- **Backend: bundled `node-llama-cpp`** (in `optionalDependencies`,
  `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true` to forbid cmake source builds). Inference
  runs in a dedicated worker thread (`src/sticky-note-worker.js`); ESM-only
  `node-llama-cpp` is loaded via dynamic `import()`. If the module or model is
  missing the feature is simply `unavailable` — the app is unaffected.
- **Model: Gemma 3 1B (Q4_K_M GGUF)** from the ungated `ggml-org` mirror
  (~806 MB). **(Superseded by ADR-0023 — the default is now Liquid LFM2-2.6B
  after a bake-off; the rationale below records the original v1 choice.)** We
  *wanted* Gemma 4 E2B, but empirically the current
  `node-llama-cpp` prebuilt (llama.cpp **b8390**, 2026-03-17) does **not**
  register the `gemma4` architecture (it predates Gemma 4). `gemma4` is already
  in llama.cpp master, so the model spec is configurable
  (`--sticky-notes-model`) and Gemma 4 E2B becomes a one-line swap once a
  gemma4-capable `node-llama-cpp` ships. Google's QAT `q4_0` repo is **gated**
  (no anonymous download), so a silent on-by-default download requires the
  ungated `Q4_K_M` mirror. GGUF quantisation is platform-independent — one file
  for Windows + macOS; the per-OS difference is node-llama-cpp's backend binary
  (Metal / CUDA / Vulkan / CPU).
- **Input (v2): the claude JSONL transcript, with the rendered-terminal scrape as
  fallback.** v1 scraped a per-session `@xterm/headless` terminal, but an Ink TUI
  (`claude`) repaints in place, so the scrape captured the input box, not the
  conversation. v2 reads claude's own session log
  (`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`; `src/sticky-note-jsonl.js`),
  bound per-tab by a 2s poll on `liveCwd||workingDir` — clean, complete
  user/assistant turns (the `@xterm/headless` scrape remains for plain non-claude
  shells; it transparently handles split multi-byte UTF-8 there).
- **Note (v2) is incremental + append-only.** `{goal, done[], remaining[],
  updates[{text,at}]}` (was `{title, goal, progress[], waitingOn[]}`). Each turn
  refines goal/done/remaining and **prepends** one `update` (newest-first, cap 25).
  `ai-title` lines from the JSONL drive the tab title for free.
- **Inference never runs on the PTY hot path.** The tap only buffers + arms
  timers. A per-session scheduler (`src/sticky-note-summarizer.js`) runs
  inference on **deterministic triggers** (JSONL mode: per completed turn,
  debounced; scrape mode: quiet ~4s, volume, max-staleness; + session-exit) with
  an adaptive `minInterval`, single-flight + dirty-bit coalescing, a circuit
  breaker, foreground-first fair dispatch over one shared worker, and a CPU thread
  cap — so it cannot livelock or starve sessions.
- **On by default, with mandatory mitigations.** Enabled by default for both
  AI-agent tabs (claude/codex/gemini/copilot) AND plain terminal tabs — users
  frequently launch an AI CLI inside a shell, so `_isStickyEligible` includes
  `terminal` (an idle terminal never triggers inference; a noisy one can be
  turned off per-tab). Disable globally with `--no-sticky-notes`; the
  server-authoritative per-session `stickyNotesEnabled` persists. Terminal output
  may contain secrets, so the
  text is **redacted on BOTH ends** (`src/utils/secret-redact.js`) — the input
  before the model sees it AND the model's output before it is persisted/
  broadcast/rendered (a small model routinely echoes a secret into the note).
  The redactor is **ReDoS-safe** (linear matching; it runs on the main thread).
  The note is rendered **`textContent`-only** on the client (no `innerHTML`)
  with control/bidi stripping + length caps — defending against prompt-injection
  driven UI spoofing. The model **downloads silently** with a progress banner,
  is **SHA-256-pinned** (refuses a swapped same-size file), and its cache lives
  under `~/.ai-or-die/models/` which is **excluded from the disk-quota breaker**
  (a one-time intentional download is not the runaway session-data growth the
  quota guards — counting it would block session creation).
- **One inference at a time.** The engine serialises requests AND the worker
  serialises `session.prompt()` calls, so the shared llama context sequence
  never has two evaluations in flight (which would corrupt KV state / crash the
  native layer). The engine is shut down with the server.
- **Auto tab titles** come from the *same* inference (no extra model call). They
  apply only when the user has not manually renamed the tab (`nameIsUserSet`); a
  manual rename pins the name. A cheap heuristic title is not yet implemented —
  titles appear once the first summary lands.
- **Pluggable backend seam.** The summariser depends on an `infer(prompt)`
  interface, leaving room for a future Ollama / external-endpoint backend
  (mirroring STT's `--stt-endpoint`) without touching the scheduler or UI.
- **Runtime: Node.js for full features; Bun runs with limited support.** The
  recommended runtime is Node ≥22. Under Bun the app **continues to run** but with
  two independent, externally-confirmed incompatibilities, so sticky-notes
  **self-gate off** (`StickyNoteEngine._doInitialize` returns `unavailable` /
  `BUN_UNSUPPORTED` before spawning its worker; the server also forces the feature
  off via `!isBun()`):
  1. **node-llama-cpp crashes Bun.** Loading its native N-API addon under Bun
     1.3.14 aborts the process with `NAPI FATAL ERROR` (exit 133) — a Bun N-API
     bug, not ours — so the sticky-note worker is never spawned under Bun.
  2. **node-pty cannot read the PTY master under Bun** (oven-sh/bun#25822): a
     bare `pty.spawn()` gets a permanent read `EAGAIN` and no data ever arrives,
     so the terminal can hang regardless of this feature (confirmed on `main` too,
     once the disk-quota breaker is neutralised — see below). Outside the feature's
     control; the fix is "run with Node".
  `bin/ai-or-die.js` prints a one-time startup notice under Bun (continuing with
  sticky-notes disabled) pointing to the equivalent `node …` command for a
  guaranteed-working terminal. The **bounded EAGAIN suppression** in
  `src/base-bridge.js` (`shouldSwallowTransientEagain`) swallows Node's transient
  startup EAGAIN but lets a *sustained* EAGAIN flood with no life-sign surface
  after a ~3s grace window, so Bun's read failure produces a visible error instead
  of a silent 30s hang. **STT (sherpa-onnx) is unaffected and still runs under
  Bun** (it is pulled on startup like on Node).

## Consequences

- Until a gemma4-capable `node-llama-cpp` is published, v1 runs Gemma 3 1B. This
  is a config change, not a code change, when the binding catches up.
- The feature adds two dependencies: `@xterm/headless` (small, pure-JS,
  dependency) and `node-llama-cpp` (optional, native).
- Summaries are derived from terminal output and may still surface
  non-pattern-matched sensitive strings; they stay on-device and live alongside
  the already-persisted output buffer in `sessions.json`.
- **SEA packaging gap (pre-existing):** `new Worker()` files are not bundled into
  `dist/bundle.js`; `sticky-note-worker.js` shares the STT worker's existing gap.
  Works in dev / npm installs; SEA builds need the worker added as an asset
  (tracked as a follow-up alongside the STT worker).
