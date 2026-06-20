# Spec: Deterministic process shutdown

Status: implemented (2026-06-19). See ADR-0031.

Goal: **no live orphaned `node`/`bun` processes.** When the top process (the supervisor)
dies for ANY reason — Ctrl+C, crash, `taskkill /F`, SIGKILL, console close — the entire
descendant tree (server, PTYs, and the CLI's MCP `node`/`bun` grandchildren) must die. While
the system is alive, individual subprocesses (tunnels, workers, the server itself) keep
restarting independently; only top-process death brings everything down.

("Zombie" here means a *live orphan*, not a POSIX `<defunct>` entry — those are auto-reaped
by init/launchd.)

## Mechanism

### Windows (primary) — Job Objects (`src/job-guard.js`, koffi FFI)

`src/job-guard.js` wraps the Win32 job APIs via `koffi`:
- `createKillOnCloseJob()` — `CreateJobObjectW` + `SetInformationJobObject`
  (`JOBOBJECT_EXTENDED_LIMIT_INFORMATION` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`;
  `BREAKAWAY_OK` deliberately **off**). Non-inheritable handle.
- `assignSelf(job)` — `AssignProcessToJobObject(GetCurrentProcess())`.
- `assignPid(job, pid)` — `OpenProcess(PROCESS_TERMINATE|PROCESS_SET_QUOTA)` → assign → close
  the process handle (not the job).
- `closeJob(job)` — `CloseHandle`; on a kill-on-close job this is the teardown trigger.

No-op on non-Windows and whenever koffi is unavailable. Never throws into the caller.

**Two jobs:**
1. **Supervisor-level** (`bin/supervisor.js`): created and self-assigned **before** the first
   `startServer()` fork, so the server and every future descendant auto-join. The handle is
   held for the supervisor's life and **never closed by us** — process death closes it, firing
   `KILL_ON_JOB_CLOSE`. Persists across server restarts (only supervisor death closes it).
2. **Per-PTY nested** (`src/base-bridge.js`): each PTY is assigned to its own kill-on-close job
   right after spawn (before the CLI boots, so the CLI's future grandchildren auto-join).
   `stopSession`, natural exit, the error path, and the spawn-watchdog all close the handle →
   the PTY + its grandchildren die atomically; the handle is freed.

   *Natural-exit behavior (intentional):* when a PTY exits on its own, `_disposePtyJob` still
   closes the job, which reaps any descendants the CLI left running (e.g. detached MCP/helper
   `node`/`bun` processes). This is a deliberate change from the prior behavior where such
   descendants survived the PTY — the goal is no orphans.
   the assignment. A child the shell spawns in the sub-tick between node-pty's `spawn()` and
   `_attachPtyJob` would miss the per-PTY job. In practice the PTYs run interactive CLIs that
   take seconds to boot before spawning MCP servers, so the window is empty; and any escapee is
   still in the **supervisor** job, so it dies on supervisor death regardless. The per-PTY job is
   per-session convenience + defense in depth, not the primary guarantee.

**Degraded mode**: the deterministic kernel guarantee needs koffi + a usable Job Object. When
that's unavailable — koffi fails to load (e.g. the **SEA single-file binary**, where koffi is
left as an external runtime require and there is no `node_modules`), `AssignProcessToJobObject`
is denied (EDR / Constrained Language Mode / Server Silo / outer-job UI limits), or the operator
sets `AOD_DISABLE_JOB_GUARD=1` — `isAvailable()` returns false and **every** teardown path falls
back to the best-effort `src/utils/process-tree.js` helper: `taskkill /T /F /PID` on Windows, a
`kill(-pgid)` process-group kill on POSIX. This fires on the spawn-watchdog, error, `stopSession`,
`uncaughtException`, and IPC-disconnect paths (gated on "no job was closed", so it never
double-kills when the kernel job already reaped the subtree). The supervisor logs a prominent
warning and the server reports `process_guard.job_guard_active=false` in `/api/diagnostics`.

> **SEA binary note:** `sea-bootstrap.js` runs `bin/ai-or-die.js` **directly** (no supervisor),
> and koffi is externalized out of the bundle, so the packaged binary always runs in degraded
> mode: best-effort `taskkill` teardown on the paths it controls, no kernel guarantee against an
> uncatchable kill. Wiring full koffi-in-SEA (extracting `@koromix/koffi-<platform>-<arch>` as a
> SEA asset + a load shim, mirroring `pty-sea-shim.js`) is a tracked follow-up. The npm-install
> path (the supervisor + koffi) gets the full kernel guarantee.

### POSIX (best-effort)

node-pty PTYs are session leaders (`forkpty`→`setsid`), so teardown escalates with
`kill(-pgid, SIGKILL)` (`src/utils/process-tree.js`) on the spawn-watchdog, error, and
`stopSession`-timeout paths. This reaches grandchildren that stayed in the group.

**Honest limitation**: a grandchild that calls `setsid()` / daemonizes starts its own group
and escapes `kill(-pgid)`. After a server crash there is no record of its pid, so it can
survive. The only airtight POSIX option is cgroup v2 `cgroup.kill`, which needs a delegated
subtree — launch via `systemd-run --user --scope -p Delegate=yes` to get one. macOS has no
PDEATHSIG and no cgroups; daemonized grandchildren can survive there.

### Cross-cutting

- **Supervisor-death watchdog** (`src/server.js`): the IPC `disconnect` handler, when
  `isShuttingDown` is false, reaps all PTY subtrees and shuts the server down (replacing the
  old "continue standalone"). On Windows the kernel job usually kills the server first; this is
  the cross-platform / degraded-mode backstop. Gated on `isShuttingDown` so it never fires
  during the legitimate exit-75 memory restart (where the channel close is expected).
- **uncaughtException** (`src/server.js`): synchronously reaps PTY subtrees before `exit(1)`.
- **Timeout ordering**: supervisor hard-kill window = 20s (`SHUTDOWN_TIMEOUT_MS`), strictly
  greater than the server's 15s force-exit, so the server always completes its own teardown.

## Re-verification gate (run on every node-pty upgrade)

The Windows guarantee depends on nothing in the tree setting `CREATE_BREAKAWAY_FROM_JOB`.
- Grep the vendored native source/binary for `CREATE_BREAKAWAY_FROM_JOB` / `0x01000000`.
- The job sets `BREAKAWAY_OK` off, so a breakaway *request* is ignored.
- `test/longevity/process/job-tree-kill.test.js` (a real grandchild that must die) is the live
  proof; treat its failure after an upgrade as "node-pty reintroduced breakaway."

## Tests

- `test/job-guard.test.js` — unit: non-win32 no-op; on win32, create+assign+close kills an
  assigned child (proves koffi struct marshaling + KILL_ON_JOB_CLOSE).
- `test/process-tree.test.js` — unit: taskkill arg shape + POSIX group-kill order (injected mocks).
- `test/longevity/process/job-tree-kill.test.js` — per-PTY job close kills a grandchild; an
  uncatchable `taskkill /F` of a self-assigned parent reaps a grandchild. (Windows; skips elsewhere.)
- `test/longevity/process/supervisor-tree-kill.test.js` — the real `bin/supervisor.js`: an
  uncatchable `taskkill /F` of the supervisor reaps its forked child via the job. (Windows.)

## Files

- `src/job-guard.js` — koffi Win32 job wrappers (no-op off win32).
- `src/utils/process-tree.js` — `taskkill /T /F` (Windows degraded) + `kill(-pgid)` (POSIX).
- `bin/supervisor.js` — supervisor job self-assign before fork; 20s shutdown timeout.
- `src/base-bridge.js` — per-PTY job attach/close across all teardown paths; POSIX pgid escalation.
- `src/server.js` — IPC `disconnect` watchdog, `uncaughtException` reap, `process_guard` diagnostics.
