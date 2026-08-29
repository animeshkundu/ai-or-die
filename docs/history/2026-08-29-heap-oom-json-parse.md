# 2026-08-29 heap OOM at JSON.parse

## What Happened

A long-lived server process accumulated large retained session output in memory. During a later file-backed `JSON.parse` call, V8 attempted one more large allocation and the process terminated with out-of-memory.

## Root Cause

The durable pressure was not the parser itself; it was retained live output tails per session. In affected runs, retained session output was on the order of ~1.8 GiB before the crash. The final `JSON.parse` allocation was the terminal allocator that crossed the heap limit.

The runtime evidence identifies a file-backed parse as the fatal allocator but cannot prove, from crash telemetry alone, whether that parse came from claude bind sidecar parsing or `sessions.json` metadata parsing in every case.

## Fix

- Added byte-bounded live session output retention at the buffer level: every production session output buffer now uses a shared cap of **1,000 items + 512 KiB**.
- Made join replay a true hard cap at **256 KiB** by taking a bounded newest suffix (including trimming a single oversized chunk/item).
- Hardened claude bind sidecar reads to **64 KiB max**, reading at most `max + 1` bytes from a single file handle, always closing the handle, and rejecting absent/oversized/malformed records. Opening the sidecar now marks the tab as sidecar-managed before validation, so malformed/oversized sidecars do not fall through to newest-mtime inference.
- Hardened `SessionStore.getSessionMetadata()` against TOCTOU + stale-cache drift: open-once/fstat/read-on-same-handle fallback, strict `64 KiB + 1` bounded read, no parse when fallback bytes exceed limit, and identity-keyed metadata cache invalidation (`size/mtimeMs` + available `dev/ino/ctimeMs`), with `dev`/`ino` stored as strings to avoid unsafe integer precision.
- Added a startup restart-loop guard in `loadSessions()` with a conservative safe-load ceiling (**128 MiB** default). Reads are positioned and chunked with a hard `maxSafeLoadBytes + 1` bound, including a post-read growth check. Oversized files are preserved byte-for-byte as `.oversized.<timestamp>` for manual recovery (rename-first, copy-and-unlink fallback), then startup continues with an empty in-memory map.
- Added regression tests covering newline-free PTY retention caps, newest-suffix retention proofs, oversized single-chunk onOutput capping, sidecar oversize/malformed binding safety, and bounded metadata/oversized-load behavior.

## Watch For

- Retention growth in `retention.output_buffers.{active,inactive}.bytes` that should now flatten near `session_count * 512 KiB` for heavy-output sessions.
- Repeated `savedAt/sessionCount/version = null` metadata responses with very large `sessions.json` before cache warm-up (expected only until a successful save/load populates cache).
- `.oversized.<timestamp>` backups appearing at startup (expected when a store exceeds the safe-load cap; preserve for manual recovery instead of parsing in-process).
- Any new code path that reintroduces unrestricted file-backed `JSON.parse` on large files in hot/diagnostic endpoints.
