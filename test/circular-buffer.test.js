const assert = require('assert');
const CircularBuffer = require('../src/utils/circular-buffer');

describe('CircularBuffer', () => {
  describe('constructor', () => {
    it('should create an empty buffer with given capacity', () => {
      const buf = new CircularBuffer(5);
      assert.strictEqual(buf.length, 0);
      assert.strictEqual(buf.capacity, 5);
    });

    it('exposes the shared live-output byte cap constant', () => {
      assert.strictEqual(CircularBuffer.LIVE_OUTPUT_MAX_BYTES, 512 * 1024);
    });
  });

  describe('push', () => {
    it('should add items and track length', () => {
      const buf = new CircularBuffer(5);
      buf.push('a');
      buf.push('b');
      assert.strictEqual(buf.length, 2);
    });

    it('should not exceed capacity', () => {
      const buf = new CircularBuffer(3);
      buf.push('a');
      buf.push('b');
      buf.push('c');
      buf.push('d');
      assert.strictEqual(buf.length, 3);
    });

    it('should evict oldest items when at capacity', () => {
      const buf = new CircularBuffer(3);
      buf.push('a');
      buf.push('b');
      buf.push('c');
      buf.push('d');
      assert.deepStrictEqual(buf.toArray(), ['b', 'c', 'd']);
    });

    it('tracks UTF-8 byte length through eviction without rescanning retained items', () => {
      const buf = new CircularBuffer(2);
      buf.push('é');
      buf.push(Buffer.from('abc'));
      assert.strictEqual(buf.byteLength, 5);
      buf.push('z');
      assert.strictEqual(buf.byteLength, 4);
    });

    it('keeps legacy count-only behavior when maxBytes is omitted', () => {
      const buf = new CircularBuffer(2);
      buf.push('x'.repeat(CircularBuffer.LIVE_OUTPUT_MAX_BYTES));
      buf.push('y');
      assert.strictEqual(buf.length, 2);
      assert.strictEqual(buf.byteLength, CircularBuffer.LIVE_OUTPUT_MAX_BYTES + 1);
    });

    it('enforces maxBytes by evicting oldest entries', () => {
      const buf = new CircularBuffer(5, 10);
      buf.push('1234');
      buf.push('5678');
      buf.push('zzzz');
      assert.deepStrictEqual(buf.toArray(), ['5678', 'zzzz']);
      assert.strictEqual(buf.byteLength, 8);
    });

    it('retains a UTF-8-valid newest string suffix when a single item is oversized', () => {
      const buf = new CircularBuffer(5, 5);
      buf.push('ab😀');
      const stored = buf.toArray()[0];
      assert.strictEqual(stored, 'b😀');
      assert.strictEqual(Buffer.byteLength(stored, 'utf8'), 5);
    });

    it('retains a copied newest Buffer suffix when a single item is oversized', () => {
      const source = Buffer.from('abcdefghij');
      const buf = new CircularBuffer(5, 4);
      buf.push(source);
      const stored = buf.toArray()[0];
      assert.ok(Buffer.isBuffer(stored));
      assert.strictEqual(stored.toString('utf8'), 'ghij');
      source[source.length - 1] = 'Z'.charCodeAt(0);
      assert.strictEqual(stored.toString('utf8'), 'ghij');
      assert.strictEqual(buf.byteLength, 4);
    });

    it('maintains exact byteLength while truncating and evicting for maxBytes', () => {
      const buf = new CircularBuffer(3, 6);
      buf.push('é');
      buf.push('abc');
      buf.push('zzzz');
      assert.deepStrictEqual(buf.toArray(), ['zzzz']);
      assert.strictEqual(buf.byteLength, 4);
    });

    it('combines wrap-around with maxBytes eviction and keeps the newest suffix', () => {
      const buf = new CircularBuffer(3, 10);
      buf.push('aa');
      buf.push('bbbb');
      buf.push('cc');
      buf.push('dddd');
      buf.push('eeee');
      assert.deepStrictEqual(buf.toArray(), ['cc', 'dddd', 'eeee']);
      assert.strictEqual(buf.byteLength, 10);
    });
  });

  describe('UTF-8 suffix trimming', () => {
    it('trims emoji-only strings without replacement characters', () => {
      const expected = ['', '', '', '😀'];
      for (const [index, limit] of [1, 2, 3, 4].entries()) {
        const result = CircularBuffer.trimUtf8Suffix('😀', limit);
        assert.strictEqual(result.value, expected[index]);
        assert.ok(result.bytes <= limit);
        assert.strictEqual(result.value.includes('\uFFFD'), false);
      }
    });

    it('keeps only complete newest emoji pairs for repeated emoji', () => {
      for (const limit of [1, 2, 3]) {
        const result = CircularBuffer.trimUtf8Suffix('😀😀', limit);
        assert.strictEqual(result.value, '');
        assert.strictEqual(result.bytes, 0);
      }
      assert.strictEqual(CircularBuffer.trimUtf8Suffix('😀😀', 4).value, '😀');
      assert.strictEqual(CircularBuffer.trimUtf8Suffix('😀😀', 5).value, '😀');
      assert.strictEqual(CircularBuffer.trimUtf8Suffix('😀😀', 8).value, '😀😀');
    });

    it('handles raw UTF-16 odd-index cuts without U+FFFD', () => {
      const expected = new Map([
        [1, 'B'],
        [2, 'B'],
        [3, 'B'],
        [4, 'B'],
        [5, '😀B'],
        [6, 'A😀B'],
      ]);
      for (const [limit, value] of expected) {
        const result = CircularBuffer.trimUtf8Suffix('A😀B', limit);
        assert.strictEqual(result.value, value);
        assert.ok(result.bytes <= limit);
        assert.strictEqual(result.value.includes('\uFFFD'), false);
      }
    });

    it('keeps the byte cap for push and newestItemsWithinBytes with emoji values', () => {
      const buf = new CircularBuffer(5, 5);
      buf.push('😀😀');
      assert.deepStrictEqual(buf.toArray(), ['😀']);
      assert.strictEqual(buf.byteLength, 4);

      const items = CircularBuffer.newestItemsWithinBytes(['old', '😀😀', 'tail'], 8);
      assert.deepStrictEqual(items, ['😀', 'tail']);
      assert.ok(items.reduce((total, item) => total + Buffer.byteLength(item, 'utf8'), 0) <= 8);
      assert.strictEqual(items.join('').includes('\uFFFD'), false);
    });
  });

  describe('slice', () => {
    it('should return last n items', () => {
      const buf = new CircularBuffer(5);
      buf.push('a');
      buf.push('b');
      buf.push('c');
      assert.deepStrictEqual(buf.slice(-2), ['b', 'c']);
    });

    it('should handle requesting more items than available', () => {
      const buf = new CircularBuffer(5);
      buf.push('a');
      buf.push('b');
      assert.deepStrictEqual(buf.slice(-10), ['a', 'b']);
    });

    it('should work after wrap-around', () => {
      const buf = new CircularBuffer(3);
      buf.push('a');
      buf.push('b');
      buf.push('c');
      buf.push('d');
      buf.push('e');
      assert.deepStrictEqual(buf.slice(-2), ['d', 'e']);
      assert.deepStrictEqual(buf.slice(-3), ['c', 'd', 'e']);
    });

    it('should return empty array for empty buffer', () => {
      const buf = new CircularBuffer(5);
      assert.deepStrictEqual(buf.slice(-3), []);
    });

    it('should return all items when called with no argument', () => {
      const buf = new CircularBuffer(5);
      buf.push('a');
      buf.push('b');
      assert.deepStrictEqual(buf.slice(), ['a', 'b']);
    });
  });

  describe('toArray', () => {
    it('should return all items in insertion order', () => {
      const buf = new CircularBuffer(3);
      buf.push('a');
      buf.push('b');
      buf.push('c');
      buf.push('d');
      assert.deepStrictEqual(buf.toArray(), ['b', 'c', 'd']);
    });

    it('should return empty array for empty buffer', () => {
      const buf = new CircularBuffer(3);
      assert.deepStrictEqual(buf.toArray(), []);
    });
  });

  describe('toJSON', () => {
    it('should produce a plain array for JSON.stringify', () => {
      const buf = new CircularBuffer(3);
      buf.push('x');
      buf.push('y');
      const json = JSON.stringify(buf);
      assert.strictEqual(json, '["x","y"]');
    });

    it('should round-trip through JSON.stringify/parse', () => {
      const buf = new CircularBuffer(3);
      buf.push('a');
      buf.push('b');
      buf.push('c');
      buf.push('d');
      const arr = JSON.parse(JSON.stringify(buf));
      assert.deepStrictEqual(arr, ['b', 'c', 'd']);
    });
  });

  describe('fromArray', () => {
    it('should reconstruct a buffer from a plain array', () => {
      const buf = CircularBuffer.fromArray(['a', 'b', 'c'], 5);
      assert.strictEqual(buf.length, 3);
      assert.deepStrictEqual(buf.toArray(), ['a', 'b', 'c']);
    });

    it('should truncate to capacity if array is larger', () => {
      const buf = CircularBuffer.fromArray(['a', 'b', 'c', 'd', 'e'], 3);
      assert.strictEqual(buf.length, 3);
      assert.deepStrictEqual(buf.toArray(), ['c', 'd', 'e']);
    });

    it('should handle empty array', () => {
      const buf = CircularBuffer.fromArray([], 5);
      assert.strictEqual(buf.length, 0);
      assert.deepStrictEqual(buf.toArray(), []);
    });

    it('supports maxBytes when reconstructing from a plain array', () => {
      const buf = CircularBuffer.fromArray(['aaaa', 'bbbb', 'cccc'], 5, 8);
      assert.deepStrictEqual(buf.toArray(), ['bbbb', 'cccc']);
      assert.strictEqual(buf.byteLength, 8);
    });
  });

  describe('Symbol.iterator', () => {
    it('should be iterable with for...of', () => {
      const buf = new CircularBuffer(3);
      buf.push('a');
      buf.push('b');
      buf.push('c');
      buf.push('d');
      const result = [];
      for (const item of buf) {
        result.push(item);
      }
      assert.deepStrictEqual(result, ['b', 'c', 'd']);
    });

    it('should work with spread operator', () => {
      const buf = new CircularBuffer(3);
      buf.push('x');
      buf.push('y');
      assert.deepStrictEqual([...buf], ['x', 'y']);
    });
  });

  describe('capacity-1 edge case', () => {
    it('should work with capacity of 1', () => {
      const buf = new CircularBuffer(1);
      buf.push('a');
      assert.deepStrictEqual(buf.toArray(), ['a']);
      buf.push('b');
      assert.deepStrictEqual(buf.toArray(), ['b']);
      assert.strictEqual(buf.length, 1);
    });
  });

  describe('session store round-trip', () => {
    it('should survive serialization and deserialization', () => {
      const buf = new CircularBuffer(1000);
      for (let i = 0; i < 50; i++) {
        buf.push(`line ${i}`);
      }

      // Simulate saveSessions: slice last 100
      const saved = buf.slice(-100);
      assert.strictEqual(saved.length, 50);

      // Simulate loadSessions: fromArray
      const restored = CircularBuffer.fromArray(saved, 1000);
      assert.strictEqual(restored.length, 50);
      assert.deepStrictEqual(restored.toArray(), saved);
    });
  });
});
