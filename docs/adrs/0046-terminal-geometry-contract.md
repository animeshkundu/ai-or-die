# ADR-0046: Terminal geometry contract

## Status

Accepted (2026-08-04).

## Context

Calling the xterm fit addon's mutating `fit()` and then subtracting columns or rows made repeated fits oscillate. Hidden split and background containers could measure as zero and send unusable geometry to a live PTY.

## Decision

`FitCoordinator` is the sole owner of browser terminal resize calls and outbound resize messages. It uses the fit addon's non-mutating proposal, applies the chrome reserve to the measurement, and deduplicates unchanged geometry.

A detached container or a container with a zero axis returns no geometry. Geometry below 20 columns or 5 rows is also refused. Refused targets remain deferred and are retried by `ResizeObserver` when they become measurable.

`ResizeObserver` alone is not sufficient. Two failure modes produce no further observation and would otherwise leave a PTY on a stale size for the rest of the session:

- The container was not measurable at the moment of the fit and never changes size again.
- The geometry was measured but the session socket had not finished opening, so `send` reported that nothing went on the wire.

The coordinator therefore owns a bounded self-retry. A target that ends a pass either deferred or with an unsent geometry re-queues itself on a timer (default 120 ms, at most 12 attempts per target). The attempt counter is per target, so one wedged pane cannot starve the others, and it resets as soon as that target resizes and sends successfully. Exhausting the bound stops the loop; a later `ResizeObserver` callback, `visibilitychange`, or explicit `request` still resumes the target normally.

## Verification

`test/fit-coordinator.test.js` drives the coordinator with injected `requestAnimationFrame`, `setTimeout`, and `ResizeObserver` and asserts: a target with a closed socket keeps retrying and succeeds on the attempt after the socket opens; a permanently unmeasurable target performs exactly `maxRetries` retries and then stops; and a target that exhausted its retries still fits once its container becomes measurable and a fresh request arrives.

## Consequences

Hidden terminals do not corrupt PTY geometry. Reconnect may force the current valid geometry onto a new socket without resizing xterm again.
