'use strict';

// Shim for @lydell/node-pty that works in both normal and SEA mode.
// In SEA mode, loads the native addon from the extracted temp directory
// using module.createRequire() to bypass the SEA embedder's require.
// In normal mode, delegates to the real @lydell/node-pty package.

const path = require('path');
const { createRequire } = require('module');

if (global.__SEA_MODE__) {
  const ptyPkg = `node-pty-${process.platform}-${process.arch}`;
  const ptyPath = path.join(global.__SEA_TEMP_DIR__, ptyPkg, 'lib', 'index.js');
  // createRequire gives us a real filesystem require, not the SEA embedder
  const diskRequire = createRequire(ptyPath);
  module.exports = diskRequire(ptyPath);
} else {
  // Dynamic require to prevent esbuild from resolving this at bundle time
  const pkg = '@lydell/node-pty';
  module.exports = require(pkg);
}
