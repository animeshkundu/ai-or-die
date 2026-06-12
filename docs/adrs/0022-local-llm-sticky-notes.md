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
  (~806 MB). We *wanted* Gemma 4 E2B, but empirically the current
  `node-llama-cpp` prebuilt (llama.cpp **b8390**, 2026-03-17) does **not**
  register the `gemma4` architecture (it predates Gemma 4). `gemma4` is already
  in llama.cpp master, so the model spec is configurable
  (`--sticky-notes-model`) and Gemma 4 E2B becomes a one-line swap once a
  gemma4-capable `node-llama-cpp` ships. Google's QAT `q4_0` repo is **gated**
  (no anonymous download), so a silent on-by-default download requires the
  ungated `Q4_K_M` mirror. GGUF quantisation is platform-independent — one file
  for Windows + macOS; the per-OS difference is node-llama-cpp's backend binary
  (Metal / CUDA / Vulkan / CPU).
- **Input is a rendered transcript, not raw bytes.** Raw PTY output is terminal
  *rendering instructions* (CR redraws, spinners, alt-screen). We replay bytes
  through a per-session **`@xterm/headless`** terminal and summarise the
  rendered recent lines — this avoids duplicated/garbage input and transparently
  handles split multi-byte UTF-8.
- **Inference never runs on the PTY hot path.** The tap only buffers + arms
  timers. A per-session scheduler (`src/sticky-note-summarizer.js`) runs
  inference on **deterministic triggers** (quiet ~4s, volume ~80 lines, max-
  staleness ~90s, session-exit, initial, focus) with an adaptive `minInterval`,
  single-flight + dirty-bit coalescing, a circuit breaker, foreground-first fair
  dispatch over one shared worker, and a CPU thread cap — so it cannot livelock
  or starve sessions.
- **On by default, with mandatory mitigations.** Enabled for AI-agent tabs by
  default (`--no-sticky-notes` disables; server-authoritative per-session
  `stickyNotesEnabled` persists). Terminal output may contain secrets, so the
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
