# Service install: boot start, staged closure, provisioning, watchdog (2026)

Follow-up to `docs/adrs/0059-win11-login-service.md`. ADR-0062 is the decision
record; this is the reproduction log.

## What the customer asked for

`ai-or-die service install` should install and start
`ai-or-die --mesh --disable-auth` as a **user-mode** service (no admin) that:

- starts **at boot, before anyone logs in**,
- restarts automatically,
- keeps serving at the lock screen.

## What actually happened

Install printed success every time. The task never ran.

### 1. Staged tree could not boot

```
Error: Cannot find module '../src/supervisor/service-logging'
Require stack:
- C:\Users\<u>\.ai-or-die\bin\ai-or-die-supervisor.js
```

`bin/supervisor-service.js` requires `../src/supervisor/service-logging`, and
`STAGED_FILES` in `src/supervisor/service-installer.js` never listed it. The
staged tree is written fresh on every install, so this failed 100% of the time
on every platform — the ADR-0059 "staged closure" claim was never enforced.

### 2. The server binary did not exist

```
[supervisor-service] failed to start: server exited before READY
Error: Cannot find module 'C:\Users\<u>\.ai-or-die\bin\ai-or-die-server'
```

Nothing in the install path created `ai-or-die-server[.exe]`; only
`AutoUpdater._stageRelease` ever wrote it. And `platformAssetPattern` matched
`ai-or-die-server-<plat>-<arch>`, while the release workflow publishes
`ai-or-die-windows-x64.exe` / `ai-or-die-linux-x64`. So the updater matched
nothing, silently, forever.

### 3. The spawn shape was wrong for a SEA binary

`ServerManager` spawned `node <binary> [args]`. For a 166 MB SEA executable,
that is Node parsing a PE image as JavaScript. Even with the file present, the
supervisor could not reach READY.

### 4. Windows rejected the Task XML

Two values made `schtasks /create` reject the **whole definition**:

```
ERROR: The task XML contains a value which is incorrectly formatted or out of range.
(19,36):StateChange:ConsoleUnlock
```

`ConsoleUnlock` is not a member of the Task Scheduler
`sessionStateChangeTriggerType` enum (it is `SessionUnlock`). After fixing that,
the next probe failed at:

```
(37,59):Count:999
```

`RestartOnFailure/Count` is `xsd:unsignedByte` (1–255).

Both values were in the generated XML for months and both suites passed,
because the tests asserted substrings of the file the code generated —
`assert.ok(xml.includes('ConsoleUnlock'))` — rather than asking Windows whether
the file was acceptable. That is the actual defect: the test doubled as a copy
of the bug.

A third, quieter value: `ExecutionTimeLimit P3D` hard-terminates the task after
72 hours. Every PTY died with it, every three days.

### 5. It could not start before login

`<LogonType>InteractiveToken</LogonType>` means "user must already be logged
on", and there was no `BootTrigger`. No XML change could satisfy the actual
requirement in login mode.

### 6. A wedge was invisible

The scheduled task sees process exit. A supervisor blocked in a stalled event
loop, or one whose server child died while its own respawn logic was stuck, is
a running process: `RestartOnFailure` never fires and `IgnoreNew` silently
absorbs every subsequent trigger. The daemon stays in that state until the
machine reboots.

## Verification

`test/integration/schtasks-xml.test.js` hands the file to Windows and asks the
OS: it creates, queries and deletes uniquely-named probe tasks for both modes,
and keeps negative controls proving `ConsoleUnlock` and `Count 999` are
rejected. Run it from a normal interactive PowerShell window:

```powershell
$env:AIORDIE_SCHEDTASK_INTEGRATION = '1'
npx mocha --exit --timeout 60000 test/integration/schtasks-xml.test.js
```

It requires `schtasks /create` permission. A restricted or sandboxed session
gets `ERROR: Access is denied.` for *every* create, including a trivial
`notepad.exe /sc onlogon`; the suite detects that and skips loudly rather than
reporting a false pass.

The generated definitions were validated this way during the fix, by
hand-probing with the task name replaced each time. The fixed XML passed schema
validation; the deliberately-broken variants failed exactly as described above.

## On-host acceptance (the part no test can do)

```powershell
ai-or-die service install --boot --mesh --disable-auth
ai-or-die service status
curl http://127.0.0.1:7777/api/health
```

Then, in order:

1. Kill the supervisor process → the task restarts it within 5 minutes
   (`LastTaskResult` confirms).
2. Wedge the supervisor (block its event loop) → the watchdog restarts it
   after the heartbeat goes stale (120 s) plus one 5-minute tick.
3. `shutdown /r` → at the login screen, without logging in, the mesh URL
   answers. This is the requirement, and it is only proven by a reboot.

Install now refuses to report success without evidence: it polls
`run/heartbeat.json` for up to 90 s and exits non-zero with the task state and
log tail if the daemon never beats. Only a heartbeat *newer than the install
start* counts — a leftover file from a previous run would otherwise make the
self-test pass while the task it just registered never started.

## Residual risks recorded, not fixed

- S4U logon sessions have no network credential material (no SMB/NTLM, EFS,
  or user-scope DPAPI). Anything reaching a file share works under `--login`
  and fails under `--boot`.
- A standard user needs `SeBatchLogonRight`; a per-user install cannot grant
  it and must say so.
- Fast Startup does not fire `BootTrigger`; the 5-minute `TimeTrigger` covers
  it (up to 5 minutes late).
- `job-guard.isAvailable()` is false inside a SEA image (no `koffi`), so PTY
  teardown uses `taskkill` instead of Job Objects. Pre-existing.
- `TrustedPath` is not set, so the child server inherits a normal user PATH.
