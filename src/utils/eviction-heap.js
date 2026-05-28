'use strict';

/**
 * Min-heap with a numeric key extractor (default: `entry.lastActivity`).
 *
 * Used by `ClaudeCodeWebServer._evictStaleSessions` to find the
 * oldest-by-lastActivity session in O(log n) instead of scanning the
 * full session Map every 5 minutes.
 *
 * Design — lazy tombstone protocol
 * --------------------------------
 * Callers MUST NOT mutate heap entries in place. Instead, when the
 * keyed field changes (e.g. a session bumps its lastActivity), push a
 * NEW entry; the old entry is treated as a tombstone on pop.
 *
 * Tombstone detection is the caller's responsibility — typically by
 * re-reading the source of truth (the session Map) on each pop and
 * skipping entries whose key no longer matches.
 *
 * Heap-size bound
 * ---------------
 * Tombstones accumulate at one-per-bump rate. Callers SHOULD call
 * `rebuild(iter)` periodically (e.g. when `heap.size > 2 * sourceMap.size`
 * AND `sourceMap.size > 100`) to amortise tombstones away. Rebuild is
 * O(n) (Floyd's heapify).
 *
 * See docs/audits/proc-04-sublinear-eviction.md for the eviction-sweep
 * algorithm that uses this heap.
 */
class MinHeap {
  /**
   * @param {(entry: any) => number} keyFn - Extract numeric key from entry.
   *   Default: `entry.lastActivity` (millisecond timestamp).
   */
  constructor(keyFn) {
    this._key = keyFn || ((e) => e.lastActivity);
    this._data = [];
  }

  /** Number of entries currently in the heap (including tombstones). */
  get size() { return this._data.length; }

  /** Smallest-key entry, or undefined if empty. Does NOT remove. */
  peek() { return this._data[0]; }

  /** Insert an entry. O(log n). */
  push(entry) {
    this._data.push(entry);
    this._siftUp(this._data.length - 1);
  }

  /** Remove and return the smallest-key entry, or undefined if empty. O(log n). */
  pop() {
    const data = this._data;
    if (data.length === 0) return undefined;
    const top = data[0];
    const last = data.pop();
    if (data.length > 0) {
      data[0] = last;
      this._siftDown(0);
    }
    return top;
  }

  /** Remove all entries. O(1). */
  clear() { this._data.length = 0; }

  /**
   * Rebuild the heap from a fresh iterable of entries. O(n) (Floyd's heapify).
   * Used to amortise tombstones away — pass an iterable of the
   * source-of-truth (e.g. one entry per live session, with the current
   * lastActivity).
   */
  rebuild(entries) {
    this._data = Array.from(entries);
    // Floyd's heapify: sift-down from the last internal node.
    for (let i = (this._data.length >> 1) - 1; i >= 0; i--) {
      this._siftDown(i);
    }
  }

  /** Iterate entries in arbitrary (heap-internal) order. */
  *[Symbol.iterator]() { yield* this._data; }

  _siftUp(i) {
    const data = this._data;
    const key = this._key;
    const entry = data[i];
    const k = key(entry);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (key(data[parent]) <= k) break;
      data[i] = data[parent];
      i = parent;
    }
    data[i] = entry;
  }

  _siftDown(i) {
    const data = this._data;
    const key = this._key;
    const n = data.length;
    const entry = data[i];
    const k = key(entry);
    while (true) {
      const left = 2 * i + 1;
      if (left >= n) break;
      const right = left + 1;
      let child = left;
      if (right < n && key(data[right]) < key(data[left])) child = right;
      if (key(data[child]) >= k) break;
      data[i] = data[child];
      i = child;
    }
    data[i] = entry;
  }
}

module.exports = MinHeap;
