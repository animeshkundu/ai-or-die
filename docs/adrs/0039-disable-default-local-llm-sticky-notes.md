# 0039 - Disable Default Local-LLM Sticky Notes

## Status

Accepted (2026-08-02). Supersedes the default-on summary policy in ADR-0022, the
LFM2-2.6B default-model decision in ADR-0023, and the LLM portion of ADR-0025.
ADR-0024/0026 binding and the model-free Claude `ai-title` tail remain in force.

## Context

**Quality: 0 long agentic-coding transcripts / 0 summary updates were available
for evaluation in this checkout or the local Claude projects directory.** Therefore
the long-session empty/degenerate, hallucination, and staleness rates are each
not measurable (0/0), not zero. ADR-0023's 0/23 result came from short sessions
and cannot establish value for tool-heavy all-day coding. A synthetic prompt
produced plausible text, but synthetic output is not evidence of quality on the
owner's workload.

**RSS: +3,052.3 MiB (steady state; 5,724% of baseline).** On 2026-08-02, the
actual production engine, worker, `buildPrompt()`, and
`LFM2-2.6B-Q4_K_M.gguf` were measured on this Linux x64 host after its Vulkan
binary fell back to CPU: baseline RSS with the disabled engine was **51.6 MiB**;
after model load it was **3,003.9 MiB** (+2,952.3 MiB); after one
grammar-constrained inference it was **3,103.8 MiB** (+3,052.3 MiB). The
12-thread CPU inference took **7.881 s** and the main-event-loop timer's maximum
lag was **3.5 ms**. This is a host-specific CPU measurement, not a claim about
the owner's Windows hardware; their measured 1.46 GiB GGUF plus 0.64 GiB STT
weights already account for roughly 2.1 GiB of a >4 GiB service. Worker threads
share process RSS, so expand-gating cannot reclaim model memory after
initialization.

For a single tab kept expanded, ADR-0025 permits an inference after each completed
turn. It prevents no residency and provides no practical CPU saving for that
usage. The `ai-title` path is separate: `readNewAiTitle()` tails Claude JSONL
without an inference, model, or worker.

## Decision

**Recommendation: DISABLE local-LLM sticky-note summaries by default.**

- Only `--sticky-notes` enables the engine. Without it, the server neither probes
  nor downloads the GGUF and never spawns a sticky-note worker.
- The browser's Display setting is also off by default, preserving explicit
  per-client consent before a summary card activates.
- Continue JSONL binding, `agent-*.jsonl` exclusion, resume ownership, turn
  detection, and Claude `ai-title` tailing. Every Claude tab continues to receive
  its free, source-authored title even when summaries are disabled, unavailable,
  or repeatedly fail.
- Do not claim a quality rate until a redacted corpus of long, tool-heavy,
  agentic-coding transcripts has been evaluated through the production worker.
  Reconsider a deterministic extractor or smaller model only with measured
  quality and cost evidence.

## Consequences

### Positive

- The default service avoids the measured multi-gigabyte model RSS increase and
  140.605-second CPU inference path.
- The useful, free tab title remains available and is now tested independently of
  the summary engine.
- Default users do not download a 1.56 GB GGUF or expose transcript content to a
  local model.

### Negative

- Sticky-note cards require explicit server and browser opt-in.
- Durable LLM summaries remain available only to users who accept their measured
  cost and the currently unproven long-session quality.

### Neutral

- Existing explicit opt-ins retain the binding, redaction, failure, resume, and
  expand-gating behavior described by the prior ADRs.
