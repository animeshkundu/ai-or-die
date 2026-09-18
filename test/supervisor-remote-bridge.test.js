'use strict';

// SupervisorProxy (child side) + Supervisor request handlers (parent side):
// the IPC bridge that makes /api/update/* work in the real supervised
// topology (parent Supervisor process + child Server process), where the
// child can never hold the Supervisor object directly.

const assert = require('assert');
const EventEmitter = require('events');
const express = require('express');
const http = require('http');
const { SupervisorProxy } = require('../src/supervisor/remote-bridge');
const { Supervisor } = require('../src/supervisor/index');
const { createUpdateRouter } = require('../src/supervisor/update-routes');
const ipc = require('../src/supervisor/ipc-protocol');

function fakeChannel() {
  // Loopback pair: childSend -> parent inbox; parentSend -> child inbox.
  const ch = {
    childInbox: [],
    parentInbox: [],
    childHandlers: [],
  };
  ch.childSend = (msg) => { ch.parentInbox.push(msg); };
  ch.parentSend = (msg) => {
    ch.childInbox.push(msg);
    for (const fn of ch.childHandlers) fn(msg);
  };
  ch.childOn = (event, fn) => { if (event === 'message') ch.childHandlers.push(fn); };
  ch.childOff = (event, fn) => {
    if (event === 'message') ch.childHandlers = ch.childHandlers.filter((f) => f !== fn);
  };
  return ch;
}

function stubSupervisor(overrides = {}) {
  const sup = Object.create(Supervisor.prototype);
  sup.autoUpdater = { check: async () => ({ checked: true, update: false }) };
  sup.applyUpdate = async () => ({ applied: false, reason: 'nothing_staged' });
  sup.updateStatus = () => ({
    currentVersion: '0.1.108', pending: null, idleMs: 1, supervisorPid: 111, serverPid: 222, ptys: 0,
  });
  sup.ptyManager = { register: () => null, confirmUnregister: () => 'unknown', reapServer: () => 0 };
  sup._shuttingDown = false;
  sup._scheduleRespawn = () => {};
  Object.assign(sup, overrides);
  return sup;
}

function fakeProc() {
  const proc = new EventEmitter();
  proc.sent = [];
  proc.send = function (msg) { this.sent.push(msg); };
  return proc;
}

describe('supervisor/remote-bridge (SupervisorProxy)', function () {
  it('resolves updateStatus through the channel', async function () {
    const ch = fakeChannel();
    const proxy = new SupervisorProxy({
      send: ch.childSend, on: ch.childOn, off: ch.childOff, isConnected: () => true,
    });
    try {
      const pending = proxy.updateStatus();
      assert.strictEqual(ch.parentInbox.length, 1);
      assert.strictEqual(ch.parentInbox[0].type, 'update_status_request');
      const id = ch.parentInbox[0].id;
      ch.parentSend({ type: 'update_status_response', id, ok: true, result: { ptys: 3 } });
      assert.deepStrictEqual(await pending, { ptys: 3 });
    } finally {
      proxy.dispose();
    }
  });

  it('resolves autoUpdater.check and applyUpdate through the channel', async function () {
    const ch = fakeChannel();
    const proxy = new SupervisorProxy({
      send: ch.childSend, on: ch.childOn, off: ch.childOff, isConnected: () => true,
    });
    try {
      const checkP = proxy.autoUpdater.check();
      ch.parentSend({ type: 'update_check_response', id: ch.parentInbox[0].id, ok: true, result: { checked: true } });
      assert.deepStrictEqual(await checkP, { checked: true });

      const applyP = proxy.applyUpdate();
      const applyReq = ch.parentInbox[ch.parentInbox.length - 1];
      assert.strictEqual(applyReq.type, 'update_apply_request');
      assert.ok(typeof applyReq.id !== 'undefined', 'apply carries an id (reply awaited)');
      ch.parentSend({ type: 'update_apply_response', id: applyReq.id, ok: true, result: { applied: true } });
      assert.deepStrictEqual(await applyP, { applied: true });
    } finally {
      proxy.dispose();
    }
  });

  it('rejects on supervisor-reported errors', async function () {
    const ch = fakeChannel();
    const proxy = new SupervisorProxy({
      send: ch.childSend, on: ch.childOn, off: ch.childOff, isConnected: () => true,
    });
    try {
      const pending = proxy.updateStatus();
      const id = ch.parentInbox[0].id;
      ch.parentSend({ type: 'update_status_response', id, ok: false, error: 'boom' });
      await assert.rejects(pending, /boom/);
    } finally {
      proxy.dispose();
    }
  });

  it('ignores stray frames (wrong id, wrong type, missing id)', async function () {
    const ch = fakeChannel();
    const proxy = new SupervisorProxy({
      send: ch.childSend, on: ch.childOn, off: ch.childOff, isConnected: () => true,
    });
    try {
      const pending = proxy.updateStatus();
      const id = ch.parentInbox[0].id;
      ch.parentSend({ type: 'update_status_response', id: id + 999, ok: true, result: {} });
      ch.parentSend({ type: 'update_check_response', id, ok: true, result: {} });
      ch.parentSend({ type: 'update_status_response', ok: true, result: {} });
      ch.parentSend({ type: 'pty_register', ptyId: 'x', pid: 1 });
      // Still pending: reply for real.
      ch.parentSend({ type: 'update_status_response', id, ok: true, result: { ok: true } });
      assert.deepStrictEqual(await pending, { ok: true });
    } finally {
      proxy.dispose();
    }
  });

  it('rejects immediately when the channel is down', async function () {
    const proxy = new SupervisorProxy({
      send: () => { throw new Error('closed'); },
      on: () => {},
      off: () => {},
      isConnected: () => false,
    });
    try {
      await assert.rejects(proxy.updateStatus(), /unreachable/);
      await assert.rejects(proxy.applyUpdate(), /unreachable/);
    } finally {
      proxy.dispose();
    }
  });

  it('rejects on timeout', async function () {
    const ch = fakeChannel();
    const proxy = new SupervisorProxy({
      send: ch.childSend, on: ch.childOn, off: ch.childOff, isConnected: () => true,
      timeoutMs: { status: 20, check: 20, apply: 20 },
    });
    try {
      await assert.rejects(proxy.updateStatus(), /timed out/);
    } finally {
      proxy.dispose();
    }
  });
});

describe('supervisor request handlers (parent side)', function () {
  it('answers update_status_request with updateStatus()', function () {
    const sup = stubSupervisor();
    const proc = fakeProc();
    sup._wireServerEvents({ proc, pid: 222 });
    proc.emit('message', { type: 'update_status_request', id: 7 });
    assert.strictEqual(proc.sent.length, 1);
    assert.strictEqual(proc.sent[0].type, 'update_status_response');
    assert.strictEqual(proc.sent[0].id, 7);
    assert.strictEqual(proc.sent[0].ok, true);
    assert.strictEqual(proc.sent[0].result.ptys, 0);
  });

  it('answers update_check_request with the check result', async function () {
    const sup = stubSupervisor({
      autoUpdater: { check: async () => ({ checked: true, update: true, version: '9.9.9' }) },
    });
    const proc = fakeProc();
    sup._wireServerEvents({ proc, pid: 222 });
    proc.emit('message', { type: 'update_check_request', id: 3 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(proc.sent.length, 1);
    assert.strictEqual(proc.sent[0].type, 'update_check_response');
    assert.strictEqual(proc.sent[0].result.version, '9.9.9');
  });

  it('answers update_apply_request WITH id (new child)', async function () {
    const sup = stubSupervisor({
      applyUpdate: async () => ({ applied: true, promoted: true, version: '9.9.9', ptys: 2 }),
    });
    const proc = fakeProc();
    sup._wireServerEvents({ proc, pid: 222 });
    proc.emit('message', { type: 'update_apply_request', id: 42 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(proc.sent.length, 1);
    assert.strictEqual(proc.sent[0].type, 'update_apply_response');
    assert.strictEqual(proc.sent[0].id, 42);
    assert.strictEqual(proc.sent[0].result.applied, true);
  });

  it('answers early via onPreShutdown while the old child lives, exactly once', async function () {
    let capturedOpts = null;
    let releaseApply;
    const applyGate = new Promise((r) => { releaseApply = r; });
    const sup = stubSupervisor({
      swapServer: undefined,
      applyUpdate: async (opts) => {
        capturedOpts = opts;
        assert.strictEqual(typeof opts.onPreShutdown, 'function', 'hook threaded through apply');
        // Simulate ServerManager: swap decided -> early answer -> shutdown -> resolve.
        await opts.onPreShutdown({ swapped: true, version: '9.9.9', ptys: 1, portTakeover: true });
        await applyGate;
        return { applied: true, promoted: true, version: '9.9.9', ptys: 1 };
      },
    });
    // Bypass AutoUpdater: point applyUpdate directly (already stubbed above).
    const proc = fakeProc();
    sup._wireServerEvents({ proc, pid: 222 });
    proc.emit('message', { type: 'update_apply_request', id: 77 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const early = proc.sent.filter((m) => m.type === 'update_apply_response');
    assert.strictEqual(early.length, 1, 'provisional answer sent while old lives');
    assert.strictEqual(early[0].id, 77);
    assert.strictEqual(early[0].result.applied, true);
    releaseApply();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(
      proc.sent.filter((m) => m.type === 'update_apply_response').length,
      1,
      'final result does not double-answer'
    );
  });

  it('keeps fire-and-forget for update_apply_request WITHOUT id (legacy child)', async function () {
    let applied = false;
    const sup = stubSupervisor({ applyUpdate: async () => { applied = true; return { applied: true }; } });
    const proc = fakeProc();
    sup._wireServerEvents({ proc, pid: 222 });
    proc.emit('message', { type: 'update_apply_request' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(applied, true);
    assert.strictEqual(proc.sent.length, 0, 'no reply without an id');
  });

  it('still swallows the post-handoff death rattle alongside new handlers', function () {
    const seen = [];
    const sup = stubSupervisor({
      ptyManager: {
        register: () => null,
        confirmUnregister: (id) => { seen.push(id); return 'ignored'; },
        reapServer: () => 0,
      },
    });
    const proc = fakeProc();
    sup._wireServerEvents({ proc, pid: 222 });
    proc.emit('message', { type: 'pty_unregister', ptyId: 'pty-1' });
    assert.deepStrictEqual(seen, ['pty-1']);
  });
});

describe('update-routes over SupervisorProxy (loopback)', function () {
  function serveProxy() {
    const ch = fakeChannel();
    // Pump runs inside send (not wrapped after construction — the proxy
    // captures the send reference once).
    const pump = () => {
      while (ch.parentInbox.length) {
        const req = ch.parentInbox.shift();
        if (req.type === 'update_status_request') {
          ch.parentSend(ipc.updateStatusResponse(req.id, true, { ptys: 2, pending: { version: '9.9.9' } }));
        } else if (req.type === 'update_apply_request') {
          ch.parentSend(ipc.updateApplyResponse(req.id, true, { applied: true, version: '9.9.9', ptys: 2 }));
        }
      }
    };
    const proxy = new SupervisorProxy({
      send: (msg) => { ch.childSend(msg); setImmediate(pump); },
      on: ch.childOn,
      off: ch.childOff,
      isConnected: () => true,
    });
    return proxy;
  }

  it('GET /status reports supervised:true through the proxy', async function () {
    const proxy = serveProxy();
    const app = express();
    app.use(express.json());
    app.use('/api/update', createUpdateRouter({ getSupervisor: () => proxy }));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const body = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/update/status' }, (res) => {
          let b = '';
          res.on('data', (d) => { b += d; });
          res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
        }).on('error', reject);
      });
      assert.strictEqual(body.status, 200);
      assert.strictEqual(body.json.supervised, true);
      assert.strictEqual(body.json.ptys, 2);
    } finally {
      server.close();
      proxy.dispose();
    }
  });

  it('POST /apply returns the swap result through the proxy', async function () {
    const proxy = serveProxy();
    const app = express();
    app.use(express.json());
    app.use('/api/update', createUpdateRouter({ getSupervisor: () => proxy }));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const body = await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port: server.address().port, path: '/api/update/apply', method: 'POST',
        }, (res) => {
          let b = '';
          res.on('data', (d) => { b += d; });
          res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.strictEqual(body.status, 200);
      assert.strictEqual(body.json.applied, true);
    } finally {
      server.close();
      proxy.dispose();
    }
  });
});
