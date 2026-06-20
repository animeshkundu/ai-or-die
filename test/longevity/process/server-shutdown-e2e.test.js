'use strict';

// TRUE end-to-end regression for deterministic process shutdown.
//
// Unlike the unit/mechanism tests (job-guard in isolation; supervisor + a fake child;
// node-pty with a manually-attached job), this drives the WHOLE real stack:
//   real `bin/supervisor.js` -> forked server -> a real terminal PTY (the user's shell)
//   -> a real `node` grandchild launched by typing a command over the live WebSocket.
// Then it tears the system down two ways and asserts no orphaned process survives:
//   A. Hard/uncatchable kill of the supervisor (taskkill /F on Windows, SIGKILL on POSIX).
//      Windows: the kernel Job Object reaps the tree. POSIX: the server's IPC-disconnect
//      watchdog reaps its PTY group and exits. Either way the grandchild must die.
//   B. Graceful shutdown (IPC {type:'shutdown'}): clean exit 0 (no SIGABRT/134), and the
//      PTY grandchild is reaped by the per-PTY job close / process-group teardown.
//
// Cross-platform; runs on the longevity-smoke matrix (Ubuntu + Windows + macOS).

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SUPERVISOR = path.join(REPO_ROOT, 'bin', 'supervisor.js');
const GC_FIXTURE = path.join(__dirname, 'fixtures', 'e2e-grandchild.js');
const IS_WIN = process.platform === 'win32';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  // process.kill(pid, 0) is a cross-platform existence probe (throws ESRCH when dead).
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function killHard(pid) {
  if (IS_WIN) spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
  else { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* ignore */ } }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

async function waitFor(fn, timeoutMs, iv = 200) {
  const start = Date.now();
  for (;;) {
    let ok = false; try { ok = await fn(); } catch (_) { ok = false; }
    if (ok) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await sleep(iv);
  }
}

// Boot the real supervisor, open a WS, start a real terminal PTY, and type a command that
// launches a real `node` grandchild. Resolves { sup, gcPid, port, out, exitInfo }.
async function bootAndSpawnGrandchild(port, withIpc) {
  const gcFile = path.join(os.tmpdir(), `aod-e2e-gc-${process.pid}-${port}-${Date.now()}.pid`);
  try { fs.rmSync(gcFile, { force: true }); } catch (_) { /* ignore */ }

  const state = { out: '', exitInfo: null, gcFile };
  const stdio = withIpc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'];
  const sup = spawn(process.execPath, [
    SUPERVISOR, '--port', String(port), '--disable-auth',
    '--no-sticky-notes', '--no-stt', '--no-keepalive',
  ], { cwd: REPO_ROOT, stdio, env: { ...process.env, AOD_SUPERVISOR_RESTART: '1' } });
  state.sup = sup;
  sup.stdout.on('data', (d) => { state.out += d.toString(); });
  sup.stderr.on('data', (d) => { state.out += d.toString(); });
  sup.on('exit', (code, signal) => { state.exitInfo = { code, signal }; });

  const ready = await waitFor(() => /is running at|Press Ctrl\+C to stop/.test(state.out), 40000);
  if (!ready) throw new Error('server did not start in 40s:\n' + state.out.slice(-500));

  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise((res, rej) => {
    ws.on('open', res); ws.on('error', rej);
    setTimeout(() => rej(new Error('ws open timeout')), 10000);
  });
  ws.send(JSON.stringify({ type: 'create_session', name: 'e2e' }));
  await sleep(1000);
  ws.send(JSON.stringify({ type: 'start_terminal', cols: 100, rows: 30, options: {} }));
  await sleep(3500); // let the shell boot

  // Type a command in the real shell that launches the real node grandchild.
  ws.send(JSON.stringify({ type: 'input', data: `node "${GC_FIXTURE}" "${gcFile}"\r` }));

  const gotPid = await waitFor(() => {
    try { return fs.existsSync(gcFile) && parseInt(fs.readFileSync(gcFile, 'utf8').trim() || '0', 10) > 0; }
    catch (_) { return false; }
  }, 20000);
  try { ws.close(); } catch (_) { /* ignore */ }
  if (!gotPid) throw new Error('node grandchild never started inside the PTY:\n' + state.out.slice(-500));

  state.gcPid = parseInt(fs.readFileSync(gcFile, 'utf8').trim(), 10);
  return state;
}

function cleanup(state) {
  if (state && state.sup && state.sup.pid) { try { killHard(state.sup.pid); } catch (_) { /* ignore */ } }
  if (state && state.gcPid && pidAlive(state.gcPid)) { try { killHard(state.gcPid); } catch (_) { /* ignore */ } }
  if (state && state.gcFile) { try { fs.rmSync(state.gcFile, { force: true }); } catch (_) { /* ignore */ } }
}

describe('deterministic shutdown: real-server end-to-end (PTY + node grandchild)', function () {
  this.timeout(90000);

  it('uncatchable supervisor kill reaps the server + PTY + node grandchild (no orphan)', async function () {
    const port = 11973;
    let state;
    try {
      state = await bootAndSpawnGrandchild(port, false);
      assert.ok(pidAlive(state.gcPid), 'grandchild should be alive before the kill');
      assert.ok(await portOpen(port), 'server port should be open before the kill');

      killHard(state.sup.pid); // taskkill /F (win) / SIGKILL (posix) — no cleanup code runs

      const gcDead = await waitFor(() => !pidAlive(state.gcPid), 12000);
      const portClosed = await waitFor(async () => !(await portOpen(port)), 12000);
      assert.ok(gcDead, 'node grandchild SURVIVED the supervisor kill — orphan leaked');
      assert.ok(portClosed, 'server still listening after the supervisor was killed');
    } finally {
      cleanup(state);
    }
  });

  it('graceful shutdown exits cleanly (code 0) and reaps the PTY grandchild', async function () {
    const port = 11974;
    let state;
    try {
      state = await bootAndSpawnGrandchild(port, true); // ipc channel for the shutdown message
      assert.ok(pidAlive(state.gcPid), 'grandchild should be alive before shutdown');

      state.sup.send({ type: 'shutdown' }); // graceful path (works on Windows too, unlike SIGINT)

      const exited = await waitFor(() => state.exitInfo !== null, 30000);
      assert.ok(exited, 'supervisor did not exit within 30s of graceful shutdown');
      assert.strictEqual(state.exitInfo.code, 0,
        `graceful shutdown must exit 0 (got ${JSON.stringify(state.exitInfo)}; SIGABRT/134 = native-teardown regression)`);

      const gcDead = await waitFor(() => !pidAlive(state.gcPid), 12000);
      assert.ok(gcDead, 'node grandchild SURVIVED graceful shutdown — orphan leaked');
    } finally {
      cleanup(state);
    }
  });
});
