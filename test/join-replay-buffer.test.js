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

  describe('alt-screen convergence', function () {
    const altTranscript = () => ({ isAltScreenActive: () => true });
    const normalTranscript = () => ({ isAltScreenActive: () => false });

    it('prepends alt-enter when alt-active but the enter was evicted', function () {
      // Long alt-session: enter fell off the 1000-chunk ring, tail holds
      // only alt drawing frames. Without the prepend the replay lands in
      // the normal buffer (ghost rows until SIGWINCH).
      const outputBuffer = new CircularBuffer(4);
      outputBuffer.push('\x1b[?1049h'); // evicted below
      for (let i = 0; i < 4; i++) outputBuffer.push(`\x1b[${i + 1};1Hframe-${i}`);
      const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
        outputBuffer,
        _ctlTranscript: altTranscript(),
      });
      assert.strictEqual(replay[0], '\x1b[?1049h');
      assert.ok(replay.slice(1).every((c) => c.startsWith('\x1b[')));
    });

    it('does not prepend when the tail already enters alt after the last exit', function () {
      const outputBuffer = new CircularBuffer(10);
      outputBuffer.push('shell noise');
      outputBuffer.push('\x1b[?1049l'); // exited...
      outputBuffer.push('\x1b[?1049h'); // ...and re-entered: present
      outputBuffer.push('\x1b[5;1Htui frame');
      const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
        outputBuffer,
        _ctlTranscript: altTranscript(),
      });
      assert.deepStrictEqual(replay, [
        'shell noise',
        '\x1b[?1049l',
        '\x1b[?1049h',
        '\x1b[5;1Htui frame',
      ]);
    });

    it('never prepends for normal-screen sessions', function () {
      const outputBuffer = new CircularBuffer(10);
      outputBuffer.push('$ echo hello');
      outputBuffer.push('hello');
      const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
        outputBuffer,
        _ctlTranscript: normalTranscript(),
      });
      assert.deepStrictEqual(replay, ['$ echo hello', 'hello']);
    });

    it('never prepends when there is no transcript (fail-closed)', function () {
      const outputBuffer = new CircularBuffer(10);
      outputBuffer.push('\x1b[5;1Hmaybe-alt frame');
      const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({ outputBuffer });
      assert.deepStrictEqual(replay, ['\x1b[5;1Hmaybe-alt frame']);
    });

    it('heals markers split across chunk boundaries', function () {
      const outputBuffer = new CircularBuffer(10);
      outputBuffer.push('shell');
      outputBuffer.push('\x1b[?104'); // enter split...
      outputBuffer.push('9h'); // ...across chunks
      outputBuffer.push('\x1b[5;1Hframe');
      const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
        outputBuffer,
        _ctlTranscript: altTranscript(),
      });
      assert.strictEqual(replay[0], 'shell', 'split enter must be detected, no prepend');
    });

    it('ignores prose mentions of ?1049h (only real ESC sequences count)', function () {
      const outputBuffer = new CircularBuffer(4);
      outputBuffer.push('\x1b[?1049h'); // evicted below
      outputBuffer.push('docs: use ?1049h to enter alt-screen');
      outputBuffer.push('\x1b[5;1Hframe');
      outputBuffer.push('\x1b[6;1Hframe');
      outputBuffer.push('\x1b[7;1Hframe');
      const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
        outputBuffer,
        _ctlTranscript: altTranscript(),
      });
      assert.strictEqual(replay[0], '\x1b[?1049h', 'prose must not suppress the prepend');
    });
  });
});
