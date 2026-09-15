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

  describe('mouse-mode convergence', function () {
    const mouseTranscript = (mode) => ({
      isAltScreenActive: () => true,
      getMouseTrackingMode: () => mode,
    });
    const noMouseTranscript = () => ({
      isAltScreenActive: () => true,
      getMouseTrackingMode: () => 'none',
    });

    it('re-asserts mouse tracking when both alt-enter and enables were evicted', function () {
      // Long mouse-TUI session: 1049h + 1000h/1006h fell off the ring.
      // Without the mouse prepend the fresh xterm reads 'none' and the
      // wheel policy suppresses every notch until the TUI repaints.
      const outputBuffer = new CircularBuffer(4);
      outputBuffer.push('\x1b[?1049h'); // evicted below
      outputBuffer.push('\x1b[?1000h'); // evicted below
      for (let i = 0; i < 4; i++) outputBuffer.push(`\x1b[${i + 1};1Hframe-${i}`);
      const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
        outputBuffer,
        _ctlTranscript: mouseTranscript('vt200'),
      });
      assert.strictEqual(replay[0], '\x1b[?1049h', 'alt-enter stays first');
      assert.strictEqual(replay[1], '\x1b[?1000h\x1b[?1006h', 'mouse re-assert rides second');
    });

    it('skips the mouse prepend when the tail already enables tracking', function () {
      const outputBuffer = new CircularBuffer(10);
      outputBuffer.push('\x1b[?1049h');
      outputBuffer.push('\x1b[?1000h\x1b[?1006h');
      outputBuffer.push('\x1b[5;1Hframe');
      const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
        outputBuffer,
        _ctlTranscript: mouseTranscript('vt200'),
      });
      assert.deepStrictEqual(replay, [
        '\x1b[?1049h',
        '\x1b[?1000h\x1b[?1006h',
        '\x1b[5;1Hframe',
      ]);
    });

    it('never prepends mouse sequences for non-tracking sessions', function () {
      const outputBuffer = new CircularBuffer(4);
      outputBuffer.push('\x1b[?1049h'); // evicted below
      for (let i = 0; i < 4; i++) outputBuffer.push(`\x1b[${i + 1};1Hframe-${i}`);
      const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
        outputBuffer,
        _ctlTranscript: noMouseTranscript(),
      });
      assert.strictEqual(replay[0], '\x1b[?1049h', 'alt prepend unaffected');
      assert.strictEqual(replay.length, 5, 'no mouse bytes added');
      assert.ok(!replay.slice(1).join('').includes('?1000h'));
    });

    it('restores the drag class with 1002h (not just 1000h)', function () {
      const outputBuffer = new CircularBuffer(2);
      outputBuffer.push('\x1b[5;1Hframe');
      outputBuffer.push('\x1b[6;1Hframe');
      const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
        outputBuffer,
        _ctlTranscript: mouseTranscript('drag'),
      });
      const head = replay.slice(0, 2).join('');
      assert.ok(head.includes('\x1b[?1002h'), `drag restore must carry 1002h, got: ${JSON.stringify(head)}`);
      assert.ok(head.includes('\x1b[?1006h'), 'SGR encoding rides along');
    });

    it('ignores prose mentions of ?1000h (only real ESC sequences count)', function () {
      const outputBuffer = new CircularBuffer(3);
      outputBuffer.push('docs: enable ?1000h for mouse');
      outputBuffer.push('\x1b[5;1Hframe');
      outputBuffer.push('\x1b[6;1Hframe');
      const replay = ClaudeCodeWebServer.prototype._buildJoinReplay({
        outputBuffer,
        _ctlTranscript: mouseTranscript('vt200'),
      });
      assert.ok(
        replay.slice(0, 2).join('').includes('\x1b[?1000h'),
        'prose must not suppress the mouse prepend'
      );
    });
  });
});
