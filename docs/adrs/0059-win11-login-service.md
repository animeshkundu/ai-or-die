# ADR-0059: Win11 User-Login Service Hardening (npx service install)

**Status:** Accepted (implemented)
**Date:** 2026-10-14
**Extends:** ADR-0058 (autoupdating user-level service)

## Context

ADR-0058 shipped a user-level service (`systemd --user` / launchd / Task
Scheduler) with a stable-path guarantee. A holistic audit plus an independent
adversarial review found the Windows 11 path — the primary target — structurally
broken in 6 places and unreliable over months in 7 more:

- `npx ai-or-die service install` never reached the installer (`package.json`
  bin maps to `bin/supervisor.js`, which treated `service` as server args).
- The stable copy staged one file whose `require('../src/supervisor/index')`
  could not resolve post-copy (every Task start → `MODULE_NOT_FOUND`).
- The server default pointed at `~/.ai-or-die/bin/ai-or-die.js`, which nothing
  creates (real target: `ai-or-die-server[.exe]`).
- Task XML was rejected/invalid: UTF-16 prolog with UTF-8 bytes, dangling
  `Actions Context="Author"` with no `Principals/InteractiveToken`, default
  `PT72H` kill, battery defaults that block laptop start, no working dir.
- `AIORDIE_SERVICE=1` never reached the Task (no env block in Task schema) →
  hibernation guard silently off.
- Install args dropped (always port 7777); `uninstall` left the daemon running;
  `logs` read a file nothing wrote; keepalive death was warn-once with no
  respawn; supervisor had Tier-1 backoff only; update promote was
  swap-before-promote, non-atomic, checksum-warn-only.

## Decision

Keep the Supervisor-anchor / stateless-Server split. Fix the packaging +
launcher contract:

1. **Shared service CLI** (`src/supervisor/service-cli.js`): both
   `bin/supervisor.js` (packaged bin) and `bin/ai-or-die.js` route `service`
   through it. `install` forwards `serverArgs` (port/mesh/https/…); `--auth`
   bearers are stripped at two layers and never persisted (Task XML + process
   lists are world-readable).
2. **Staged stable tree** (not single-file copy, not esbuild bundle): stage the
   supervisor entry + its full built-ins-only closure under `~/.ai-or-die/`
   (`src/supervisor/*`, `keepalive/hibernation/job-guard`, `utils/process-tree`).
   Always copy (global paths prune on upgrade — never reference). Missing entry
   throws instead of writing a dangling unit. Rejected: tree-copy needs no
   build step and has no native deps (koffi optional, degrades loudly);
   esbuild bundle was rejected for supervisor-staleness rot, `.node`
   externals, and build-time version inlining.
3. **Direct-node Task Exec** (absolute, quoted, no `cmd /c` wrapper): `/end`
   terminates the real child; no `cmd→node` orphan under `IgnoreNew`. Task XML
   written UTF-16LE **with BOM** to match its prolog; `InteractiveToken` /
   `LeastPrivilege`; Logon + ConsoleUnlock + SessionUnlock + RemoteConnect;
   battery `false/false`; `P3D` limit; `PT1M×999` restart backstop;
   `AllowHardTerminate`; absolute `WorkingDirectory`.
4. **Service sentinel** (`isServiceRuntime()`): staged image + `service.json`
   imply service mode when the Task provides no env block. Keeps
   keepalive-on / hibernation-default-on true without a wrapper.
5. **Node pinned at install** (baked `execPath`, Bun rejected, ≥22 gate, PATH /
   ProgramFiles fallback chain); reinstall after a Node upgrade is documented.
6. **In-process file logging** (`service-logging.js`, append + copy-truncate
   rotation — rename fails on open Windows handles) so `service logs` works on
   all three platforms; units also wire their native log capture (systemd
   append, launchd `StandardOutPath`).
7. **Lifecycle**: idempotent reinstall (content+args+node diff → no daemon
   restart, protects live PTYs); rollback on OS-command failure; `uninstall`
   does `/end` → `/delete` → xml cleanup; `status` parses the `Status:` line
   (not substring) plus meta.
8. **Months hardening**: Tier-1 + Tier-2 backoff with 1024-cap (intentional
   restarts excluded from crash counts), uncaught-fault budget (continue a few
   per hour, then exit for a clean Task restart), keepalive watchdog with
   backoff, install-time conditional hibernation UAC (read-first,
   headless-safe), atomic verify-then-promote-**before**-swap with corruption
   self-heal (mismatch discards + re-stages; channel trust is GitHub TLS —
   release signatures are future work), `maybeAutoApply` wired to the check
   tick with a conservative v1 gate (zero owned sessions; per-keystroke
   `ptyActivityAt` producer is the tracked follow-up).

Build-phase adversarial review drove: strict staging (missing closure member
throws; `update-routes.js` unstaged — needs express), staged entry candidates,
trailing-backslash quoting, BOM dedup, version-aware idempotency, `/create`
compensation + `/run` warning, `/end` settle poll, `AIORDIE_SERVICE=0`
opt-out, case-insensitive sentinel, logging teardown, public keepalive API
with acquired-gate, env-clamped updater intervals.

## Consequences

- `npx -y ai-or-die service install --port 8888 --mesh` works from any
  package location; reinstalls are safe while sessions run.
- `--auth` at install warns and is dropped; the server mints a per-boot token
  (documented rotation).
- Supervisor fixes require reinstall (server autoupdate does not deliver the
  staged tree) — documented; a supervisor-update channel is future work.
- Linux/macOS units gain the shared fixes (args, logging, no `sleep infinity`,
  PATH, idempotency); `launchctl bootstrap` migration and `loginctl linger`
  auto-enable remain follow-ups.
- Tests: `test/supervisor-service-win11.test.js` (25) + updated
  `test/supervisor-service-installer.test.js` (7).

## References

- ADR-0058, `docs/specs/autoupdate-service.md` (Windows section)
- `src/supervisor/service-installer.js`, `service-cli.js`, `service-logging.js`
- Review history: plan-phase audit (4 passes) + build-phase adversarial review
