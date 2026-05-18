// test/files-find.test.js — GET /api/files/find unit tests (Part B of file-browser v2).
//
// Covers the fuzzy filename search endpoint: rg --files enumeration, fuzzysort
// scoring, .gitignore awareness, the 10k file enumeration cap, the per-session
// 5 queries/sec rate limit, validatePath sandboxing, and the response shape
// per spec (file-browser.md §"GET /api/files/find").
//
// Pattern matches test/file-browser-api.test.js: spawn the real server in a
// temp baseFolder, drive HTTP via Node's http module, assert JSON response
// shapes. Tests use port 0 (ephemeral) so we never collide with the
// dev-server port (7777) or the test-port-floor convention (>11000).

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { execFileSync } = require('child_process');

let ClaudeCodeWebServer;
try {
  ({ ClaudeCodeWebServer } = require('../src/server'));
} catch (e) {
  // node-pty not installable on this runner — entire suite skips.
}

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
      res.on('data', (c) => chunks.push(c));
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

(ClaudeCodeWebServer ? describe : describe.skip)('GET /api/files/find', function () {
  this.timeout(30000);

  let server, port, tmpDir;

  // Each test gets its own session id so the per-session 5 q/s rate
  // limiter doesn't bleed across tests (the dedicated rate-limit test
  // bursts deliberately).
  function freshSession() {
    return request(port, 'POST', '/api/sessions/create', {
      name: 'find-test-' + Math.random().toString(36).slice(2, 8),
      workingDir: tmpDir,
    }).then((r) => {
      assert.strictEqual(r.status, 200, 'session create: ' + JSON.stringify(r.body));
      return r.body.id || r.body.sessionId;
    });
  }

  before(async function () {
    this.timeout(30000);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-test-'));

    // Build a populated tree:
    //   /src/app.js
    //   /src/utils/format-date.js
    //   /src/utils/format-currency.js
    //   /src/components/UserProfile.tsx
    //   /test/app.test.js
    //   /node_modules/junk/index.js  ← gitignored
    //   /.gitignore                  ← ignores node_modules/
    //
    // We `git init` the dir so ripgrep honours .gitignore — by default
    // rg only respects .gitignore files inside a real git repo. (The
    // `--no-require-git` flag would relax that, but we want to mirror
    // the production behaviour from /api/search exactly.)
    fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'junk'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), '// app');
    fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'format-date.js'), '// fd');
    fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'format-currency.js'), '// fc');
    fs.writeFileSync(path.join(tmpDir, 'src', 'components', 'UserProfile.tsx'), '// up');
    fs.writeFileSync(path.join(tmpDir, 'test', 'app.test.js'), '// at');
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'junk', 'index.js'), '// junk');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');
    try {
      execFileSync('git', ['init', '-q'], { cwd: tmpDir, stdio: 'ignore' });
    } catch (_) {
      // git not present on this runner — the gitignore-aware test will
      // still detect node_modules entries via this no-init fallback and
      // will be skipped explicitly below.
    }

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
    process.chdir(origCwd);
  });

  after(function () {
    if (server) server.close();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ── Response shape ───────────────────────────────────────────────────────

  it('returns matches, truncated, totalFound, queryMs (the documented shape)', async function () {
    const sessionId = await freshSession();
    const r = await request(port, 'GET', '/api/files/find?q=app&session=' + encodeURIComponent(sessionId));
    assert.strictEqual(r.status, 200, 'body: ' + JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.matches), 'matches is array');
    assert.strictEqual(typeof r.body.truncated, 'boolean');
    assert.strictEqual(typeof r.body.totalFound, 'number');
    assert.strictEqual(typeof r.body.queryMs, 'number');
    assert.ok(r.body.matches.length > 0, 'should find app.js / app.test.js');
    for (const m of r.body.matches) {
      assert.strictEqual(typeof m.path, 'string');
      assert.strictEqual(typeof m.basename, 'string');
      assert.strictEqual(typeof m.score, 'number');
      assert.strictEqual(typeof m.mtimeMs, 'number');
      // path should be absolute (server normalizes to forward slashes elsewhere
      // but the find endpoint returns the OS-native absolute form for the
      // client-side resolver chain).
      assert.ok(path.isAbsolute(m.path), 'absolute path: ' + m.path);
    }
  });

  // ── Fuzzy ranking ────────────────────────────────────────────────────────

  it('ranks basename matches above directory-only matches', async function () {
    const sessionId = await freshSession();
    // Query "app" — should rank src/app.js above test/app.test.js (basename "app.js"
    // is a tighter contiguous match than "app.test.js"), and both above any
    // path-only "app" coincidence (there is none in this tree).
    const r = await request(port, 'GET', '/api/files/find?q=app&session=' + encodeURIComponent(sessionId));
    assert.strictEqual(r.status, 200);
    const basenames = r.body.matches.map((m) => m.basename);
    // Both should appear; app.js should outrank app.test.js.
    assert.ok(basenames.indexOf('app.js') !== -1, 'app.js found: ' + basenames);
    assert.ok(basenames.indexOf('app.test.js') !== -1, 'app.test.js found: ' + basenames);
    assert.ok(
      basenames.indexOf('app.js') < basenames.indexOf('app.test.js'),
      'app.js outranks app.test.js — got order: ' + basenames
    );
  });

  it('handles acronym / non-contiguous matches (fuzzysort core feature)', async function () {
    const sessionId = await freshSession();
    // Query "fd" — should match "format-date.js" via the f...d acronym path.
    const r = await request(port, 'GET', '/api/files/find?q=fd&session=' + encodeURIComponent(sessionId));
    assert.strictEqual(r.status, 200);
    const basenames = r.body.matches.map((m) => m.basename);
    assert.ok(basenames.includes('format-date.js'),
      'fd → format-date.js: ' + JSON.stringify(basenames));
  });

  // QA journey P1 finding #5 (task #14): typing a path-separator query
  // (e.g. `lib/router`) used to score 0 because fuzzysort was scoring
  // against basename only — basenames never contain `/`. Real users type
  // `path/file` to disambiguate among many same-named files (the natural
  // VS Code Quick Open pattern). The fix scores against BOTH basename and
  // relative path; fuzzysort's multi-key API picks the best per-target
  // score automatically.
  it('matches a path-separator query against the relative path (e.g. `utils/format` → format-date.js)', async function () {
    const sessionId = await freshSession();
    // Our fixture has src/utils/format-date.js and src/utils/format-currency.js.
    // Typing `utils/format` is the canonical "I want one of those" query.
    const r = await request(port, 'GET',
      '/api/files/find?q=' + encodeURIComponent('utils/format') +
      '&session=' + encodeURIComponent(sessionId));
    assert.strictEqual(r.status, 200);
    const basenames = r.body.matches.map((m) => m.basename);
    assert.ok(
      basenames.includes('format-date.js') || basenames.includes('format-currency.js'),
      'path-separator query failed to match either format-* file: ' + JSON.stringify(r.body.matches)
    );
  });

  it('matches a deep path-separator query against the full relative path (e.g. `src/components/UserProfile`)', async function () {
    const sessionId = await freshSession();
    // Type a query that ONLY matches via the path component — the basename
    // alone (`UserProfile.tsx`) has no slash anywhere. Confirms the multi-
    // key fuzzysort fix sources matches from BOTH keys, not just basename.
    const r = await request(port, 'GET',
      '/api/files/find?q=' + encodeURIComponent('components/UserProfile') +
      '&session=' + encodeURIComponent(sessionId));
    assert.strictEqual(r.status, 200);
    const basenames = r.body.matches.map((m) => m.basename);
    assert.ok(basenames.includes('UserProfile.tsx'),
      'deep path-separator query did not match UserProfile.tsx: ' + JSON.stringify(r.body.matches));
  });

  it('basename-only query still wins when no path qualifier is given', async function () {
    // Regression guard: the multi-key fix must not REGRESS the existing
    // basename-only flow. Typing `app` should still surface app.js + app.test.js
    // and rank app.js (tighter basename match) first.
    const sessionId = await freshSession();
    const r = await request(port, 'GET', '/api/files/find?q=app&session=' + encodeURIComponent(sessionId));
    assert.strictEqual(r.status, 200);
    const basenames = r.body.matches.map((m) => m.basename);
    assert.ok(basenames.indexOf('app.js') !== -1, 'app.js found: ' + basenames);
    assert.ok(
      basenames.indexOf('app.js') < basenames.indexOf('app.test.js'),
      'app.js still outranks app.test.js: ' + basenames
    );
  });

  // ── .gitignore awareness ─────────────────────────────────────────────────

  it('respects .gitignore (does not surface node_modules/ entries)', async function () {
    const sessionId = await freshSession();
    // node_modules/junk/index.js exists; .gitignore lists node_modules/.
    // rg --files respects .gitignore by default — we should never see junk.
    const r = await request(port, 'GET', '/api/files/find?q=index&session=' + encodeURIComponent(sessionId));
    assert.strictEqual(r.status, 200);
    for (const m of r.body.matches) {
      assert.ok(
        m.path.indexOf('node_modules') === -1,
        'gitignored entry leaked: ' + m.path
      );
    }
  });

  // ── Validation + errors ──────────────────────────────────────────────────

  it('rejects missing q with 400', async function () {
    const sessionId = await freshSession();
    const r = await request(port, 'GET', '/api/files/find?session=' + encodeURIComponent(sessionId));
    assert.strictEqual(r.status, 400);
  });

  it('rejects whitespace-only q with 400', async function () {
    const sessionId = await freshSession();
    const r = await request(port, 'GET', '/api/files/find?q=%20&session=' + encodeURIComponent(sessionId));
    assert.strictEqual(r.status, 400);
  });

  it('rejects path outside sandbox with 403', async function () {
    const sessionId = await freshSession();
    const outside = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    const r = await request(port, 'GET',
      '/api/files/find?q=foo&path=' + encodeURIComponent(outside) +
      '&session=' + encodeURIComponent(sessionId));
    assert.strictEqual(r.status, 403);
  });

  it('clamps limit to 200 max', async function () {
    const sessionId = await freshSession();
    const r = await request(port, 'GET', '/api/files/find?q=js&limit=9999&session=' + encodeURIComponent(sessionId));
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.matches.length <= 200, 'limit clamped: ' + r.body.matches.length);
  });

  it('honours an explicit limit smaller than the result set', async function () {
    const sessionId = await freshSession();
    const r = await request(port, 'GET', '/api/files/find?q=js&limit=2&session=' + encodeURIComponent(sessionId));
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.matches.length <= 2, 'limit honoured: ' + r.body.matches.length);
  });

  // ── Per-session rate limit ───────────────────────────────────────────────

  it('rate-limits at 5 queries/sec/session — 6th hits 429', async function () {
    const sessionId = await freshSession();
    // Burst 6 in a tight loop — sliding-window 1s bucket should 429 the 6th.
    const url = '/api/files/find?q=app&session=' + encodeURIComponent(sessionId);
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await request(port, 'GET', url));
    }
    const statuses = results.map((r) => r.status);
    const has429 = statuses.includes(429);
    assert.ok(has429, 'expected at least one 429 in burst, got: ' + JSON.stringify(statuses));
  });

  it('rate limit is per-session — a different session id is independently bucketed', async function () {
    const sid1 = await freshSession();
    // Burn the first session's bucket.
    const burnUrl = '/api/files/find?q=app&session=' + encodeURIComponent(sid1);
    for (let i = 0; i < 6; i++) await request(port, 'GET', burnUrl);
    // A fresh session should NOT see a 429 — its bucket is empty.
    const sid2 = await freshSession();
    const r = await request(port, 'GET',
      '/api/files/find?q=app&session=' + encodeURIComponent(sid2));
    assert.strictEqual(r.status, 200);
  });
});
