'use strict';

const assert = require('assert');
const { measureTerminalGeometry } = require('../src/public/terminal-geometry');

function container(width, height, isConnected = true) {
  return { isConnected, getBoundingClientRect: () => ({ width, height }) };
}

describe('terminal geometry', function () {
  it('refuses zero-axis and detached containers', function () {
    assert.strictEqual(measureTerminalGeometry(container(0, 800), { cols: 100, rows: 40 }), null);
    assert.strictEqual(measureTerminalGeometry(container(1200, 0), { cols: 100, rows: 40 }), null);
    assert.strictEqual(measureTerminalGeometry(container(1200, 800, false), { cols: 100, rows: 40 }), null);
  });

  it('applies the reserve to the measurement without mutating the proposal', function () {
    const proposed = { cols: 158, rows: 41 };
    assert.deepStrictEqual(
      measureTerminalGeometry(container(1264, 656), proposed, { cols: 6, rows: 2 }),
      { cols: 152, rows: 39 }
    );
    assert.deepStrictEqual(proposed, { cols: 158, rows: 41 });
  });
});
