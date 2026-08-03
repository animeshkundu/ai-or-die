# ADR-0041: Use a dedicated framed binary pipe for model payloads

## Status

**Accepted**

## Date

2026-08-02

## Context

Default process IPC does not preserve typed arrays. Advanced serialization was
empirically unusable under Bun 1.3.14, including for a trivial object. Local STT
supports Bun, and voice payloads reach 3.84 MB.

## Decision

Use fd 3 for JSON control metadata, fd 4 for `AOD1` length-prefixed binary
payloads, and fd 5 for parent liveness. Frames include a generation nonce,
per-generation sequence, dtype, and validated length. Writers use one `write()`
per frame and handle backpressure and pipe errors.

This ADR relates to ADR-0026, which continues to define browser-to-core voice
framing. The model-host frame is an internal core-to-child protocol.

## Consequences

### Positive

- Typed payloads remain binary and copy-efficient.
- The protocol works without advanced serialization.
- Corruption and partial EOF are detected deterministically.

### Negative

- Metadata/frame correlation and parser state require explicit bounds and tests.

### Neutral

- Results remain small JSON IPC messages.
