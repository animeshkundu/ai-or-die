'use strict';

/**
 * O(1) fixed-capacity circular buffer.
 * Drop-in replacement for an array used as a capped FIFO queue.
 */
class CircularBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;   // next write position
    this.size = 0;
  }

  push(item) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /**
   * Return the last `count` items in insertion order (oldest first).
   * Accepts a negative number like Array.prototype.slice(-n).
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

  toArray() {
    return this.slice(-this.size);
  }

  get length() {
    return this.size;
  }

  static fromArray(arr, capacity) {
    const buf = new CircularBuffer(capacity);
    for (const item of arr) buf.push(item);
    return buf;
  }
}

module.exports = CircularBuffer;
