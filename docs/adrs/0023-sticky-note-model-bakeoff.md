# 0023 - Sticky-Note Summariser Model: Liquid LFM2-2.6B (bake-off-driven)

## Status

Accepted (2026-06). Supersedes the **Model** decision of
[ADR-0022](0022-local-llm-sticky-notes.md) (Gemma 3 1B). The rest of ADR-0022
(architecture, worker, redaction, scheduling, on-by-default, degradation) stands.

## Context

ADR-0022 shipped the sticky-note summariser on **Gemma 3 1B (Q4_K_M)**, picked
for size and because the bundled `node-llama-cpp` (llama.cpp **b8390**) lacks the
`gemma4` arch. Once the input moved to the clean claude JSONL transcript (ADR-0022
v2) and the prompt was hardened (input markdown-stripping + per-turn cap; output
sanitisation that drops stub updates), the dominant remaining quality problem was
the **model**, not the data or the prompt:

- **Goal** became reliable (grounded in the JSONL `ai-title`).
- **Done/Remaining** stayed weak: frozen lists, `snake_case` identifier tokens
  (`user_needs_multiplexing`, `orienting_myself`), or empty.
- **Update** was empty on ~35% of turns (stubs the sanitiser correctly dropped).

This is the 1B's ceiling. We ran a bake-off to pick a better default.

### Bake-off

Five models, one family scale-up plus two new families, run through the **exact
production inference path** (`LlamaChatSession` + `createGrammarForJsonSchema` +
`temperature 0` + `maxTokens 320`, `contextSize 8192`) over **4 real claude JSONL
sessions** (design brainstorm / short benchmark / git-ops / feature-dev), first 6
completed turns each (23 inferences/model). Quality judged on
Goal/Done/Remaining concreteness + Update fidelity; cost on parse-fails, empty
updates, latency (Mac/Metal), and download size.

| model | quality | empty updates | avg latency (Metal) | size |
| --- | --- | --- | --- | --- |
| gemma-3-1b (incumbent) | snake_case / frozen / often empty | 8/23 (35%) | 3.7 s | 806 MB |
| **lfm2-1.2b** | concrete plain-English | 0/23 | 4.0 s | 731 MB |
| **lfm2-2.6b** | **best — concrete + forward-looking** | 0/23 | 7.1 s | 1.56 GB |
| qwen3-4b | faithful, terse | 2/23 | 11.5 s | 2.5 GB |
| gemma-3-4b | strong but bullets bleed; leaked a transcript error string into Remaining | 0/23 | 16.1 s | 2.5 GB |

All five loaded on b8390 (gemma3 / lfm2 / qwen3 archs are registered; only
`gemma4` is missing). Metal latencies are a **floor** — Windows (the primary
target) runs CPU/Vulkan and is materially slower, so per-turn latency weighs
heavily for an on-by-default feature.

Notable: **LFM2-1.2B is a strict Pareto win over the incumbent** — smaller, same
latency, output jumps from junk to usable. The two 4B models give marginal
quality over LFM2-2.6B at 1.6–2.3× its latency and 1.6× its size — wrong tradeoff
for a silent on-by-default download.

## Decision

- **Default model: Liquid LFM2-2.6B (Q4_K_M)** from the ungated
  `LiquidAI/LFM2-2.6B-GGUF` repo, pinned to commit
  `a759abdc5955d4ca97763e5cb7ff3940589ba898`, **SHA-256-verified**
  (`384bc877…0340df`, ~1.56 GB) before load. It produced the best
  Done/Remaining (concrete, forward-looking), zero empty updates, and ~7 s/turn
  on Metal — acceptable for a debounced, single-flight, background summary that
  never touches the PTY hot path.
- **`LFM2-1.2B` is the documented lighter alternative** (~731 MB, ~half the
  latency, still far better than the 1B) via `--sticky-notes-model`.
- **No code changes beyond the model spec.** Same worker, grammar, `contextSize`
  8192, `maxTokens` 320, redaction, and scheduler. The prompt's input/output
  sanitisation (markdown-stripping + per-turn cap + stub-update drop) lands with
  this change and benefits every model.
- **Configurability preserved.** `--sticky-notes-model <url>` / `STICKY_NOTES_MODEL`
  still overrides the GGUF; any ungated GGUF whose arch b8390 registers works.

## Consequences

- The on-by-default download grows from ~806 MB to ~1.56 GB. The model cache
  (`~/.ai-or-die/models/`) is already excluded from the disk-quota breaker.
- Per-turn inference is ~2× slower than the 1B on Metal, more on Windows CPU.
  The scheduler's debounce + single-flight + `minInterval` absorb this; inference
  is never on the PTY path and degrades to `unavailable` on any failure.
- **Licensing:** LFM2 ships under the LFM Open License v1.0 (custom, like Gemma's
  own licence). We download at runtime (no redistribution), same shape as the
  Gemma mirror. Confirm the licence remains acceptable if the distribution model
  changes.
- Latencies are Mac/Metal; a Windows CPU/Vulkan regression check belongs in the
  perf budget. If LFM2-2.6B proves too heavy on low-end Windows boxes, LFM2-1.2B
  is a one-line default downgrade with most of the quality.
- Gemma 4 E2B remains the eventual candidate once a `gemma4`-capable
  node-llama-cpp ships; re-run this bake-off against it before switching.

## How to reproduce

Load each candidate via `getLlama().loadModel`, run `buildPrompt` →
`LlamaChatSession.prompt({grammar, temperature:0, maxTokens:320})` → `parseNote`
over the first 6 completed turns of several real
`~/.claude/projects/<slug>/<sessionId>.jsonl` sessions, and compare
Goal/Done/Remaining/Update plus parse-fail / empty-update / latency.
