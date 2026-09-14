'use strict';

const assert = require('assert');
const {
  correctedPointForCell,
  correctionForEvent,
  attach,
} = require('../src/public/pointer-correction');

// Minimal pointerToCell stand-in with the real contract:
// outer-relative -> 0-based {col,row}, CLAMPED to the grid (like the real
// module); null only on bad input. Callers that must distinguish
// outside-grid hits (chrome guard) bounds-check themselves.
function pointerToCell(pres, applied, cell, outer) {
  if (!pres || !applied || !cell || !outer) return null;
  const gx = (outer.x + pres.offsetX) / pres.scale;
  const gy = (outer.y + pres.offsetY) / pres.scale;
  const col = Math.min(Math.max(Math.floor(gx / cell.width), 0), applied.cols - 1);
  const row = Math.min(Math.max(Math.floor(gy / cell.height), 0), applied.rows - 1);
  return { col, row };
}

const CELL = { width: 8, height: 16 };

describe('pointer correction', function () {
  describe('correctedPointForCell', function () {
    it('aims at the cell center in xterm screen space', function () {
      const pt = correctedPointForCell(6, 4, { left: 100, top: 50 }, CELL);
      assert.deepStrictEqual(pt, { x: 100 + 5.5 * 8, y: 50 + 3.5 * 16 });
    });
  });

  describe('correctionForEvent', function () {
    it('returns null in the exact regime (common case untouched)', function () {
      const state = {
        presentation: { regime: 'exact', scale: 1, offsetX: 0, offsetY: 0 },
        applied: { cols: 80, rows: 24 },
        cell: CELL,
        outerRect: { left: 0, top: 0 },
        screenRect: { left: 8, top: 8 },
      };
      assert.strictEqual(correctionForEvent(state, pointerToCell, 100, 100), null);
    });

    it('returns null without a pointerToCell function', function () {
      const state = {
        presentation: { regime: 'pan', scale: 0.5, offsetX: 80, offsetY: 0 },
        applied: { cols: 170, rows: 44 },
        cell: CELL,
        outerRect: { left: 0, top: 0 },
        screenRect: { left: -72, top: 8 },
      };
      assert.strictEqual(correctionForEvent(state, null, 100, 100), null);
    });

    it('remaps a pan-regime click to the drawn cell center', function () {
      // Drawn col 30 center in outer coords: grid 30.5*8=244 plus the
      // screen inset (8 layout px, inside the transform: 8*0.5=4 client px),
      // i.e. outer x = 244*0.5+4-80 = 46.
      const state = {
        presentation: { regime: 'pan', scale: 0.5, offsetX: 80, offsetY: 0 },
        applied: { cols: 170, rows: 44 },
        cell: CELL,
        outerRect: { left: 0, top: 37 },
        screenRect: { left: -76, top: 41 },
        inset: { x: 8, y: 8 },
      };
      const fixed = correctionForEvent(state, pointerToCell, 46, 37 + 100);
      assert.ok(fixed, 'should remap under pan');
      // Drawn cell at outer 46: stage-local (46+80)/0.5=252, grid 252-8=244
      // -> col 30 (0-based); corrected point must make xterm report SGR 31:
      // floor((x + 76)/8)+1 = 31 -> x in [168,176); center 172.
      assert.strictEqual(Math.floor((fixed.x + 76) / 8) + 1, 31);
    });

    it('clamps far-outside clicks to the grid edge (mappable must gate these)', function () {
      const state = {
        presentation: { regime: 'scale', scale: 0.5, offsetX: 0, offsetY: 0 },
        applied: { cols: 170, rows: 44 },
        cell: CELL,
        outerRect: { left: 0, top: 0 },
        screenRect: { left: 8, top: 8 },
      };
      // Clamped to the last cell: proves why the chrome/outside guard lives
      // in mappable (attach level), not in correctionForEvent.
      const fixed = correctionForEvent(state, pointerToCell, 5000, 5000);
      assert.ok(fixed, 'clamped edge point returned');
      assert.strictEqual(Math.floor((fixed.x - 8) / 8) + 1, 170);
    });
  });

  describe('attach wiring', function () {
    // Fake DOM: wrapper containing exactly one screen element.
    function fakeWorld() {
      const dispatched = [];
      const screen = {
        getBoundingClientRect: () => ({ left: -76, top: 41 }),
        contains: (el) => el === screen || el === inner,
        dispatchEvent: (e) => { dispatched.push(e); return true; },
      };
      const inner = {};
      const wrapper = {
        _handlers: {},
        contains: (el) => el === screen || el === inner,
        querySelector: () => screen,
        addEventListener: function (t, f) { this._handlers[t] = f; },
        removeEventListener: function (t) { delete this._handlers[t]; },
      };
      return { wrapper, screen, inner, dispatched };
    }

    function panState(screen) {
      return {
        presentation: { regime: 'pan', scale: 0.5, offsetX: 80, offsetY: 0 },
        applied: { cols: 170, rows: 44 },
        cell: CELL,
        outerRect: { left: 0, top: 37 },
        screenEl: screen,
        inset: { x: 8, y: 8 },
      };
    }

    function fakeEvent(type, x, y, target, extra) {
      return Object.assign({
        type, clientX: x, clientY: y, target,
        button: 0, buttons: type === 'mouseup' ? 0 : 1,
        stopped: false, prevented: false,
        stopPropagation: function () { this.stopped = true; },
        preventDefault: function () { this.prevented = true; },
      }, extra || {});
    }

    before(function () {
      // Minimal MouseEvent for the wiring (coords carried verbatim).
      global.MouseEvent = global.MouseEvent || class {
        constructor(type, init) { this.type = type; Object.assign(this, init); }
      };
    });

    it('remaps a grid mousedown exactly once (no double delivery)', function () {
      const w = fakeWorld();
      // Drawn col 30 center in outer coords: ((30.5*8)+8)*0.5-80 = 46.
      const detach = attach(w.wrapper, () => panState(w.screen), pointerToCell);
      const down = fakeEvent('mousedown', 46, 125, w.inner);
      w.wrapper._handlers.mousedown(down);
      assert.strictEqual(down.stopped, true, 'original must be stopped');
      assert.strictEqual(w.dispatched.length, 1, 'exactly one corrected clone');
      assert.strictEqual(w.dispatched[0].clientX, -76 + 30.5 * 8);
      detach();
    });

    it('leaves scrollbar/chrome hits raw (no forging)', function () {
      const w = fakeWorld();
      const detach = attach(w.wrapper, () => panState(w.screen), pointerToCell);
      // Far outside the drawn grid but inside the wrapper.
      const down = fakeEvent('mousedown', 5000, 5000, w.inner);
      w.wrapper._handlers.mousedown(down);
      assert.strictEqual(down.stopped, false, 'chrome hit must flow raw');
      assert.strictEqual(w.dispatched.length, 0);
      detach();
    });

    it('ends an open gesture on outside mouseup, then ignores further ups', function () {
      const w = fakeWorld();
      const detach = attach(w.wrapper, () => panState(w.screen), pointerToCell);
      w.wrapper._handlers.mousedown(fakeEvent('mousedown', 46, 125, w.inner));
      assert.strictEqual(w.dispatched.length, 1);
      // Release far outside: remapped to a clamped edge cell (no stuck drag).
      const outside = { not: 'in-dom' };
      w.wrapper._handlers.mouseup(fakeEvent('mouseup', 5000, 5000, outside));
      assert.strictEqual(w.dispatched.length, 2, 'outside release still delivered');
      // Gesture closed: another outside up is ignored entirely.
      w.wrapper._handlers.mouseup(fakeEvent('mouseup', 5000, 5000, outside));
      assert.strictEqual(w.dispatched.length, 2);
      detach();
    });

    it('remaps dblclick like mousedown', function () {
      const w = fakeWorld();
      const detach = attach(w.wrapper, () => panState(w.screen), pointerToCell);
      const dbl = fakeEvent('dblclick', 46, 125, w.inner);
      w.wrapper._handlers.dblclick(dbl);
      assert.strictEqual(dbl.stopped, true);
      assert.strictEqual(w.dispatched.length, 1);
      detach();
    });

    it('stays inert in the exact regime', function () {
      const w = fakeWorld();
      const exact = panState(w.screen);
      exact.presentation = { regime: 'exact', scale: 1, offsetX: 0, offsetY: 0 };
      const detach = attach(w.wrapper, () => exact, pointerToCell);
      const down = fakeEvent('mousedown', 100, 100, w.inner);
      w.wrapper._handlers.mousedown(down);
      assert.strictEqual(down.stopped, false);
      assert.strictEqual(w.dispatched.length, 0);
      detach();
    });
  });
});
