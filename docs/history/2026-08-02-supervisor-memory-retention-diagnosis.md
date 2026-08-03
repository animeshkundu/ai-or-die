# Supervisor Memory Retention Diagnosis

## What Happened

The long-running ai-or-die service grew until V8 heap OOM on Windows, Ubuntu,
and macOS longevity jobs. Historical Windows data reached about 3.9 GiB heap
used after 2h23m. Existing soaks ran the server and load generator in one
process, disabled sticky notes and STT, and could not attribute heap growth to a
PID or worker.

## Root Cause

The supervisor wrapper stayed flat. The server child retained data through
several independent lifetime structures:

- on Windows, each completed PTY leaves a `conhost.exe`, 22 server handles, and
  native private bytes after bridge/listener/job counters reach zero;
- live sessions have no count limit for seven days and eagerly allocate a
  1,000-slot output buffer;
- output buffers are bounded by raw PTY callback count, not bytes, and survive
  PTY exit and client disconnect;
- ended artifact reviews, chat, queued prompts, and DOM snapshots remain in the
  lifetime review Map;
- an unavailable sticky-note engine never drains pending JSONL text;
- VS Code `serve-web` stdout is concatenated into a lifetime closure string.

The ranked measurements, exact base-commit locations, conditional production
rates, and ruled-out surfaces are in
`test/longevity/results/MEMORY-DIAGNOSIS-PR-BODY.md`.

## Fix

No fix was made in this diagnosis-only change. It added secret-gated counters,
post-GC and heap-snapshot probes, process-isolated Node 22 harnesses, worker
heap reporting, a streaming weak-edge-aware dominator analyzer, and opt-in
expected-red tests. A paired persistence-on/off arm crossed the 30-second
autosave boundary and separated serialization churn from the live-session
floor on both Windows and Ubuntu; an explicit tick assertion prevents timing
drift from silently changing that evidence shape. Later fix PRs should implement
byte/count budgets and lifecycle deletion independently so each
characterization flips green for one reason.

## Watch For

Do not derive CircularBuffer cost from the historical 798,680-session
`mock-clock` peak: those synthetic sessions never allocate a CircularBuffer.
Do not upload raw heap snapshots; they can contain terminal text, local paths,
usernames, and credentials. Do not treat missing heap-size flags or restart
policy as a root cause of retention.
