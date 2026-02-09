'use strict';

/**
 * Fixed-capacity circular buffer with O(1) push and eviction.
 * Drop-in replacement for the capped array pattern:
 *   arr.push(item); if (arr.length > cap) arr.shift();
 *
 * Provides Array-compatible .slice(), .toArray(), .toJSON(), and iteration.
 */
class CircularBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;   // next write position
    this.size = 0;
  }

  /** Add an item, evicting the oldest if at capacity. O(1). */
  push(item) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /**
   * Return items as an array. Accepts a single negative argument
   * like Array.prototype.slice(-n) to get the last n items.
   * Returns items in insertion order (oldest first).
   */
  slice(negativeStart) {
    const count = Math.min(Math.abs(negativeStart || this.size), this.size);
    const result = new Array(count);
    const start = (this.head - count + this.capacity) % this.capacity;
    for (let i = 0; i < count; i++) {
      result[i] = this.buffer[(start + i) % this.capacity];
    }
    return result;
  }

  /** Return all items in insertion order. */
  toArray() {
    return this.slice(-this.size);
  }

  /** Enable JSON.stringify(circularBuffer) to produce a plain array. */
  toJSON() {
    return this.toArray();
  }

  /** Number of items currently stored. */
  get length() {
    return this.size;
  }

  /** Make the buffer iterable with for...of. */
  [Symbol.iterator]() {
    const buf = this.buffer;
    const cap = this.capacity;
    const count = this.size;
    const start = (this.head - count + cap) % cap;
    let i = 0;
    return {
      next() {
        if (i < count) {
          return { value: buf[(start + i++) % cap], done: false };
        }
        return { done: true };
      }
    };
  }

  /** Reconstruct a CircularBuffer from a plain array (e.g., after JSON deserialization). */
  static fromArray(arr, capacity) {
    const buf = new CircularBuffer(capacity);
    for (const item of arr) buf.push(item);
    return buf;
  }
}

module.exports = CircularBuffer;
