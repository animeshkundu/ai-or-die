'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const {
  closeProcServer,
  diagnosticRequest,
  requestJson,
  startProcServer,
} = require('../harness/proc-controller');
const { startServer } = require('../harness/server-controller');

function messageQueue(ws) {
  const queued = [];
  const waiters = new Map();
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let message;
    try { message = JSON.parse(raw.toString()); } catch (_) { return; }
    const wait = waiters.get(message.type);
    if (wait) {
      waiters.delete(message.type);
      clearTimeout(wait.timer);
      wait.resolve(message);
    } else {
      queued.push(message);
    }
  });
  return {
    wait(type, timeoutMs = 15000) {
      const index = queued.findIndex((message) => message.type === type);
      if (index !== -1) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(type);
          reject(new Error(`timeout waiting for ${type}`));
        }, timeoutMs);
        waiters.set(type, { resolve, timer });
      });
    },
  };
}

function closeWs(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      resolve();
    }, 2000);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.close();
  });
}

describe('session retention lifecycle probes', function () {
  this.timeout(120000);

  it('measures buffer ownership across PTY exit, disconnect, reconnect, and explicit delete', async function () {
    const fixture = path.join(__dirname, '..', '..', 'fixtures', 'synthetic-agent-output.js');
    const controller = await startProcServer({
      syntheticAgentFixture: fixture,
      env: {
        AOD_SYNTHETIC_OUTPUT_CHUNKS: '32',
        AOD_SYNTHETIC_OUTPUT_CHUNK_BYTES: String(64 * 1024),
      },
    });
    let first;
    let second;
    try {
      first = new WebSocket(controller.wsUrl);
      const firstMessages = messageQueue(first);
      await firstMessages.wait('connected');
      first.send(JSON.stringify({ type: 'create_session', name: 'lifecycle-output' }));
      const created = await firstMessages.wait('session_created');
      first.send(JSON.stringify({ type: 'start_claude' }));
      await firstMessages.wait('claude_started');
      await firstMessages.wait('exit');

      const afterExit = await diagnosticRequest(controller, '/api/_diag/gc', {
        method: 'POST',
        body: {},
      });
      assert.strictEqual(afterExit.body.sessions.total, 1);
      assert.strictEqual(afterExit.body.bridges.claudeBridge.sessions, 0);
      assert(afterExit.body.sessions.output_buffers.retained_bytes >= 1024 * 1024);

      const retainedAfterExit = afterExit.body.sessions.output_buffers.retained_bytes;
      await closeWs(first);
      first = null;
      const afterDisconnect = await diagnosticRequest(controller, '/api/_diag/gc', {
        method: 'POST',
        body: {},
      });
      assert.strictEqual(afterDisconnect.body.sessions.connected_clients, 0);
      assert.strictEqual(afterDisconnect.body.sessions.total, 1);
      assert.strictEqual(afterDisconnect.body.sessions.output_buffers.retained_bytes, retainedAfterExit);

      second = new WebSocket(`${controller.wsUrl}/?sessionId=${encodeURIComponent(created.sessionId)}`);
      const secondMessages = messageQueue(second);
      await secondMessages.wait('connected');
      await secondMessages.wait('session_joined');
      const afterReconnect = await diagnosticRequest(controller, '/api/_diag/counters');
      assert.strictEqual(afterReconnect.body.sessions.total, 1);
      assert.strictEqual(afterReconnect.body.sessions.connected_clients, 1);
      assert.strictEqual(afterReconnect.body.sessions.output_buffers.retained_bytes, retainedAfterExit);

      const deleted = await requestJson(
        `${controller.baseUrl}/api/sessions/${created.sessionId}`,
        { method: 'DELETE' },
      );
      assert.strictEqual(deleted.statusCode, 200);
      const afterDelete = await diagnosticRequest(controller, '/api/_diag/gc', {
        method: 'POST',
        body: {},
      });
      assert.strictEqual(afterDelete.body.sessions.total, 0);
      assert.strictEqual(afterDelete.body.sessions.output_buffers.backing_slots, 0);
      assert.strictEqual(afterDelete.body.sessions.output_buffers.retained_bytes, 0);
    } finally {
      if (first) await closeWs(first);
      if (second) await closeWs(second);
      await closeProcServer(controller);
    }
  });

  it('releases the session buffer during the seven-day eviction sweep', async function () {
    const controller = await startServer({
      serverOpts: { stt: false, stickyNotes: false, keepalive: false },
    });
    try {
      const created = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ name: 'stale-session', workingDir: controller.workDir });
        const req = http.request(`${controller.baseUrl}/api/sessions/create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        });
        req.on('error', reject);
        req.end(body);
      });
      const session = controller.server.claudeSessions.get(created.sessionId);
      session.outputBuffer.push('retained-output');
      session.lastActivity = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      controller.server._pushEvictionEntry(created.sessionId);
      const evicted = await controller.server._evictStaleSessions();
      assert.strictEqual(evicted, 1);
      assert.strictEqual(controller.server.claudeSessions.has(created.sessionId), false);
    } finally {
      await controller.close();
    }
  });
});
