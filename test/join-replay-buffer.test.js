'use strict';

const assert = require('assert');
const { ClaudeCodeWebServer } = require('../src/server');
const CircularBuffer = require('../src/utils/circular-buffer');

function replayBytes(items) {
  return items.reduce((total, item) => {
    if (Buffer.isBuffer(item)) return total + item.length;
    return total + Buffer.byteLength(typeof item === 'string' ? item : String(item || ''), 'utf8');
  }, 0);
}

describe('session join replay buffer', function () {
  it('keeps the newest chunks within the byte budget', function () {
    const outputBuffer = new CircularBuffer(1000);
    outputBuffer.push('12345');
    outputBuffer.push('67890');
    outputBuffer.push('abc');
    const replay = ClaudeCodeWebServer.prototype._buildJoinReplay(
      { outputBuffer },
      8
    );
    assert.deepStrictEqual(replay, ['67890', 'abc']);
    assert.ok(replayBytes(replay) <= 8);
  });

  it('trims an oversized newest string chunk so replay bytes never exceed the budget', function () {
    const outputBuffer = new CircularBuffer(1000);
    outputBuffer.push('older');
    outputBuffer.push('ab😀');
    const replay = ClaudeCodeWebServer.prototype._buildJoinReplay(
      { outputBuffer },
      5
    );
    assert.deepStrictEqual(replay, ['b😀']);
    assert.ok(replayBytes(replay) <= 5);
  });

  it('trims an oversized newest Buffer chunk to a copied suffix', function () {
    const source = Buffer.from('abcdefghij');
    const outputBuffer = new CircularBuffer(1000);
    outputBuffer.push('older');
    outputBuffer.push(source);
    const replay = ClaudeCodeWebServer.prototype._buildJoinReplay(
      { outputBuffer },
      4
    );
    assert.strictEqual(replay.length, 1);
    assert.ok(Buffer.isBuffer(replay[0]));
    assert.strictEqual(replay[0].toString('utf8'), 'ghij');
    source[source.length - 1] = 'Z'.charCodeAt(0);
    assert.strictEqual(replay[0].toString('utf8'), 'ghij');
    assert.ok(replayBytes(replay) <= 4);
  });

  it('excludes geometry-held output that will be released after the join frame', function () {
    const outputBuffer = new CircularBuffer(1000);
    outputBuffer.push('before-resize');
    outputBuffer.push('held-redraw-a');
    outputBuffer.push('held-redraw-b');
    const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
      outputBuffer,
      _geometryOutputHold: ['held-redraw-a', 'held-redraw-b'],
      _geometryReplayBuffer: ['before-resize'],
    });
    assert.deepStrictEqual(replay, ['before-resize']);
  });

  it('keeps the pre-transaction replay stable when held output exceeds the ring', function () {
    const outputBuffer = new CircularBuffer(3);
    outputBuffer.push('held-c');
    outputBuffer.push('held-d');
    outputBuffer.push('held-e');
    const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
      outputBuffer,
      _geometryOutputHold: ['held-a', 'held-b', 'held-c', 'held-d', 'held-e'],
      _geometryReplayBuffer: ['before-resize'],
    });
    assert.deepStrictEqual(replay, ['before-resize']);
  });
});
