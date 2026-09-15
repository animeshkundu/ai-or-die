'use strict';

// Conditional repaint assist: a live fullscreen TUI is nudged with a real
// SIGWINCH (same-size PTY resize) after a join replay or a browser-tab
// refocus, so it repaints from its intact internal model. Every gate must
// hold or nothing is resized.

const assert = require('assert');
const {
  ClaudeCodeWebServer,
  REPAINT_ASSIST_MIN_INTERVAL_MS,
  mouseEnableSeqForMode,
  replayHasMouseEnableAfterReset,
} = require('../src/server');

describe('mouse enable helpers', function () {
  it('maps each tracking class to its minimal restore set', function () {
    assert.strictEqual(mouseEnableSeqForMode('none'), '');
    assert.strictEqual(mouseEnableSeqForMode('bogus'), '');
    assert.strictEqual(mouseEnableSeqForMode('x10'), '\x1b[?9h');
    assert.strictEqual(mouseEnableSeqForMode('vt200'), '\x1b[?1000h\x1b[?1006h');
    const drag = mouseEnableSeqForMode('drag');
    assert.ok(drag.includes('\x1b[?1002h') && !drag.includes('\x1b[?1003h'), drag);
    const any = mouseEnableSeqForMode('any');
    assert.ok(any.includes('\x1b[?1003h'), any);
  });

  it('detects enables after the last reset, split markers, and prose', function () {
    assert.strictEqual(replayHasMouseEnableAfterReset([]), false);
    assert.strictEqual(replayHasMouseEnableAfterReset(['plain text']), false);
    assert.strictEqual(
      replayHasMouseEnableAfterReset(['\x1b[?1000h', 'frame']), true
    );
    assert.strictEqual(
      replayHasMouseEnableAfterReset(['\x1b[?1000h', '\x1b[?1049l', 'frame']), false,
      'enable stranded before the exit must not count'
    );
    assert.strictEqual(
      replayHasMouseEnableAfterReset(['\x1b[?100', '0h', 'frame']), true,
      'split markers reunite via the join'
    );
    assert.strictEqual(
      replayHasMouseEnableAfterReset(['enable ?1000h for mouse', 'frame']), false,
      'prose must not count'
    );
    assert.strictEqual(
      replayHasMouseEnableAfterReset([Buffer.from('\x1b[?1002h'), Buffer.from('frame')]), true,
      'ring Buffers count like strings'
    );
  });
});

function makeHarness(overrides = {}) {
  const resizeCalls = [];
  const session = {
    active: true,
    agent: 'claude',
    cols: 120,
    rows: 30,
    outputBuffer: { toArray: () => [] },
    _ctlTranscript: { isAltScreenActive: () => true },
    ...overrides.session,
  };
  const fakeThis = {
    dev: false,
    claudeSessions: new Map([['sess-1', session]]),
    _lastRepaintAssist: new Map(),
    getBridgeForAgent: () => ({
      resize: async (id, cols, rows) => {
        resizeCalls.push([id, cols, rows]);
      },
    }),
    _beginGeometryOutputHold: (id) => {
      const s = fakeThis.claudeSessions.get(id);
      if (!Array.isArray(s._geometryOutputHold)) s._geometryOutputHold = [];
    },
    _releaseGeometryOutput: (id) => {
      const s = fakeThis.claudeSessions.get(id);
      if (s) s._geometryOutputHold = null;
    },
    ...overrides.thisProps,
  };
  return { fakeThis, session, resizeCalls };
}

describe('repaint assist', function () {
  it('bumps +1 and back (two SIGWINCHs) for live alt sessions', async function () {
    // Same-size TIOCSWINSZ delivers NO signal (kernel/ConPTY only notify
    // on change — node-pty probe: same-size → 0, any change → exactly 1),
    // so the assist is a +1 round-trip converging on the committed grid.
    const { fakeThis, resizeCalls } = makeHarness();
    const result = await ClaudeCodeWebServer.prototype._requestRepaintAssist.call(
      fakeThis, 'sess-1', 'tab-switch'
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.reason, 'tab-switch');
    assert.strictEqual(result.roundTrip, true);
    assert.deepStrictEqual(resizeCalls, [['sess-1', 121, 30], ['sess-1', 120, 30]]);
    const session = fakeThis.claudeSessions.get('sess-1');
    assert.strictEqual(session.cols, 120, 'committed grid unchanged');
    assert.strictEqual(session.rows, 30);
  });

  it('bumps rows when pinned at the col cap', async function () {
    const { fakeThis, resizeCalls } = makeHarness({
      session: { cols: 1000, rows: 30 },
    });
    const result = await ClaudeCodeWebServer.prototype._requestRepaintAssist.call(
      fakeThis, 'sess-1', 'tab-switch'
    );
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(resizeCalls, [['sess-1', 1000, 31], ['sess-1', 1000, 30]]);
  });

  it('rate-limits a second assist within the interval', async function () {
    const { fakeThis, resizeCalls } = makeHarness();
    const first = await ClaudeCodeWebServer.prototype._requestRepaintAssist.call(
      fakeThis, 'sess-1', 'tab-switch'
    );
    assert.strictEqual(first.ok, true);
    const second = await ClaudeCodeWebServer.prototype._requestRepaintAssist.call(
      fakeThis, 'sess-1', 'browser-focus'
    );
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.reason, 'rate-limited');
    assert.strictEqual(resizeCalls.length, 2, 'no second round-trip');
  });

  it('assists again after the interval elapses', async function () {
    const { fakeThis, resizeCalls } = makeHarness();
    await ClaudeCodeWebServer.prototype._requestRepaintAssist.call(fakeThis, 'sess-1', 'a');
    fakeThis._lastRepaintAssist.set('sess-1', Date.now() - REPAINT_ASSIST_MIN_INTERVAL_MS - 1);
    const result = await ClaudeCodeWebServer.prototype._requestRepaintAssist.call(
      fakeThis, 'sess-1', 'browser-focus'
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(resizeCalls.length, 4);
  });

  it('skips unknown, non-live, geometry-less, and non-alt sessions without resizing', async function () {
    const { fakeThis, resizeCalls } = makeHarness();
    assert.strictEqual(
      (await ClaudeCodeWebServer.prototype._requestRepaintAssist.call(fakeThis, 'nope', 'x')).reason,
      'unknown-session'
    );
    for (const [label, session] of [
      ['session-not-live', { active: false }],
      ['no-geometry', { cols: null }],
    ]) {
      const h = makeHarness({ session });
      const r = await ClaudeCodeWebServer.prototype._requestRepaintAssist.call(h.fakeThis, 'sess-1', 'x');
      assert.strictEqual(r.reason, label);
      assert.strictEqual(h.resizeCalls.length, 0);
    }
    const notAlt = makeHarness({
      session: { _ctlTranscript: { isAltScreenActive: () => false } },
    });
    const r = await ClaudeCodeWebServer.prototype._requestRepaintAssist.call(
      notAlt.fakeThis, 'sess-1', 'x'
    );
    assert.strictEqual(r.reason, 'not-alt-screen');
    assert.strictEqual(notAlt.resizeCalls.length, 0);
    assert.strictEqual(resizeCalls.length, 0, 'nothing resized across skips');
  });

  it('settles the transcript parser before reading alt state', async function () {
    // A fast switch can request help while the alt-enter bytes are still
    // queued unparsed; the assist must drain first or it mis-skips as
    // 'not-alt-screen'. The drain Razor: resize must happen only after
    // drain() resolved.
    const order = [];
    const { fakeThis, resizeCalls } = makeHarness({
      session: {
        _ctlTranscript: {
          isAltScreenActive: () => true,
          drain: async () => { order.push('drain'); },
        },
      },
      thisProps: {
        getBridgeForAgent: () => ({
          resize: async (id, cols, rows) => {
            order.push('resize');
            resizeCalls.push([id, cols, rows]);
          },
        }),
      },
    });
    const result = await ClaudeCodeWebServer.prototype._requestRepaintAssist.call(
      fakeThis, 'sess-1', 'tab-switch'
    );
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(order, ['drain', 'resize', 'resize']);
  });

  it('leaves an in-flight geometry transaction alone', async function () {
    const { fakeThis, resizeCalls } = makeHarness({
      session: { _geometryOutputHold: [] },
    });
    const result = await ClaudeCodeWebServer.prototype._requestRepaintAssist.call(
      fakeThis, 'sess-1', 'tab-switch'
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'hold-active');
    assert.strictEqual(resizeCalls.length, 0, 'must not resize mid-transaction');
  });

  it('releases the geometry hold even when the PTY resize throws', async function () {
    const { fakeThis } = makeHarness({
      thisProps: {
        getBridgeForAgent: () => ({
          resize: async () => { throw new Error('ConPTY busy'); },
        }),
      },
    });
    const result = await ClaudeCodeWebServer.prototype._requestRepaintAssist.call(
      fakeThis, 'sess-1', 'tab-switch'
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'resize-failed');
    const session = fakeThis.claudeSessions.get('sess-1');
    assert.strictEqual(session._geometryOutputHold, null, 'hold must not strand output');
  });
});
