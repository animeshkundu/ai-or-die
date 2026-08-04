'use strict';

const assert = require('assert');
const { ViewportRegime } = require('../src/public/viewport-regime');

describe('ViewportRegime', function () {
  it('detects keyboard state from visualViewport only and publishes layout values', function () {
    const listeners = {};
    const properties = {};
    const viewport = {
      height: 852,
      offsetTop: 0,
      scale: 1,
      addEventListener: (type, fn) => { listeners[type] = fn; },
      removeEventListener() {},
    };
    const queue = [];
    const states = [];
    const regime = new ViewportRegime({
      visualViewport: viewport,
      document: { documentElement: { style: { setProperty: (k, v) => { properties[k] = v; } } } },
      window: { scrollTo() {} },
      requestAnimationFrame: (fn) => queue.push(fn),
      onChange: (state) => states.push(state),
    });
    queue.shift()();
    viewport.height = 480;
    listeners.resize();
    queue.shift()();
    assert.strictEqual(states.at(-1).keyboardOpen, true);
    assert.strictEqual(properties['--visual-viewport-height'], '480px');
    regime.destroy();
  });

  it('resets residual viewport offset after keyboard dismissal', function () {
    let resets = 0;
    const listeners = {};
    const viewport = {
      height: 852,
      offsetTop: 0,
      scale: 1,
      addEventListener(type, fn) { listeners[type] = fn; },
      removeEventListener() {},
    };
    const queue = [];
    new ViewportRegime({
      visualViewport: viewport,
      document: { documentElement: { style: { setProperty() {} } } },
      window: { scrollTo: () => { resets++; } },
      requestAnimationFrame: (fn) => queue.push(fn),
    });
    queue.shift()();
    viewport.height = 480;
    listeners.resize();
    queue.shift()();
    viewport.height = 852;
    viewport.offsetTop = 12;
    listeners.resize();
    queue.shift()();
    assert.strictEqual(resets, 1);
  });

  it('does not treat pinch zoom or panning as a keyboard', function () {
    let resets = 0;
    const viewport = {
      height: 426,
      offsetTop: 30,
      scale: 2,
      addEventListener() {},
      removeEventListener() {},
    };
    const queue = [];
    const states = [];
    new ViewportRegime({
      visualViewport: viewport,
      document: { documentElement: { style: { setProperty() {} } } },
      window: { scrollTo: () => { resets++; } },
      requestAnimationFrame: (fn) => queue.push(fn),
      onChange: (state) => states.push(state),
    });
    queue.shift()();
    assert.strictEqual(states[0].keyboardOpen, false);
    assert.strictEqual(states[0].zoomed, true);
    assert.strictEqual(resets, 0);
  });

  it('treats a viewport orientation change as a new baseline, not a keyboard', function () {
    const listeners = {};
    const viewport = {
      width: 393,
      height: 852,
      offsetTop: 0,
      scale: 1,
      addEventListener(type, fn) { listeners[type] = fn; },
      removeEventListener() {},
    };
    const queue = [];
    const states = [];
    new ViewportRegime({
      visualViewport: viewport,
      document: { documentElement: { style: { setProperty() {} } } },
      window: { scrollTo() {} },
      requestAnimationFrame: (fn) => queue.push(fn),
      onChange: (state) => states.push(state),
    });
    queue.shift()();
    viewport.width = 852;
    viewport.height = 393;
    listeners.resize();
    queue.shift()();
    assert.strictEqual(states.at(-1).keyboardOpen, false);
    assert.strictEqual(states.at(-1).baselineHeight, 393);
  });
});
