# Spec: Autoupdating Service with Zero-Downtime PTY Preservation

**Status:** implemented (ADR-0058, extended by ADR-0059 + ADR-0062)

## Goal

`ai-or-die` runs as a per-machine user-level daemon that starts on login,
resumes after sleep/wake, and updates itself from GitHub Releases without
interrupting any running Claude/Copilot/Opencode session.

## Architecture

Stable **Supervisor** anchor (`src/supervisor/`, `bin/supervisor-service.js`)
owns PTY lifecycles; updatable **Server** (SEA binary,
`~/.ai-or-die/bin/ai-or-die-server`) is a stateless frontend.

Validated live on port 11433 with an isolated session dir (20/20 E2E
checks): swap with port takeover, uniform teardown, adopt-respawn with
rejoin + interactive echo, sessions.json in the custom dir.

## Session continuity model (ADR-0058)

Processes do NOT survive a swap (POSIX SIGHUP, proven). uniform teardown
runs on every platform; the new Server adopt-respawns each transferred
session (`_adoptHandoffSessions` → `_controlStartAgent`): same session id
and cwd, persisted launch options, CLI-native resume argv (claude
`--resume <id>`, copilot `--continue`). Terminal/codex/gemini respawn
fresh in place. Adopted sessions are fully joinable (fresh geometry lease
+ live output fan-out).

## Components

- **PtyManager** — PTY registry; per-PTY kill-on-close jobs (Windows) /
  process-group teardown (POSIX); `transferOwnership` re-parents records
  without killing processes.
- **ServerManager** — spawn/READY/handshake/shutdown; `swapServer` rolls
  back to v1 when v2 fails READY/HANDOFF.
- **AutoUpdater** — hourly GitHub Releases poll, staged download + checksum,
  hybrid apply (Settings button or 4h PTY idle).
- **ServiceInstaller** — user-level units (systemd --user, launchd agent,
  Task Scheduler); stable-path guarantee (staged tree under `~/.ai-or-die/`,
  never the npx/bunx cache). CLI: `ai-or-die service <install|uninstall|status|logs>`.
  `install` forwards server flags (`--port/--mesh/…`); `--auth` bearers are
  never persisted. See “Windows service” below.
- **ServiceLogging** — in-process tee to `logs/supervisor.log` (append +
  copy-truncate rotation); `service logs` tails it on all platforms.
- **WakeHandler** — timer-gap sleep detection + 15s resume grace.
- **FleetClient** — fleet-gateway register/heartbeat/deregister.
- **KeepaliveManager** — always ON for service (Windows).
- **HibernationGuard** — DEFAULT ON for Windows service installs
  (opt out: `AIORDIE_DISABLE_HIBERNATION=1`).

## Update API (server, supervised only)

- `GET /api/update/status` → `{ supervised, updatable, currentVersion, pending, idleMs, ptys }`
- `POST /api/update/check` → trigger a poll
- `POST /api/update/apply` → seamless swap; `{ applied, promoted, version, ptys }`
- WS `update_ready` broadcast → Settings banner with Apply Now.

## IPC (supervisor ↔ server)

`shutdown` / `handoff_start` / `release_port` / `listen_port` /
`config_update` → `ready` / `shutdown_complete` / `handoff_complete` /
`port_released` / `listen_port_ok` / `listen_port_failed` / `status` /
`pty_register` / `pty_unregister` / `update_apply_request`.
See `src/supervisor/ipc-protocol.js`.

Swap order: v2 boots ephemeral → READY → HANDOFF_START → HANDOFF_COMPLETE
(+ fire-and-forget adopt) → ownership records move → v1 `release_port` →
supervisor polls the port free → v2 `listen_port` (close-then-relisten the
same front object) → v1 graceful shutdown → promote. Round-trips use
persistent listeners (never `once` — a stray frame would eat the waiter).

## File paths

`~/.ai-or-die/bin/ai-or-die-supervisor.js` (stable, unit target),
`~/.ai-or-die/src/` (staged supervisor closure: `supervisor/*`,
`keepalive-manager.js`, `hibernation-guard.js`, `job-guard.js`,
`utils/process-tree.js`),
`~/.ai-or-die/bin/ai-or-die-server[.exe]` (provisioned at install, updated in
place), `~/.ai-or-die/staging/`, `sessions.json`, `service.json`,
`fleet-token`, `machine-id`, `logs/supervisor.log`, `run/heartbeat.json`,
`run/watchdog.json`, `logs/watchdog.log`.

## Windows service (Win11, primary target)

```bash
npx -y ai-or-die service install [--boot|--login] [--port 8888] [--mesh] \
    [--disable-auth] [--no-hibernation-guard] [--no-verify] \
    [--server-binary <path> | --offline | --release-version <tag>] [--force]
```

Creates a per-user Task (`ai-or-die`, overridable via `AIORDIE_SERVICE_NAME`)
plus, in boot mode, a `ai-or-die-watchdog` task. **No admin rights required.**

### Start modes

| | `--login` (default) | `--boot` |
|---|---|---|
| Principal | `InteractiveToken` | `S4U` + explicit `<UserId>` (SID) |
| Trigger | `LogonTrigger` (+ 5-min repeat) | `BootTrigger` (20s delay) + logon + 5-min repeat |
| Starts before login | no | **yes** |
| Stored password | none | none |
| Credential material | full user token | no network creds (no SMB/EFS/DPAPI-to-user), no desktop |

`--boot` is the mode for a headless box you reach over the mesh: it starts
before anyone logs on and keeps running at the lock screen.

### Task definition (both modes)

- **Launcher:** direct `node <stable-supervisor> [serverArgs]` (absolute,
  quoted; Node ≥22 resolved at install from `execPath` → `where node` →
  `%ProgramFiles%`). No `cmd` wrapper: `/end` would terminate only the wrapper
  and orphan the real daemon under `IgnoreNew`. Re-run install after a Node
  upgrade.
- **Triggers:** `BootTrigger` (boot mode only, `PT20S` delay so the profile
  service is up), `LogonTrigger` with `PT5M` repetition, and a `TimeTrigger`
  with `PT5M` repetition as the self-healing backstop (also covers Fast
  Startup, which does not fire `BootTrigger`). `SessionStateChangeTrigger` for
  `ConsoleConnect`, `SessionUnlock`, `RemoteConnect` — **not** `ConsoleUnlock`,
  which is not in the enum and makes `schtasks` reject the whole definition.
- **Settings:** `IgnoreNew`, `StartWhenAvailable`, `WakeToRun`, battery
  start/stop `false`, `ExecutionTimeLimit PT0S` (unlimited — the schema
  default `P3D` would hard-kill the daemon and every PTY every three days),
  `RestartOnFailure PT1M × 255` (`Count` is `xsd:unsignedByte`; 999 is
  rejected), `AllowHardTerminate`.
- **XML encoding:** UTF-16LE with BOM (matches the prolog). Trigger children
  follow the XSD sequence `StartBoundary → EndBoundary → Enabled → Repetition`.
- **Service mode without env:** Task Exec has no env block, so the staged image
  + `service.json` sentinel implies `AIORDIE_SERVICE=1`
  (`isServiceRuntime()`): keepalive ON, hibernation guard default ON.
- **Secrets:** `--auth` is stripped (warns); the server mints a per-boot token.
  No bearer is ever written into Task XML or `service.json`.

### Staged tree

`STAGED_FILES` is explicit and verified: `assertStagedClosure()` walks every
relative `require()` from the staged entry and fails the install when the
staged tree cannot satisfy one (bare allowlist: `koffi`, `@vscode/ripgrep`,
`node:sea`). This runs **before** the unit is written, so a broken package
cannot leave a registered task behind. A minimal `package.json` is written into
the base dir so version reporting and update comparison stay truthful.

### Server provisioning

Install downloads the pinned release SEA (`ai-or-die-windows-x64.exe` /
`ai-or-die-linux-x64`), verifies GitHub's per-asset `sha256:` digest, strips the
mark-of-the-web, execs it once (`--version`), and only then renames it onto
`~/.ai-or-die/bin/ai-or-die-server[.exe]`. Failure aborts before the unit
exists. Reinstalls reuse an already-runnable binary. Escapes: `--server-binary
<path>`, `--offline`, `--release-version <tag>`, `--force`.

Four guarantees the implementation has to keep, each with a test:

- **A release without a digest is refused** (`no sha256 digest`), because bytes
  that cannot be authenticated must never become the executable the task
  launches. `AIORDIE_ALLOW_UNDIGESTED_SERVER=1` is the explicit override.
- **The advertised byte count is checked** after the transfer (and again before
  promotion): a stream that ends early without an error still fires `finish`.
- **The previous binary is never absent.** Promotion renames the old file aside,
  renames the new one in, and restores the old one if that fails — Windows
  refuses the replace while a running process has the image mapped, and a
  delete-then-rename would leave the installed task pointing at nothing.
- **Staging paths are created exclusively** (`wx`), so a planted file or
  symlink under `<base>/staging` fails the download instead of receiving it.

The supervisor execs that binary **directly** (`<binary> [args]`), never
`node <binary>` (Node would parse a 166 MB PE file as JavaScript).

### Post-install self-test

After starting the task, install polls `run/heartbeat.json` for up to 90s.
On timeout it prints the task state and the log tail and exits non-zero — a
registered task is not evidence that a daemon runs. `--no-verify` skips it.
Only a heartbeat written **after the install began** counts: a leftover beacon
from a previous run would otherwise make the check pass for a daemon it never
started. The poll lives in `service-cli.js`, so all three entry points
(`bin/supervisor.js`, `bin/ai-or-die.js`, `bin/supervisor-service.js`) behave
identically.

### Watchdog (boot mode, Windows)

`ai-or-die-watchdog` runs `ai-or-die service watchdog` every 5 minutes. It
restarts the service **only** when all three signals agree: heartbeat older
than `AIORDIE_WATCHDOG_STALE_MS` (120s), recorded pid dead, and `/api/health`
failing within 3s (a 200 is only accepted when its body's `pid` matches the
`serverPid` in the heartbeat, so a stale dev server on the same port cannot
masquerade as a healthy daemon). A daemon whose heartbeat says it is still in a boot phase is
spared for `AIORDIE_WATCHDOG_BOOT_GRACE_MS` (10 min) so a slow first start is
not killed mid-boot. Restart is `schtasks /end` then `/run` (a bare `/run` is
absorbed by `IgnoreNew`). 10-minute debounce with exponential backoff on
consecutive failures, cleared on recovery. `AIORDIE_DISABLE_WATCHDOG=1` opts
out. Installed in both modes; in `--boot` the watchdog task itself runs as S4U
with a `BootTrigger`, so it can act before anyone logs in.

Because the watchdog XML is submitted to the same Task Scheduler as the
service, its `BootTrigger` must precede `TimeTrigger` (the XSD validates
`<Triggers>` children in document order). `test/supervisor-service-watchdog-xml.test.js`
pins that ordering structurally, and the opt-in `schtasks` acceptance suite
submits both definitions to Windows itself.

### S4U caveats (`--boot`)

- No network credential material: SMB shares, EFS files, and user-scope DPAPI
  secrets are unavailable to the daemon.
- No interactive desktop: the hibernation remediation (`Start-Process -Verb
  RunAs`) can never prompt, so boot installs force
  `AIORDIE_DISABLE_HIBERNATION=1`; the keepalive PowerShell assertion is
  best-effort.
- A **standard** (non-admin) user needs `SeBatchLogonRight` for S4U. A per-user
  install cannot grant it; install prints the exact remediation
  (`secpol.msc` → Local Policies → User Rights Assignment → "Log on as a batch
  job", or `ntrights -u <user> +r SeBatchLogonRight`).

### Lifecycle

Reinstalls diff content+args+node+**bundle version captured before staging**
and no-op when identical (live PTYs survive). A no-op is not a licence to do
nothing: the unit is still `enable --now`'d (systemd), `load`ed when unloaded
(launchd), or `/run` when not Running (Task Scheduler), and a start failure is
reported with the same SeBatchLogonRight hint as a fresh install. If the
registration throws, the sentinel is restored to the record captured *before*
staging, so a retry of the failed upgrade is not mistaken for an unchanged
no-op against the old daemon. `uninstall` runs `schtasks /end` → `/delete` → removes the staged
XML → removes the watchdog task (left behind it would resurrect the service).
`status` reports `{installed, active, taskState, mode, serverBinary,
serverVersion, watchdog, heartbeat:{ageSeconds,phase,pid}, lastTaskResult}`;
`logs` tails `logs/supervisor.log`; `service watchdog [--dry-run]` is the
task's own entry point.

- **Reliability:** Tier-1/Tier-2 respawn backoff, never-exit exception guards
  (counted budget — persistent corruption exits for a clean Task restart),
  keepalive watchdog, atomic checksum-gated promote-before-swap, idle
  auto-apply + manual Apply Now. v1 conservative gate: automatic apply
  requires zero supervisor-owned sessions (per-keystroke activity has no
  in-process producer yet — server-side `STATUS ptyActivityAt` is the tracked
  follow-up); manual Apply is unaffected.
- **Scope:** single active user per machine; supervisor fixes require
  reinstall (server autoupdate does not re-stage the tree).
- **Known limits:** in a SEA image `job-guard.isAvailable()` is false (no
  `koffi`), so PTY teardown falls back to `taskkill`; the child server inherits
  a normal user PATH (`TrustedPath` is not set).

## Environment

`AIORDIE_UPDATE_INTERVAL` (1h), `AIORDIE_AUTO_APPLY_IDLE_MS` (4h),
`AIORDIE_AUTO_UPDATE=1`, `AIORDIE_SERVICE=1`,
`AIORDIE_FLEET_GATEWAY`, `AIORDIE_FLEET_TOKEN`, `AIORDIE_FLEET_HEARTBEAT`,
`AIORDIE_DISABLE_HIBERNATION=1` (opt out), `AIORDIE_WAKE_GRACE_MS`,
`AIORDIE_HEARTBEAT_MS` (15000), `AIORDIE_WATCHDOG_STALE_MS` (120000),
`AIORDIE_DISABLE_WATCHDOG=1` (opt out).

## Tests

`test/supervisor-*.test.js` + `test/server-update-banner.test.js` (60 unit).
Service-specific: `supervisor-service-watchdog`, `-staging`, `-taskxml`,
`-server-provisioner`, `-win11`, `-installer`. Task XML is validated by
**Windows itself** in `test/integration/schtasks-xml.test.js` (opt-in:
`AIORDIE_SCHEDTASK_INTEGRATION=1`, and `schtasks /create` must be permitted in
the calling session) including negative controls for the values that used to be
rejected. The suite preflights with a trivial `notepad.exe /sc onlogon` task;
if that is denied it prints `[schtasks-xml] SKIPPED — ...` and reports pending,
never passing — a green run in a restricted session would otherwise certify XML
that was never handed to Windows.

Live E2E (port 11433, isolated session dir, real PTY + real swap): 20/20 —
see validation notes in ADR-0058. Longevity gate: 100 consecutive swaps
with adopt verified each round; 7-day soak.
