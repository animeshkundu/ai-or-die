// Regression: the memory gate must not deliver a slope verdict from a window
// too short to support one.
//
// The gate threshold is calibrated as 10MB/4h = 2.5 MB/h. A slope expressed in
// MB/h reads as duration-independent, but it is not: extrapolating a window of
// length W to an hourly rate multiplies whatever noise is in it by 3600000/W.
// The 5-minute smoke tier measured 0.45MB of ordinary GC sawtooth and reported
// "heap slope 5.432 MB/h (threshold 2.5)" — a confident FAIL on data that
// cannot support a verdict either way.
//
// The fix returns pass:null (N/A) below a minimum window, which is what the
// harness already does for gates with no data. It must NOT weaken the leak
// check for the tiers that can measure it: nightly runs 4h and weekly 6h.

const assert = require('assert');
const { GATES } = require('../harness/gates');

const memoryGate = GATES.find((g) => g.name === 'memory');

// Build heap_used_mb rows with a given per-hour growth over a given window.
function heapRows({ windowMs, samples, mbPerHour, startMb = 40 }) {
  const rows = [];
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < samples; i++) {
    const dt = (windowMs * i) / (samples - 1);
    rows.push({
      metric: 'heap_used_mb',
      ts: t0 + dt,
      value: startMb + (mbPerHour * dt) / 3_600_000,
    });
  }
  return rows;
}

describe('longevity memory gate — slope window sufficiency', () => {
  const ctx = { thresholds: {} };

  it('returns N/A for a 5-minute window even when the extrapolated slope is huge', () => {
    // Exactly the smoke-tier shape that failed CI: 17 samples over 5 minutes.
    const rows = heapRows({ windowMs: 5 * 60 * 1000, samples: 17, mbPerHour: 5.432 });
    const res = memoryGate.evaluate(rows, ctx);
    assert.strictEqual(res.pass, null, 'a 5-minute window must not produce a verdict');
    assert.match(res.summary, /below the .* needed for a slope verdict/);
    // Still reported, so a real trend remains visible for diagnosis.
    assert.ok(res.slope_mb_per_hour > 5, 'slope must still be reported for diagnosis');
  });

  it('FAILS a genuine leak once the window is long enough (nightly 4h)', () => {
    const rows = heapRows({ windowMs: 4 * 60 * 60 * 1000, samples: 480, mbPerHour: 6 });
    const res = memoryGate.evaluate(rows, ctx);
    assert.strictEqual(res.pass, false, 'a 6 MB/h leak over 4h must still FAIL');
    assert.ok(res.slope_mb_per_hour > 5.9 && res.slope_mb_per_hour < 6.1);
  });

  it('PASSES a flat heap over a long window', () => {
    const rows = heapRows({ windowMs: 4 * 60 * 60 * 1000, samples: 480, mbPerHour: 0 });
    const res = memoryGate.evaluate(rows, ctx);
    assert.strictEqual(res.pass, true);
  });

  it('gates right at the minimum window, not just far above it', () => {
    const justUnder = memoryGate.evaluate(
      heapRows({ windowMs: 30 * 60 * 1000 - 1000, samples: 40, mbPerHour: 9 }), ctx);
    const justOver = memoryGate.evaluate(
      heapRows({ windowMs: 30 * 60 * 1000 + 1000, samples: 40, mbPerHour: 9 }), ctx);
    assert.strictEqual(justUnder.pass, null, 'just under the floor: no verdict');
    assert.strictEqual(justOver.pass, false, 'just over the floor: real leak still caught');
  });

  it('honours an explicit heap_slope_min_window_ms override', () => {
    const rows = heapRows({ windowMs: 5 * 60 * 1000, samples: 17, mbPerHour: 9 });
    const res = memoryGate.evaluate(rows, { thresholds: { heap_slope_min_window_ms: 60 * 1000 } });
    assert.strictEqual(res.pass, false, 'lowering the floor must re-enable the verdict');
  });

  it('still reports insufficient samples when there are fewer than two', () => {
    const res = memoryGate.evaluate(
      [{ metric: 'heap_used_mb', ts: 1_700_000_000_000, value: 40 }], ctx);
    assert.strictEqual(res.pass, null);
    assert.match(res.summary, /insufficient samples/);
  });
});
