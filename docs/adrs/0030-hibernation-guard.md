# 0030 - Opt-in hibernation guard for host-initiated sleep (Hyper-V)

## Status

Accepted (2026-07). Complements ADR-0029 (the keepalive wake assertion); does not
supersede it. Both ship together in the keepalive feature.

## Context

The keepalive assertion (ADR-0028 → ADR-0029) holds `ES_SYSTEM_REQUIRED` /
`PowerRequestSystemRequired`, which suppress only the **idle timer**. Power logs on
the deployment host (a Hyper-V guest) showed repeated sleep events initiated
through the **Application API** by the host's Guest Shutdown Service
(`vmicshutdown`) requesting **hibernation** — not idle sleep. Microsoft documents
that `SetThreadExecutionState` *"cannot be used to prevent ... standby or
hibernate"* for a programmatic suspend, so the assertion **provably cannot** block
this vector.

The only reliable fix is to remove the sleep target itself: `powercfg /hibernate
off` (+ sleep/hibernate timeouts → Never). Verified on the host — afterwards
Windows reports no sleep or hibernate states available. On a Hyper-V guest, S3
standby is typically unavailable, so disabling S4 hibernate eliminates the vector.
This requires **elevation** (admin) and is **persistent** (survives the process
exit), which is a fundamentally different operation than the runtime lease the
keepalive holds.

## Decision

Add `HibernationGuard` (`src/hibernation-guard.js`), **OFF by default**, gated by
`--disable-hibernation` / `AIORDIE_DISABLE_HIBERNATION=1`. One-shot at server start
(Windows only; skipped under `underTest` / `CI`, same as keepalive). One long-lived
in-box `powershell.exe` (spawned like the keepalive helper) runs:

1. **Non-privileged detect** — read `HKLM\SYSTEM\CurrentControlSet\Control\Power\
   HibernateEnabled`. If `0`, print `SKIPPED` and exit — **no UAC**. A machine that
   is already configured never prompts again.
2. **Elevate only if needed** — otherwise launch ONE elevated `cmd.exe` via
   `Start-Process -Verb RunAs` that runs the powercfg remediation under a single
   UAC prompt: `powercfg /hibernate off` plus `standby-timeout` and
   `hibernate-timeout` AC/DC → `0` (Never). The `--disable-hibernation` flag is the
   user's pre-approval; **UAC is the OS approve/deny**. Already-elevated shells run
   without a prompt.
3. **Best-effort + non-fatal** — a declined UAC, a headless/remote session with no
   interactive desktop, or any spawn failure logs a `warn` and startup continues.
   The helper prints `APPLIED` / `SKIPPED` / `DENIED` / `ERROR` (mirroring
   keepalive's `OK` readiness token), which the guard logs at info/warn. Never
   throws into startup.

**Persistent by design** — not released on exit (it is a machine setup, not a
runtime lease). Reversible manually with `powercfg /hibernate on`. Reuses
`KeepaliveManager`'s PowerShell hardening (absolute in-box path,
`-NoProfile -NonInteractive -ExecutionPolicy Bypass`, `$ErrorActionPreference=
'Stop'`, `windowsHide`, `unref`, `# aod-hibernation ppid=` tag). All powercfg
commands are constants (no user input), so there is no command-injection surface.

### Rejected alternatives

- **Default-on.** A privileged, persistent machine change on every start is too
  aggressive for a "keepalive," prompts UAC repeatedly on non-elevated launches,
  and fails silently on headless/remote hosts. Kept opt-in.
- **Warn-only.** Honest and zero-risk, but leaves the primary deployment
  environment (a Hyper-V guest) still hibernating. Rejected as insufficient.
- **Veto the suspend** via a `WM_POWERBROADCAST` / power-setting notification.
  Applications have not been able to veto sleep since Windows Vista.
- **Disable the `vmicshutdown` service or host-side integration settings.** Either
  is host-side (out of the guest's control) or breaks graceful host→guest
  shutdown.

## Consequences

- New opt-in flag; no new runtime dependencies; nothing to code-sign.
- When enabled and hibernate is on, a **UAC prompt appears once** at startup
  (unless the process is already elevated). Denial or a headless session degrades
  to a `warn`; startup always continues.
- The change **persists after exit** (by design). Reverse with `powercfg
  /hibernate on`.
- Detection keys on `HibernateEnabled`; if the value is absent (rare) the guard
  attempts the fix (idempotent) rather than skipping.
- On a Hyper-V guest this removes the last sleep vector the keepalive assertion
  cannot cover; on a bare-metal host it also disables normal hibernation, so it is
  opt-in rather than automatic.
