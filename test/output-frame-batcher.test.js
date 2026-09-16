'use strict';

const assert = require('assert');
const {
  takeChunkBudget,
  appendBoundedText,
  trailingHoldbackLength,
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

  it('holds a trailing partial CSI for the next frame without losing bytes', function () {
    const full = Buffer.from('hello\x1b[31mworld');
    const queue = [new Uint8Array(full)];
    const first = takeChunkBudget(queue, 8); // cuts inside ESC[31m
    const second = takeChunkBudget(queue, 64);
    const combined = Buffer.concat([Buffer.from(first), Buffer.from(second)]);
    assert.strictEqual(combined.toString('utf8'), full.toString('utf8'));
    // First frame must not end mid-escape.
    assert.strictEqual(trailingHoldbackLength(first), 0);
  });

  it('holds a trailing incomplete UTF-8 sequence', function () {
    const euro = Buffer.from('€'); // 3 bytes E2 82 AC
    const queue = [new Uint8Array(Buffer.concat([Buffer.from('ab'), euro.subarray(0, 2)])),
      new Uint8Array(euro.subarray(2))];
    const first = takeChunkBudget(queue, 4); // 'ab' + first 2 bytes of €
    assert.ok(first.length <= 2, 'partial multibyte tail is held, got ' + first.length);
    const second = takeChunkBudget(queue, 64);
    const combined = Buffer.concat([Buffer.from(first), Buffer.from(second)]);
    assert.strictEqual(combined.toString('utf8'), 'ab€');
  });

  it('never stalls: budget smaller than the partial still makes progress', function () {
    const queue = [new Uint8Array(Buffer.from('\x1b[31m'))];
    const first = takeChunkBudget(queue, 1);
    assert.ok(first.byteLength >= 1);
  });

  it('complete frames have zero holdback', function () {
    assert.strictEqual(trailingHoldbackLength(Buffer.from('plain text')), 0);
    assert.strictEqual(trailingHoldbackLength(Buffer.from('a\x1b[0m')), 0);
  });
});
