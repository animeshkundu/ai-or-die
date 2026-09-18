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

## Components

- **PtyManager** — PTY registry; per-PTY kill-on-close jobs (Windows) /
  process-group teardown (POSIX); `transferOwnership` re-parents records
  without killing processes.
- **ServerManager** — spawn/READY/handshake/shutdown; `swapServer` rolls
  back to v1 when v2 fails READY/HANDOFF.
- **AutoUpdater** — hourly GitHub Releases poll, staged download + checksum,
  hybrid apply (Settings button or 4h PTY idle).
- **ServiceInstaller** — user-level units (systemd --user, launchd agent,
  Task Scheduler); stable-path guarantee (`~/.ai-or-die/bin/`, never the
  npx/bunx cache). CLI: `ai-or-die service <install|uninstall|status|logs>`.
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

`shutdown` / `handoff_start` / `config_update` →
`ready` / `shutdown_complete` / `handoff_complete` / `status` /
`pty_register` / `pty_unregister` / `update_apply_request`.
See `src/supervisor/ipc-protocol.js`.

## File paths

`~/.ai-or-die/bin/ai-or-die-supervisor[.js]` (stable, unit target),
`~/.ai-or-die/bin/ai-or-die-server[.exe]` (updated in place),
`~/.ai-or-die/staging/`, `sessions.json`, `service.json`, `fleet-token`,
`machine-id`, `logs/supervisor.log`.

## Environment

`AIORDIE_UPDATE_INTERVAL` (1h), `AIORDIE_AUTO_APPLY_IDLE_MS` (4h),
`AIORDIE_AUTO_UPDATE=1`, `AIORDIE_SERVICE=1`,
`AIORDIE_FLEET_GATEWAY`, `AIORDIE_FLEET_TOKEN`, `AIORDIE_FLEET_HEARTBEAT`,
`AIORDIE_DISABLE_HIBERNATION=1` (opt out), `AIORDIE_WAKE_GRACE_MS`.

## Tests

`test/supervisor-*.test.js` (38) + `test/server-update-banner.test.js` (6).
Longevity gate: 100 consecutive swaps, zero PTY death; 7-day soak.
