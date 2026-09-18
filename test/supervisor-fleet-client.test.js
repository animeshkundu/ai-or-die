'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FleetClient } = require('../src/supervisor/fleet-client');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aod-fleet-'));
}

function clientFor(dir, calls, opts = {}) {
  return new FleetClient({
    gatewayUrl: 'https://fleet.example.invalid',
    machineId: 'test-machine-1',
    token: 'test-token',
    idFile: path.join(dir, 'machine-id'),
    tokenFile: path.join(dir, 'fleet-token'),
    heartbeatMs: 50,
    supervisor: { version: '0.1.108', ptyManager: { size: 3 } },
    request: async (method, apiPath, body) => {
      calls.push({ method, apiPath, body });
      if (method === 'POST') return { token: 'server-token' };
      return {};
    },
    ...opts,
  });
}

describe('supervisor/fleet-client', function () {
  it('register posts machine identity and persists a new token', async function () {
    const dir = sandbox();
    try {
      const calls = [];
      const client = clientFor(dir, calls);
      const result = await client.register();
      assert.deepStrictEqual(result, { registered: true });
      assert.strictEqual(calls[0].method, 'POST');
      assert.strictEqual(calls[0].apiPath, '/api/fleet/register');
      assert.strictEqual(calls[0].body.machineId, 'test-machine-1');
      assert.ok(calls[0].body.capabilities.includes('pty-handoff'));
      assert.strictEqual(fs.readFileSync(path.join(dir, 'fleet-token'), 'utf8'), 'server-token');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('heartbeat reports healthy with session counts', async function () {
    const dir = sandbox();
    try {
      const calls = [];
      const client = clientFor(dir, calls);
      client.registered = true;
      const result = await client.heartbeat();
      assert.deepStrictEqual(result, { sent: true });
      assert.strictEqual(calls[0].apiPath, '/api/fleet/heartbeat/test-machine-1');
      assert.strictEqual(calls[0].body.status, 'healthy');
      assert.strictEqual(calls[0].body.activeSessions, 3);
      assert.strictEqual(calls[0].body.version, '0.1.108');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reportUpdating flips status and reportHealthy flips back', async function () {
    const dir = sandbox();
    try {
      const calls = [];
      const client = clientFor(dir, calls);
      client.registered = true;
      await client.reportUpdating('0.1.109');
      assert.strictEqual(calls[0].body.status, 'updating');
      await client.reportHealthy();
      assert.strictEqual(calls[1].body.status, 'healthy');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disabled without a gateway URL', async function () {
    const client = new FleetClient({ gatewayUrl: null, machineId: 'x', token: 'y' });
    assert.strictEqual(client.enabled, false);
    assert.deepStrictEqual(await client.register(), { registered: false, reason: 'no_gateway' });
  });
});
