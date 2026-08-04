# ADR-0046: Terminal geometry contract

## Status

Accepted (2026-08-04).

## Context

Calling the xterm fit addon's mutating `fit()` and then subtracting columns or rows made repeated fits oscillate. Hidden split and background containers could measure as zero and send unusable geometry to a live PTY.

## Decision

`FitCoordinator` is the sole owner of browser terminal resize calls and outbound resize messages. It uses the fit addon's non-mutating proposal, applies the chrome reserve to the measurement, and deduplicates unchanged geometry.

A detached container or a container with a zero axis returns no geometry. Geometry below 20 columns or 5 rows is also refused. Refused targets remain deferred and are retried by `ResizeObserver` when they become measurable.

## Consequences

Hidden terminals do not corrupt PTY geometry. Reconnect may force the current valid geometry onto a new socket without resizing xterm again.
