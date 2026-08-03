# Soak Results

This directory holds per-run output from `npm run soak`. Each run creates a
subdirectory named `<utc-stamp>[-<label>]/` containing:

- `metadata.json` — soak parameters + sampler stats + node/platform fingerprint
- `samples.jsonl` — one row per `{gate, metric}` per sample tick
- `events.jsonl` — soak/workload lifecycle markers
- `gate-result.json` — final pass/fail verdict per gate

The schema and gate definitions are documented in `../README.md`.

`derived/` contains redacted, process-isolated memory-diagnosis series. These
files may contain counters, per-PID metrics, and dominator aggregates, but never
raw heap snapshots. Raw `.heapsnapshot` files can contain terminal text, paths,
usernames, and secrets; keep them local and delete them after generating the
redacted aggregate with `harness/heap-snapshot-cli.js`.

The `persistence-*` series pair persistence-enabled and diagnostic-only
persistence-disabled server processes with identical session workloads so
serialization peaks are separated from the live-session floor.

`MEMORY-DIAGNOSIS-PR-BODY.md` is the ranked diagnosis report generated from the
Node 22 series and historical CI OOM evidence.

`baseline-*/` directories are pinned reference runs captured on `main` HEAD
before any fix lands; do not delete or overwrite them.
