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
    it('should trim buffer when exceeding maxBufferSize', () => {
      detector.maxBufferSize = 10;
      for (let i = 0; i < 15; i++) {
        detector.processOutput(`line ${i}\r\n`);
      }
      assert.ok(detector.outputBuffer.length <= 10,
        `buffer should not exceed maxBufferSize (got ${detector.outputBuffer.length})`);
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
