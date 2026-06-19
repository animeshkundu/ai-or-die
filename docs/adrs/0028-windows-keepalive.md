# 0028 - Keep the machine awake while the server runs (Windows)

## Status

Accepted (2026-06).

## Context

When ai-or-die runs unattended (long agent sessions, an open dev tunnel, remote
browser access), Windows 11 can put the host to sleep on its idle timer and drop
every live session, WebSocket, and tunnel. We want the machine to stay awake for
as long as the server process is alive and to release the instant it exits.
Windows is the primary deployment target, so the active mechanism leads with
Windows 11; macOS/Linux are a no-op (their default power behavior is acceptable
for the dev/secondary case, and the sister project that this is ported from is
Windows-only).

The OS primitive is `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`
from `kernel32.dll`: while held, the system idle timer cannot sleep the machine.
The assertion is per-thread and lives only while the asserting thread lives, so
it must be held by a long-lived thread for the server's whole lifetime.

Options considered for invoking it from a Node app:

1. **`powercfg.exe`** — does not expose `SetThreadExecutionState`; `powercfg
   /requests` only *reports* assertions. Rejected: cannot acquire.
2. **A bundled native helper `.exe`** — under Windows Defender Application
   Control (WDAC) / code-integrity policy an unsigned binary is refused. Rejected:
   breaks on exactly the locked-down enterprise machines we must support, and
   adds a signed-binary build/release burden.
3. **Native FFI (koffi / ffi-napi)** — adds a native npm addon to a project that
   deliberately keeps its native surface minimal (node-pty, ggml workers) and has
   a documented history of native-teardown aborts (SIGABRT/exit-134). Rejected.
4. **Persistent in-box PowerShell P/Invoke (chosen)** — spawn one long-lived
   Windows PowerShell 5.1 (`powershell.exe`, ships in-box on Windows 11) that
   `Add-Type`s a one-line `DllImport` of `SetThreadExecutionState`, holds the
   assertion, and blocks on stdin. No new dependencies; nothing to sign.

## Decision

Spawn one helper at server start (once `server.listen` succeeds), release it in
`close()` after the session-save flush. The helper holds the assertion on its
main pipeline thread, prints `OK` as a readiness signal, then blocks on
`[Console]::In.ReadLine()`. Closing the child's stdin (graceful release) **or**
the parent dying (the OS tears down the anonymous pipe → `ReadLine()` returns
null) makes it clear the assertion and exit. Windows also drops a thread's
execution-state flags when the holding process dies, so even `taskkill /F`
cannot leak the assertion past reboot.

Key properties:

- **Default-on, Windows-only.** Disable with `--no-keepalive` /
  `AIORDIE_DISABLE_KEEPALIVE=1`. Instant no-op on macOS/Linux. Also disabled
  under `mocha` (`underTest`) and in CI (`CI` / `GITHUB_ACTIONS`): a headless CI
  session can't hold the assertion, and the startup `powershell.exe` spawn races
  node-pty's ConPTY setup on Windows (it flaked the binary smoke test). System-awake
  only (`ES_SYSTEM_REQUIRED`, decimal `2147483649`); `--keepalive-display` /
  `AIORDIE_KEEPALIVE_DISPLAY=1` adds `ES_DISPLAY_REQUIRED` (`2147483651`).
- **Decimal `[uint32]` flag literals, never hex.** In Windows PowerShell 5.1
  `0x80000001` parses as a negative `Int32` and the `[uint32]` cast throws;
  `[uint32]2147483649` is correct. Verified on a real Windows host.
- **`$ErrorActionPreference = 'Stop'` is load-bearing.** `Add-Type` in PS 5.1
  writes a `.cs` to `%TEMP%` and shells to `csc.exe` — a pattern WDAC /
  Constrained Language Mode (CLM) / AppLocker / EDR frequently block. Without
  `Stop`, a blocked `Add-Type` does not exit; PowerShell falls into the infinite
  stdin loop and leaks an immortal process on every restart. `Stop` makes the
  child die immediately so the readiness promise resolves `false` and our exit
  handler reaps the reference.
- **Visible degradation, not silent assumed-success.** The same WDAC/CLM that
  blocks an unsigned `.exe` (option 2) can also block `Add-Type` P/Invoke. So
  when readiness fails (timeout / early exit / spawn error) the server logs a
  `warn`-level line (matching the existing STT/HTTPS startup warnings), with the
  first stderr line as a hint, rather than assuming the assertion is held.
- **Absolute interpreter path + `-ExecutionPolicy Bypass`.** Resolve
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (PATH-hijack
  hardening) and bypass GPO machine-wide execution policy for the inline command.
- **No second signal handler.** The server already owns SIGINT/SIGTERM via a
  single `handleShutdown`; adding another competing handler reintroduced the
  documented SIGABRT/exit-134 shutdown race. Release is layered instead:
  `close()` (graceful) + a `releaseSync()` in the 15s force-exit timer (hang) +
  a synchronous `process.once('exit')` hook (the `process.exit(1)` paths that
  skip `close()`: `uncaughtException` and the `bin` outer catch) + stdin-EOF
  (hard kill). The `exit` hook only closes a pipe; it is not a signal handler and
  cannot race `handleShutdown`.

## Consequences

- No new runtime dependencies; nothing to code-sign.
- On WDAC/CLM/AppLocker/EDR machines the feature degrades to a visible warning
  and the host may sleep — an inherent limit of any in-process approach short of
  a signed driver/service. Documented in `docs/specs/keepalive.md`.
- `ES_SYSTEM_REQUIRED` prevents classic S3/S4 sleep but **not** Modern Standby
  (S0 low-power idle) on post-2020 laptops, where the CPU still throttles and
  NICs may power down. Documented as a known limitation; out of scope to fix here.
- A brief double-assertion can occur across a supervisor restart (old helper's
  EOF-exit races the new helper's spawn). Harmless: Windows stays awake while any
  assertion lives. The command line is tagged `# aod-keepalive ppid=<pid>` so a
  genuinely stale helper is identifiable for triage.
