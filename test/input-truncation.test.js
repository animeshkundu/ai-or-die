'use strict';

const assert = require('assert');
const { truncateInputAtBoundary } = require('../src/server');

describe('input truncation at escape boundaries', function () {
  it('returns short input unchanged', function () {
    assert.strictEqual(truncateInputAtBoundary('abc', 256), 'abc');
  });

  it('never splits an in-progress SGR mouse report', function () {
    const text = 'x'.repeat(100) + '\x1b[<32;12;34';
    assert.strictEqual(truncateInputAtBoundary(text, 104), 'x'.repeat(100));
  });

  it('keeps complete sequences ending at or before the cap', function () {
    const rep = '\x1b[<32;12;34M';
    const text = 'x'.repeat(100) + rep + 'yyyy';
    assert.strictEqual(
      truncateInputAtBoundary(text, 100 + rep.length),
      'x'.repeat(100) + rep
    );
  });

  it('never splits a surrogate pair', function () {
    assert.strictEqual(truncateInputAtBoundary('ab😀cd', 3), 'ab');
  });

  it('never splits an in-progress OSC hyperlink', function () {
    const text = 'x'.repeat(100) + '\x1b]8;;http://example.com';
    assert.strictEqual(truncateInputAtBoundary(text, 110), 'x'.repeat(100));
  });

  it('keeps a complete OSC terminated by BEL', function () {
    const osc = '\x1b]8;;http://example.com\x07';
    const text = 'x'.repeat(100) + osc + 'yyyy';
    assert.strictEqual(
      truncateInputAtBoundary(text, 100 + osc.length),
      'x'.repeat(100) + osc
    );
  });

  it('handles empty and non-string input', function () {
    assert.strictEqual(truncateInputAtBoundary('', 10), '');
    assert.strictEqual(truncateInputAtBoundary(null, 10), null);
  });
});
