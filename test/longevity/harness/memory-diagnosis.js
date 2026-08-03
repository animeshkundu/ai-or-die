'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

const {
  closeProcServer,
  diagnosticRequest,
  requestJson,
  startProcServer,
  supervisorDiagnostics,
} = require('./proc-controller');
const { sampleProcessTree } = require('./process-tree-sampler');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function waitForWsMessage(ws, type, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    const onMessage = (raw, isBinary) => {
      if (isBinary) return;
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (message.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      ws.removeListener('error', onError);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

async function createThenDisconnect(wsUrl, index) {
  const ws = new WebSocket(wsUrl);
  try {
    await waitForWsMessage(ws, 'connected');
    const created = waitForWsMessage(ws, 'session_created');
    ws.send(JSON.stringify({ type: 'create_session', name: `memory-diagnosis-${index}` }));
    await created;
  } finally {
    await new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch (_) {}
        resolve();
      }, 2000);
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try { ws.close(); } catch (_) { resolve(); }
    });
  }
}

async function runSessionOperations(controller, options) {
  const intervalMs = options.ratePerSecond > 0 ? 1000 / options.ratePerSecond : 0;
  for (let i = 0; i < options.operations; i++) {
    const started = Date.now();
    await createThenDisconnect(controller.wsUrl, i);
    const remaining = intervalMs - (Date.now() - started);
    if (remaining > 0) await sleep(remaining);
  }
}

async function runArtifactOperations(controller, options) {
  const artifact = path.join(controller.workDir, 'memory-diagnosis-artifact.html');
  fs.writeFileSync(artifact, '<!doctype html><title>memory diagnosis</title><p>probe</p>');
  const payload = 'x'.repeat(options.payloadBytes || 1024);
  for (let i = 0; i < options.operations; i++) {
    const id = `memory-diagnosis-artifact-${i}`;
    const open = await requestJson(`${controller.baseUrl}/api/artifact/${id}/open`, {
      method: 'POST',
      body: { file: artifact },
    });
    if (open.statusCode !== 200) throw new Error(`artifact open ${i}: HTTP ${open.statusCode}`);
    const prompts = await requestJson(`${controller.baseUrl}/api/artifact/${id}/prompts`, {
      method: 'POST',
      body: { prompts: [{ prompt: payload }], domSnapshot: payload },
    });
    if (prompts.statusCode !== 200) throw new Error(`artifact prompts ${i}: HTTP ${prompts.statusCode}`);
    const reply = await requestJson(`${controller.baseUrl}/api/artifact/${id}/agent-reply`, {
      method: 'POST',
      body: { text: payload },
    });
    if (reply.statusCode !== 200) throw new Error(`artifact reply ${i}: HTTP ${reply.statusCode}`);
    const end = await requestJson(`${controller.baseUrl}/api/artifact/${id}/end`, {
      method: 'POST',
      body: {},
    });
    if (end.statusCode !== 200) throw new Error(`artifact end ${i}: HTTP ${end.statusCode}`);
  }
}

async function runPtyOperations(controller) {
  const ws = new WebSocket(controller.wsUrl);
  try {
    await waitForWsMessage(ws, 'connected');
    const created = waitForWsMessage(ws, 'session_created');
    ws.send(JSON.stringify({ type: 'create_session', name: 'memory-diagnosis-pty' }));
    await created;
    const started = waitForWsMessage(ws, 'claude_started');
    ws.send(JSON.stringify({ type: 'start_claude' }));
    await started;
    await waitForWsMessage(ws, 'exit', 30000);
  } finally {
    await new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch (_) {}
        resolve();
      }, 2000);
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try { ws.close(); } catch (_) { resolve(); }
    });
  }
}

async function capture(controller, phase, repeat, operationCount) {
  const [gc, supervisor, tree] = await Promise.all([
    diagnosticRequest(controller, '/api/_diag/gc', { method: 'POST', body: {} }),
    supervisorDiagnostics(controller),
    sampleProcessTree(controller.supervisorPid),
  ]);
  if (gc.statusCode !== 200) {
    throw new Error(`post-GC capture failed: HTTP ${gc.statusCode} ${JSON.stringify(gc.body)}`);
  }
  return {
    ts: new Date().toISOString(),
    phase,
    repeat,
    operations: operationCount,
    server: gc.body,
    supervisor,
    process_tree: tree,
  };
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeRuns(arm, runs, operations, ratePerSecond) {
  const deltas = runs.map((run) =>
    run.after.server.process.memory.heapUsed - run.before.server.process.memory.heapUsed);
  const controlDeltas = runs.map((run) =>
    run.control_after.server.process.memory.heapUsed - run.control_before.server.process.memory.heapUsed);
  const net = deltas.map((delta, index) => delta - controlDeltas[index]);
  const bytesPerOperation = operations > 0 ? net.map((value) => value / operations) : net;
  const elapsedHours = runs.map((run) => (run.workload_finished_ms - run.workload_started_ms) / 3600000);
  const mbPerHour = net.map((value, index) => (value / (1024 * 1024)) / elapsedHours[index]);
  const effectiveRate = operations /
    median(runs.map((run) => (run.workload_finished_ms - run.workload_started_ms) / 1000));
  return {
    arm,
    operations,
    repeats: runs.length,
    requested_rate_per_second: ratePerSecond,
    effective_rate_per_second: effectiveRate,
    post_gc_heap_delta_bytes: {
      median: median(net),
      min: Math.min(...net),
      max: Math.max(...net),
    },
    bytes_per_operation: {
      median: median(bytesPerOperation),
      min: Math.min(...bytesPerOperation),
      max: Math.max(...bytesPerOperation),
    },
    mb_per_hour: {
      median: median(mbPerHour),
      min: Math.min(...mbPerHour),
      max: Math.max(...mbPerHour),
    },
    control_delta_bytes: {
      median: median(controlDeltas),
      min: Math.min(...controlDeltas),
      max: Math.max(...controlDeltas),
    },
  };
}

async function runOne(options, repeat, workload) {
  const controller = await startProcServer({
    diagToken: options.diagToken,
    env: options.env,
    syntheticAgentFixture: options.syntheticAgentFixture,
  });
  try {
    await sleep(options.warmupMs);
    const beforeMs = Date.now();
    const before = await capture(controller, 'before', repeat, 0);
    const workloadStartedMs = Date.now();
    await workload(controller, options);
    const workloadFinishedMs = Date.now();
    await sleep(options.drainMs);
    const after = await capture(controller, 'after', repeat, options.operations);
    const afterMs = Date.now();
    return {
      before,
      after,
      before_ms: beforeMs,
      after_ms: afterMs,
      workload_started_ms: workloadStartedMs,
      workload_finished_ms: workloadFinishedMs,
    };
  } finally {
    await closeProcServer(controller);
  }
}

async function runMemoryDiagnosis(options = {}) {
  const cfg = {
    arm: options.arm || 'sessions',
    operations: options.operations == null ? 250 : Number(options.operations),
    repeats: options.repeats == null ? 3 : Number(options.repeats),
    ratePerSecond: options.ratePerSecond == null ? 0 : Number(options.ratePerSecond),
    warmupMs: options.warmupMs == null ? 500 : Number(options.warmupMs),
    drainMs: options.drainMs == null ? 500 : Number(options.drainMs),
    controlMs: options.controlMs == null ? 250 : Number(options.controlMs),
    payloadBytes: options.payloadBytes == null ? 1024 : Number(options.payloadBytes),
    diagToken: options.diagToken,
  };
  const workloads = {
    sessions: runSessionOperations,
    artifacts: runArtifactOperations,
    pty: runPtyOperations,
  };
  const workload = workloads[cfg.arm];
  if (!workload) throw new Error(`unknown diagnosis arm: ${cfg.arm}`);
  if (!(cfg.repeats >= 3)) throw new Error('memory diagnosis requires at least 3 repeats');
  if (!(cfg.operations > 0)) throw new Error('memory diagnosis requires operations > 0');
  if (cfg.arm === 'pty') {
    const fixture = path.join(__dirname, '..', '..', 'fixtures', 'synthetic-agent-output.js');
    cfg.syntheticAgentFixture = fixture;
    cfg.env = {
      AOD_SYNTHETIC_OUTPUT_CHUNKS: String(cfg.operations),
      AOD_SYNTHETIC_OUTPUT_CHUNK_BYTES: String(cfg.payloadBytes),
    };
  }

  const runs = [];
  for (let repeat = 0; repeat < cfg.repeats; repeat++) {
    const control = await runOne(
      { ...cfg, operations: 0, drainMs: cfg.controlMs },
      repeat,
      async () => sleep(cfg.controlMs),
    );
    const measured = await runOne(cfg, repeat, workload);
    runs.push({
      ...measured,
      control_before: control.before,
      control_after: control.after,
    });
  }

  const publicConfig = { ...cfg };
  delete publicConfig.env;
  delete publicConfig.diagToken;
  delete publicConfig.syntheticAgentFixture;
  return {
    metadata: {
      captured_at: new Date().toISOString(),
      head: currentHead(),
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      config: publicConfig,
    },
    summary: summarizeRuns(cfg.arm, runs, cfg.operations, cfg.ratePerSecond),
    runs,
  };
}

module.exports = {
  capture,
  createThenDisconnect,
  runMemoryDiagnosis,
  summarizeRuns,
};
