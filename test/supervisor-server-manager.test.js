'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const { ServerManager } = require('../src/supervisor/server-manager');

function fakeProc() {
  const proc = new EventEmitter();
  proc.pid = 5000 + Math.floor(Math.random() * 1000);
  proc.killed = false;
  proc.connected = true;
  proc.sent = [];
  proc.send = function (msg) { this.sent.push(msg); };
  proc.kill = function () { this.killed = true; };
  return proc;
}

describe('supervisor/server-manager', function () {
  it('spawnServer resolves on READY', async function () {
    const proc = fakeProc();
    const mgr = new ServerManager({
      spawn: () => proc,
      readyTimeoutMs: 1000,
    });
    const pending = mgr.spawnServer('/bin/server');
    proc.emit('message', { type: 'ready', pid: proc.pid, version: '0.1.109' });
    const record = await pending;
    assert.strictEqual(record.version, '0.1.109');
  });

  it('spawnServer rejects when the child exits before READY', async function () {
    const proc = fakeProc();
    const mgr = new ServerManager({ spawn: () => proc, readyTimeoutMs: 1000 });
    const pending = mgr.spawnServer('/bin/server');
    proc.emit('exit', 1);
    await assert.rejects(pending, /exited before READY/);
  });

  it('swapServer rolls back when the new server never becomes READY', async function () {
    const oldProc = fakeProc();
    oldProc.pid = 100;
    const mgr = new ServerManager({
      spawn: () => fakeProc(), // new proc that never sends READY
      readyTimeoutMs: 20,
      handoffTimeoutMs: 20,
      shutdownGraceMs: 20,
    });
    mgr.current = { proc: oldProc, pid: 100, binary: '/bin/old' };
    const result = await mgr.swapServer('/bin/new');
    assert.strictEqual(result.swapped, false);
    assert.strictEqual(result.reason, 'spawn_failed');
    assert.strictEqual(mgr.current.proc, oldProc, 'old server stays live');
    assert.strictEqual(oldProc.killed, false, 'old server is not killed on rollback');
  });

  it('swapServer hands off PTYs and kills only the old server', async function () {
    const ptys = [{ ptyId: 'pty-1', bridgeType: 'claude', pid: 4242 }];
    const mgr = new ServerManager({
      ptyManager: {
        describeForHandoff: () => ptys,
        transferOwnership: () => ({ transferred: 1, failed: 0 }),
      },
      readyTimeoutMs: 1000,
      handoffTimeoutMs: 1000,
      shutdownGraceMs: 1000,
    });
    const oldProc = fakeProc();
    oldProc.pid = 100;
    oldProc.exitCode = null; // live ChildProcess reports null until exit
    mgr.current = { proc: oldProc, pid: 100, binary: '/bin/old' };

    const newProc = fakeProc();
    newProc.pid = 200;
    mgr._spawn = () => newProc;
    const origSpawn = mgr.spawnServer.bind(mgr);
    mgr.spawnServer = async () => ({ proc: newProc, pid: 200, binary: '/bin/new', version: '0.1.109' });
    mgr._requestHandoff = async () => true;
    mgr.gracefulShutdown = async () => true;

    const result = await mgr.swapServer('/bin/new');
    assert.strictEqual(result.swapped, true);
    assert.strictEqual(result.ptys, 1);
    assert.strictEqual(mgr.current.pid, 200);
    assert.strictEqual(newProc.killed, false, 'new server survives');
    assert.strictEqual(oldProc.killed, true, 'old server is torn down');
    void origSpawn;
  });

  it('portFromArgs/argsWithPort parse and rewrite --port/-p', function () {
    const { ServerManager: SM } = require('../src/supervisor/server-manager');
    assert.strictEqual(SM.portFromArgs(['--port', '11433']), 11433);
    assert.strictEqual(SM.portFromArgs(['-p', '7777']), 7777);
    assert.strictEqual(SM.portFromArgs([]), null);
    assert.strictEqual(SM.portFromArgs(['--port', 'bogus']), null);
    assert.deepStrictEqual(SM.argsWithPort(['--port', '11433'], 0), ['--port', '0']);
    assert.deepStrictEqual(SM.argsWithPort([], 0), ['--port', '0']);
    const original = ['--dev', '--port', '11433'];
    SM.argsWithPort(original, 0);
    assert.deepStrictEqual(original, ['--dev', '--port', '11433'], 'does not mutate input');
  });

  it('swapServer with a known port boots ephemeral then takes over', async function () {
    const sent = { old: [], new: [] };
    const oldProc = fakeProc();
    oldProc.pid = 100;
    oldProc.exitCode = null;
    oldProc.send = function (m) { sent.old.push(m); };
    const newProc = fakeProc();
    newProc.pid = 200;
    newProc.send = function (m) {
      sent.new.push(m);
      // Simulate the real server's IPC replies asynchronously.
      const reply = m.type === 'handoff_start' ? { type: 'handoff_complete', receivedPtys: 1 }
        : m.type === 'listen_port' ? { type: 'listen_port_ok', port: m.port }
        : null;
      if (reply) setImmediate(() => newProc.emit('message', reply));
    };
    const mgr = new ServerManager({
      ptyManager: {
        describeForHandoff: () => [{ ptyId: 'p', bridgeType: 't', pid: 9 }],
        transferOwnership: () => ({ transferred: 1, failed: 0 }),
      },
      readyTimeoutMs: 1000,
      handoffTimeoutMs: 1000,
      shutdownGraceMs: 50,
    });
    let spawnedArgs = null;
    mgr.spawnServer = async (bin, args) => {
      spawnedArgs = args;
      return { proc: newProc, pid: 200, binary: bin, version: '0.1.109' };
    };
    // Old server replies port_released to release_port.
    const origSend = oldProc.send.bind(oldProc);
    oldProc.send = function (m) {
      origSend(m);
      if (m.type === 'release_port') setImmediate(() => oldProc.emit('message', { type: 'port_released' }));
      if (m.type === 'shutdown') setImmediate(() => oldProc.emit('message', { type: 'shutdown_complete', savedSessions: true }));
    };
    mgr.current = { proc: oldProc, pid: 100, binary: '/bin/old' };

    const result = await mgr.swapServer('/bin/new', ['--port', '11433'], {});
    assert.strictEqual(result.swapped, true);
    assert.strictEqual(result.portTakeover, true);
    assert.deepStrictEqual(spawnedArgs, ['--port', '0'], 'candidate boots ephemeral');
    assert.ok(sent.old.some((m) => m.type === 'release_port'), 'old releases the port');
    assert.ok(sent.new.some((m) => m.type === 'listen_port' && m.port === 11433), 'new binds the real port');
    assert.strictEqual(mgr.current.pid, 200);
  });

  it('swapServer rolls back cleanly when port release fails', async function () {
    const newProc = fakeProc();
    newProc.pid = 200;
    const oldProc = fakeProc();
    oldProc.pid = 100;
    oldProc.exitCode = null;
    const mgr = new ServerManager({
      ptyManager: { describeForHandoff: () => [], transferOwnership: () => ({ transferred: 0, failed: 0 }) },
      readyTimeoutMs: 1000,
      handoffTimeoutMs: 1000,
      shutdownGraceMs: 50,
    });
    mgr.spawnServer = async (bin) => ({ proc: newProc, pid: 200, binary: bin, version: 'x' });
    mgr._requestHandoff = async () => true;
    mgr.current = { proc: oldProc, pid: 100, binary: '/bin/old' };
    // Fail the release_port round-trip without waiting the 10s timeout.
    const origRequest = mgr._request.bind(mgr);
    mgr._request = (record, msg, okType, timeout) => {
      if (msg && msg.type === 'release_port') return Promise.resolve(false);
      return origRequest(record, msg, okType, timeout);
    };
    const result = await mgr.swapServer('/bin/new', ['--port', '11433'], {});
    assert.strictEqual(result.swapped, false);
    assert.strictEqual(result.reason, 'release_failed');
    assert.strictEqual(newProc.killed, true, 'failed candidate is reaped');
    assert.strictEqual(mgr.current.pid, 100, 'old server stays live');
    assert.strictEqual(oldProc.killed, false, 'old server untouched');
  });

  it('swapServer re-binds old when takeover fails', async function () {
    const oldSent = [];
    const newProc = fakeProc();
    newProc.pid = 200;
    newProc.send = function () { /* never replies to listen_port */ };
    const oldProc = fakeProc();
    oldProc.pid = 100;
    oldProc.exitCode = null;
    oldProc.send = function (m) {
      oldSent.push(m);
      if (m.type === 'release_port') setImmediate(() => oldProc.emit('message', { type: 'port_released' }));
    };
    const mgr = new ServerManager({
      ptyManager: { describeForHandoff: () => [], transferOwnership: () => ({ transferred: 0, failed: 0 }) },
      readyTimeoutMs: 1000,
      handoffTimeoutMs: 1000,
      shutdownGraceMs: 50,
    });
    mgr.spawnServer = async (bin) => ({ proc: newProc, pid: 200, binary: bin, version: 'x' });
    mgr._requestHandoff = async () => true;
    mgr.current = { proc: oldProc, pid: 100, binary: '/bin/old' };
    // Force the listen_port round-trip to fail without waiting 15s.
    const origReply = mgr._requestReply.bind(mgr);
    mgr._requestReply = (record, msg, okType, timeout, failType) => {
      if (msg && msg.type === 'listen_port') {
        assert.strictEqual(failType, 'listen_port_failed', 'failure frame is caught, not timed out');
        return Promise.resolve({ type: 'listen_port_failed', error: 'simulated EADDRINUSE' });
      }
      return origReply(record, msg, okType, timeout, failType);
    };
    const result = await mgr.swapServer('/bin/new', ['--port', '11433'], {});
    assert.strictEqual(result.swapped, false);
    assert.strictEqual(result.reason, 'port_takeover_failed');
    assert.strictEqual(result.detail, 'simulated EADDRINUSE');
    assert.ok(oldSent.some((m) => m.type === 'listen_port' && m.port === 11433), 'old re-binds the port');
    assert.strictEqual(newProc.killed, true);
    assert.strictEqual(mgr.current.pid, 100);
  });

  it('gracefulShutdown sends IPC shutdown and resolves', async function () {
    const mgr = new ServerManager({ shutdownGraceMs: 500 });
    const proc = fakeProc();
    const pending = mgr.gracefulShutdown({ proc, pid: 1 }, 'update');
    assert.deepStrictEqual(proc.sent[0], { type: 'shutdown', reason: 'update' });
    proc.emit('message', { type: 'shutdown_complete', savedSessions: true });
    assert.strictEqual(await pending, true);
  });

  it('swapServer calls onPreShutdown with the preview while old is still alive', async function () {
    const newProc = fakeProc();
    newProc.pid = 200;
    const oldProc = fakeProc();
    oldProc.pid = 100;
    oldProc.exitCode = null;
    const mgr = new ServerManager({
      ptyManager: { describeForHandoff: () => [], transferOwnership: () => ({ transferred: 0, failed: 0 }) },
      readyTimeoutMs: 1000,
      handoffTimeoutMs: 1000,
      shutdownGraceMs: 50,
    });
    mgr.spawnServer = async (bin) => ({ proc: newProc, pid: 200, binary: bin, version: '0.1.109' });
    mgr._requestHandoff = async () => true;
    mgr.gracefulShutdown = async () => true;
    mgr.current = { proc: oldProc, pid: 100, binary: '/bin/old' };
    let preview = null;
    let oldAliveAtHook = null;
    const result = await mgr.swapServer('/bin/new', [], {}, {
      onPreShutdown: (p) => { preview = p; oldAliveAtHook = !oldProc.killed; },
    });
    assert.strictEqual(result.swapped, true);
    assert.ok(preview, 'hook fired');
    assert.strictEqual(preview.version, '0.1.109');
    assert.strictEqual(preview.ptys, 0);
    assert.strictEqual(oldAliveAtHook, true, 'old child living when the hook runs');
  });

  it('swapServer skips onPreShutdown on rollback paths', async function () {
    const oldProc = fakeProc();
    oldProc.pid = 100;
    const mgr = new ServerManager({
      spawn: () => fakeProc(),
      readyTimeoutMs: 20,
      handoffTimeoutMs: 20,
      shutdownGraceMs: 20,
    });
    mgr.current = { proc: oldProc, pid: 100, binary: '/bin/old' };
    let fired = false;
    const result = await mgr.swapServer('/bin/new', [], {}, { onPreShutdown: () => { fired = true; } });
    assert.strictEqual(result.swapped, false);
    assert.strictEqual(fired, false, 'no early answer on a refused swap');
  });
});
