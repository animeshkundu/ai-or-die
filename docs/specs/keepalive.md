# Spec: Keep-Awake (prevent OS sleep while the server runs)

Holds two redundant Windows power assertions for the lifetime of the ai-or-die
server so the host does not sleep mid-session. One of them is a named
`PowerCreateRequest` carrying the reason string `GitHub Copilot CLI session
active` (byte-identical to what the GitHub Copilot CLI `/keep-alive` registers),
so `powercfg /requests` reads as Copilot. See ADR-0028 (original design) and
**ADR-0029 (current mechanism, supersedes 0028)** for rationale and rejected
options.

## Components

| File | Role |
|------|------|
| `src/keepalive-manager.js` | `KeepaliveManager` class. Builds the PowerShell script/argv, spawns + supervises the helper, exposes `start()` / `release()` / `releaseSync()`. Windows-only; instant no-op elsewhere. No dependencies (Node `child_process` only). |
| `bin/ai-or-die.js` | `--no-keepalive` / `--keepalive-display` flags → `keepalive` / `keepaliveDisplay` in `serverOptions`. |
| `src/server.js` | Constructs the manager (gated `!underTest`), `start()` once listening, `releaseSync()` at the end of `close()` and in the `handleShutdown` force-exit timer. |

## Mechanism

One long-lived `powershell.exe` (Windows PowerShell 5.1, in-box) holds **two
redundant kernel32 power assertions**, then blocks on stdin:

```powershell
$ErrorActionPreference = 'Stop'
# aod-keepalive ppid=<parent pid>
Add-Type -Name P -Namespace W -MemberDefinition '<REASON_CONTEXT struct + 4 kernel32 P/Invokes>'
$held = $false
# (1) legacy per-thread assertion (unnamed in powercfg /requests)
if ([W.P]::SetThreadExecutionState([uint32]2147483649) -ne 0) { $held = $true }
# (2) named power request -- the "GitHub Copilot CLI session active" entry
$ctx = New-Object 'W.P+REASON_CONTEXT'
$ctx.Version = 0
$ctx.Flags = 1                                      # POWER_REQUEST_CONTEXT_SIMPLE_STRING
$ctx.Reason = 'GitHub Copilot CLI session active'
$h = [W.P]::PowerCreateRequest([ref]$ctx)
$hv = $h.ToInt64()
$power = $false
if ($hv -ne 0 -and $hv -ne -1) { if ([W.P]::PowerSetRequest($h, 1)) { $held = $true; $power = $true } }
if (-not $held) { [Console]::Error.WriteLine('...both failed'); exit 1 }
[Console]::Out.WriteLine('OK'); [Console]::Out.Flush()
while ($null -ne [Console]::In.ReadLine()) {}
[void][W.P]::SetThreadExecutionState([uint32]2147483648)   # clear STES
if ($power) { [void][W.P]::PowerClearRequest($h, 1) }      # clear the request
if ($hv -ne 0 -and $hv -ne -1) { [void][W.P]::CloseHandle($h) }
```

The named request (2) uses the **exact** API and reason string of the GitHub
Copilot CLI `/keep-alive` (confirmed by disassembling its `cli-native.node`), so
`powercfg /requests` shows a byte-identical `GitHub Copilot CLI session active`
line. The holding process is still `powershell.exe` — it cannot be renamed; only
the reason string is Copilot's. Holding both assertions is deliberate
belt-and-suspenders (see ADR-0029).

Spawned via the absolute path `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <script>`,
`windowsHide: true`, `shell: false`, `stdio: ['pipe','pipe','pipe']`.

- Prints `OK` once **at least one** assertion is held (parent readiness signal),
  then blocks on stdin. Closing stdin (release) **or** parent death (pipe closes
  → EOF) clears both assertions and exits. `exit 1` (→ readiness false → visible
  warn) only when **both** are refused.
- The child and all three stdio streams are `unref()`'d so the helper can never
  keep the parent's event loop alive (`unref()` does not affect stdin
  writability, so `release()` can still `.end()` it).

### SetThreadExecutionState flags (decimal `[uint32]`, never hex)

| Value | Meaning |
|-------|---------|
| `2147483649` | `ES_CONTINUOUS \| ES_SYSTEM_REQUIRED` — system-awake (default) |
| `2147483651` | `+ ES_DISPLAY_REQUIRED` — also keep the display on (`--keepalive-display`) |
| `2147483648` | `ES_CONTINUOUS` alone — clear the assertion |

Hex `0x80000001` is misparsed as a negative `Int32` in PS 5.1 and the `[uint32]`
cast throws — the decimal forms are mandatory.

### Power request (named, Copilot-identical)

`PowerCreateRequest` → `PowerSetRequest(type)` → `PowerClearRequest(type)` +
`CloseHandle`, with a `REASON_CONTEXT` marshalled `Sequential`/`Unicode`
(`Version = 0`, `Flags = 1` = `POWER_REQUEST_CONTEXT_SIMPLE_STRING`,
`SimpleReasonString = "GitHub Copilot CLI session active"` as an `LPWStr`).

| `POWER_REQUEST_TYPE` | Value | When |
|----------------------|-------|------|
| `PowerRequestSystemRequired` | `1` | always (default) |
| `PowerRequestDisplayRequired` | `0` | added by `--keepalive-display` |

Small ints, so no hex/`Int32` hazard. `PowerCreateRequest` returns `NULL` /
`INVALID_HANDLE_VALUE` (-1) on failure — both are handled before `PowerSetRequest`.

## Configuration

| Flag | Env | Default | Effect |
|------|-----|---------|--------|
| `--no-keepalive` | `AIORDIE_DISABLE_KEEPALIVE=1` | enabled | Disable entirely. |
| `--keepalive-display` | `AIORDIE_KEEPALIVE_DISPLAY=1` | off | Also keep the display on. |

The disable env var is checked in **both** `bin/ai-or-die.js` (CLI wiring) and
the `server.js` constructor — deliberate belt-and-suspenders so the feature is
off regardless of which layer constructs the server. The constructor also gates
on `underTest`, so `mocha` never spawns the helper, **and on `CI`** (GitHub
Actions / most CIs set `CI=true`), so CI server processes — the binary smoke
test, browser e2e, longevity soak — never spawn the helper either: a headless CI
session can't hold the assertion anyway, and the startup spawn races node-pty's
ConPTY console setup on Windows. The `CI` gate lives in the server, not in
`KeepaliveManager`, so the unit tests still exercise the win32 logic directly.

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
# in an ELEVATED shell (powercfg /requests needs admin to show entries):
powercfg /requests
#   SYSTEM:
#   [PROCESS] \Device\...\powershell.exe
#   GitHub Copilot CLI session active     <- the named PowerSetRequest (Copilot-identical)
#   [PROCESS] \Device\...\powershell.exe  <- the SetThreadExecutionState net (no reason text)
# Ctrl+C the server, re-run powercfg /requests -> both entries are gone.

# --keepalive-display adds DISPLAY: entries (STES +ES_DISPLAY_REQUIRED and
#   PowerRequestDisplayRequired).
# --no-keepalive / AIORDIE_DISABLE_KEEPALIVE=1 -> no entry, no helper spawned.

# Hard-kill check:
taskkill /F /PID <node pid>
powercfg /requests        # both entries clear within ~seconds (stdin EOF / process death)
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'"   # no 'aod-keepalive' orphan
```

## Tests

`test/keepalive.test.js` (mocha) — injected `platform` / `spawn` / `logger` +
fake child, so the Windows logic is exercised on macOS/Linux CI without
PowerShell: script/argv generation (both mechanisms — STES decimal flags AND the
`PowerCreateRequest`/`PowerSetRequest` request with the `GitHub Copilot CLI
session active` reason string, `Flags=1`, system=1/display=0 request types,
release + `CloseHandle`; `Stop`, ppid tag, absolute path), platform + enabled
gating, readiness (OK / early-exit / timeout), the visible warning, stdio unref,
idempotency + the double-helper race, and `release()` safety. Plus a real-process
integration test proving a stdin-blocking helper exits when its parent process is
killed (the C1 EOF-on-death invariant).
