# Soak Results

This directory holds per-run output from `npm run soak`. Each run creates a
subdirectory named `<utc-stamp>[-<label>]/` containing:

- `metadata.json` — soak parameters + sampler stats + node/platform fingerprint
- `samples.jsonl` — one row per `{gate, metric}` per sample tick
- `events.jsonl` — soak/workload lifecycle markers
- `gate-result.json` — final pass/fail verdict per gate

The schema and gate definitions are documented in `../README.md`.

`baseline-*/` directories are pinned reference runs captured on `main` HEAD
before any fix lands; do not delete or overwrite them.
