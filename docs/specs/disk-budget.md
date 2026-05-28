# Disk Budget Specification

**Owner:** SUP-DISK (stability-hardening-2026 campaign)
**Status:** Living document — DISK-01 landed; DISK-02 and DISK-03 to follow.

Canonical spec for everything the ai-or-die daemon writes to or reads
from disk on the long horizon. Covers durability guarantees, rotation
policy, size caps, ENOSPC behavior, and the diagnostic surface that
makes long-running disk usage observable.

---

## 1. Disk surface inventory

The daemon and its hosted child processes touch these on-disk
locations:

| Path | Writer | Append model | Rotation | Owner |
|---|---|---|---|---|
| `~/.ai-or-die/sessions.json` | ai-or-die (`session-store.js`) | full overwrite via temp+rename | n/a — single file, bounded by per-session 512 KB cap × N sessions | DISK-01 |
| `~/.ai-or-die/sessions.json.tmp` | ai-or-die | transient | unlinked on next save | DISK-01 |
| `~/.ai-or-die/sessions.json.corrupted.<ts>` | ai-or-die (corruption recovery) | rare | manual sweep; documented | DISK-02 (cleanup) |
| `~/.ai-or-die/sessions.json.crash[.<ts>]` | ai-or-die (uncaughtException) | rare; one per crash | NONE today — DISK-02 adds startup-time pruning | DISK-02 |
| `~/.ai-or-die/<future>` | TBD | TBD | covered by ~/.ai-or-die quota | DISK-03 |
| `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl` | **Claude CLI itself** (we only read) | append-only line-per-event, ~3 KB/line | NONE today — DISK-02 adds consumer-side janitor (gzip+age+size) | DISK-02 |
| `~/.claude-code-web/*` | legacy path (some installs migrated) | same shape as `~/.ai-or-die/` | same policy applies to legacy path | DISK-03 |

The daemon does NOT write its own JSONL anywhere. `src/usage-analytics.js`
is a pure in-memory `EventEmitter` — its name is misleading.

---

## 2. DISK-01: `sessions.json` atomic-write durability ✅

**Status:** Landed.

**Recipe:** temp file → fsync(temp) → close → rename → fsync(dir) on
POSIX. See `src/utils/session-store.js#saveSessions` and the audit
memo at `docs/audits/disk-atomic-write.md`.

**Guarantee:** After `saveSessions` resolves true, a power loss leaves
`sessions.json` either fully old, fully new, or absent — never torn.

**Regression test:** `test/longevity/disk/atomic-write-power-loss.test.js`.

---

## 3. DISK-02: JSONL growth + rotation (proposed)

**Status:** Memo only — `docs/audits/disk-usage-analytics-jsonl.md`.
Implementation to land next.

**Problem:** Claude CLI writes `~/.claude/projects/<cwd>/<sid>.jsonl`
append-only with no rotation. Empirical measurement: **723 MB across
889 files on one dev machine over ~6 months**. Growth is unbounded.

**Proposed policy** (consumer-side janitor in `src/usage-reader.js`,
opt-in via `AI_OR_DIE_USAGE_COMPACT=1` for the first release):

| Trigger | Condition | Action |
|---|---|---|
| Size, per file | ≥ 100 MB | gzip in place to `.jsonl.gz` |
| Size, per project dir | ≥ 500 MB | gzip oldest files until under cap |
| Age | `mtime` older than 90 days | gzip |
| Active-file protection | most recent 3 per project dir | never touched (CLI may still hold an append fd) |
| Idle protection | `mtime` newer than 1 hour | skipped |

**Reader compatibility:** `findJsonlFiles` and `readJsonlFile` must
accept both `.jsonl` and `.jsonl.gz`. Stream-wrap with
`zlib.createGunzip()` for the `.gz` case.

**Atomicity during rotation:** temp+rename pattern (mirrors DISK-01).
On Windows use `copyFile`+`unlink` instead of `rename` to avoid
`EBUSY` if the CLI still has the file open. Retry 3× with backoff.

**Crash-file pruning** (rides along with DISK-02 because it shares the
log-rotator utility):

- On startup in `server.js`, glob `${sessionsFile}.crash*` and delete
  files older than 7 days, but always preserve the single most recent
  one so operators can inspect.
- The `.crash` writer at `src/server.js:207` itself stays sync (it's
  in `uncaughtException`); we add `fsyncSync` + `closeSync` for
  durability.

**Wire-up:** new `UsageReader.compactStale()` invoked from the 5 min
diagnostics tick at `src/server.js:188`. Constructor gets an
optional `options.claudeProjectsPath` so the regression test can
redirect away from the real `~/.claude/projects/`.

**Regression test:** `test/longevity/disk/usage-analytics-growth.test.js`
covers size threshold, age threshold, active-file protection,
idempotency, crash-file pruning, Windows `EBUSY` fallback.

---

## 4. DISK-03: ENOSPC + `~/.ai-or-die/` size cap (proposed)

**Status:** Memo to be drafted; implementation to land last.

### Size cap

- **Default ceiling:** 1 GB total bytes under `~/.ai-or-die/`.
- **Override:** `AIORDIE_DISK_QUOTA_MB` environment variable.
- **Enforcement points:**
  - Pre-write check in `saveSessions` (estimate envelope size + headroom).
  - Pre-write check in any attachment-upload path.
  - Periodic (5 min diagnostics tick) audit emits a `disk_pressure`
    WS broadcast when usage > 80 % of quota.
- **On cap breach:** refuse new writes that would exceed the cap;
  return structured error (`disk_full`) over WS; do NOT crash the
  process; existing sessions remain read-only.

### ENOSPC circuit breaker

- Catch `ENOSPC` on **all** disk-write call sites:
  - `session-store.js#saveSessions` (already gracefully returns false).
  - `server.js` attachment upload paths.
  - `usage-reader.js` (gzip rotation — must not corrupt source on ENOSPC).
- New WebSocket message type: `{ type: 'disk_full', detail: { path, op, quota_used_mb, quota_total_mb } }`.
- Server-wide circuit-breaker state: after first ENOSPC, set
  `this._diskFull = true`; periodic recheck via diagnostics tick clears
  it when usage drops 10 % below the cap.
- Degrade gracefully: refuse new sessions, refuse uploads, keep
  serving existing sessions read-only (no buffer growth past the
  current 512 KB cap).

### Diagnostics endpoint extension

`src/server.js:3791–3826` (`_collectDiagnostics`) gets a new `disk`
block:

```json
{
  "disk": {
    "ai_or_die_dir_bytes": 12345678,
    "ai_or_die_dir_files": 42,
    "quota_total_mb": 1024,
    "quota_used_pct": 1.2,
    "claude_projects_bytes": 758912345,
    "claude_projects_files": 889,
    "circuit_breaker_open": false
  }
}
```

The sampling uses a directory-walk with a 50 ms time budget and
caches results for 60 s — must NOT block the event loop. If the
sample times out, the previous cached value is returned with a
`stale: true` flag.

**Regression test:** `test/longevity/disk/enospc-handling.test.js`.
Linux-only (tmpfs/loopback with a tight cap); skipped on macOS/Windows
in CI with manual reproduction documented inline.

---

## 5. Cross-cutting design rules

1. **Never block the event loop on disk-walk operations.** All
   directory enumerations cap at a 50 ms time budget; results cache
   for 60 s.
2. **Temp+rename is the only durable write pattern in this codebase.**
   Anything that wants durability must follow the DISK-01 recipe.
3. **Windows-first.** Every disk-touching code path must work without
   `fsync` on directory handles, must tolerate `EBUSY` on rename, and
   must not depend on POSIX file-locking semantics.
4. **Opt-in for destructive janitorial sweeps** (gzip, eviction) for
   the first release. Behind env flags. Default off. Once
   stability is confirmed (one weekly soak), flip the default on in
   a minor-version bump.
5. **Reuse existing patterns:** `CircularBuffer` (`src/utils/circular-buffer.js`)
   for bounded structures; `_collectDiagnostics` for new metrics
   (extend, don't fork); the DISK-01 temp+rename recipe for any new
   atomic write path.

---

## 6. Manual reproduction (operators)

### Power-loss torn-write reproduction (Linux)

```bash
# Spin up daemon, drive activity, then on another shell:
sync && echo b > /proc/sysrq-trigger
# Reboot. After reboot, verify sessions.json is parseable:
node -e "console.log(JSON.parse(require('fs').readFileSync('~/.ai-or-die/sessions.json', 'utf8')))"
```

### Disk-full reproduction (Linux)

```bash
mkdir /tmp/ai-or-die-tmpfs && sudo mount -t tmpfs -o size=10m tmpfs /tmp/ai-or-die-tmpfs
AI_OR_DIE_SESSION_DIR=/tmp/ai-or-die-tmpfs npm run dev
# Drive activity until quota fills; observe disk_full WS messages and
# graceful degradation (no crash).
```

### Disk-full reproduction (macOS)

```bash
hdiutil create -size 10m -fs HFS+ -volname AiOrDieFull /tmp/disk-full.dmg
hdiutil attach /tmp/disk-full.dmg
AI_OR_DIE_SESSION_DIR=/Volumes/AiOrDieFull npm run dev
```

### Disk-full reproduction (Windows)

```powershell
# Use Disk Management to create a 10 MB VHD, mount it as Z:, then:
$env:AI_OR_DIE_SESSION_DIR = "Z:\ai-or-die"
npm run dev
```

---

## 7. References

- `docs/audits/disk-atomic-write.md` — DISK-01 audit
- `docs/audits/disk-usage-analytics-jsonl.md` — DISK-02 audit
- `docs/specs/session-store.md` — full SessionStore spec
- `test/longevity/disk/atomic-write-power-loss.test.js` — DISK-01 regression
- `test/longevity/disk/usage-analytics-growth.test.js` — DISK-02 regression (to land)
- `test/longevity/disk/enospc-handling.test.js` — DISK-03 regression (to land)
- LWN: <https://lwn.net/Articles/322823/> — ext4 + delayed allocation + rename safety
