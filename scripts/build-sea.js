#!/usr/bin/env node
'use strict';

// Build script for Node.js Single Executable Application (SEA).
// Usage:
//   node scripts/build-sea.js          -- full build (bundle + SEA binary)
//   node scripts/build-sea.js bundle   -- bundle only (for testing)

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PLATFORM = process.platform;
const ARCH = process.arch;

// ---------------------------------------------------------------------------
// Step 1: Bundle all JS into a single file using esbuild
// ---------------------------------------------------------------------------
function bundle() {
  console.log('Bundling application with esbuild...');
  fs.mkdirSync(DIST, { recursive: true });

  const esbuildArgs = [
    path.join(ROOT, 'sea-bootstrap.js'),
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=cjs',
    '--outfile=' + path.join(DIST, 'bundle.js'),
    // Native modules cannot be bundled — they are loaded at runtime
    '--external:@lydell/node-pty',
    '--external:@lydell/node-pty-win32-x64',
    '--external:@lydell/node-pty-win32-arm64',
    '--external:@lydell/node-pty-linux-x64',
    '--external:@lydell/node-pty-linux-arm64',
    '--external:@lydell/node-pty-darwin-x64',
    '--external:@lydell/node-pty-darwin-arm64',
    // open package uses import() which doesn't work in SEA
    '--external:open',
  ];

  // Use npx to run esbuild — avoids .cmd shell issues on Windows
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    ...esbuildArgs
  ], { stdio: 'inherit', cwd: ROOT });

  console.log('Bundle created: dist/bundle.js');
}

// ---------------------------------------------------------------------------
// Step 2: Collect all assets for the SEA config
// ---------------------------------------------------------------------------
function collectAssets() {
  const assets = {};

  // Static web assets
  const publicDir = path.join(ROOT, 'src', 'public');
  for (const file of fs.readdirSync(publicDir)) {
    const fullPath = path.join(publicDir, file);
    if (fs.statSync(fullPath).isFile()) {
      assets[`public/${file}`] = fullPath;
    }
  }

  // Platform-specific native addon files
  const ptyPkgName = `node-pty-${PLATFORM}-${ARCH}`;
  const ptyPkgDir = path.join(ROOT, 'node_modules', '@lydell', ptyPkgName);

  if (fs.existsSync(ptyPkgDir)) {
    collectFilesRecursive(ptyPkgDir, ptyPkgName, assets);
    console.log(`Collected native addon files from @lydell/${ptyPkgName}`);
  } else {
    console.warn(`Warning: @lydell/${ptyPkgName} not found. Native PTY may not work in the binary.`);
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

if (mode === 'bundle') {
  bundle();
} else {
  bundle();
  const assets = collectAssets();
  const configPath = generateSeaConfig(assets);
  buildSea(configPath);
}
