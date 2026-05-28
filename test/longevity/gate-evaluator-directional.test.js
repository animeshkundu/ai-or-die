'use strict';

/**
 * Unit tests for SOAK-05x directional gate fixes.
 *
 * Tests the scenario that surfaced in round-6 CI: the `fd` gate flagged
 * a HEALTHY decrease (33 → 29, Δ -4, -12.12%) as FAIL because the prior
 * `Math.abs(pctDelta) <= pctLimit` check is direction-agnostic. The fix:
 * only positive growth past threshold = FAIL; explicit pass on decrease.
 *
 * The `handles` gate had the same latent bug (not surfaced in any past
 * soak because handles always grew under synthetic load) — fixed
 * defensively to prevent it biting a future cleaner-teardown run.
 */

const assert = require('assert');

const { GateEvaluator } = require('./harness/gate-evaluator');

function makeFdRow(value, tsOffsetMs = 0) {
  return {
    ts: new Date(2026, 0, 1, 0, 0, tsOffsetMs / 1000).toISOString(),
    gate: 'fd',
    metric: 'fd_count',
    value,
    threshold: null,
    pass: null,
  };
}

function makeHandlesRow(value, tsOffsetMs = 0) {
  return {
    ts: new Date(2026, 0, 1, 0, 0, tsOffsetMs / 1000).toISOString(),
    gate: 'handles',
    metric: 'active_handles',
    value,
    threshold: null,
    pass: null,
  };
}

describe('Gate evaluator — SOAK-05x directional fix (fd)', () => {
  it('PASSes on clean fd_count decrease (round-6 CI scenario)', () => {
    // 33 → 29 over 5 samples — exactly what round-6 CI flagged as FAIL.
    const evaluator = new GateEvaluator({ gates: ['fd'] });
    [33, 32, 30, 29, 29].forEach((v, i) => evaluator.ingest(makeFdRow(v, i * 30_000)));
    const result = evaluator.evaluate();
    const gate = result.gates.find(g => g.name === 'fd');
    assert.strictEqual(gate.pass, true,
      `clean fd decrease should PASS, got ${gate.pass} (summary: ${gate.summary})`);
    assert.strictEqual(gate.abs_delta, -4);
    assert.ok(gate.pct_delta < 0, 'pct_delta is negative for a decrease');
  });

  it('FAILs on fd_count growth past threshold (real leak)', () => {
    const evaluator = new GateEvaluator({ gates: ['fd'] });
    [29, 30, 32, 34, 35].forEach((v, i) => evaluator.ingest(makeFdRow(v, i * 30_000))); // +20.7%
    const result = evaluator.evaluate();
    const gate = result.gates.find(g => g.name === 'fd');
    assert.strictEqual(gate.pass, false, 'fd growth past 1% should FAIL');
    assert.strictEqual(gate.abs_delta, 6);
  });

  it('PASSes on fd_count growth within threshold (e.g. < 1%)', () => {
    const evaluator = new GateEvaluator({ gates: ['fd'] });
    // 1000 → 1005 = +0.5% (under 1% threshold)
    [1000, 1001, 1003, 1004, 1005].forEach((v, i) => evaluator.ingest(makeFdRow(v, i * 30_000)));
    const result = evaluator.evaluate();
    const gate = result.gates.find(g => g.name === 'fd');
    assert.strictEqual(gate.pass, true,
      `small fd growth (0.5%) under 1% threshold should PASS, got ${gate.pass}`);
  });

  it('PASSes on fd_count unchanged', () => {
    const evaluator = new GateEvaluator({ gates: ['fd'] });
    [50, 50, 50, 50, 50].forEach((v, i) => evaluator.ingest(makeFdRow(v, i * 30_000)));
    const result = evaluator.evaluate();
    const gate = result.gates.find(g => g.name === 'fd');
    assert.strictEqual(gate.pass, true, 'unchanged fd_count should PASS');
    assert.strictEqual(gate.abs_delta, 0);
  });

  it('N/A on non-Linux (fd_count rows absent)', () => {
    const evaluator = new GateEvaluator({ gates: ['fd'] });
    // no rows ingested
    const result = evaluator.evaluate();
    const gate = result.gates.find(g => g.name === 'fd');
    assert.strictEqual(gate.pass, null);
  });
});

describe('Gate evaluator — SOAK-05x directional fix (handles)', () => {
  it('PASSes on clean handles decrease (e.g. 35 → 11 teardown)', () => {
    // Defensive: not surfaced in any past soak but the same Math.abs() bug
    // existed in handles gate. Verify clean teardown now PASSes.
    const evaluator = new GateEvaluator({ gates: ['handles'] });
    [35, 28, 20, 15, 11].forEach((v, i) => evaluator.ingest(makeHandlesRow(v, i * 30_000)));
    const result = evaluator.evaluate();
    const gate = result.gates.find(g => g.name === 'handles');
    assert.strictEqual(gate.pass, true,
      `clean handles decrease should PASS, got ${gate.pass} (summary: ${gate.summary})`);
    assert.strictEqual(gate.abs_delta, -24);
  });

  it('FAILs on handles growth past abs limit (5)', () => {
    const evaluator = new GateEvaluator({ gates: ['handles'] });
    [5, 7, 8, 10, 11].forEach((v, i) => evaluator.ingest(makeHandlesRow(v, i * 30_000)));
    const result = evaluator.evaluate();
    const gate = result.gates.find(g => g.name === 'handles');
    assert.strictEqual(gate.pass, false,
      `handles growth Δ +6 (> 5 abs limit) should FAIL, got ${gate.pass}`);
  });

  it('PASSes on handles growth within abs limit OR pct limit', () => {
    const evaluator = new GateEvaluator({ gates: ['handles'] });
    // 100 → 101 = +1 abs (≤ 5 abs limit) AND +1% (≤ 2% pct limit)
    [100, 100, 101, 101, 101].forEach((v, i) => evaluator.ingest(makeHandlesRow(v, i * 30_000)));
    const result = evaluator.evaluate();
    const gate = result.gates.find(g => g.name === 'handles');
    assert.strictEqual(gate.pass, true, 'small handles growth under both thresholds should PASS');
  });
});
