'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');
const testApi = global.describe ? { describe: global.describe, it: global.it } : require('node:test');
const { describe, it } = testApi;
const { createControlRouter } = require('../../src/control/routes');
const { ControlEventBus } = require('../../src/control/event-bus');
const { DecisionStore } = require('../../src/control/decision-store');

function buildServer(deps, opts) {
  opts = opts || {};
  const app = express();
  app.use(express.json());
  if (opts.auth) {
    app.use((req, res, next) => {
      const token = req.headers.authorization || req.query.token;
      if (token !== `Bearer ${opts.auth}` && token !== opts.auth) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      next();
    });
  }
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

function fakeDeps(overrides) {
  overrides = overrides || {};
  const eventBus = overrides.eventBus || new ControlEventBus();
  const decisionStore = overrides.decisionStore || new DecisionStore({
    eventBus,
    ttlMs: overrides.decisionTtlMs || 60 * 60 * 1000,
    cleanupIntervalMs: 0,
  });
  return Object.assign({
    sessions: new Map([
      ['s1', { id: 's1', name: 'one', workingDir: '/w', active: true, connections: new Set() }],
    ]),
    eventBus,
    decisionStore,
    getSessionViewerCount: () => 0,
  }, overrides, { eventBus, decisionStore });
}

async function getJson(port, pathname, headers) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: headers || {} });
  return { status: r.status, body: await r.json() };
}

async function postJson(port, pathname, body, headers) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('control decision endpoints', function () {
  it('registers pending decisions, lists them, and emits decision_pending', async function () {
    const deps = fakeDeps();
    const { server, port } = await listen(buildServer(deps));
    try {
      const head = deps.eventBus.headCursor();
      const first = await postJson(port, '/api/control/sessions/s1/decision', {
        kind: 'tool_approval',
        tool: 'Bash',
        command: 'npm test',
        cwd: '/w',
        idempotencyKey: 'same-decision',
      });
      const retry = await postJson(port, '/api/control/sessions/s1/decision', {
        kind: 'tool_approval',
        tool: 'Bash',
        command: 'npm test',
        cwd: '/w',
        idempotencyKey: 'same-decision',
      });

      assert.equal(first.status, 200);
      assert.match(first.body.decisionId, /^dec_[0-9a-f]+$/);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.decisionId, first.body.decisionId);
      assert.equal(retry.body.duplicated, true);

      const events = deps.eventBus.since(head, { sessionIds: ['s1'], kinds: ['decision_pending'] }).events;
      assert.equal(events.length, 1, 'idempotent retry must not emit a second event');
      assert.equal(events[0].kind, 'decision_pending');
      assert.equal(events[0].detail.decisionId, first.body.decisionId);
      assert.equal(events[0].detail.kind, 'tool_approval');
      assert.equal(events[0].detail.command, 'npm test');
      assert.equal(events[0].detail.idempotencyKey, undefined);

      const listed = await getJson(port, '/api/control/sessions/s1/decisions');
      assert.equal(listed.status, 200);
      assert.equal(listed.body.decisions.length, 1);
      assert.equal(listed.body.decisions[0].decisionId, first.body.decisionId);
      assert.equal(listed.body.decisions[0].tool, 'Bash');
    } finally {
      server.close();
      deps.decisionStore.close();
    }
  });

  it('register → await blocks → answer resolves the held await with the structured choice', async function () {
    const deps = fakeDeps();
    const { server, port } = await listen(buildServer(deps));
    try {
      const registered = await postJson(port, '/api/control/sessions/s1/decision', {
        kind: 'choice_question',
        question: 'Deploy?',
        options: [{ label: 'approve', description: 'Ship it' }, { label: 'reject' }],
      });
      assert.equal(registered.status, 200);
      const decisionId = registered.body.decisionId;

      const pendingAwait = getJson(port, `/api/control/decisions/${encodeURIComponent(decisionId)}/await?timeoutMs=1000`);
      await delay(20);
      const answered = await postJson(port, `/api/control/decisions/${encodeURIComponent(decisionId)}/answer`, {
        choice: 'approve',
      });
      assert.equal(answered.status, 200);
      assert.deepEqual(answered.body, { ok: true });

      const resolved = await pendingAwait;
      assert.equal(resolved.status, 200);
      assert.deepEqual(resolved.body, { answered: true, choice: 'approve' });

      const listed = await getJson(port, '/api/control/sessions/s1/decisions');
      assert.deepEqual(listed.body.decisions, []);
    } finally {
      server.close();
      deps.decisionStore.close();
    }
  });

  it('/await timeout returns answered:false with the current session viewer count', async function () {
    const deps = fakeDeps({
      getSessionViewerCount: (sessionId) => {
        assert.equal(sessionId, 's1');
        return 3;
      },
    });
    const { server, port } = await listen(buildServer(deps));
    try {
      const registered = await postJson(port, '/api/control/sessions/s1/decision', {
        kind: 'plan_approval',
        plan: 'Run the migration',
      });
      const decisionId = registered.body.decisionId;
      const awaited = await getJson(port, `/api/control/decisions/${encodeURIComponent(decisionId)}/await?timeoutMs=20`);
      assert.equal(awaited.status, 200);
      assert.deepEqual(awaited.body, { answered: false, viewers: 3 });
    } finally {
      server.close();
      deps.decisionStore.close();
    }
  });

  it('second answer loses with 409; first answer still wins for later await calls', async function () {
    const deps = fakeDeps();
    const { server, port } = await listen(buildServer(deps));
    try {
      const registered = await postJson(port, '/api/control/sessions/s1/decision', {
        kind: 'tool_approval',
        tool: 'Bash',
        command: 'rm -rf build',
      });
      const decisionId = registered.body.decisionId;
      const first = await postJson(port, `/api/control/decisions/${decisionId}/answer`, { choice: 'reject' });
      const second = await postJson(port, `/api/control/decisions/${decisionId}/answer`, { choice: 'approve' });
      const awaited = await getJson(port, `/api/control/decisions/${decisionId}/await?timeoutMs=0`);

      assert.equal(first.status, 200);
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, 'PRECONDITION_FAILED');
      assert.deepEqual(awaited.body, { answered: true, choice: 'reject' });
    } finally {
      server.close();
      deps.decisionStore.close();
    }
  });

  it('unknown decisionId returns 404 for answer and await', async function () {
    const deps = fakeDeps();
    const { server, port } = await listen(buildServer(deps));
    try {
      const answer = await postJson(port, '/api/control/decisions/nope/answer', { choice: 'approve' });
      const awaited = await getJson(port, '/api/control/decisions/nope/await?timeoutMs=0');
      assert.equal(answer.status, 404);
      assert.equal(answer.body.error.code, 'DECISION_NOT_FOUND');
      assert.equal(awaited.status, 404);
      assert.equal(awaited.body.error.code, 'DECISION_NOT_FOUND');
    } finally {
      server.close();
      deps.decisionStore.close();
    }
  });

  it('session-exit control events clear pending decisions and wake awaiters as 404', async function () {
    const deps = fakeDeps();
    const { server, port } = await listen(buildServer(deps));
    try {
      const registered = await postJson(port, '/api/control/sessions/s1/decision', {
        kind: 'choice_question',
        question: 'Continue?',
      });
      const decisionId = registered.body.decisionId;
      const pendingAwait = getJson(port, `/api/control/decisions/${decisionId}/await?timeoutMs=1000`);
      await delay(20);
      deps.eventBus.append('s1', 'exited');

      const listed = await getJson(port, '/api/control/sessions/s1/decisions');
      const awaited = await pendingAwait;
      assert.deepEqual(listed.body.decisions, []);
      assert.equal(awaited.status, 404);
      assert.equal(awaited.body.error.code, 'DECISION_NOT_FOUND');
    } finally {
      server.close();
      deps.decisionStore.close();
    }
  });

  it('requires the existing control Bearer auth before decision endpoints are reachable', async function () {
    const deps = fakeDeps();
    const { server, port } = await listen(buildServer(deps, { auth: 'secret-token' }));
    try {
      const unauth = await postJson(port, '/api/control/sessions/s1/decision', { kind: 'choice_question', question: 'OK?' });
      const authed = await postJson(
        port,
        '/api/control/sessions/s1/decision',
        { kind: 'choice_question', question: 'OK?' },
        { authorization: 'Bearer secret-token' }
      );
      assert.equal(unauth.status, 401);
      assert.equal(authed.status, 200);
      assert.match(authed.body.decisionId, /^dec_/);
    } finally {
      server.close();
      deps.decisionStore.close();
    }
  });
});
