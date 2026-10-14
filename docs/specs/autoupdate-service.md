# Spec: Autoupdating Service with Zero-Downtime PTY Preservation

**Status:** implemented (ADR-0058)

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
`~/.ai-or-die/bin/ai-or-die-server[.exe]` (updated in place),
`~/.ai-or-die/staging/`, `sessions.json`, `service.json`, `fleet-token`,
`machine-id`, `logs/supervisor.log`.

## Windows service (Win11, primary target)

`npx -y ai-or-die service install [--port 8888] [--mesh] [--no-hibernation-guard]`
creates a per-user Task (`ai-or-die`, overridable via `AIORDIE_SERVICE_NAME`):

- **Launcher:** direct `node <stable-supervisor> [serverArgs]` (absolute,
  quoted; Node ≥22 resolved at install from `execPath` → `where node` →
  `%ProgramFiles%`). No `cmd` wrapper (avoids orphaned `node` on `/end`).
  Re-run install after a Node upgrade.
- **Triggers:** Logon + ConsoleUnlock + SessionUnlock + RemoteConnect;
  `IgnoreNew`, `StartWhenAvailable`, `WakeToRun`, battery start/stop `false`,
  `P3D` time limit, `PT1M×999` restart backstop, `AllowHardTerminate`.
- **XML encoding:** UTF-16LE with BOM (matches the prolog); `Principals` uses
  `InteractiveToken`/`LeastPrivilege` so non-elevated create works.
- **Service mode without env:** Task Exec has no env block, so the staged
  image + `service.json` sentinel implies `AIORDIE_SERVICE=1`
  (`isServiceRuntime()`): keepalive ON, hibernation guard default ON.
- **Hibernation:** install does a non-privileged `HibernateEnabled` read; one
  UAC prompt only when hibernate is on, the session is interactive, and no
  opt-out (`--no-hibernation-guard` / `AIORDIE_DISABLE_HIBERNATION=1`).
- **Secrets:** `--auth` is stripped (warns); the server mints a per-boot token.
- **Lifecycle:** reinstalls diff content+args+node and no-op when identical
  (live PTYs survive); `uninstall` runs `schtasks /end` before `/delete` and
  removes the staged XML; `status` reports `{installed,active,taskState}` plus
  persisted args; `logs` tails `logs/supervisor.log`.
- **Reliability:** Tier-1/Tier-2 respawn backoff, never-exit exception guards
  (counted budget — persistent corruption exits for a clean Task restart),
  keepalive watchdog, atomic checksum-gated promote-before-swap, idle
  auto-apply + manual Apply Now. v1 conservative gate: automatic apply
  requires zero supervisor-owned sessions (per-keystroke activity has no
  in-process producer yet — server-side `STATUS ptyActivityAt` is the tracked
  follow-up); manual Apply is unaffected.
- **Scope:** single active user per machine; supervisor fixes require
  reinstall (server autoupdate does not re-stage the tree).

## Environment

`AIORDIE_UPDATE_INTERVAL` (1h), `AIORDIE_AUTO_APPLY_IDLE_MS` (4h),
`AIORDIE_AUTO_UPDATE=1`, `AIORDIE_SERVICE=1`,
`AIORDIE_FLEET_GATEWAY`, `AIORDIE_FLEET_TOKEN`, `AIORDIE_FLEET_HEARTBEAT`,
`AIORDIE_DISABLE_HIBERNATION=1` (opt out), `AIORDIE_WAKE_GRACE_MS`.

## Tests

`test/supervisor-*.test.js` + `test/server-update-banner.test.js` (60 unit).
Live E2E (port 11433, isolated session dir, real PTY + real swap): 20/20 —
see validation notes in ADR-0058. Longevity gate: 100 consecutive swaps
with adopt verified each round; 7-day soak.
