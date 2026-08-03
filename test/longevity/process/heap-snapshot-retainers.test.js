'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CircularBuffer = require('../../../src/utils/circular-buffer');
const {
  captureHeapSnapshot,
  diffHeapSnapshots,
  findRetainerPath,
  summarizeHeapSnapshot,
} = require('../harness/heap-snapshot');
const { runSoak } = require('../harness/runner');

describe('heap snapshot retainer attribution', function () {
  this.timeout(60000);

  it('attributes a retained CircularBuffer through a V8 heap snapshot diff', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-retainer-'));
    const rootKey = '__aiOrDieRetentionProbe';
    try {
      const before = captureHeapSnapshot(dir, 'before');
      const buffer = new CircularBuffer(1000);
      for (let index = 0; index < 64; index++) {
        buffer.push(`snapshot-${index}:${'x'.repeat(16 * 1024)}`);
      }
      global[rootKey] = new Map([['session', { outputBuffer: buffer }]]);
      const after = captureHeapSnapshot(dir, 'after');
      const diff = diffHeapSnapshots(before, after);
      const circularBuffer = diff.top.find((entry) => entry.group === 'object:CircularBuffer');

      assert.ok(circularBuffer, 'snapshot diff must name CircularBuffer as an added retainer');
      assert.ok(circularBuffer.count_delta >= 1);
      assert.ok(
        Array.isArray(circularBuffer.retainer_path) && circularBuffer.retainer_path.length > 1,
        'snapshot diff must include a root-to-object retainer path'
      );
      fs.writeFileSync(path.join(dir, 'heap-diff.json'), JSON.stringify(diff, null, 2));
    } finally {
      delete global[rootKey];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures the live server output-buffer retainer path during an isolated soak', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-retainer-soak-'));
    try {
      const result = await runSoak({
        durationMs: 1200,
        sampleIntervalMs: 200,
        workloads: ['output-buffer-flood'],
        gates: ['memory'],
        outputDir: dir,
        heapSnapshots: true,
        workloadOpts: {
          'output-buffer-flood': {
            sessionCount: 1,
            targetBytesPerSecond: 1024 * 1024,
          },
        },
        log: () => {},
      });
      assert.strictEqual(result.metadata.heap_snapshot_diff, 'heap-diff.json');
      assert.ok(fs.existsSync(path.join(dir, 'heap-start.heapsnapshot')));
      assert.ok(fs.existsSync(path.join(dir, 'heap-end.heapsnapshot')));

      const diff = JSON.parse(fs.readFileSync(path.join(dir, 'heap-diff.json'), 'utf8'));
      const circularBuffer = diff.top.find((entry) => entry.group === 'object:CircularBuffer');
      assert.ok(circularBuffer, 'live soak diff must name CircularBuffer');
      assert.ok(circularBuffer.count_delta >= 1);
      const start = summarizeHeapSnapshot(path.join(dir, 'heap-start.heapsnapshot'));
      const startCircularBuffers = start.groups.get('object:CircularBuffer');
      assert.ok(
        !startCircularBuffers || startCircularBuffers.count === 0,
        'the baseline has no session scrollback buffers, so the target exists only after the flood'
      );
      const end = summarizeHeapSnapshot(path.join(dir, 'heap-end.heapsnapshot'));
      const retainerPath = findRetainerPath(end.snapshot, 'object:CircularBuffer', {
        requiredVias: ['claudeSessions', 'outputBuffer'],
      });
      assert.ok(
        retainerPath,
        'live soak must find a strong retainer path through claudeSessions.outputBuffer'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
