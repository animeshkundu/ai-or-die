'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const BaseBridge = require('../../../src/base-bridge');

function getWindowsHandleCount() {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = execFileSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).HandleCount`],
    { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  ).trim();
  const count = Number.parseInt(output, 10);
  if (!Number.isFinite(count)) throw new Error(`PowerShell returned an invalid handle count: ${output}`);
  return count;
}

describe('Windows native handle drift probe', function () {
  this.timeout(60000);

  it('does not leak native handles across real ConPTY create/exit churn', async function () {
    if (process.platform !== 'win32') this.skip();
    const baseline = getWindowsHandleCount();
    const bridge = new BaseBridge('handle-probe', {
      launcher: { command: process.execPath, prefixArgs: [] },
    });
    bridge.buildArgs = () => ['-e', 'process.exit(0)'];

    for (let index = 0; index < 20; index++) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`PTY ${index} did not exit`)), 5000);
        bridge.startSession(`handle-probe-${index}`, {
          workingDir: os.tmpdir(),
          onOutput: () => {},
          onExit: () => {
            clearTimeout(timeout);
            resolve();
          },
          onError: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        }).catch(reject);
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = getWindowsHandleCount();

    assert.ok(baseline > 0, `expected a positive Windows HandleCount, got ${baseline}`);
    assert.ok(
      after - baseline <= 5,
      `ConPTY handle drift exceeded the longevity gate: ${baseline} -> ${after} (delta ${after - baseline})`
    );
  });
});
