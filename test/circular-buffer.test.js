const assert = require('assert');
const CircularBuffer = require('../src/utils/circular-buffer');

describe('CircularBuffer', () => {
  describe('constructor', () => {
    it('should create an empty buffer with given capacity', () => {
      const buf = new CircularBuffer(5);
      assert.strictEqual(buf.length, 0);
      assert.strictEqual(buf.capacity, 5);
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
