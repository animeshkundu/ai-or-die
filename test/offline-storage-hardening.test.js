const assert = require('assert');
const fs = require('fs');
const path = require('path');

function mockElement() {
  return {
    style: {},
    textContent: '',
    innerHTML: '',
    appendChild() {},
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

global.window = global.window || {};
global.document = global.document || {
  hidden: false,
  createElement() { return mockElement(); },
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  head: { appendChild() {} },
  body: { appendChild() {} },
};
global.requestAnimationFrame = global.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
global.WebSocket = global.WebSocket || { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
global.navigator = global.navigator || {};
global.localStorage = global.localStorage || {
  getItem() { return null; },
  setItem() {},
};

const { ClaudeCodeWebInterface } = require('../src/public/app');

function createApp() {
  const app = Object.create(ClaudeCodeWebInterface.prototype);
  app.socket = null;
  return app;
}

describe('offline shell and storage hardening', function () {
  const publicDir = path.join(__dirname, '..', 'src', 'public');

  it('falls back to cached sessions when session list fetch fails', async function () {
    const app = createApp();
    const cached = [{ id: 'cached-1', name: 'Cached Session' }];
    let renderCount = 0;
    app.authFetch = async () => { throw new Error('offline'); };
    app._getCachedSessions = () => cached;
    app.renderSessionList = () => { renderCount++; };

    await app.loadSessions();

    assert.deepStrictEqual(app.claudeSessions, cached);
    assert.strictEqual(renderCount, 1);
  });

  it('shows offline waiting state when browser emits offline event', function () {
    const app = createApp();
    const listeners = {};
    let status = null;
    let waitingMessage = null;
    const previousAddEventListener = window.addEventListener;
    window.addEventListener = (event, handler) => { listeners[event] = handler; };
    app.updateStatus = (next) => { status = next; };
    app.showConnectionWaiting = (message) => { waitingMessage = message; };

    app.setupConnectivityHandlers();
    listeners.offline();

    window.addEventListener = previousAddEventListener;
    assert.strictEqual(status, 'Offline');
    assert.strictEqual(waitingMessage, 'You are offline. We will reconnect automatically when your network is back.');
  });

  it('reconnects immediately on online event when socket is not open', function () {
    const app = createApp();
    const listeners = {};
    let waitingMessage = null;
    let reconnectArgs = null;
    const previousAddEventListener = window.addEventListener;
    window.addEventListener = (event, handler) => { listeners[event] = handler; };
    app.socket = { readyState: WebSocket.CLOSED };
    app.showConnectionWaiting = (message) => { waitingMessage = message; };
    app.reconnect = (reason, delayMs) => { reconnectArgs = { reason, delayMs }; };
    app.updateStatus = () => {};
    app.hideOverlay = () => {};

    app.setupConnectivityHandlers();
    listeners.online();

    window.addEventListener = previousAddEventListener;
    assert.strictEqual(waitingMessage, 'Back online. Reconnecting to server...');
    assert.deepStrictEqual(reconnectArgs, { reason: 'online', delayMs: 0 });
  });

  it('requests persistent storage once and stores completion marker', async function () {
    const app = createApp();
    const storageState = {};
    let persistedCalls = 0;
    let persistCalls = 0;
    const previousStorage = navigator.storage;
    const previousLocalStorage = global.localStorage;

    navigator.storage = {
      async persisted() {
        persistedCalls++;
        return false;
      },
      async persist() {
        persistCalls++;
      }
    };
    global.localStorage = {
      getItem(key) {
        return storageState[key] || null;
      },
      setItem(key, value) {
        storageState[key] = value;
      }
    };

    await app.requestPersistentStorage();

    navigator.storage = previousStorage;
    global.localStorage = previousLocalStorage;
    assert.strictEqual(persistedCalls, 1);
    assert.strictEqual(persistCalls, 1);
    assert.strictEqual(storageState['cc-web-storage-persist-requested'], '1');
  });

  it('skips persist call after marker is already present', async function () {
    const app = createApp();
    let persistCalls = 0;
    const previousStorage = navigator.storage;
    const previousLocalStorage = global.localStorage;

    navigator.storage = {
      async persisted() {
        return false;
      },
      async persist() {
        persistCalls++;
      }
    };
    global.localStorage = {
      getItem(key) {
        if (key === 'cc-web-storage-persist-requested') return '1';
        return null;
      },
      setItem() {}
    };

    await app.requestPersistentStorage();

    navigator.storage = previousStorage;
    global.localStorage = previousLocalStorage;
    assert.strictEqual(persistCalls, 0);
  });

  it('service worker keeps cached shell fallback for navigation requests', function () {
    const sw = fs.readFileSync(path.join(publicDir, 'service-worker.js'), 'utf8');
    assert.ok(sw.includes("if (request.mode === 'navigate')"), 'service worker must detect navigation requests');
    assert.ok(sw.includes("return caches.match('/index.html');"), 'service worker must return cached app shell while offline');
  });

  it('service worker returns explicit 503 JSON for offline API requests', function () {
    const sw = fs.readFileSync(path.join(publicDir, 'service-worker.js'), 'utf8');
    assert.ok(sw.includes("status: 503"), 'service worker must return 503 for offline API responses');
    assert.ok(sw.includes('You are offline. Reconnect, then retry this action.'), 'service worker must include offline API guidance');
  });
});
