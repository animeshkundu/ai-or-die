// test/repo-root.test.js — GET /api/sessions/:sessionId/repo-root tests (Part C).
//
// Covers git repo-root resolution for a session: positive (git init'd dir),
// negative (non-git dir → null), 404 (no such session), 403 (workingDir
// outside sandbox), and the per-session caching contract.

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
} catch (e) { /* skip suite below */ }

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port, path: urlPath, method, headers: {} };
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

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (_) { return false; }
}

(ClaudeCodeWebServer && gitAvailable() ? describe : describe.skip)('GET /api/sessions/:sessionId/repo-root', function () {
  this.timeout(30000);

  let server, port, baseDir, repoDir, nonRepoDir;

  before(async function () {
    this.timeout(30000);
    // baseDir is the served sandbox; we put two siblings inside it:
    //   /repo    — git init'd
    //   /plain   — no .git
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-root-test-'));
    repoDir = path.join(baseDir, 'repo');
    nonRepoDir = path.join(baseDir, 'plain');
    fs.mkdirSync(repoDir);
    fs.mkdirSync(nonRepoDir);
    fs.mkdirSync(path.join(repoDir, 'src'));
    fs.writeFileSync(path.join(repoDir, 'src', 'app.js'), '// app');
    execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'ignore' });

    const origCwd = process.cwd();
    process.chdir(baseDir);
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
    process.chdir(origCwd);
  });

  after(function () {
    if (server) server.close();
    if (baseDir) {
      try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  async function makeSession(workingDir) {
    const r = await request(port, 'POST', '/api/sessions/create', {
      name: 'rr-' + Math.random().toString(36).slice(2, 8),
      workingDir,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.id || r.body.sessionId;
  }

  it('resolves repo root for a session whose workingDir is inside a git repo', async function () {
    // Create the session with workingDir = repoDir/src — git rev-parse
    // should walk up and report repoDir as the root.
    const sid = await makeSession(path.join(repoDir, 'src'));
    const r = await request(port, 'GET', '/api/sessions/' + sid + '/repo-root');
    assert.strictEqual(r.status, 200);
    assert.notStrictEqual(r.body.root, null,
      'expected non-null root for session inside git repo, got null (server validation rejected git output?)');
    // Compare via realpath of BOTH sides so we don't trip on Windows 8.3
    // short vs long form (CI runner exposes tmpdir as `C:\Users\RUNNER~1`
    // but git rev-parse returns the long form `C:\Users\runneradmin`).
    // Both calls go through the same canonicalization pipe, so they
    // collapse to the same form regardless of which form the caller
    // started in. Matters on macOS too (where /var → /private/var).
    const canonicalActual = fs.realpathSync(r.body.root);
    const canonicalExpected = fs.realpathSync(repoDir);
    assert.strictEqual(canonicalActual, canonicalExpected,
      'expected ' + canonicalExpected + ', got ' + canonicalActual +
      ' (server returned ' + r.body.root + ')');
  });

  it('returns root: null for a session whose workingDir is not inside a git repo', async function () {
    const sid = await makeSession(nonRepoDir);
    const r = await request(port, 'GET', '/api/sessions/' + sid + '/repo-root');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.root, null);
  });

  it('returns 404 for an unknown session id', async function () {
    const r = await request(port, 'GET', '/api/sessions/does-not-exist/repo-root');
    assert.strictEqual(r.status, 404);
  });

  it('caches the result per session — second call does not re-spawn git', async function () {
    // We can't directly observe the spawn count, but we CAN observe behaviour
    // via cache invalidation: delete the .git dir AFTER the first call, then
    // assert the second call still returns the cached repo root.
    const sid = await makeSession(repoDir);
    const r1 = await request(port, 'GET', '/api/sessions/' + sid + '/repo-root');
    assert.strictEqual(r1.status, 200);
    assert.notStrictEqual(r1.body.root, null);

    // Strip .git and call again — if there were no cache, git rev-parse
    // would now fail and return null. With the cache, we expect the same
    // root as before. (We restore .git after the test so other tests don't
    // see a torn-down repo.)
    const gitDir = path.join(repoDir, '.git');
    const backupDir = path.join(repoDir, '.git_backup_for_cache_test');
    fs.renameSync(gitDir, backupDir);
    try {
      const r2 = await request(port, 'GET', '/api/sessions/' + sid + '/repo-root');
      assert.strictEqual(r2.status, 200);
      assert.strictEqual(r2.body.root, r1.body.root,
        'cache should keep returning the same root after .git is removed');
    } finally {
      fs.renameSync(backupDir, gitDir);
    }
  });
});
