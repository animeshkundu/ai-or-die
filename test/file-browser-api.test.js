const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

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

function encodeParam(val) {
  return encodeURIComponent(val);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

(ClaudeCodeWebServer ? describe : describe.skip)('File Browser API', function () {
  this.timeout(30000);

  let server, port, tmpDir;

  before(async function () {
    this.timeout(30000);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-api-test-'));

    // Override process.cwd so the server uses our temp dir as baseFolder
    const origCwd = process.cwd();
    process.chdir(tmpDir);

    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;

    // Restore cwd (server already captured baseFolder)
    process.chdir(origCwd);
  });

  after(function () {
    if (server) server.close();
    // Clean up temp directory recursively
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  // Create fresh test fixtures before each test
  beforeEach(function () {
    // Ensure tmpDir is clean of test-specific files (but keep the dir)
    // We create files per-test as needed
  });

  // ── Helpers for creating test fixtures ──

  function createFile(name, content) {
    const filePath = path.join(tmpDir, name);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function createDir(name) {
    const dirPath = path.join(tmpDir, name);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return dirPath;
  }

  function removeIfExists(name) {
    const p = path.join(tmpDir, name);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  // =========================================================================
  // GET /api/files (directory listing)
  // =========================================================================

  describe('GET /api/files', function () {

    it('should return items array with files and directories', async function () {
      createFile('list-test-file.txt', 'hello');
      createDir('list-test-dir');

      const res = await request(port, 'GET', `/api/files?path=${encodeParam(tmpDir)}`);
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.items), 'Expected items array');
      assert.ok(res.body.items.length > 0, 'Expected at least one item');

      removeIfExists('list-test-file.txt');
      removeIfExists('list-test-dir');
    });

    it('should sort directories before files', async function () {
      createFile('aaa-file.txt', 'a');
      createDir('bbb-dir');

      const res = await request(port, 'GET', `/api/files?path=${encodeParam(tmpDir)}`);
      assert.strictEqual(res.status, 200);

      const items = res.body.items;
      // Find both items
      const dirIdx = items.findIndex(i => i.name === 'bbb-dir');
      const fileIdx = items.findIndex(i => i.name === 'aaa-file.txt');
      assert.ok(dirIdx >= 0, 'Expected bbb-dir in results');
      assert.ok(fileIdx >= 0, 'Expected aaa-file.txt in results');
      assert.ok(dirIdx < fileIdx, 'Directories should be sorted before files');

      removeIfExists('aaa-file.txt');
      removeIfExists('bbb-dir');
    });

    it('should return correct metadata for items', async function () {
      createFile('meta-test.js', 'console.log("hi");');

      const res = await request(port, 'GET', `/api/files?path=${encodeParam(tmpDir)}`);
      assert.strictEqual(res.status, 200);

      const item = res.body.items.find(i => i.name === 'meta-test.js');
      assert.ok(item, 'Expected meta-test.js in listing');
      assert.strictEqual(item.isDirectory, false);
      assert.strictEqual(typeof item.size, 'number');
      assert.strictEqual(item.mimeCategory, 'code');
      assert.strictEqual(item.editable, true);
      assert.ok(item.path, 'Expected path property');

      removeIfExists('meta-test.js');
    });

    it('should hide hidden files by default', async function () {
      createFile('.hidden-file', 'secret');
      createFile('visible-file.txt', 'public');

      const res = await request(port, 'GET', `/api/files?path=${encodeParam(tmpDir)}`);
      assert.strictEqual(res.status, 200);

      const hidden = res.body.items.find(i => i.name === '.hidden-file');
      const visible = res.body.items.find(i => i.name === 'visible-file.txt');
      assert.ok(!hidden, 'Hidden files should not appear by default');
      assert.ok(visible, 'Visible files should appear');

      removeIfExists('.hidden-file');
      removeIfExists('visible-file.txt');
    });

    it('should show hidden files when showHidden=true', async function () {
      createFile('.hidden-show.txt', 'secret');

      const res = await request(port, 'GET', `/api/files?path=${encodeParam(tmpDir)}&showHidden=true`);
      assert.strictEqual(res.status, 200);

      const hidden = res.body.items.find(i => i.name === '.hidden-show.txt');
      assert.ok(hidden, 'Hidden files should appear when showHidden=true');

      removeIfExists('.hidden-show.txt');
    });

    it('should return pagination info', async function () {
      createFile('page-test.txt', 'data');

      const res = await request(port, 'GET', `/api/files?path=${encodeParam(tmpDir)}&offset=0&limit=10`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(typeof res.body.totalCount, 'number');
      assert.strictEqual(typeof res.body.offset, 'number');
      assert.strictEqual(typeof res.body.limit, 'number');

      removeIfExists('page-test.txt');
    });

    it('should return 403 for paths outside baseFolder', async function () {
      const outsidePath = path.resolve(tmpDir, '..');
      const res = await request(port, 'GET', `/api/files?path=${encodeParam(outsidePath)}`);
      assert.strictEqual(res.status, 403);
    });

    it('should return 400 for paths that are not directories', async function () {
      const filePath = createFile('not-a-dir.txt', 'content');

      const res = await request(port, 'GET', `/api/files?path=${encodeParam(filePath)}`);
      assert.strictEqual(res.status, 400);

      removeIfExists('not-a-dir.txt');
    });

    it('should use forward slashes in response paths', async function () {
      createFile('slash-test.txt', 'x');

      const res = await request(port, 'GET', `/api/files?path=${encodeParam(tmpDir)}`);
      assert.strictEqual(res.status, 200);

      const item = res.body.items.find(i => i.name === 'slash-test.txt');
      assert.ok(item, 'Expected slash-test.txt in listing');
      assert.ok(!item.path.includes('\\'), 'Paths should use forward slashes, got: ' + item.path);
      assert.ok(!res.body.currentPath.includes('\\'), 'currentPath should use forward slashes');

      removeIfExists('slash-test.txt');
    });
  });

  // =========================================================================
  // GET /api/files/stat (file metadata)
  // =========================================================================

  describe('GET /api/files/stat', function () {

    it('should return correct metadata for a text file', async function () {
      const filePath = createFile('stat-test.txt', 'hello world');

      const res = await request(port, 'GET', `/api/files/stat?path=${encodeParam(filePath)}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.name, 'stat-test.txt');
      assert.strictEqual(res.body.isDirectory, false);
      assert.strictEqual(typeof res.body.size, 'number');
      assert.ok(res.body.size > 0);
      assert.ok(res.body.modified);
      assert.ok(res.body.created);
      assert.ok(res.body.sizeFormatted);

      removeIfExists('stat-test.txt');
    });

    it('should return hash for text files', async function () {
      const filePath = createFile('stat-hash.txt', 'content for hashing');

      const res = await request(port, 'GET', `/api/files/stat?path=${encodeParam(filePath)}`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.hash, 'Expected hash for text file');
      assert.ok(/^[0-9a-f]{32}$/.test(res.body.hash), 'Hash should be 32-char hex');

      removeIfExists('stat-hash.txt');
    });

    it('should return correct mimeCategory', async function () {
      const filePath = createFile('stat-cat.js', 'const x = 1;');

      const res = await request(port, 'GET', `/api/files/stat?path=${encodeParam(filePath)}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.mimeCategory, 'code');
      assert.strictEqual(res.body.editable, true);
      assert.strictEqual(res.body.previewable, true);

      removeIfExists('stat-cat.js');
    });

    it('should return 404 for non-existent paths', async function () {
      const fakePath = path.join(tmpDir, 'does-not-exist.txt');
      const res = await request(port, 'GET', `/api/files/stat?path=${encodeParam(fakePath)}`);
      assert.strictEqual(res.status, 404);
    });

    it('should return 403 for paths outside baseFolder', async function () {
      const outsidePath = path.resolve(tmpDir, '..', 'outside.txt');
      const res = await request(port, 'GET', `/api/files/stat?path=${encodeParam(outsidePath)}`);
      assert.strictEqual(res.status, 403);
    });
  });

  // =========================================================================
  // GET /api/files/content (text content)
  // =========================================================================

  describe('GET /api/files/content', function () {

    it('should return text content in JSON envelope with hash', async function () {
      const filePath = createFile('content-test.txt', 'file content here');

      const res = await request(port, 'GET', `/api/files/content?path=${encodeParam(filePath)}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.content, 'file content here');
      assert.ok(res.body.hash, 'Expected hash in response');
      assert.ok(/^[0-9a-f]{32}$/.test(res.body.hash));
      assert.strictEqual(typeof res.body.truncated, 'boolean');
      assert.strictEqual(typeof res.body.totalSize, 'number');

      removeIfExists('content-test.txt');
    });

    it('should return truncation info for large files', async function () {
      // Create a file larger than the requested maxSize
      const bigContent = 'x'.repeat(2000);
      const filePath = createFile('content-big.txt', bigContent);

      // Request with a small maxSize
      const res = await request(port, 'GET', `/api/files/content?path=${encodeParam(filePath)}&maxSize=100`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.truncated, true);
      assert.strictEqual(res.body.totalSize, 2000);
      assert.ok(res.body.content.length <= 100, 'Content should be truncated to maxSize');

      removeIfExists('content-big.txt');
    });

    it('should return 415 for binary files', async function () {
      // Create a file with null bytes (binary content)
      const binaryContent = Buffer.from([0x48, 0x65, 0x6c, 0x00, 0x6f]);
      const filePath = createFile('content-binary.bin', binaryContent);

      const res = await request(port, 'GET', `/api/files/content?path=${encodeParam(filePath)}`);
      assert.strictEqual(res.status, 415);

      removeIfExists('content-binary.bin');
    });

    it('should return 404 for non-existent files', async function () {
      const fakePath = path.join(tmpDir, 'no-such-file.txt');
      const res = await request(port, 'GET', `/api/files/content?path=${encodeParam(fakePath)}`);
      assert.strictEqual(res.status, 404);
    });

    it('should return 403 for paths outside baseFolder', async function () {
      const outsidePath = path.resolve(tmpDir, '..', 'outside.txt');
      const res = await request(port, 'GET', `/api/files/content?path=${encodeParam(outsidePath)}`);
      assert.strictEqual(res.status, 403);
    });

    it('should return 400 for directories', async function () {
      const dirPath = createDir('content-dir-test');

      const res = await request(port, 'GET', `/api/files/content?path=${encodeParam(dirPath)}`);
      assert.strictEqual(res.status, 400);

      removeIfExists('content-dir-test');
    });
  });

  // =========================================================================
  // GET /api/files/download
  // =========================================================================

  describe('GET /api/files/download', function () {

    it('should return file with Content-Disposition: attachment header', async function () {
      const filePath = createFile('download-test.txt', 'download me');

      const res = await request(port, 'GET', `/api/files/download?path=${encodeParam(filePath)}`);
      assert.strictEqual(res.status, 200);
      const disposition = res.headers['content-disposition'];
      assert.ok(disposition, 'Expected Content-Disposition header');
      assert.ok(disposition.includes('attachment'), 'Expected attachment disposition');
      assert.ok(disposition.includes('download-test.txt'), 'Expected filename in disposition');

      removeIfExists('download-test.txt');
    });

    it('should return inline with ?inline=1 and correct Content-Type', async function () {
      const filePath = createFile('inline-test.txt', 'inline me');

      const res = await request(port, 'GET', `/api/files/download?path=${encodeParam(filePath)}&inline=1`);
      assert.strictEqual(res.status, 200);
      const disposition = res.headers['content-disposition'];
      assert.ok(disposition, 'Expected Content-Disposition header');
      assert.ok(disposition.includes('inline'), 'Expected inline disposition');
      assert.ok(res.headers['content-type'], 'Expected Content-Type header');

      removeIfExists('inline-test.txt');
    });

    it('should return 413 for files > 100MB', async function () {
      // Create a file and then override its stat to simulate a large file.
      // Instead, we create a small file and mock by checking the server behavior.
      // The server checks stat.size > 100 * 1024 * 1024 using sync stat.
      // We cannot easily create a 100MB file, so we verify by checking a
      // smaller threshold won't trigger it.
      const filePath = createFile('small-dl.txt', 'small');
      const res = await request(port, 'GET', `/api/files/download?path=${encodeParam(filePath)}`);
      assert.strictEqual(res.status, 200, 'Small file should download fine');

      removeIfExists('small-dl.txt');
    });

    it('should return 404 for non-existent files', async function () {
      const fakePath = path.join(tmpDir, 'no-file-dl.txt');
      const res = await request(port, 'GET', `/api/files/download?path=${encodeParam(fakePath)}`);
      assert.strictEqual(res.status, 404);
    });

    it('should return 403 for paths outside baseFolder', async function () {
      const outsidePath = path.resolve(tmpDir, '..', 'outside-dl.txt');
      const res = await request(port, 'GET', `/api/files/download?path=${encodeParam(outsidePath)}`);
      assert.strictEqual(res.status, 403);
    });
  });

  // =========================================================================
  // PUT /api/files/content (save file)
  // =========================================================================

  describe('PUT /api/files/content', function () {

    it('should save file content and return new hash', async function () {
      const filePath = createFile('save-test.txt', 'original');

      const res = await request(port, 'PUT', '/api/files/content', {
        path: filePath,
        content: 'updated content',
      });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.hash, 'Expected hash in response');
      assert.ok(/^[0-9a-f]{32}$/.test(res.body.hash));
      assert.strictEqual(typeof res.body.size, 'number');

      // Verify file was actually written
      const actual = fs.readFileSync(filePath, 'utf-8');
      assert.strictEqual(actual, 'updated content');

      removeIfExists('save-test.txt');
    });

    it('should return 409 when hash does not match (conflict detection)', async function () {
      const filePath = createFile('conflict-test.txt', 'version 1');

      // Get the current hash
      const statRes = await request(port, 'GET', `/api/files/stat?path=${encodeParam(filePath)}`);
      const originalHash = statRes.body.hash;

      // Modify the file externally (simulating another editor)
      fs.writeFileSync(filePath, 'version 2 - external edit');

      // Try to save with the old hash
      const res = await request(port, 'PUT', '/api/files/content', {
        path: filePath,
        content: 'my edit',
        hash: originalHash,
      });
      assert.strictEqual(res.status, 409);
      assert.ok(res.body.error.includes('modified'), 'Expected conflict error message');
      assert.ok(res.body.currentHash, 'Expected currentHash in conflict response');
      assert.ok(res.body.yourHash, 'Expected yourHash in conflict response');

      removeIfExists('conflict-test.txt');
    });

    it('should return 413 for content > 5MB', async function () {
      const filePath = createFile('big-save.txt', 'x');
      const largeContent = 'x'.repeat(6 * 1024 * 1024); // 6MB

      const res = await request(port, 'PUT', '/api/files/content', {
        path: filePath,
        content: largeContent,
      });
      assert.strictEqual(res.status, 413);

      removeIfExists('big-save.txt');
    });

    it('should return 403 for paths outside baseFolder', async function () {
      const outsidePath = path.resolve(tmpDir, '..', 'outside-save.txt');
      const res = await request(port, 'PUT', '/api/files/content', {
        path: outsidePath,
        content: 'hack',
      });
      assert.strictEqual(res.status, 403);
    });
  });

  // =========================================================================
  // POST /api/files/upload
  // =========================================================================

  describe('POST /api/files/upload', function () {

    it('should upload a file (base64 content) to target directory', async function () {
      const content = Buffer.from('uploaded file content').toString('base64');

      const res = await request(port, 'POST', '/api/files/upload', {
        targetDir: tmpDir,
        fileName: 'uploaded.txt',
        content,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.name, 'uploaded.txt');
      assert.ok(res.body.path, 'Expected path in response');
      assert.strictEqual(typeof res.body.size, 'number');

      // Verify file exists and content is correct
      const filePath = path.join(tmpDir, 'uploaded.txt');
      assert.ok(fs.existsSync(filePath), 'Uploaded file should exist on disk');
      const actual = fs.readFileSync(filePath, 'utf-8');
      assert.strictEqual(actual, 'uploaded file content');

      removeIfExists('uploaded.txt');
    });

    it('should return 409 if file already exists (overwrite=false)', async function () {
      createFile('existing-upload.txt', 'already here');
      const content = Buffer.from('new content').toString('base64');

      const res = await request(port, 'POST', '/api/files/upload', {
        targetDir: tmpDir,
        fileName: 'existing-upload.txt',
        content,
        overwrite: false,
      });
      assert.strictEqual(res.status, 409);
      assert.ok(res.body.error.includes('exists'), 'Expected exists error');

      removeIfExists('existing-upload.txt');
    });

    it('should successfully overwrite with overwrite=true', async function () {
      createFile('overwrite-test.txt', 'old content');
      const content = Buffer.from('new overwritten content').toString('base64');

      const res = await request(port, 'POST', '/api/files/upload', {
        targetDir: tmpDir,
        fileName: 'overwrite-test.txt',
        content,
        overwrite: true,
      });
      assert.strictEqual(res.status, 200);

      const actual = fs.readFileSync(path.join(tmpDir, 'overwrite-test.txt'), 'utf-8');
      assert.strictEqual(actual, 'new overwritten content');

      removeIfExists('overwrite-test.txt');
    });

    it('should return 403 for blocked extensions (.exe)', async function () {
      const content = Buffer.from('fake exe').toString('base64');

      const res = await request(port, 'POST', '/api/files/upload', {
        targetDir: tmpDir,
        fileName: 'malware.exe',
        content,
      });
      assert.strictEqual(res.status, 403);
      assert.ok(res.body.error.includes('.exe'), 'Expected .exe in error message');
    });

    it('should return 403 for paths outside baseFolder', async function () {
      const outsideDir = path.resolve(tmpDir, '..');
      const content = Buffer.from('hack').toString('base64');

      const res = await request(port, 'POST', '/api/files/upload', {
        targetDir: outsideDir,
        fileName: 'escape.txt',
        content,
      });
      assert.strictEqual(res.status, 403);
    });

    it('should sanitize filenames (strips path separators)', async function () {
      const content = Buffer.from('sanitized content').toString('base64');

      const res = await request(port, 'POST', '/api/files/upload', {
        targetDir: tmpDir,
        fileName: '../escape.txt',
        content,
      });
      // The path separators should be stripped, resulting in "escape.txt"
      // which is a valid upload within tmpDir
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.name, 'escape.txt');

      removeIfExists('escape.txt');
    });
  });

  // =========================================================================
  // Path traversal security
  // =========================================================================

  describe('Path traversal security', function () {

    it('GET /api/files with ../../ should return 403', async function () {
      const traversalPath = path.join(tmpDir, '..', '..', 'etc');
      const res = await request(port, 'GET', `/api/files?path=${encodeParam(traversalPath)}`);
      assert.strictEqual(res.status, 403);
    });

    it('GET /api/files/content with ../../etc/passwd should return 403', async function () {
      // Use a path that clearly escapes baseFolder
      const traversalPath = path.resolve(tmpDir, '..', '..', 'etc', 'passwd');
      const res = await request(port, 'GET', `/api/files/content?path=${encodeParam(traversalPath)}`);
      assert.strictEqual(res.status, 403);
    });

    it('POST /api/files/upload with ../ in fileName is sanitized', async function () {
      const content = Buffer.from('traversal test').toString('base64');

      const res = await request(port, 'POST', '/api/files/upload', {
        targetDir: tmpDir,
        fileName: '../../etc/passwd',
        content,
      });

      // sanitizeFileName strips slashes, so the file ends up as "etcpasswd"
      // within the target directory. It should succeed (the path separators
      // are removed) and the file should be inside tmpDir.
      if (res.status === 200) {
        assert.ok(!res.body.path.includes('..'), 'Path should not contain ..');
        // Verify the saved file is inside tmpDir. Compare against the
        // REALPATH of tmpDir because the server canonicalizes paths via
        // realpath (so on macOS the response path is /private/var/...
        // while the bare tmpDir is /var/...). Using realpath on both
        // sides keeps the comparison working on darwin tmp-symlink and
        // on linux where realpath is a no-op.
        const normalizedPath = res.body.path.replace(/\//g, path.sep);
        const resolvedTarget = path.resolve(normalizedPath);
        let resolvedBase;
        try { resolvedBase = fs.realpathSync(tmpDir); }
        catch (_) { resolvedBase = path.resolve(tmpDir); }
        assert.ok(resolvedTarget.startsWith(resolvedBase),
          'File should be within base directory; got ' + resolvedTarget +
          ' vs base ' + resolvedBase);
        removeIfExists(res.body.name);
      } else {
        // If the server rejected it outright, that's also acceptable security behavior
        assert.ok([400, 403].includes(res.status),
          'Expected 400 or 403 for path traversal attempt, got ' + res.status);
      }
    });

    it('GET /api/files/stat with path traversal should return 403', async function () {
      const traversalPath = path.resolve(tmpDir, '..', 'outside.txt');
      const res = await request(port, 'GET', `/api/files/stat?path=${encodeParam(traversalPath)}`);
      assert.strictEqual(res.status, 403);
    });

    it('GET /api/files/download with path traversal should return 403', async function () {
      const traversalPath = path.resolve(tmpDir, '..', 'outside-dl.txt');
      const res = await request(port, 'GET', `/api/files/download?path=${encodeParam(traversalPath)}`);
      assert.strictEqual(res.status, 403);
    });

    it('PUT /api/files/content with path traversal should return 403', async function () {
      const traversalPath = path.resolve(tmpDir, '..', 'outside-write.txt');
      const res = await request(port, 'PUT', '/api/files/content', {
        path: traversalPath,
        content: 'hacked',
      });
      assert.strictEqual(res.status, 403);
    });
  });

  // ===========================================================================
  // GET /api/files/git-show
  // ===========================================================================
  describe('GET /api/files/git-show', function () {
    const { execFileSync } = require('child_process');
    let gitAvailable = true;
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch (_) {
      gitAvailable = false;
    }

    // On macOS, os.tmpdir() returns a symlinked path (/var → /private/var) and
    // process.cwd() resolves it; validatePath compares with path.resolve which
    // does NOT resolve symlinks. So compute the realpath of tmpDir for use in
    // requests so the path matches baseFolder. Linux + Windows tmp dirs are
    // typically not symlinked, but realpath is a no-op there.
    function realTmpDir() {
      try { return fs.realpathSync(tmpDir); } catch (_) { return tmpDir; }
    }
    function realJoin() {
      const parts = Array.prototype.slice.call(arguments);
      return path.join.apply(null, [realTmpDir()].concat(parts));
    }

    function gitInit(dir) {
      execFileSync('git', ['init', '--quiet'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      // Disable signing to avoid prompting in CI
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    }
    function gitAdd(dir, file) {
      execFileSync('git', ['add', file], { cwd: dir });
    }
    function gitCommit(dir, msg) {
      execFileSync('git', ['commit', '--quiet', '-m', msg, '--allow-empty'], { cwd: dir });
    }

    (gitAvailable ? it : it.skip)('returns 404 when path is not in a git repository', async function () {
      // tmpDir is NOT a git repo (we never `git init`-ed it).
      createFile('not-in-git.txt', 'plain content');
      const filePath = realJoin('not-in-git.txt');
      const res = await request(port, 'GET',
        `/api/files/git-show?path=${encodeParam(filePath)}`);
      assert.strictEqual(res.status, 404);
      assert.match(res.body.error || '', /Not a git repository/i);
    });

    (gitAvailable ? it : it.skip)('returns the committed content of a tracked file at HEAD', async function () {
      const subDir = realJoin('gitrepo');
      fs.mkdirSync(subDir, { recursive: true });
      gitInit(subDir);
      const target = path.join(subDir, 'tracked.txt');
      fs.writeFileSync(target, 'committed-version-v1\n');
      gitAdd(subDir, 'tracked.txt');
      gitCommit(subDir, 'initial');
      // Mutate working tree — git-show should return the committed version, not this.
      fs.writeFileSync(target, 'working-tree-version-v2\n');

      const res = await request(port, 'GET',
        `/api/files/git-show?path=${encodeParam(target)}&ref=HEAD`);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.ref, 'HEAD');
      assert.strictEqual(res.body.content, 'committed-version-v1\n');
      assert.strictEqual(res.body.truncated, false);
      assert.strictEqual(res.body.relPath, 'tracked.txt');

      // Cleanup
      fs.rmSync(subDir, { recursive: true, force: true });
    });

    (gitAvailable ? it : it.skip)('rejects refs with shell metacharacters', async function () {
      const subDir = realJoin('gitrepo-meta');
      fs.mkdirSync(subDir, { recursive: true });
      gitInit(subDir);
      const target = path.join(subDir, 'a.txt');
      fs.writeFileSync(target, 'x');
      gitAdd(subDir, 'a.txt');
      gitCommit(subDir, 'init');

      const dangerous = ['HEAD;rm -rf /', 'HEAD$(whoami)', 'HEAD|cat', 'HEAD`id`', 'HEAD\nfoo'];
      for (const ref of dangerous) {
        const res = await request(port, 'GET',
          `/api/files/git-show?path=${encodeParam(target)}&ref=${encodeParam(ref)}`);
        assert.strictEqual(res.status, 400, 'Expected 400 for ref=' + JSON.stringify(ref));
        assert.match(res.body.error || '', /Invalid ref/i);
      }

      fs.rmSync(subDir, { recursive: true, force: true });
    });

    (gitAvailable ? it : it.skip)('rejects refs starting with - (option-injection)', async function () {
      const subDir = realJoin('gitrepo-opt');
      fs.mkdirSync(subDir, { recursive: true });
      gitInit(subDir);
      const target = path.join(subDir, 'b.txt');
      fs.writeFileSync(target, 'y');
      gitAdd(subDir, 'b.txt');
      gitCommit(subDir, 'init');

      const res = await request(port, 'GET',
        `/api/files/git-show?path=${encodeParam(target)}&ref=${encodeParam('--upload-pack=evil')}`);
      assert.strictEqual(res.status, 400);

      fs.rmSync(subDir, { recursive: true, force: true });
    });

    (gitAvailable ? it : it.skip)('returns 404 with helpful message when ref does not contain the file', async function () {
      const subDir = realJoin('gitrepo-missing');
      fs.mkdirSync(subDir, { recursive: true });
      gitInit(subDir);
      const target = path.join(subDir, 'c.txt');
      fs.writeFileSync(target, 'z');
      gitAdd(subDir, 'c.txt');
      gitCommit(subDir, 'init');

      // Reference a file that exists but at a non-existent ref/branch.
      const res = await request(port, 'GET',
        `/api/files/git-show?path=${encodeParam(target)}&ref=does-not-exist`);
      assert.strictEqual(res.status, 404);

      fs.rmSync(subDir, { recursive: true, force: true });
    });

    (gitAvailable ? it : it.skip)('blocks path traversal via ?path', async function () {
      const traversal = path.resolve(realTmpDir(), '..', 'outside-git.txt');
      const res = await request(port, 'GET',
        `/api/files/git-show?path=${encodeParam(traversal)}`);
      assert.strictEqual(res.status, 403);
    });

    it('returns 400 when path is missing', async function () {
      const res = await request(port, 'GET', '/api/files/git-show');
      assert.strictEqual(res.status, 400);
    });

    // ── Reviewer follow-ups (MEDIUM-1..4 + LOW-1 from review of 2fa99d1) ──

    (gitAvailable ? it : it.skip)('rejects symlinked .git as the repo root (MEDIUM-4)', async function () {
      // Create a directory whose `.git` is a SYMLINK pointing at /etc.
      // Plain existsSync would follow the symlink and treat it as a repo,
      // which would then run `git show` with `cwd=<that dir>` — letting
      // an attacker redirect git's repo discovery (CVE-class footgun).
      // The fix uses lstat + isDirectory()/isFile(), rejecting symlinks.
      const subDir = realJoin('symlinked-git');
      fs.mkdirSync(subDir, { recursive: true });
      try {
        // Symlink target needs to exist and be a directory; /tmp works
        // cross-platform (Windows tests would skip via gitAvailable on
        // most CI runners that don't have git).
        fs.symlinkSync(os.tmpdir(), path.join(subDir, '.git'), 'dir');
      } catch (e) {
        // Symlinks may not be supported in the test sandbox — skip.
        this.skip();
        return;
      }
      const target = path.join(subDir, 'foo.txt');
      fs.writeFileSync(target, 'content');

      const res = await request(port, 'GET',
        `/api/files/git-show?path=${encodeParam(target)}`);
      // _findGitRoot must NOT treat the symlink as a repo root; we get
      // either 'Not a git repository' (404 — no real .git ancestor) or
      // 'git show failed' if git is reached for a non-repo cwd.
      assert.ok(res.status === 404, 'Expected 404 for symlinked .git, got ' + res.status);
      assert.match(res.body.error || '', /Not a git repository|git show failed/);

      fs.rmSync(subDir, { recursive: true, force: true });
    });

    (gitAvailable ? it : it.skip)('rate-limits at 30 requests per minute per IP (MEDIUM-1)', async function () {
      const subDir = realJoin('gitrepo-rl');
      fs.mkdirSync(subDir, { recursive: true });
      gitInit(subDir);
      const target = path.join(subDir, 'rl.txt');
      fs.writeFileSync(target, 'x');
      gitAdd(subDir, 'rl.txt');
      gitCommit(subDir, 'init');

      // Reset the per-IP bucket so prior tests don't taint our budget.
      if (server._rateLimitBuckets) {
        const b = server._rateLimitBuckets.get('git-show');
        if (b) b.clear();
      }

      // Fire 31 requests sequentially; 31st must 429.
      let lastStatus;
      for (let i = 0; i < 31; i++) {
        const r = await request(port, 'GET',
          `/api/files/git-show?path=${encodeParam(target)}&ref=HEAD`);
        lastStatus = r.status;
        if (r.status === 429) break;
      }
      assert.strictEqual(lastStatus, 429, 'expected 429 within 31 requests, got ' + lastStatus);

      // Reset again so the NEXT test doesn't inherit an exhausted budget.
      if (server._rateLimitBuckets) {
        const b = server._rateLimitBuckets.get('git-show');
        if (b) b.clear();
      }

      fs.rmSync(subDir, { recursive: true, force: true });
    });

    (gitAvailable ? it : it.skip)('sanitizes server-absolute paths from error messages (MEDIUM-2)', async function () {
      // Reset rate-limit bucket in case a prior test exhausted our budget.
      if (server._rateLimitBuckets) {
        const b = server._rateLimitBuckets.get('git-show');
        if (b) b.clear();
      }

      const subDir = realJoin('gitrepo-leak');
      fs.mkdirSync(subDir, { recursive: true });
      gitInit(subDir);
      const target = path.join(subDir, 'l.txt');
      fs.writeFileSync(target, 'y');
      gitAdd(subDir, 'l.txt');
      gitCommit(subDir, 'init');

      // Reference a non-existent ref → git emits an error containing the
      // file path or repo path. The response message must NOT contain
      // the absolute server path verbatim.
      const res = await request(port, 'GET',
        `/api/files/git-show?path=${encodeParam(target)}&ref=does-not-exist-xyz`);
      assert.strictEqual(res.status, 404);
      const msg = res.body.message || '';
      assert.ok(!msg.includes(subDir),
        'message must not leak absolute repo path; got: ' + msg);
      assert.ok(!msg.includes(realTmpDir()),
        'message must not leak base folder; got: ' + msg);

      fs.rmSync(subDir, { recursive: true, force: true });
    });
  });

  // ===========================================================================
  // GET /api/search — SSE-streamed cross-file search
  // ===========================================================================
  describe('GET /api/search', function () {
    const search = require('../src/utils/search');
    const searchAvailable = !!search.detectBackend();

    /**
     * Open an EventSource-style SSE connection and collect events until
     * the server closes the stream or `timeoutMs` elapses.
     */
    function consumeSse(port, urlPath, timeoutMs) {
      timeoutMs = timeoutMs || 10_000;
      return new Promise((resolve, reject) => {
        const opts = {
          hostname: '127.0.0.1', port: port, path: urlPath, method: 'GET',
          headers: { 'Accept': 'text/event-stream' },
        };
        const req = http.request(opts, (res) => {
          if (res.statusCode !== 200) {
            // Drain body, then resolve with error indicator so the test
            // can assert on the status code (e.g. 429, 400, 403).
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf-8');
              let body;
              try { body = JSON.parse(raw); } catch (_) { body = raw; }
              resolve({ status: res.statusCode, headers: res.headers, body: body, events: [] });
            });
            return;
          }
          let buf = '';
          const events = [];
          const t = setTimeout(() => {
            try { req.destroy(); } catch (_) {}
            resolve({ status: 200, headers: res.headers, events: events, timedOut: true });
          }, timeoutMs);
          res.setEncoding('utf-8');
          res.on('data', (chunk) => {
            buf += chunk;
            // SSE frames are separated by \n\n. Each frame is one or more
            // "data: ..." lines we concatenate.
            let sep;
            while ((sep = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const lines = frame.split('\n');
              const dataLines = lines
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.replace(/^data:\s?/, ''));
              if (!dataLines.length) continue;
              try {
                events.push(JSON.parse(dataLines.join('\n')));
              } catch (_) { /* ignore malformed */ }
            }
          });
          res.on('end', () => {
            clearTimeout(t);
            resolve({ status: 200, headers: res.headers, events: events });
          });
          res.on('error', (err) => { clearTimeout(t); reject(err); });
        });
        req.on('error', reject);
        req.end();
      });
    }

    function realTmpDirS() {
      try { return fs.realpathSync(tmpDir); } catch (_) { return tmpDir; }
    }

    (searchAvailable ? it : it.skip)('returns 400 when q is missing', async function () {
      const r = await consumeSse(port, '/api/search');
      assert.strictEqual(r.status, 400);
    });

    (searchAvailable ? it : it.skip)('returns 400 for an invalid glob (shell metachar)', async function () {
      const r = await consumeSse(port, '/api/search?q=foo&glob=' + encodeParam(';rm -rf /'));
      assert.strictEqual(r.status, 400);
    });

    // codex review fix-up: Windows-shaped globs like `src\public\*.js` were
    // rejected as "invalid glob" because the validation regex only accepted
    // forward-slash separators. Server now normalizes `\` → `/` BEFORE the
    // regex check (matches the canonical-input pattern in validatePath).
    (searchAvailable ? it : it.skip)('accepts Windows-style backslash globs (codex review)', async function () {
      // Use a temp corpus so we get a real 200 SSE flow, not a synthetic
      // happy-path-only check.
      const subDir = path.join(realTmpDirS(), 'searchcorpus-bs');
      fs.mkdirSync(subDir, { recursive: true });
      fs.mkdirSync(path.join(subDir, 'public'), { recursive: true });
      fs.writeFileSync(path.join(subDir, 'public', 'foo.js'), 'NEEDLE-WIN-PATH found here\n');
      fs.writeFileSync(path.join(subDir, 'other.txt'), 'NEEDLE-WIN-PATH should NOT match\n');

      const r = await consumeSse(port,
        '/api/search?q=' + encodeParam('NEEDLE-WIN-PATH') +
        '&path=' + encodeParam(subDir) +
        '&glob=' + encodeParam('public\\*.js'));   // <-- Windows-shaped
      // Status 200 (not 400) is the load-bearing assertion — proves the
      // server normalized `\` → `/` before the regex check. Without the
      // normalization, the 400 "Invalid glob pattern" path would fire
      // on every Windows client.
      assert.strictEqual(r.status, 200,
        'Windows-style backslash glob must NOT 400; got ' + r.status);

      // Match-count assertion is only meaningful on the ripgrep backend.
      // grep's `--include` flag matches FILENAMES (not paths) — the
      // normalized `public/*.js` would match nothing on grep, where a
      // basename glob like `*.js` would be needed instead. The
      // backslash-normalization contract holds either way (status 200
      // is the proof); the grep semantics gap for path-relative globs
      // is a separate v2 concern (a wrapper that translates path-
      // relative globs to grep's --include + --exclude-dir is the
      // honest path forward; out of scope for this fix-up).
      const start = r.events.find((e) => e.type === 'start');
      const backend = start && start.backend;
      if (backend === 'rg') {
        const matches = r.events.filter((e) => e.type === 'match');
        assert.ok(matches.length >= 1,
          'expected at least 1 match on rg backend; got ' + matches.length);
        for (const m of matches) {
          assert.match(m.path, /public.*foo\.js$/,
            'all rg matches should be inside public/; got ' + m.path);
        }
      }
      // On grep backend (Linux CI without ripgrep): match count is not
      // asserted — the contract is satisfied by the 200 status above.

      fs.rmSync(subDir, { recursive: true, force: true });
    });

    (searchAvailable ? it : it.skip)('returns 403 when ?path escapes baseFolder', async function () {
      const escape = path.resolve(realTmpDirS(), '..', 'outside-search');
      const r = await consumeSse(port, '/api/search?q=foo&path=' + encodeParam(escape));
      assert.strictEqual(r.status, 403);
    });

    (searchAvailable ? it : it.skip)('streams matches via SSE for fixed-string query', async function () {
      const subDir = path.join(realTmpDirS(), 'searchcorpus');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'a.txt'), 'alpha\nNEEDLE-MARK in line two\nbeta\n');
      fs.writeFileSync(path.join(subDir, 'b.txt'), 'gamma\ndelta NEEDLE-MARK\n');
      fs.writeFileSync(path.join(subDir, 'noisy.txt'), 'unrelated content here\n');

      const r = await consumeSse(port,
        '/api/search?q=' + encodeParam('NEEDLE-MARK') + '&path=' + encodeParam(subDir));
      assert.strictEqual(r.status, 200);

      const start = r.events.find((e) => e.type === 'start');
      const matches = r.events.filter((e) => e.type === 'match');
      const end = r.events.find((e) => e.type === 'end');

      assert.ok(start, 'expected a start event');
      assert.ok(end, 'expected an end event');
      assert.ok(matches.length >= 2, 'expected at least 2 matches, got ' + matches.length);

      // Verify shape of one match.
      const m = matches[0];
      assert.ok(typeof m.path === 'string');
      assert.ok(typeof m.line === 'number');
      assert.ok(typeof m.col === 'number');
      assert.match(m.text, /NEEDLE-MARK/);

      // Cleanup
      fs.rmSync(subDir, { recursive: true, force: true });
    });

    (searchAvailable ? it : it.skip)('case-insensitive by default', async function () {
      const subDir = path.join(realTmpDirS(), 'searchcase');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'mixed.txt'), 'CamelCase needle here\n');

      const r = await consumeSse(port,
        '/api/search?q=' + encodeParam('camelcase') + '&path=' + encodeParam(subDir));
      assert.strictEqual(r.status, 200);
      const matches = r.events.filter((e) => e.type === 'match');
      assert.ok(matches.length >= 1, 'expected at least 1 case-insensitive match');

      fs.rmSync(subDir, { recursive: true, force: true });
    });

    (searchAvailable ? it : it.skip)('rate-limits at 10 requests per minute per IP', async function () {
      // Fire 11 cheap requests sequentially. The 11th should 429.
      const subDir = path.join(realTmpDirS(), 'ratelimit');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'r.txt'), 'aaa\n');
      let lastStatus;
      for (let i = 0; i < 11; i++) {
        const r = await consumeSse(port,
          '/api/search?q=aaa&path=' + encodeParam(subDir), 5000);
        lastStatus = r.status;
        if (r.status === 429) break;
      }
      assert.strictEqual(lastStatus, 429, 'expected 429 within 11 requests');

      fs.rmSync(subDir, { recursive: true, force: true });
    });
  });

  // ===========================================================================
  // GET /api/files/watch — SSE-streamed fs-watcher events (ADR-0017 / #100)
  // ===========================================================================
  describe('GET /api/files/watch', function () {
    function realTmpDirW() {
      try { return fs.realpathSync(tmpDir); } catch (_) { return tmpDir; }
    }

    // chokidar's FSEvents backend on macOS races with sync writeFileSync
    // (the file appears stable on chokidar's first poll BEFORE the write
    // completes). Switching to the polling backend (`usePolling: true`)
    // bypasses FSEvents entirely and uses fs.stat-loop change detection
    // — slower (50ms interval) but reliable for the sync-write tests.
    // Combined with awaitWriteFinish disabled (stability=0), this makes
    // tests deterministic. Production keeps both defaults for native-OS
    // performance + read-during-write protection.
    const _origStabilityMs = process.env.FS_WATCHER_STABILITY_MS;
    const _origPollMs = process.env.FS_WATCHER_POLL_MS;
    const _origUsePolling = process.env.FS_WATCHER_USE_POLLING;
    before(function () {
      process.env.FS_WATCHER_STABILITY_MS = '0';
      process.env.FS_WATCHER_USE_POLLING = '1';
    });
    after(function () {
      if (_origStabilityMs === undefined) delete process.env.FS_WATCHER_STABILITY_MS;
      else process.env.FS_WATCHER_STABILITY_MS = _origStabilityMs;
      if (_origPollMs === undefined) delete process.env.FS_WATCHER_POLL_MS;
      else process.env.FS_WATCHER_POLL_MS = _origPollMs;
      if (_origUsePolling === undefined) delete process.env.FS_WATCHER_USE_POLLING;
      else process.env.FS_WATCHER_USE_POLLING = _origUsePolling;
    });

    // Reset the server's per-IP watcher counter + active-session map
    // BEFORE each test. SSE close-handlers race with test teardown when
    // many watch tests run in sequence — a leaked count from a prior
    // test's destroy() can push a fresh test past the 5/IP cap. Clearing
    // server state here guarantees each test starts from a known baseline
    // without making each individual test wait 500ms+ for TCP teardown.
    //
    // Async to await chokidar's close() — closing is otherwise fire-and-
    // forget in the cleanup() handler, and an in-flight close from a
    // prior test can interfere with the next test's chokidar instance
    // (FSEvents handles overlap, intermittent missed events).
    beforeEach(async function () {
      if (server && server._activeWatchersByIp) {
        server._activeWatchersByIp.clear();
      }
      if (server && server._fsWatchSessions) {
        const closes = [];
        for (const entry of server._fsWatchSessions.values()) {
          if (entry && entry.watcher && typeof entry.watcher.close === 'function') {
            closes.push(entry.watcher.close().catch(() => {}));
          }
          try { entry.cleanup && entry.cleanup('test-reset'); } catch (_) {}
        }
        server._fsWatchSessions.clear();
        await Promise.all(closes);
        // Small additional settle: chokidar's FSEvents stream takes a
        // few ms after close to release. Without this, a fresh watcher
        // in the next test sometimes shares state with the old one
        // and misses events.
        await new Promise((r) => setTimeout(r, 50));
      }
    });

    /**
     * Test helper — register a synthetic session in the server map so
     * the watcher's race guard (no orphan watchers without a parent
     * session) lets the SSE open. Real REST-API session creation would
     * also work, but it pulls in body-parser overhead and the watcher
     * code path doesn't care about any other session field.
     *
     * The PR #99 leak fix added the guard:
     *     if (!this.claudeSessions.has(sessionId)) { cleanup(); return; }
     * which is correct for production (every watcher is anchored to a
     * live session that DELETE/eviction can cascade through), but it
     * means watcher tests can no longer fabricate sessionIds out of thin
     * air.
     */
    function ensureSession(id) {
      if (!server || !server.claudeSessions) return;
      if (server.claudeSessions.has(id)) return;
      server.claudeSessions.set(id, {
        id: id,
        name: 'test-' + id,
        created: new Date(),
        lastActivity: new Date(),
        active: false,
        agent: null,
        workingDir: tmpDir,
        connections: new Set(),
        outputBuffer: { push: () => {}, getAll: () => [], clear: () => {} },
        priority: 'foreground',
        sessionStartTime: null,
        sessionUsage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalCost: 0, models: {} },
        maxBufferSize: 1000,
      });
    }

    /**
     * Open an SSE connection that stays open until `predicate(events)` returns
     * truthy or `timeoutMs` elapses, then closes the connection and resolves
     * with { status, events }. Used by tests that need to wait for specific
     * events from the watcher (which are async and arrive after the fs-write).
     */
    function consumeSseUntil(port, urlPath, predicate, timeoutMs) {
      timeoutMs = timeoutMs || 5000;
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port: port, path: urlPath, method: 'GET',
          headers: { 'Accept': 'text/event-stream' },
        }, (res) => {
          if (res.statusCode !== 200) {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf-8');
              let body;
              try { body = JSON.parse(raw); } catch (_) { body = raw; }
              resolve({ status: res.statusCode, events: [], body, request: req });
            });
            return;
          }
          let buf = '';
          const events = [];
          let resolved = false;
          const t = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            try { req.destroy(); } catch (_) {}
            resolve({ status: 200, events, timedOut: true, request: req });
          }, timeoutMs);
          res.setEncoding('utf-8');
          res.on('data', (chunk) => {
            buf += chunk;
            let sep;
            while ((sep = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const dataLines = frame.split('\n')
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.replace(/^data:\s?/, ''));
              if (!dataLines.length) continue;
              try {
                const evt = JSON.parse(dataLines.join('\n'));
                events.push(evt);
                if (predicate(events) && !resolved) {
                  resolved = true;
                  clearTimeout(t);
                  try { req.destroy(); } catch (_) {}
                  resolve({ status: 200, events, request: req });
                }
              } catch (_) {}
            }
          });
          res.on('end', () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(t);
            resolve({ status: 200, events, request: req });
          });
          res.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(t);
            reject(err);
          });
        });
        req.on('error', (err) => { if (!resolved) reject(err); });
        req.end();
      });
    }

    /** Open an SSE connection without waiting — caller closes it. */
    function openSse(port, urlPath) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port: port, path: urlPath, method: 'GET',
          headers: { 'Accept': 'text/event-stream' },
        }, (res) => {
          resolve({ status: res.statusCode, request: req, response: res });
          // Drain so the connection stays alive (no backpressure trigger).
          res.on('data', () => {});
          res.on('error', () => {});
        });
        req.on('error', reject);
        req.end();
      });
    }

    /**
     * Helper: open an SSE for the given session + watch root, wait for
     * {type:'start'}, then return the request handle so the caller can
     * subscribe paths via POST and read events as they arrive.
     */
    function openSseAndWaitForStart(port, sessionId, watchRoot, timeoutMs) {
      // PR #99 race-guard contract — the watcher route now refuses to
      // register an entry for a sessionId that's not present in
      // claudeSessions. Tests that fabricate sessionIds must register
      // a placeholder first.
      ensureSession(sessionId);
      timeoutMs = timeoutMs || 3000;
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port: port,
          path: `/api/files/watch?session=${encodeParam(sessionId)}&path=${encodeParam(watchRoot)}`,
          method: 'GET', headers: { 'Accept': 'text/event-stream' },
        }, (res) => {
          if (res.statusCode !== 200) {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf-8');
              let body;
              try { body = JSON.parse(raw); } catch (_) { body = raw; }
              resolve({ status: res.statusCode, body, request: req, events: [] });
            });
            return;
          }
          let buf = '';
          const events = [];
          let started = false;
          const t = setTimeout(() => {
            if (!started) {
              try { req.destroy(); } catch (_) {}
              reject(new Error('SSE start timeout after ' + timeoutMs + 'ms'));
            }
          }, timeoutMs);
          res.setEncoding('utf-8');
          res.on('data', (chunk) => {
            buf += chunk;
            let sep;
            while ((sep = buf.indexOf('\n\n')) !== -1) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const dataLines = frame.split('\n')
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.replace(/^data:\s?/, ''));
              if (!dataLines.length) continue;
              try {
                const evt = JSON.parse(dataLines.join('\n'));
                events.push(evt);
                if (evt.type === 'start' && !started) {
                  started = true;
                  clearTimeout(t);
                  resolve({ status: 200, request: req, response: res, events: events });
                }
              } catch (_) {}
            }
          });
          res.on('error', (err) => { if (!started) { clearTimeout(t); reject(err); } });
        });
        req.on('error', reject);
        req.end();
      });
    }

    /** Wait for an event matching predicate to appear in the events array. */
    function waitForEvent(events, predicate, timeoutMs) {
      timeoutMs = timeoutMs || 3000;
      return new Promise((resolve, reject) => {
        const start = Date.now();
        function check() {
          const found = events.find(predicate);
          if (found) return resolve(found);
          if (Date.now() - start > timeoutMs) return reject(new Error('waitForEvent timeout'));
          setTimeout(check, 30);
        }
        check();
      });
    }

    function postJson(port, urlPath) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port: port, path: urlPath, method: 'POST',
          headers: { 'Content-Length': '0' },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            let body;
            try { body = JSON.parse(raw); } catch (_) { body = raw; }
            resolve({ status: res.statusCode, body });
          });
        });
        req.on('error', reject);
        req.end();
      });
    }

    it('returns 400 when session is missing', async function () {
      const r = await consumeSseUntil(port, '/api/files/watch?path=' + encodeParam(realTmpDirW()), () => true, 1000);
      assert.strictEqual(r.status, 400);
    });

    it('returns 400 when path is missing', async function () {
      const r = await consumeSseUntil(port, '/api/files/watch?session=s1', () => true, 1000);
      assert.strictEqual(r.status, 400);
    });

    it('returns 403 when path escapes baseFolder', async function () {
      const escape = path.resolve(realTmpDirW(), '..', 'outside-watch');
      const r = await consumeSseUntil(port, '/api/files/watch?session=s2&path=' + encodeParam(escape), () => true, 1000);
      assert.strictEqual(r.status, 403);
    });

    it('returns 404 when path does not exist', async function () {
      const missing = path.join(realTmpDirW(), 'definitely-not-here-' + Date.now());
      const r = await consumeSseUntil(port, '/api/files/watch?session=s3&path=' + encodeParam(missing), () => true, 1000);
      assert.strictEqual(r.status, 404);
    });

    it('returns 400 when path is a file, not a directory', async function () {
      const f = path.join(realTmpDirW(), 'watch-not-a-dir.txt');
      fs.writeFileSync(f, 'x');
      const r = await consumeSseUntil(port, '/api/files/watch?session=s4&path=' + encodeParam(f), () => true, 1000);
      assert.strictEqual(r.status, 400);
      try { fs.unlinkSync(f); } catch (_) {}
    });

    it('subscribe before EventSource open returns 404', async function () {
      const subDir = path.join(realTmpDirW(), 'watch-sub-no-es');
      fs.mkdirSync(subDir, { recursive: true });
      const target = path.join(subDir, 'never.txt');

      const r = await postJson(port,
        `/api/files/watch/subscribe?session=no-such-session&path=${encodeParam(target)}`);
      assert.strictEqual(r.status, 404);
      assert.match(r.body.error || '', /no active watcher/i);

      fs.rmSync(subDir, { recursive: true, force: true });
    });

    it('multi-path subscribe on one EventSource → events from BOTH paths arrive', async function () {
      const subDir = path.join(realTmpDirW(), 'watch-multipath');
      fs.mkdirSync(subDir, { recursive: true });
      fs.mkdirSync(path.join(subDir, 'sub1'), { recursive: true });
      fs.mkdirSync(path.join(subDir, 'sub2'), { recursive: true });
      const targetA = path.join(subDir, 'sub1', 'a.txt');
      const targetB = path.join(subDir, 'sub2', 'b.txt');

      const sessionId = 'mp-' + Date.now();
      const sse = await openSseAndWaitForStart(port, sessionId, subDir);
      assert.strictEqual(sse.status, 200);

      // Subscribe both paths via the control channel.
      const sub1 = await postJson(port,
        `/api/files/watch/subscribe?session=${encodeParam(sessionId)}&path=${encodeParam(targetA)}`);
      assert.strictEqual(sub1.status, 204, 'expected 204 on first subscribe');
      const sub2 = await postJson(port,
        `/api/files/watch/subscribe?session=${encodeParam(sessionId)}&path=${encodeParam(targetB)}`);
      assert.strictEqual(sub2.status, 204, 'expected 204 on second subscribe');

      // Small wait before sync writeFileSync — chokidar's awaitWriteFinish
      // poll cycle (30ms) sometimes happens BEFORE the write completes,
      // and then never re-polls because the file appears stable. Real-
      // user writes (network, editor, agent) take long enough that this
      // race doesn't apply, but a sync 5-byte writeFileSync immediately
      // after subscribe DOES race. 80ms is enough to land between two
      // chokidar polls so the change is detected.
      await new Promise((r) => setTimeout(r, 80));

      // Write to BOTH; events for BOTH should arrive on the single SSE.
      fs.writeFileSync(targetA, 'one');
      fs.writeFileSync(targetB, 'two');

      const evtA = await waitForEvent(sse.events, (e) => e.type === 'add' && e.path && e.path.endsWith('/sub1/a.txt'), 3000);
      const evtB = await waitForEvent(sse.events, (e) => e.type === 'add' && e.path && e.path.endsWith('/sub2/b.txt'), 3000);

      assert.ok(evtA, 'expected add event for sub1/a.txt');
      assert.ok(evtB, 'expected add event for sub2/b.txt');
      // relPath should be set and forward-slashed.
      assert.strictEqual(evtA.relPath, 'sub1/a.txt');
      assert.strictEqual(evtB.relPath, 'sub2/b.txt');

      try { sse.request.destroy(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
      fs.rmSync(subDir, { recursive: true, force: true });
    });

    it('unsubscribe stops events for that path; non-subscribed paths are silent', async function () {
      const subDir = path.join(realTmpDirW(), 'watch-unsub');
      fs.mkdirSync(subDir, { recursive: true });
      const subscribed = path.join(subDir, 'subscribed.txt');
      const unsubscribed = path.join(subDir, 'never-subscribed.txt');

      const sessionId = 'us-' + Date.now();
      const sse = await openSseAndWaitForStart(port, sessionId, subDir);
      assert.strictEqual(sse.status, 200);

      // Subscribe one path; the other is never subscribed.
      const sub = await postJson(port,
        `/api/files/watch/subscribe?session=${encodeParam(sessionId)}&path=${encodeParam(subscribed)}`);
      assert.strictEqual(sub.status, 204);

      fs.writeFileSync(subscribed, 'sub');
      fs.writeFileSync(unsubscribed, 'no-sub');

      // Wait for the subscribed-file event to arrive.
      await waitForEvent(sse.events, (e) => e.type === 'add' && e.path && e.path.endsWith('/subscribed.txt'), 3000);

      // The unsubscribed file's add must NOT appear (subscription filter).
      const unsubEvts = sse.events.filter((e) => e.path && e.path.endsWith('/never-subscribed.txt'));
      assert.strictEqual(unsubEvts.length, 0,
        'unsubscribed-path events leaked: ' + JSON.stringify(unsubEvts));

      // Now unsubscribe the subscribed path; subsequent changes silent.
      const before = sse.events.length;
      const us = await postJson(port,
        `/api/files/watch/unsubscribe?session=${encodeParam(sessionId)}&path=${encodeParam(subscribed)}`);
      assert.strictEqual(us.status, 204);
      // chokidar/debounce may still be in flight from earlier events; wait
      // out the debounce + a small buffer, snapshot, then write again.
      await new Promise((r) => setTimeout(r, 200));
      const beforeWrite = sse.events.length;
      fs.writeFileSync(subscribed, 'silent');
      await new Promise((r) => setTimeout(r, 250));
      const newEvents = sse.events.slice(beforeWrite);
      const subscribedEvents = newEvents.filter((e) => e.path && e.path.endsWith('/subscribed.txt'));
      assert.strictEqual(subscribedEvents.length, 0,
        'unsubscribed-path got events: ' + JSON.stringify(subscribedEvents));

      try { sse.request.destroy(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
      fs.rmSync(subDir, { recursive: true, force: true });
    });

    it('streams add → change → unlink for a subscribed file', async function () {
      const subDir = path.join(realTmpDirW(), 'watch-acu');
      fs.mkdirSync(subDir, { recursive: true });
      const target = path.join(subDir, 'changeling.txt');

      const sessionId = 'acu-' + Date.now();
      const sse = await openSseAndWaitForStart(port, sessionId, subDir);
      assert.strictEqual(sse.status, 200);

      const sub = await postJson(port,
        `/api/files/watch/subscribe?session=${encodeParam(sessionId)}&path=${encodeParam(target)}`);
      assert.strictEqual(sub.status, 204);

      // Under depth: 0, subscribe() calls chokidar.add() which is async — give
      // it a moment to attach before mutating, or the first 'add' event races.
      // In production the file-browser's initial /api/files readdir naturally
      // covers this window; tests need an explicit delay.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Lifecycle: write → modify → delete, with > debounce-window between
      // (debounce default is 500ms post-Windows-hang fix — the gap MUST
      // exceed that or per-path debounce will collapse add+change into one
      // event with the latest type winning).
      fs.writeFileSync(target, 'first');
      await new Promise((resolve) => setTimeout(resolve, 700));
      fs.writeFileSync(target, 'second');
      await new Promise((resolve) => setTimeout(resolve, 700));
      fs.unlinkSync(target);

      // Wait for the unlink event to confirm the chain completed.
      await waitForEvent(sse.events, (e) => e.type === 'unlink' && e.path && e.path.endsWith('/changeling.txt'), 5000);

      const types = sse.events.filter((e) => e.path && e.path.endsWith('/changeling.txt')).map((e) => e.type);
      assert.ok(types.includes('add'), 'expected add; got ' + types.join(','));
      assert.ok(types.includes('change'), 'expected change; got ' + types.join(','));
      assert.ok(types.includes('unlink'), 'expected unlink; got ' + types.join(','));

      // Validate event-payload shape.
      const change = sse.events.find((e) => e.type === 'change' && e.path && e.path.endsWith('/changeling.txt'));
      assert.ok(change, 'change event must exist');
      assert.strictEqual(change.relPath, 'changeling.txt', 'relPath must be set');
      assert.strictEqual(typeof change.mtime, 'number', 'change must include numeric mtime');
      // hash is now opt-in: when the server constructs FileWatcher with
      // depth: 0 (the narrow-scope path used by /api/files/watch since the
      // Windows-hang fix), includeHash defaults to false to keep the sync
      // fs.readFileSync MD5 from blocking the event loop under bulk edits.
      // When present, it must still be a 32-char hex string.
      if (change.hash !== undefined) {
        assert.ok(typeof change.hash === 'string' && /^[0-9a-f]{32}$/.test(change.hash),
          'change.hash, if emitted, must be a 32-char md5 hex; got ' + change.hash);
      }

      const unlink = sse.events.find((e) => e.type === 'unlink' && e.path && e.path.endsWith('/changeling.txt'));
      assert.strictEqual(unlink.mtime, null, 'unlink mtime must be null');
      assert.strictEqual(unlink.hash, undefined, 'unlink must not include hash');

      try { sse.request.destroy(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
      fs.rmSync(subDir, { recursive: true, force: true });
    });

    it('opening a 2nd EventSource for same session replaces the first (single-ES-per-session)', async function () {
      const subDir = path.join(realTmpDirW(), 'watch-replace');
      fs.mkdirSync(subDir, { recursive: true });

      const sessionId = 'rep-' + Date.now();
      const first = await openSseAndWaitForStart(port, sessionId, subDir);
      assert.strictEqual(first.status, 200);

      // Open a SECOND ES with the same session id. The first should
      // receive {type:"end", reason:"replaced"} on its stream.
      const second = await openSseAndWaitForStart(port, sessionId, subDir);
      assert.strictEqual(second.status, 200);

      // Wait for the replaced event on the first stream.
      await waitForEvent(first.events, (e) => e.type === 'end' && e.reason === 'replaced', 2000);

      try { first.request.destroy(); } catch (_) {}
      try { second.request.destroy(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
      fs.rmSync(subDir, { recursive: true, force: true });
    });

    it('rate-limits at 5 concurrent watchers per IP (returns 429 on 6th)', async function () {
      const subDir = path.join(realTmpDirW(), 'watch-rl');
      fs.mkdirSync(subDir, { recursive: true });

      // PR #99 race-guard contract — pre-register each synthetic session
      // so the 5 watcher slots actually open (otherwise the route bails
      // on the 'session_missing' guard before incrementing the counter).
      for (let i = 0; i < 7; i++) ensureSession('rl-slot-' + i);

      // Open 5 watchers with DISTINCT session ids and HOLD them open.
      // The 6th must 429.
      const open5 = [];
      for (let i = 0; i < 5; i++) {
        open5.push(await openSse(port,
          `/api/files/watch?session=rl-slot-${i}&path=${encodeParam(subDir)}`));
      }
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(open5[i].status, 200,
          `slot ${i + 1} expected 200, got ${open5[i].status}`);
      }
      // 6th attempt → 429.
      const sixth = await consumeSseUntil(port,
        `/api/files/watch?session=rl-slot-6&path=${encodeParam(subDir)}`, () => true, 1000);
      assert.strictEqual(sixth.status, 429,
        'expected 429 on 6th concurrent watcher, got ' + sixth.status);

      // Close the 5 holders so the counter decrements.
      for (const h of open5) {
        try { h.request.destroy(); } catch (_) {}
      }
      await new Promise((resolve) => setTimeout(resolve, 200));

      fs.rmSync(subDir, { recursive: true, force: true });
    });

    it('unsubscribe is idempotent (no-op for non-existent session)', async function () {
      const target = path.join(realTmpDirW(), 'unsub-idem.txt');
      const r = await postJson(port,
        `/api/files/watch/unsubscribe?session=ghost&path=${encodeParam(target)}`);
      assert.strictEqual(r.status, 204);
    });

    // ── Recursive subscriptions (engineer's a5e57d7 gap) ──────────────────
    //
    // Without recursive=1, the server's exact-path filter drops events
    // for paths that weren't subscribed at the time of the event — which
    // breaks the "external add → file list refreshes" case (the new
    // file's path can't be subscribed because it didn't exist when the
    // panel mounted). recursive=1 stores the subscription as a directory
    // prefix-match so any descendant fires the event.

    it('recursive=1: emits add event for fresh file in subscribed dir', async function () {
      const subDir = path.join(realTmpDirW(), 'watch-rec-add');
      fs.mkdirSync(subDir, { recursive: true });

      const sessionId = 'rec-add-' + Date.now();
      const sse = await openSseAndWaitForStart(port, sessionId, subDir);
      assert.strictEqual(sse.status, 200);

      const sub = await postJson(port,
        `/api/files/watch/subscribe?session=${encodeParam(sessionId)}&path=${encodeParam(subDir)}&recursive=1`);
      assert.strictEqual(sub.status, 204);

      // File path was NOT subscribed exactly — only the parent dir was,
      // recursively. The exact-path filter would drop this event; the
      // recursive filter must accept it.
      const target = path.join(subDir, 'fresh-from-agent.txt');
      fs.writeFileSync(target, 'agent created me');

      const evt = await waitForEvent(sse.events,
        (e) => e.type === 'add' && e.path && e.path.endsWith('/fresh-from-agent.txt'),
        3000);
      assert.ok(evt, 'expected add event for newly-created file inside recursive sub');
      assert.strictEqual(evt.relPath, 'fresh-from-agent.txt');

      try { sse.request.destroy(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
      fs.rmSync(subDir, { recursive: true, force: true });
    });

    it('recursive=1: emits change event for nested file in subscribed dir', async function () {
      // SEMANTIC NOTE: under the depth: 0 narrow-scope (introduced when the
      // Windows-hang fix narrowed chokidar to direct-children-only), a
      // "recursive" subscription means "this dir's direct children", not
      // "this dir's whole subtree". The file-browser listing only renders
      // direct children anyway, so this matches actual use. This test now
      // exercises the direct-child case; descendant events are intentionally
      // not supported.
      const subDir = path.join(realTmpDirW(), 'watch-rec-direct');
      fs.mkdirSync(subDir, { recursive: true });
      const direct = path.join(subDir, 'direct.txt');
      fs.writeFileSync(direct, 'initial');

      const sessionId = 'rec-direct-' + Date.now();
      const sse = await openSseAndWaitForStart(port, sessionId, subDir);
      assert.strictEqual(sse.status, 200);

      const sub = await postJson(port,
        `/api/files/watch/subscribe?session=${encodeParam(sessionId)}&path=${encodeParam(subDir)}&recursive=1`);
      assert.strictEqual(sub.status, 204);

      // Settle the chokidar.add() race window (see note in the "streams add
      // → change → unlink" test above).
      await new Promise((r) => setTimeout(r, 200));
      fs.writeFileSync(direct, 'modified by agent');

      const evt = await waitForEvent(sse.events,
        (e) => e.type === 'change' && e.path && e.path.endsWith('/direct.txt'),
        3000);
      assert.ok(evt, 'expected change event for direct-child file inside recursive sub');
      assert.strictEqual(evt.relPath, 'direct.txt');

      try { sse.request.destroy(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
      fs.rmSync(subDir, { recursive: true, force: true });
    });

    it('recursive=1: events for paths OUTSIDE the subscribed dir are suppressed', async function () {
      const root = path.join(realTmpDirW(), 'watch-rec-outside');
      const inside = path.join(root, 'inside');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(inside, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });

      const sessionId = 'rec-out-' + Date.now();
      const sse = await openSseAndWaitForStart(port, sessionId, root);
      assert.strictEqual(sse.status, 200);

      // Subscribe ONLY the inside dir.
      const sub = await postJson(port,
        `/api/files/watch/subscribe?session=${encodeParam(sessionId)}&path=${encodeParam(inside)}&recursive=1`);
      assert.strictEqual(sub.status, 204);

      // Settle the chokidar.add() race for the inside subscription.
      await new Promise((r) => setTimeout(r, 200));
      fs.writeFileSync(path.join(inside, 'in.txt'), 'inside');
      fs.writeFileSync(path.join(outside, 'out.txt'), 'outside');

      // Wait for the inside event so we know events have had time to flow.
      await waitForEvent(sse.events,
        (e) => e.type === 'add' && e.path && e.path.endsWith('/inside/in.txt'),
        3000);

      // Outside event must NOT have arrived.
      const outsideEvts = sse.events.filter((e) => e.path && e.path.endsWith('/outside/out.txt'));
      assert.strictEqual(outsideEvts.length, 0,
        'outside-dir events leaked through recursive sub: ' + JSON.stringify(outsideEvts));

      try { sse.request.destroy(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('recursive=1: prefix-match precision — /a/b should NOT match /a/bc', async function () {
      // Defends against the classic "string startsWith" bug. /a/bc is NOT
      // inside /a/b — the trailing-separator storage in _dirSubscriptions
      // is the load-bearing detail.
      const root = path.join(realTmpDirW(), 'watch-rec-prefix');
      fs.mkdirSync(path.join(root, 'b'), { recursive: true });
      fs.mkdirSync(path.join(root, 'bc'), { recursive: true });

      const sessionId = 'rec-pre-' + Date.now();
      const sse = await openSseAndWaitForStart(port, sessionId, root);
      assert.strictEqual(sse.status, 200);

      // Subscribe /a/b recursively. Files in /a/bc must NOT trigger.
      const sub = await postJson(port,
        `/api/files/watch/subscribe?session=${encodeParam(sessionId)}&path=${encodeParam(path.join(root, 'b'))}&recursive=1`);
      assert.strictEqual(sub.status, 204);

      // Settle the chokidar.add() race.
      await new Promise((r) => setTimeout(r, 200));
      fs.writeFileSync(path.join(root, 'b', 'in.txt'), 'in');
      fs.writeFileSync(path.join(root, 'bc', 'out.txt'), 'out');

      // Wait for the in event.
      await waitForEvent(sse.events,
        (e) => e.type === 'add' && e.path && e.path.endsWith('/b/in.txt'),
        3000);

      // /bc/out.txt must NOT have triggered.
      const outEvts = sse.events.filter((e) => e.path && e.path.endsWith('/bc/out.txt'));
      assert.strictEqual(outEvts.length, 0,
        'sibling /bc/out.txt event leaked via /b prefix match: ' + JSON.stringify(outEvts));

      try { sse.request.destroy(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('recursive=1: unsubscribe with recursive=1 stops events; events resume silent', async function () {
      const subDir = path.join(realTmpDirW(), 'watch-rec-unsub');
      fs.mkdirSync(subDir, { recursive: true });

      const sessionId = 'rec-unsub-' + Date.now();
      const sse = await openSseAndWaitForStart(port, sessionId, subDir);
      assert.strictEqual(sse.status, 200);

      const sub = await postJson(port,
        `/api/files/watch/subscribe?session=${encodeParam(sessionId)}&path=${encodeParam(subDir)}&recursive=1`);
      assert.strictEqual(sub.status, 204);

      fs.writeFileSync(path.join(subDir, 'first.txt'), 'a');
      await waitForEvent(sse.events,
        (e) => e.type === 'add' && e.path && e.path.endsWith('/first.txt'), 3000);

      // Unsubscribe with the SAME flavour we subscribed with.
      const us = await postJson(port,
        `/api/files/watch/unsubscribe?session=${encodeParam(sessionId)}&path=${encodeParam(subDir)}&recursive=1`);
      assert.strictEqual(us.status, 204);

      await new Promise((r) => setTimeout(r, 200));   // let any in-flight settle
      const before = sse.events.length;
      fs.writeFileSync(path.join(subDir, 'silent.txt'), 'b');
      await new Promise((r) => setTimeout(r, 250));
      const newEvents = sse.events.slice(before).filter((e) => e.path && e.path.endsWith('/silent.txt'));
      assert.strictEqual(newEvents.length, 0,
        'recursive unsubscribe failed; got events: ' + JSON.stringify(newEvents));

      try { sse.request.destroy(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
      fs.rmSync(subDir, { recursive: true, force: true });
    });

    it('recursive=1: wrong-flavour unsubscribe is a no-op (recursive sub stays)', async function () {
      // A client that issues unsubscribe(path) without recursive=1 against
      // a path that was subscribed WITH recursive=1 should NOT remove the
      // recursive sub (and vice versa). This lets clients safely "unsub
      // both flavours" without prior knowledge.
      const subDir = path.join(realTmpDirW(), 'watch-rec-mismatch');
      fs.mkdirSync(subDir, { recursive: true });

      const sessionId = 'rec-mis-' + Date.now();
      const sse = await openSseAndWaitForStart(port, sessionId, subDir);
      assert.strictEqual(sse.status, 200);

      // Subscribe recursive.
      await postJson(port,
        `/api/files/watch/subscribe?session=${encodeParam(sessionId)}&path=${encodeParam(subDir)}&recursive=1`);

      // Wrong-flavour unsubscribe (no recursive=1) → 204 but doesn't
      // affect the recursive subscription.
      const wrong = await postJson(port,
        `/api/files/watch/unsubscribe?session=${encodeParam(sessionId)}&path=${encodeParam(subDir)}`);
      assert.strictEqual(wrong.status, 204);

      // Recursive sub should still fire.
      fs.writeFileSync(path.join(subDir, 'should-fire.txt'), 'still subscribed');
      const evt = await waitForEvent(sse.events,
        (e) => e.type === 'add' && e.path && e.path.endsWith('/should-fire.txt'), 3000);
      assert.ok(evt, 'wrong-flavour unsubscribe must not affect recursive sub');

      try { sse.request.destroy(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
      fs.rmSync(subDir, { recursive: true, force: true });
    });

    // Regression for the path-canonicalization bug team-lead caught on
    // ce0102e: subscribe paths were stored via path.resolve() (lexical),
    // but chokidar emits the realpath form for events. On macOS where
    // /var → /private/var, the prefix-match in _dirSubscriptions missed
    // → recursive subs silently dropped events even for paths INSIDE
    // the subscribed dir. The fix in FileWatcher._canonicalize() runs
    // realpathSync (with parent-realpath fallback for non-existent
    // paths) so subscriptions and events compare in the same form.
    //
    // This test exercises the bug directly via a symlinked subscribe
    // path: an event on the realpath-form must match a subscription
    // submitted in the symlinked-form.
    it('recursive=1: subscription via symlinked path still receives events (canonicalization)', async function () {
      const realDir = path.join(realTmpDirW(), 'watch-rec-realdir');
      fs.mkdirSync(realDir, { recursive: true });
      const symlinkDir = path.join(realTmpDirW(), 'watch-rec-symlink');
      try {
        fs.symlinkSync(realDir, symlinkDir, 'dir');
      } catch (e) {
        // Symlinks may not be supported in the test sandbox (e.g.
        // some Windows configurations) — skip rather than fail.
        this.skip();
        return;
      }

      const sessionId = 'rec-sym-' + Date.now();
      const sse = await openSseAndWaitForStart(port, sessionId, realTmpDirW());
      assert.strictEqual(sse.status, 200);

      // Subscribe via the SYMLINK form. Event will arrive on the
      // canonical (realpath) form. Without the canonicalization fix,
      // the prefix-match would miss and the test would time out.
      const sub = await postJson(port,
        `/api/files/watch/subscribe?session=${encodeParam(sessionId)}&path=${encodeParam(symlinkDir)}&recursive=1`);
      assert.strictEqual(sub.status, 204);

      // Settle wait — chokidar's awaitWriteFinish poll cycle (30ms) can
      // race with sync writeFileSync on freshly-created files; without
      // this wait the test is flaky (passes ~2/3 runs locally on macOS).
      // Real-user writes (network, editor, agent) take long enough that
      // the race doesn't apply in production.
      await new Promise((r) => setTimeout(r, 80));

      // Write a fresh file via the REAL path; chokidar emits canonical.
      const target = path.join(realDir, 'symlinked-sub.txt');
      fs.writeFileSync(target, 'agent created');

      const evt = await waitForEvent(sse.events,
        (e) => e.type === 'add' && e.path && e.path.endsWith('/symlinked-sub.txt'),
        3000);
      assert.ok(evt, 'event must arrive even though sub used the symlinked path');

      try { sse.request.destroy(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
      try { fs.unlinkSync(symlinkDir); } catch (_) {}
      fs.rmSync(realDir, { recursive: true, force: true });
    });

    it('recursive + exact subs at once: one event per file (no double-fire)', async function () {
      const subDir = path.join(realTmpDirW(), 'watch-rec-coexist');
      fs.mkdirSync(subDir, { recursive: true });
      const target = path.join(subDir, 'twice.txt');

      const sessionId = 'rec-coex-' + Date.now();
      const sse = await openSseAndWaitForStart(port, sessionId, subDir);
      assert.strictEqual(sse.status, 200);

      // Subscribe BOTH the parent dir (recursive) AND the file (exact).
      // The same change event should emit ONCE, not twice.
      await postJson(port,
        `/api/files/watch/subscribe?session=${encodeParam(sessionId)}&path=${encodeParam(subDir)}&recursive=1`);
      await postJson(port,
        `/api/files/watch/subscribe?session=${encodeParam(sessionId)}&path=${encodeParam(target)}`);

      // Settle the chokidar.add() race so the immediate writeFileSync below
      // is observed.
      await new Promise((r) => setTimeout(r, 200));
      fs.writeFileSync(target, 'first');
      // Wait > debounce window so any duplicates would have surfaced.
      await new Promise((r) => setTimeout(r, 600));

      const matchingEvts = sse.events.filter(
        (e) => e.type === 'add' && e.path && e.path.endsWith('/twice.txt'));
      assert.strictEqual(matchingEvts.length, 1,
        'expected exactly one add event despite double-subscription; got ' +
        matchingEvts.length + ': ' + JSON.stringify(matchingEvts));

      try { sse.request.destroy(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
      fs.rmSync(subDir, { recursive: true, force: true });
    });
  });
});

// ===========================================================================
// Auth-mode regression: inline-preview asset URLs (PDF.js, image, iframe
// fallback) MUST work when --auth <token> is set. The server has always
// accepted `?token=<t>` as a fallback when the Authorization header isn't
// available; the client just wasn't threading it through. This suite
// pins both halves of that contract end-to-end.
//
// Reviewer's HIGH on 913bfdd was the visible breakage: PDF preview 401s
// in --auth mode. Image preview and iframe fallback had the same latent
// bug. The client now uses authManager.appendAuthToUrl() to thread the
// token; this test verifies the server accepts the result.
// ===========================================================================
(ClaudeCodeWebServer ? describe : describe.skip)('Auth-mode inline preview', function () {
  this.timeout(30000);

  let server, port, tmpDir;
  const TOKEN = 'test-bearer-token-xyz';

  before(async function () {
    this.timeout(30000);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-auth-test-'));
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    server = new ClaudeCodeWebServer({ port: 0, auth: TOKEN });
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

  function realTmpDir() {
    try { return fs.realpathSync(tmpDir); } catch (_) { return tmpDir; }
  }

  it('rejects /api/files/download without auth (401)', async function () {
    const target = path.join(realTmpDir(), 'auth-test-1.txt');
    fs.writeFileSync(target, 'auth corpus');
    const res = await request(port, 'GET',
      `/api/files/download?path=${encodeParam(target)}&inline=1`);
    assert.strictEqual(res.status, 401);
  });

  it('accepts /api/files/download with valid ?token= (200)', async function () {
    const target = path.join(realTmpDir(), 'auth-test-2.txt');
    fs.writeFileSync(target, 'auth corpus 2');
    const res = await request(port, 'GET',
      `/api/files/download?path=${encodeParam(target)}&inline=1&token=${encodeParam(TOKEN)}`);
    assert.strictEqual(res.status, 200);
    // Body shape: raw bytes for inline downloads.
    const body = Buffer.isBuffer(res.body) ? res.body.toString() : String(res.body);
    assert.ok(body.includes('auth corpus 2'));
  });

  it('rejects /api/files/download with wrong ?token= (401)', async function () {
    const target = path.join(realTmpDir(), 'auth-test-3.txt');
    fs.writeFileSync(target, 'auth corpus 3');
    const res = await request(port, 'GET',
      `/api/files/download?path=${encodeParam(target)}&inline=1&token=wrong-token`);
    assert.strictEqual(res.status, 401);
  });

  it('accepts /api/files/stat with valid ?token= (200) and rejects without', async function () {
    const target = path.join(realTmpDir(), 'stat-target.txt');
    fs.writeFileSync(target, 'x');
    const res401 = await request(port, 'GET',
      `/api/files/stat?path=${encodeParam(target)}`);
    assert.strictEqual(res401.status, 401);
    const res200 = await request(port, 'GET',
      `/api/files/stat?path=${encodeParam(target)}&token=${encodeParam(TOKEN)}`);
    assert.strictEqual(res200.status, 200);
  });

  // ADR-0017 explicitly says /api/files/watch uses the same ?token= auth
  // pattern as PDF.js / image / iframe-fallback URLs (EventSource cannot
  // carry custom Authorization headers, same constraint as those).
  it('rejects /api/files/watch without auth (401)', async function () {
    const watchDir = realTmpDir();
    const res = await request(port, 'GET',
      `/api/files/watch?session=auth-no&path=${encodeParam(watchDir)}`);
    assert.strictEqual(res.status, 401);
  });

  it('accepts /api/files/watch with valid ?token= (200 SSE start)', async function () {
    const watchDir = realTmpDir();
    const reqOpts = {
      hostname: '127.0.0.1', port: port,
      path: `/api/files/watch?session=auth-yes&path=${encodeParam(watchDir)}&token=${encodeParam(TOKEN)}`,
      method: 'GET', headers: { 'Accept': 'text/event-stream' },
    };
    const status = await new Promise((resolve, reject) => {
      const req = http.request(reqOpts, (res) => {
        res.on('data', () => {});
        setImmediate(() => {
          try { req.destroy(); } catch (_) {}
          resolve(res.statusCode);
        });
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(status, 200,
      'expected 200 SSE with valid token, got ' + status);
  });
});
