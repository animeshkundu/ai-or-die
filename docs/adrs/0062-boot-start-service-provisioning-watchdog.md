# ADR-0062: Boot-Startable Windows Service, Staged-Closure Guard, Provisioned Server, and Out-of-Process Watchdog

**Status:** Accepted (implemented)
**Date:** 2026-11-23
**Extends:** ADR-0058 (autoupdating user-level service), ADR-0059 (Win11 user-login service)
**Amends:** ADR-0059 (Task XML values, default install mode, server provisioning)

## Context

ADR-0059 hardened the Win11 login service and shipped. A follow-up audit
reproduced `npx ai-or-die service install` end-to-end on a clean Windows 11
host and found every install still produced a task that could not run, plus
two gaps the ADR-0059 tests could not see:

1. **Staged tree incomplete.** `bin/supervisor-service.js` requires
   `../src/supervisor/service-logging`, which was never added to `STAGED_FILES`.
   Every fresh install staged a tree that died at the first
   `require` with `Cannot find module '../src/supervisor/service-logging'`.
   The hand-maintained list has no enforcement, so this class of bug is
   guaranteed to recur.
2. **No server binary.** The unit launches a supervisor that spawns
   `~/.ai-or-die/bin/ai-or-die-server[.exe]`. Nothing created that file at
   install time; it was only ever written by the AutoUpdater — and the
   AutoUpdater's asset pattern (`ai-or-die-server-<plat>-<arch>`) matched
   nothing that was ever published, so it never wrote it either. Result:
   `[supervisor-service] failed to start: server exited before READY`.
3. **Wrong spawn shape.** `ServerManager` spawned
   `node <stable-server-binary>`. For a SEA image that is Node parsing a
   166 MB PE file as JavaScript.
4. **Task XML rejected by Windows.** `StateChange>ConsoleUnlock` is not in the
   Task Scheduler enum and `RestartOnFailure/Count` is `xsd:unsignedByte`
   (1–255). Both values make `schtasks /create` reject the *whole* definition:
   `(19,36):StateChange:ConsoleUnlock`, `(37,59):Count`. Neither was caught
   because the tests asserted substrings of the generated file, never that
   Windows accepted it.
5. **Cannot start before login.** `InteractiveToken` by definition requires
   the user to already be logged on, and there was no `BootTrigger`.
6. **Lifetime silently capped.** `ExecutionTimeLimit>P3D` hard-terminates the
   daemon (and every PTY under it) every three days.
7. **No liveness signal.** A task only sees process *exit*. A supervisor that
   is alive but wedged accepts no trigger (`IgnoreNew`) and looks healthy to
   the OS forever.
8. **`PT72H`/`P3D` plus dead trigger repetition**: no self-healing tick, so a
   death that `RestartOnFailure` missed stayed dead until the next logon.

Customer requirement driving the work: the daemon must start **at boot,
before anyone logs in**, and must come back on its own.

## Decision

### 1. Staged closure is verified, not maintained (all platforms)

Keep `STAGED_FILES` explicit (a walker cannot know the entry points), and add
`src/supervisor/staged-closure.js`: a comment- and string-aware static walk of
every relative `require()` reachable from the staged entry, resolving each
against the **staged** tree. `assertStagedClosure()` runs inside
`ensureStableBinary()` **before any unit file is written**, so an incomplete
stage fails the install and leaves no registered task behind.

Bare specifiers are allowlisted explicitly (`koffi` — optional native, degrades
with `isAvailable()`; `@vscode/ripgrep`, `node:sea` — provided by the SEA
image). `scripts/mesh-lock` is allowlisted as an unreachable build-time helper
(the require is wrapped in `try/catch` with a literal fallback).

Rejected: deriving the file list from the closure automatically. The walker
can see what a file requires but not which top-level entry points the unit
needs, and a wrong guess stages a tree that boots into an unhandled throw
instead of a loud install error.

### 2. The Server binary is provisioned at install time (all platforms)

`src/supervisor/server-provisioner.js` downloads the pinned release SEA from
GitHub Releases, verifies the per-asset `sha256:` digest GitHub computes on
upload, strips the mark-of-the-web, probes the file with `--version`, and only
then atomically renames it onto `STABLE_SERVER_BIN`. Provisioning runs
**before** the unit is written. Asset names come from one matrix shared with
the AutoUpdater (`ai-or-die-windows-x64.exe`, `ai-or-die-linux-x64`), and an
unsupported platform/arch fails loudly instead of silently matching nothing.

Escapes: `--server-binary <path>` (operator-supplied), `--offline` (refuse the
network with an actionable message), `--release-version <tag>` (pin), and
`--force` (re-provision an already-runnable binary). Reinstalls reuse a
verified existing binary rather than re-downloading 166–209 MB.

### 3. Spawn the SEA directly; acquire `gc` inside the image

`ServerManager.childCommand()` execs a SEA binary directly (`<binary> [args]`)
and keeps `node --expose-gc <file>` only for a `.js` target (dev and tests).
The supervisor's forced-GC points obtain `global.gc` inside the SEA process via
`v8.setFlagsFromString('--expose_gc')` + `vm.runInNewContext('gc')`, guarded —
where that is unavailable it degrades to no *forced* GC, never to a crash.

### 4. Task XML that Windows actually accepts, in two modes

`--login` remains the default (`InteractiveToken`), so existing installs keep
their semantics. `--boot` selects an **S4U principal** with an explicit
`<UserId>` (SID preferred, then `DOMAIN\user`) plus a `BootTrigger`, which
starts the task in the user's context at boot with **no stored password** and
no interactive logon.

Both modes gain: `ConsoleConnect` (the valid enum member) instead of
`ConsoleUnlock`; `RestartOnFailure/Count 255`; `ExecutionTimeLimit PT0S`
(run indefinitely); a `TimeTrigger` with `PT5M` repetition as a
self-healing backstop (covers Fast Startup, which does not fire
`BootTrigger`); `PT5M` repetition on the `LogonTrigger`; `IgnoreNew` retained;
trigger children ordered per the XSD sequence
(`StartBoundary → EndBoundary → Enabled → Repetition`).

Validation is by Windows itself: `test/integration/schtasks-xml.test.js`
(opt-in, `AIORDIE_SCHEDTASK_INTEGRATION=1`) creates, queries and deletes
uniquely-named probe tasks, and includes negative controls that prove the old
values are rejected.

### 5. Boot mode is honest about S4U's limits

S4U gives no network credential material (no SMB/NTLM to a file server, no
EFS, no user-scope DPAPI) and no interactive desktop. Install therefore:
forces `AIORDIE_DISABLE_HIBERNATION=1` in boot mode (the remediation path
calls `Start-Process -Verb RunAs`, which can never prompt without a desktop);
treats the keepalive PowerShell assertion as best-effort; and prints the S4U
caveat. `SeBatchLogonRight` is required for a **standard** user to log on this
way, which a per-user install cannot grant — install prints the exact
remediation (`secpol.msc` → Local Policies → User Rights Assignment → "Log on
as a batch job", or `ntrights`) rather than attempting a silent elevation.

### 6. Out-of-process watchdog + heartbeat (Windows, boot mode)

The daemon rewrites `run/heartbeat.json` every 15 s (atomic tmp+rename, mode
0600, `unref()`'d timer, never throws). A second scheduled task
(`ai-or-die-watchdog`, 5-minute tick, `AIORDIE_DISABLE_WATCHDOG=1` opt-out)
restarts the service only when **all three** signals agree: heartbeat older
than `AIORIDIE_WATCHDOG_STALE_MS` (120 s), recorded pid not alive, and
`/api/health` failing within 3 s. It uses `schtasks /end` then `/run` (a bare
`/run` is absorbed by `IgnoreNew`), and applies a 10-minute debounce with
exponential backoff on consecutive failures so a broken install cannot thrash.

Rejected: a `cmd.exe` retry loop inside the task. `schtasks /end` terminates
only the direct child, so the orphaned `node` keeps the port and `IgnoreNew`
wedges every subsequent trigger — the exact ADR-0059 failure.

### 7. Install proves itself

`service install` polls the heartbeat for up to 90 s after starting the task
and exits non-zero with the task state and log tail when it never appears
(`--no-verify` to skip). A registered task is not evidence that a daemon runs;
the original `MODULE_NOT_FOUND` install reported success.

## Consequences

- `ai-or-die service install --boot --mesh --disable-auth` produces a task
  that starts before login, serves without an interactive session, restarts on
  failure, and self-heals within 5 minutes of a wedge.
- Windows-only for boot/watchdog: systemd (`Restart=always`) and launchd
  (`KeepAlive`) already restart a live-but-wedged unit imprecisely but
  adequately, and neither has a safe "restart a running unit" primitive for a
  timer. The shared fixes (closure guard, provisioning, direct SEA spawn,
  heartbeat writer) apply on all three platforms.
- A fresh install now needs network access to GitHub (166–209 MB) unless
  `--server-binary` or an already-provisioned binary is present.
- Boot mode changes what credentials exist in the daemon's logon session;
  features that reach a network share or an EFS file will fail under `--boot`
  and work under `--login`.
- `job-guard.isAvailable()` is false in a SEA image (no koffi), so PTY teardown
  in the SEA supervisor uses `taskkill` rather than Job Objects. Pre-existing
  behaviour, unchanged here, recorded so it is not mistaken for a regression.
- `TrustedPath` is not set, so the child server inherits a normal user PATH;
  PATH-dependent tool discovery (claude/copilot/gemini/codex) relies on
  whatever PATH the task inherits. Follow-up.
- Tests: `supervisor-service-staging`, `-taskxml`, `-watchdog`,
  `-watchdog-xml`, `-verify`, `-reinstall`, `-server-provisioner`, updated
  `-win11` and `-installer`, plus the opt-in
  `test/integration/schtasks-xml.test.js`. The `-watchdog-xml` suite asserts
  *structural* ordering (`BootTrigger` before `TimeTrigger`) rather than
  substrings, because a reordered trigger list is rejected by the same XSD
  that rejected `ConsoleUnlock`.
- An undigested release is refused rather than promoted
  (`AIORDIE_ALLOW_UNDIGESTED_SERVER=1` overrides). GitHub publishes per-asset
  digests today, so this costs nothing and removes the "unverifiable bytes
  become executable" path entirely.
- The health endpoint gained a `pid` field. It is unauthenticated, like the
  rest of `/api/health`, and reveals only the server process id of the instance
  that answered — no paths, no sessions, no configuration.

## References

- ADR-0058, ADR-0059, `docs/specs/autoupdate-service.md`
- `src/supervisor/staged-closure.js`, `server-provisioner.js`,
  `service-watchdog.js`, `heartbeat.js`, `service-installer.js`,
  `server-manager.js`, `service-cli.js`
- `docs/history/service-boot-start-2026.md` (reproduction log)
