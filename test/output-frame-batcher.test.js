'use strict';

const assert = require('assert');
const {
  takeChunkBudget,
  appendBoundedText,
} = require('../src/public/output-frame-batcher');

describe('output frame batching', function () {
  it('preserves UTF-8 across arbitrary chunk and flush boundaries', function () {
    const source = Buffer.from('ASCII · € · 😀 · 終');
    const queue = [
      new Uint8Array(source.subarray(0, 8)),
      new Uint8Array(source.subarray(8, 13)),
      new Uint8Array(source.subarray(13)),
    ];
    const decoder = new TextDecoder();
    let decoded = '';
    while (queue.length) decoded += decoder.decode(takeChunkBudget(queue, 7), { stream: true });
    decoded += decoder.decode();
    assert.strictEqual(decoded, source.toString('utf8'));
  });

  it('never exceeds the per-frame byte budget and preserves all bytes', function () {
    const queue = [new Uint8Array(10).fill(1), new Uint8Array(10).fill(2)];
    const first = takeChunkBudget(queue, 12);
    const second = takeChunkBudget(queue, 12);
    assert.strictEqual(first.byteLength, 12);
    assert.strictEqual(second.byteLength, 8);
    assert.deepStrictEqual(Array.from(first).concat(Array.from(second)), [
      ...new Array(10).fill(1),
      ...new Array(10).fill(2),
    ]);
  });

  it('keeps a bounded rendered tail', function () {
    assert.strictEqual(appendBoundedText('abcd', 'efgh', 6), 'cdefgh');
  });
});
