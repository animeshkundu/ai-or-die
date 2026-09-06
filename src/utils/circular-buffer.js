'use strict';

/**
 * Fixed-capacity circular buffer with O(1) push and eviction.
 * Drop-in replacement for the capped array pattern:
 *   arr.push(item); if (arr.length > cap) arr.shift();
 *
 * Provides Array-compatible .slice(), .toArray(), .toJSON(), and iteration.
 */
class CircularBuffer {
  constructor(capacity, options = {}) {
    this.capacity = capacity;
    this.maxBytes = typeof options === 'number' ? options : (options && options.maxBytes) || null;
    this.buffer = new Array(capacity);
    this._itemByteLengths = new Array(capacity).fill(0);
    this.head = 0;   // next write position
    this.size = 0;
    this.byteLength = 0;
  }

  /**
   * Oldest index in insertion order.
   */
  get tail() {
    return (this.head - this.size + this.capacity) % this.capacity;
  }

  /** Evict the oldest item. */
  shift() {
    if (this.size === 0) return undefined;
    const oldIndex = this.tail;
    const item = this.buffer[oldIndex];
    this.byteLength -= this._itemByteLengths[oldIndex];
    this.buffer[oldIndex] = undefined;
    this._itemByteLengths[oldIndex] = 0;
    this.size--;
    return item;
  }

  /** Add an item, evicting the oldest if at capacity or exceeding maxBytes. */
  push(item) {
    let cleanItem = item;
    // Flatten string if needed to break SlicedString retainers
    if (typeof cleanItem === 'string' && cleanItem.length > 256) {
      cleanItem = Buffer.from(cleanItem, 'utf8').toString('utf8');
    }

    const bytes = Buffer.isBuffer(cleanItem)
      ? cleanItem.length
      : Buffer.byteLength(typeof cleanItem === 'string' ? cleanItem : String(cleanItem || ''), 'utf8');

    // If at item capacity, evict oldest
    if (this.size === this.capacity) {
      this.shift();
    }

    // If maxBytes is set, evict oldest whole chunks until new item fits (or buffer is empty)
    if (this.maxBytes && this.maxBytes > 0) {
      while (this.size > 0 && (this.byteLength + bytes > this.maxBytes)) {
        this.shift();
      }
    }

    this.buffer[this.head] = cleanItem;
    this._itemByteLengths[this.head] = bytes;
    this.byteLength += bytes;
    this.head = (this.head + 1) % this.capacity;
    this.size++;
  }

  /**
   * Truncate the buffer to at most targetBytes of the most recent tail.
   * Evicts oldest chunks until byteLength <= targetBytes.
   */
  truncateToBytes(targetBytes) {
    if (!targetBytes || targetBytes <= 0) {
      this.buffer.fill(undefined);
      this._itemByteLengths.fill(0);
      this.head = 0;
      this.size = 0;
      this.byteLength = 0;
      return;
    }
    while (this.size > 0 && this.byteLength > targetBytes) {
      this.shift();
    }
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
