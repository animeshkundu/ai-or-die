# Sticky Notes (local-LLM session summaries) — build notes, 2026-06

Implementation of the per-tab local-LLM "sticky note" + auto tab title feature
(ADR-0022, spec `docs/specs/sticky-notes.md`). Gotchas worth remembering:

## Gemma 4 is NOT loadable on the current node-llama-cpp prebuilt

We standardised on Gemma 4 E2B, then validated empirically before committing:

- `node-llama-cpp@3.18.1` (latest, published 2026-03-17) bundles llama.cpp
  **b8390**. Its `src/llama-arch.cpp` registers `gemma / gemma2 / gemma3 /
  gemma3n / gemma-embedding` — **no `gemma4`**. Gemma 4 shipped ~2026-04-02,
  after b8390.
- llama.cpp **master** *does* have `gemma4` + `gemma4-assistant`, so a future
  node-llama-cpp release will support it.
- Verdict: v1 runs **Gemma 3 1B (Q4_K_M)**; the model is configurable so Gemma 4
  E2B is a one-line `--sticky-notes-model` swap when the binding catches up.

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

## Cross-lab review caught what self-review missed

The adversarial panel found: input-only redaction (model output reached
disk/clients unredacted — now redacted on both ends), a ReDoS in the base64
redactor (40KB → 3.7s main-thread stall, now linear `.test()` validation), a
45s-vs-60s timeout split that could run two prompts on one llama sequence (fixed
by serialising the worker), and an unpinned model hash (now SHA-256-pinned).
Also: graceful worker dispose before `terminate()` (a bare terminate with the
model loaded aborts the process / holds a Windows file lock). All fixed pre-merge.

## Files

Engine/worker/summarizer/transcript/prompt under `src/sticky-note-*.js`;
`src/utils/{secret-redact,gguf-model-manager}.js`; client
`src/public/sticky-note-card.js` + `components/sticky-note.css`. Tests:
`test/sticky-note-*.test.js` (78 cases, no model download — real inference is
manual).
