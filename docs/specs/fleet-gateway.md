# Spec: Fleet-Gateway API

**Status:** defined (client implemented in `src/supervisor/fleet-client.js`)

The supervisor registers each machine with fleet-gateway so the fleet
dashboard can show online machines, versions, and update state.

## Endpoints

### POST /api/fleet/register
Request: `{ machineId, hostname, platform, version, meshUrl, capabilities[] }`
Response: `{ machineId, token }` — token persisted to `~/.ai-or-die/fleet-token`.

### PUT /api/fleet/heartbeat/:machineId
Headers: `Authorization: Bearer <token>`
Request: `{ status: healthy|updating|degraded, version, activeSessions, uptimeMs }`
Response: `{}` on 2xx. Client retries with backoff; never throws into the
supervisor loop. Gateway treats a missed window as offline.

### GET /api/fleet/machines
Dashboard list. Auth per gateway deployment (out of scope for the client).

### DELETE /api/fleet/machines/:machineId
Deregister on graceful supervisor shutdown. Best-effort.

## Client behavior (`src/supervisor/fleet-client.js`)

- Registers once at supervisor start; heartbeats every 30s
  (`AIORDIE_FLEET_HEARTBEAT` overrides).
- During a swap: `reportUpdating()` before, `reportHealthy()` after.
- Runs standalone when no gateway is configured (`AIORDIE_FLEET_GATEWAY`
  unset) or the gateway is unreachable.
- Machine ID persisted to `~/.ai-or-die/machine-id`; never regenerated.

## Capabilities advertised

`pty-handoff`, `auto-update`, `update-button`, `wake-resume`.
