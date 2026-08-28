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

  // Regression: nothing but a container size change or a visibilitychange used
  // to re-drive a target, so a pane whose socket was still opening (or whose
  // container was not measurable yet) kept a stale PTY size forever. Observed
  // on WebKit as a freshly created split pane that never sent its geometry.
  it('retries on its own when the socket is not open yet', function () {
    const queue = [];
    const timers = [];
    const sends = [];
    let open = false;
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
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
    assert.strictEqual(sends.length, 1, 'first attempt runs');
    assert.strictEqual(timers.length, 1, 'a retry is armed after a failed send');

    // No ResizeObserver fires and the page never hides: only the coordinator's
    // own retry can rescue this target.
    timers.shift()();
    queue.shift()();
    assert.strictEqual(sends.length, 2, 'retry re-attempts the send');

    open = true;
    timers.shift()();
    queue.shift()();
    assert.strictEqual(sends.length, 3, 'succeeds once the socket opens');

    // Settled: no further retries are armed.
    const armedAfterSuccess = timers.length;
    assert.strictEqual(armedAfterSuccess, 0, 'retries stop once the send lands');
  });

  it('bounds the retry loop so a permanently unmeasurable target cannot spin', function () {
    const queue = [];
    const timers = [];
    let attempts = 0;
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      maxRetries: 3,
      logger: { warn() {} },
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 0, height: 0 }) },
      terminal: { resize() {} },
      proposeDimensions: () => { attempts++; return null; },
      send() { return true; },
    });
    queue.shift()();
    let guard = 0;
    while (timers.length && guard++ < 50) {
      timers.shift()();
      while (queue.length) queue.shift()();
    }
    assert.strictEqual(attempts, 4, 'one initial attempt plus maxRetries retries');
    assert.strictEqual(timers.length, 0, 'the retry loop terminates');
  });

  // Regression: the budget used to be spent at schedule time, so a burst of
  // ResizeObserver callbacks arriving while one timer was armed could consume
  // every attempt without a single retry ever running.
  it('does not spend the retry budget on requests made while a retry is armed', function () {
    const queue = [];
    const timers = [];
    let attempts = 0;
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      maxRetries: 2,
      logger: { warn() {} },
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      terminal: { resize() {} },
      proposeDimensions: () => ({ cols: 80, rows: 25 }),
      send() { attempts++; return false; },
    });
    queue.shift()();
    assert.strictEqual(attempts, 1);
    assert.strictEqual(timers.length, 1, 'exactly one shared timer is armed');

    // Three more schedule attempts land while that timer is still pending.
    for (let i = 0; i < 3; i++) coordinator._scheduleRetry('main');
    assert.strictEqual(timers.length, 1, 'no extra timers pile up');

    timers.shift()();
    while (queue.length) queue.shift()();
    assert.strictEqual(attempts, 2, 'the armed retry still ran');
    assert.ok(timers.length >= 1, 'the second retry of the budget is still available');
  });

  it('starts a fresh bounded run after an external request', function () {
    const queue = [];
    const timers = [];
    let attempts = 0;
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      maxRetries: 2,
      logger: { warn() {} },
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      terminal: { resize() {} },
      proposeDimensions: () => ({ cols: 80, rows: 25 }),
      send() { attempts++; return false; },
    });
    queue.shift()();
    let guard = 0;
    while (timers.length && guard++ < 20) {
      timers.shift()();
      while (queue.length) queue.shift()();
    }
    assert.strictEqual(attempts, 3, 'initial attempt plus maxRetries retries');
    assert.strictEqual(timers.length, 0, 'budget exhausted, loop stopped');

    // A ResizeObserver callback is new information: the budget resets.
    coordinator.request('main');
    while (queue.length) queue.shift()();
    assert.strictEqual(attempts, 4);
    assert.strictEqual(timers.length, 1, 'a fresh bounded run is armed');
  });

  it('shares one timer across targets without cross-starving their budgets', function () {
    const queue = [];
    const timers = [];
    const attempts = { a: 0, b: 0 };
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      maxRetries: 2,
      logger: { warn() {} },
    });
    const makeTarget = (key, open) => ({
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      terminal: { resize() {} },
      proposeDimensions: () => ({ cols: 80, rows: 25 }),
      send() { attempts[key]++; return open(); },
    });
    let bOpen = false;
    coordinator.register('a', makeTarget('a', () => false));
    coordinator.register('b', makeTarget('b', () => bOpen));
    while (queue.length) queue.shift()();
    assert.strictEqual(attempts.a, 1);
    assert.strictEqual(attempts.b, 1);
    assert.strictEqual(timers.length, 1, 'both targets coalesce into one timer');

    bOpen = true;
    timers.shift()();
    while (queue.length) queue.shift()();
    assert.strictEqual(attempts.a, 2);
    assert.strictEqual(attempts.b, 2, 'b succeeds on its retry');

    // b settled, so only a keeps retrying and a still has its own budget left.
    timers.shift()();
    while (queue.length) queue.shift()();
    assert.strictEqual(attempts.b, 2, 'a settled target is not retried again');
    assert.strictEqual(attempts.a, 3);
    assert.strictEqual(timers.length, 0, 'a exhausted its own budget of 2');
  });

  // Regression: the self-retry must not fight the overlay invariant of
  // ADR-0045. An established terminal whose container is temporarily
  // unmeasurable (chrome overlaying it) must NOT be re-fitted on a timer --
  // that reflowed a terminal the user was reading. Only targets that never had
  // a geometry chase a measurement.
  it('never re-fits an established target whose container goes unmeasurable', function () {
    const queue = [];
    const timers = [];
    const resizes = [];
    let width = 800;
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      logger: { warn() {} },
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width, height: 400 }) },
      terminal: { resize: (cols, rows) => resizes.push({ cols, rows }) },
      proposeDimensions: () => (width ? { cols: width === 800 ? 80 : 40, rows: 25 } : null),
      send: () => true,
    });
    queue.shift()();
    assert.deepStrictEqual(resizes, [{ cols: 80, rows: 25 }], 'establishes a geometry');

    // Chrome overlays the terminal: the container measures as unmeasurable.
    width = 0;
    coordinator.request('main');
    while (queue.length) queue.shift()();
    assert.strictEqual(timers.length, 0, 'no retry is armed for an established target');
    assert.strictEqual(resizes.length, 1, 'the established geometry is untouched');

    // Only a real ResizeObserver-driven change re-fits it.
    width = 400;
    coordinator.request('main');
    while (queue.length) queue.shift()();
    assert.deepStrictEqual(resizes, [{ cols: 80, rows: 25 }, { cols: 40, rows: 25 }]);
  });

  it('resumes retrying after a bounded run once the container becomes measurable', function () {
    const queue = [];
    const timers = [];
    const resizes = [];
    let width = 0;
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      maxRetries: 2,
      logger: { warn() {} },
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width, height: 400 }) },
      terminal: { resize: (cols, rows) => resizes.push({ cols, rows }) },
      proposeDimensions: () => (width ? { cols: 80, rows: 25 } : null),
      send: () => true,
    });
    queue.shift()();
    let guard = 0;
    while (timers.length && guard++ < 20) {
      timers.shift()();
      while (queue.length) queue.shift()();
    }
    assert.deepStrictEqual(resizes, [], 'never fits against a zero-width container');
    width = 800;
    coordinator.request('main');
    while (queue.length) queue.shift()();
    assert.deepStrictEqual(resizes, [{ cols: 80, rows: 25 }]);
  });

  it('resolves requestAndWait after resize and send settle', async function () {
    const queue = [];
    const timers = [];
    const resizes = [];
    const sends = [];
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      terminal: { resize: (cols, rows) => resizes.push({ cols, rows }) },
      proposeDimensions: () => ({ cols: 80, rows: 25 }),
      send: (size) => sends.push(size),
    });
    queue.shift()();
    const settled = coordinator.requestAndWait('main', { forceSend: true, generation: 7 });
    assert.strictEqual(timers.length, 1, 'waiter arms one timeout');
    queue.shift()();
    assert.deepStrictEqual(await settled, { cols: 80, rows: 25 });
    assert.deepStrictEqual(resizes, [{ cols: 80, rows: 25 }]);
    assert.strictEqual(sends.length, 2, 'forceSend is preserved for the requested pass');
    assert.strictEqual(timers.length, 1, 'clearing a timer does not remove the test timer record');
  });

  it('rejects requestAndWait on timeout without changing request behavior', async function () {
    const queue = [];
    const timers = [];
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      requestWaitTimeoutMs: 25,
      maxRetries: 0,
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 0, height: 0 }) },
      terminal: { resize() {} },
      proposeDimensions: () => null,
    });
    queue.shift()();
    const pending = coordinator.requestAndWait('main', { generation: 1 });
    queue.shift()();
    assert.strictEqual(timers.length, 1, 'waiter timeout is bounded even without a retry');
    const timeout = timers[0];
    timeout();
    await assert.rejects(pending, (error) => error.name === 'FitRequestTimeoutError'
      && error.code === 'FIT_REQUEST_TIMEOUT');

    coordinator.request('main');
    assert.strictEqual(queue.length, 1, 'regular request still queues a fit');
  });

  it('rejects stale generations without settling the newer waiter', async function () {
    const queue = [];
    const timers = [];
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
    });
    let proposed = { cols: 80, rows: 25 };
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      terminal: { resize() {} },
      proposeDimensions: () => proposed,
      send: () => true,
    });
    queue.shift()();
    const first = coordinator.requestAndWait('main', { generation: 10 });
    const second = coordinator.requestAndWait('main', { generation: 11 });
    await assert.rejects(first, (error) => error.name === 'FitRequestSupersededError'
      && error.code === 'FIT_REQUEST_SUPERSEDED');
    queue.shift()();
    assert.deepStrictEqual(await second, { cols: 80, rows: 25 });
    proposed = { cols: 100, rows: 25 };
    const timersBeforeStale = timers.length;
    const stale = coordinator.requestAndWait('main', { generation: 10 });
    await assert.rejects(stale, (error) => error.name === 'FitRequestSupersededError');
    assert.strictEqual(timers.length, timersBeforeStale, 'stale generations do not arm a waiter timer');

    coordinator.destroy();
    assert.strictEqual(queue.length, 0, 'stale generation does not leave a queued fit');
  });

  it('does not cross-cancel waiters for different targets', async function () {
    const queue = [];
    const timers = [];
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
    });
    const target = {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      terminal: { resize() {} },
      proposeDimensions: () => ({ cols: 80, rows: 25 }),
      send: () => true,
    };
    coordinator.register('a', target);
    coordinator.register('b', target);
    while (queue.length) queue.shift()();
    const a = coordinator.requestAndWait('a', { generation: 1 });
    const b = coordinator.requestAndWait('b', { generation: 1 });
    while (queue.length) queue.shift()();
    assert.deepStrictEqual(await a, { cols: 80, rows: 25 });
    assert.deepStrictEqual(await b, { cols: 80, rows: 25 });
    assert.strictEqual(timers.length, 2, 'each target owns its waiter timer');
  });

  it('still applies a timed-out request when its frame runs later', async function () {
    const queue = [];
    const timers = [];
    const resizes = [];
    const sends = [];
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      terminal: { resize: (cols, rows) => resizes.push({ cols, rows }) },
      proposeDimensions: () => ({ cols: 80, rows: 25 }),
      send: (size) => sends.push(size),
    });
    const pending = coordinator.requestAndWait('main', { generation: 1, timeoutMs: 5 });
    const timeout = timers.pop();
    timeout();
    await assert.rejects(pending, (error) => error.name === 'FitRequestTimeoutError');
    queue.shift()();
    assert.deepStrictEqual(resizes, [{ cols: 80, rows: 25 }]);
    assert.deepStrictEqual(sends, [{ cols: 80, rows: 25 }]);
  });

  it('preserves a retry after a timed-out waiter', async function () {
    const queue = [];
    const timers = [];
    let open = false;
    let sends = 0;
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      retryDelayMs: 10,
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      terminal: { resize() {} },
      proposeDimensions: () => ({ cols: 80, rows: 25 }),
      send: () => {
        sends++;
        return open;
      },
    });
    while (queue.length) queue.shift()();
    const pending = coordinator.requestAndWait('main', { generation: 1, timeoutMs: 5 });
    while (queue.length) queue.shift()();
    const timeout = timers.pop();
    timeout();
    await assert.rejects(pending, (error) => error.name === 'FitRequestTimeoutError');
    assert.strictEqual(timers.length, 1, 'fit retry remains armed after waiter timeout');
    timers.shift()();
    while (queue.length) queue.shift()();
    open = true;
    timers.shift()();
    while (queue.length) queue.shift()();
    assert.strictEqual(open, true, 'the ordinary retry path remains active');
    assert.strictEqual(sends, 4, 'the retry sends again after the waiter times out');
  });

  it('lets a regular request share and complete a pending waiter generation', async function () {
    const queue = [];
    const timers = [];
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      terminal: { resize() {} },
      proposeDimensions: () => ({ cols: 80, rows: 25 }),
      send: () => true,
    });
    while (queue.length) queue.shift()();
    const pending = coordinator.requestAndWait('main', { generation: 4 });
    coordinator.request('main');
    queue.shift()();
    assert.deepStrictEqual(await pending, { cols: 80, rows: 25 });
  });

  it('applies one queued fit while a newer generation supersedes the old waiter', async function () {
    const queue = [];
    const timers = [];
    let resizes = 0;
    const coordinator = new FitCoordinator({
      requestAnimationFrame: (fn) => queue.push(fn),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
    });
    coordinator.register('main', {
      container: { isConnected: true, getBoundingClientRect: () => ({ width: 800, height: 400 }) },
      terminal: { resize: () => { resizes++; } },
      proposeDimensions: () => ({ cols: 80, rows: 25 }),
      send: () => true,
    });
    while (queue.length) queue.shift()();
    const oldWaiter = coordinator.requestAndWait('main', { generation: 8 });
    const newWaiter = coordinator.requestAndWait('main', { generation: 9 });
    await assert.rejects(oldWaiter, (error) => error.name === 'FitRequestSupersededError');
    queue.shift()();
    assert.deepStrictEqual(await newWaiter, { cols: 80, rows: 25 });
    assert.strictEqual(resizes, 1, 'supersession coalesces the queued fit');
  });
});
