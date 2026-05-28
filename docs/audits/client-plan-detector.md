# CLIENT-01 — Plan-Detector Buffer: Item-Count → Byte-Count Cap

**Lane:** SUP-CLIENT
**Status:** fix landing in same PR as memo
**Files:** `src/public/plan-detector.js`
**Severity:** medium (slow-burn tab OOM under sustained heavy output)

## Summary

`src/public/plan-detector.js` keeps a rolling buffer of PTY output chunks so it can re-scan when a trigger keyword arrives. The pre-existing cap was **item-count**: 10 000 entries, pruned to 5 000 on overflow. Each entry is `{ timestamp, data }` where `data` is the raw chunk handed to `processOutput()`. Chunk size is unbounded — the output coalescer (ADR 0009) caps coalesced flushes at 32 KB, and large `cat` / build-log / `npm ls` bursts routinely produce single chunks in the 1–8 KB range, with worst-case chunks reaching the coalescer ceiling.

**Worst-case heap math on the old policy:** 10 000 entries × 8 KB ≈ **80 MB** of retained string memory per tab. V8 stores most chunks as two-byte strings, so the real number can be 2× that. The only path to clear the buffer was a full tab refresh, `setTool()` (which calls `clearBuffer()`), or `stop/startMonitoring()` — none of which fire on long passive sessions. On a tab held open for days, the buffer climbed monotonically until the user noticed the slowdown.

## Root cause

The intent of the cap was "don't run out of memory". The implementation measured the wrong axis. With a fixed-size payload mental model (think: line-of-log per entry), 10 000 entries is generous. With realistic PTY chunks (which can carry an entire screen of output or a base64 image preview), the cap permits ~80 MB.

A secondary issue: the eviction step `slice(-maxBufferSize / 2)` allocates a new array, copies 5 000 references, then GCs the old array. Not a leak, but it's O(n) work on the hot path whenever the cap is breached.

## Fix

Switch the cap from item-count to byte-count.

- **New field:** `this.maxBufferBytes = 8 * 1024 * 1024` (8 MB hard cap).
- **New field:** `this.bufferBytes` — running total of `data.length` across the live buffer.
- **Push path:** `this.bufferBytes += data.length` after each push.
- **Eviction:** `while (this.bufferBytes > this.maxBufferBytes && this.outputBuffer.length > 0)` — `shift()` the oldest entry, subtract its `data.length`. FIFO, O(k) where k is the number of entries to evict (usually 1 unless a giant chunk arrives).
- **Reset:** `startMonitoring()` / `stopMonitoring()` / `clearBuffer()` zero `bufferBytes`.
- **Backwards compat:** `maxBufferSize` is removed; nothing outside the class reads it.

## Why `data.length` and not `Buffer.byteLength(data, 'utf8')`

`processOutput` runs on every PTY chunk; CPU cost on this path matters. `data.length` is the UTF-16 code-unit count, which:
- equals byte count for ASCII (the vast majority of PTY traffic)
- is a 2× under-estimate for two-byte strings (which V8 still stores as 2 bytes per unit internally)

So `data.length` is a faithful proxy for V8 string heap cost. We pick **8 MB as the budget unit in `data.length` terms**, which corresponds to ≤ 16 MB of actual heap under pathological two-byte-string traffic. That's still ~5× lower than the pre-fix worst case and several orders of magnitude below any tab-OOM threshold.

## Why 8 MB

Two constraints:
1. **Must hold enough text for the worst-case plan extraction.** `getRecentText()` clamps at 50 000 chars; `detectCompletedPlan()` scans `text.slice(-10000)`. So the detector only ever looks at the tail ≤ 50 KB. 8 MB is 160× that — ample headroom for tools that buffer pre-plan exposition.
2. **Must not be a noticeable tab footprint.** 8 MB is < 1 % of typical Chromium tab budgets; invisible to the user.

## Test strategy

Two layers:
- **Unit (Node, `test/plan-detector.test.js`).** Push 100 MB of synthetic chunks; assert `bufferBytes ≤ maxBufferBytes` and `bufferBytes` accounting matches the sum of `data.length` over the live buffer.
- **Browser (Playwright, `test/longevity/browser/plan-detector-byte-cap.test.js`).** Load the app, exercise `window.app.planDetector` with 100 MB of synthetic chunks, sample `bufferBytes` and assert under cap. Confirms the cap survives module loading in the actual browser environment (not just the Node `require` path).

Both tests would have failed on the pre-fix code: the unit test by observing heap growth past 80 MB, the browser test by observing `outputBuffer.length === 5000` with `bufferBytes` un-tracked (undefined).

## Out of scope

- Coalesce-on-push: not worth the complexity given the cap is now bounded by bytes.
- Per-tool cap: not justified; same cap applies regardless of which CLI is attached.
- Persisting the buffer across reload: an explicit non-goal (plan detection is best-effort on a fresh tab).
