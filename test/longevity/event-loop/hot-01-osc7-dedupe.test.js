// test/longevity/event-loop/hot-01-osc7-dedupe.test.js
//
// HOT-01 regression test — OSC 7 dedupe cache miss
//
// Memo: docs/audits/hot-01-osc7-dedupe.md
//
// What this proves on main HEAD (failing assertion = real bug):
//
//   The per-session `_lastRawOsc7` cache in src/terminal-bridge.js:212–214
//   only collapses BACK-TO-BACK identical raws for the SAME session. With
//   multiple tabs (multiple sessionIds) hitting the same shell-side cwd,
//   or with one tab whose shell oscillates between two cwds (pushd/popd /
//   multi-segment prompts), every emission goes through validatePath —
//   which on a Windows SUBST or network/mapped drive is 30–150 ms sync.
//
// Repro: 8 sessions × 2 alternating cwds × 10 cycles = 160 OSC 7 emissions.
// validatePath is a 30 ms busy-wait stub (proxy for SUBST-drive cost) that
// counts calls.
//
// On main:
//   • validatePath called 160 times (every emission misses dedupe).
//   • perf_hooks.monitorEventLoopDelay records p99 ≥ 30 ms during the burst.
//   ⇒ both assertions fail.
//
// After the proposed fix (process-wide canonical-keyed validated-path cache,
// 256-entry LRU, mtime + 5 s TTL — see memo §Proposed fix):
//   • validatePath called once per unique canonical path (≤ 2).
//   • perf_hooks.monitorEventLoopDelay p99 < 50 ms throughout.
//   ⇒ both assertions pass.

'use strict';

const assert = require('assert');
const { monitorEventLoopDelay } = require('perf_hooks');

const TerminalBridge = require('../../../src/terminal-bridge');

// Synchronous busy-wait — a fair stand-in for fs.realpathSync round-trips
// on a Windows SUBST/network drive. We deliberately do NOT use setTimeout
// (which yields to the event loop) — validatePath in production is sync,
// and the symptom is event-loop block, so the repro must be sync too.
function busyWait(ms) {
  const end = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < end) { /* spin */ }
}

describe('HOT-01: OSC 7 dedupe under multi-tab oscillation (event-loop hot path)', function () {
  // Test budget: 8 sessions * 2 paths * 10 cycles * 30 ms = 4.8 s wall on main.
  // After fix it's < 100 ms. Bump mocha timeout accordingly.
  this.timeout(15000);

  it('caps validatePath invocations under cross-session + alternating-cwd workload', () => {
    const bridge = new TerminalBridge();

    let validateCalls = 0;
    const validatePath = (p) => {
      validateCalls++;
      // Simulate SUBST-drive realpathSync cost. On a fast SSD validatePath
      // is < 1 ms — production-only fix verification rides on this proxy.
      busyWait(30);
      return { valid: true, path: p };
    };
    const onCwdChange = () => { /* noop — we're measuring validation, not broadcast */ };

    const SESSIONS = 8;
    const CYCLES = 10;
    // Two cwds. Alternating defeats per-session `_lastRawOsc7`. Identical
    // across sessions to expose the per-session-vs-process-wide gap.
    const cwds = ['/tmp/hot01-a', '/tmp/hot01-b'];

    for (let s = 0; s < SESSIONS; s++) {
      bridge._installOsc7State(`s${s}`, { onCwdChange, validatePath });
    }

    try {
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        for (let s = 0; s < SESSIONS; s++) {
          for (const cwd of cwds) {
            // Build a complete OSC 7 chunk: ESC ] 7 ; file://<host><path> BEL.
            // Use an empty host so the parser accepts on every platform.
            const chunk = `\x1b]7;file://${cwd}\x07`;
            bridge._handleOsc7Chunk(`s${s}`, chunk);
          }
        }
      }
    } finally {
      for (let s = 0; s < SESSIONS; s++) {
        bridge._uninstallOsc7State(`s${s}`);
      }
    }

    // Total emissions: 8 * 2 * 10 = 160.
    // On main (per-session dedupe defeated by alternation): expect 160 calls.
    // After fix (process-wide canonical cache, 2 unique paths): expect ≤ 16
    // (slack for first-touch warmup if the implementation chooses a
    // session-local fast path before consulting the shared cache).
    assert.ok(
      validateCalls <= 16,
      `validatePath called ${validateCalls} times; expected ≤ 16 ` +
      '(cross-session + alternating dedupe gap — see docs/audits/hot-01-osc7-dedupe.md)'
    );
  });

  it('keeps event-loop p99 lag under 50 ms during an OSC 7 burst', async () => {
    const bridge = new TerminalBridge();

    const validatePath = (p) => {
      busyWait(30); // SUBST-drive proxy
      return { valid: true, path: p };
    };
    const onCwdChange = () => {};

    const SESSIONS = 8;
    const CYCLES = 10;
    const cwds = ['/tmp/hot01-a', '/tmp/hot01-b'];

    for (let s = 0; s < SESSIONS; s++) {
      bridge._installOsc7State(`s${s}`, { onCwdChange, validatePath });
    }

    // Sample event-loop delay at 10 ms resolution while the burst runs.
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();

    try {
      // Spread the burst across microtask boundaries so the event-loop
      // histogram has chances to sample. We use Promise.resolve().then(...)
      // to yield between chunks; the validatePath busy-wait inside is what
      // produces the lag the histogram should record.
      const yieldNext = () => new Promise((r) => setImmediate(r));
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        for (let s = 0; s < SESSIONS; s++) {
          for (const cwd of cwds) {
            bridge._handleOsc7Chunk(`s${s}`, `\x1b]7;file://${cwd}\x07`);
          }
          await yieldNext(); // give the loop monitor a chance to sample
        }
      }
    } finally {
      h.disable();
      for (let s = 0; s < SESSIONS; s++) {
        bridge._uninstallOsc7State(`s${s}`);
      }
    }

    // perf_hooks.monitorEventLoopDelay reports nanoseconds.
    const p99ms = h.percentile(99) / 1e6;
    const maxMs = h.max / 1e6;

    // On main: validatePath blocks 30 ms inline per call; the histogram
    // sees gaps ≥ 30 ms repeatedly, p99 ≥ 30 ms. After the fix the cache
    // hit path is ~0 ms and p99 lag is dominated by Node's idle scheduling
    // (< 5 ms typically; 50 ms allows headroom for noisy CI).
    assert.ok(
      p99ms < 50,
      `event-loop p99 lag = ${p99ms.toFixed(2)} ms (max ${maxMs.toFixed(2)} ms); ` +
      'expected < 50 ms — process-wide OSC 7 validated-path cache not in place ' +
      '(see docs/audits/hot-01-osc7-dedupe.md)'
    );
  });
});
