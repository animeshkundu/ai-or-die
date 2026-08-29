'use strict';

const LIVE_OUTPUT_MAX_BYTES = 512 * 1024; // 512 KiB

function isHighSurrogate(code) {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code) {
  return code >= 0xDC00 && code <= 0xDFFF;
}

function trimUtf8Suffix(value, maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.floor(maxBytes)
    : 0;
  if (limit === 0 || !value) {
    return { value: '', bytes: 0 };
  }

  const totalBytes = Buffer.byteLength(value, 'utf8');
  if (totalBytes <= limit) {
    return { value, bytes: totalBytes };
  }

  // Find the smallest raw UTF-16 start index whose suffix fits in `limit`
  // bytes. Do not align the probe: moving a probe forward while it is inside
  // a surrogate pair can otherwise make the binary search stop making
  // progress. The raw suffix byte length is monotonic, so this search always
  // converges.
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const bytes = Buffer.byteLength(value.slice(mid), 'utf8');
    if (bytes > limit) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  // Align only after convergence. A raw search can land on the low surrogate
  // of a pair. Include the complete pair when it still fits; otherwise skip
  // the low surrogate. Both choices are guaranteed to be valid and within the
  // byte budget, with no replacement character introduced by truncation.
  let start = low;
  if (
    start > 0 &&
    start < value.length &&
    isLowSurrogate(value.charCodeAt(start)) &&
    isHighSurrogate(value.charCodeAt(start - 1))
  ) {
    const pairStart = start - 1;
    if (Buffer.byteLength(value.slice(pairStart), 'utf8') <= limit) {
      start = pairStart;
    } else {
      start++;
    }
  }

  // Encode/copy ONLY the bounded suffix so the retained value cannot keep
  // a giant original string alive through V8 substring sharing.
  const suffix = value.slice(start);
  const encodedSuffix = Buffer.from(suffix, 'utf8');
  return {
    value: encodedSuffix.toString('utf8'),
    bytes: encodedSuffix.length,
  };
}

/**
 * Fixed-capacity circular buffer with O(1) push and eviction.
 * Drop-in replacement for the capped array pattern:
 *   arr.push(item); if (arr.length > cap) arr.shift();
 *
 * Provides Array-compatible .slice(), .toArray(), .toJSON(), and iteration.
 */
class CircularBuffer {
  constructor(capacity, maxBytes) {
    this.capacity = capacity;
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.floor(maxBytes)
      : null;
    this.buffer = new Array(capacity);
    this._itemByteLengths = new Array(capacity).fill(0);
    this.head = 0;   // next write position
    this.size = 0;
    this.byteLength = 0;
  }

  static _toString(item) {
    return typeof item === 'string' ? item : String(item || '');
  }

  static measureItemBytes(item) {
    if (Buffer.isBuffer(item)) return item.length;
    return Buffer.byteLength(CircularBuffer._toString(item), 'utf8');
  }

  static boundedItemSuffix(item, maxBytes) {
    const limit = Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.floor(maxBytes)
      : 0;
    if (limit === 0) {
      return { item: '', bytes: 0 };
    }

    const bytes = CircularBuffer.measureItemBytes(item);
    if (bytes <= limit) {
      return { item, bytes };
    }
    if (Buffer.isBuffer(item)) {
      const suffix = Buffer.from(item.subarray(item.length - limit));
      return { item: suffix, bytes: suffix.length };
    }
    const trimmed = trimUtf8Suffix(CircularBuffer._toString(item), limit);
    return { item: trimmed.value, bytes: trimmed.bytes };
  }

  static newestItemsWithinBytes(items, maxBytes) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const limit = Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.floor(maxBytes)
      : 0;
    if (limit === 0) return [];

    const kept = [];
    let totalBytes = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      if (totalBytes >= limit) break;
      const remaining = limit - totalBytes;
      const original = items[i];
      const originalBytes = CircularBuffer.measureItemBytes(original);
      if (originalBytes <= remaining) {
        kept.push(original);
        totalBytes += originalBytes;
        continue;
      }

      const trimmed = CircularBuffer.boundedItemSuffix(original, remaining);
      if (trimmed.bytes > 0) {
        kept.push(trimmed.item);
      }
      break;
    }
    kept.reverse();
    return kept;
  }

  _measureItemBytes(item) {
    return CircularBuffer.measureItemBytes(item);
  }

  _normalizeItem(item) {
    const bytes = this._measureItemBytes(item);
    if (!this.maxBytes) return { item, bytes };
    return CircularBuffer.boundedItemSuffix(item, this.maxBytes);
  }

  _evictOldest() {
    if (this.size === 0) return;
    const oldest = (this.head - this.size + this.capacity) % this.capacity;
    this.byteLength -= this._itemByteLengths[oldest];
    this._itemByteLengths[oldest] = 0;
    this.buffer[oldest] = undefined;
    this.size--;
  }

  /** Add an item, evicting the oldest if at capacity. O(1). */
  push(item) {
    const normalized = this._normalizeItem(item);
    const storedItem = normalized.item;
    const bytes = normalized.bytes;

    if (this.maxBytes) {
      while (this.size > 0 && this.byteLength + bytes > this.maxBytes) {
        this._evictOldest();
      }
    }

    if (this.size === this.capacity) {
      this.byteLength -= this._itemByteLengths[this.head];
    } else {
      this.size++;
    }

    this.buffer[this.head] = storedItem;
    this._itemByteLengths[this.head] = bytes;
    this.byteLength += bytes;
    this.head = (this.head + 1) % this.capacity;
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
  static fromArray(arr, capacity, maxBytes) {
    const buf = new CircularBuffer(capacity, maxBytes);
    for (const item of arr) buf.push(item);
    return buf;
  }
}

CircularBuffer.LIVE_OUTPUT_MAX_BYTES = LIVE_OUTPUT_MAX_BYTES;
CircularBuffer.trimUtf8Suffix = trimUtf8Suffix;

module.exports = CircularBuffer;
module.exports.LIVE_OUTPUT_MAX_BYTES = LIVE_OUTPUT_MAX_BYTES;
