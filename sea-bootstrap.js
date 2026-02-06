#!/usr/bin/env node
'use strict';

// SEA (Single Executable Application) bootstrap.
// When running as a SEA binary, this extracts native addons to a temp directory
// and patches module resolution before delegating to the real entry point.

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
  const Module = require('module');

  const tempDir = path.join(os.tmpdir(), `ai-or-die-${process.pid}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Extract native addon files from SEA assets
  const ptyPkg = `node-pty-${process.platform}-${process.arch}`;
  const assetKeys = sea.getAssetKeys();

  for (const key of assetKeys) {
    if (key.startsWith(ptyPkg + '/')) {
      const targetPath = path.join(tempDir, key);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, new Uint8Array(sea.getRawAsset(key)));
    }
  }

  // Patch Module._resolveFilename to redirect @lydell/node-pty requires
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === '@lydell/node-pty') {
      // The main package loads the platform-specific one
      const platformIndex = path.join(tempDir, ptyPkg, 'lib', 'index.js');
      if (fs.existsSync(platformIndex)) {
        return platformIndex;
      }
    }
    if (request.startsWith('@lydell/node-pty-')) {
      const pkgName = request.replace('@lydell/', '');
      const indexPath = path.join(tempDir, pkgName, 'lib', 'index.js');
      if (fs.existsSync(indexPath)) {
        return indexPath;
      }
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };

  // Store references for server.js to use
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
