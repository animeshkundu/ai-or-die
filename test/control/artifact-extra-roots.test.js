'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let ClaudeCodeWebServer;
try {
  ({ ClaudeCodeWebServer } = require('../../src/server'));
} catch (_) {
  /* optional native deps may be unavailable in some local test runs */
}

async function startWebServer(baseDir, options) {
  const originalCwd = process.cwd();
  try {
    process.chdir(baseDir);
    const server = new ClaudeCodeWebServer(Object.assign({
      port: 0,
      sessionStoreOptions: { storageDir: path.join(baseDir, '.sessions') },
    }, options || {}));
    const httpServer = await server.start();
    return { server, httpServer };
  } finally {
    process.chdir(originalCwd);
  }
}

describe('validateArtifactPath (extra roots for out-of-workspace plans)', function () {
  if (!ClaudeCodeWebServer) {
    it.skip('ClaudeCodeWebServer unavailable in this environment', () => {});
    return;
  }

  let baseDir, plansDir, prevExtra;

  beforeEach(function () {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aod-base-')));
    plansDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aod-plans-')));
    prevExtra = process.env.AIORDIE_ARTIFACT_EXTRA_ROOTS;
    process.env.AIORDIE_ARTIFACT_EXTRA_ROOTS = plansDir;
  });

  afterEach(function () {
    if (prevExtra === undefined) delete process.env.AIORDIE_ARTIFACT_EXTRA_ROOTS;
    else process.env.AIORDIE_ARTIFACT_EXTRA_ROOTS = prevExtra;
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(plansDir, { recursive: true, force: true });
  });

  it('accepts a file in an extra root for artifacts but not the general sandbox', async function () {
    const planFile = path.join(plansDir, 'plan.md');
    fs.writeFileSync(planFile, '# plan');
    const { server, httpServer } = await startWebServer(baseDir);
    try {
      const art = server.validateArtifactPath(planFile);
      assert.equal(art.valid, true, 'artifact validator should accept an extra-root file');
      const gen = server.validatePath(planFile);
      assert.equal(gen.valid, false, 'general validatePath must stay strict (workspace only)');
    } finally {
      await new Promise((r) => httpServer.close(r));
    }
  });

  it('still rejects a file outside both the workspace and the extra roots', async function () {
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aod-out-')));
    const outsideFile = path.join(outsideDir, 'x.md');
    fs.writeFileSync(outsideFile, 'x');
    const { server, httpServer } = await startWebServer(baseDir);
    try {
      assert.equal(server.validateArtifactPath(outsideFile).valid, false);
    } finally {
      await new Promise((r) => httpServer.close(r));
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

// keep http import referenced (lint parity with sibling tests)
void http;
