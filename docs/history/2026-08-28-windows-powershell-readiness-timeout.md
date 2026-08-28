# Windows PowerShell Shell-Integration Readiness Timeout

## What Happened

A Windows PowerShell terminal could start without live CWD tracking even though
the session-scoped shell integration shim was valid. The readiness wait in
`TerminalBridge` used the same two-second deadline as POSIX shells. Cold
PowerShell/ConPTY startup can exceed that deadline, so the bridge discarded the
integrated attempt and respawned a vanilla shell.

## Root Cause

`src/terminal-bridge.js` hardcoded a two-second deadline and a 25 ms polling
sleep in `_waitForShellIntegration`. The deadline did not distinguish the
slower Windows PowerShell startup path from POSIX shells. Inline `Date.now()`
and `setTimeout()` calls also made delayed-ready, timeout, and early-exit cases
awkward to test deterministically.

## Fix

Use private named readiness constants and select the timeout only when both the
bridge is on Windows and the prepared integration kind is `powershell`: two
seconds for POSIX/non-PowerShell integrations and ten seconds for Windows
PowerShell. Keep the 25 ms polling interval, and pass an optional method-level
`{ now, sleep }` clock object to `_waitForShellIntegration` so unit tests can
drive readiness without real delays.

The real Windows PowerShell OSC 7 assertions remain unchanged. The integration
helper's `terminal_started` wait remains 10 seconds by default, while the
cross-platform `pwsh` case uses 20 seconds only on Windows and the Windows-only
`powershell.exe` case uses 20 seconds. Prompt-output waits remain 10 seconds,
and CWD waits remain 15 seconds.

## Watch For

Keep the Windows PowerShell timeout finite and scoped to the readiness sentinel.
Do not widen POSIX readiness or remove the fallback path. Tests that exercise
startup timing should use the deterministic `{ now, sleep }` clock object rather
than arbitrary sleeps, and real-shell tests should retain their destination and
canonical-path OSC 7 assertions.
