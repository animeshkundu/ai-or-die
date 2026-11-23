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
  // Bundled ripgrep (ADR-0018) — see scripts/build-sea.js for the asset
  // prefix scheme. Mirror it here for the extraction predicate AND the
  // post-extract path computation that feeds global.__SEA_RG_PATH__.
  const rgAssetPrefix = `vscode-ripgrep-${process.platform}-${process.arch}`;
  const rgBinName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const assetKeys = sea.getAssetKeys();

  for (const key of assetKeys) {
    if (key.startsWith(ptyPkg + '/') ||
        key.startsWith(sherpaPkg + '/') ||
        key.startsWith('sherpa-onnx-node/') ||
        key.startsWith(rgAssetPrefix + '/')) {
      const targetPath = path.join(tempDir, key);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, new Uint8Array(sea.getRawAsset(key)));
    }
  }

  // chmod +x the extracted ripgrep binary on POSIX. fs.writeFileSync
  // doesn't preserve the executable bit; without this chmod, the
  // search backend's fs.accessSync(X_OK) liveness check would reject
  // the binary on macOS / Linux SEA builds even though the bytes are
  // intact. Windows ignores file mode bits — the .exe extension
  // already conveys executability.
  const rgExtractedPath = path.join(tempDir, rgAssetPrefix, 'bin', rgBinName);
  if (fs.existsSync(rgExtractedPath)) {
    if (process.platform !== 'win32') {
      try { fs.chmodSync(rgExtractedPath, 0o755); }
      catch (e) {
        console.warn('[SEA] failed to chmod +x bundled ripgrep:', e.message);
      }
    }
    // Surface the resolved path to the search backend (src/utils/search.js)
    // via a global, since the bundled module's require('@vscode/ripgrep')
    // can't resolve at SEA runtime (no node_modules on disk).
    global.__SEA_RG_PATH__ = rgExtractedPath;
  }

  // Store references for pty-sea-shim.js and server.js to use
  global.__SEA_MODE__ = true;
  global.__SEA_TEMP_DIR__ = tempDir;

  // Acquire a `gc` function in-process. When the .js entry points are run
  // under `node`, the supervisor adds --expose-gc to the child; a SEA binary is
  // exec'd directly and CANNOT receive that flag (there is no Node CLI in
  // front of it), so src/restart-manager.js would silently skip every forced
  // collection and the memory guard would degrade to "do nothing".
  // v8.setFlagsFromString + a fresh context resolving the `gc` global is the
  // documented way to expose the builtin at runtime. Guarded and never fatal:
  // if a future Node removes it, the memory guard degrades exactly as before.
  try {
    if (typeof global.gc !== 'function') {
      const v8 = require('v8');
      const vm = require('vm');
      v8.setFlagsFromString('--expose_gc');
      const gcFn = vm.runInNewContext('gc');
      if (typeof gcFn === 'function') global.gc = gcFn;
    }
  } catch (_) { /* memory guard degrades to no forced GC */ }

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
