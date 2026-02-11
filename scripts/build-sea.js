#!/usr/bin/env node
'use strict';

// Build script for Node.js Single Executable Application (SEA).
// Usage:
//   node scripts/build-sea.js          -- full build (bundle + SEA binary)
//   node scripts/build-sea.js bundle   -- bundle only (for testing)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PLATFORM = process.platform;
const ARCH = process.arch;

// ---------------------------------------------------------------------------
// Step 1: Bundle all JS into a single file using esbuild
// ---------------------------------------------------------------------------
async function bundle() {
  console.log('Bundling application with esbuild...');
  fs.mkdirSync(DIST, { recursive: true });

  const esbuild = require('esbuild');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'sea-bootstrap.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: path.join(DIST, 'bundle.js'),
    // Redirect @lydell/node-pty to our shim that handles SEA mode
    alias: {
      '@lydell/node-pty': path.join(ROOT, 'scripts', 'pty-sea-shim.js'),
      'sherpa-onnx-node': path.join(ROOT, 'scripts', 'sherpa-onnx-sea-shim.js'),
    },
    external: [
      // Platform-specific packages are loaded dynamically by the shim
      '@lydell/node-pty-win32-x64',
      '@lydell/node-pty-win32-arm64',
      '@lydell/node-pty-linux-x64',
      '@lydell/node-pty-linux-arm64',
      '@lydell/node-pty-darwin-x64',
      '@lydell/node-pty-darwin-arm64',
      // Platform-specific sherpa-onnx packages (loaded dynamically by the shim)
      'sherpa-onnx-win-x64',
      'sherpa-onnx-win-ia32',
      'sherpa-onnx-linux-x64',
      'sherpa-onnx-linux-arm64',
      'sherpa-onnx-darwin-x64',
      'sherpa-onnx-darwin-arm64',
      // open uses dynamic import() — lazy-loaded in bin/ai-or-die.js
      'open',
    ],
  });

  console.log('Bundle created: dist/bundle.js');
}

// ---------------------------------------------------------------------------
// Step 2: Collect all assets for the SEA config
// ---------------------------------------------------------------------------
function collectAssets() {
  const assets = {};

  // Static web assets (recursive to include fonts/ and components/ subdirectories)
  const publicDir = path.join(ROOT, 'src', 'public');
  collectFilesRecursive(publicDir, 'public', assets);

  // Platform-specific native addon files
  const ptyPkgName = `node-pty-${PLATFORM}-${ARCH}`;
  const ptyPkgDir = path.join(ROOT, 'node_modules', '@lydell', ptyPkgName);

  if (fs.existsSync(ptyPkgDir)) {
    collectFilesRecursive(ptyPkgDir, ptyPkgName, assets);
    console.log(`Collected native addon files from @lydell/${ptyPkgName}`);
  } else {
    console.warn(`Warning: @lydell/${ptyPkgName} not found. Native PTY may not work in the binary.`);
  }

  // sherpa-onnx platform-specific native addon files (uses 'win' not 'win32')
  const sherpaPlatform = PLATFORM === 'win32' ? 'win' : PLATFORM;
  const sherpaPkgName = `sherpa-onnx-${sherpaPlatform}-${ARCH}`;
  const sherpaPkgDir = path.join(ROOT, 'node_modules', sherpaPkgName);

  if (fs.existsSync(sherpaPkgDir)) {
    collectFilesRecursive(sherpaPkgDir, sherpaPkgName, assets);
    console.log(`Collected native addon files from ${sherpaPkgName}`);
  } else {
    console.warn(`Warning: ${sherpaPkgName} not found. Local STT may not work in the binary.`);
  }

  // sherpa-onnx-node JS files (needed for the full API surface in SEA mode)
  const sherpaNodeDir = path.join(ROOT, 'node_modules', 'sherpa-onnx-node');
  if (fs.existsSync(sherpaNodeDir)) {
    collectFilesRecursive(sherpaNodeDir, 'sherpa-onnx-node', assets);
    console.log('Collected sherpa-onnx-node JS files');
  }

  console.log(`Total assets: ${Object.keys(assets).length}`);
  return assets;
}

function collectFilesRecursive(dir, prefix, assets) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const assetKey = `${prefix}/${entry.name}`;
    if (entry.isFile() && !entry.name.endsWith('.md') && entry.name !== 'package.json') {
      assets[assetKey] = fullPath;
    } else if (entry.isDirectory() && entry.name !== 'node_modules') {
      collectFilesRecursive(fullPath, assetKey, assets);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3: Generate SEA config and build the binary
// ---------------------------------------------------------------------------
function generateSeaConfig(assets) {
  const config = {
    main: path.join(DIST, 'bundle.js'),
    output: path.join(DIST, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    assets
  };

  const configPath = path.join(DIST, 'sea-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log('SEA config written: dist/sea-config.json');
  return configPath;
}

function buildSea(configPath) {
  const nodeExe = process.execPath;
  const outputName = PLATFORM === 'win32' ? 'ai-or-die.exe' : 'ai-or-die';
  const outputPath = path.join(DIST, outputName);

  // Generate the SEA preparation blob
  console.log('Generating SEA blob...');
  execFileSync(nodeExe, [
    '--experimental-sea-config', configPath
  ], { stdio: 'inherit', cwd: ROOT });

  // Copy the Node binary
  console.log('Copying Node.js binary...');
  fs.copyFileSync(nodeExe, outputPath);

  // Remove signature on macOS before injection
  if (PLATFORM === 'darwin') {
    try {
      execFileSync('codesign', ['--remove-signature', outputPath]);
    } catch (err) {
      console.warn('Warning: codesign --remove-signature failed:', err.message);
    }
  }

  // Inject the blob using postject
  console.log('Injecting SEA blob...');
  const blobPath = path.join(DIST, 'sea-prep.blob');

  const postjectArgs = [
    path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
    outputPath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  ];
  if (PLATFORM === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }

  execFileSync(process.execPath, postjectArgs, { stdio: 'inherit', cwd: ROOT });

  // Re-sign on macOS
  if (PLATFORM === 'darwin') {
    try {
      execFileSync('codesign', ['--sign', '-', outputPath]);
    } catch (err) {
      console.warn('Warning: codesign --sign failed:', err.message);
    }
  }

  const stats = fs.statSync(outputPath);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
  console.log(`\nSEA binary built: ${outputPath} (${sizeMB} MB)`);
  return outputPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const mode = process.argv[2];

(async () => {
  if (mode === 'bundle') {
    await bundle();
  } else {
    await bundle();
    const assets = collectAssets();
    const configPath = generateSeaConfig(assets);
    buildSea(configPath);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
