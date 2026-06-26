'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const { createControlRouter, parseCursor, encodeCursor } = require('../../src/control/routes');
const { ControlEventBus } = require('../../src/control/event-bus');

function buildServer(deps) {
  const app = express();
  app.use(express.json());
  app.use('/api/control', createControlRouter(deps));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => res.status(500).json({ error: { code: 'INTERNAL', message: err.message } }));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function fakeDeps(overrides = {}) {
  const sessions = new Map([
    ['s1', { name: 'one', agent: 'claude', active: true, workingDir: '/w', lastActivity: 1 }],
    ['s2', { name: 'two', agent: 'terminal', active: false, workingDir: '/w', lastActivity: 2 }],
  ]);
  return Object.assign(
    {
      sessions,
      getStatusSignal: (id) =>
        id === 's1'
          ? { hadOutput: true, jsonl: { bound: true, endsOnAssistant: true, lastTurnEndedAt: 99 } }
          : { hadOutput: true },
      readTail: async (id, lines) => ({ text: `tail of ${id} (${lines})`, truncated: false, source: 'transcript' }),
      eventBus: new ControlEventBus(),
      createSession: async (opts) => ({ sessionId: 'new1', lifecycle: 'starting', name: opts.name || null }),
      stopSession: async (id, mode) => ({ stopped: true, lifecycle: 'exited', mode }),
      sendMessage: async (opts) => ({
        messageId: 'm1',
        delivered: true,
        confirmed: false,
        confidence: 'medium',
        interactionState: 'idle',
        sessionStateSeq: 0,
        duplicated: false,
        received: opts,
      }),
      sendKeys: async (opts) => ({ keysId: 'k1', delivered: true, duplicated: false, received: opts }),
      respond: async (opts) => ({ delivered: true, awaitingKind: 'choice_question', mappedKeys: '1\r', duplicated: false, received: opts }),
    },
    overrides
  );
}

async function getJson(port, pathname) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return { status: r.status, body: await r.json() };
}
async function postJson(port, pathname, body) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
}

describe('control/routes /api/control', function () {
  it('GET /sessions returns summaries with derived lifecycle/state', async function () {
    const { server, port } = await listen(buildServer(fakeDeps()));
    try {
      const { status, body } = await getJson(port, '/api/control/sessions');
      assert.equal(status, 200);
      assert.equal(body.sessions.length, 2);
      const s1 = body.sessions.find((s) => s.sessionId === 's1');
      assert.equal(s1.lifecycle, 'running');
      assert.equal(s1.interactionState, 'idle');
      assert.equal(s1.canAcceptInput, true);
      const s2 = body.sessions.find((s) => s.sessionId === 's2');
      assert.equal(s2.lifecycle, 'exited');
    } finally {
      server.close();
    }
  });

  it('GET /sessions/:id/status 200 + 404', async function () {
    const { server, port } = await listen(buildServer(fakeDeps()));
    try {
      const ok = await getJson(port, '/api/control/sessions/s1/status');
      assert.equal(ok.status, 200);
      assert.equal(ok.body.status.confidence, 'high');
      assert.equal(ok.body.status.awaiting.kind, 'next_message');
      const missing = await getJson(port, '/api/control/sessions/nope/status');
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.code, 'SESSION_NOT_FOUND');
    } finally {
      server.close();
    }
  });

  it('GET /sessions/:id/read returns tail + status; lines=0 is status-only', async function () {
    const { server, port } = await listen(buildServer(fakeDeps()));
    try {
      const full = await getJson(port, '/api/control/sessions/s1/read?lines=40');
      assert.equal(full.status, 200);
      assert.match(full.body.text, /tail of s1 \(40\)/);
      assert.equal(full.body.status.lifecycle, 'running');
      const statusOnly = await getJson(port, '/api/control/sessions/s1/read?lines=0');
      assert.equal(statusOnly.body.text, '');
      assert.equal(statusOnly.body.source, 'none');
    } finally {
      server.close();
    }
  });

  it('POST /sessions/create and /stop', async function () {
    let stopKey;
    const { server, port } = await listen(buildServer(fakeDeps({
      stopSession: async (id, mode, idempotencyKey) => {
        stopKey = idempotencyKey;
        return { stopped: true, lifecycle: 'exited', mode };
      },
    })));
    try {
      const created = await postJson(port, '/api/control/sessions/create', { name: 'x' });
      assert.equal(created.status, 200);
      assert.equal(created.body.sessionId, 'new1');
      const stopped = await postJson(port, '/api/control/sessions/s1/stop', { mode: 'kill', idempotencyKey: 'stop-1' });
      assert.equal(stopped.body.stopped, true);
      assert.equal(stopped.body.mode, 'kill');
      assert.equal(stopKey, 'stop-1');
      const missing = await postJson(port, '/api/control/sessions/nope/stop', {});
      assert.equal(missing.status, 404);
    } finally {
      server.close();
    }
  });

  it('POST /sessions/create and /stop preserve idempotent results from deps', async function () {
    let createCalls = 0;
    let stopCalls = 0;
    const createCache = new Map();
    const stopCache = new Map();
    const deps = fakeDeps({
      createSession: async (opts) => {
        if (opts.idempotencyKey && createCache.has(opts.idempotencyKey)) {
          return { ...createCache.get(opts.idempotencyKey), duplicated: true };
        }
        createCalls++;
        const out = {
          sessionId: `new-${createCalls}`,
          lifecycle: 'created',
          name: opts.name || null,
          duplicated: false,
        };
        if (opts.idempotencyKey) createCache.set(opts.idempotencyKey, out);
        return out;
      },
      stopSession: async (id, mode, idempotencyKey) => {
        const key = idempotencyKey ? `${id}:${idempotencyKey}` : null;
        if (key && stopCache.has(key)) return { ...stopCache.get(key), duplicated: true };
        stopCalls++;
        const out = { stopped: true, lifecycle: 'exited', mode, duplicated: false };
        if (key) stopCache.set(key, out);
        return out;
      },
    });
    const { server, port } = await listen(buildServer(deps));
    try {
      const createBody = { name: 'x', idempotencyKey: 'create-key' };
      const created1 = await postJson(port, '/api/control/sessions/create', createBody);
      const created2 = await postJson(port, '/api/control/sessions/create', createBody);
      assert.equal(created1.status, 200);
      assert.equal(created2.status, 200);
      assert.equal(createCalls, 1);
      assert.equal(created2.body.sessionId, created1.body.sessionId);
      assert.equal(created1.body.duplicated, false);
      assert.equal(created2.body.duplicated, true);

      const stopBody = { mode: 'kill', idempotencyKey: 'stop-key' };
      const stopped1 = await postJson(port, '/api/control/sessions/s1/stop', stopBody);
      const stopped2 = await postJson(port, '/api/control/sessions/s1/stop', stopBody);
      assert.equal(stopped1.status, 200);
      assert.equal(stopped2.status, 200);
      assert.equal(stopCalls, 1);
      assert.equal(stopped1.body.duplicated, false);
      assert.equal(stopped2.body.duplicated, true);
    } finally {
      server.close();
    }
  });

  it('GET /events long-polls and returns appended events with a cursor', async function () {
    const deps = fakeDeps();
    const { server, port } = await listen(buildServer(deps));
    try {
      const head = deps.eventBus.headCursor();
      const pending = getJson(
        port,
        `/api/control/events?cursor=${encodeURIComponent(encodeCursor(head))}&timeoutMs=1000`
      );
      setTimeout(() => deps.eventBus.append('s1', 'turn_ended'), 20);
      const { status, body } = await pending;
      assert.equal(status, 200);
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].kind, 'turn_ended');
      assert.ok(typeof body.cursor === 'string' && body.cursor.includes(':'));
    } finally {
      server.close();
    }
  });

  it('rate-limits control requests per token', async function () {
    const { server, port } = await listen(buildServer(fakeDeps({
      rateLimit: { max: 2, windowMs: 60000 },
    })));
    try {
      const first = await getJson(port, '/api/control/sessions?token=tok-a');
      const second = await getJson(port, '/api/control/sessions/s1/status?token=tok-a');
      const limited = await getJson(port, '/api/control/sessions?token=tok-a');
      const fresh = await getJson(port, '/api/control/sessions?token=tok-b');

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(limited.status, 429);
      assert.equal(limited.body.error.code, 'RATE_LIMITED');
      assert.ok(limited.body.error.retryAfterMs > 0);
      assert.equal(fresh.status, 200);
    } finally {
      server.close();
    }
  });

  it('does not count held event long-polls against the rate limit', async function () {
    const deps = fakeDeps({ rateLimit: { max: 1, windowMs: 60000 } });
    const { server, port } = await listen(buildServer(deps));
    try {
      const head = deps.eventBus.headCursor();
      const pending = getJson(
        port,
        `/api/control/events?token=event-token&cursor=${encodeURIComponent(encodeCursor(head))}&timeoutMs=50`
      );
      const sessions = await getJson(port, '/api/control/sessions?token=event-token');
      const limited = await getJson(port, '/api/control/sessions?token=event-token');
      const events = await pending;

      assert.equal(sessions.status, 200);
      assert.equal(limited.status, 429);
      assert.equal(events.status, 200);
    } finally {
      server.close();
    }
  });

  it('POST /sessions/:id/message is idempotent at the router and does not double-call deps', async function () {
    let calls = 0;
    const deps = fakeDeps({
      sendMessage: async (opts) => {
        calls++;
        return {
          messageId: 'msg-1',
          delivered: true,
          confirmed: false,
          confidence: 'medium',
          interactionState: 'idle',
          sessionStateSeq: 0,
          duplicated: false,
          received: opts,
        };
      },
    });
    const { server, port } = await listen(buildServer(deps));
    try {
      const body = { message: 'hello', idempotencyKey: 'same-key', awaitMs: 0 };
      const first = await postJson(port, '/api/control/sessions/s1/message', body);
      const second = await postJson(port, '/api/control/sessions/s1/message', body);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(calls, 1);
      assert.equal(first.body.duplicated, false);
      assert.equal(second.body.duplicated, true);
      assert.equal(second.body.messageId, 'msg-1');
    } finally {
      server.close();
    }
  });

  it('POST /sessions/:id/keys forwards named keys to the injected sender', async function () {
    let received;
    const deps = fakeDeps({
      sendKeys: async (opts) => {
        received = opts;
        const bytes = opts.raw ? opts.keys : (opts.keys === 'Enter' ? '\r' : opts.keys);
        return { keysId: 'keys-1', delivered: true, duplicated: false, bytes };
      },
    });
    const { server, port } = await listen(buildServer(deps));
    try {
      const res = await postJson(port, '/api/control/sessions/s1/keys', { keys: 'Enter', idempotencyKey: 'enter-1' });
      assert.equal(res.status, 200);
      assert.equal(res.body.delivered, true);
      assert.equal(res.body.bytes, '\r');
      assert.equal(received.sessionId, 's1');
      assert.equal(received.keys, 'Enter');
      assert.equal(received.raw, undefined);
    } finally {
      server.close();
    }
  });

  it('POST /sessions/:id/respond calls the injected responder', async function () {
    let received;
    const deps = fakeDeps({
      respond: async (opts) => {
        received = opts;
        return { delivered: true, awaitingKind: 'tool_approval', mappedKeys: 'y', duplicated: false };
      },
    });
    const { server, port } = await listen(buildServer(deps));
    try {
      const res = await postJson(port, '/api/control/sessions/s1/respond', { choice: 'yes', idempotencyKey: 'yes-1' });
      assert.equal(res.status, 200);
      assert.equal(res.body.delivered, true);
      assert.equal(res.body.awaitingKind, 'tool_approval');
      assert.equal(res.body.mappedKeys, 'y');
      assert.equal(received.sessionId, 's1');
      assert.equal(received.choice, 'yes');
    } finally {
      server.close();
    }
  });

  it('POST /sessions/:id/respond returns 409 when there is no awaiting interaction', async function () {
    const deps = fakeDeps({
      respond: async () => ({ error: { code: 'PRECONDITION_FAILED', message: 'no pending interaction' } }),
    });
    const { server, port } = await listen(buildServer(deps));
    try {
      const res = await postJson(port, '/api/control/sessions/s1/respond', { choice: 'yes' });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'PRECONDITION_FAILED');
    } finally {
      server.close();
    }
  });

  it('cursor round-trips through parse/encode', function () {
    const c = { epoch: 'abc123', seq: 7 };
    assert.deepEqual(parseCursor(encodeCursor(c)), c);
    assert.equal(parseCursor(undefined), undefined);
  });
});
