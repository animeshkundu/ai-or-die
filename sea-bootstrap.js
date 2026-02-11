#!/usr/bin/env node
'use strict';

// SEA (Single Executable Application) bootstrap.
// When running as a SEA binary, this extracts native addons to a temp directory
// and sets global flags before delegating to the real entry point.
// The pty-sea-shim.js handles module resolution for @lydell/node-pty.

const isSea = (() => {
  try {
    require('node:sea');
    return true;
  } catch {
    return false;
  }
})();

if (isSea) {
  const sea = require('node:sea');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const tempDir = path.join(os.tmpdir(), `ai-or-die-${process.pid}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Extract native addon files from SEA assets
  const ptyPkg = `node-pty-${process.platform}-${process.arch}`;
  const sherpaPlatform = process.platform === 'win32' ? 'win' : process.platform;
  const sherpaPkg = `sherpa-onnx-${sherpaPlatform}-${process.arch}`;
  const assetKeys = sea.getAssetKeys();

  for (const key of assetKeys) {
    if (key.startsWith(ptyPkg + '/') ||
        key.startsWith(sherpaPkg + '/') ||
        key.startsWith('sherpa-onnx-node/')) {
      const targetPath = path.join(tempDir, key);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, new Uint8Array(sea.getRawAsset(key)));
    }
  }

  // Store references for pty-sea-shim.js and server.js to use
  global.__SEA_MODE__ = true;
  global.__SEA_TEMP_DIR__ = tempDir;

  // Cleanup temp directory on exit
  process.on('exit', () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });
}

// Delegate to the real entry point
require('./bin/ai-or-die.js');
