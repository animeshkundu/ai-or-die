# ADR-0054: Platform-Specific Shell-Integration Readiness

## Status

**Accepted**

## Date

2026-08-28

## Context

ADR-0050 used one two-second readiness deadline for every session-scoped shell
wrapper. That is sufficient for POSIX shells, but a cold Windows PowerShell /
ConPTY startup can take longer before the shim writes its readiness sentinel.
The wrapper could therefore be healthy while `TerminalBridge` timed it out and
respawned a vanilla shell, leaving the Windows terminal without live CWD
tracking.

The readiness loop also used inline wall-clock and sleep calls, which made the
boundary between delayed readiness, timeout, and early exit difficult to test
deterministically.

## Decision

`TerminalBridge` keeps the timeout constants private and selects the readiness
window in `_getShellIntegrationReadyTimeoutMs(integration)`:

- POSIX shells and non-PowerShell integrations use
  `SHELL_INTEGRATION_READY_TIMEOUT_MS` (2,000 ms).
- Windows PowerShell integrations use
  `WINDOWS_POWERSHELL_READY_TIMEOUT_MS` (10,000 ms).
- Polling uses `SHELL_INTEGRATION_READY_POLL_MS` (25 ms) on every platform.

The longer window requires both `this.isWindows === true` and
`integration.kind === 'powershell'`. The readiness loop continues to return
`ready`, `exited`, or `timed_out`, checks session liveness, and falls back as
specified by ADR-0050.

`_waitForShellIntegration` accepts an optional method-level `{ now, sleep }`
clock object. Production defaults remain `Date.now` and a Promise around
`setTimeout`; focused tests inject deterministic implementations without
spawning shells or waiting on wall-clock time. The public module export remains
`module.exports = TerminalBridge`; constants and the selector are not exported.

## Consequences

### Positive

- Cold Windows PowerShell startup has a finite, platform-specific allowance
  without weakening POSIX startup failure detection.
- A genuinely hung wrapper still reaches the existing vanilla-shell fallback.
- Delayed readiness, timeout, and natural exit are covered deterministically.
- Existing OSC 7 parsing, output buffering, cancellation, and fallback behavior
  remain unchanged.

### Negative

- A hung Windows PowerShell wrapper can delay fallback by up to ten seconds.
- The private readiness method has a small optional test seam.

### Neutral

- The real-shell integration helper keeps its default `terminal_started` wait
  at 10 seconds. The cross-platform `pwsh` case uses 20 seconds only on
  Windows, and the Windows-only `powershell.exe` case uses 20 seconds. Their
  prompt-output waits remain 10 seconds and their CWD waits remain 15 seconds.
- No terminal copy behavior, retry policy, skip policy, or assertion strictness
  changes.

## Notes

- Supersedes the readiness-timing sentence in [ADR-0050](0050-session-scoped-shell-integration.md);
  ADR-0050 remains authoritative for the rest of session-scoped integration.
- The behavior is specified in [docs/specs/bridges.md](../specs/bridges.md).
- The regression record is [docs/history/2026-08-28-windows-powershell-readiness-timeout.md](../history/2026-08-28-windows-powershell-readiness-timeout.md).
