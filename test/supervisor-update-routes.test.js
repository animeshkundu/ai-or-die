'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const { createUpdateRouter } = require('../src/supervisor/update-routes');

function listen(router) {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/update', router);
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function call(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `/api/update${route}`,
      method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('supervisor/update-routes', function () {
  it('status reports supervised state', async function () {
    const router = createUpdateRouter({
      getSupervisor: () => ({
        updateStatus: () => ({ currentVersion: '0.1.108', pending: null, idleMs: 5, ptys: 2 }),
      }),
    });
    const { server, port } = await listen(router);
    try {
      const res = await call(port, 'GET', '/status');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.supervised, true);
      assert.strictEqual(res.body.ptys, 2);
    } finally {
      server.close();
    }
  });

  it('status reports unsupervised when no bridge is attached', async function () {
    const router = createUpdateRouter({ getSupervisor: () => null });
    const { server, port } = await listen(router);
    try {
      const res = await call(port, 'GET', '/status');
      assert.deepStrictEqual(res.body, { supervised: false, updatable: false });
    } finally {
      server.close();
    }
  });

  it('apply delegates to the supervisor and returns the swap result', async function () {
    const router = createUpdateRouter({
      getSupervisor: () => ({
        applyUpdate: async () => ({ applied: true, promoted: true, version: '0.1.109', ptys: 3 }),
      }),
    });
    const { server, port } = await listen(router);
    try {
      const res = await call(port, 'POST', '/apply', {});
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.applied, true);
      assert.strictEqual(res.body.ptys, 3);
    } finally {
      server.close();
    }
  });

  it('apply returns 409 when unsupervised', async function () {
    const router = createUpdateRouter({ getSupervisor: () => null });
    const { server, port } = await listen(router);
    try {
      const res = await call(port, 'POST', '/apply', {});
      assert.strictEqual(res.status, 409);
    } finally {
      server.close();
    }
  });
});
