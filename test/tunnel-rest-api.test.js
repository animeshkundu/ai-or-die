const assert = require('assert');
const http = require('http');

// Try to load server - may fail if node-pty not available
let ClaudeCodeWebServer;
try {
  ({ ClaudeCodeWebServer } = require('../src/server'));
} catch (e) {
  // node-pty not available locally, tests will be skipped
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request and return { status, headers, body }.
 * Body is parsed as JSON when content-type is application/json.
 */
function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {},
    };

    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let parsed;
        const ct = res.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try { parsed = JSON.parse(raw.toString('utf-8')); } catch { parsed = raw.toString('utf-8'); }
        } else {
          parsed = raw;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });

    req.on('error', reject);

    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.write(payload);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

(ClaudeCodeWebServer ? describe : describe.skip)('Tunnel REST API', function () {
  this.timeout(30000);

  let server, port;

  before(async function () {
    this.timeout(30000);
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    if (server) server.close();
  });

  describe('GET /api/tunnel/status', function () {
    it('should return running false and null publicUrl when no tunnel manager', async function () {
      const res = await request(port, 'GET', '/api/tunnel/status');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { running: false, publicUrl: null });
    });
  });

  describe('POST /api/tunnel/restart', function () {
    it('should return 404 with error when no tunnel manager', async function () {
      const res = await request(port, 'POST', '/api/tunnel/restart');
      assert.strictEqual(res.status, 404);
      assert.ok(res.body.error, 'Expected error property in response');
      assert.ok(res.body.error.includes('No tunnel configured'), 'Expected "No tunnel configured" error message');
    });
  });
});
