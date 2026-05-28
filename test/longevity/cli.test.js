'use strict';

/**
 * Unit tests for the soak CLI's argument parser (SOAK-05l).
 *
 * Focused on the `--workload-opts=name.key=value` repeatable flag plumbing.
 * Other flags (--duration, --workloads, --gates, --resume, --browser-page)
 * are covered indirectly by the existing smoke / resume / browser-sampler
 * tests; those exercise the runner end-to-end.
 */

const assert = require('assert');

const { parseArgs, parseDuration } = require('./harness/cli');

describe('CLI parseArgs — workload-opts (SOAK-05l)', () => {
  function p(...flags) {
    // simulate process.argv shape: [node, script, ...flags]
    return parseArgs(['node', 'cli.js', ...flags]);
  }

  it('parses a single --workload-opts into the workloadOpts map', () => {
    const args = p('--workload-opts=mock-clock.batchSize=50');
    assert.deepStrictEqual(args._workloadOpts, {
      'mock-clock': { batchSize: 50 },
    });
  });

  it('parses multiple --workload-opts on the same workload as merged keys', () => {
    const args = p(
      '--workload-opts=mock-clock.batchSize=50',
      '--workload-opts=mock-clock.maxInjected=50000',
      '--workload-opts=mock-clock.sweepsPerSecond=5',
    );
    assert.deepStrictEqual(args._workloadOpts, {
      'mock-clock': { batchSize: 50, maxInjected: 50000, sweepsPerSecond: 5 },
    });
  });

  it('parses --workload-opts across multiple workloads', () => {
    const args = p(
      '--workload-opts=mock-clock.batchSize=50',
      '--workload-opts=session-stringify.sessionCount=500',
      '--workload-opts=pty-flood-ws.targetBytesPerSecond=5242880',
    );
    assert.deepStrictEqual(args._workloadOpts, {
      'mock-clock': { batchSize: 50 },
      'session-stringify': { sessionCount: 500 },
      'pty-flood-ws': { targetBytesPerSecond: 5242880 },
    });
  });

  it('coerces value types: int / float / true / false / string', () => {
    const args = p(
      '--workload-opts=demo.intVal=42',
      '--workload-opts=demo.floatVal=1.5',
      '--workload-opts=demo.trueVal=true',
      '--workload-opts=demo.falseVal=false',
      '--workload-opts=demo.strVal=hello',
      '--workload-opts=demo.negVal=-7',
    );
    assert.deepStrictEqual(args._workloadOpts.demo, {
      intVal: 42,
      floatVal: 1.5,
      trueVal: true,
      falseVal: false,
      strVal: 'hello',
      negVal: -7,
    });
  });

  it('omits _workloadOpts entirely when no --workload-opts present', () => {
    const args = p('--duration=60s', '--workloads=noop');
    assert.strictEqual(args._workloadOpts, undefined);
  });

  it('rejects malformed --workload-opts (missing dot or equals)', () => {
    assert.throws(() => p('--workload-opts=mock-clock-batchSize-50'),
      /bad --workload-opts/, 'missing dot');
    assert.throws(() => p('--workload-opts=mock-clock.batchSize'),
      /bad --workload-opts/, 'missing equals');
  });

  it('allows other args to coexist alongside --workload-opts', () => {
    const args = p(
      '--duration=10m',
      '--workloads=mock-clock',
      '--workload-opts=mock-clock.batchSize=50',
      '--label=stress',
    );
    assert.strictEqual(args.duration, '10m');
    assert.strictEqual(args.workloads, 'mock-clock');
    assert.strictEqual(args.label, 'stress');
    assert.deepStrictEqual(args._workloadOpts, { 'mock-clock': { batchSize: 50 } });
  });
});

describe('CLI parseDuration', () => {
  it('parses ms / s / m / h units', () => {
    assert.strictEqual(parseDuration('500ms'), 500);
    assert.strictEqual(parseDuration('30s'), 30_000);
    assert.strictEqual(parseDuration('5m'), 300_000);
    assert.strictEqual(parseDuration('2h'), 7_200_000);
  });
  it('defaults to seconds when no unit', () => {
    assert.strictEqual(parseDuration('45'), 45_000);
  });
  it('rejects garbage', () => {
    assert.throws(() => parseDuration('abc'), /bad duration/);
    assert.throws(() => parseDuration('5x'), /bad duration/);
  });
});
