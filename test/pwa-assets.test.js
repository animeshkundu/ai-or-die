'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');

// PWA installability assets: icons must be real PNGs (the manifest declares image/png),
// the manifest must parse, and the manifest <link> must use crossorigin=use-credentials
// so the manifest/icons aren't auth-redirected behind a credentialed proxy/tunnel.

describe('PWA assets', function () {
  this.timeout(20000);
  let server, port;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port; // OS-assigned ephemeral port (>11000)
  });

  after(function () {
    if (server) server.close();
  });

  async function get(p) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf };
  }

  for (const size of [16, 32, 144, 180, 192, 512]) {
    it(`/icon-${size}.png is a real PNG served as image/png`, async function () {
      const { res, buf } = await get(`/icon-${size}.png`);
      assert.strictEqual(res.status, 200, `status for icon-${size}`);
      assert.match(res.headers.get('content-type') || '', /image\/png/);
      // PNG signature: 89 50 4E 47
      assert.deepStrictEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], `PNG signature for icon-${size}`);
    });
  }

  it('manifest declares 192/512 png icons and parses', async function () {
    const { res, buf } = await get('/manifest.json');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /manifest\+json/);
    const m = JSON.parse(buf.toString('utf8'));
    assert.ok(m.icons.some(i => i.sizes === '192x192' && i.type === 'image/png'), 'has 192 png icon');
    assert.ok(m.icons.some(i => i.sizes === '512x512' && i.type === 'image/png'), 'has 512 png icon');
  });

  it('service worker is served with a JS content-type', async function () {
    const { res } = await get('/service-worker.js');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /javascript/);
  });

  it('index.html manifest link uses crossorigin=use-credentials', function () {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
    assert.match(
      html,
      /<link[^>]*rel="manifest"[^>]*crossorigin="use-credentials"/,
      'manifest <link> must carry crossorigin="use-credentials"'
    );
  });
});
