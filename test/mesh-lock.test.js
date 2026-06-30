'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'mesh-lock.js');
const meshLock = require('../scripts/mesh-lock.js');

function run(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('mesh-lock', function () {
  it('exposes the full 6-platform asset matrix', function () {
    assert.strictEqual(meshLock.ASSET_NAMES.length, 6);
    assert.ok(meshLock.ASSET_NAMES.includes('aiordie-mesh-windows-amd64.exe'));
    assert.ok(meshLock.ASSET_NAMES.includes('aiordie-mesh-darwin-arm64'));
  });

  it('computes a stable 64-hex content hash', function () {
    const h = meshLock.computeContentHash();
    assert.ok(/^[0-9a-f]{64}$/.test(h), h);
    assert.strictEqual(meshLock.computeContentHash(), h, 'deterministic across calls');
  });

  it('--print-hash matches the committed lock contentHash (lock is current)', function () {
    const printed = run(['--print-hash']).trim();
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mesh-sidecar.lock.json'), 'utf8'));
    assert.strictEqual(printed, lock.contentHash);
  });

  it('--check passes for the committed lock', function () {
    const out = run(['--check']);
    assert.ok(/current/.test(out), out);
  });

  it('--assert-complete fails when assets are not embedded (in-repo lock)', function () {
    // The committed lock ships with empty assets (CI fills them at publish), so
    // the publish-readiness gate must reject it here.
    assert.throws(() => run(['--assert-complete']), (e) => /publish-ready|missing/i.test(String(e.stderr || e.stdout || e.message)));
  });

  it('parseChecksums reads "<sha>  <name>" lines', function () {
    const parsed = meshLock.parseChecksums('abc123  aiordie-mesh-linux-amd64\nDEF456  aiordie-mesh-darwin-arm64\n\n');
    assert.strictEqual(parsed['aiordie-mesh-linux-amd64'], 'abc123');
    assert.strictEqual(parsed['aiordie-mesh-darwin-arm64'], 'def456');
  });
});
