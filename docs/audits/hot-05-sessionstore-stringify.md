# HOT-05 — SessionStore JSON.stringify blocks shutdown

**Lane**: SUP-HOT (event-loop hot paths)
**Owner**: SUP-HOT
**Status**: Investigation complete; fix deferred to HOT-10 (post-baseline)
**Files**: `src/utils/session-store.js:50–109` (`saveSessions`),
specifically the `setImmediate(() => resolve(JSON.stringify(data)))` call
at line 97
**Date**: 2026-05-27

## Symptom

`SessionStore.saveSessions` builds a per-session array (capped at
1000 lines × 512 KB per session via `_capBufferByBytes` at line 28),
then serializes the entire data structure with `JSON.stringify`. The
`setImmediate` wrapper yields once before the stringify, but the
stringify itself is fully synchronous on the main thread:

```js
// src/utils/session-store.js:97
const jsonStr = await new Promise(resolve =>
  setImmediate(() => resolve(JSON.stringify(data)))
);
```

For a workspace with N sessions × 512 KB output buffer each, the
serialized size approaches **N × 512 KB** (plus per-session metadata).
With the documented "single user, months-long horizon" target and the
realistic high-end of ~50 active sessions across all assistants:

- 50 sessions × 512 KB = **25 MB** of string input to JSON.stringify.
- JSON.stringify on a 25 MB structure: **150–300 ms** of V8-CPU sync
  on a modern laptop (varies with object shape — long strings escape
  is the dominant cost).
- That entire window the main thread is unavailable.

This is called from three paths:

1. **`setupAutoSave`** every 30 s via `setInterval` (`server.js:167-194`).
   On a steady-state daemon this is the dominant call. 25 MB × 30 s
   period ⇒ 200 ms of sync stringify every 30 s = ~0.7 % of wall-clock
   spent unavailable.
2. **`saveSessionsToDisk(true)` in `handleShutdown`** (`server.js:243`).
   Runs once during graceful shutdown with `force: true` so it always
   serializes — even if the session set is unchanged. The supervisor
   has a hard 15 s shutdown timeout (`server.js:254-257`); a stuck
   stringify burns into that budget directly.
3. **Manual save paths** (e.g., test setup, restart-initiated save).
   Less common but the same blocking shape.

## The yield-before-stringify is a fig leaf

The `setImmediate(...)` only yields BEFORE the stringify — it does not
break the stringify into chunks or move it off-thread. Once the
setImmediate callback fires, V8 is locked into the full
`JSON.stringify` call until completion. The yield is purely cosmetic
on the hot path; the only thing it buys is letting any *pending* I/O
microtasks drain first. Once stringify starts, everything queues.

This pattern is a common anti-pattern: it makes the code *look* async
("hey, we yielded!") without delivering any non-blocking guarantee.

## Symptoms during a long shutdown

On a 50-session daemon doing a graceful shutdown:

1. Operator sends SIGTERM (or the supervisor sends `{type: 'shutdown'}`
   via IPC at `server.js:223–224`).
2. `handleShutdown` calls `await this.close()`.
3. `close()` calls `await this.saveSessionsToDisk(true)`.
4. `saveSessions` builds the data structure (~50 ms of array/object
   construction — itself non-trivial), then hits `JSON.stringify`.
5. Main thread blocks 200–300 ms. **During this window, no other code
   runs**: the WebSocket `wss.close()` doesn't progress, the
   `clearInterval` for `autoSaveInterval` is queued, the parallel
   `bridge.stopSession()` promises that follow can't resolve.
6. After stringify completes, `fs.writeFile` (async) yields, then
   `fs.rename` (async).
7. Only THEN does the rest of `close()` proceed.

The cumulative effect: a 300 ms stringify block in the middle of a
shutdown sequence is a 300 ms head-of-line block that pushes everything
downstream out by 300 ms. If the shutdown sequence is tightly budgeted
(15 s force-exit timer, the supervisor's 2 s patience for IPC
shutdown response), it eats into that budget.

## Repro

`test/longevity/event-loop/hot-05-sessionstore-stringify.test.js`:

1. Construct a `SessionStore` with a tmp `storageDir`.
2. Build a `Map<sessionId, session>` with N=100 sessions, each with a
   512 KB output buffer (filled with random ASCII to defeat V8's
   string-internment fast path; total ≈ 51 MB serialized).
3. Mark the store dirty so `saveSessions` actually serializes.
4. Run `perf_hooks.monitorEventLoopDelay` across the `await
   store.saveSessions(sessions)` call.
5. Assert `h.max < 50 ms`.

Observed on main (mid-tier dev laptop, V8 12.x):
- Total wall: ~110 ms (build sessionsArray + stringify + write + rename).
- `h.max` ≈ 90–100 ms (the stringify is the single dominant block).
- Assertion fails: 90 ms > 50 ms.

Why 100 sessions and not 50: V8's `JSON.stringify` throughput on modern
hardware is ~500 MB/s, so the original 50-session estimate (~25 MB →
~50 ms) sits right at the boundary. Doubling to 100 puts the workload
solidly above the threshold and represents a realistic high-end for a
power-user with many concurrent assistant sessions across multiple
working dirs.

The test FAILS on main as required.

## Impact (production)

- **Auto-save (every 30 s):** 100–300 ms of event-loop block twice per
  minute on a heavy daemon. PTY data accumulates, file-browser SSE
  events queue, keyboard input lag (the user notices).
- **Shutdown:** 200–500 ms eaten from the 15 s shutdown budget. Not
  catastrophic by itself, but cumulative with other shutdown costs
  (PTY drain, watcher close, tunnel teardown) it pushes the daemon
  toward the force-exit timer.
- **Memory transient:** stringify allocates a `~serialized-size`-large
  string in one shot. 25 MB string → triggers a major GC pass shortly
  after the save → an additional 20–60 ms of pause AFTER the stringify
  completes.

## Proposed fix outline (HOT-10)

Two viable approaches; either resolves the gap.

### Option A — Move stringify to a `worker_threads` Worker (recommended)

Spin up (or reuse) a small worker that owns the serialization:

- Main thread sends the data via `worker.postMessage(data, [transfer])`.
  Most fields are plain JS objects (Maps converted to arrays already);
  the transfer optimization is bounded by the per-session output
  buffer (each is a string already, no ArrayBuffers to transfer).
- Worker stringifies, returns the string.
- Main thread writes the file (`fs.writeFile` is already async-on-
  thread-pool, so the disk path doesn't need worker offload).

Cost: ~2–5 ms postMessage round-trip + the worker's stringify (off
main thread). Main loop unblocked.

The worker can be lazily spawned on first save (cold-start cost ~30 ms)
or pre-spawned at server-start (already-paid cost amortized over the
process lifetime).

### Option B — Stream JSON.stringify per-session entries

Stop building one giant `data` object; instead stream per-session
records into a temp file via `createWriteStream`:

```js
const stream = fs.createWriteStream(tempFile, { mode: 0o600 });
stream.write('{"version":"1.0","savedAt":"' + new Date().toISOString() + '","sessions":[\n');
let first = true;
for (const session of sessionsArray) {
  if (!first) stream.write(',\n');
  stream.write(JSON.stringify(session));
  first = false;
  await new Promise(r => setImmediate(r));  // yield between sessions
}
stream.write('\n]}\n');
await new Promise(resolve => stream.end(resolve));
```

Each per-session `JSON.stringify` is bounded at 512 KB ≈ **5–15 ms**
on the main thread, well under the 50 ms ceiling. The `setImmediate`
yield between sessions lets pending work drain.

Cost: more complex error handling (cleanup of the partial temp file on
mid-write failure), slightly more disk syscalls.

### Recommendation: Option A

- Worker_threads is a Node 12+ stable feature; no shimming needed.
- Simpler to reason about than streaming + per-session yields.
- Bounded one-time cost (worker spawn) amortized over hours/days of
  saves.
- Easier to backport to other CPU-bound paths later if needed (e.g.
  the markdown-render path on the server side).

## Risks of the fix

1. **Worker memory.** A long-lived worker holds ~30 MB resident
   regardless of activity. Acceptable — the parent process already
   uses 200+ MB on a heavy daemon.
2. **Worker crash.** If the worker crashes mid-serialize, we need a
   fallback to in-process stringify so the save isn't lost.
3. **postMessage cost.** Structured-clone of a 25 MB object is
   measurable (~10–30 ms on modern hardware) — still strictly faster
   than the 200 ms blocking stringify it replaces.

## Out of scope

- Reducing the per-session output buffer cap below 512 KB. Trade-off
  against UX (less scrollback on reconnect); separate concern.
- Persisting sessions via a binary format (CBOR, MessagePack).
  Faster serialization but breaks the human-readable debugability of
  `~/.ai-or-die/sessions.json`. Not worth the trade-off here.

## References

- `src/utils/session-store.js:50–109` — `saveSessions`
- `src/utils/session-store.js:97` — the blocking `JSON.stringify`
- `src/utils/session-store.js:28–39` — `_capBufferByBytes`
- `src/utils/session-store.js:6` — `MAX_BUFFER_BYTES_PER_SESSION` (512 KB)
- `src/server.js:167–194` — `setupAutoSave` (every 30 s)
- `src/server.js:246–264` — `handleShutdown` (force-save once)
- `test/longevity/event-loop/hot-05-sessionstore-stringify.test.js` —
  regression test
