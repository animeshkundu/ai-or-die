const assert = require('assert');
const PlanDetector = require('../src/public/plan-detector');

describe('PlanDetector', () => {
  let detector;

  beforeEach(() => {
    detector = new PlanDetector();
    detector.startMonitoring();
  });

  afterEach(() => {
    detector.stopMonitoring();
  });

  describe('trigger scan optimization', () => {
    it('should skip full buffer scan when no trigger keywords present', () => {
      // Feed non-trigger output
      const originalGetRecentText = detector.getRecentText.bind(detector);
      let getRecentTextCalled = false;
      detector.getRecentText = (...args) => {
        getRecentTextCalled = true;
        return originalGetRecentText(...args);
      };

      detector.processOutput('Hello world, this is normal terminal output.\r\n');
      detector.processOutput('More output without any triggers.\r\n');
      detector.processOutput('\x1b[32mGreen text with ANSI codes\x1b[0m\r\n');

      assert.strictEqual(getRecentTextCalled, false,
        'getRecentText should not be called when no trigger keywords found');
    });

    it('should do full scan when trigger keyword is found', () => {
      let getRecentTextCalled = false;
      const originalGetRecentText = detector.getRecentText.bind(detector);
      detector.getRecentText = (...args) => {
        getRecentTextCalled = true;
        return originalGetRecentText(...args);
      };

      detector.processOutput('Plan mode is active\r\n');

      assert.strictEqual(getRecentTextCalled, true,
        'getRecentText should be called when trigger keyword found');
    });

    it('should detect plan mode start', () => {
      let planModeChanged = false;
      detector.onPlanModeChange = (active) => {
        planModeChanged = active;
      };

      detector.processOutput('Plan mode is active. You MUST NOT make any edits.\r\n');

      assert.strictEqual(planModeChanged, true);
      assert.strictEqual(detector.planModeActive, true);
    });

    it('should detect plan mode end', () => {
      // First activate plan mode
      detector.processOutput('Plan mode is active\r\n');

      let planModeEnded = false;
      detector.onPlanModeChange = (active) => {
        if (!active) planModeEnded = true;
      };

      detector.processOutput('User has approved your plan\r\n');

      assert.strictEqual(planModeEnded, true);
      assert.strictEqual(detector.planModeActive, false);
    });
  });

  describe('chunk boundary overlap', () => {
    it('should detect trigger split across two chunks', () => {
      let planModeChanged = false;
      detector.onPlanModeChange = (active) => {
        planModeChanged = active;
      };

      // "Plan mode is active" split across chunks
      detector.processOutput('Some output before Plan mo');
      detector.processOutput('de is active and more text');

      assert.strictEqual(planModeChanged, true,
        'should detect "Plan mode is active" spanning two chunks');
    });

    it('should detect trigger with ANSI codes spanning chunks', () => {
      let planModeChanged = false;
      detector.onPlanModeChange = (active) => {
        planModeChanged = active;
      };

      // Trigger with ANSI code in the middle, split across chunks
      detector.processOutput('before \x1b[1mPlan mode is ac');
      detector.processOutput('tive\x1b[0m after');

      assert.strictEqual(planModeChanged, true,
        'should detect trigger even with ANSI codes at chunk boundary');
    });
  });

  describe('buffer management', () => {
    it('should evict oldest entries when exceeding maxBufferBytes', () => {
      // Shrink the cap so the test runs fast and deterministically.
      detector.maxBufferBytes = 1000; // 1 KB
      for (let i = 0; i < 15; i++) {
        detector.processOutput('x'.repeat(100)); // 100 chars each, 1.5 KB total
      }
      assert.ok(detector.bufferBytes <= detector.maxBufferBytes,
        `bufferBytes should not exceed maxBufferBytes (got ${detector.bufferBytes})`);
      // Accounting invariant: bufferBytes equals the sum of data.length
      // across the live buffer at all times.
      const recomputed = detector.outputBuffer.reduce((n, e) => n + e.data.length, 0);
      assert.strictEqual(detector.bufferBytes, recomputed,
        `bufferBytes (${detector.bufferBytes}) should match sum of data.length (${recomputed})`);
    });

    it('should bound memory under sustained 100MB synthetic flood', () => {
      // CLIENT-01 regression: confirm bufferBytes stays under the cap when
      // we push two orders of magnitude more data than the cap allows.
      // Pre-fix this test would have observed outputBuffer.length capping
      // at 5000 entries while in-memory bytes grew unbounded.
      detector.maxBufferBytes = 8 * 1024 * 1024; // 8 MB cap
      const chunk = 'x'.repeat(8 * 1024); // 8 KB per chunk
      const target = 100 * 1024 * 1024;   // 100 MB total
      const iters = Math.ceil(target / chunk.length);
      for (let i = 0; i < iters; i++) {
        detector.processOutput(chunk);
      }
      assert.ok(detector.bufferBytes <= detector.maxBufferBytes,
        `bufferBytes (${detector.bufferBytes}) must stay <= maxBufferBytes (${detector.maxBufferBytes})`);
      // Sanity: we should have evicted most of what we pushed; live buffer
      // should be roughly cap / chunk = 1024 entries, not iters.
      assert.ok(detector.outputBuffer.length < iters / 2,
        `live buffer (${detector.outputBuffer.length}) should be much smaller than total pushes (${iters})`);
      // Accounting invariant survives the flood.
      const recomputed = detector.outputBuffer.reduce((n, e) => n + e.data.length, 0);
      assert.strictEqual(detector.bufferBytes, recomputed,
        'bufferBytes accounting must match live buffer sum after sustained flood');
    });

    it('should reset bufferBytes on startMonitoring', () => {
      detector.processOutput('some text');
      assert.ok(detector.bufferBytes > 0);
      detector.stopMonitoring();
      detector.startMonitoring();
      assert.strictEqual(detector.bufferBytes, 0);
    });

    it('should reset bufferBytes on clearBuffer', () => {
      detector.processOutput('some text');
      assert.ok(detector.bufferBytes > 0);
      detector.clearBuffer();
      assert.strictEqual(detector.bufferBytes, 0);
    });

    it('should reset overlap buffer on startMonitoring', () => {
      detector.processOutput('some text');
      detector.stopMonitoring();
      detector.startMonitoring();
      assert.strictEqual(detector._lastChunkTail, '');
    });

    it('should reset overlap buffer on clearBuffer', () => {
      detector.processOutput('some text');
      detector.clearBuffer();
      assert.strictEqual(detector._lastChunkTail, '');
    });
  });

  describe('ANSI stripping in trigger scan', () => {
    it('should strip ANSI codes before trigger check', () => {
      let planModeChanged = false;
      detector.onPlanModeChange = (active) => {
        planModeChanged = active;
      };

      // Trigger wrapped in ANSI codes
      detector.processOutput('\x1b[1m\x1b[34mPlan mode is active\x1b[0m\r\n');

      assert.strictEqual(planModeChanged, true,
        'should detect trigger even through ANSI formatting');
    });
  });

  describe('no monitoring', () => {
    it('should not process output when not monitoring', () => {
      detector.stopMonitoring();
      detector.processOutput('Plan mode is active\r\n');
      assert.strictEqual(detector.planModeActive, false);
    });
  });

  describe('batched output processing', () => {
    it('should detect plan in large concatenated chunk', () => {
      let planModeChanged = false;
      detector.onPlanModeChange = (active) => {
        if (active) planModeChanged = true;
      };

      // Simulate what happens when _flushPlanDetection concatenates
      // multiple smaller chunks into one big string
      const normalOutput = 'Hello world\r\nProcessing files...\r\nDone.\r\n';
      const planTrigger = 'Plan mode is active. You MUST NOT make any edits.\r\n';
      const bigChunk = normalOutput + planTrigger;
      detector.processOutput(bigChunk);

      assert.strictEqual(planModeChanged, true,
        'should detect plan mode in a large concatenated chunk');
      assert.strictEqual(detector.planModeActive, true);
    });

    it('should detect plan content in concatenated output', () => {
      let detectedPlan = null;
      detector.onPlanDetected = (plan) => {
        detectedPlan = plan;
      };

      // Activate plan mode first
      detector.processOutput('Plan mode is active\r\n');

      // Send a large chunk with plan content
      const planContent = [
        'Some preamble output...\r\n',
        '## Implementation Plan:\r\n',
        '### 1. First step\r\n',
        'Do something important\r\n',
        '### 2. Second step\r\n',
        'Do something else\r\n',
        '### 3. Third step\r\n',
        'Finish up\r\n'
      ].join('');
      detector.processOutput(planContent);

      assert.ok(detectedPlan, 'should have detected a plan from batched output');
      assert.ok(detectedPlan.content.includes('Implementation Plan'),
        'plan content should include the plan header');
    });

    it('should detect plan end in concatenated output after activation', () => {
      // Activate plan mode
      detector.processOutput('Plan mode is active\r\n');
      assert.strictEqual(detector.planModeActive, true);

      let planModeEnded = false;
      detector.onPlanModeChange = (active) => {
        if (!active) planModeEnded = true;
      };

      // Large chunk that includes plan end trigger
      const bigChunk = 'Some output...\r\nUser has approved your plan\r\nContinuing...\r\n';
      detector.processOutput(bigChunk);

      assert.strictEqual(planModeEnded, true,
        'should detect plan mode end in concatenated chunk');
      assert.strictEqual(detector.planModeActive, false);
    });
  });
});
