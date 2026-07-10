'use strict';

// test/terminal-wheel.test.js — wheel policy that stops xterm's alt-buffer
// wheel->arrow translation from hijacking the Claude Code TUI.
//
// Pure-logic tests (decideWheelAction) cover the full decision matrix:
//   buffer type × mouse mode × wheelScrollMode × explicit DEC 1007.
// Wiring tests (attachTerminalWheel) use a fake container to assert the
// capture-phase listener preempts (preventDefault + stopImmediatePropagation)
// only when it should, that the parser 1007 hook flips the decision, and that
// dispose() unwires everything.

const assert = require('assert');
const path = require('path');

const modulePath = path.join(__dirname, '..', 'src', 'public', 'terminal-wheel.js');
delete require.cache[require.resolve(modulePath)];
const { attachTerminalWheel, decideWheelAction } = require(modulePath);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
function fakeTerminal(opts) {
  opts = opts || {};
  const csi = {}; // key `${prefix}${final}` -> handler
  const esc = {}; // key `${final}` -> handler
  const t = {
    buffer: { active: { type: opts.type || 'normal' } },
    modes: { mouseTrackingMode: opts.mouse || 'none' },
    parser: {
      registerCsiHandler: ({ prefix, final }, cb) => {
        csi[(prefix || '') + final] = cb;
        return { dispose() { csi[(prefix || '') + final] = null; } };
      },
      registerEscHandler: ({ final }, cb) => {
        esc[final] = cb;
        return { dispose() { esc[final] = null; } };
      }
    },
    _csi: csi,
    _esc: esc
  };
  // Opt in to the official xterm >= 5.4 wheel-handler API.
  if (opts.customWheel) {
    t.attachCustomWheelEventHandler = (fn) => { t._wheelFn = fn; };
  }
  return t;
}

function fakeContainer() {
  const state = { handler: null, opts: null, removed: false };
  return {
    addEventListener: (type, h, o) => { if (type === 'wheel') { state.handler = h; state.opts = o; } },
    removeEventListener: (type) => { if (type === 'wheel') { state.handler = null; state.removed = true; } },
    _fire: (deltaY) => {
      const ev = { deltaY, pd: 0, sip: 0, preventDefault() { this.pd++; }, stopImmediatePropagation() { this.sip++; } };
      if (state.handler) state.handler(ev);
      return ev;
    },
    _state: state
  };
}

// ---------------------------------------------------------------------------
// decideWheelAction — pure decision matrix
// ---------------------------------------------------------------------------
describe('terminal-wheel: decideWheelAction', function () {
  it('normal buffer always passes through (native scrollback scroll)', function () {
    const t = fakeTerminal({ type: 'normal' });
    assert.strictEqual(decideWheelAction(t, 'dontHijack', null), 'passthrough');
    assert.strictEqual(decideWheelAction(t, 'altScroll', null), 'passthrough');
  });

  it('alt buffer + mouse mode passes through (xterm reports mouse events)', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'vt200' });
    assert.strictEqual(decideWheelAction(t, 'dontHijack', null), 'passthrough');
    assert.strictEqual(decideWheelAction(t, 'altScroll', null), 'passthrough');
  });

  it('alt buffer, no mouse, dontHijack -> suppress (no menu hijack)', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none' });
    assert.strictEqual(decideWheelAction(t, 'dontHijack', null), 'suppress');
  });

  it('alt buffer, no mouse, altScroll -> passthrough (pagers scroll)', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none' });
    assert.strictEqual(decideWheelAction(t, 'altScroll', null), 'passthrough');
  });

  it('explicit DEC 1007=on overrides dontHijack -> passthrough', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none' });
    assert.strictEqual(decideWheelAction(t, 'dontHijack', 'on'), 'passthrough');
  });

  it('explicit DEC 1007=off overrides altScroll -> suppress', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none' });
    assert.strictEqual(decideWheelAction(t, 'altScroll', 'off'), 'suppress');
  });

  it('unknown mode defaults to dontHijack behaviour in alt buffer', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none' });
    assert.strictEqual(decideWheelAction(t, undefined, null), 'suppress');
  });

  it('never throws on a malformed terminal (fails open to passthrough)', function () {
    assert.strictEqual(decideWheelAction(null, 'dontHijack', null), 'passthrough');
    assert.strictEqual(decideWheelAction({}, 'dontHijack', null), 'passthrough');
    assert.strictEqual(decideWheelAction({ buffer: {} }, 'dontHijack', null), 'passthrough');
  });
});

// ---------------------------------------------------------------------------
// attachTerminalWheel — capture-phase wiring
// ---------------------------------------------------------------------------
describe('terminal-wheel: attachTerminalWheel', function () {
  it('registers a capture-phase, non-passive wheel listener', function () {
    const t = fakeTerminal({ type: 'alternate' });
    const c = fakeContainer();
    attachTerminalWheel(t, c, () => 'dontHijack');
    assert.strictEqual(typeof c._state.handler, 'function');
    assert.deepStrictEqual(c._state.opts, { capture: true, passive: false });
  });

  it('suppresses (preventDefault + stopImmediatePropagation) in alt buffer with dontHijack', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none' });
    const c = fakeContainer();
    attachTerminalWheel(t, c, () => 'dontHijack');
    const ev = c._fire(-120);
    assert.strictEqual(ev.pd, 1);
    assert.strictEqual(ev.sip, 1);
  });

  it('does not touch the event in the normal buffer', function () {
    const t = fakeTerminal({ type: 'normal' });
    const c = fakeContainer();
    attachTerminalWheel(t, c, () => 'dontHijack');
    const ev = c._fire(-120);
    assert.strictEqual(ev.pd, 0);
    assert.strictEqual(ev.sip, 0);
  });

  it('does not touch the event in alt buffer with altScroll (lets xterm send arrows)', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none' });
    const c = fakeContainer();
    attachTerminalWheel(t, c, () => 'altScroll');
    const ev = c._fire(120);
    assert.strictEqual(ev.pd, 0);
    assert.strictEqual(ev.sip, 0);
  });

  it('honours a live DEC 1007h set by the app (flips dontHijack -> passthrough)', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none' });
    const c = fakeContainer();
    attachTerminalWheel(t, c, () => 'dontHijack');
    // default: suppress
    assert.strictEqual(c._fire(-120).pd, 1);
    // app sets DEC private mode 1007 (alternate scroll) -> the '?h' handler flips the flag
    assert.strictEqual(typeof t._csi['?h'], 'function');
    t._csi['?h']([1007]);
    const ev = c._fire(-120);
    assert.strictEqual(ev.pd, 0, 'should pass through after 1007h');
    assert.strictEqual(ev.sip, 0);
    // app resets 1007 -> back to suppress
    t._csi['?l']([1007]);
    assert.strictEqual(c._fire(-120).pd, 1);
  });

  it('registered CSI handlers return false so other DEC modes still flow to xterm', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none' });
    const c = fakeContainer();
    attachTerminalWheel(t, c, () => 'dontHijack');
    assert.strictEqual(t._csi['?h']([25]), false);      // unrelated mode (cursor visibility)
    assert.strictEqual(t._csi['?h']([1049, 1007]), false); // 1007 among others
    assert.strictEqual(t._csi['?l']([2004]), false);
  });

  it('clears the 1007 flag on alt-buffer EXIT so a stale flag cannot hijack the next app', function () {
    // Repro: tmux sets 1007h, exits (1049l); a later Claude Code TUI (alt, no
    // mouse, no 1007) must NOT inherit tmux's 1007.
    const t = fakeTerminal({ type: 'alternate', mouse: 'none' });
    const c = fakeContainer();
    attachTerminalWheel(t, c, () => 'dontHijack');
    t._csi['?h']([1007]);                        // app A opts into alt-scroll
    assert.strictEqual(c._fire(-120).pd, 0);     // passthrough
    t._csi['?l']([1049]);                         // app A leaves the alt buffer
    assert.strictEqual(c._fire(-120).pd, 1);     // reset -> suppress again (no hijack)
  });

  it('resets the 1007 flag on alt-buffer ENTER (a stale off does not stick)', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none' });
    const c = fakeContainer();
    attachTerminalWheel(t, c, () => 'altScroll');
    t._csi['?l']([1007]);                         // prior app forced 1007 off
    assert.strictEqual(c._fire(120).pd, 1);      // off -> suppress even in altScroll
    t._csi['?h']([1049]);                         // new app enters the alt buffer -> reset
    assert.strictEqual(c._fire(120).pd, 0);      // altScroll + null -> passthrough
  });

  it('clears the 1007 flag on RIS (ESC c)', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none' });
    const c = fakeContainer();
    attachTerminalWheel(t, c, () => 'dontHijack');
    t._csi['?h']([1007]);
    assert.strictEqual(c._fire(-120).pd, 0);     // 1007 on -> passthrough
    assert.strictEqual(typeof t._esc['c'], 'function');
    t._esc['c']();                                // RIS full reset
    assert.strictEqual(c._fire(-120).pd, 1);     // reset -> suppress
  });

  it('dispose() removes the wheel listener', function () {
    const t = fakeTerminal({ type: 'alternate' });
    const c = fakeContainer();
    const handle = attachTerminalWheel(t, c, () => 'dontHijack');
    handle.dispose();
    assert.strictEqual(c._state.removed, true);
    assert.strictEqual(c._state.handler, null);
  });

  it('degrades gracefully when the parser API is absent (setting-only)', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none' });
    delete t.parser;
    const c = fakeContainer();
    attachTerminalWheel(t, c, () => 'dontHijack');
    assert.strictEqual(c._fire(-120).pd, 1); // still suppresses via the setting
  });

  it('returns a no-op handle for a missing container', function () {
    const handle = attachTerminalWheel(fakeTerminal(), null, () => 'dontHijack');
    assert.strictEqual(typeof handle.dispose, 'function');
    handle.dispose(); // must not throw
  });
});

// ---------------------------------------------------------------------------
// attachTerminalWheel — official attachCustomWheelEventHandler path (xterm >= 5.4)
// ---------------------------------------------------------------------------
describe('terminal-wheel: attachCustomWheelEventHandler path', function () {
  it('uses the official handler; returns false to suppress, true to pass through', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none', customWheel: true });
    let mode = 'dontHijack';
    attachTerminalWheel(t, null, () => mode);
    assert.strictEqual(typeof t._wheelFn, 'function');
    assert.strictEqual(t._wheelFn(), false); // dontHijack + alt -> suppress -> false (cancel)
    mode = 'altScroll';
    assert.strictEqual(t._wheelFn(), true);  // altScroll -> passthrough -> true (proceed)
  });

  it('does not require a container element and reinstalls a permissive handler on dispose', function () {
    const t = fakeTerminal({ type: 'normal', customWheel: true });
    const handle = attachTerminalWheel(t, null, () => 'dontHijack');
    assert.strictEqual(t._wheelFn(), true); // normal buffer -> passthrough
    handle.dispose();
    assert.strictEqual(t._wheelFn(), true); // permissive handler after dispose
  });

  it('honours the 1007 reset-on-alt-exit on the official path too', function () {
    const t = fakeTerminal({ type: 'alternate', mouse: 'none', customWheel: true });
    attachTerminalWheel(t, null, () => 'dontHijack');
    t._csi['?h']([1007]);
    assert.strictEqual(t._wheelFn(), true);  // 1007 on -> pass
    t._csi['?l']([1049]);                     // alt exit resets
    assert.strictEqual(t._wheelFn(), false); // suppress again
  });
});
