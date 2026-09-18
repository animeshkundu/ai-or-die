# ADR-0058: Autoupdating User-Level Service with Zero-Downtime PTY Preservation

**Status:** Accepted (implemented)
**Date:** 2026-09-18
**Supersedes:** nothing (extends ADR-0031 process-shutdown, ADR-0029/0030 keepalive)

## Context

`ai-or-die` runs as a manually-started CLI (`npm start` / SEA binary). The
product direction is a per-machine daemon consumed via fleet-gateway: it must
start on login, survive sleep/wake, and update itself from GitHub Releases
without killing any running Claude/Copilot/Opencode session.

Constraints from existing ADRs/specs:
- PROC-01 (never-exit supervisor): no orchestrator above us; the supervisor
  must never permanently exit (`docs/history/proc-supervisor-2026.md`).
- `docs/specs/process-shutdown.md`: Windows Job Objects (koffi) + POSIX
  process-group teardown; per-PTY kill-on-close jobs owned by bridges.
- `docs/architecture/north-star.md`: bounded structures, explicit disposal,
  diagnostics instrumentation, Windows-first cross-platform.
- HibernationGuard is DEFAULT ON for Windows service installs.

## Decision

Split the daemon into a **stable Supervisor anchor** (npm, ~200 lines, almost
never updates) and an **updatable Server** (SEA binary):

- The Supervisor owns ALL PTY lifecycles (`src/supervisor/pty-manager.js`):
  per-PTY Job Objects on Windows, process-group teardown on POSIX. Bridges
  keep their local teardown but additionally notify the supervisor
  (`pty_register`/`pty_unregister` over the existing IPC channel), so the
  supervisor's registry is authoritative.
- Server swaps go through `ServerManager.swapServer`: spawn v2 on an
  EPHEMERAL port → wait READY → HANDOFF_START → wait HANDOFF_COMPLETE →
  move ownership records → old `release_port` → `waitPortFree` poll →
  new `listen_port` (close-then-relisten the SAME front object; double
  listen throws ERR_SERVER_ALREADY_LISTEN) → graceful shutdown of v1 →
  promote v2. Rollback at every step (release failure keeps v1 fully live;
  takeover failure re-binds v1 before giving up).
- Update trigger is **hybrid**: the AutoUpdater polls GitHub Releases hourly
  and stages the binary silently; the user applies via the Settings
  "Update Ready / Apply Now" banner (`update_ready` WS broadcast +
  `GET/POST /api/update/*`), or it auto-applies after 4h of PTY idle.
- Service installation is **user-level only** (systemd --user, launchd agent,
  Task Scheduler) and **never references the invoking package path**: on
  `service install` the supervisor entry is copied to
  `~/.ai-or-die/bin/ai-or-die-supervisor.js`, so `npx`/`bunx`/`npm -g` all
  converge on the same unit definition.
- Fleet-gateway wire contract lives in-repo (`docs/specs/fleet-gateway.md`):
  register → 30s heartbeat (`healthy|updating|degraded`) → deregister.
- Self-signed certs are embedded in the SEA build for localhost trust;
  installed to the user trust store on first service start.
- No beta channel yet; stable releases only. No migration path for existing
  npm users (fresh installs only).

## Validated findings (live E2E, port 11433, isolated session dir)

- **POSIX SIGHUP (proven):** when the process holding a PTY master exits,
  the kernel SIGHUPs the shell — process survival across a server exit is
  impossible without fd passing. Update-shutdown therefore tears PTYs down
  UNIFORMLY on all platforms, and continuity comes from **adopt-respawn**:
  the new Server relaunches each transferred session headlessly via
  `_controlStartAgent` (same cwd, persisted `launchOptions`, CLI-native
  resume argv). Verified live: same session id, fresh shell, replay +
  interactive echo after rejoin.
- **Resume argv (verified):** `claude --resume <stickyClaudeSessionId>`
  (documented CLI flag), `copilot --continue` (verified `--help` on-host);
  terminal/codex/gemini respawn fresh in place. Never duplicates a
  user-supplied resume flag. `launchOptions` are now persisted in
  sessions.json (additive; old files load fine).
- **Adopt needs three framework fixes (all live-verified):** (1) adopted
  sessions get a FRESH geometry init (restored:true suppresses the
  automatic ownership lease forever → silent to joiners); (2) the
  headless `_controlStartAgent` output path now also calls
  `_broadcastOrHoldSessionOutput` (it previously fanned out to nobody);
  (3) IPC round-trips use persistent `on` + explicit removal instead of
  `once` — a stray `pty_register` racing a reply consumed the `once`
  waiter and dropped `listen_port_ok` on the floor (15s timeout).
- **Send hardening:** every supervisor-bound `process.send` funnels
  through `_supervisorSend`/`_supervisorSend` with a `process.connected`
  guard — after a supervisor-death disconnect, an unguarded send throws
  ERR_IPC_CHANNEL_CLOSED as an uncaught exception mid-teardown.
- Raw fd/handle passing (SCM_RIGHTS / PROC_THREAD_ATTRIBUTE_HANDLE_LIST)
  remains the tracked follow-up for true process continuity; the death-
  rattle guard (`handedOff` flag, order-independent) keeps the registry
  consistent either way.

## Consequences

- `src/base-bridge.js` gains two best-effort `process.send` notifications;
  unsupervised runs are unaffected (no IPC channel → no-op).
- `src/server.js` gains `supervisorBridge`, `notifySupervisor()`,
  update-ready/handoff IPC handling, and the `/api/update/*` mount.
- New surface: `src/supervisor/` (8 modules), `bin/supervisor-service.js`
  entry, `service` CLI subcommand, Settings update banner.
- Raw fd/handle passing (SCM_RIGHTS / PROC_THREAD_ATTRIBUTE_HANDLE_LIST)
  is the documented follow-up; v1 transfers ownership records + descriptors
  while processes stay alive under supervisor ownership.
- Longevity gate: 100 consecutive swaps with zero PTY death; 7-day soak
  with daily updates, event-loop p99 < 50ms.

## References

- `docs/specs/process-shutdown.md`, `docs/specs/keepalive.md`,
  `docs/specs/fleet-gateway.md`
- ADR-0029 (windows-keepalive-power-request), ADR-0030 (hibernation-guard),
  ADR-0031 (deterministic-process-shutdown)
- `src/job-guard.js`, `src/utils/process-tree.js`
