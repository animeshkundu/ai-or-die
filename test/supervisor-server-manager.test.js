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

  it('gracefulShutdown sends IPC shutdown and resolves', async function () {
    const mgr = new ServerManager({ shutdownGraceMs: 500 });
    const proc = fakeProc();
    const pending = mgr.gracefulShutdown({ proc, pid: 1 }, 'update');
    assert.deepStrictEqual(proc.sent[0], { type: 'shutdown', reason: 'update' });
    proc.emit('message', { type: 'shutdown_complete', savedSessions: true });
    assert.strictEqual(await pending, true);
  });
});
