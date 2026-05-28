'use strict';

/**
 * Seeded deterministic RNG (mulberry32). Shared by every workload so a
 * seeded soak replays bit-for-bit. Do NOT use Math.random anywhere in the
 * harness — every randomized choice flows through this.
 *
 * Source: https://stackoverflow.com/a/47593316 (public domain).
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed = 42) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
  }
  /** [0, 1) */
  next() { return this._next(); }
  /** Integer in [min, max) */
  int(min, max) { return Math.floor(this.next() * (max - min)) + min; }
  /** Pick one item from a non-empty array. */
  pick(arr) { return arr[this.int(0, arr.length)]; }
  /** Spawn a child RNG with a derived but stable seed. */
  fork(label) {
    // Deterministically derive a 32-bit seed from (seed, label).
    let h = this.seed >>> 0;
    for (let i = 0; i < label.length; i++) {
      h = Math.imul(h ^ label.charCodeAt(i), 0x01000193);
    }
    return new Rng(h >>> 0);
  }
}

module.exports = { Rng, mulberry32 };
