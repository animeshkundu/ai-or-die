# ADR-0062: concurrent mesh nodes on one machine (hostname + state dir overrides)

## Status

**Accepted**

## Date

2026-11-28

## Context

`MeshManager` derives the tailnet node's identity from the machine, not from
configuration: `hostname = aiordie-${os.hostname()}` and
`stateDir = <appBase>/ts-state`. A tsnet node owns both exclusively — the state
dir holds `tailscaled.state` (the node identity) and the hostname is what the
tailnet registers — so two `--mesh` instances on one machine silently fight over
the same node.

This surfaced on a macOS host that already ran an interactive instance on 7777
and needed a second, always-on instance (login LaunchAgent, port 7778) exposing
a different port on the tailnet. The observed failure mode was not a clean
error: with the published 0.1.112 as-is, the second instance started, spawned
`ai-or-die-mesh --hostname aiordie-anilocal --statedir .../ts-state` (node 1's
identity), and reported `Mesh ready: https://aiordie-anilocal...` — a healthy
looking success that had in fact attached itself to the first node's identity
and state dir. Ports and the session store had already been separated
(`--port`, `AI_OR_DIE_SESSION_DIR`); identity was the remaining collision.

A second, related defect was found while fixing it: `peers.json`,
`egress.json` and `quarantine.json` all live in a single `<appBase>/mesh`
directory, describe *one* sidecar (hostname, loopback proxy port + token), and
`stop()` deletes them — so two managers sharing that directory overwrite and
then erase each other's view of the mesh.

## Decision

Add two opt-in environment overrides, both defaulting to existing behavior:

| Var | Default | Effect |
|---|---|---|
| `AIORDIE_MESH_HOSTNAME_SUFFIX` | unset | Appended to the derived name before sanitization (`boot` → `aiordie-anilocal-boot`). |
| `AIORDIE_MESH_STATE_DIR` | `<appBase>/ts-state` | Relocates `--statedir`. |

`MeshManager` captures the relocation at construction (`_explicitStateDir`) and
derives its aux directory from that captured value — not by re-reading the
environment, which would attribute the first node's files to a manager that
merely set the var afterwards. `_auxDir()` returns `<appBase>/mesh` by default
and the relocated sibling `mesh/` next to the state dir, so a relocated node's
`peers.json` / `egress.json` / `quarantine.json` are private to it.

Rejected alternatives:

- **Derive the suffix from the port.** Ports are ephemeral in some deployments
  (`--port 0` for the update candidate) and a suffix that changes with a port
  change would strand the tailnet identity every time.
- **One state dir with a lockfile and a `--profile` name.** Still cannot
  distinguish identity *inside* the counter; two `tailscaled.state` files in one
  directory is not something tsnet supports, and it invites copying one machine's
  identity into another profile.
- **Document "run only one `--mesh` per machine"** (the previous position). It
  is true today but it is exactly the constraint an always-on gateway plus an
  interactive instance cannot respect.
- **Share the aux directory.** Never safe: the files are per-sidecar and
  `stop()` removes them.

## Consequences

### Positive

- An always-on instance and an interactive instance can both be on the tailnet,
  each with its own `*.ts.net` name, cert, and endpoints.
- Existing installs are byte-identical in behavior: with neither env var set,
  hostname, state dir and aux dir are unchanged.
- The two-knob contract is testable without touching the network.

### Negative

- A relocated state dir is **unenrolled**: the new node prints the enroll block
  and runs localhost-only (`Mesh: NOT ENROLLED`) until a reusable tagged
  `AIORDIE_TS_AUTHKEY` is supplied once. Enrolling does not migrate — copying
  `tailscaled.state` between dirs would present one identity from two nodes and
  is explicitly forbidden.
- More than two nodes on one machine needs a naming convention the operator
  owns; nothing validates uniqueness.
- The aux-dir move is a behavior change for anyone who already set
  `AIORDIE_MESH_STATE_DIR` (nobody did — the var is new).

## References

- `src/mesh-manager.js` (`joinHostSuffix`, `_auxDir`, `_explicitStateDir`)
- `test/mesh-manager.test.js` (suffix/state relocation, empty-suffix default,
  aux-dir separation)
- `docs/specs/mesh.md` § "Running a second node on one machine"
- `docs/history/macos-launchagent-boot-2026.md` (the deployment that needed it)
