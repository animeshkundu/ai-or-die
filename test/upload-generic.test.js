// test/upload-generic.test.js — Part D server-side reinforcements to
// POST /api/files/upload for generic file drops (.claude-attachments/).
//
// Covers:
//   - Existing happy path: .pdf upload to .claude-attachments/
//   - Existing rejection: blocked extension (.exe → 403)
//   - Existing rejection: oversize (>10MB → 413)
//   - NEW: per-session 100 MB cap across .claude-attachments/ → 413 with
//     a stable error code the client can switch on for a toast
//   - NEW: first-write-per-session appends `.claude-attachments/` to
//     <workingDir>/.gitignore (idempotent, best-effort)
//   - NEW: 24h sweep deletes stale attachments (driven directly so the
//     test doesn't have to wait 24 hours)

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

let ClaudeCodeWebServer;
try {
  ({ ClaudeCodeWebServer } = require('../src/server'));
} catch (e) { /* skip */ }

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

(ClaudeCodeWebServer ? describe : describe.skip)('POST /api/files/upload — generic-drop reinforcements', function () {
  this.timeout(30000);

  let server, port, baseDir, workingDir, attachmentsDir;

  before(async function () {
    this.timeout(30000);
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
    workingDir = path.join(baseDir, 'project');
    attachmentsDir = path.join(workingDir, '.claude-attachments');
    fs.mkdirSync(workingDir);

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

  beforeEach(function () {
    // Wipe + recreate the attachments dir so per-test asserts on size cap
    // and .gitignore start from a known clean state. Keep the workingDir
    // itself intact so the .gitignore-append test can manage its own
    // .gitignore file lifecycle.
    if (fs.existsSync(attachmentsDir)) {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
    // Remove any leftover .gitignore so each test starts clean.
    const gi = path.join(workingDir, '.gitignore');
    if (fs.existsSync(gi)) fs.unlinkSync(gi);
    // Wipe any sibling dirs created by previous tests (e.g. docs/) so
    // happy-path uploads to those dirs don't 409 on stale files.
    for (const ent of fs.readdirSync(workingDir, { withFileTypes: true })) {
      if (ent.isDirectory() && ent.name !== '.claude-attachments') {
        fs.rmSync(path.join(workingDir, ent.name), { recursive: true, force: true });
      }
    }
  });

  // ── Happy path + existing guards ─────────────────────────────────────────

  it('uploads a small PDF to .claude-attachments/ (200)', async function () {
    const pdf = Buffer.from('%PDF-1.4\n%fake pdf body');
    const r = await request(port, 'POST', '/api/files/upload', {
      targetDir: attachmentsDir,
      fileName: 'note.pdf',
      content: pdf.toString('base64'),
    });
    // 200 (the existing endpoint returns 200, not 201 — see src/server.js).
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.name, 'note.pdf');
    assert.ok(fs.existsSync(path.join(attachmentsDir, 'note.pdf')));
  });

  it('rejects a blocked extension (.exe → 403)', async function () {
    const r = await request(port, 'POST', '/api/files/upload', {
      targetDir: attachmentsDir,
      fileName: 'evil.exe',
      content: Buffer.from('MZ').toString('base64'),
    });
    assert.strictEqual(r.status, 403);
  });

  it('accepts a body over the old ~100KB global-parser limit but under the decoded 10MB cap (200)', async function () {
    // Regression guard for the upload fix: the global express.json() (~100kb
    // default) used to run BEFORE the route's parser and 413'd any base64
    // body over ~100kb — so non-image drag-drops of normal files silently
    // failed. The route is now exempt from the global parser and mounts its
    // own 20mb parser, so a 1 MB file (~1.4 MB JSON body) reaches the handler.
    const big = Buffer.alloc(1024 * 1024, 'a'); // 1 MB → ~1.4 MB JSON body
    const r = await request(port, 'POST', '/api/files/upload', {
      targetDir: attachmentsDir,
      fileName: 'big.bin',
      content: big.toString('base64'),
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(fs.existsSync(path.join(attachmentsDir, 'big.bin')));
  });

  it('still exempts the route when addressed with a trailing slash (200)', async function () {
    // Express routes `/api/files/upload/` to the same handler; the global-parser
    // exemption normalizes the trailing slash so it is exempt too (a bare
    // req.path === '/api/files/upload' check would let the global ~100kb
    // parser 413 it again).
    const big = Buffer.alloc(300 * 1024, 'b'); // ~400 KB JSON body, > old 100kb
    const r = await request(port, 'POST', '/api/files/upload/', {
      targetDir: attachmentsDir,
      fileName: 'slash.bin',
      content: big.toString('base64'),
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(fs.existsSync(path.join(attachmentsDir, 'slash.bin')));
  });

  it('still exempts the route when addressed with a different case (200)', async function () {
    // Express default routing is case-insensitive, so `/api/FILES/upload`
    // reaches the handler; the global-parser exemption is lower-cased to match,
    // otherwise the ~100kb global parser would 413 a case-variant request.
    const big = Buffer.alloc(300 * 1024, 'c'); // > old 100kb global limit
    const r = await request(port, 'POST', '/api/FILES/upload', {
      targetDir: attachmentsDir,
      fileName: 'case.bin',
      content: big.toString('base64'),
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(fs.existsSync(path.join(attachmentsDir, 'case.bin')));
  });

  it('rejects content over the decoded 10 MB cap (413)', async function () {
    // base64 of 11 MB (~14.7 MB) fits under the 20mb route parser, so the
    // body is parsed and the decoded-size guard returns the 413.
    const big = Buffer.alloc(11 * 1024 * 1024, 'a');
    const r = await request(port, 'POST', '/api/files/upload', {
      targetDir: attachmentsDir,
      fileName: 'toobig.bin',
      content: big.toString('base64'),
    });
    assert.strictEqual(r.status, 413, JSON.stringify(r.body));
  });

  it('rejects a body over the 20mb route parser limit with a JSON error (413)', async function () {
    // base64 of 16 MB (~21.3 MB) exceeds the route parser limit, so the parser
    // throws entity.too.large; the body-parser error handler must translate it
    // to the API's { error } JSON shape (not Express default HTML).
    const big = Buffer.alloc(16 * 1024 * 1024, 'a');
    const r = await request(port, 'POST', '/api/files/upload', {
      targetDir: attachmentsDir,
      fileName: 'huge.bin',
      content: big.toString('base64'),
    });
    assert.strictEqual(r.status, 413, JSON.stringify(r.body));
    assert.ok(r.body && typeof r.body === 'object' && r.body.error,
      'expected a JSON { error } body, got: ' + JSON.stringify(r.body).slice(0, 200));
  });

  it('returns a JSON 400 for a malformed JSON body', async function () {
    const r = await request(port, 'POST', '/api/files/upload', '{ not valid json');
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.ok(r.body && typeof r.body === 'object' && r.body.error,
      'expected a JSON { error } body, got: ' + JSON.stringify(r.body).slice(0, 200));
  });

  // ── NEW: per-session 100 MB cap on .claude-attachments/ ──────────────────
  // The production cap is 100 MB. To exercise it without colliding with
  // the global express.json() default (~100 KB) per-request limit, the
  // tests monkeypatch the cap to a small value and use small uploads.
  // The cap-computation logic itself is what we're verifying — the
  // specific 100 MB threshold is policy.

  it('rejects an upload that would push .claude-attachments/ over the per-session cap (413 + code)', async function () {
    const original = server._attachmentSessionCapBytes.bind(server);
    server._attachmentSessionCapBytes = () => 100 * 1024; // 100 KB cap for the test
    try {
      // Pre-seed 95 KB of files (a single file under the per-request limit).
      fs.mkdirSync(attachmentsDir, { recursive: true });
      fs.writeFileSync(path.join(attachmentsDir, 'pre.bin'), Buffer.alloc(95 * 1024, 'a'));
      // Attempt a 10 KB upload — total would be 105 KB > 100 KB cap.
      const fresh = Buffer.alloc(10 * 1024, 'b');
      const r = await request(port, 'POST', '/api/files/upload', {
        targetDir: attachmentsDir,
        fileName: 'overflow.bin',
        content: fresh.toString('base64'),
      });
      assert.strictEqual(r.status, 413, 'expected 413 for over-cap; got ' + r.status);
      assert.strictEqual(r.body.code, 'attachment_cap_exceeded',
        'expected error code "attachment_cap_exceeded"; got ' + JSON.stringify(r.body).slice(0, 200));
      assert.ok(!fs.existsSync(path.join(attachmentsDir, 'overflow.bin')),
        'over-cap file should not exist on disk');
    } finally {
      server._attachmentSessionCapBytes = original;
    }
  });

  it('allows uploads under the per-session cap even after partial accumulation', async function () {
    const original = server._attachmentSessionCapBytes.bind(server);
    server._attachmentSessionCapBytes = () => 100 * 1024;
    try {
      fs.mkdirSync(attachmentsDir, { recursive: true });
      fs.writeFileSync(path.join(attachmentsDir, 'pre.bin'), Buffer.alloc(50 * 1024, 'a'));
      // Attempt a 10 KB upload — total 60 KB << 100 KB cap → 200.
      const r = await request(port, 'POST', '/api/files/upload', {
        targetDir: attachmentsDir,
        fileName: 'ok.bin',
        content: Buffer.alloc(10 * 1024, 'c').toString('base64'),
      });
      assert.strictEqual(r.status, 200);
    } finally {
      server._attachmentSessionCapBytes = original;
    }
  });

  it('cap only applies to .claude-attachments/ uploads (other targetDirs unaffected)', async function () {
    const original = server._attachmentSessionCapBytes.bind(server);
    server._attachmentSessionCapBytes = () => 10 * 1024; // 10 KB cap
    try {
      // Pre-seed .claude-attachments/ over the 10 KB cap, then upload to a
      // different sub-dir. Should succeed regardless.
      fs.mkdirSync(attachmentsDir, { recursive: true });
      fs.writeFileSync(path.join(attachmentsDir, 'pre.bin'), Buffer.alloc(20 * 1024, 'a'));
      const otherDir = path.join(workingDir, 'docs');
      fs.mkdirSync(otherDir, { recursive: true });
      const r = await request(port, 'POST', '/api/files/upload', {
        targetDir: otherDir,
        fileName: 'doc.pdf',
        content: Buffer.from('%PDF').toString('base64'),
      });
      assert.strictEqual(r.status, 200);
    } finally {
      server._attachmentSessionCapBytes = original;
    }
  });

  // ── NEW: .gitignore append on first attachment write per session ─────────

  it('appends .claude-attachments/ to <workingDir>/.gitignore on first attachment write', async function () {
    const gi = path.join(workingDir, '.gitignore');
    fs.writeFileSync(gi, '*.log\nnode_modules/\n');

    const r = await request(port, 'POST', '/api/files/upload', {
      targetDir: attachmentsDir,
      fileName: 'note.pdf',
      content: Buffer.from('%PDF').toString('base64'),
    });
    assert.strictEqual(r.status, 200);
    const after = fs.readFileSync(gi, 'utf-8');
    assert.ok(after.includes('.claude-attachments/'),
      '.gitignore should now contain .claude-attachments/, got: ' + JSON.stringify(after));
    // Original lines preserved.
    assert.ok(after.includes('*.log'));
    assert.ok(after.includes('node_modules/'));
  });

  it('is idempotent — does not duplicate the .claude-attachments/ line if already present', async function () {
    const gi = path.join(workingDir, '.gitignore');
    fs.writeFileSync(gi, 'node_modules/\n.claude-attachments/\n*.log\n');

    const r = await request(port, 'POST', '/api/files/upload', {
      targetDir: attachmentsDir,
      fileName: 'a.pdf',
      content: Buffer.from('x').toString('base64'),
    });
    assert.strictEqual(r.status, 200);
    const after = fs.readFileSync(gi, 'utf-8');
    const occurrences = after.match(/^\.claude-attachments\/$/gm) || [];
    assert.strictEqual(occurrences.length, 1,
      'expected exactly one .claude-attachments/ line, got: ' + JSON.stringify(after));
  });

  it('does not create a .gitignore if none exists (best-effort, no-op)', async function () {
    const gi = path.join(workingDir, '.gitignore');
    assert.ok(!fs.existsSync(gi), 'precondition: no .gitignore');

    const r = await request(port, 'POST', '/api/files/upload', {
      targetDir: attachmentsDir,
      fileName: 'a.pdf',
      content: Buffer.from('x').toString('base64'),
    });
    assert.strictEqual(r.status, 200);
    // We did NOT pre-create .gitignore — the spec says best-effort, no
    // error if missing. The endpoint must not have created one.
    assert.ok(!fs.existsSync(gi),
      '.gitignore should NOT be auto-created when missing');
  });

  it('only appends for uploads to .claude-attachments/ (other targetDirs leave .gitignore alone)', async function () {
    const gi = path.join(workingDir, '.gitignore');
    fs.writeFileSync(gi, '*.log\n');
    const otherDir = path.join(workingDir, 'docs');
    fs.mkdirSync(otherDir, { recursive: true });

    const r = await request(port, 'POST', '/api/files/upload', {
      targetDir: otherDir,
      fileName: 'doc.pdf',
      content: Buffer.from('%PDF').toString('base64'),
    });
    assert.strictEqual(r.status, 200);
    const after = fs.readFileSync(gi, 'utf-8');
    assert.strictEqual(after.includes('.claude-attachments/'), false,
      'unrelated upload should not modify .gitignore');
  });

  // ── NEW: 24h sweep ───────────────────────────────────────────────────────

  it('sweeps attachment files older than 24 h, preserving newer ones', function () {
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const oldFile = path.join(attachmentsDir, 'old.pdf');
    const freshFile = path.join(attachmentsDir, 'fresh.pdf');
    fs.writeFileSync(oldFile, '%PDF-old');
    fs.writeFileSync(freshFile, '%PDF-fresh');
    // Backdate the old file to 25 h ago.
    const past = (Date.now() - 25 * 60 * 60 * 1000) / 1000; // seconds
    fs.utimesSync(oldFile, past, past);

    // Drive the sweep directly via the server method (exposed for testing).
    server._sweepAttachments(workingDir, { maxAgeMs: 24 * 60 * 60 * 1000 });

    assert.ok(!fs.existsSync(oldFile), 'old.pdf should have been swept');
    assert.ok(fs.existsSync(freshFile), 'fresh.pdf should still be there');
  });

  it('sweeps idempotently and tolerates a missing .claude-attachments/ dir', function () {
    // No attachments dir at all — should not throw.
    if (fs.existsSync(attachmentsDir)) fs.rmSync(attachmentsDir, { recursive: true, force: true });
    assert.doesNotThrow(() => {
      server._sweepAttachments(workingDir, { maxAgeMs: 24 * 60 * 60 * 1000 });
    });
  });
});
