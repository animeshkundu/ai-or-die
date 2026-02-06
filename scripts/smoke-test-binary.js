#!/usr/bin/env node
'use strict';

// Smoke test for the SEA binary.
// Starts the binary, connects via WebSocket, and verifies core functionality:
//   - Health endpoint responds
//   - WebSocket connection works
//   - Session creation works
//   - Terminal starts and echoes a marker back
//
// Usage: node scripts/test-binary.js <path-to-binary>

const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const binaryPath = process.argv[2];
if (!binaryPath) {
  console.error('Usage: node scripts/test-binary.js <path-to-binary>');
  process.exit(1);
}

const PORT = 18923; // Fixed port for smoke test
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
let child;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${urlPath}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
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
    function onMessage(raw) {
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
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) collected.push(msg);
    }
    ws.on('message', onMessage);
    setTimeout(() => { ws.removeListener('message', onMessage); resolve(collected); }, durationMs);
  });
}

async function waitForServer(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await httpGet('/api/health');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('Server did not start within timeout');
}

async function run() {
  console.log(`\nStarting binary: ${binaryPath}`);
  child = spawn(binaryPath, ['--disable-auth', '--port', String(PORT)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' }
  });

  let serverOutput = '';
  child.stdout.on('data', (d) => {
    serverOutput += d.toString();
    if (process.env.VERBOSE) process.stdout.write(`  [stdout] ${d}`);
  });
  child.stderr.on('data', (d) => {
    serverOutput += d.toString();
    process.stderr.write(`  [binary] ${d}`);
  });
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`\nBinary exited early with code ${code}`);
      console.error('Output:\n' + serverOutput.slice(-2000));
    }
  });

  console.log('Waiting for server to be ready...');
  await waitForServer();
  console.log('Server is ready.\n');

  // Test 1: Health endpoint
  console.log('Test: Health endpoint');
  const health = await httpGet('/api/health');
  assert(health.status === 200, 'Health returns 200');
  assert(health.body.status === 'ok', 'Health status is ok');

  // Test 2: WebSocket connection
  console.log('Test: WebSocket connection');
  const { ws, msg } = await connectWs();
  assert(msg.type === 'connected', 'Received connected message');
  assert(msg.connectionId, 'Has connectionId');

  // Test 3: Session creation
  console.log('Test: Session creation');
  wsSend(ws, { type: 'create_session', name: 'Binary Smoke Test' });
  const created = await waitForMessage(ws, 'session_created');
  assert(created.sessionId, 'Session created with ID');

  // Test 4: Terminal start + echo round-trip
  console.log('Test: Terminal echo round-trip');
  const startedPromise = waitForMessage(ws, 'terminal_started', 15000);
  wsSend(ws, { type: 'start_terminal' });
  const started = await startedPromise;
  assert(started.type === 'terminal_started', 'Terminal started');

  // Drain initial output
  await collectMessages(ws, 'output', 3000);

  // Send echo with unique marker
  const marker = `SMOKE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  wsSend(ws, { type: 'input', data: `echo ${marker}\n` });
  const outputs = await collectMessages(ws, 'output', 5000);
  const combined = outputs.map((m) => m.data).join('');
  assert(combined.includes(marker), `Terminal echoed marker "${marker}"`);

  // Cleanup
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
    failed++;
  })
  .finally(() => {
    if (child) child.kill();
    process.exit(failed > 0 ? 1 : 0);
  });
