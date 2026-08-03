#!/usr/bin/env node

'use strict';

const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const v8 = require('v8');

const StickyNoteSummarizer = require('../../../src/sticky-note-summarizer');
const { VSCodeTunnelManager } = require('../../../src/vscode-tunnel');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.pid = 12345;
  }

  kill() {
    process.nextTick(() => this.emit('exit', 0));
  }
}

function gcSample() {
  if (typeof global.gc !== 'function') throw new Error('component probe requires --expose-gc');
  global.gc();
  global.gc();
  return {
    pid: process.pid,
    memory: process.memoryUsage(),
    heap_spaces: v8.getHeapSpaceStatistics(),
  };
}

async function stickyProbe(operations, payloadBytes) {
  const transcript = {
    dispose() {},
    newLineCount() { return 0; },
    resize() {},
    snapshot() { return Promise.resolve(''); },
    write() {},
  };
  const summarizer = new StickyNoteSummarizer({
    engine: { isReady: () => false, getStatus: () => 'unavailable' },
    createTranscript: () => transcript,
    timers: { set: () => ({ id: 1 }), clear: () => {} },
  });
  summarizer.enable('probe');
  const before = gcSample();
  const payload = 'x'.repeat(payloadBytes);
  for (let i = 0; i < operations; i++) summarizer.feedTurns('probe', payload);
  summarizer._attempt('probe', 'turn');
  const retainedBytes = Buffer.byteLength(summarizer._states.get('probe').pendingText, 'utf8');
  const after = gcSample();
  return { before, after, ownership_counter: retainedBytes };
}

async function vscodeProbe(operations, payloadBytes) {
  const children = [];
  const manager = new VSCodeTunnelManager({
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  await manager._initPromise;
  manager._command = 'fake-code';
  manager._available = true;
  const sessionId = 'component-probe';
  const tunnel = {
    serverProcess: null,
    tunnelProcess: null,
    _loginProcess: null,
    localPort: 19191,
    connectionToken: 'token',
    localUrl: null,
    publicUrl: null,
    tunnelId: sessionId,
    status: 'starting',
    sessionId,
    workingDir: process.cwd(),
    retryCount: 0,
    stopping: false,
    _lastSpawnTime: null,
    _totalRestarts: 0,
    _stabilityTimer: null,
    _restartDelayTimer: null,
    _restartDelayResolve: null,
    _whichDied: null,
  };
  manager.tunnels.set(sessionId, tunnel);
  const started = manager._spawnServer(sessionId);
  children[0].stdout.emit('data', Buffer.from('Web UI available at http://localhost:19191\n'));
  await started;
  const before = gcSample();
  const payload = Buffer.alloc(payloadBytes, 0x78);
  for (let i = 0; i < operations; i++) children[0].stdout.emit('data', payload);
  const after = gcSample();
  return { before, after, ownership_counter: tunnel._diagnosticServerStdoutChars };
}

async function childMain(args) {
  const arm = args[0];
  const operations = Number(args[1]);
  const payloadBytes = Number(args[2]);
  let result;
  if (arm === 'sticky') result = await stickyProbe(operations, payloadBytes);
  else if (arm === 'vscode') result = await vscodeProbe(operations, payloadBytes);
  else if (arm === 'noop') {
    const before = gcSample();
    await new Promise((resolve) => setTimeout(resolve, 25));
    result = { before, after: gcSample(), ownership_counter: 0 };
  } else {
    throw new Error(`unknown component arm ${arm}`);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

function runChild(arm, operations, payloadBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--expose-gc',
      __filename,
      '--child',
      arm,
      String(operations),
      String(payloadBytes),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, AOD_DIAG_ENABLED: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`component child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout.trim().split('\n').pop())); }
      catch (error) { reject(new Error(`component child JSON: ${error.message}\n${stdout}\n${stderr}`)); }
    });
  });
}

function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function currentHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.join(__dirname, '..', '..', '..'),
      encoding: 'utf8',
    }).trim();
  } catch (_) {
    return process.env.GITHUB_SHA || null;
  }
}

async function runParent(args) {
  const arm = args.arm || 'sticky';
  const operations = Number(args.operations || 100);
  const payloadBytes = Number(args['payload-bytes'] || 1024);
  const repeats = Number(args.repeats || 3);
  if (repeats < 3) throw new Error('component probe requires at least 3 repeats');
  const runs = [];
  for (let i = 0; i < repeats; i++) {
    const control = await runChild('noop', 0, 0);
    const measured = await runChild(arm, operations, payloadBytes);
    runs.push({ repeat: i, control, measured });
  }
  const net = runs.map((run) =>
    (run.measured.after.memory.heapUsed - run.measured.before.memory.heapUsed) -
    (run.control.after.memory.heapUsed - run.control.before.memory.heapUsed));
  const output = {
    metadata: {
      captured_at: new Date().toISOString(),
      head: currentHead(),
      node_version: process.version,
      platform: process.platform,
      arm,
      operations,
      payload_bytes: payloadBytes,
      repeats,
    },
    summary: {
      post_gc_heap_delta_bytes: stats(net),
      bytes_per_operation: stats(net.map((value) => value / operations)),
      ownership_counter: stats(runs.map((run) => run.measured.ownership_counter)),
    },
    runs,
  };
  const target = path.resolve(args.out || `component-${arm}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(output, null, 2));
  process.stdout.write(JSON.stringify({ output: target, summary: output.summary }, null, 2) + '\n');
}

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const index = raw.indexOf('=');
    args[index === -1 ? raw.slice(2) : raw.slice(2, index)] =
      index === -1 ? true : raw.slice(index + 1);
  }
  return args;
}

if (process.argv[2] === '--child') {
  childMain(process.argv.slice(3)).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
} else if (require.main === module) {
  runParent(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { runChild, stats };
