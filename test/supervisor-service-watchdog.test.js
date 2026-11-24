'use strict';

// Coverage for the out-of-process watchdog and the heartbeat it reads.
//
// A scheduled task can only act on process EXIT. A supervisor that is alive but
// wedged (blocked event loop, dead server child, respawn logic given up) looks
// healthy to every OS-level supervisor, so `IgnoreNew` refuses every later
// trigger and the machine silently stops answering. The watchdog is the only
// mechanism that can distinguish those states, and it must never restart a
// daemon that is merely quiet.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
  Heartbeat,
  writeHeartbeat,
  readHeartbeat,
  heartbeatAgeMs,
} = require('../src/supervisor/heartbeat');
const {
  ServiceWatchdog,
  probeHealth,
  isPidAlive,
  portFromServerArgs,
} = require('../src/supervisor/service-watchdog');

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aod-watchdog-'));
}

function paths(dir) {
  const base = path.join(dir, 'aod');
  return {
    base,
    heartbeat: path.join(base, 'run', 'heartbeat.json'),
    state: path.join(base, 'run', 'watchdog.json'),
    log: path.join(base, 'logs', 'watchdog.log'),
    meta: path.join(base, 'service.json'),
  };
}

function writeMeta(dir, serverArgs) {
  const p = paths(dir);
  fs.mkdirSync(p.base, { recursive: true });
  fs.writeFileSync(p.meta, JSON.stringify({ serverArgs }));
}

describe('service/heartbeat', function () {
  it('writes atomically with mode 0600 and never throws', function () {
    const dir = sandbox();
    try {
      const file = path.join(dir, 'run', 'heartbeat.json');
      assert.strictEqual(writeHeartbeat({ phase: 'ready', pid: process.pid }, { file }), true);
      const hb = readHeartbeat({ file });
      assert.strictEqual(hb.phase, 'ready');
      assert.strictEqual(hb.pid, process.pid);
      assert.ok(hb.updatedAtMs > 0);
      if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      }
      // Unwritable location: must report false, never throw.
      assert.strictEqual(writeHeartbeat({ phase: 'x' }, { file: path.join(dir, 'nope', '\u0000x') }), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports Infinity age when the file is missing or corrupt', function () {
    const dir = sandbox();
    try {
      const file = path.join(dir, 'heartbeat.json');
      assert.strictEqual(heartbeatAgeMs({ file }), Infinity);
      fs.writeFileSync(file, 'not json');
      assert.strictEqual(heartbeatAgeMs({ file }), Infinity);
      assert.strictEqual(readHeartbeat({ file }), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('beats on an interval and reports live status', function (done) {
    const dir = sandbox();
    const file = path.join(dir, 'heartbeat.json');
    const hb = new Heartbeat({
      file,
      intervalMs: 1000,
      status: () => ({ serverPid: 1234, ptys: 2 }),
    });
    hb.start('ready');
    const first = readHeartbeat({ file });
    assert.strictEqual(first.phase, 'ready');
    assert.strictEqual(first.status.serverPid, 1234);
    setTimeout(() => {
      try {
        const second = readHeartbeat({ file });
        assert.ok(second.updatedAtMs >= first.updatedAtMs, 'heartbeat keeps advancing');
        hb.stop();
        fs.rmSync(dir, { recursive: true, force: true });
        done();
      } catch (err) {
        hb.stop();
        fs.rmSync(dir, { recursive: true, force: true });
        done(err);
      }
    }, 1200);
  });
});

describe('service/watchdog', function () {
  function watchdogFor(dir, extra = {}) {
    return new ServiceWatchdog({
      platform: 'win32',
      baseDir: paths(dir).base,
      logger: silent,
      serviceName: 'ai-or-die',
      probeHealth: async () => ({ ok: false, detail: 'ECONNREFUSED' }),
      execFileSync: () => Buffer.from(''),
      ...extra,
    });
  }

  it('does nothing while the heartbeat is fresh and the pid is alive', async function () {
    const dir = sandbox();
    try {
      writeMeta(dir, ['--port', '8899']);
      const p = paths(dir);
      writeHeartbeat({ phase: 'ready' }, { file: p.heartbeat });
      const calls = [];
      const wd = watchdogFor(dir, { execFileSync: (...a) => { calls.push(a); return Buffer.from(''); } });
      const result = await wd.run();
      assert.strictEqual(result.acted, false);
      assert.strictEqual(result.reason, 'heartbeat-fresh');
      assert.deepStrictEqual(calls, [], 'no schtasks call while healthy');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restarts when the heartbeat is stale, the pid is dead and health fails', async function () {
    const dir = sandbox();
    try {
      writeMeta(dir, ['--port', '8899']);
      const p = paths(dir);
      fs.mkdirSync(path.dirname(p.heartbeat), { recursive: true });
      // A pid that cannot exist: heartbeat aged well past the threshold.
      fs.writeFileSync(p.heartbeat, JSON.stringify({
        pid: 2147483646, phase: 'ready', updatedAtMs: Date.now() - 600000,
      }));
      const calls = [];
      const wd = watchdogFor(dir, {
        execFileSync: (...a) => { calls.push(a[1][0]); return Buffer.from(''); },
      });
      const result = await wd.run();
      assert.strictEqual(result.acted, true);
      assert.strictEqual(result.reason, 'restarted');
      assert.deepStrictEqual(calls, ['/end', '/run'], 'end before run (IgnoreNew would ignore a bare run)');
      const state = JSON.parse(fs.readFileSync(p.state, 'utf8'));
      assert.strictEqual(state.restarts, 1);
      assert.ok(fs.existsSync(p.log), 'watchdog logged the action');
      assert.ok(fs.readFileSync(p.log, 'utf8').includes('restarting ai-or-die'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not kill a daemon that is still in its boot phase', async function () {
    const dir = sandbox();
    try {
      writeMeta(dir, []);
      const p = paths(dir);
      fs.mkdirSync(path.dirname(p.heartbeat), { recursive: true });
      // Phase 'boot' never advances until the server answers. A slow first boot
      // (AV scan, cold profile) looks identical to a wedge by age alone.
      fs.writeFileSync(p.heartbeat, JSON.stringify({
        pid: process.pid, phase: 'boot', updatedAtMs: Date.now() - 300000, startedAtMs: Date.now() - 300000,
      }));
      const calls = [];
      const wd = watchdogFor(dir, { execFileSync: (...a) => { calls.push(a); return Buffer.from(''); } });
      const result = await wd.run();
      assert.strictEqual(result.acted, false);
      assert.strictEqual(result.reason, 'booting');
      assert.ok(result.bootGraceRemainingMs > 0);
      assert.deepStrictEqual(calls, []);

      // Past the grace window the same state IS a wedge: a boot that never
      // reaches ready must be restarted.
      const stuck = watchdogFor(dir, {
        now: () => Date.now() + 11 * 60 * 1000,
        execFileSync: (...a) => { calls.push(a); return Buffer.from(''); },
      });
      const second = await stuck.run();
      assert.strictEqual(second.reason, 'restarted', `expected a restart once the grace expired, got ${second.reason}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never restarts a daemon that is still answering /api/health', async function () {
    const dir = sandbox();
    try {
      writeMeta(dir, ['--port', '8899']);
      const p = paths(dir);
      fs.mkdirSync(path.dirname(p.heartbeat), { recursive: true });
      fs.writeFileSync(p.heartbeat, JSON.stringify({ pid: 2147483646, phase: 'ready', updatedAtMs: Date.now() - 600000 }));
      const calls = [];
      const wd = watchdogFor(dir, {
        probeHealth: async () => ({ ok: true, detail: 'HTTP 200' }),
        execFileSync: (...a) => { calls.push(a); return Buffer.from(''); },
      });
      const result = await wd.run();
      assert.strictEqual(result.acted, false);
      assert.strictEqual(result.reason, 'healthy-but-stale');
      assert.deepStrictEqual(calls, [], 'a serving daemon is never killed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('debounces repeated restarts so a broken install does not thrash', async function () {
    const dir = sandbox();
    try {
      writeMeta(dir, []);
      const p = paths(dir);
      fs.mkdirSync(path.dirname(p.heartbeat), { recursive: true });
      fs.writeFileSync(p.heartbeat, JSON.stringify({ pid: 2147483646, phase: 'ready', updatedAtMs: Date.now() - 600000 }));
      let now = Date.now();
      const calls = [];
      const wd = watchdogFor(dir, {
        now: () => now,
        execFileSync: (...a) => { calls.push(a[1][0]); return Buffer.from(''); },
      });
      const first = await wd.run();
      assert.strictEqual(first.acted, true);
      const second = await wd.run();
      assert.strictEqual(second.acted, false, 'second attempt inside the debounce window is skipped');
      assert.strictEqual(second.reason, 'debounced');
      // Ten minutes later the retry is allowed again.
      now += 11 * 60 * 1000;
      const third = await wd.run();
      assert.strictEqual(third.acted, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backs off on consecutive failures instead of hammering', async function () {
    const dir = sandbox();
    try {
      writeMeta(dir, []);
      const p = paths(dir);
      fs.mkdirSync(path.dirname(p.heartbeat), { recursive: true });
      fs.writeFileSync(p.heartbeat, JSON.stringify({ pid: 2147483646, phase: 'ready', updatedAtMs: Date.now() - 600000 }));
      fs.writeFileSync(p.state, JSON.stringify({ restarts: 3, lastAttemptMs: Date.now() }));
      const wd = watchdogFor(dir);
      const result = await wd.run();
      assert.strictEqual(result.acted, false);
      assert.strictEqual(result.reason, 'debounced');
      // 10 min * 2^(3-1) = 40 min for the fourth attempt.
      assert.ok(result.debounceRemainingMs > 30 * 60 * 1000, `backoff grew (${result.debounceRemainingMs})`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resets the backoff once the daemon is healthy again', async function () {
    const dir = sandbox();
    try {
      writeMeta(dir, []);
      const p = paths(dir);
      fs.mkdirSync(path.dirname(p.heartbeat), { recursive: true });
      fs.writeFileSync(p.state, JSON.stringify({ restarts: 4, lastAttemptMs: Date.now() }));
      writeHeartbeat({ phase: 'ready' }, { file: p.heartbeat });
      const wd = watchdogFor(dir);
      const result = await wd.run();
      assert.strictEqual(result.reason, 'heartbeat-fresh');
      const state = JSON.parse(fs.readFileSync(p.state, 'utf8'));
      assert.strictEqual(state.restarts, 0, 'backoff cleared after recovery');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op on POSIX (systemd Restart= / launchd KeepAlive own that)', async function () {
    const dir = sandbox();
    try {
      const wd = new ServiceWatchdog({ platform: 'linux', baseDir: path.join(dir, 'aod'), logger: silent });
      const result = await wd.run();
      assert.strictEqual(result.reason, 'not-applicable');
      assert.strictEqual(result.acted, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dry-run reports the decision without touching the task', async function () {
    const dir = sandbox();
    try {
      writeMeta(dir, []);
      const p = paths(dir);
      fs.mkdirSync(path.dirname(p.heartbeat), { recursive: true });
      fs.writeFileSync(p.heartbeat, JSON.stringify({ pid: 2147483646, phase: 'ready', updatedAtMs: Date.now() - 600000 }));
      const calls = [];
      const wd = watchdogFor(dir, { execFileSync: (...a) => { calls.push(a); return Buffer.from(''); } });
      const result = await wd.run({ dryRun: true });
      assert.strictEqual(result.reason, 'would-restart');
      assert.deepStrictEqual(calls, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws when the environment is broken', async function () {
    const wd = new ServiceWatchdog({
      platform: 'win32',
      baseDir: path.join(os.tmpdir(), '\u0000bad'),
      logger: silent,
      probeHealth: async () => { throw new Error('boom'); },
      execFileSync: () => { throw new Error('boom'); },
    });
    const result = await wd.run();
    assert.strictEqual(result.acted, false);
    assert.ok(['error', 'debounced', 'restart-failed'].includes(result.reason), `reason=${result.reason}`);
  });

  it('parses the port from persisted server args', function () {
    assert.strictEqual(portFromServerArgs(['--port', '8899']), 8899);
    assert.strictEqual(portFromServerArgs(['--port=8899']), 8899);
    assert.strictEqual(portFromServerArgs(['-p', '8899']), 8899);
    assert.strictEqual(portFromServerArgs(['--mesh'], 7777), 7777);
    assert.strictEqual(portFromServerArgs(['--port', 'nope'], 7777), 7777);
    assert.strictEqual(portFromServerArgs(null, 7777), 7777);
  });

  it('detects live and dead pids without throwing', function () {
    assert.strictEqual(isPidAlive(process.pid), true);
    assert.strictEqual(isPidAlive(2147483646), false);
    assert.strictEqual(isPidAlive(0), false);
    assert.strictEqual(isPidAlive('nope'), false);
  });

  it('a 200 from the wrong process is not "healthy" (pid mismatch)', async function () {
    const dir = sandbox();
    try {
      writeMeta(dir, ['--port', '8899']);
      const p = paths(dir);
      fs.mkdirSync(path.dirname(p.heartbeat), { recursive: true });
      fs.writeFileSync(p.heartbeat, JSON.stringify({
        pid: 2147483646, phase: 'ready', updatedAtMs: Date.now() - 600000,
        // The health endpoint answers from the SERVER child, so that is the pid
        // the probe must confirm.
        status: { serverPid: 777001 },
      }));
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        // A DIFFERENT process owns the port (stale dev server, another user's
        // instance). Treating this 200 as healthy would leave the real wedge.
        res.end(JSON.stringify({ status: 'ok', pid: 4242 }));
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      try {
        const calls = [];
        const wd = watchdogFor(dir, {
          probeHealth: (pp, t, expect) => probeHealth(pp, t, expect),
          execFileSync: (...a) => { calls.push(a[1][0]); return Buffer.from(''); },
        });
        // Point the watchdog at the live port without needing service.json.
        wd._serverPort = () => port;
        const result = await wd.run();
        assert.strictEqual(result.healthy, false, 'wrong pid is not healthy');
        assert.strictEqual(result.acted, true, 'the wedge is still acted on');
        assert.ok(/expected 777001/.test(result.healthDetail || ''), `detail names the mismatch: ${result.healthDetail}`);
        assert.deepStrictEqual(calls, ['/end', '/run']);
      } finally {
        await new Promise((r) => server.close(r));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a healthy daemon as serving even when the heartbeat stringified the pid', async function () {
    const dir = sandbox();
    try {
      writeMeta(dir, ['--port', '8899']);
      const p = paths(dir);
      fs.mkdirSync(path.dirname(p.heartbeat), { recursive: true });
      fs.writeFileSync(p.heartbeat, JSON.stringify({
        pid: 2147483646, phase: 'ready', updatedAtMs: Date.now() - 600000,
        // A serializer or an older writer may emit the pid as a string. Falling
        // back to "no expectation" would restart a daemon that is serving.
        status: { serverPid: '777001' },
      }));
      const calls = [];
      const wd = watchdogFor(dir, {
        probeHealth: async (pp, t, expect) => ({ ok: Number(expect) === 777001, detail: `expected ${expect}` }),
        execFileSync: (...a) => { calls.push(a); return Buffer.from(''); },
      });
      const result = await wd.run();
      assert.strictEqual(result.healthy, true, 'stringified pid still identifies the server');
      assert.strictEqual(result.reason, 'healthy-but-stale');
      assert.deepStrictEqual(calls, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a 200 that names the expected pid', async function () {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: 1234 }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      assert.strictEqual((await probeHealth(port, 2000, 1234)).ok, true);
      assert.strictEqual((await probeHealth(port, 2000, 999)).ok, false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('is not healthy when no expectation is known or the body names no pid', async function () {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      // No expectation (no heartbeat on disk): a 200 from ANY process on the
      // port says nothing about our daemon — a stale dev server squatting it
      // would otherwise read as healthy-but-stale forever.
      const noExpect = await probeHealth(port, 2000);
      assert.strictEqual(noExpect.ok, false, 'a 200 alone is not proof of identity');
      assert.ok(/no expected pid/i.test(noExpect.detail), `detail says which case: ${noExpect.detail}`);
      // Expectation known but the body names no pid: same conclusion.
      const noPid = await probeHealth(port, 2000, 1234);
      assert.strictEqual(noPid.ok, false, 'a body without a pid cannot confirm identity');
      assert.ok(/without a usable pid/i.test(noPid.detail), `detail says which case: ${noPid.detail}`);
      // Unparseable pid (a non-numeric string) is the same as missing.
      assert.strictEqual((await probeHealth(port, 2000, 'nope')).ok, false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('accepts a 200 whose pid arrives as a string (numeric coercion)', async function () {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Some proxies/health shims stringify pids; '1234' !== 1234 would fail
      // the identity check on a perfectly healthy daemon.
      res.end(JSON.stringify({ status: 'ok', pid: '1234' }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const stringPid = await probeHealth(port, 2000, 1234);
      assert.strictEqual(stringPid.ok, true, `string pid matches the heartbeat: ${stringPid.detail}`);
      // Proves it matched on the pid and not by falling back to "no pid in body".
      assert.ok(/pid 1234/.test(stringPid.detail), `detail confirms the pid: ${stringPid.detail}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('restarts when a foreign server answers but no heartbeat exists at all', async function () {
    const dir = sandbox();
    try {
      writeMeta(dir, ['--port', '8899']);
      // No heartbeat: the daemon never registered a server pid, so nothing on
      // this machine can confirm the port belongs to it.
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', pid: 4242 }));
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      try {
        const calls = [];
        const wd = watchdogFor(dir, {
          probeHealth: (pp, t, expect) => probeHealth(pp, t, expect),
          execFileSync: (...a) => { calls.push(a[1][0]); return Buffer.from(''); },
        });
        wd._serverPort = () => port;
        const result = await wd.run();
        assert.strictEqual(result.healthy, false, 'cannot confirm identity => not healthy');
        assert.strictEqual(result.reason, 'restarted', `expected a restart, got ${result.reason}`);
        assert.deepStrictEqual(calls, ['/end', '/run']);
      } finally {
        await new Promise((r) => server.close(r));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an unwritable state file instead of silently losing the backoff', async function () {
    const dir = sandbox();
    try {
      writeMeta(dir, []);
      const p = paths(dir);
      fs.mkdirSync(path.dirname(p.heartbeat), { recursive: true });
      fs.writeFileSync(p.heartbeat, JSON.stringify({ pid: 2147483646, phase: 'ready', updatedAtMs: Date.now() - 600000 }));
      // A DIRECTORY where watchdog.json belongs: writeFileSync/renameSync fail
      // every time, so `restarts` would read back as 0 on every tick and the
      // exponential backoff would never engage.
      fs.mkdirSync(p.state, { recursive: true });
      const wd = watchdogFor(dir);
      const result = await wd.run();
      assert.strictEqual(result.reason, 'restarted', 'the restart itself still happens');
      const logged = fs.readFileSync(p.log, 'utf8');
      assert.ok(/cannot persist watchdog state/.test(logged), `the failure is reported: ${logged.slice(-400)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('probes /api/health and reports failure without throwing', async function () {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') { res.writeHead(200); res.end('{"ok":true,"pid":424242}'); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      // An expectation is supplied: without one a bare 200 is not identity proof
      // (see probeHealth), and this test is about the transport, not identity.
      const ok = await probeHealth(port, 2000, 424242);
      assert.strictEqual(ok.ok, true, `endpoint answered: ${ok.detail}`);
      // Nothing listening on an ephemeral port that just closed.
      await new Promise((r) => server.close(r));
      const dead = await probeHealth(port, 1000, 424242);
      assert.strictEqual(dead.ok, false);
    } finally {
      try { server.close(); } catch (_) { /* ignore */ }
    }
  });

  const NODE = 'C:\\Program Files\\nodejs\\node.exe';
  const SUP = 'C:\\Users\\u\\.ai-or-die\\bin\\ai-or-die-supervisor.js';

  it('builds a valid login-mode watchdog task definition', function () {
    const dir = sandbox();
    try {
      const xml = watchdogFor(dir).buildWatchdogXml(NODE, SUP);
      assert.ok(xml.includes('<Interval>PT5M</Interval>'), 'ticks every 5 minutes');
      assert.ok(xml.includes('<ExecutionTimeLimit>PT5M</ExecutionTimeLimit>'), 'a stuck probe cannot hang forever');
      assert.ok(xml.includes('service watchdog'), 'runs the watchdog verb');
      assert.ok(!xml.includes('ConsoleUnlock'), 'no invalid enum values');
      assert.ok(xml.includes('InteractiveToken'), 'runs as the logged-on user');
      assert.ok(!xml.includes('<BootTrigger>'), 'login mode has no boot trigger');
      // Element order per the XSD sequence: StartBoundary before Enabled.
      const body = /<TimeTrigger>([\s\S]*?)<\/TimeTrigger>/.exec(xml)[1];
      assert.ok(body.indexOf('<StartBoundary>') < body.indexOf('<Enabled>'));
      assert.ok(body.indexOf('<Enabled>') < body.indexOf('<Repetition>'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the watchdog before login in boot mode (S4U, no desktop needed)', function () {
    const dir = sandbox();
    try {
      const xml = watchdogFor(dir).buildWatchdogXml(NODE, SUP, {
        mode: 'boot', userId: 'S-1-5-21-1-2-3-1001',
      });
      // An InteractiveToken watchdog would be silent until someone logged in,
      // which is exactly the window it exists to cover.
      assert.ok(xml.includes('<LogonType>S4U</LogonType>'), 'S4U principal');
      assert.ok(xml.includes('<UserId>S-1-5-21-1-2-3-1001</UserId>'), 'explicit principal');
      assert.ok(xml.includes('<BootTrigger>'), 'starts ticking at boot');
      assert.ok(xml.includes('<Interval>PT5M</Interval>'), 'still 5-minute cadence');
      assert.ok(!xml.includes('InteractiveToken'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
