# ADR-0042: Isolate native models in child processes

## Status

**Accepted**

## Date

2026-08-02

## Context

After 8.9 days, the live core used 2236.9 MB RSS while JavaScript heap usage was
20 MB. Native model weights accounted for 98.6% of RSS and were loaded through
worker threads, which share the core address space. A worker-thread crash can
therefore terminate every live terminal, and terminating a thread does not
reliably return native allocator pages to the OS.

The primary safety invariant is that model failure must never terminate a live
terminal PTY. Automatic memory-triggered core restart is therefore prohibited.

## Decision

Run local STT and sticky-note inference in dedicated `ModelHost` child processes.
Use immutable spawn generations, one order-independent finalizer, rolling and
consecutive crash counters, readiness deadlines, timeout retirement, Windows Job
Objects, a Windows orphan sweep, and a POSIX armed liveness watchdog.

Crash-budget exhaustion is a demand barrier, not merely a displayed state.
Transient failures can be retried only through a bounded cooloff or explicit
rate-limited retry; permanent configuration failures cannot. The Windows sweep
uses exact owner-PID parsing and removes a host only after its owner is absent, so
parallel live server instances do not retire one another's models.

Model pressure may unload or retire only a model host. It cannot call core restart
or shutdown.

This supersedes the eager worker-thread lifecycle rationale in ADR-0022 and
ADR-0025. It does not supersede ADR-0031; PTY shutdown semantics remain unchanged.

## Consequences

### Positive

- Native faults and memory reclamation are isolated per model.
- Host termination returns native pages to the OS without touching live PTYs.
- Models can load on demand and unload independently.

### Negative

- Child lifecycle, containment, and IPC framing are more complex.
- Cold demand adds bounded latency.

### Neutral

- PTY bridges and the JSONL control plane remain in the core.
- Windows create-suspended assignment is not yet implemented; the residual
  PID-reuse window is documented in the model-host specification.
