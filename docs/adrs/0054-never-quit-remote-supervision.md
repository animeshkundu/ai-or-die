# ADR-0054: Never-Quit Remote Supervision

## Status

Accepted

## Date

2026-09-14

## Context

The app devtunnel (`src/tunnel-manager.js`), VS Code tunnel
(`src/vscode-tunnel.js`), and mesh sidecar (`src/mesh-manager.js`)
supervisors halted permanently after 10 fast crashes (`MAX_RETRIES`),
logging "Giving up. Server continues on localhost." For the primary
envelope — a single user's daemon, 2–3 Claude sessions, remote over
devtunnel or mesh, unattended for weeks — a sub-60-second burst (auth
outage, relay 5xx, TLSA hiccup) permanently stranded remote access until
a human intervened. The halt message itself is useless to someone remote.
Related gaps found in the same audit: clean exits (code 0) never
restarted; VS Code respawn failures deleted the tunnel record and the
health sweep never re-swept `degraded`, so one transient blip during a
respawn window also stranded the tunnel.

This supersedes the MAX_RETRIES-as-halt-condition discipline recorded in
`docs/audits/proc-child-processes.md` (§4 backoff, §7 respawn-failure
branches) and asserted by the PROC-02 longevity probes.

## Decision

Automatic supervision never halts:

- Every process exit while the tunnel/mesh is wanted recovers, regardless
  of exit code (`_shouldAutoRestart()` gates only on intentional
  shutdown). Backoff stays exponential capped at 30s no matter how high
  `retryCount` grows; the 60s stability reset is unchanged.
- Respawn failures keep the tunnel record (status `error`, port still
  reserved) so the 60s health sweep — which now also re-sweeps `degraded`
  and `error` — retries with backoff.
- `MAX_RETRIES` survives as the escalated-logging threshold and the
  stability-reset accounting unit, never as a halt condition.
- Manual recovery (portal Retry / `restart()` / `start()`) was audited and
  is budget-free by construction (counter reset / fresh record); it is
  never gated by automatic-loop state.
- Spawn failures inside fire-and-forget restart chains are caught and
  logged instead of surfacing as unhandled rejections.
- No proactive restarts: pressure signals stay alerts-only. Crash
  recovery (supervisor respawn after an actual crash) is unchanged.

## Consequences

### Positive

- A weeks-long unattended daemon self-heals through auth outages, relay
  drops, and respawn-window blips; remote access no longer has a
  give-up state.
- Clean relay closes (exit 0) recover instead of silently dropping the URL.

### Negative

- A persistently failing spawn (e.g. CLI uninstalled, key revoked) now
  retries every ≤30s forever, logging each cycle, instead of going quiet.
  Mitigated by the capped rate and the escalated log line past the old
  budget; operators watch for the "still retrying" line.
- The portal `attempt`/`maxRetries` event fields are retained for UI
  compat but no longer describe a real budget (log lines no longer show
  `attempt N/10`).

### Neutral

- `stop()`/`stopAll()` semantics unchanged; `_cleanupTunnel` still runs on
  explicit stop/delete, just never on failure.
- Mesh has no portal restart endpoint; never-quit auto-supervision covers
  it instead (documented gap, not added).

## Notes

- History: `docs/history/never-quit-supervision-runaway-guards-2026.md`.
- Specs: `docs/specs/vscode-tunnel.md` (MAX_RETRIES meaning, health-check
  states) updated in the same change.
- Verification: PROC-02 probes rewritten to never-quit semantics; new
  probes fail on pre-fix code.
