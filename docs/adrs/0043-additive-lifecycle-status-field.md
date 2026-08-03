# ADR-0043: Add lifecycle state without replacing legacy status

## Status

**Accepted**

## Date

2026-08-02

## Context

Existing browser pages can remain connected across a server upgrade. They gate
the microphone and sticky-note affordances on the literal legacy value `ready`.
Replacing that enum with model-host lifecycle values would disable those controls
on stale pages.

## Decision

Keep the legacy status field and its four existing values unchanged. Send
`model_lifecycle_status` as a separate message only after a client advertises the
`model_host_lifecycle` capability.

With cold demand implemented, `idle`, `unloading`, and `restarting` project to
legacy `ready`. New clients render more specific titles and state markers while
old clients continue to initiate the action that warms the model.

## Consequences

### Positive

- Connected pre-upgrade pages remain usable.
- New clients can distinguish unloaded, loading, reconnecting, and failed states.

### Negative

- Server and client maintain two related status representations.

### Neutral

- Unknown additive messages remain harmless to old clients.
