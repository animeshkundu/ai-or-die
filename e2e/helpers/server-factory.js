const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Start the server programmatically via ClaudeCodeWebServer class.
 * Each test spec gets its own instance with an isolated session store
 * to prevent session pollution across test files.
 *
 * @param {object} [opts]
 * @param {string} [opts.auth] — when set, boots the server with
 *   `--auth <token>` semantics (sets ClaudeCodeWebServer's `auth` option
 *   and clears `noAuth`). Used by the auth-regressions journey spec
 *   so QA #13's URL-token / log-leak guards can be exercised end-to-end.
 * @returns {Promise<{server: Object, port: number, url: string}>}
 */
async function createServer(opts) {
  opts = opts || {};
  // Create a unique temp directory for this server instance's session store
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-or-die-test-'));
  const { ClaudeCodeWebServer } = require('../../src/server');
  const constructorOpts = {
    port: 0,
    sessionStoreOptions: { storageDir: tempDir },
  };
  if (opts.auth) {
    constructorOpts.auth = opts.auth;
    constructorOpts.noAuth = false;
  } else {
    constructorOpts.noAuth = true;
  }
  const server = new ClaudeCodeWebServer(constructorOpts);
  const httpServer = await server.start();
  const port = httpServer.address().port;
  // Store tempDir on server for cleanup
  server._testTempDir = tempDir;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

/**
 * Spawn the actual CLI entry point (node bin/ai-or-die.js) as a child process.
 * Used by the golden path test to validate the real user flow.
 * @returns {Promise<{process: ChildProcess, port: number, url: string}>}
 */
async function spawnCli() {
  const binPath = path.resolve(__dirname, '../../bin/ai-or-die.js');

  // Use a random high port (CLI rejects port 0)
  const randomPort = 49152 + Math.floor(Math.random() * 16383);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-or-die-test-'));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, '--disable-auth', '--no-open', '--port', String(randomPort)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test', AI_OR_DIE_SESSION_DIR: tempDir }
    });

    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI did not start within 30s. Output: ${output}`));
    }, 30000);

    child.stdout.on('data', (data) => {
      output += data.toString();
      // Parse the port from "Server running at http://127.0.0.1:PORT"
      const match = output.match(/running at https?:\/\/[\d.]+:(\d+)/i)
        || output.match(/listening on.*?:(\d+)/i)
        || output.match(/:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        const port = parseInt(match[1], 10);
        // Wait for server to be ready by polling health endpoint
        const checkReady = setInterval(async () => {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/health`);
            if (res.ok) {
              clearInterval(checkReady);
              resolve({ process: child, port, url: `http://127.0.0.1:${port}` });
            }
          } catch {
            // Not ready yet
          }
        }, 200);
        // Safety timeout for health check
        setTimeout(() => {
          clearInterval(checkReady);
          reject(new Error(`Server health check failed. Port: ${port}, Output: ${output}`));
        }, 15000);
      }
    });

    child.stderr.on('data', (data) => {
      output += data.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Create a session and start a terminal tool via REST + WebSocket API.
 * Used by focused tests that don't need to walk the full UI flow.
 * @param {number} port - Server port
 * @param {string} [name='Playwright Test'] - Session name
 * @returns {Promise<string>} Session ID
 */
async function createSessionViaApi(port, name = 'Playwright Test') {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const data = await res.json();
  return data.sessionId;
}

module.exports = { createServer, spawnCli, createSessionViaApi };
