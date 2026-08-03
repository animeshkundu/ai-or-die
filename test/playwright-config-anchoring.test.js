'use strict';

const assert = require('assert');
const path = require('path');
const config = require('../e2e/playwright.config');

function matches(pattern, file) {
  if (typeof pattern === 'string') return path.basename(file) === pattern;
  pattern.lastIndex = 0;
  return pattern.test(file);
}

describe('Playwright project testMatch anchoring', function () {
  it('is unaffected by digits in the absolute checkout path', function () {
    const basename = '22-sticky-notes.spec.js';
    const clean = path.join('/tmp', 'checkout', 'e2e', 'tests', basename);
    const hostile = path.join('/tmp', 'factory-33-workspace', 'e2e', 'tests', basename);
    for (const project of config.projects) {
      assert.strictEqual(
        matches(project.testMatch, hostile),
        matches(project.testMatch, clean),
        `${project.name} must match only the test path, not checkout directory digits`
      );
    }
  });
});
