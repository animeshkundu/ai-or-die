# ADR-0031: Deterministic process shutdown (no zombie node/bun processes)

## Status

Accepted — 2026-06-19.

## Context

ai-or-die runs a deep process tree. `bin/supervisor.js` (the top "main" process) forks
`bin/ai-or-die.js` (the server) and restarts it on crash/memory-restart (exit code 75). The
server spawns PTYs via `@lydell/node-pty` (ConPTY on Windows) plus worker threads, tunnel
children, a keepalive helper, and ripgrep. Inside each PTY runs a CLI (claude/codex/gemini)
that spawns **its own** children — MCP servers that are `node`/`bun` processes, ripgrep,
hooks. The server does not own that grandchild layer.

The graceful shutdown path (SIGINT/SIGTERM/IPC) was already mature. The gap was **orphans**:
when the tree was torn down non-gracefully, the CLI's `node`/`bun` grandchildren survived.
Root causes (all verified):

- node-pty's Windows `kill()` (ConPTY path) does not walk the console process list, so the
  CLI's grandchildren outlive a PTY kill.
- `BaseBridge.stopSession()` had no force-kill escalation (it waited 3s then stopped waiting).
- The supervisor force-SIGKILLed the server at 10s while the server's own force-exit was 15s,
  so a hung shutdown killed the server before it could tear down its tree.
- On IPC `disconnect` the server logged "continuing standalone" and kept running — killing
  the supervisor orphaned the whole tree.
- `uncaughtException` exited without tearing down PTYs.

An adversarial design review (multiple independent reviewers across Windows-internals,
POSIX/Node, and scope/maintainability perspectives) shaped the design. Key confirmed facts:

- A Win32 Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates **every** process
  in the job atomically when the last handle closes — even on `taskkill /F` — with no user
  code running. `AssignProcessToJobObject` is forward-looking: future descendants auto-join.
- Current node-pty/ConPTY sets **no** `CREATE_BREAKAWAY_FROM_JOB`, so the shell + its
  `node`/`bun`/`rg` descendants stay in an ancestor job. (Implementation gate: clear the
  job's `BREAKAWAY_OK`, and the grandchild-dies integration test is the live proof.)
- POSIX has no equivalent that survives an uncatchable parent kill short of cgroup v2
  delegation. Process groups + watchdogs are best-effort (`setsid`/daemonized children escape).

## Decision

1. **Windows (primary) — kernel-enforced via Job Objects, held in-process with the koffi FFI.**
   - The **supervisor** creates a kill-on-close job and assigns **itself** before forking the
     server (`bin/supervisor.js`, `src/job-guard.js`). Its whole future tree joins; supervisor
     death by any means closes the in-process handle and the kernel reaps the tree. The job
     persists across server restarts (only supervisor death closes the handle), so the exit-75
     memory restart is unaffected.
   - Each **PTY** gets its own nested kill-on-close job (`src/base-bridge.js`); closing that
     handle on `stopSession`/exit atomically kills the PTY + its grandchildren — deterministic
     per-session teardown that also satisfies "subprocesses restart independently while alive."
   - Held in-process via **koffi** (a vetted FFI), not a separate helper (which would be a
     single point of failure) and not PowerShell (whose `Add-Type`→`csc.exe` is blocked by
     CLM/WDAC/AMSI on hardened corporate boxes — the primary audience).
   - **Degraded mode** (koffi/job create/assign fails: EDR/CLM/silo/outer-job UI limits): start
     anyway, log a prominent warning, surface `jobGuard:false` in `/api/diagnostics`, and fall
     back to best-effort `taskkill /T /F` teardown.

2. **POSIX (best-effort).** PTYs are session leaders (node-pty `forkpty`→`setsid`); teardown
   escalates to a process-group kill (`kill(-pgid, SIGKILL)`) on every controlled path. The
   `setsid`/daemonized-grandchild crash-path gap is documented; cgroup v2 (`systemd-run --user
   --scope -p Delegate=yes`) is the opt-in hard path. The PDEATHSIG/subreaper/getppid stack was
   considered and **cut** as fragile + low-value for a secondary platform.

3. **Cross-cutting.** The server's IPC `disconnect` handler now tears down its PTY trees and
   exits when the supervisor dies (gated on `isShuttingDown` so it never races the exit-75
   restart), replacing "continue standalone." `uncaughtException` reaps PTY subtrees before
   exit. The supervisor hard-kill window was raised to 20s (strictly above the server's 15s
   force-exit) so the server always finishes its own teardown first.

4. **No startup reaper / no PID-identity machinery.** The Job Objects make prior-run orphans
   near-impossible on Windows; on POSIX a reaper can't reach `setsid`'d grandchildren anyway;
   and killing by recorded PID carries PID-reuse wrong-kill risk. Cut.

## Consequences

- **Windows**: the whole tree (server, PTYs, `node`/`bun` MCP grandchildren) dies deterministically
  whenever the supervisor dies, for any reason. Adds one dependency (`koffi`, prebuilt FFI).
- **POSIX**: honest best-effort — solves the grandchild case in the graceful path and the
  in-group crash path; daemonized escapees can survive without cgroup delegation (documented).
- A new native-FFI dependency means SEA-binary packaging must bundle koffi's prebuilt `.node`
  (follow-up; the build already handles node-pty/sherpa/llama natives).
- See `docs/specs/process-shutdown.md` for the mechanism detail, the breakaway re-verification
  gate (re-run on every node-pty upgrade), and the test matrix.
