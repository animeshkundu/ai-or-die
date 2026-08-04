'use strict';

const assert = require('assert');
const { FitCoordinator } = require('../src/public/fit-coordinator');

describe('FitCoordinator', function () {
  it('defers zero-size targets and resumes on ResizeObserver', function () {
    let width = 0;
    let observerCallback;
    const resizes = [];
    const sends = [];
    const queue = [];
    class Observer {
      constructor(cb) { observerCallback = cb; }
      observe() {}
      disconnect() {}
    }
    const coordinator = new FitCoordinator({
      ResizeObserver: Observer,
      requestAnimationFrame: (fn) => queue.push(fn),
      logger: { warn() {} },
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width, height: 400 }) },
      terminal: { resize: (cols, rows) => resizes.push({ cols, rows }) },
      proposeDimensions: () => width ? ({ cols: 80, rows: 25 }) : null,
      send: (size) => sends.push(size),
    });
    queue.shift()();
    assert.deepStrictEqual(resizes, []);
    width = 800;
    observerCallback();
    queue.shift()();
    assert.deepStrictEqual(resizes, [{ cols: 80, rows: 25 }]);
    assert.deepStrictEqual(sends, [{ cols: 80, rows: 25 }]);
  });

  it('deduplicates geometry but can force a wire send after reconnect', function () {
    const queue = [];
    const resizes = [];
    const sends = [];
    const coordinator = new FitCoordinator({ requestAnimationFrame: (fn) => queue.push(fn) });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      terminal: { resize: (cols, rows) => resizes.push({ cols, rows }) },
      proposeDimensions: () => ({ cols: 80, rows: 25 }),
      send: (size) => sends.push(size),
    });
    queue.shift()();
    coordinator.request('main');
    queue.shift()();
    coordinator.request('main', { forceSend: true });
    queue.shift()();
    assert.strictEqual(resizes.length, 1);
    assert.strictEqual(sends.length, 2);
  });

  it('never applies unsafe geometry', function () {
    const queue = [];
    let resized = false;
    const coordinator = new FitCoordinator({ requestAnimationFrame: (fn) => queue.push(fn) });
    coordinator.register('tiny', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 100, height: 100 }) },
      terminal: { resize: () => { resized = true; } },
      proposeDimensions: () => ({ cols: 10, rows: 4 }),
    });
    queue.shift()();
    assert.strictEqual(resized, false);
  });

  it('retries deferred targets when the document becomes visible', function () {
    const queue = [];
    const listeners = {};
    let width = 0;
    const resizes = [];
    const document = {
      visibilityState: 'hidden',
      addEventListener(type, fn) { listeners[type] = fn; },
      removeEventListener() {},
    };
    const coordinator = new FitCoordinator({
      document,
      requestAnimationFrame: (fn) => queue.push(fn),
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width, height: 400 }) },
      terminal: { resize: (cols, rows) => resizes.push({ cols, rows }) },
      proposeDimensions: () => width ? ({ cols: 80, rows: 25 }) : null,
    });
    queue.shift()();
    width = 800;
    document.visibilityState = 'visible';
    listeners.visibilitychange();
    queue.shift()();
    assert.deepStrictEqual(resizes, [{ cols: 80, rows: 25 }]);
    coordinator.destroy();
  });

  it('retains a forced send after a transient wire failure', function () {
    const queue = [];
    let fail = false;
    let sends = 0;
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      logger: { warn() {} },
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      terminal: { resize() {} },
      proposeDimensions: () => ({ cols: 80, rows: 25 }),
      send() {
        sends++;
        if (fail) throw new Error('socket closed');
      },
    });
    queue.shift()();
    fail = true;
    coordinator.request('main', { forceSend: true });
    queue.shift()();
    fail = false;
    coordinator.request('main');
    queue.shift()();
    assert.strictEqual(sends, 3);
  });

  it('retries when a socket-aware sender reports that it did not send', function () {
    const queue = [];
    const sends = [];
    let open = false;
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      terminal: { resize() {} },
      proposeDimensions: () => ({ cols: 80, rows: 25 }),
      send(size) {
        sends.push(size);
        return open;
      },
    });
    queue.shift()();
    open = true;
    coordinator.request('main');
    queue.shift()();
    assert.strictEqual(sends.length, 2);
  });
});
