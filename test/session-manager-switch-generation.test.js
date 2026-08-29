'use strict';

const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');

const SM_SRC = path.join(__dirname, '..', 'src', 'public', 'session-manager.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('SessionTabManager.switchToTab generation fencing', function () {
  let dom;
  let previousGlobals;
  let SessionTabManager;

  beforeEach(function () {
    previousGlobals = {};
    for (const key of ['window', 'document', 'localStorage', 'requestAnimationFrame']) {
      previousGlobals[key] = {
        present: Object.prototype.hasOwnProperty.call(global, key),
        value: global[key],
      };
    }

    dom = new JSDOM(`<!DOCTYPE html>
      <body>
        <div id="tabsContainer"></div>
        <div id="terminalContainer"></div>
        <div id="workingDir"></div>
        <div id="srAnnounce"></div>
        <div id="overlay" style="display: none"></div>
      </body>`, { url: 'http://localhost' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.localStorage = dom.window.localStorage;

    delete require.cache[require.resolve(SM_SRC)];
    ({ SessionTabManager } = require(SM_SRC));
  });

  afterEach(function () {
    dom.window.close();
    for (const [key, state] of Object.entries(previousGlobals)) {
      if (state.present) global[key] = state.value;
      else delete global[key];
    }
  });

  function buildHarness(ids = ['a', 'b']) {
    const rafQueue = [];
    const joinRequests = new Map();
    const calls = { headers: [], fit: 0, focus: 0 };
    const claudeInterface = {
      isMobile: false,
      pendingJoinSessionId: null,
      snapshotCache: {
        capture() {},
        evict() {},
        paintCached() { return false; },
      },
      joinSession(sessionId) {
        const request = deferred();
        const requests = joinRequests.get(sessionId) || [];
        requests.push(request);
        joinRequests.set(sessionId, requests);
        return request.promise;
      },
      fitTerminal() {
        calls.fit++;
      },
      terminal: {
        focus() {
          calls.focus++;
        },
      },
    };

    global.requestAnimationFrame = (callback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    };
    global.window.requestAnimationFrame = global.requestAnimationFrame;

    const manager = new SessionTabManager(claudeInterface);
    for (const id of ids) {
      manager.addTab(id, `Session ${id.toUpperCase()}`, 'idle', `/workspace/${id}`, false);
    }
    manager.updateHeaderInfo = (sessionId) => {
      calls.headers.push(sessionId);
    };

    Object.defineProperty(document.getElementById('terminalContainer'), 'offsetHeight', {
      configurable: true,
      value: 400,
    });

    return {
      manager,
      claudeInterface,
      calls,
      resolveJoin(sessionId, index = 0) {
        joinRequests.get(sessionId)[index].resolve();
      },
      flushRaf() {
        while (rafQueue.length) rafQueue.shift()();
      },
      get queuedRafCount() {
        return rafQueue.length;
      },
    };
  }

  it('keeps the current switch behavior on the happy path', async function () {
    const { manager, calls, resolveJoin, flushRaf } = buildHarness();

    const switching = manager.switchToTab('a');
    resolveJoin('a');
    await switching;

    assert.deepStrictEqual(calls.headers, ['a']);
    assert.strictEqual(document.getElementById('srAnnounce').textContent, 'Switched to session: Session A');
    assert.strictEqual(calls.fit, 0);
    assert.strictEqual(calls.focus, 0);

    flushRaf();

    assert.strictEqual(calls.fit, 1);
    assert.strictEqual(calls.focus, 1);
  });

  it('drops post-await work from a superseded switch', async function () {
    const { manager, calls, resolveJoin, flushRaf } = buildHarness();

    const switchingA = manager.switchToTab('a');
    const switchingB = manager.switchToTab('b');

    resolveJoin('a');
    await switchingA;
    assert.deepStrictEqual(calls.headers, []);
    assert.strictEqual(document.getElementById('srAnnounce').textContent, '');

    resolveJoin('b');
    await switchingB;
    flushRaf();

    assert.deepStrictEqual(calls.headers, ['b']);
    assert.strictEqual(document.getElementById('srAnnounce').textContent, 'Switched to session: Session B');
    assert.strictEqual(calls.fit, 1);
    assert.strictEqual(calls.focus, 1);
    assert.strictEqual(manager.activeTabId, 'b');
  });

  it('drops a queued rAF continuation when another switch starts', async function () {
    const harness = buildHarness();
    const { manager, calls, resolveJoin, flushRaf } = harness;

    const switchingA = manager.switchToTab('a');
    resolveJoin('a');
    await switchingA;
    assert.strictEqual(harness.queuedRafCount, 1);

    const switchingB = manager.switchToTab('b');
    flushRaf();
    assert.strictEqual(calls.fit, 0);
    assert.strictEqual(calls.focus, 0);

    resolveJoin('b');
    await switchingB;
    flushRaf();
    assert.strictEqual(calls.fit, 1);
    assert.strictEqual(calls.focus, 1);
  });

  it('fences an earlier switch when the same tab is selected again', async function () {
    const { manager, calls, resolveJoin, flushRaf } = buildHarness();

    const firstSwitch = manager.switchToTab('a');
    const secondSwitch = manager.switchToTab('a');

    resolveJoin('a', 0);
    await firstSwitch;
    assert.deepStrictEqual(calls.headers, []);

    resolveJoin('a', 1);
    await secondSwitch;
    flushRaf();

    assert.deepStrictEqual(calls.headers, ['a']);
    assert.strictEqual(calls.fit, 1);
    assert.strictEqual(calls.focus, 1);
  });

  it('requires the active tab to remain selected after the join', async function () {
    const { manager, calls, resolveJoin, flushRaf } = buildHarness(['a']);

    const switching = manager.switchToTab('a');
    manager.closeSession('a', { skipServerRequest: true, skipConfirmation: true });
    resolveJoin('a');
    await switching;
    flushRaf();

    assert.strictEqual(manager.activeTabId, null);
    assert.deepStrictEqual(calls.headers, []);
    assert.strictEqual(calls.fit, 0);
    assert.strictEqual(calls.focus, 0);
  });

  it('does not invalidate a real switch for an unknown tab request', async function () {
    const { manager, calls, resolveJoin, flushRaf } = buildHarness();

    const switching = manager.switchToTab('a');
    const generation = manager._switchGeneration;
    await manager.switchToTab('missing');
    assert.strictEqual(manager._switchGeneration, generation);

    resolveJoin('a');
    await switching;
    flushRaf();
    assert.deepStrictEqual(calls.headers, ['a']);
    assert.strictEqual(calls.fit, 1);
    assert.strictEqual(calls.focus, 1);
  });
});
