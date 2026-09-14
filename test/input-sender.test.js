'use strict';

const assert = require('assert');
const {
  filterFocusBytes,
  isPureMotion,
  compressMotion,
} = require('../src/public/input-sender');

function sgr(cb, x, y, suffix) {
  return `\x1b[<${cb};${x};${y}${suffix}`;
}

describe('input sender (mouse path)', function () {
  describe('filterFocusBytes', function () {
    it('strips focus in/out sequences, keeps everything else', function () {
      assert.strictEqual(
        filterFocusBytes('a\x1b[Ib\x1b[Oc'),
        'abc'
      );
      assert.strictEqual(filterFocusBytes(sgr(0, 10, 20, 'M')), sgr(0, 10, 20, 'M'));
      assert.strictEqual(filterFocusBytes(''), '');
    });
  });

  describe('isPureMotion', function () {
    it('accepts runs of SGR drag/motion reports only', function () {
      assert.strictEqual(isPureMotion(sgr(32, 1, 1, 'M') + sgr(35, 40, 20, 'M')), true);
      assert.strictEqual(isPureMotion(sgr(63, 90, 40, 'M')), true);
    });

    it('rejects presses, releases, wheel ticks, keys, and empties', function () {
      assert.strictEqual(isPureMotion(sgr(0, 1, 1, 'M')), false); // press
      assert.strictEqual(isPureMotion(sgr(3, 1, 1, 'm')), false); // release
      assert.strictEqual(isPureMotion(sgr(64, 1, 1, 'M')), false); // wheel
      assert.strictEqual(isPureMotion(sgr(32, 1, 1, 'M') + 'a'), false); // key
      assert.strictEqual(isPureMotion(''), false);
    });
  });

  describe('compressMotion', function () {
    it('collapses a motion run to its tail', function () {
      const run = sgr(32, 1, 1, 'M') + sgr(32, 2, 2, 'M') + sgr(32, 9, 9, 'M');
      assert.strictEqual(compressMotion(run), sgr(32, 9, 9, 'M'));
    });

    it('preserves button-down, release, wheel, and keys in order', function () {
      const press = sgr(0, 5, 5, 'M');
      const drag = sgr(32, 6, 5, 'M') + sgr(32, 7, 5, 'M');
      const release = sgr(3, 7, 5, 'm');
      const wheel = sgr(64, 7, 5, 'M');
      const inText = press + drag + release + 'x' + wheel;
      assert.strictEqual(
        compressMotion(inText),
        press + sgr(32, 7, 5, 'M') + release + 'x' + wheel
      );
    });

    it('keeps interleaved non-SGR text verbatim and ordered', function () {
      const inText = 'ab' + sgr(33, 1, 1, 'M') + sgr(33, 2, 2, 'M') + 'cd';
      assert.strictEqual(compressMotion(inText), 'ab' + sgr(33, 2, 2, 'M') + 'cd');
    });

    it('is a no-op for text without motion and for empty input', function () {
      assert.strictEqual(compressMotion('hello'), 'hello');
      assert.strictEqual(compressMotion(''), '');
      const pressOnly = sgr(0, 1, 1, 'M') + sgr(3, 1, 1, 'm');
      assert.strictEqual(compressMotion(pressOnly), pressOnly);
    });

    it('endpoint-exact on randomized drag streams', function () {
      let rngState = 42;
      const rng = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff);
      for (let trial = 0; trial < 50; trial++) {
        const parts = [sgr(0, 1, 1, 'M')];
        let lastMotion = null;
        const n = 5 + (rng() % 40);
        for (let i = 0; i < n; i++) {
          const r = rng() % 10;
          if (r < 7) {
            lastMotion = sgr(32 + (rng() % 4), 1 + (rng() % 80), 1 + (rng() % 24), 'M');
            parts.push(lastMotion);
          } else if (r < 8) {
            parts.push('k');
          } else {
            parts.push(sgr(64, 9, 9, 'M'));
          }
        }
        parts.push(sgr(3, 9, 9, 'm'));
        const out = compressMotion(parts.join(''));
        // Release edge + every key/wheel preserved; final motion == last motion.
        assert.ok(out.endsWith(sgr(3, 9, 9, 'm')));
        const keyCount = (parts.join('').match(/k/g) || []).length;
        assert.strictEqual((out.match(/k/g) || []).length, keyCount);
        if (lastMotion) assert.ok(out.includes(lastMotion));
      }
    });
  });

});
