'use strict';

// Regression tests for the join repaint decision (the crux of the #131 fix).
// The load-bearing rule: a LIVE (active) session must NEVER be repainted from
// the plain-text renderedSnapshot — that is what caused the overlap/garble.

const assert = require('assert');
const { chooseJoinRepaint } = require('../src/public/join-repaint');

describe('chooseJoinRepaint', function () {
  const buf = ['chunk1', 'chunk2'];

  it('LIVE + buffer + snapshot → buffer (never the plain-text snapshot) [#131 fix]', function () {
    assert.strictEqual(
      chooseJoinRepaint({ active: true, outputBuffer: buf, renderedSnapshot: 'PLAIN TEXT' }),
      'buffer'
    );
  });

  it('LIVE + buffer (no snapshot) → buffer', function () {
    assert.strictEqual(chooseJoinRepaint({ active: true, outputBuffer: buf }), 'buffer');
  });

  it('LIVE + empty buffer → clear (brand-new just-started session)', function () {
    assert.strictEqual(chooseJoinRepaint({ active: true, outputBuffer: [] }), 'clear');
    assert.strictEqual(chooseJoinRepaint({ active: true }), 'clear');
  });

  it('EXITED + snapshot → snapshot (preserves #131 blank-on-refresh fix)', function () {
    assert.strictEqual(
      chooseJoinRepaint({ active: false, renderedSnapshot: 'SNAP', outputBuffer: buf }),
      'snapshot'
    );
  });

  it('EXITED + snapshot, no buffer → snapshot', function () {
    assert.strictEqual(chooseJoinRepaint({ active: false, renderedSnapshot: 'SNAP' }), 'snapshot');
  });

  it('EXITED + no snapshot + buffer → buffer', function () {
    assert.strictEqual(chooseJoinRepaint({ active: false, outputBuffer: buf }), 'buffer');
  });

  it('EXITED + nothing → clear (empty-state guard, no lingering previous tab)', function () {
    assert.strictEqual(chooseJoinRepaint({ active: false }), 'clear');
    assert.strictEqual(chooseJoinRepaint({ active: false, outputBuffer: [] }), 'clear');
  });

  it('null / undefined / empty message → clear (no throw)', function () {
    assert.strictEqual(chooseJoinRepaint(null), 'clear');
    assert.strictEqual(chooseJoinRepaint(undefined), 'clear');
    assert.strictEqual(chooseJoinRepaint({}), 'clear');
  });
});
