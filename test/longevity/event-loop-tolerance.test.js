'use strict';

/**
 * Regression tests for the event_loop gate's isolated-runner-stall tolerance.
 *
 * Background: the longevity PR-blocking smoke (5-min soak, 20s interval, ~15
 * samples) flaked on shared Windows CI when an IDLE process (0 sessions, 0 ws,
 * ~28MB RSS) hit ONE 20s window with p99 ~70ms / max ~1345ms — a single GC/OS
 * scheduling stall, not app latency. The old `every(row.pass)` verdict failed
 * the whole soak on that one window. The fix tolerates at most ONE isolated
 * outlier window while still hard-failing every SUSTAINED signal: an extreme
 * stall (max >= 2000ms), >= 2 CONSECUTIVE bad windows, or > 1 bad window total.
 * Tolerance only applies with >= 10 samples.
 *
 * These tests pin that behavior so a future change can't silently widen the
 * tolerance (masking real regressions) or revert it (re-introducing the flake).
 */

const assert = require('assert');

const { GateEvaluator } = require('./harness/gate-evaluator');

// One sample window = a p99_ms row + a max_ms row sharing a timestamp (the
// sampler emits both per tick). tsOffsetMs spaces windows 20s apart, matching
// the smoke's --interval=20s.
function ingestWindow(evaluator, { p99, max }, tsOffsetMs) {
  const ts = new Date(2026, 0, 1, 0, 0, 0, 0).getTime() + tsOffsetMs;
  const iso = new Date(ts).toISOString();
  evaluator.ingest({ ts: iso, gate: 'event_loop', metric: 'p99_ms', value: p99, threshold: 50, pass: p99 < 50 });
  evaluator.ingest({ ts: iso, gate: 'event_loop', metric: 'max_ms', value: max, threshold: 200, pass: max < 200 });
}

// Build N windows from a generator(i) -> {p99, max}, 20s apart.
function ingestWindows(evaluator, n, gen) {
  for (let i = 0; i < n; i++) ingestWindow(evaluator, gen(i), i * 20_000);
}

function evalEventLoop(evaluator) {
  return evaluator.evaluate().gates.find(g => g.name === 'event_loop');
}

const HEALTHY = () => ({ p99: 5, max: 30 });

describe('Gate evaluator — event_loop isolated-stall tolerance', () => {
  it('PASSes a clean 15-sample run (no bad windows)', () => {
    const ev = new GateEvaluator({ gates: ['event_loop'] });
    ingestWindows(ev, 15, HEALTHY);
    const g = evalEventLoop(ev);
    assert.strictEqual(g.pass, true, g.summary);
    assert.strictEqual(g.bad_windows, 0);
    assert.strictEqual(g.tolerated_outlier, false);
  });

  it('PASSes 15 samples with ONE isolated runner stall (the exact CI flake: p99 69.67, max 1345.32)', () => {
    const ev = new GateEvaluator({ gates: ['event_loop'] });
    ingestWindows(ev, 15, (i) => (i === 7 ? { p99: 69.67, max: 1345.32 } : HEALTHY()));
    const g = evalEventLoop(ev);
    assert.strictEqual(g.pass, true, `the one-stall CI scenario should PASS, got ${g.pass} (${g.summary})`);
    assert.strictEqual(g.bad_windows, 1);
    assert.strictEqual(g.tolerated_outlier, true, 'the outlier should be reported as tolerated');
    assert.ok(Math.abs(g.max_peak_ms - 1345.32) < 0.01);
    assert.ok(Math.abs(g.p99_peak_ms - 69.67) < 0.01);
  });

  it('counts a window breaching BOTH p99 and max as ONE bad window, not two', () => {
    const ev = new GateEvaluator({ gates: ['event_loop'] });
    ingestWindows(ev, 15, (i) => (i === 3 ? { p99: 120, max: 900 } : HEALTHY()));
    const g = evalEventLoop(ev);
    assert.strictEqual(g.bad_windows, 1, 'a window failing both metrics is one bad window');
    assert.strictEqual(g.pass, true, g.summary);
  });

  it('FAILs on TWO non-consecutive bad windows (one p99-only, one max-only)', () => {
    const ev = new GateEvaluator({ gates: ['event_loop'] });
    ingestWindows(ev, 15, (i) => {
      if (i === 4) return { p99: 80, max: 40 };
      if (i === 11) return { p99: 5, max: 500 };
      return HEALTHY();
    });
    const g = evalEventLoop(ev);
    assert.strictEqual(g.pass, false, 'two separate bad windows should FAIL');
    assert.strictEqual(g.bad_windows, 2);
  });

  it('FAILs on TWO CONSECUTIVE bad windows even within the count tolerance (sustained hot-loop)', () => {
    const ev = new GateEvaluator({ gates: ['event_loop'] });
    ingestWindows(ev, 15, (i) => (i === 6 || i === 7 ? { p99: 70, max: 250 } : HEALTHY()));
    const g = evalEventLoop(ev);
    assert.strictEqual(g.pass, false, 'consecutive bad windows should FAIL (sustained)');
    assert.ok(g.max_consecutive_bad >= 2, `expected >=2 consecutive, got ${g.max_consecutive_bad}`);
  });

  it('FAILs on a sustained low-grade p99 hot-loop (many consecutive windows just over limit)', () => {
    const ev = new GateEvaluator({ gates: ['event_loop'] });
    ingestWindows(ev, 15, () => ({ p99: 55, max: 60 }));
    const g = evalEventLoop(ev);
    assert.strictEqual(g.pass, false, 'sustained p99 just-over-limit should FAIL');
    assert.strictEqual(g.bad_windows, 15);
  });

  it('FAILs on an EXTREME isolated stall (max >= 2000ms ceiling) even as the only outlier', () => {
    const ev = new GateEvaluator({ gates: ['event_loop'] });
    ingestWindows(ev, 15, (i) => (i === 9 ? { p99: 90, max: 5000 } : HEALTHY()));
    const g = evalEventLoop(ev);
    assert.strictEqual(g.pass, false, 'an extreme 5s stall must FAIL despite being isolated');
    assert.ok(/extreme/i.test(g.summary), `summary should cite the ceiling: ${g.summary}`);
  });

  it('tolerates an isolated stall right UP TO but under the 2000ms ceiling', () => {
    const ev = new GateEvaluator({ gates: ['event_loop'] });
    ingestWindows(ev, 15, (i) => (i === 2 ? { p99: 60, max: 1999 } : HEALTHY()));
    const g = evalEventLoop(ev);
    assert.strictEqual(g.pass, true, '1999ms < 2000ms ceiling should still be tolerated as one outlier');
  });

  it('does NOT tolerate the only bad window when sample count is below the floor (< 10 samples)', () => {
    const ev = new GateEvaluator({ gates: ['event_loop'] });
    ingestWindows(ev, 6, (i) => (i === 2 ? { p99: 69.67, max: 1345.32 } : HEALTHY()));
    const g = evalEventLoop(ev);
    assert.strictEqual(g.pass, false, 'with < 10 samples a single bad window should FAIL (no tolerance)');
    assert.strictEqual(g.bad_windows, 1);
  });

  it('PASSes a clean short run below the sample floor (zero bad windows, no tolerance needed)', () => {
    const ev = new GateEvaluator({ gates: ['event_loop'] });
    ingestWindows(ev, 6, HEALTHY);
    const g = evalEventLoop(ev);
    assert.strictEqual(g.pass, true, g.summary);
    assert.strictEqual(g.bad_windows, 0);
  });

  it('returns pass:null when there are no event-loop samples', () => {
    const ev = new GateEvaluator({ gates: ['event_loop'] });
    const g = evalEventLoop(ev);
    assert.strictEqual(g.pass, null);
  });
});
