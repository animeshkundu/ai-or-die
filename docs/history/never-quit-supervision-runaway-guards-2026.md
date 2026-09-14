# Never-quit remote supervision + weeks-long runaway guards (2026)

## Problem
Single-user daemon (2-3 Claude sessions over devtunnel/mesh, unattended for
weeks) could permanently lose remote access or grow without bound:

1. App tunnel, VS Code tunnel, and mesh sidecar supervisors halted forever
   after 10 fast crashes (`MAX_RETRIES`), logging "Giving up / continues on
   localhost" — useless to a remote user.
2. Clean process exits (code 0, e.g. relay-side close) never restarted the
   app tunnel or mesh sidecar — only `code !== 0` did.
3. VS Code tunnel respawn failures deleted the tunnel record
   (`_cleanupTunnel`), and the health sweep only re-swept `running` tunnels,
   so a stuck `degraded`/`error` tunnel was never retried.
4. Sticky-note `pendingText` grew without limit while the inference engine
   was down (failed inferences keep `needsSummary=true`; every `feedTurns`
   appends, nothing drains).
5. Eviction-heap tombstones grew without limit at small live counts: the
   PROC-04 ratio rebuild returns early when `live <= 100`, so 2-3 chatty
   sessions accumulated tens of thousands of entries over weeks.

## Fix
- Automatic supervision never halts: backoff stays capped at 30s, retry
  counters keep counting for observability, manual portal restart/start
  paths are untouched and were audited to be budget-free already (app
  tunnel `restart()` resets the counter; VS Code Retry calls `start()`
  which creates a fresh record).
- Exit code no longer gates recovery (`_shouldAutoRestart()` = not
  stopping / no manual restart in flight); `_spawn` failures inside the
  restart chain are caught and logged instead of rejecting the
  fire-and-forget chain.
- VS Code respawn failures keep the record (status `error`, port still
  reserved — retries reuse it); the health sweep now also re-sweeps
  `degraded` and `error` tunnels.
- `pendingText` capped at 1M chars (drop-oldest + `pendingDroppedChars`
  counter); healthy-path summaries byte-identical (cap only triggers on
  the failure path).
- Eviction heap: absolute 5000-entry rebuild trigger applies only when
  `live <= 100`; PROC-04 ratio tuning for larger N is untouched.

## Thresholds (deliberate floors)
Per product direction: no optimization below 256MB memory / 500MB disk
overall. All caps here are runaway guards set orders of magnitude below
those floors (1M chars ≈ 1-3MB; 5000 heap entries ≈ kilobytes), never
tuning for small savings.

## Verification
- New repro tests fail on pre-fix code (9 failures) and pass post-fix:
  never-quit past budget + spawn-failure survival (tunnel, mesh, vscode),
  `_shouldAutoRestart` predicate, `pendingText` cap + healthy-path parity,
  small-N heap bound.
- Regression: tunnel/mesh/summarizer 80 passing, vscode-tunnel 57
  passing, eviction-sublinear 7 passing (PROC-04 large-N gates unchanged),
  `test:control` green, 122-test switch/output/join set green.
- Spec: `docs/specs/vscode-tunnel.md` (MAX_RETRIES meaning, health-check
  states) updated in the same change.

## Follow-ups (not done)
- Mesh has no portal restart endpoint; covered by never-quit auto
  supervision instead. Add one only if manual mesh recovery is wanted.
- Auth-token expiry remains a loud-banner + one-action-recovery situation
  (device-code flow cannot complete unattended).
- Disk janitor defaults + autosave `_outputDirty` split + sticky FG bypass
  proposed separately; need explicit sign-off (disk) and workload gates.
