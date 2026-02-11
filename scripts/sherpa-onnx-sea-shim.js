'use strict';

// Shim for sherpa-onnx-node that works in both normal and SEA mode.
// In SEA mode, loads the native addon from the extracted temp directory
// using module.createRequire() to bypass the SEA embedder's require.
// In normal mode, delegates to the real sherpa-onnx-node package.

const path = require('path');
const { createRequire } = require('module');

if (global.__SEA_MODE__) {
  // sherpa-onnx uses 'win' instead of 'win32' for Windows platform
  const platform = process.platform === 'win32' ? 'win' : process.platform;
  const sherpaDir = `sherpa-onnx-${platform}-${process.arch}`;
  const addonPath = path.join(global.__SEA_TEMP_DIR__, sherpaDir, 'sherpa-onnx.node');

  // The .node addon needs its companion shared libraries (.dll/.so/.dylib)
  // in the same directory. sea-bootstrap.js already extracted them all.
  // Set PATH/LD_LIBRARY_PATH so the dynamic linker finds them.
  const addonDir = path.dirname(addonPath);
  if (process.platform === 'win32') {
    process.env.PATH = addonDir + ';' + (process.env.PATH || '');
  } else if (process.platform === 'darwin') {
    process.env.DYLD_LIBRARY_PATH = addonDir + ':' + (process.env.DYLD_LIBRARY_PATH || '');
  } else {
    process.env.LD_LIBRARY_PATH = addonDir + ':' + (process.env.LD_LIBRARY_PATH || '');
  }

  // createRequire gives us a real filesystem require, not the SEA embedder
  const diskRequire = createRequire(addonPath);
  const addon = diskRequire(addonPath);

  // Re-export the full sherpa-onnx-node API surface by loading each module
  // with the addon already resolved
  const sherpaNodeDir = path.join(global.__SEA_TEMP_DIR__, 'sherpa-onnx-node');
  const sherpaRequire = createRequire(path.join(sherpaNodeDir, 'sherpa-onnx.js'));

  // Patch Module._resolveFilename so sherpa-onnx-node's internal requires
  // for the platform package resolve to our extracted directory.
  // addon-static-import.js tries multiple paths to find sherpa-onnx.node:
  //   ../sherpa-onnx-{platform}-{arch}/sherpa-onnx.node
  //   ./node_modules/sherpa-onnx-{platform}-{arch}/sherpa-onnx.node
  //   ./sherpa-onnx.node
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function(request, parent, ...rest) {
    if (request.includes(`sherpa-onnx-${platform}-${process.arch}`) &&
        request.endsWith('.node')) {
      return addonPath;
    }
    if (request === './sherpa-onnx.node' && parent && parent.filename &&
        parent.filename.includes('sherpa-onnx-node')) {
      return addonPath;
    }
    return origResolve.call(this, request, parent, ...rest);
  };

  module.exports = sherpaRequire(path.join(sherpaNodeDir, 'sherpa-onnx.js'));
} else {
  // Dynamic require to prevent esbuild from resolving this at bundle time
  const pkg = 'sherpa-onnx-node';
  module.exports = require(pkg);
}
