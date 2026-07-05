'use strict';

// test/image-persist.test.js — unit tests for the shared image-persist core
// (ClaudeCodeWebServer._persistImageUpload), used by both the WS image_upload
// path and the HTTP POST /api/images/upload path. Verifies validation, limits,
// and a successful save without starting the HTTP server.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ClaudeCodeWebServer } = require('../src/server');

// A valid 1x1 transparent PNG.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

describe('server._persistImageUpload (image persist core)', function () {
  this.timeout(20000);
  let server;
  const tmpRoots = [];

  before(function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
  });

  after(function () {
    try { if (server && server.close) server.close(); } catch (_) { /* not started */ }
    for (const dir of tmpRoots) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  function fakeSession() {
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aod-img-'));
    tmpRoots.push(workingDir);
    return { id: 'sess-' + crypto.randomBytes(4).toString('hex'), workingDir, tempImages: [] };
  }

  async function expectThrows(fn, status) {
    let err = null;
    try { await fn(); } catch (e) { err = e; }
    assert.ok(err, 'expected the call to throw');
    assert.strictEqual(err.status, status, `expected status ${status}, got ${err.status} (${err.message})`);
    assert.ok(err.userMessage, 'error should carry a userMessage');
  }

  it('saves a valid PNG and returns filePath + size, tracking the temp image', async function () {
    const session = fakeSession();
    const result = await server._persistImageUpload(session, {
      base64: PNG_1x1, mimeType: 'image/png', fileName: 'x.png'
    });
    assert.ok(result.filePath, 'returns a filePath');
    assert.ok(result.size > 0, 'returns a positive size');
    assert.ok(fs.existsSync(result.filePath), 'the file exists on disk');
    assert.ok(result.filePath.includes('.claude-images'), 'saved under .claude-images');
    assert.strictEqual(session.tempImages.length, 1, 'tracked one temp image');
  });

  it('rejects missing base64 with 400', async function () {
    const session = fakeSession();
    await expectThrows(() => server._persistImageUpload(session, { mimeType: 'image/png' }), 400);
  });

  it('rejects an oversize image (>5.5MB base64) with 413', async function () {
    const session = fakeSession();
    const huge = 'A'.repeat(5.5 * 1024 * 1024 + 16);
    await expectThrows(() => server._persistImageUpload(session, { base64: huge, mimeType: 'image/png' }), 413);
  });

  it('rejects an unsupported MIME type with 415', async function () {
    const session = fakeSession();
    await expectThrows(() => server._persistImageUpload(session, { base64: PNG_1x1, mimeType: 'image/bmp' }), 415);
  });

  it('rate-limits after 5 uploads per minute with 429', async function () {
    const session = fakeSession();
    for (let i = 0; i < 5; i++) {
      const r = await server._persistImageUpload(session, { base64: PNG_1x1, mimeType: 'image/png' });
      assert.ok(fs.existsSync(r.filePath), `upload ${i + 1} saved`);
    }
    await expectThrows(() => server._persistImageUpload(session, { base64: PNG_1x1, mimeType: 'image/png' }), 429);
  });
});
