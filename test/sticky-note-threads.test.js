'use strict';

const assert = require('assert');
const { pickThreads } = require('../src/sticky-note-threads');

describe('sticky-note pickThreads', function () {
  it('uses three-quarters of the cores on a CPU backend (no GPU)', function () {
    assert.strictEqual(pickThreads({ explicit: undefined, gpu: false, cpus: 16 }), 12);
    assert.strictEqual(pickThreads({ explicit: undefined, gpu: false, cpus: 12 }), 9);
    assert.strictEqual(pickThreads({ explicit: undefined, gpu: false, cpus: 8 }), 6);
  });

  it('is three-quarters of the cores down to a floor of 1 on small CPU boxes', function () {
    assert.strictEqual(pickThreads({ gpu: false, cpus: 4 }), 3);
    assert.strictEqual(pickThreads({ gpu: false, cpus: 2 }), 1);
    assert.strictEqual(pickThreads({ gpu: false, cpus: 1 }), 1);
  });

  it('stays gentle (<=2) on a GPU backend — the GPU carries the load', function () {
    assert.strictEqual(pickThreads({ gpu: true, cpus: 16 }), 2);
    assert.strictEqual(pickThreads({ gpu: true, cpus: 3 }), 1);
  });

  it('honors a valid explicit override regardless of backend', function () {
    assert.strictEqual(pickThreads({ explicit: 6, gpu: false, cpus: 16 }), 6);
    assert.strictEqual(pickThreads({ explicit: 6, gpu: true, cpus: 16 }), 6);
    assert.strictEqual(pickThreads({ explicit: 3.9, gpu: false, cpus: 16 }), 3); // floored
    assert.strictEqual(pickThreads({ explicit: '8', gpu: false, cpus: 16 }), 8); // numeric string from CLI/env
  });

  it('ignores a bogus explicit override and falls back to auto', function () {
    assert.strictEqual(pickThreads({ explicit: 0, gpu: false, cpus: 16 }), 12);
    assert.strictEqual(pickThreads({ explicit: -2, gpu: false, cpus: 16 }), 12);
    assert.strictEqual(pickThreads({ explicit: NaN, gpu: false, cpus: 16 }), 12);
    assert.strictEqual(pickThreads({ explicit: 'x', gpu: false, cpus: 16 }), 12);
  });
});
