# Spec: Keep-Awake (prevent OS sleep while the server runs)

Holds a Windows power assertion for the lifetime of the ai-or-die server so the
host does not sleep mid-session. See ADR-0028 for rationale and rejected options.

## Components

| File | Role |
|------|------|
| `src/keepalive-manager.js` | `KeepaliveManager` class. Builds the PowerShell script/argv, spawns + supervises the helper, exposes `start()` / `release()` / `releaseSync()`. Windows-only; instant no-op elsewhere. No dependencies (Node `child_process` only). |
| `bin/ai-or-die.js` | `--no-keepalive` / `--keepalive-display` flags → `keepalive` / `keepaliveDisplay` in `serverOptions`. |
| `src/server.js` | Constructs the manager (gated `!underTest`), `start()` once listening, `releaseSync()` at the end of `close()` and in the `handleShutdown` force-exit timer. |

## Mechanism

One long-lived `powershell.exe` (Windows PowerShell 5.1, in-box) runs:

```powershell
$ErrorActionPreference = 'Stop'
# aod-keepalive ppid=<parent pid>
Add-Type -Name P -Namespace W -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint e);'
if ([W.P]::SetThreadExecutionState([uint32]2147483649) -ne 0) { [Console]::Out.WriteLine('OK'); [Console]::Out.Flush() }
while ($null -ne [Console]::In.ReadLine()) {}
[void][W.P]::SetThreadExecutionState([uint32]2147483648)
```

Spawned via the absolute path `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <script>`,
`windowsHide: true`, `shell: false`, `stdio: ['pipe','pipe','pipe']`.

- Prints `OK` once the assertion is held (parent readiness signal), then blocks
  on stdin. Closing stdin (release) **or** parent death (pipe closes → EOF)
  clears the assertion and exits.
- The child and all three stdio streams are `unref()`'d so the helper can never
  keep the parent's event loop alive (`unref()` does not affect stdin
  writability, so `release()` can still `.end()` it).

### Flags (decimal `[uint32]`, never hex)

| Value | Meaning |
|-------|---------|
| `2147483649` | `ES_CONTINUOUS \| ES_SYSTEM_REQUIRED` — system-awake (default) |
| `2147483651` | `+ ES_DISPLAY_REQUIRED` — also keep the display on (`--keepalive-display`) |
| `2147483648` | `ES_CONTINUOUS` alone — clear the assertion |

Hex `0x80000001` is misparsed as a negative `Int32` in PS 5.1 and the `[uint32]`
cast throws — the decimal forms are mandatory.

## Configuration

| Flag | Env | Default | Effect |
|------|-----|---------|--------|
| `--no-keepalive` | `AIORDIE_DISABLE_KEEPALIVE=1` | enabled | Disable entirely. |
| `--keepalive-display` | `AIORDIE_KEEPALIVE_DISPLAY=1` | off | Also keep the display on. |

The disable env var is checked in **both** `bin/ai-or-die.js` (CLI wiring) and
the `server.js` constructor — deliberate belt-and-suspenders so the feature is
off regardless of which layer constructs the server. The constructor also gates
on `underTest`, so `mocha` never spawns the helper.

## Lifecycle & release coverage

Acquire: in `start()`, inside the `server.listen` success callback, right after
`this.server = server`. Fire-and-forget; never throws.

Release is layered so every exit path drops the assertion:

1. **`close()`** — `releaseSync()` runs LAST (after the session-save flush and
   native-engine teardown) so an already-idle laptop cannot sleep mid-flush.
2. **Force-exit timer** — `releaseSync()` in the `handleShutdown` 15s timeout, in
   case `close()` hangs.
3. **`process.once('exit')`** — a synchronous hook installed on first `start()`,
   covering the paths that call `process.exit(1)` without `close()`
   (`uncaughtException`, the `bin` outer catch). It only closes a pipe and is
   **not** a signal handler, so it cannot race the single `handleShutdown` owner.
4. **stdin-EOF** — on `SIGKILL` / `taskkill /F` the OS closes the pipe and the
   helper self-exits; Windows also drops the flags on process death.

All release entry points are idempotent and no-ops when keepalive was never
started.

## Graceful degradation & known limitations

- **WDAC / Constrained Language Mode / AppLocker / AV-EDR** can block `Add-Type`
  or kill a hidden `powershell.exe` doing `DllImport`. The helper then exits
  before `OK`; the server logs a **warn**-level line
  (`⚠  keepalive: could not hold the wake assertion; the machine may sleep
  (<hint>). Disable with --no-keepalive.`) with the first stderr line as the
  hint, and continues normally. `$ErrorActionPreference='Stop'` plus an explicit
  `exit 1` when `SetThreadExecutionState` returns 0 ensure a blocked/refused
  helper dies instead of leaking; a helper that times out without exiting is
  reaped.
- **Loss after acquire.** If the helper dies *after* a successful `OK` (e.g. an
  AV/EDR kill hours into a run), the server logs a distinct **warn**
  (`wake assertion lost — the helper exited`). Recovery is manual (restart
  ai-or-die); the feature does not auto-respawn, since an EDR that killed it once
  would just kill the replacement in a loop.
- **Modern Standby (S0 low-power idle)** — on most post-2020 laptops
  `ES_SYSTEM_REQUIRED` prevents classic S3/S4 sleep but not S0 idle, where the
  CPU throttles and NICs may power down (connections can still drop). To fully
  prevent this the operator must disable Modern Standby at the OS level; out of
  scope for this feature.

## Manual verification (Windows 11)

```text
node bin/ai-or-die.js
# in another shell:
powercfg /requests        # SYSTEM: shows a [PROCESS] ...\powershell.exe entry
# Ctrl+C the server, re-run powercfg /requests -> entry is gone.

# --keepalive-display adds a DISPLAY: entry.
# --no-keepalive / AIORDIE_DISABLE_KEEPALIVE=1 -> no entry, no helper spawned.

# Hard-kill check:
taskkill /F /PID <node pid>
powercfg /requests        # SYSTEM entry clears within ~seconds (stdin EOF)
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'"   # no 'aod-keepalive' orphan
```

## Tests

`test/keepalive.test.js` (mocha) — injected `platform` / `spawn` / `logger` +
fake child, so the Windows logic is exercised on macOS/Linux CI without
PowerShell: script/argv generation (decimal flags, `Stop`, ppid tag, absolute
path), platform + enabled gating, readiness (OK / early-exit / timeout), the
visible warning, stdio unref, idempotency + the double-helper race, and
`release()` safety. Plus a real-process integration test proving a stdin-blocking
helper exits when its parent process is killed (the C1 EOF-on-death invariant).
