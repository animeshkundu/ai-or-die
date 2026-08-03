'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  closeProcServer,
  diagnosticRequest,
  startProcServer,
  supervisorDiagnostics,
} = require('../harness/proc-controller');

describe('process-isolated longevity controller', function () {
  this.timeout(120000);

  let controller;

  afterEach(async function () {
    if (controller) await closeProcServer(controller);
    controller = null;
  });

  it('spawns the production supervisor and attributes diagnostics to a distinct server PID', async function () {
    controller = await startProcServer();
    assert.deepStrictEqual(Object.keys(controller).sort(), [
      'baseUrl',
      'serverPid',
      'supervisorPid',
      'workDir',
      'wsUrl',
    ]);
    assert.notStrictEqual(controller.supervisorPid, process.pid);
    assert.notStrictEqual(controller.serverPid, process.pid);
    assert.notStrictEqual(controller.serverPid, controller.supervisorPid);

    const server = await diagnosticRequest(controller, '/api/_diag/counters');
    assert.strictEqual(server.statusCode, 200);
    assert.strictEqual(server.body.process.pid, controller.serverPid);
    assert.strictEqual(server.body.process.ppid, controller.supervisorPid);

    const supervisor = await supervisorDiagnostics(controller);
    assert(supervisor, 'supervisor should answer the env-gated IPC probe');
    assert.strictEqual(supervisor.pid, controller.supervisorPid);
    assert.strictEqual(supervisor.child_pid, controller.serverPid);
  });

  it('never imports the server into the load-generator process', function () {
    const source = fs.readFileSync(path.join(__dirname, '..', 'harness', 'proc-controller.js'), 'utf8');
    assert(!source.includes("require('../../../src/server')"));
    assert(!/\bserver\s*:/.test(source), 'controller must not expose a server object');
  });
});
