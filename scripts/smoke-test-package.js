#!/usr/bin/env node
'use strict';

// Smoke test for the npm package tarball.
// Packs the project, installs the tarball in a temp directory, then verifies:
//   - --version returns the correct version from package.json
//   - --help contains expected CLI options
//   - Both bin entries (ai-or-die, aiordie) are linked
//   - Key production files are present, dev/CI files excluded
//   - Native modules load (@lydell/node-pty, sherpa-onnx-node)
//   - Server starts and /api/health responds 200
//   - WebSocket connects and session creation works
//   - Terminal spawns and echoes a marker back (verifies PTY end-to-end)
//
// Usage: node scripts/smoke-test-package.js

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXPECTED_VERSION = require(path.join(PROJECT_ROOT, 'package.json')).version;
const PORT = 18924; // Distinct from binary smoke test (18923)
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
let installDir = null;
let child = null;
let childExited = null; // Promise that resolves when child exits

function assert(condition, msg, detail) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    if (detail) console.error(`        ${detail}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', timeout: 120000, ...opts }).trim();
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${urlPath}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('HTTP request timeout')); });
  });
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('WS connect timeout')); }, 10000);
    ws.on('open', () => {
      ws.once('message', (raw) => {
        clearTimeout(timeout);
        const msg = JSON.parse(raw.toString());
        resolve({ ws, msg });
      });
    });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

function wsSend(ws, data) {
  ws.send(JSON.stringify(data));
}

function waitForMessage(ws, type, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timeout waiting for "${type}"`)); }, timeoutMs);
    function onMessage(raw, isBinary) {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) { cleanup(); resolve(msg); }
    }
    function cleanup() { clearTimeout(timer); ws.removeListener('message', onMessage); }
    ws.on('message', onMessage);
  });
}

function collectMessages(ws, type, durationMs = 5000) {
  return new Promise((resolve) => {
    const collected = [];
    function onMessage(raw, isBinary) {
      if (isBinary) {
        if (type === 'output') collected.push({ type: 'output', data: raw.toString() });
        return;
      }
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) collected.push(msg);
    }
    ws.on('message', onMessage);
    setTimeout(() => { ws.removeListener('message', onMessage); resolve(collected); }, durationMs);
  });
}

async function waitForServer(maxWaitMs = 30000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < maxWaitMs) {
    try {
      await httpGet('/api/health');
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Server did not start within ${maxWaitMs}ms (last error: ${lastError?.message})`);
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

async function doCleanup() {
  if (child) {
    const proc = child;
    child = null;
    proc.kill();
    // Wait for process to actually exit (Windows ConPTY needs generous drain)
    try {
      await Promise.race([
        childExited,
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch { /* ok */ }
  }
  if (installDir) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.rmSync(installDir, { recursive: true, force: true });
        break;
      } catch {
        if (attempt === 2) console.warn('  Warning: could not fully clean temp directory');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

async function run() {
  // Step 1: npm pack
  console.log('\nStep 1: Creating tarball with npm pack');
  const packOutput = exec('npm pack --json', { cwd: PROJECT_ROOT });
  const packInfo = JSON.parse(packOutput);
  const entry = Array.isArray(packInfo) ? packInfo[0] : packInfo;
  assert(entry && typeof entry.filename === 'string', 'npm pack returned valid filename');
  const tarballName = entry.filename;
  const tarballPath = path.join(PROJECT_ROOT, tarballName);
  assert(fileExists(tarballPath), `Tarball created: ${tarballName}`);

  // Step 2: Install in temp directory
  console.log('\nStep 2: Installing tarball in temp directory');
  installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-or-die-pkg-test-'));
  exec('npm init -y', { cwd: installDir });
  exec(`npm install "${tarballPath}"`, { cwd: installDir });

  const pkgDir = path.join(installDir, 'node_modules', 'ai-or-die');
  assert(fileExists(pkgDir), 'Package installed in node_modules');

  try { fs.unlinkSync(tarballPath); } catch { /* ok */ }

  // Step 3: Verify --version
  console.log('\nStep 3: Verifying --version');
  const binScript = path.join(pkgDir, 'bin', 'ai-or-die.js');
  const versionOutput = exec(`node "${binScript}" --version`);
  assert(versionOutput === EXPECTED_VERSION, `--version returns "${versionOutput}" (expected "${EXPECTED_VERSION}")`);

  // Step 4: Verify --help
  console.log('\nStep 4: Verifying --help');
  const helpOutput = exec(`node "${binScript}" --help`);
  const expectedStrings = ['ai-or-die', '--port', '--auth', '--stt', '--tunnel', '--plan'];
  for (const s of expectedStrings) {
    assert(helpOutput.includes(s), `--help contains "${s}"`);
  }

  // Step 5: Verify bin entries
  console.log('\nStep 5: Verifying bin entries');
  const binDir = path.join(installDir, 'node_modules', '.bin');
  if (process.platform === 'win32') {
    assert(fileExists(path.join(binDir, 'ai-or-die.cmd')), 'bin/ai-or-die.cmd exists');
    assert(fileExists(path.join(binDir, 'aiordie.cmd')), 'bin/aiordie.cmd exists');
  } else {
    assert(fileExists(path.join(binDir, 'ai-or-die')), 'bin/ai-or-die exists');
    assert(fileExists(path.join(binDir, 'aiordie')), 'bin/aiordie exists');
  }

  // Step 6: Verify key production files present
  console.log('\nStep 6: Verifying production files present');
  const requiredFiles = [
    'bin/ai-or-die.js',
    'bin/supervisor.js',
    'src/server.js',
    'src/claude-bridge.js',
    'src/stt-engine.js',
    'src/tunnel-manager.js',
    'src/public/index.html',
    'src/public/app.js',
    'package.json',
  ];
  for (const f of requiredFiles) {
    assert(fileExists(path.join(pkgDir, f)), `Present: ${f}`);
  }

  // Step 7: Verify dev/CI files excluded
  console.log('\nStep 7: Verifying dev files excluded');
  const excludedPaths = [
    'test',
    'e2e',
    '.github',
    'docs',
    'scripts',
    'site',
    'CLAUDE.md',
    'AGENTS.md',
    'test-results',
  ];
  for (const f of excludedPaths) {
    assert(!fileExists(path.join(pkgDir, f)), `Excluded: ${f}`);
  }

  // Step 8: Verify native modules load from installed package
  // npm hoists deps to top-level node_modules, not inside the package dir
  console.log('\nStep 8: Verifying native modules load');
  const topModules = path.join(installDir, 'node_modules');

  // node-pty — required by all bridge modules for terminal sessions
  try {
    const pty = require(path.join(topModules, '@lydell', 'node-pty'));
    assert(typeof pty.spawn === 'function', 'node-pty loads and exports spawn()');
  } catch (err) {
    assert(false, 'node-pty loads', err.message);
  }

  // sherpa-onnx-node — required by STT worker for speech-to-text
  try {
    require(path.join(topModules, 'sherpa-onnx-node'));
    assert(true, 'sherpa-onnx-node loads');
  } catch (err) {
    assert(false, 'sherpa-onnx-node loads', err.message);
  }

  // Verify platform-specific sherpa binary exists
  const sherpaPlatform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const sherpaArch = os.arch();
  const sherpaPlatformPkg = `sherpa-onnx-${sherpaPlatform}-${sherpaArch}`;
  const sherpaPlatformDir = path.join(topModules, sherpaPlatformPkg);
  assert(fileExists(sherpaPlatformDir), `Platform package installed: ${sherpaPlatformPkg}`);

  // Step 9: Start server and verify /api/health
  console.log('\nStep 9: Starting server and verifying /api/health');
  child = spawn(process.execPath, [binScript, '--disable-auth', '--no-open', '--port', String(PORT)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' }
  });

  childExited = new Promise((resolve) => child.on('exit', resolve));

  let serverOutput = '';
  child.stdout.on('data', (d) => {
    serverOutput += d.toString();
    if (process.env.VERBOSE) process.stdout.write(`  [stdout] ${d}`);
  });
  child.stderr.on('data', (d) => {
    serverOutput += d.toString();
    if (process.env.VERBOSE) process.stderr.write(`  [stderr] ${d}`);
  });
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`\nServer exited early with code ${code}`);
      console.error('Output:\n' + serverOutput.slice(-2000));
    }
  });

  console.log('  Waiting for server...');
  await waitForServer();

  const health = await httpGet('/api/health');
  assert(health.status === 200, 'Health returns 200');
  assert(health.body && health.body.status === 'ok', 'Health status is ok',
    health.body ? `got: ${JSON.stringify(health.body)}` : 'empty body');

  // Step 10: WebSocket connection
  console.log('\nStep 10: WebSocket connection');
  const { ws, msg } = await connectWs();
  assert(msg.type === 'connected', 'Received connected message');
  assert(msg.connectionId, 'Has connectionId');

  // Step 11: Session creation
  console.log('\nStep 11: Session creation');
  wsSend(ws, { type: 'create_session', name: 'Package Smoke Test' });
  const created = await waitForMessage(ws, 'session_created');
  assert(created.sessionId, 'Session created with ID');

  // Step 12: Terminal start + echo round-trip (verifies node-pty end-to-end)
  console.log('\nStep 12: Terminal echo round-trip');
  const startedPromise = waitForMessage(ws, 'terminal_started', 15000);
  wsSend(ws, { type: 'start_terminal' });
  const started = await startedPromise;
  assert(started.type === 'terminal_started', 'Terminal started (node-pty working)');

  // Drain initial output (PowerShell startup on Windows CI can take 3-5s)
  await collectMessages(ws, 'output', 5000);

  // Send echo with unique marker
  const marker = `PKGTEST_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  wsSend(ws, { type: 'input', data: `echo ${marker}\n` });
  const outputs = await collectMessages(ws, 'output', 8000);
  const combined = outputs.map((m) => m.data).join('');
  assert(combined.includes(marker), `Terminal echoed marker "${marker}"`);

  // Cleanup WebSocket
  wsSend(ws, { type: 'stop' });
  try { await waitForMessage(ws, 'terminal_stopped', 10000); } catch { /* ok */ }
  ws.close();

  // Summary
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(40)}\n`);
}

run()
  .catch((err) => {
    console.error(`\nFATAL: ${err.message}`);
    if (err.stack) console.error(err.stack);
    failed++;
  })
  .finally(async () => {
    await doCleanup();
    process.exit(failed > 0 ? 1 : 0);
  });
