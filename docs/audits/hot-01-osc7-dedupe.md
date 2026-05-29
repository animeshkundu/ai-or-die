# HOT-01 — OSC 7 dedupe cache miss

**Lane**: SUP-HOT (event-loop hot paths)
**Owner**: SUP-HOT
**Status**: Investigation complete. **Fix landed in HOT-06** (`src/terminal-bridge.js`).
**Files**: `src/terminal-bridge.js:195–243`, `src/server.js:341–421` (`isPathWithinBase` / `validatePath`)
**Date**: 2026-05-27 (investigation), 2026-05-28 (fix)

## Symptom

Under sustained multi-tab usage on a Windows SUBST or mapped/network drive
(e.g. `Q:\` pointing at a remote share), the Node event loop blocks in
visible 30–100 ms windows whenever any shell prompt re-renders. With
oh-my-posh / Starship / pwsh's default OSC 7 emitter, the prompt re-renders
on every keystroke, so the stall pattern is one block per keypress per
active tab. Symptoms degrade roughly linearly with the number of open
terminal tabs.

Two interacting effects produce the stall:

1. The `_lastRawOsc7` cache in `terminal-bridge.js:212–214` is **scoped per
   `sessionId`** — `Map<sessionId, string>`. It only short-circuits
   re-emissions of the **same** raw OSC 7 payload for the **same** session.
2. `validatePath()` (`src/server.js:374–421`) performs `path.resolve` →
   `fs.existsSync` → `fs.realpathSync` followed by `isPathWithinBase`,
   which in turn calls `_canonicalizePathSync` (which itself does
   `fs.realpathSync.native`). On a SUBST/network/mapped Windows drive each
   syscall is 10–50 ms. A single miss therefore costs 30–150 ms wall and
   blocks the event loop for the same duration (these are sync syscalls
   inside the PTY data callback).

The dedupe is undermined in three independent ways:

- **Per-session, not process-wide.** N tabs CD-ing into the same directory
  pay the validation cost N times — once per session, even though the
  validated canonical path is identical across sessions.
- **Defeated by alternation within a single session.** Shells that bounce
  between two cwds (e.g. `pushd`/`popd` patterns, two windows of the same
  multi-pane prompt redrawing in sequence, oh-my-posh segments that report
  on `cwd` vs `git root` separately) emit `…file:///A\x07 …file:///B\x07
  …file:///A\x07` — every emission misses the cache.
- **Defeated by case / separator / trailing-slash variance.** The cache
  key is the **raw** OSC 7 byte string. `file:///Q:/src` and
  `file:///Q:/src/` are different strings to this cache but identical
  after canonicalization. Even subtle hostname differences in the URI
  body (`file://localhost/…` vs `file://HOST/…` — see `osc7-parser.js:194`)
  produce raw misses with identical canonical results.

## Repro

The synthetic repro implemented in `test/longevity/event-loop/hot-01-osc7-dedupe.test.js`:

1. Construct `TerminalBridge` and call `_installOsc7State()` for 8 sessions
   (simulating 8 open tabs).
2. For each session, feed OSC 7 chunks alternating between two cwds
   (`/tmp/a`, `/tmp/b`), 10 cycles per session.
3. Provide a `validatePath` stub that does a 30 ms busy-wait to simulate
   one SUBST-drive `realpathSync` round-trip and counts invocations.

Observed on main:
- Validator invoked **160 times** (8 × 2 × 10) — every emission misses the
  per-session dedupe.
- `perf_hooks.monitorEventLoopDelay` records p99 lag ≥ 30 ms during the
  burst.

Both assertions trip the configured thresholds (`calls ≤ 20`,
`p99 < 50 ms`). The test FAILS on main HEAD as required for a regression
test.

## Impact (production)

- One OSC 7 burst per keystroke under SUBST/network drives, ~8 tabs:
  roughly 8 × 30 ms = **240 ms event-loop block per keystroke** under the
  worst-case alternation pattern. Even with one cwd-per-session, the
  first-touch per session is uncached: 8 × 30 ms still on cold cache.
- The block is in the PTY data callback, so all WS frames / heartbeat
  pongs / HTTP responses queue behind it. The pong watchdog
  (`heartbeat-watchdog.js`) does NOT trip at 240 ms — the daemon stays
  technically alive — but the user sees keystrokes lag and the file-browser
  SSE stream visibly stutters.
- On a fast local SSD the symptom is invisible (validatePath takes < 1 ms).
  This is a Windows-primary regression hidden from macOS/Linux dev loops.

## Proposed fix outline (HOT-06)

Replace the per-session `_lastRawOsc7` cache with a **process-wide,
canonical-keyed validated-path cache**, hosted on `TerminalBridge` (or
injected via the existing `validatePath` callback wrapper so the same
cache instance is shared across all bridges that call into the server's
`validatePath`).

Sketch:

- **Cache key**: the **canonical** path returned by `validatePath` (or
  decoded OSC 7 path pre-validation), NOT the raw OSC 7 byte string.
- **Cache value**: `{ valid: boolean, path: string, mtime: number }`.
  Storing `mtime` lets us cheaply invalidate when the directory at the
  cached canonical path has changed (e.g. been renamed/replaced); a quick
  `fs.statSync(canonical).mtimeMs` compare is one syscall vs three for
  full revalidation.
- **Bound**: LRU, 256 entries — far more than any realistic distinct-cwd
  set under sustained use.
- **TTL**: 5 s. Long enough to absorb prompt-redraw bursts; short enough
  that the user's manual `mkdir` / `rm` will be reflected at the next
  emission without a server restart.
- **Process-wide**: the cache survives session boundary, so 8 tabs CD-ing
  into the same directory pay 1 validation, not 8.

Keep the per-session `_lastRawOsc7` cache as a **fast first-level filter**
(`raw === lastRaw` is a 1-instruction string compare — strictly faster
than even a Map lookup) and add the process-wide canonical-keyed cache as
a second level after the parser decodes the URI but before `validatePath`.

### Edge cases the fix must handle

- **Cache poisoning**: a malicious symlink swap could leave the cache
  returning the wrong canonical. mtime check + 5 s TTL bounds this.
- **baseFolder change at runtime**: not currently possible (baseFolder
  is constant for the process), but if a future `setBaseFolder` is added,
  the cache must be cleared. Document this in the cache module.
- **Cache size under churn**: 256-entry LRU is bounded; even a perverse
  shell that emits 1000 distinct paths/s will only ever hold 256 entries.

## Risks of the fix

1. **Cache invalidation lag**: a path validated as inside-sandbox once,
   then symlinked outside the sandbox, would still be reported valid for
   up to 5 s. Acceptable — the symlink swap requires write access inside
   `baseFolder` already, and the same operator could just submit a
   non-sandbox raw path through any HTTP endpoint with the same effect.
2. **Mtime-based revalidation skews on FAT32 / SMB**: mtime resolution
   can be 2 s on some networked filesystems. The 5 s TTL is the binding
   guarantee; mtime is a finer-grained accelerator within the TTL.

## Out of scope

- Reworking `validatePath` itself to be async — that's an `O(callers)`
  refactor and the per-call cost is bounded by the cache fix above.
- Making OSC 7 parsing async — the parser is already cheap; the cost is
  entirely in validation.

## References

- `src/terminal-bridge.js:195–243` — `_handleOsc7Chunk`
- `src/terminal-bridge.js:46–57` — `_lastRawOsc7` Map declaration + comment
- `src/server.js:374–421` — `validatePath`
- `src/server.js:341–372` — `isPathWithinBase` (calls `_canonicalizePathSync`)
- `src/osc7-parser.js:67–147` — `Osc7Parser#feed`
- `test/longevity/event-loop/hot-01-osc7-dedupe.test.js` — regression test

## Fix landed (HOT-06)

Process-wide validated-path cache added to `TerminalBridge`
(`src/terminal-bridge.js`):

- New module constants `OSC7_CACHE_MAX_ENTRIES = 256` and
  `OSC7_CACHE_TTL_MS = 5000`.
- New instance field `_osc7ValidationCache: Map<rawPath, {validated,
  expiresAt}>` — caches both VALID and INVALID `validatePath` results
  (an out-of-sandbox path stops paying syscalls on every emission too).
- Cache hits are bumped to MRU via delete+reinsert (Map insertion order
  = LRU order, pre-existing pattern in Node).
- Bounded-LRU eviction drops oldest entries on overflow.
- 5 s TTL means a user-side `mkdir` or `rm` of a cached path is reflected
  on the next emission after expiry; the cache is **not** cleared
  proactively on session uninstall (that's the whole point — multi-tab
  same-cwd should pay validation exactly once across all tabs).
- Full `bridge.cleanup()` clears the cache so a fresh bridge starts
  fresh.

The pre-existing per-session `_lastRawOsc7` fast-path is kept as Level 1
(sub-microsecond string-identity compare for the same-raw-redraw case);
the new cache is Level 2 (sub-microsecond Map lookup for cross-session
+ alternation cases that defeat Level 1).

**Decision divergence from this memo's "Proposed fix":** the memo
described an mtime-keyed canonical-path cache. The implementation
instead uses a TTL-only raw-path cache because:
- mtime-based invalidation requires a `statSync` on every cache hit,
  which would re-introduce most of the syscall cost the fix is meant to
  eliminate.
- Canonicalizing for the key requires a syscall on every miss, just to
  decide whether two raws collide.
- The 5 s TTL bounds the staleness window; the LRU caps the cardinality
  blowup that raw-keying could theoretically cause (it doesn't in
  practice — shells emit ONE form per cwd, not alternating
  trailing-slash variants).
- Lexical-variant raws (same cwd, different string form) get cached
  separately at most once each, bounded by the LRU cap.

Test surface:
- `test/longevity/event-loop/hot-01-osc7-dedupe.test.js` — both
  regression assertions pass (validatePath called ≤ 16 across 160
  emissions; observed: 2 calls. p99 event-loop lag < 50 ms; observed:
  well under).
- `test/osc7-parser.test.js` — pre-existing same-raw-redraw test still
  passes; new `process-wide validation cache survives session uninstall
  (HOT-06)` and `full bridge cleanup() drops the process-wide validation
  cache (HOT-06)` tests document the new contract.

Out-of-scope follow-ups (deliberately deferred):
- Variance-collapsing canonicalization in the cache key (would catch
  `/tmp/x` vs `/tmp/x/` as the same hit). The shell-output assumption
  holds in practice; revisit if SUP-SOAK sees evidence otherwise in
  long soak runs.
- Surfacing cache hit-rate via `_collectDiagnostics`. Useful for tuning
  TTL/cap but not load-bearing; defer to a future diagnostics
  enrichment PR.
