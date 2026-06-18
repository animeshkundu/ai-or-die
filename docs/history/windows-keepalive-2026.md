# Windows keep-awake: the traps that bit (2026-06)

Context for the next agent who touches `src/keepalive-manager.js`. The feature
holds `SetThreadExecutionState` via a persistent in-box PowerShell helper. See
ADR-0028 and `docs/specs/keepalive.md`. These are the non-obvious failure modes,
all caught in a three-lab plan review before implementation.

## 1. Decimal `[uint32]`, never hex

`SetThreadExecutionState(0x80000001)` looks right but **fails** in Windows
PowerShell 5.1: `0x80000001` is parsed as a negative `Int32`, and converting it
to the method's `uint` parameter throws. Use the decimal literal with an explicit
cast: `[uint32]2147483649`. (`ES_CONTINUOUS 0x80000000 = 2147483648`,
`| ES_SYSTEM_REQUIRED 0x1 = 2147483649`, `| ES_DISPLAY_REQUIRED 0x2 = 2147483651`.)
Verified on a real Windows host.

## 2. `Add-Type` zombie under Constrained Language Mode / WDAC / EDR

In PS 5.1 `Add-Type` is not in-memory FFI: it writes a `.cs` to `%TEMP%` and
shells to `csc.exe`. AppLocker / WDAC / CLM / EDR commonly block that. With the
default `$ErrorActionPreference = 'Continue'`, a blocked `Add-Type` does **not**
stop the script — `[W.P]` is undefined, the `OK` is skipped, and PowerShell
proceeds straight into `while ($null -ne [Console]::In.ReadLine()) {}`. Result: a
useless ~30-50MB `powershell.exe` blocked on stdin **forever**, one new zombie per
server restart. Fix: prefix the script with `$ErrorActionPreference = 'Stop'` so
the child terminates immediately, the readiness promise resolves `false`, and the
`exit` handler reaps it.

## 3. A long-lived hidden `powershell.exe` + `DllImport` looks like malware

Hidden `powershell.exe` spawned by `node.exe`, `Add-Type`-ing a `kernel32`
`DllImport` via `-Command`, trips several EDR heuristics and AMSI scans
(CrowdStrike, SentinelOne, Defender ASR). It may be killed before `OK`. That is
acceptable and expected — but it must be **visible**, not silent. On readiness
failure the server logs a `warn` line (with the first stderr line as a hint) so
the operator knows the machine may sleep. Do not downgrade that to `debug`.

## 4. `unref()` stdin too — or risk the exit-134 class

Earlier reasoning kept the child's stdin **referenced** "so `release()` can end
it." That is wrong: `unref()` does not affect a stream's writability. A
*referenced* stdin pipe is a live libuv handle that can hold the event loop open
and revive this repo's documented native-teardown abort (SIGABRT / exit 134, see
`ctrl-c-native-worker-sigabrt-2026.md`). Unref the child **and** all three stdio
streams; you can still `.end()`/`.destroy()` an unref'd stdin in `release()`.

## 5. Release must cover the `process.exit(1)` paths that skip `close()`

`uncaughtException` (`server.js`) and the `bin/ai-or-die.js` outer catch both call
`process.exit(1)` **without** `close()`, so a release placed only in `close()`
would be skipped. Do **not** add a second SIGINT/SIGTERM handler to compensate —
that is exactly the competing-handler shutdown race the server was refactored to
avoid. Instead, the manager installs a synchronous `process.once('exit', …)` hook
(it only closes a pipe; not a signal handler, cannot race `handleShutdown`).
Release is layered: `close()` (graceful) + force-exit-timer `releaseSync()` +
`exit` hook + stdin-EOF (hard kill).

## 6. Release at the END of `close()`, not the top

`close()` begins with `await saveSessionsToDisk(true)` then multi-second native
teardown. Releasing the assertion first lets an already-idle laptop sleep
mid-flush — the exact data-loss window the feature exists to prevent. Release
last.

## 7. Crash-restart double-assertion is harmless

On a supervisor restart the old helper's EOF-exit races the new helper's spawn,
so two assertions can briefly coexist. Windows stays awake while any assertion
lives, so this is benign. The command line carries `# aod-keepalive ppid=<pid>`
so a genuinely *leaked* (not merely overlapping) helper is identifiable via
`Get-CimInstance Win32_Process`.

## 8. Modern Standby (S0) is not covered

`ES_SYSTEM_REQUIRED` stops classic S3/S4 sleep, not S0 low-power idle on
post-2020 laptops. Don't claim the feature guarantees connectivity on those
machines; it can't without an OS-level Modern Standby change.
