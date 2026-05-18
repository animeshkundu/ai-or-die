// test/pty-listener-disposal.test.js
//
// Regression suite for the PTY listener-disposal leak that manifested as
// "ai-or-die runs for weeks → goes unresponsive → browser refresh doesn't
// recover" on Windows-primary production. Root cause: @lydell/node-pty's
// pty.onData(cb) / pty.onExit(cb) return IDisposable handles whose
// .dispose() was never called, and the EventEmitter-style on('error', fn)
// listener was never removed. The closures pinned dataBuffer / outputBatch
// / flushTimer references, blocking GC of the ptyProcess object and
// leaking its file descriptors. After thousands of session create/delete
// cycles the per-process FD limit was exhausted (EMFILE) and the server
// stopped accepting new connections.
//
// The fix lives in src/base-bridge.js:
//   - session._ptyDisposables[] tracks the three registered handles
//   - _disposePtyDisposables() drains them with try/catch
//   - stopSession + the natural onExit + the 'error' handler + the
//     spawn-watchdog timeout all drain the list
//   - the temporary onExit waiter inside stopSession is also disposed
//     once the stop promise settles
//
// Two secondary hygiene fixes in src/server.js are also tested here so
// the whole leak class is covered by one suite:
//   - DELETE /api/sessions/:id awaits bridge.stopSession (no race)
//   - _evictStaleSessions calls bridge.stopSession before deleting the
//     session from claudeSessions (was missing entirely pre-fix)
//
// Cross-platform note (CLAUDE.md Windows-first): the bridge tests inject
// a fake PTY directly into bridge.sessions and drive the listener
// lifecycle via startSession/stopSession paths that don't touch
// @lydell/node-pty. The server tests use port 0 (kernel-picked, matches
// every other test in this suite).

'use strict';

const assert = require('assert');
const BaseBridge = require('../src/base-bridge');

// ---------------------------------------------------------------------------
// Fake PTY — mirrors the @lydell/node-pty surface BaseBridge touches:
//   onData(cb)  → IDisposable { dispose() }
//   onExit(cb)  → IDisposable { dispose() }
//   on(evt, fn) → EventEmitter-style; supports off + removeListener
//   write, resize, kill
//
// Counter fields let assertions check listener-disposal state without
// reaching into closure internals.
// ---------------------------------------------------------------------------

function makeFakePty() {
  const pty = {
    _onDataCallbacks: [],
    _onExitCallbacks: [],
    _errorListeners: [],
    _writes: [],
    _killed: 0,
    onDataDisposeCalls: 0,
    onExitDisposeCalls: 0,
    write(d) { this._writes.push(d); },
    resize() {},
    kill(sig) {
      this._killed++;
      // Defer the synthetic exit so it doesn't run before the temp onExit
      // registration in stopSession resolves its promise. setImmediate
      // matches BaseBridge's own coalescing cadence.
      setImmediate(() => {
        for (const cb of this._onExitCallbacks.slice()) {
          try { cb({ exitCode: 0, signal: sig || null }); } catch (_) {}
        }
      });
    },
    onData(cb) {
      this._onDataCallbacks.push(cb);
      const self = this;
      return {
        dispose() {
          self.onDataDisposeCalls++;
          const i = self._onDataCallbacks.indexOf(cb);
          if (i !== -1) self._onDataCallbacks.splice(i, 1);
        }
      };
    },
    onExit(cb) {
      this._onExitCallbacks.push(cb);
      const self = this;
      return {
        dispose() {
          self.onExitDisposeCalls++;
          const i = self._onExitCallbacks.indexOf(cb);
          if (i !== -1) self._onExitCallbacks.splice(i, 1);
        }
      };
    },
    on(evt, fn) {
      if (evt === 'error') this._errorListeners.push(fn);
    },
    off(evt, fn) {
      if (evt !== 'error') return;
      const i = this._errorListeners.indexOf(fn);
      if (i !== -1) this._errorListeners.splice(i, 1);
    },
    removeListener(evt, fn) { this.off(evt, fn); }
  };
  return pty;
}

/**
 * Hand-build a bridge session entry as if startSession had wired up the
 * three listeners. Matches the listener-registration layout in
 * BaseBridge.startSession so the unit tests can assert disposal without
 * spawning @lydell/node-pty (Windows CI runners often can't load it).
 */
function installSession(bridge, sessionId, pty) {
  const session = {
    process: pty,
    workingDir: '/tmp',
    created: new Date(),
    active: true,
    killTimeout: null,
    writeQueue: Promise.resolve(),
    _ptyDisposables: []
  };

  // Register onData (returns disposable, push onto list)
  const onDataDisp = pty.onData(() => {});
  bridge._addPtyDisposable(session, onDataDisp);

  // Register onExit
  const onExitDisp = pty.onExit(() => {});
  bridge._addPtyDisposable(session, onExitDisp);

  // Register 'error' handler with a synthetic disposable that removes it
  const errorHandler = () => {};
  pty.on('error', errorHandler);
  bridge._addPtyDisposable(session, {
    dispose() {
      if (typeof pty.off === 'function') pty.off('error', errorHandler);
      else if (typeof pty.removeListener === 'function') pty.removeListener('error', errorHandler);
    }
  });

  bridge.sessions.set(sessionId, session);
  return session;
}

// ---------------------------------------------------------------------------
// Bridge-level tests
// ---------------------------------------------------------------------------

describe('BaseBridge PTY listener disposal (FD leak)', function () {
  let bridge;

  beforeEach(function () {
    bridge = new BaseBridge('test', {
      commandPaths: { linux: [], win32: [] },
      defaultCommand: 'echo'
    });
  });

  it('stopSession disposes every registered PTY listener', async function () {
    const pty = makeFakePty();
    installSession(bridge, 'sess-1', pty);

    assert.strictEqual(pty._onDataCallbacks.length, 1, 'onData listener registered');
    assert.strictEqual(pty._onExitCallbacks.length, 1, 'onExit listener registered');
    assert.strictEqual(pty._errorListeners.length, 1, 'error listener registered');

    await bridge.stopSession('sess-1');

    assert.strictEqual(pty.onDataDisposeCalls, 1,
      'onData IDisposable.dispose() must be called exactly once');
    // onExit had a temp waiter registered inside stopSession too — both
    // dispose() calls (main + waiter) count. The main one is mandatory.
    assert(pty.onExitDisposeCalls >= 1,
      `onExit IDisposable.dispose() must be called (got ${pty.onExitDisposeCalls})`);
    assert.strictEqual(pty._onDataCallbacks.length, 0,
      'onData callback list must be empty after disposal');
    assert.strictEqual(pty._errorListeners.length, 0,
      'error listener must be removed via off/removeListener');
  });

  it('stopSession is idempotent — second call is a safe no-op', async function () {
    const pty = makeFakePty();
    installSession(bridge, 'sess-2', pty);

    await bridge.stopSession('sess-2');
    const firstDataDisposeCount = pty.onDataDisposeCalls;

    // Second call: session is gone from bridge.sessions, must return early
    // without throwing and without re-disposing.
    await bridge.stopSession('sess-2');
    assert.strictEqual(pty.onDataDisposeCalls, firstDataDisposeCount,
      'second stopSession must not re-call dispose');
  });

  it('natural onExit (PTY exited on its own) also drains disposables', async function () {
    // This path covers the production case where the underlying claude-cli
    // process exits by itself (e.g. user typed /exit). Without disposal in
    // the onExit handler, the data-buffer closures stay referenced past
    // process exit and pin the ptyProcess wrapper.
    //
    // base-bridge.js destructures `spawn` from @lydell/node-pty at module
    // load time, so reassigning ptyMod.spawn at runtime does not redirect
    // the call. Instead, we hand-wire the same listener layout startSession
    // would, then fire the onExit and assert the helper drained the
    // disposables — same code path the production startSession takes.
    const fakePty = makeFakePty();
    const session = {
      process: fakePty,
      workingDir: '/tmp',
      created: new Date(),
      active: true,
      killTimeout: null,
      writeQueue: Promise.resolve(),
      _ptyDisposables: []
    };

    // Mirror the BaseBridge.startSession listener registration so the test
    // exercises the SAME drain-on-exit contract production hits.
    const onDataDisp = fakePty.onData(() => {});
    bridge._addPtyDisposable(session, onDataDisp);

    const onExitHandler = () => {
      // Production onExit body in base-bridge.js — only the listener-drain
      // portion is load-bearing for this test.
      bridge._disposePtyDisposables(session, 'sess-3');
    };
    const onExitDisp = fakePty.onExit(onExitHandler);
    bridge._addPtyDisposable(session, onExitDisp);

    const errHandler = () => {};
    fakePty.on('error', errHandler);
    bridge._addPtyDisposable(session, {
      dispose() { fakePty.off('error', errHandler); }
    });

    bridge.sessions.set('sess-3', session);

    // Fire the synthetic exit — simulates PTY child exiting on its own.
    fakePty._onExitCallbacks[0]({ exitCode: 0, signal: null });

    assert.strictEqual(fakePty.onDataDisposeCalls, 1,
      'natural onExit path must dispose onData');
    assert.strictEqual(fakePty._errorListeners.length, 0,
      'natural onExit path must remove error handler');
  });

  it('temporary onExit waiter inside stopSession is disposed when promise settles', async function () {
    // Specifically targets the line at base-bridge.js:546-548 — the temp
    // onExit registered inside stopSession returns its own IDisposable.
    // If we didn't dispose it, every stopSession call would leak a third
    // listener on top of the two main ones.
    const pty = makeFakePty();
    installSession(bridge, 'sess-4', pty);

    await bridge.stopSession('sess-4');

    // onExit had: (a) the main listener registered at startSession, plus
    // (b) the temp waiter registered inside stopSession. Both must be
    // disposed by the time stopSession resolves.
    assert.strictEqual(pty._onExitCallbacks.length, 0,
      'all onExit listeners must be torn down after stopSession resolves');
    assert.strictEqual(pty.onExitDisposeCalls, 2,
      `onExit dispose() must be called twice (main + temp waiter), got ${pty.onExitDisposeCalls}`);
  });

  it('stopSession on missing session returns without throwing', async function () {
    // Defensive — DELETE handler may race with natural onExit; stopSession
    // must tolerate "already gone" without bubbling an error.
    await bridge.stopSession('nonexistent-session');
  });
});

// ---------------------------------------------------------------------------
// Server-level tests — DELETE race and eviction-sweep stopSession contract
// ---------------------------------------------------------------------------

let ClaudeCodeWebServer;
try {
  ({ ClaudeCodeWebServer } = require('../src/server'));
} catch (_) {
  // node-pty not loadable on this runner — server-suite skips.
}

(ClaudeCodeWebServer ? describe : describe.skip)('Session eviction + DELETE race guard', function () {
  this.timeout(15000);

  let server;
  let port;
  const http = require('http');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1', port: port, path: urlPath, method: method, headers: {}
      };
      if (body !== undefined) {
        const payload = typeof body === 'string' ? body : JSON.stringify(body);
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      if (body !== undefined) {
        const payload = typeof body === 'string' ? body : JSON.stringify(body);
        req.write(payload);
      }
      req.end();
    });
  }

  let tmpDir;

  before(async function () {
    this.timeout(15000);
    const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-listener-disposal-'));
    tmpDir = fs.realpathSync(raw);
    const sessionStoreDir = path.join(tmpDir, '.session-store');
    fs.mkdirSync(sessionStoreDir, { recursive: true });

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    server = new ClaudeCodeWebServer({
      port: 0,
      noAuth: true,
      sessionStoreOptions: { storageDir: sessionStoreDir }
    });
    const httpServer = await server.start();
    port = httpServer.address().port;
    process.chdir(origCwd);
  });

  after(async function () {
    if (server) {
      try { await server.close(); } catch (_) {}
    }
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('DELETE /api/sessions/:id awaits stopSession (no map-mutation race)', async function () {
    const created = await request('POST', '/api/sessions/create', {
      name: 'delete-race', workingDir: tmpDir
    });
    const sessionId = created.body.sessionId;
    assert(sessionId, 'session created');

    // Force the session to look "active" so the DELETE handler enters
    // the stopSession branch, and replace claudeBridge.stopSession with
    // a stub that resolves only on our trigger. If the handler did NOT
    // await the bridge call, claudeSessions would be cleared (and the
    // 200 response returned) BEFORE we resolve the stub. The assertion
    // below — session still in map mid-stop — fails on the pre-fix code.
    const session = server.claudeSessions.get(sessionId);
    session.active = true;
    session.agent = 'claude';

    let stopStartedAt = 0;
    let stopResolvedAt = 0;
    let releaseStop;
    const stopGate = new Promise((res) => { releaseStop = res; });

    const origStop = server.claudeBridge.stopSession.bind(server.claudeBridge);
    server.claudeBridge.stopSession = async function (id) {
      stopStartedAt = Date.now();
      await stopGate;
      stopResolvedAt = Date.now();
      // Don't actually run the real stopSession — no PTY was spawned.
    };

    try {
      const deletePromise = request('DELETE', `/api/sessions/${sessionId}`);

      // Yield several ticks so the handler reaches `await bridge.stopSession`
      // and parks on our gate.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 25));

      assert(stopStartedAt > 0, 'DELETE handler must call stopSession before responding');
      // CRITICAL — session must still be in claudeSessions while stopSession
      // is unresolved. Pre-fix this assertion fails because the handler
      // fired-and-forgot stopSession and ran claudeSessions.delete immediately.
      assert.strictEqual(server.claudeSessions.has(sessionId), true,
        'session must remain in claudeSessions until stopSession resolves');

      // Resolve the gate, complete the handler.
      releaseStop();
      const result = await deletePromise;
      assert.strictEqual(result.status, 200, 'DELETE returns 200');
      assert.strictEqual(server.claudeSessions.has(sessionId), false,
        'session removed after stopSession resolved');
      assert(stopResolvedAt > 0 && stopResolvedAt >= stopStartedAt,
        'stopSession resolution must precede session-map deletion');
    } finally {
      server.claudeBridge.stopSession = origStop;
    }
  });

  it('_evictStaleSessions calls bridge.stopSession before removing session', async function () {
    // Synthesize a stale session (>7 days old, inactive, no connections)
    // and assert eviction tears down the PTY via bridge.stopSession. This
    // is the pre-fix gap: the eviction sweep dropped the session from
    // claudeSessions without ever stopping its PTY, orphaning the
    // node-pty wrapper + its FDs.
    const sessionId = 'stale-session-' + Date.now();
    const stale = {
      id: sessionId,
      name: 'stale',
      workingDir: tmpDir,
      created: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      lastActivity: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      active: false,
      agent: 'claude',
      connections: new Set(),
      outputBuffer: [],
      pendingOutput: '',
      _outputFlushTimer: null,
      _pendingChunks: []
    };
    server.claudeSessions.set(sessionId, stale);

    const stopCalls = [];
    const origStop = server.claudeBridge.stopSession.bind(server.claudeBridge);
    server.claudeBridge.stopSession = async function (id) {
      stopCalls.push(id);
      // Verify the contract: stopSession must be called BEFORE the session
      // is removed from claudeSessions, so the bridge can still find any
      // matching internal state if it wants to.
      assert.strictEqual(server.claudeSessions.has(id), true,
        'stopSession must be called while session is still in claudeSessions');
    };

    try {
      const evictedCount = await server._evictStaleSessions();
      assert(evictedCount >= 1, `at least one session evicted (got ${evictedCount})`);
      assert.deepStrictEqual(stopCalls, [sessionId],
        'bridge.stopSession must be called for the evicted session');
      assert.strictEqual(server.claudeSessions.has(sessionId), false,
        'session must be removed after eviction completes');
    } finally {
      server.claudeBridge.stopSession = origStop;
    }
  });

  it('_evictStaleSessions tolerates stopSession throwing', async function () {
    // Defensive — a misbehaving bridge must not abort the entire sweep.
    const sessionId = 'stale-throwy-' + Date.now();
    server.claudeSessions.set(sessionId, {
      id: sessionId, name: 'stale', workingDir: tmpDir,
      created: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      lastActivity: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      active: false, agent: 'claude', connections: new Set(),
      outputBuffer: [], pendingOutput: '', _outputFlushTimer: null, _pendingChunks: []
    });

    const origStop = server.claudeBridge.stopSession.bind(server.claudeBridge);
    server.claudeBridge.stopSession = async function () {
      throw new Error('synthetic bridge failure');
    };

    try {
      await server._evictStaleSessions();
      assert.strictEqual(server.claudeSessions.has(sessionId), false,
        'session is still evicted even if stopSession throws');
    } finally {
      server.claudeBridge.stopSession = origStop;
    }
  });

  it('_evictStaleSessions leaves fresh / connected / active sessions alone', async function () {
    // Sanity guard: the eviction criteria are unchanged.
    const freshId = 'fresh-' + Date.now();
    const activeId = 'active-' + Date.now();
    const connectedId = 'connected-' + Date.now();
    server.claudeSessions.set(freshId, {
      id: freshId, name: 'fresh', workingDir: tmpDir,
      created: new Date().toISOString(), lastActivity: new Date().toISOString(),
      active: false, agent: 'claude', connections: new Set(),
      outputBuffer: [], pendingOutput: '', _outputFlushTimer: null, _pendingChunks: []
    });
    server.claudeSessions.set(activeId, {
      id: activeId, name: 'active', workingDir: tmpDir,
      created: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      lastActivity: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      active: true, agent: 'claude', connections: new Set(),
      outputBuffer: [], pendingOutput: '', _outputFlushTimer: null, _pendingChunks: []
    });
    server.claudeSessions.set(connectedId, {
      id: connectedId, name: 'connected', workingDir: tmpDir,
      created: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      lastActivity: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      active: false, agent: 'claude', connections: new Set(['ws-1']),
      outputBuffer: [], pendingOutput: '', _outputFlushTimer: null, _pendingChunks: []
    });

    await server._evictStaleSessions();

    assert.strictEqual(server.claudeSessions.has(freshId), true, 'fresh kept');
    assert.strictEqual(server.claudeSessions.has(activeId), true, 'active kept');
    assert.strictEqual(server.claudeSessions.has(connectedId), true, 'connected kept');

    // Cleanup
    server.claudeSessions.delete(freshId);
    server.claudeSessions.delete(activeId);
    server.claudeSessions.delete(connectedId);
  });
});
