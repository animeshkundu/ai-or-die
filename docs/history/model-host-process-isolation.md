# Model host process isolation — 2026-08-02

## Diagnosis

A live Windows instance at 8.9 days uptime measured 2236.9 MB RSS, 20 MB heap
used, 6.3 MB external, and 3.6 MB array buffers. Native model weights loaded in
worker threads accounted for 98.6% of RSS. The issue was a native-memory floor,
not a JavaScript leak.

## Resolution

STT and sticky-note inference moved to generation-scoped child processes with a
framed binary payload pipe and an armed parent-liveness pipe. Native bindings are
loaded only in the child entrypoints. Model timeouts, crashes, unload, and memory
retirement cannot reach core shutdown, and a process test kills a host while the
same terminal PTY continues streaming.

The core handles errors on both dedicated pipes for the entire generation
lifetime, so a host that exits during startup cannot turn an `EPIPE` or
`ECONNRESET` into an uncaught core exception. Late events from an exited
generation are ignored, crash-budget exhaustion blocks ordinary demand, and a
Windows orphan sweep removes only hosts whose recorded owner process is gone.

The installed package commands now start through the supervisor, gaining crash
respawn, the Windows Job Object guard, and `--expose-gc`. Deliberate startup
failures use a shared non-retryable exit code instead of looping.

## STT default evidence

Measured on the cached local model in this workspace:

| Step | Core RSS | Host RSS | Cold latency |
|---|---:|---:|---:|
| Engine constructed | 53.2 MB | none | — |
| Download-ready, still idle | 53.5 MB | none | — |
| First demand ready | 53.3 MB | 1480.2 MB | 9850 ms |
| Unloaded | 53.3 MB | none | — |

Decision: local STT remains enabled by default but loads lazily. Lazy loading
removes its boot memory cost, the measured 9.85 s cold start fits the 25 s bound,
and `voice_warm` begins loading when recording starts.

## Test-suite defects resolved

- Unit tests now use a per-run session-store sandbox and fail on access to the
  real home-directory store.
- Server close removes every process listener registered by the instance.
- Playwright project regexes are suffix-anchored, so digits in a checkout parent
  cannot reassign specs.
- The PowerShell OSC 7 PTY harness answers DSR, submits with CR, and uses the
  documented empty-host URL.
- The integration suite now runs in both CI matrix jobs.
- Real-browser reconnect verification found that restored tabs discarded the
  persisted agent type, so replayed terminal prompts were mislabeled as Claude
  activity. Session restoration now applies the server's `agent` metadata before
  replay processing.
  - System pressure now has the replacement action described by the plan: low
    system free memory retires inactive, request-free model hosts instead of
    restarting the core. Legacy expanded-card leases are renewed by the existing
    application heartbeat as well as the new dedicated heartbeat.
- The Windows startup sweep now requires the model-host executable, exact host
    entrypoint, host marker, and original parent PID. This prevents command text in
    a live PowerShell or cmd session from being mistaken for an orphan host.
