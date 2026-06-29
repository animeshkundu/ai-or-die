const assert = require('assert');
const path = require('path');
const { assetName, sidecarPath, ensureSidecar } = require('../src/utils/sidecar-installer');

describe('sidecar-installer', function() {
  describe('assetName', function() {
    it('maps the current platform/arch to an asset name', function() {
      const n = assetName();
      if (process.platform === 'win32') assert.ok(/^aiordie-mesh-windows-(amd64|arm64)\.exe$/.test(n), n);
      else if (process.platform === 'darwin') assert.ok(/^aiordie-mesh-darwin-(amd64|arm64)$/.test(n), n);
      else if (process.platform === 'linux') assert.ok(/^aiordie-mesh-linux-(amd64|arm64)$/.test(n), n);
    });
  });

  describe('sidecarPath', function() {
    it('lands under the app bin dir with the right extension', function() {
      const p = sidecarPath();
      assert.ok(p.endsWith(process.platform === 'win32' ? 'aiordie-mesh.exe' : 'aiordie-mesh'));
      assert.ok(p.includes(path.join('ai-or-die', 'bin')) || p.includes(path.join('.ai-or-die', 'bin')));
    });
  });

  describe('ensureSidecar', function() {
    it('throws on a missing release (no silent success)', async function() {
      const dest = path.join(require('os').tmpdir(), 'aiordie-mesh-nope-' + process.pid);
      await assert.rejects(() => ensureSidecar('0.0.0-does-not-exist', dest));
    });
    it('verifies even a pre-existing file (does not blindly trust it)', async function() {
      // dest exists but the release/version does not → must throw, not return.
      await assert.rejects(() => ensureSidecar('0.0.0-does-not-exist', __filename));
    });
  });
});
