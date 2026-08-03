'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const supervisorScript = path.join(__dirname, '..', '..', '..', 'bin', 'supervisor.js');
const stateByController = new WeakMap();

function allocatePort() {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const server = net.createServer();
      server.unref();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => {
          if (port <= 11000) attempt();
          else resolve(port);
        });
      });
    };
    attempt();
  });
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        } : {}),
        ...(options.headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsedBody = text;
        try { parsedBody = JSON.parse(text); } catch (_) { /* preserve text */ }
        resolve({ statusCode: res.statusCode, body: parsedBody });
      });
    });
    req.setTimeout(options.timeoutMs || 5000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForReady(baseUrl, timeoutMs, getFailureContext) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await requestJson(`${baseUrl}/api/health`, { timeoutMs: 2000 });
      if (response.statusCode === 200) return;
      lastError = new Error(`health returned ${response.statusCode}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `server did not become ready within ${timeoutMs}ms: ${lastError && lastError.message}\n` +
    getFailureContext(),
  );
}

function appendBounded(current, chunk, cap = 64 * 1024) {
  const next = current + chunk.toString();
  return next.length > cap ? next.slice(-cap) : next;
}

async function startProcServer(options = {}) {
  const port = options.port || await allocatePort();
  if (port <= 11000) throw new Error(`startProcServer: port ${port} must be above 11000`);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aod-proc-soak-'));
  const workDir = path.join(tmpRoot, 'work');
  const storageDir = path.join(tmpRoot, 'storage');
  const snapshotDir = path.join(tmpRoot, 'snapshots');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(snapshotDir, { recursive: true });
  const childEnv = { ...(options.env || {}) };
  if (options.syntheticAgentFixture) {
    const fixtureName = 'synthetic-agent-output.js';
    fs.copyFileSync(options.syntheticAgentFixture, path.join(workDir, fixtureName));
    childEnv.AIORDIE_CLAUDE_LAUNCHER = `node ${fixtureName}`;
  }

  const diagToken = options.diagToken || crypto.randomBytes(24).toString('hex');
  const child = spawn(process.execPath, [
    supervisorScript,
    '--port', String(port),
    '--disable-auth',
    '--no-stt',
    '--no-sticky-notes',
    '--no-keepalive',
  ], {
    cwd: workDir,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      AI_OR_DIE_SESSION_DIR: storageDir,
      AOD_DIAG_ENABLED: '1',
      AOD_DIAG_TOKEN: diagToken,
      AOD_DIAG_SNAPSHOT_DIR: snapshotDir,
      AIORDIE_DISABLE_KEEPALIVE: '1',
      STT_DISABLED: '1',
      STICKY_NOTES_DISABLED: '1',
      ...childEnv,
    },
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output = appendBounded(output, chunk); });
  child.stderr.on('data', (chunk) => { output = appendBounded(output, chunk); });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(baseUrl, options.timeoutMs || 90000, () => output);
    const counters = await requestJson(`${baseUrl}/api/_diag/counters`, {
      headers: { 'x-aod-diag-token': diagToken },
    });
    if (counters.statusCode !== 200 || !counters.body.process || !counters.body.process.pid) {
      throw new Error(`diagnostic handshake failed: HTTP ${counters.statusCode}`);
    }

    const controller = {
      baseUrl,
      wsUrl: `ws://127.0.0.1:${port}`,
      workDir,
      supervisorPid: child.pid,
      serverPid: counters.body.process.pid,
    };
    stateByController.set(controller, {
      child,
      diagToken,
      tmpRoot,
      snapshotDir,
      output: () => output,
    });
    return controller;
  } catch (error) {
    await stopChild(child);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
    throw error;
  }
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once('exit', finish);
    try {
      if (child.connected) child.send({ type: 'shutdown' }, () => {});
    } catch (_) { /* closed IPC */ }
    timer = setTimeout(() => {
      if (process.platform === 'win32') {
        execFile('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], () => finish());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* already gone */ }
        finish();
      }
    }, 25000);
    if (timer.unref) timer.unref();
  });
}

async function closeProcServer(controller) {
  const state = stateByController.get(controller);
  if (!state) return;
  stateByController.delete(controller);
  await stopChild(state.child);
  try { fs.rmSync(state.tmpRoot, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
}

function diagnosticRequest(controller, pathname, options = {}) {
  const state = stateByController.get(controller);
  if (!state) return Promise.reject(new Error('unknown or closed process controller'));
  return requestJson(`${controller.baseUrl}${pathname}`, {
    ...options,
    headers: {
      'x-aod-diag-token': state.diagToken,
      ...(options.headers || {}),
    },
  });
}

function supervisorDiagnostics(controller, timeoutMs = 3000) {
  const state = stateByController.get(controller);
  if (!state || !state.child.connected) return Promise.resolve(null);
  const id = crypto.randomBytes(8).toString('hex');
  return new Promise((resolve) => {
    const onMessage = (message) => {
      if (!message || message.type !== 'diagnostics' || message.id !== id) return;
      clearTimeout(timer);
      state.child.removeListener('message', onMessage);
      resolve(message.diagnostics);
    };
    const timer = setTimeout(() => {
      state.child.removeListener('message', onMessage);
      resolve(null);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    state.child.on('message', onMessage);
    try {
      state.child.send({ type: 'diagnostics', id, token: state.diagToken }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        state.child.removeListener('message', onMessage);
        resolve(null);
      });
    } catch (_) {
      clearTimeout(timer);
      state.child.removeListener('message', onMessage);
      resolve(null);
    }
  });
}

function controllerOutput(controller) {
  const state = stateByController.get(controller);
  return state ? state.output() : '';
}

module.exports = {
  allocatePort,
  closeProcServer,
  controllerOutput,
  diagnosticRequest,
  requestJson,
  startProcServer,
  supervisorDiagnostics,
};
