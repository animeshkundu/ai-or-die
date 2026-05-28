'use strict';

/**
 * Boots and tears down a real ClaudeCodeWebServer for the soak harness.
 *
 * Differences from production startup:
 *   - Listens on port 0 (kernel-assigned) or a caller-supplied port > 11000.
 *     Production default 7777 is reserved per CLAUDE.md memory; tests must
 *     never collide with it.
 *   - No-auth (we control the client side).
 *   - sessionStore points at an isolated temp dir so the soak never reads
 *     or mutates the operator's ~/.ai-or-die/.
 *   - baseFolder is the temp work dir, NOT the worktree root — keeps the
 *     watcher flood from scanning real source files.
 *
 * Public surface:
 *   const ctl = await startServer({ port: 0 });
 *   ctl.port        // assigned port
 *   ctl.baseUrl     // 'http://127.0.0.1:<port>'
 *   ctl.wsUrl       // 'ws://127.0.0.1:<port>'
 *   ctl.server      // the ClaudeCodeWebServer instance
 *   ctl.workDir     // baseFolder (caller can poke files into it)
 *   await ctl.close();
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ClaudeCodeWebServer } = require('../../../src/server');

async function startServer(options = {}) {
  const {
    port = 0,
    workDir = null,
    storageDir = null,
    serverOpts = {},
  } = options;

  // Caller may pin a high port for repeat runs, but reject reserved range.
  if (port !== 0 && port < 11000) {
    throw new Error(`startServer: port ${port} is below 11000 — pick a high port (CLAUDE.md memory).`);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-'));
  const resolvedWorkDir = workDir || path.join(tmpRoot, 'work');
  const resolvedStorage = storageDir || path.join(tmpRoot, 'storage');
  fs.mkdirSync(resolvedWorkDir, { recursive: true });
  fs.mkdirSync(resolvedStorage, { recursive: true });

  // ClaudeCodeWebServer captures process.cwd() into baseFolder in its
  // constructor; chdir into workDir BEFORE constructing so the watcher /
  // file-browser roots in the temp tree, not in the worktree.
  const originalCwd = process.cwd();
  process.chdir(resolvedWorkDir);

  let server;
  try {
    server = new ClaudeCodeWebServer({
      port,
      noAuth: true,
      dev: false,
      sessionStoreOptions: { storageDir: resolvedStorage },
      ...serverOpts,
    });
  } finally {
    process.chdir(originalCwd);
  }

  const httpServer = await server.start();
  const assignedPort = httpServer.address().port;

  return {
    server,
    port: assignedPort,
    baseUrl: `http://127.0.0.1:${assignedPort}`,
    wsUrl: `ws://127.0.0.1:${assignedPort}`,
    workDir: resolvedWorkDir,
    storageDir: resolvedStorage,
    tmpRoot,
    async close() {
      try { await server.close(); } catch (_) { /* ignore */ }
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
      } catch (_) { /* ignore: best-effort cleanup */ }
    },
  };
}

module.exports = { startServer };
