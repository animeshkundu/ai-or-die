// Tests for the per-session Map cleanup wired into the
// `session_deleted` WebSocket message handler in src/public/app.js.
//
// Production issue (long-running ai-or-die tabs, weeks of uptime, many
// session create/delete cycles): four supporting Maps keyed by
// sessionId — `_sessionWorkingDirs`, `_liveCwd`, `_repoRootCache`,
// `_repoRootInFlight` — were never garbage-collected on session
// deletion, drifting memory upward. The handler now drops the key
// from all four Maps. This suite asserts that contract.
//
// Approach: ClaudeCodeWebInterface is a global class declared in
// src/public/app.js without a module export, and its constructor
// touches `window`, async timers, and an async `init()` that calls
// `window.authManager.initialize()` — heavy to stand up. Following
// the precedent in test/monaco-worker-shim.test.js, we evaluate the
// source in a sandboxed Node `vm` context with minimal browser-shape
// stubs that prevent the constructor and the bottom
// `DOMContentLoaded` registration from running, then directly invoke
// the prototype's `handleMessage` method against a fake `this`.
//
// Cross-platform note (CLAUDE.md Windows-first): test uses sessionId
// strings only — no filesystem paths — so it runs identically on
// Windows / macOS / Linux CI.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------------------
// Load ClaudeCodeWebInterface into a sandbox so the prototype is reachable
// without invoking the constructor (which would call window.authManager,
// register beforeinstallprompt listeners, kick off async init, etc).
// ---------------------------------------------------------------------------

function loadAppClass() {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/public/app.js'),
    'utf8'
  );

  // Minimal browser-shape sandbox. Constructor is never called; we only
  // need the source to parse + the bottom DOMContentLoaded listener to
  // register harmlessly (our document.addEventListener swallows it).
  const noopFn = function () {};
  const noopEl = {
    classList: { add: noopFn, remove: noopFn, contains: () => false, toggle: noopFn },
    addEventListener: noopFn,
    appendChild: noopFn,
    setAttribute: noopFn,
    style: {},
    dataset: {},
  };
  const sandbox = {
    window: { addEventListener: noopFn, innerWidth: 1280 },
    document: {
      addEventListener: noopFn,
      createElement: () => noopEl,
      body: { appendChild: noopFn },
      head: { appendChild: noopFn },
    },
    navigator: { userAgent: '' },
    TextDecoder: TextDecoder,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    console: console,
  };
  vm.createContext(sandbox);
  // Bind self/globalThis so any `typeof X === 'undefined'` checks see something.
  vm.runInContext('var self = globalThis;', sandbox);
  // Re-expose the class onto the sandbox global so the host test can grab it.
  const exposed = src + '\n;globalThis.__ClaudeCodeWebInterface = ClaudeCodeWebInterface;';
  vm.runInContext(exposed, sandbox, { filename: 'app.js' });
  return sandbox.__ClaudeCodeWebInterface;
}

// ---------------------------------------------------------------------------
// Fake-app harness: mimics just the surface the session_deleted handler
// reads / writes. No real DOM, no real sessionTabManager — we want the
// test to fail loudly if the handler regresses on any of the four Maps.
// ---------------------------------------------------------------------------

function makeFakeApp() {
  const calls = {
    showError: [],
    updateSessionButton: [],
    closeSession: [],
    loadSessions: 0,
    clearUserDeletion: [],
  };
  return {
    calls,
    // Maps under test — pre-populated by each test case.
    _sessionWorkingDirs: new Map(),
    _liveCwd: new Map(),
    _repoRootCache: new Map(),
    _repoRootInFlight: new Map(),
    // Other state the handler touches.
    currentClaudeSessionId: null,
    currentClaudeSessionName: null,
    claudeSessions: [],
    // Stubs.
    sessionTabManager: {
      isUserDeletion: () => true,            // user-initiated path — no error toast
      clearUserDeletion(id) { calls.clearUserDeletion.push(id); },
      closeSession(id, opts) { calls.closeSession.push({ id, opts }); },
    },
    showError(msg) { calls.showError.push(msg); },
    updateSessionButton(label) { calls.updateSessionButton.push(label); },
    loadSessions() { calls.loadSessions++; },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('handleMessage(session_deleted) — per-session Map cleanup', function () {
  let ClaudeCodeWebInterface;
  let handleMessage;

  before(function () {
    ClaudeCodeWebInterface = loadAppClass();
    assert.strictEqual(
      typeof ClaudeCodeWebInterface, 'function',
      'sandbox must expose the ClaudeCodeWebInterface class'
    );
    handleMessage = ClaudeCodeWebInterface.prototype.handleMessage;
    assert.strictEqual(
      typeof handleMessage, 'function',
      'prototype.handleMessage must be a function'
    );
  });

  it('drops the sessionId from all four supporting Maps', function () {
    const app = makeFakeApp();
    const sid = 'sess-cleanup-target';
    const otherSid = 'sess-keep';

    // Populate all four Maps with both the target sid and an unrelated sid.
    app._sessionWorkingDirs.set(sid, '/proj/A');
    app._sessionWorkingDirs.set(otherSid, '/proj/B');
    app._liveCwd.set(sid, '/proj/A/src');
    app._liveCwd.set(otherSid, '/proj/B/src');
    app._repoRootCache.set(sid, '/proj/A');
    app._repoRootCache.set(otherSid, '/proj/B');
    app._repoRootInFlight.set(sid, Promise.resolve(null));
    app._repoRootInFlight.set(otherSid, Promise.resolve(null));

    handleMessage.call(app, { type: 'session_deleted', sessionId: sid });

    // Target sid gone from every Map.
    assert.strictEqual(app._sessionWorkingDirs.has(sid), false,
      '_sessionWorkingDirs must drop the deleted sessionId');
    assert.strictEqual(app._liveCwd.has(sid), false,
      '_liveCwd must drop the deleted sessionId');
    assert.strictEqual(app._repoRootCache.has(sid), false,
      '_repoRootCache must drop the deleted sessionId');
    assert.strictEqual(app._repoRootInFlight.has(sid), false,
      '_repoRootInFlight must drop the deleted sessionId');

    // Unrelated sid untouched — per-session isolation, not a full Map.clear().
    assert.strictEqual(app._sessionWorkingDirs.get(otherSid), '/proj/B',
      'unrelated session must be preserved in _sessionWorkingDirs');
    assert.strictEqual(app._liveCwd.get(otherSid), '/proj/B/src',
      'unrelated session must be preserved in _liveCwd');
    assert.strictEqual(app._repoRootCache.get(otherSid), '/proj/B',
      'unrelated session must be preserved in _repoRootCache');
    assert.strictEqual(app._repoRootInFlight.has(otherSid), true,
      'unrelated session must be preserved in _repoRootInFlight');
  });

  it('is defensive against missing Maps (lazy-init Maps absent on cleanup)', function () {
    // _repoRootCache / _repoRootInFlight are lazy-initialised inside
    // _getRepoRootCached(); a session deleted before any link click in
    // it will hit the handler with those Maps still undefined. Handler
    // must not throw.
    const app = makeFakeApp();
    app._repoRootCache = undefined;
    app._repoRootInFlight = undefined;
    const sid = 'sess-Y';
    app._sessionWorkingDirs.set(sid, '/y');
    app._liveCwd.set(sid, '/y/sub');

    assert.doesNotThrow(() => {
      handleMessage.call(app, { type: 'session_deleted', sessionId: sid });
    });
    assert.strictEqual(app._sessionWorkingDirs.has(sid), false);
    assert.strictEqual(app._liveCwd.has(sid), false);
  });

  it('is a no-op on the Maps when message.sessionId is missing', function () {
    // Server-side anomaly: a session_deleted frame without sessionId.
    // The Map cleanup is gated behind `if (deletedId)` so nothing
    // should be dropped — guards against an accidental Map.clear() if
    // the gate is removed in a future refactor.
    const app = makeFakeApp();
    app._sessionWorkingDirs.set('sess-A', '/a');
    app._liveCwd.set('sess-A', '/a/sub');
    app._repoRootCache.set('sess-A', '/a');
    app._repoRootInFlight.set('sess-A', Promise.resolve(null));

    handleMessage.call(app, { type: 'session_deleted' /* no sessionId */ });

    assert.strictEqual(app._sessionWorkingDirs.has('sess-A'), true);
    assert.strictEqual(app._liveCwd.has('sess-A'), true);
    assert.strictEqual(app._repoRootCache.has('sess-A'), true);
    assert.strictEqual(app._repoRootInFlight.has('sess-A'), true);
  });
});
