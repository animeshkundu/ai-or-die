# ADR-0046: Terminal geometry contract

## Status

Accepted (2026-08-04). **Partially superseded by
[ADR-0052](0052-multi-viewer-terminal-geometry.md) (2026-08-05).**

Everything below remains accurate for a single browser measuring its own container, and
`FitCoordinator` is still the sole owner of client-side resize calls. What ADR-0052 supersedes is the
implicit assumption that one viewer exists: it adds ownership arbitration, a monotonic revision, a
session epoch, and transactional application for the case where several viewers share one PTY.

## Context

Calling the xterm fit addon's mutating `fit()` and then subtracting columns or rows made repeated fits oscillate. Hidden split and background containers could measure as zero and send unusable geometry to a live PTY.

## Decision

`FitCoordinator` is the sole owner of browser terminal resize calls and outbound resize messages. It uses the fit addon's non-mutating proposal, applies the chrome reserve to the measurement, and deduplicates unchanged geometry.

A detached container or a container with a zero axis returns no geometry. Geometry below 20 columns or 5 rows is also refused. Refused targets remain deferred and are retried by `ResizeObserver` when they become measurable.

`ResizeObserver` alone is not sufficient. Two failure modes produce no further observation and would otherwise leave a PTY on a stale size for the rest of the session:

- The container was not measurable at the moment of the fit and never changes size again.
- The geometry was measured but the session socket had not finished opening, so `send` reported that nothing went on the wire.

The coordinator therefore owns a bounded self-retry. A target that ends a pass with an unsent geometry re-queues itself on a timer (default 120 ms, at most 12 attempts per target). A target that could not be measured at all re-queues only if it has **never** had a valid geometry: once a terminal is established, an unmeasurable container means chrome is overlaying it, and re-fitting it on a timer would reflow a terminal that ADR-0045 requires to stay put. Established targets wait for `ResizeObserver`, as before.

The attempt counter records retries the coordinator actually performed and advances only when the timer fires, so a burst of `ResizeObserver` callbacks arriving while one timer is armed cannot silently spend the whole budget. It is per target, so one wedged pane cannot starve the others, and it is cleared both when that target settles and when an external `request` arrives. Exhausting the bound stops the loop; a later `ResizeObserver` callback, `visibilitychange`, or explicit `request` still resumes the target normally.

## Verification

`test/fit-coordinator.test.js` drives the coordinator with injected `requestAnimationFrame`, `setTimeout`, and `ResizeObserver` and asserts: a target with a closed socket keeps retrying and succeeds on the attempt after the socket opens; a permanently unmeasurable target performs exactly `maxRetries` retries and then stops; requests made while a retry is armed do not consume the budget; an external request starts a fresh bounded run after exhaustion; one shared timer serves several targets without cross-starving their budgets; and an established target whose container goes unmeasurable is never re-fitted on a timer.

## Consequences

Hidden terminals do not corrupt PTY geometry. Reconnect may force the current valid geometry onto a new socket without resizing xterm again.
