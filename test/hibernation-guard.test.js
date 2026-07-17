'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const HibernationGuard = require('../src/hibernation-guard');

function tick() {
  return new Promise((r) => setImmediate(r));
}

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.unrefCount = 0;
    this.encoding = null;
  }
  setEncoding(e) { this.encoding = e; }
  unref() { this.unrefCount++; }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.unrefCount = 0;
    this.killed = false;
  }
  unref() { this.unrefCount++; }
  kill() { this.killed = true; return true; }
  // drivers:
  emitOut(s) { this.stdout.emit('data', s); }
  emitErr(s) { this.stderr.emit('data', s); }
  close(code = 0) { this.emit('close', code); }
}

function makeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new FakeChild();
    calls.push({ cmd, args, opts, child });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

function makeLogger() {
  const logger = { logs: [], warns: [], debugs: [] };
  logger.log = (...a) => logger.logs.push(a.join(' '));
  logger.warn = (...a) => logger.warns.push(a.join(' '));
  logger.debug = (...a) => logger.debugs.push(a.join(' '));
  return logger;
}

describe('HibernationGuard', () => {
  function win32Guard(extra = {}) {
    return new HibernationGuard(Object.assign({
      enabled: true,
      platform: 'win32',
      spawn: makeSpawn(),
      logger: makeLogger(),
      readyTimeoutMs: 50,
    }, extra));
  }

  describe('buildScript / buildArgs (pure)', () => {
    it('reads HibernateEnabled and SKIPs (no elevation) when already off', () => {
      const s = HibernationGuard.buildScript(4242);
      assert.ok(s.includes("$ErrorActionPreference = 'Stop'"), 'Stop preference');
      assert.ok(s.includes('HibernateEnabled'), 'reads the registry flag (non-privileged)');
      assert.ok(s.includes("if ($he -eq 0) { [Console]::Out.WriteLine('SKIPPED'); exit 0 }"),
        'skips (no UAC) when already disabled');
      assert.ok(s.includes('aod-hibernation ppid=4242'), 'tags the parent pid');
    });

    it('elevates via Start-Process RunAs and runs the full powercfg remediation', () => {
      const s = HibernationGuard.buildScript(1);
      assert.ok(s.includes('-Verb RunAs'), 'requests elevation');
      assert.ok(s.includes('System32\\\\cmd.exe') || s.includes('System32\\cmd.exe'), 'elevated cmd absolute path');
      assert.ok(s.includes('powercfg /hibernate off'), 'disables hibernation');
      assert.ok(s.includes('powercfg /change standby-timeout-ac 0'), 'standby timeout AC -> Never');
      assert.ok(s.includes('powercfg /change standby-timeout-dc 0'), 'standby timeout DC -> Never');
      assert.ok(s.includes('powercfg /change hibernate-timeout-ac 0'), 'hibernate timeout AC -> Never');
      assert.ok(s.includes('powercfg /change hibernate-timeout-dc 0'), 'hibernate timeout DC -> Never');
      assert.ok(s.includes("[Console]::Out.WriteLine('APPLIED')"), 'reports APPLIED on success');
      assert.ok(s.includes("[Console]::Out.WriteLine('DENIED')"), 'reports DENIED on cancel');
    });

    it('exposes the remediation command list', () => {
      assert.ok(Array.isArray(HibernationGuard.REMEDIATION));
      assert.strictEqual(HibernationGuard.REMEDIATION[0], 'powercfg /hibernate off');
      assert.strictEqual(HibernationGuard.REMEDIATION.length, 5);
    });

    it('builds non-interactive, profile-less, bypass argv ending in the script', () => {
      const args = HibernationGuard.buildArgs(7);
      assert.ok(args.includes('-NoProfile'));
      assert.ok(args.includes('-NonInteractive'));
      const ep = args.indexOf('-ExecutionPolicy');
      assert.ok(ep >= 0 && args[ep + 1] === 'Bypass', 'execution policy bypass');
      const c = args.indexOf('-Command');
      assert.strictEqual(c, args.length - 2, '-Command is the penultimate arg');
      assert.strictEqual(args[args.length - 1], HibernationGuard.buildScript(7));
    });
  });

  describe('gating', () => {
    it('is a no-op off Windows (never spawns)', () => {
      const spawn = makeSpawn();
      const g = new HibernationGuard({ enabled: true, platform: 'darwin', spawn, logger: makeLogger() });
      g.run();
      assert.strictEqual(spawn.calls.length, 0);
    });

    it('is a no-op when disabled, even on win32', () => {
      const spawn = makeSpawn();
      const g = new HibernationGuard({ enabled: false, platform: 'win32', spawn, logger: makeLogger() });
      g.run();
      assert.strictEqual(spawn.calls.length, 0);
    });

    it('runs once; a second run() is a no-op', () => {
      const g = win32Guard();
      g.run();
      g.run();
      assert.strictEqual(g._spawn.calls.length, 1, 'second run is a no-op');
    });
  });

  describe('run() on win32', () => {
    it('spawns hidden, no shell, stdin ignored, stdout/stderr piped, all unref\'d', () => {
      const g = win32Guard();
      g.run();
      const { opts, child } = g._spawn.calls[0];
      assert.strictEqual(opts.windowsHide, true);
      assert.strictEqual(opts.shell, false);
      assert.deepStrictEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
      assert.ok(child.unrefCount >= 1, 'child unref');
      assert.ok(child.stdout.unrefCount >= 1, 'stdout unref');
      assert.ok(child.stderr.unrefCount >= 1, 'stderr unref');
    });

    it('logs success on APPLIED (no warning)', async () => {
      const g = win32Guard();
      g.run();
      const { child } = g._spawn.calls[0];
      child.emitOut('APPLIED\r\n');
      child.close(0);
      await tick();
      assert.ok(g._logger.logs.some((l) => /hibernation disabled/.test(l)), 'success logged');
      assert.strictEqual(g._logger.warns.length, 0, 'no warning on success');
    });

    it('logs (no warning) on SKIPPED — already disabled', async () => {
      const g = win32Guard();
      g.run();
      const { child } = g._spawn.calls[0];
      child.emitOut('SKIPPED\r\n');
      child.close(0);
      await tick();
      assert.ok(g._logger.logs.some((l) => /already disabled/.test(l)));
      assert.strictEqual(g._logger.warns.length, 0);
    });

    it('WARNS on DENIED (UAC declined) but does not throw', async () => {
      const g = win32Guard();
      g.run();
      const { child } = g._spawn.calls[0];
      child.emitOut('DENIED\r\n');
      child.close(0);
      await tick();
      assert.ok(g._logger.warns.some((w) => /elevation declined/.test(w)), 'visible warning');
    });

    it('WARNS on ERROR and surfaces the stderr hint', async () => {
      const g = win32Guard();
      g.run();
      const { child } = g._spawn.calls[0];
      child.emitErr('powercfg exit=1');
      child.emitOut('ERROR\r\n');
      child.close(1);
      await tick();
      assert.ok(g._logger.warns.some((w) => /could not disable hibernation/.test(w)));
      assert.ok(g._logger.warns.some((w) => /powercfg exit=1/.test(w)), 'includes the hint');
    });

    it('WARNS when the helper prints no recognizable token', async () => {
      const g = win32Guard();
      g.run();
      const { child } = g._spawn.calls[0];
      child.close(0);
      await tick();
      assert.ok(g._logger.warns.some((w) => /could not disable hibernation/.test(w)));
    });

    it('does not throw when the child emits an error (spawn failure)', async () => {
      const g = win32Guard();
      g.run();
      const { child } = g._spawn.calls[0];
      assert.doesNotThrow(() => child.emit('error', new Error('ENOENT')));
      await tick();
      assert.ok(g._logger.warns.some((w) => /could not disable hibernation/.test(w)));
    });

    it('degrades gracefully (no throw) when spawn itself throws', () => {
      const badSpawn = () => { throw new Error('ENOENT'); };
      const g = new HibernationGuard({ enabled: true, platform: 'win32', spawn: badSpawn, logger: makeLogger() });
      assert.doesNotThrow(() => g.run());
    });

    it('reaps a helper that never reports (timeout) and warns', async () => {
      const g = win32Guard({ readyTimeoutMs: 15 });
      g.run();
      const { child } = g._spawn.calls[0];
      await new Promise((r) => setTimeout(r, 40));
      assert.ok(child.killed, 'stuck helper is killed');
      assert.ok(g._logger.warns.some((w) => /could not disable hibernation/.test(w)));
    });
  });
});
