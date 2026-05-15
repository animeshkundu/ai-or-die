// test/generic-drop-path-roundtrip.test.js — Task #8 part 2 lite.
//
// Codex's critique: "do not merely confirm text was injected. Ask Claude
// to read the file and return a known sentinel/hash." The full sentinel
// loop requires real Claude API credits; this suite covers the credit-
// free half — assert that the path the GENERIC-DROP HANDLER injects via
// the `@<path>` bracketed-paste payload is the EXACT path the server
// wrote the file to. If the upload endpoint succeeds + the on-disk file
// is readable at that path with the original bytes, then by construction
// any consumer (Claude, Codex, Gemini, the user themselves) that follows
// the @<path> reference will read what we sent.
//
// Mismatch surfaces caught here:
//   - Server-side sanitizeFileName mangles the basename → we inject a
//     stale path. (Today: sanitization is silent and doesn't echo back.)
//   - UUID prefix lost in transit → `@<path>` references the unprefixed
//     filename, which doesn't exist on disk.
//   - Path normalisation drift between client (POSIX joins) and server
//     (validatePath() may reformat).
//   - .claude-attachments/ dir not created → upload 500s but client
//     shows a successful injection.
//
// We boot a real ai-or-die server (port >11000 per feedback_test_ports)
// but exercise only the upload + on-disk verification — no browser, no
// Claude. Fast (one mocha run, ~1s).

'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let ClaudeCodeWebServer;
try { ({ ClaudeCodeWebServer } = require('../src/server')); }
catch (_) { /* server requires native deps; skip suite if unavailable */ }
const gd = require(path.join(__dirname, '..', 'src', 'public', 'generic-drop-handler'));

function postJson(port, urlPath, body) {
  return new Promise(function (resolve, reject) {
    var data = JSON.stringify(body);
    var req = http.request({
      hostname: '127.0.0.1', port: port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8');
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
        resolve({ status: res.statusCode, body: parsed, raw: raw });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(ClaudeCodeWebServer ? describe : describe.skip)('generic-drop path round-trip — server contract', function () {
  this.timeout(30000);

  let server, port, sandboxDir;

  before(async function () {
    // Convention from test/file-browser-api.test.js: chdir to a temp
    // dir so the server captures it as baseFolder, then restore.
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-roundtrip-'));
    const origCwd = process.cwd();
    process.chdir(sandboxDir);
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
    process.chdir(origCwd);
  });

  after(function () {
    if (server && typeof server.close === 'function') {
      try { server.close(); } catch (_) {}
    }
    if (sandboxDir) {
      try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('uploaded file is readable on disk at the path the server returns', async function () {
    var sentinel = 'SENTINEL_' + crypto.randomBytes(12).toString('hex');
    var content = 'Hello from generic-drop test.\n' + sentinel + '\n';
    var base64 = Buffer.from(content, 'utf8').toString('base64');

    var attachmentsDir = path.join(sandboxDir, '.claude-attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });
    var fileName = 'abcdef0123456789-test-doc.txt';

    var resp = await postJson(port, '/api/files/upload', {
      targetDir: attachmentsDir,
      fileName: fileName,
      content: base64,
    });

    assert.strictEqual(resp.status, 200, 'upload should 200; raw: ' + resp.raw);
    assert.ok(resp.body, 'response body should parse');
    assert.strictEqual(typeof resp.body.path, 'string', 'response.path should be string');

    var serverPath = resp.body.path;
    assert.ok(fs.existsSync(serverPath), 'on-disk file must exist at: ' + serverPath);
    var diskBytes = fs.readFileSync(serverPath);
    assert.strictEqual(diskBytes.toString('utf8'), content,
      'on-disk content must match upload bytes exactly');
    assert.ok(diskBytes.toString('utf8').indexOf(sentinel) !== -1,
      'sentinel survives the round-trip');
  });

  it('client `@<path>` injection points at the server-returned path', async function () {
    var content = 'roundtrip body';
    var base64 = Buffer.from(content, 'utf8').toString('base64');
    var attachmentsDir = path.join(sandboxDir, '.claude-attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });
    var resp = await postJson(port, '/api/files/upload', {
      targetDir: attachmentsDir,
      fileName: 'uuid-injection-target.txt',
      content: base64,
    });
    assert.strictEqual(resp.status, 200);
    var serverPath = resp.body.path;
    var injected = gd.buildAtPathInjection(serverPath);
    assert.strictEqual(injected, '@' + serverPath,
      'injected payload must be @<server-path> verbatim');
    assert.strictEqual(injected.slice(1), serverPath);
    assert.ok(fs.existsSync(serverPath));
  });

  it('targetDir + fileName resolve to the path the server reports', async function () {
    var attachmentsDir = path.join(sandboxDir, '.claude-attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });
    var fileName = 'normalisation-check.txt';
    var resp = await postJson(port, '/api/files/upload', {
      targetDir: attachmentsDir,
      fileName: fileName,
      content: Buffer.from('x', 'utf8').toString('base64'),
    });
    assert.strictEqual(resp.status, 200);
    var serverPath = resp.body.path;
    assert.strictEqual(path.basename(serverPath), fileName,
      'basename round-trip: ' + serverPath);
    var serverParent = path.dirname(serverPath).replace(/\\/g, '/');
    var expectedParent = attachmentsDir.replace(/\\/g, '/');
    // Tolerate /private/ realpath expansion on macOS — server's
    // normalizePath may have resolved a symlink.
    assert.ok(
      serverParent === expectedParent ||
      serverParent === expectedParent.replace(/^\/var\//, '/private/var/') ||
      serverParent === expectedParent.replace(/^\/tmp\//, '/private/tmp/'),
      'parent-dir round-trip: ' + serverParent + ' vs ' + expectedParent);
  });

  it('rejects upload outside the sandbox (defence-in-depth)', async function () {
    var resp = await postJson(port, '/api/files/upload', {
      targetDir: '/etc',
      fileName: 'evil.txt',
      content: Buffer.from('x', 'utf8').toString('base64'),
    });
    assert.strictEqual(resp.status, 403, 'expected 403; got ' + resp.status + ' / ' + resp.raw);
  });

  it('rejects blocked-extension uploads (defence-in-depth)', async function () {
    var attachmentsDir = path.join(sandboxDir, '.claude-attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });
    var resp = await postJson(port, '/api/files/upload', {
      targetDir: attachmentsDir,
      fileName: 'malware.exe',
      content: Buffer.from('x', 'utf8').toString('base64'),
    });
    assert.strictEqual(resp.status, 403, 'expected 403; got ' + resp.status);
  });
});
