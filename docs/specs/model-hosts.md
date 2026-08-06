# Model Host Process Specification

Status: implemented (2026-08-02). See ADR-0042, ADR-0043, and ADR-0044.

## Invariant

Model lifecycle events must never stop or restart the core server. In particular,
memory pressure, model-host crashes, crash-budget exhaustion, readiness timeout,
request timeout, unload, and host containment failure may retire only the affected
model host. A live terminal PTY continues running throughout.

## Topology

The core owns HTTP, WebSocket, PTY bridges, session persistence, and the JSONL
control plane. Local STT and sticky-note inference run in separate child processes:

```
supervisor
└── core server
    ├── stt-host
    └── sticky-note-host
```

Neither `sherpa-onnx-node` nor `node-llama-cpp` may be loaded by the core,
directly or transitively. `src/stt-host.js` and `src/sticky-note-host.js` are the
only native inference entrypoints.

Hosts receive an allowlisted runtime environment plus their encoded model
configuration. Authentication, tunnel, mesh, and unrelated operator credentials
from the core environment are not inherited. Runtime backend selectors such as
CUDA, HIP, Vulkan, GGML, and llama configuration are preserved.

## Lifecycle

`ModelHost` exposes these states:

`disabled`, `downloading`, `idle`, `loading`, `ready`, `unloading`,
`restarting`, `failed`.

Every spawn owns an immutable generation object containing the child identity,
nonce, IPC streams, readiness/exit promises, timers, request map, tombstones, and
mutable generation-local runtime state. Every event handler and timer verifies
that generation identity before mutating host-wide state.

A single idempotent finalizer handles child error, IPC disconnect, payload-pipe
error/EOF, readiness expiry, request timeout, protocol violation, and exit.
Replacement cannot start until exit for the previous generation has been
observed. `unload()` acts only from `ready`; it is a no-op from every other state.

Crash control has two independent counters:

- A rolling crash-time ring. Successful readiness does not clear it.
- A consecutive-failure counter. Successful readiness resets it and it drives
  backoff of 1 s, 2 s, 4 s, 8 s, capped at 15 s.

Permanent failures such as `MODULE_NOT_FOUND` enter `failed` and never retry on
a timer. Exhausting the rolling budget also enters `failed`; ordinary demand and
lease heartbeats cannot bypass it. A transient failure may leave `failed` only
after a generation-checked 30-minute cooloff or an explicit rate-limited retry.

## IPC

Each host uses:

```
stdio: ['ignore', 'inherit', 'inherit', 'ipc', 'pipe', 'pipe']
```

- fd 3: JSON control metadata and JSON results
- fd 4: length-prefixed binary request payloads
- fd 5: parent-liveness channel

Advanced process serialization is not used. Each fd-4 frame is written in one
`write()` call and contains magic `AOD1`, protocol version, dtype, generation
nonce, per-generation sequence, and payload length. The parser validates the hard
8 MiB maximum before waiting for a body, validates dtype alignment, rejects
duplicate metadata/frames, expires bounded orphan entries, and treats EOF
mid-frame as a protocol failure. The writer handles backpressure, `drain`, write
callback errors, stream errors, and `EPIPE`.

Late results are accepted only for an explicit unexpired timeout tombstone.
Other unknown IDs are protocol violations.

## Containment

### Windows 11

The core creates a non-inheritable kill-on-close Job Object for every host and
assigns the child immediately after spawn. Creation or assignment failure is fatal
for that child, which is terminated before it can receive the `load` command.
A startup PowerShell/CIM sweep requires a Node/Bun executable, an exact STT or
sticky-note host entrypoint, the model-host marker arguments, and a
`ParentProcessId` equal to the recorded `--core-pid`. It terminates the process
only when that original owning core no longer exists. Shell processes whose
command text happens to contain marker strings are never candidates, and a host
owned by another live server instance is never retired.

The sweep launches the in-box Windows PowerShell 5.1 executable by absolute path
under `SystemRoot` (falling back through `windir` and then `C:\Windows`), never
through `PATH`. A synchronous launch failure, missing executable, timeout, or
non-zero exit emits one warning naming that path. Sweep failure remains
non-fatal so server startup continues in degraded containment mode. Windows
coverage parses the generated command with the in-box PowerShell 5.1 parser
before the sweep contract is accepted.

There remains a PID-reuse window between process creation and assignment because
the launcher does not yet create the process suspended. This is documented, not
claimed as closed.

### POSIX

The host exits on IPC disconnect. Before native loading, a dedicated pure-JavaScript
watchdog worker blocks on fd 5 and acknowledges that it is armed. Loss of the core
closes the pipe and the watchdog sends `SIGKILL` to its own process, including
while the main host thread is blocked in synchronous native inference.

`SIGSTOP` and uninterruptible kernel waits are not covered.

## Lazy policy

- Boot performs download preparation only and spawns no host.
- Expanding a sticky-note card demands and holds the sticky host. Leases heartbeat
  every 30 s and expire after 45 s. With no expanded card, it unloads after 90 s.
- Starting local voice recording sends a rate-limited `voice_warm`. A cold
  transcription also demands the STT host and waits up to 25 s. The STT host
  unloads after 10 minutes idle. External-endpoint STT has no host and is never
  unloaded. Warm requests require an active joined session, share one rate limit
  across all sockets for that session, and cannot extend one warm hold beyond two
  minutes.
- When system free memory falls below 1 GiB (configurable with
  `MODEL_HOST_PRESSURE_FREE_MB`), the core asks both engines to retire. A host
  retires only while `ready`, with no active UI/warm hold and no request in flight.
  Pressure retirement is an intentional unload and never enters core restart or
  shutdown.
- Existing clients already send the application heartbeat but do not send the
  newer dedicated card-lease heartbeat. The server renews expanded-card leases
  from either heartbeat so a page connected across an upgrade remains compatible;
  a silent or half-open connection still expires.

## Compatibility

The existing status enum remains exactly:

`unavailable`, `downloading`, `loading`, `ready`.

Lifecycle state is sent separately as `model_lifecycle_status` only after the
client advertises `model_host_lifecycle`. Idle, unloading, and restarting project
to legacy `ready`, because cold demand is implemented atomically with that
projection. Old pages therefore keep the mic and sticky-note affordances.

## Diagnostics

`GET /api/diagnostics` includes `model_hosts`, one entry per engine, with name,
lifecycle state, legacy status, pid, generation, crash counts, and permanent
failure detail.

## Tests

- `test/model-host.test.js`
- `test/model-host-protocol.test.js`
- `test/model-host-projection.test.js`
- `test/model-host-native-boundary.test.js`
- `test/longevity/process/model-host-isolation.test.js`
- `test/longevity/process/stt-worker-respawn.test.js`
- `test/no-memory-triggered-core-restart.test.js`
