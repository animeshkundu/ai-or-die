'use strict';

const fs = require('fs');
const { EVENT_RUN_END, EVENT_TEST_END, EVENT_TEST_FAIL } = require('mocha').Runner.constants;

class FlakeInventoryReporter {
  constructor(runner) {
    const tests = [];
    const failures = [];

    runner.on(EVENT_TEST_END, (test) => {
      tests.push({
        title: test.fullTitle(),
        state: test.state,
        durationMs: test.duration || 0,
      });
    });
    runner.on(EVENT_TEST_FAIL, (test, error) => {
      failures.push({
        title: test.fullTitle(),
        durationMs: test.duration || 0,
        message: error && error.message,
        stack: error && error.stack,
      });
    });
    runner.once(EVENT_RUN_END, () => {
      const output = process.env.MOCHA_FLAKE_INVENTORY_FILE;
      if (!output) return;
      fs.writeFileSync(output, JSON.stringify({
        platform: process.platform,
        node: process.version,
        stats: runner.stats,
        tests,
        failures,
      }, null, 2));
    });
  }
}

module.exports = FlakeInventoryReporter;
