'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const probe = require('../scripts/soak-memory-probe');

describe('soak-memory-probe', function () {
  it('parses the documented arm, duration, rate, cadence, and output flags', function () {
    const options = probe.parseArgs([
      '--arm', 'persist-off',
      '--duration-seconds', '600',
      '--session-rate', '59',
      '--sample-seconds', '20',
      '--payload-bytes', '256',
      '--output-dir', 'probe-results',
      '--repetition', '3',
      '--seed', '42',
    ]);

    assert.strictEqual(options.arm, 'persist-off');
    assert.strictEqual(options.durationSeconds, 600);
    assert.strictEqual(options.sessionRate, 59);
    assert.strictEqual(options.sampleSeconds, 20);
    assert.strictEqual(options.payloadBytes, 256);
    assert.strictEqual(options.outputDir, 'probe-results');
    assert.strictEqual(options.repetition, 3);
    assert.strictEqual(options.seed, 42);
  });

  it('rejects invalid arms and numeric arguments', function () {
    assert.throws(
      () => probe.parseArgs(['--arm', 'unknown']),
      /--arm must be one of/
    );
    assert.throws(
      () => probe.parseArgs(['--arm', 'persist-on', '--session-rate', '0']),
      /--session-rate must be a positive integer/
    );
    assert.throws(
      () => probe.parseArgs(['--arm', 'persist-on', '--payload-bytes', '16']),
      /--payload-bytes must be at least 32/
    );
  });

  it('defaults serialization to a production-scale payload without changing retention arms', function () {
    const serialization = probe.parseArgs(['--arm', 'serialization']);
    const retention = probe.parseArgs(['--arm', 'persist-on']);

    assert.strictEqual(serialization.payloadBytes, 12500);
    assert.strictEqual(retention.payloadBytes, 1024);
  });

  it('computes a known regression slope, R-squared, and sample standard deviation', function () {
    const regression = probe.linearRegression([
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 5 },
      { x: 3, y: 7 },
    ]);

    assert.strictEqual(regression.slope, 2);
    assert.strictEqual(regression.intercept, 1);
    assert.strictEqual(regression.r2, 1);
    assert.strictEqual(regression.n, 4);
    assert.strictEqual(probe.standardDeviation([1, 2, 3]), 1);
  });

  it('builds exact-length deterministic payloads that are unique per session', function () {
    const first = probe.makeUniquePayload(0, 128, 1234);
    const second = probe.makeUniquePayload(1, 128, 1234);

    assert.strictEqual(Buffer.byteLength(first), 128);
    assert.strictEqual(Buffer.byteLength(second), 128);
    assert.notStrictEqual(first, second);
    assert.strictEqual(probe.makeUniquePayload(0, 128, 1234), first);
    assert.strictEqual(probe.assertUniquePayloads(100, 128, 1234), 100);
  });

  it('records the complete per-sample measurement shape', function () {
    const record = probe.createSampleRecord({
      arm: 'persist-on',
      phase: 'retention',
      repetition: 2,
      elapsedSeconds: 30,
      postGcHeapUsedBytes: 1000,
      rssBytes: 2000,
      sessionsTotal: 59,
      sessionsJsonBytes: 3000,
      instrumentation: {
        stringifyDurationMs: 4,
        writeDurationMs: 5,
        saveQueueDepth: 0,
        saveQueueDepthPeak: 7,
        writeOverlapCount: 0,
        stringifyPeakHeapUsedBytes: 4000,
        writePeakHeapUsedBytes: 5000,
      },
    });

    assert.deepStrictEqual(
      Object.keys(record).sort(),
      [
        'arm',
        'elapsed_seconds',
        'phase',
        'post_gc_heap_used_bytes',
        'repetition',
        'rss_bytes',
        'save_queue_depth',
        'save_queue_depth_peak',
        'sessions_json_bytes',
        'sessions_total',
        'stringify_duration_ms',
        'stringify_phase_peak_heap_used_bytes',
        'timestamp',
        'write_duration_ms',
        'write_overlap_count',
        'write_phase_peak_heap_used_bytes',
      ].sort()
    );
    assert.strictEqual(record.stringify_duration_ms, 4);
    assert.strictEqual(record.write_duration_ms, 5);
    assert.strictEqual(record.save_queue_depth_peak, 7);
    assert.strictEqual(record.stringify_phase_peak_heap_used_bytes, 4000);
    assert.strictEqual(record.write_phase_peak_heap_used_bytes, 5000);
  });

  it('measures queue depth, serialization phases, write overlap, and interval resets', async function () {
    const realOpen = fs.promises.open;
    const writeGate = {};
    writeGate.promise = new Promise((resolve) => { writeGate.resolve = resolve; });
    const handles = [];
    fs.promises.open = async () => {
      const handle = {
        async writeFile() {
          await writeGate.promise;
        },
        async sync() {},
        async close() {},
      };
      handles.push(handle);
      return handle;
    };

    let releaseSave;
    const saveGate = new Promise((resolve) => { releaseSave = resolve; });
    const store = {
      sessionsFile: path.join(os.tmpdir(), 'instrumented-sessions.json'),
      _dirty: true,
      _inFlightSave: Promise.resolve(),
      async saveSessions() {
        await saveGate;
        return true;
      },
      async _serializeDataStreamed() {
        await new Promise((resolve) => setImmediate(resolve));
        return '{}';
      },
    };
    const instrumentation = new probe.SessionStoreInstrumentation(store, { phaseSampleMs: 1 });

    try {
      instrumentation.install();
      const saveA = store.saveSessions(new Map());
      const saveB = store.saveSessions(new Map());
      const queued = instrumentation.takeInterval();
      assert.strictEqual(queued.saveQueueDepth, 1);
      assert.strictEqual(queued.saveQueueDepthPeak, 1);

      await store._serializeDataStreamed({});
      const serializeInterval = instrumentation.takeInterval();
      assert(serializeInterval.stringifyDurationMs >= 0);
      assert(serializeInterval.stringifyPeakHeapUsedBytes > 0);

      const handleA = await fs.promises.open(`${store.sessionsFile}.tmp`, 'w');
      const handleB = await fs.promises.open(`${store.sessionsFile}.tmp`, 'w');
      const writeA = handleA.writeFile('a');
      const writeB = handleB.writeFile('b');
      writeGate.resolve();
      await Promise.all([writeA, writeB]);
      await Promise.all([handleA.sync(), handleB.sync()]);
      await Promise.all([handleA.close(), handleB.close()]);

      const writeInterval = instrumentation.takeInterval();
      assert.strictEqual(writeInterval.writeOverlapCount, 1);
      assert(writeInterval.writeDurationMs >= 0);
      assert(writeInterval.writePeakHeapUsedBytes > 0);
      const resetInterval = instrumentation.takeInterval();
      assert.strictEqual(resetInterval.writeOverlapCount, 0);
      assert.strictEqual(resetInterval.saveQueueDepthPeak, 1);

      releaseSave();
      await Promise.all([saveA, saveB]);
      await instrumentation.quiesce();
      assert.strictEqual(instrumentation.summary().save_queue_depth_peak, 1);
      assert.strictEqual(instrumentation.summary().write_overlap_count, 1);
      assert.strictEqual(handles.length, 2);
    } finally {
      releaseSave();
      instrumentation.restore();
      fs.promises.open = realOpen;
    }
  });

  it('exits non-zero with a clear message when --expose-gc is absent', function () {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-probe-no-gc-'));
    try {
      const result = spawnSync(process.execPath, [
        '--no-expose-gc',
        path.join(__dirname, '..', 'scripts', 'soak-memory-probe.js'),
        '--arm', 'persist-off',
        '--duration-seconds', '1',
        '--sample-seconds', '1',
        '--payload-bytes', '32',
        '--output-dir', outputDir,
      ], { encoding: 'utf8' });

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /requires --expose-gc/);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('exits non-zero with a clear message when CLI arguments are invalid', function () {
    const result = spawnSync(process.execPath, [
      '--expose-gc',
      path.join(__dirname, '..', 'scripts', 'soak-memory-probe.js'),
      '--arm', 'unknown',
    ], { encoding: 'utf8' });

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /--arm must be one of/);
  });
});
