'use strict';

const assert = require('assert');
const cp = require('child_process');
const { EventEmitter } = require('events');
const KeepaliveManager = require('../src/keepalive-manager');

function tick() {
  return new Promise((r) => setImmediate(r));
}

// Minimal stand-in for a child stdio stream (stdin/stdout/stderr).
class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.ended = false;
    this.unrefCount = 0;
    this.encoding = null;
  }
  setEncoding(e) { this.encoding = e; }
  unref() { this.unrefCount++; }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
}

// Minimal stand-in for a spawned ChildProcess.
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new FakeStream();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.unrefCount = 0;
    this.killed = false;
  }
  unref() { this.unrefCount++; }
  kill() { this.killed = true; return true; }
  // helpers the tests drive:
  ok() { this.stdout.emit('data', 'OK\r\n'); }
  err(line) { this.stderr.emit('data', line + '\n'); }
  // Real children emit 'exit' then 'close' (the latter after stdio drains); the
  // manager settles on 'close', so emit both in order.
  die(code = 0) { this.emit('exit', code, null); this.emit('close', code, null); }
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

describe('KeepaliveManager', () => {
  // Track managers so each test releases its helper -> removes the process
  // 'exit' listener it installed (otherwise many win32 managers would pile up
  // listeners and trip MaxListenersExceededWarning).
  let mgrs = [];
  function track(m) { mgrs.push(m); return m; }
  function win32Manager(extra = {}) {
    return track(new KeepaliveManager(Object.assign({
      enabled: true,
      platform: 'win32',
      spawn: makeSpawn(),
      logger: makeLogger(),
    }, extra)));
  }
  afterEach(() => {
    for (const m of mgrs) { try { m.releaseSync(); } catch (_) { /* ignore */ } }
    mgrs = [];
  });

  describe('buildScript / buildArgs (pure)', () => {
    it('uses $ErrorActionPreference=Stop and the decimal system flag', () => {
      const s = KeepaliveManager.buildScript(false, 4242);
      assert.ok(s.includes("$ErrorActionPreference = 'Stop'"), 'has Stop preference');
      assert.ok(s.includes('[uint32]2147483649'), 'asserts ES_CONTINUOUS|ES_SYSTEM_REQUIRED');
      assert.ok(!s.includes('2147483651'), 'does NOT request display when system-only');
      assert.ok(s.includes('[uint32]2147483648'), 'clears with ES_CONTINUOUS alone');
      assert.ok(s.includes('aod-keepalive ppid=4242'), 'tags the parent pid');
      assert.ok(s.includes('exit 1'), 'exits when the assertion is refused (no silent block)');
      assert.ok(s.includes('SetThreadExecutionState'), 'P/Invokes the API');
      assert.ok(!/0x8000000/i.test(s), 'no hex flag literal');
    });

    it('adds the display flag when keepDisplayOn', () => {
      const s = KeepaliveManager.buildScript(true, 1);
      assert.ok(s.includes('[uint32]2147483651'), 'asserts +ES_DISPLAY_REQUIRED');
    });

    it('builds non-interactive, profile-less, bypass argv ending in the script', () => {
      const args = KeepaliveManager.buildArgs(false, 7);
      assert.ok(args.includes('-NoProfile'));
      assert.ok(args.includes('-NonInteractive'));
      const ep = args.indexOf('-ExecutionPolicy');
      assert.ok(ep >= 0 && args[ep + 1] === 'Bypass', 'execution policy bypass');
      const c = args.indexOf('-Command');
      assert.strictEqual(c, args.length - 2, '-Command is the penultimate arg');
      assert.strictEqual(args[args.length - 1], KeepaliveManager.buildScript(false, 7));
    });

    it('resolves the absolute in-box Windows PowerShell path', () => {
      const p = KeepaliveManager.powershellPath();
      assert.ok(p.includes('System32'), 'under System32');
      assert.ok(p.includes('WindowsPowerShell'), 'in-box Windows PowerShell');
      assert.ok(p.endsWith('powershell.exe'), 'is powershell.exe (not pwsh)');
    });
  });

  describe('platform / enabled gating', () => {
    it('is a no-op off Windows (never spawns)', async () => {
      const spawn = makeSpawn();
      const m = track(new KeepaliveManager({ enabled: true, platform: 'darwin', spawn, logger: makeLogger() }));
      m.start();
      await tick();
      assert.strictEqual(spawn.calls.length, 0, 'no spawn on darwin');
      assert.strictEqual(await m.ready, false);
    });

    it('is a no-op when disabled, even on win32', async () => {
      const spawn = makeSpawn();
      const m = track(new KeepaliveManager({ enabled: false, platform: 'win32', spawn, logger: makeLogger() }));
      m.start();
      await tick();
      assert.strictEqual(spawn.calls.length, 0);
      assert.strictEqual(await m.ready, false);
    });
  });

  describe('start() on win32', () => {
    it('spawns once, hidden, no shell, with piped stdio', () => {
      const m = win32Manager();
      m.start();
      assert.strictEqual(m._spawn.calls.length, 1);
      const { opts } = m._spawn.calls[0];
      assert.strictEqual(opts.windowsHide, true);
      assert.strictEqual(opts.shell, false);
      assert.deepStrictEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
    });

    it('unrefs the child and all three stdio streams (no event-loop pinning)', () => {
      const m = win32Manager();
      m.start();
      const { child } = m._spawn.calls[0];
      assert.ok(child.unrefCount >= 1, 'child unref');
      assert.ok(child.stdin.unrefCount >= 1, 'stdin unref');
      assert.ok(child.stdout.unrefCount >= 1, 'stdout unref');
      assert.ok(child.stderr.unrefCount >= 1, 'stderr unref');
    });

    it('resolves ready=true and logs success after the OK line', async () => {
      const m = win32Manager();
      m.start();
      m._spawn.calls[0].child.ok();
      assert.strictEqual(await m.ready, true);
      assert.ok(m._logger.logs.some((l) => /holding wake assertion/.test(l)));
      assert.strictEqual(m._logger.warns.length, 0, 'no warning on success');
    });

    it('resolves ready=false and WARNS with the stderr hint when the child dies without OK', async () => {
      const m = win32Manager();
      m.start();
      const { child } = m._spawn.calls[0];
      child.err('Add-Type : Cannot invoke method. CLM.');
      child.die(1);
      assert.strictEqual(await m.ready, false);
      await tick();
      assert.ok(m._logger.warns.some((w) => /machine may sleep/.test(w)), 'visible warning');
      assert.ok(m._logger.warns.some((w) => /CLM/.test(w)), 'includes the stderr hint');
    });

    it('resolves ready=false on readiness timeout AND reaps the zombie helper', async () => {
      const m = win32Manager({ readyTimeoutMs: 15 });
      m.start();
      const { child } = m._spawn.calls[0];
      assert.strictEqual(await m.ready, false);
      await tick();
      assert.ok(m._logger.warns.some((w) => /machine may sleep/.test(w)));
      assert.ok(child.stdin.ended, 'timed-out helper is reaped (stdin closed)');
      assert.ok(child.killed, 'timed-out helper is killed');
    });

    it('degrades gracefully (no throw) when spawn itself throws', async () => {
      const badSpawn = () => { throw new Error('ENOENT'); };
      const m = track(new KeepaliveManager({ enabled: true, platform: 'win32', spawn: badSpawn, logger: makeLogger() }));
      assert.doesNotThrow(() => m.start());
      assert.strictEqual(m._started, false);
      assert.strictEqual(await m.ready, false);
    });

    it('warns when the helper dies AFTER a successful acquire (assertion lost)', async () => {
      const m = win32Manager();
      m.start();
      const { child } = m._spawn.calls[0];
      child.ok();
      await m.ready;
      child.die(1); // e.g. AV/EDR kills it later
      await tick();
      assert.ok(m._logger.warns.some((w) => /assertion lost/.test(w)), 'loss is surfaced, not silent');
      assert.strictEqual(m._started, false);
    });
  });

  describe('idempotency & re-acquire', () => {
    it('does not spawn a second helper while one is live', () => {
      const m = win32Manager();
      m.start();
      m._spawn.calls[0].child.ok();
      m.start();
      assert.strictEqual(m._spawn.calls.length, 1, 'second start is a no-op');
    });

    it('re-spawns exactly one helper after the live child dies', async () => {
      const m = win32Manager();
      m.start();
      const first = m._spawn.calls[0].child;
      first.ok();
      await m.ready;
      first.die(1);
      await tick();
      assert.strictEqual(m._started, false, 'state reflects the dead child');
      m.start();
      assert.strictEqual(m._spawn.calls.length, 2, 'exactly one new helper');
    });

    it('a superseded child\'s late exit does not corrupt the live run', async () => {
      const m = win32Manager();
      m.start();
      const first = m._spawn.calls[0].child;
      first.ok();
      await m.ready;
      m.releaseSync();          // drop the first
      m.start();                // acquire a second
      const second = m._spawn.calls[1].child;
      second.ok();
      await m.ready;
      first.die(1);             // first's delayed death arrives now
      await tick();
      assert.strictEqual(m._started, true, 'live run still considered started');
      assert.strictEqual(m._child, second, 'live child not cleared by the stale exit');
    });
  });

  describe('release / releaseSync', () => {
    it('ends stdin (graceful EOF) and kills the child, without destroy()', () => {
      const m = win32Manager();
      m.start();
      const { child } = m._spawn.calls[0];
      m.releaseSync();
      assert.ok(child.stdin.ended, 'stdin ended -> helper hits EOF and self-clears');
      assert.ok(!child.stdin.destroyed, 'stdin NOT destroyed (would abort the EOF)');
      assert.ok(child.killed, 'belt-and-suspenders kill');
      assert.strictEqual(m._started, false);
    });

    it('is idempotent and safe when never started', () => {
      const m = win32Manager();
      assert.doesNotThrow(() => m.releaseSync());
      assert.doesNotThrow(() => m.releaseSync());
    });

    it('does not throw when stdin is already destroyed', () => {
      const m = win32Manager();
      m.start();
      const { child } = m._spawn.calls[0];
      child.stdin.destroyed = true;
      assert.doesNotThrow(() => m.releaseSync());
    });

    it('removes its process exit listener on release (no listener leak)', () => {
      const before = process.listenerCount('exit');
      const m = win32Manager();
      m.start();
      assert.strictEqual(process.listenerCount('exit'), before + 1, 'one hook while held');
      m.releaseSync();
      assert.strictEqual(process.listenerCount('exit'), before, 'hook removed on release');
    });

    it('async release() resolves and clears state', async () => {
      const m = win32Manager();
      m.start();
      await m.release();
      assert.strictEqual(m._started, false);
    });
  });

  // Real-process integration: the load-bearing C1 invariant -- a stdin-blocking
  // helper exits when its parent dies (the pipe closes -> EOF). Validated with
  // node helpers so it runs on macOS/Linux CI (no PowerShell required).
  describe('parent-death EOF invariant (integration)', () => {
    it('a stdin-blocking helper exits when its parent process is killed', function (done) {
      this.timeout(8000);
      const helperSrc =
        "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setInterval(()=>{},1e9);";
      const parentSrc =
        "const cp=require('child_process');" +
        "const h=cp.spawn(process.execPath,['-e'," + JSON.stringify(helperSrc) + "],{stdio:['pipe','pipe','ignore']});" +
        "process.stdout.write(String(h.pid));";
      const parent = cp.spawn(process.execPath, ['-e', parentSrc], { stdio: ['pipe', 'pipe', 'ignore'] });

      let buf = '';
      parent.stdout.on('data', (d) => { buf += String(d); });
      parent.on('spawn', () => {
        setTimeout(() => {
          const helperPid = parseInt(buf, 10);
          assert.ok(helperPid > 0, 'captured helper pid');
          parent.kill('SIGKILL'); // simulate hard parent death
          const start = Date.now();
          const poll = setInterval(() => {
            let alive = true;
            try { process.kill(helperPid, 0); } catch (_) { alive = false; }
            if (!alive) { clearInterval(poll); done(); return; }
            if (Date.now() - start > 6000) {
              clearInterval(poll);
              try { process.kill(helperPid, 'SIGKILL'); } catch (_) {}
              done(new Error('helper did not exit after parent death'));
            }
          }, 100);
        }, 400);
      });
    });
  });
});
