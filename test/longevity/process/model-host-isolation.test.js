'use strict';

const assert = require('assert');
const path = require('path');
const { fork } = require('child_process');
const ModelHost = require('../../../src/model-host');
const TerminalBridge = require('../../../src/terminal-bridge');

const fixture = path.join(__dirname, '..', '..', 'fixtures', 'model-host-fixture.js');

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition timed out');
}

describe('model-host fault isolation keeps live PTYs intact', function () {
  this.timeout(20000);

  it('respawns a killed model host while terminal output continues', async function () {
    const bridge = new TerminalBridge();
    const output = [];
    const host = new ModelHost({
      name: 'isolation-fixture',
      entryPath: fixture,
      readinessTimeoutMs: 5000,
    });
    try {
      await bridge.startSession('live-shell', {
        workingDir: process.cwd(),
        cols: 100,
        rows: 30,
        onOutput: (chunk) => output.push(String(chunk)),
        onExit: () => {},
        onError: (error) => { throw error; },
      });
      await host.demand();
      const oldPid = host.diagnostics().pid;
      await bridge.sendInput('live-shell', `echo BEFORE_HOST_KILL\r`);
      await waitFor(() => output.join('').includes('BEFORE_HOST_KILL'), 5000);

      host._generation.child.kill('SIGKILL');
      await waitFor(() => {
        const pid = host.diagnostics().pid;
        return pid && pid !== oldPid && host.getState() === 'ready';
      }, 7000);

      await bridge.sendInput('live-shell', `echo AFTER_HOST_KILL\r`);
      await waitFor(() => output.join('').includes('AFTER_HOST_KILL'), 5000);
      assert.ok(bridge.sessions.get('live-shell').active, 'the live shell remains active');
      assert.notStrictEqual(host.diagnostics().pid, oldPid, 'a replacement host is running');
    } finally {
      await host.shutdown();
      await bridge.stopSession('live-shell');
    }
  });

  it('does not leave a host behind when its core is uncatchably killed', async function () {
    const parent = fork(path.join(__dirname, '..', '..', 'fixtures', 'model-host-parent.js'), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env },
    });
    let hostPid;
    try {
      const message = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('parent fixture did not become ready')), 10000);
        parent.on('message', (value) => {
          if (value && value.type === 'error') {
            clearTimeout(timer);
            reject(new Error(value.message));
          } else if (value && value.type === 'ready') {
            clearTimeout(timer);
            resolve(value);
          }
        });
        parent.once('error', reject);
      });
      hostPid = message.hostPid;
      assert.ok(hostPid > 0);
      parent.kill('SIGKILL');
      await waitFor(() => {
        try {
          process.kill(hostPid, 0);
          return false;
        } catch (error) {
          return error.code === 'ESRCH';
        }
      }, 7000);
    } finally {
      try { parent.kill('SIGKILL'); } catch (_) {}
      if (hostPid) {
        try { process.kill(hostPid, 'SIGKILL'); } catch (_) {}
      }
    }
  });
});
