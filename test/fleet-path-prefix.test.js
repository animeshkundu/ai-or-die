'use strict';

// Fleet path-mode dual-serve: the same instance must work at root `/`
// (standalone, --tunnel) and under an arbitrary `/m/<id>/` prefix (fleet)
// with zero startup config.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ClaudeCodeWebServer } = require('../src/server');

describe('fleet path prefix dual-serve', function () {
  this.timeout(20000);
  let server;
  let port;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    if (server) server.close();
  });

  async function get(p) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  }

  it('root mode unchanged: /, /auth-status, /api/health, /manifest.json', async function () {
    const home = await get('/');
    assert.strictEqual(home.status, 200);
    assert.match(home.text, /ai-or-die/);

    const as = await get('/auth-status');
    assert.strictEqual(as.status, 200);
    assert.deepStrictEqual(JSON.parse(as.text).authRequired, false);

    const health = await get('/api/health');
    assert.strictEqual(health.status, 200);

    const m = JSON.parse((await get('/manifest.json')).text);
    assert.strictEqual(m.scope, '/');
    assert.strictEqual(m.start_url, '/');
  });

  it('prefixed mode serves the same app: /m/demo/ + /m/demo/auth-status + /m/demo/api/health', async function () {
    const home = await get('/m/demo/');
    assert.strictEqual(home.status, 200);
    assert.match(home.text, /ai-or-die/);

    const bare = await get('/m/demo');
    assert.strictEqual(bare.status, 200);

    const as = await get('/m/demo/auth-status');
    assert.strictEqual(as.status, 200);
    assert.deepStrictEqual(JSON.parse(as.text).authRequired, false);

    const health = await get('/m/demo/api/health');
    assert.strictEqual(health.status, 200);

    const sessions = await get('/m/demo/api/sessions/list');
    assert.strictEqual(sessions.status, 200);
  });

  it('prefixed manifest scopes id/start_url/scope/icons to the prefix', async function () {
    const m = JSON.parse((await get('/m/demo/manifest.json')).text);
    assert.strictEqual(m.scope, '/m/demo/');
    assert.strictEqual(m.start_url, '/m/demo/');
    assert.strictEqual(m.id, '/m/demo/');
    for (const icon of m.icons) assert.ok(icon.src.startsWith('/m/demo/'), icon.src);
    for (const sc of m.shortcuts) assert.ok(sc.url.startsWith('/m/demo/'), sc.url);
    for (const ss of m.screenshots) assert.ok(ss.src.startsWith('/m/demo/'), ss.src);
  });

  it('prefixed static + docs resolve under the prefix', async function () {
    const css = await get('/m/demo/style.css');
    assert.strictEqual(css.status, 200);
    const fb = await get('/m/demo/fleet-base.js');
    assert.strictEqual(fb.status, 200);
    assert.match(fb.text, /withBase/);
    const vendor = await get('/m/demo/vendor/xterm/xterm.js');
    assert.strictEqual(vendor.status, 200);
  });

  it('bare prefix with query still routes (/m/demo?token=x → /)', async function () {
    const as = await get('/m/demo/auth-status?token=x');
    assert.strictEqual(as.status, 200);
  });

  it('bare /m/ and unknown prefixed API behave like root (no prefix leak)', async function () {
    const bare = await get('/m/');
    assert.strictEqual(bare.status, 404);
    const root404 = await get('/api/no-such-route-xyz');
    const prefixed404 = await get('/m/demo/api/no-such-route-xyz');
    assert.strictEqual(prefixed404.status, root404.status);
  });

  it('index.html has no root-absolute first-party asset refs', function () {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
    const bad = [];
    for (const m of html.matchAll(/(?:src|href)="(\/[^"]*)"/g)) {
      bad.push(m[1]);
    }
    assert.deepStrictEqual(bad, [], `root-absolute refs would escape /m/<id>/: ${bad.join(', ')}`);
  });

  it('service worker registers relatively with prefix scope', function () {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
    assert.ok(!html.includes("register('/service-worker.js')"), 'absolute SW registration removed');
    assert.ok(html.includes("register('service-worker.js'"), 'relative SW registration present');
  });

  describe('fleet-base.js helper', function () {
    function loadHelper(pathname) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'fleet-base.js'), 'utf8');
      const sandbox = { window: { location: { pathname } }, console };
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(src, sandbox, { filename: 'fleet-base.js' });
      return sandbox.window;
    }

    it('root mode is identity', function () {
      const w = loadHelper('/');
      assert.strictEqual(w.getBasePrefix(), '');
      assert.strictEqual(w.withBase('/api/x'), '/api/x');
      assert.strictEqual(w.scopedAuthKey('cc-web-token'), 'cc-web-token');
    });

    it('fleet mode prefixes root-absolute paths once', function () {
      const w = loadHelper('/m/demo/some/page?x=1');
      assert.strictEqual(w.getBasePrefix(), '/m/demo');
      assert.strictEqual(w.withBase('/api/x'), '/m/demo/api/x');
      assert.strictEqual(w.withBase('/m/demo/api/x'), '/m/demo/api/x');
      assert.strictEqual(w.withBase('relative.js'), 'relative.js');
      assert.strictEqual(w.withBase('https://cdn/x.js'), 'https://cdn/x.js');
      assert.strictEqual(w.scopedAuthKey('cc-web-token'), 'cc-web-token:/m/demo');
    });
  });
});
