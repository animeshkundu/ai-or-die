'use strict';

/**
 * Unit tests for SOAK-05n vacuous-PASS guard in the gate evaluator.
 *
 * Tests the scenario that surfaced in SOAK-05m: a soak with --browser-page
 * but without a workload that drives output through the WS broadcast layer.
 * The browser sampler emits client.plan_detector.bytes rows but all values
 * are 0. Pre-SOAK-05n, the gate reported PASS ("0 ≤ 8 MB cap held").
 * Post-SOAK-05n, the gate must report 'vacuous' to flag the gap.
 */

const assert = require('assert');

const { GateEvaluator } = require('./harness/gate-evaluator');

function makePlanDetectorRow(value, tsOffsetMs = 0) {
  return {
    ts: new Date(2026, 0, 1, 0, 0, tsOffsetMs / 1000).toISOString(),
    gate: 'client.plan_detector',
    metric: 'bytes',
    value,
    threshold: 8 * 1024 * 1024,
    pass: null,
  };
}

describe('Gate evaluator — SOAK-05n vacuous-PASS guard', () => {
  it('reports VACUOUS when client.plan_detector.bytes peak is 0 across all samples', () => {
    const evaluator = new GateEvaluator({ gates: ['client.plan_detector'] });
    for (let i = 0; i < 30; i++) {
      evaluator.ingest(makePlanDetectorRow(0, i * 30_000));
    }
    const result = evaluator.evaluate();
    const gate = result.gates.find(g => g.name === 'client.plan_detector');
    assert.strictEqual(gate.pass, 'vacuous',
      `expected pass: 'vacuous', got ${gate.pass}`);
    assert.match(gate.summary, /vacuous|VACUOUS|UNTESTED/i,
      `summary should mention vacuous/UNTESTED, got: ${gate.summary}`);
    assert.strictEqual(result.vacuous_count, 1, 'vacuous_count reflects the vacuous gate');
    assert.strictEqual(result.overall, false, 'overall verdict is false when any gate is vacuous');
  });

  it('reports PASS when client.plan_detector.bytes crosses non-zero AND stays under cap', () => {
    const evaluator = new GateEvaluator({ gates: ['client.plan_detector'] });
    // Buffer grows to ~6 MB and oscillates — typical of CLIENT-01's
    // eviction-on-cap behavior under sustained WS broadcast.
    const samples = [0, 2_000_000, 5_500_000, 6_200_000, 5_800_000, 6_100_000];
    for (let i = 0; i < samples.length; i++) {
      evaluator.ingest(makePlanDetectorRow(samples[i], i * 30_000));
    }
    const result = evaluator.evaluate();
    const gate = result.gates.find(g => g.name === 'client.plan_detector');
    assert.strictEqual(gate.pass, true,
      `expected pass: true, got ${gate.pass} (summary: ${gate.summary})`);
    assert.strictEqual(result.vacuous_count, 0);
    assert.strictEqual(result.overall, true);
  });

  it('reports FAIL when client.plan_detector.bytes peak exceeds 8 MB cap', () => {
    const evaluator = new GateEvaluator({ gates: ['client.plan_detector'] });
    const samples = [0, 2_000_000, 8_500_000, 9_100_000]; // breached cap
    for (let i = 0; i < samples.length; i++) {
      evaluator.ingest(makePlanDetectorRow(samples[i], i * 30_000));
    }
    const result = evaluator.evaluate();
    const gate = result.gates.find(g => g.name === 'client.plan_detector');
    assert.strictEqual(gate.pass, false,
      `expected pass: false (over cap), got ${gate.pass}`);
    assert.strictEqual(result.vacuous_count, 0,
      'cap-breach is FAIL, not VACUOUS');
  });

  it('reports N/A (pass:null) when no client.plan_detector rows present', () => {
    const evaluator = new GateEvaluator({ gates: ['client.plan_detector'] });
    // no rows ingested
    const result = evaluator.evaluate();
    const gate = result.gates.find(g => g.name === 'client.plan_detector');
    assert.strictEqual(gate.pass, null);
    assert.strictEqual(result.vacuous_count, 0);
  });

  it('vacuous_count surfaces in evaluation result alongside decidable_count', () => {
    const evaluator = new GateEvaluator({ gates: ['client.plan_detector'] });
    for (let i = 0; i < 10; i++) evaluator.ingest(makePlanDetectorRow(0, i * 30_000));
    const result = evaluator.evaluate();
    assert.strictEqual(typeof result.vacuous_count, 'number');
    assert.strictEqual(result.vacuous_count, 1);
    assert.strictEqual(typeof result.decidable_count, 'number');
  });
});
