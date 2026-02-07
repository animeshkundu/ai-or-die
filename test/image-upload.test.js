const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

let ClaudeCodeWebServer;
try {
  ({ ClaudeCodeWebServer } = require('../src/server'));
} catch (e) {
  // node-pty not available locally, tests will be skipped
}

// Minimal 1x1 PNG as base64
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

function connectWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws, type, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
    function onMessage(data) {
      const msg = JSON.parse(data);
      if (msg.type === type) {
        clearTimeout(timer);
        ws.removeListener('message', onMessage);
        resolve(msg);
      }
    }
    ws.on('message', onMessage);
  });
}

function send(ws, data) {
  ws.send(JSON.stringify(data));
}

describe('Image upload WebSocket protocol', function () {
  // Skip entire suite if server can't be loaded (no node-pty)
  before(function () {
    if (!ClaudeCodeWebServer) this.skip();
  });

  let server, port;

  beforeEach(async function () {
    this.timeout(15000);
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  afterEach(function () {
    if (server) server.close();
  });

  it('should accept a valid PNG upload and write file to disk', async function () {
    this.timeout(15000);
    const ws = await connectWs(port);
    await waitForMessage(ws, 'connected');

    // Create session
    send(ws, { type: 'create_session', name: 'img-test' });
    const created = await waitForMessage(ws, 'session_created');

    // Upload image
    send(ws, {
      type: 'image_upload',
      base64: TINY_PNG_BASE64,
      mimeType: 'image/png',
      fileName: 'test.png',
      caption: 'test caption'
    });

    const response = await waitForMessage(ws, 'image_upload_complete');

    // Verify response has filePath
    assert(response.filePath, 'Expected filePath in response');
    assert(response.filePath.endsWith('.png'), 'Expected .png extension');

    // Verify file exists on disk
    assert(fs.existsSync(response.filePath), 'Expected file to exist on disk');

    // Verify file content is valid PNG
    const buf = fs.readFileSync(response.filePath);
    assert(buf[0] === 0x89 && buf[1] === 0x50, 'Expected PNG magic bytes');

    ws.close();
  });

  it('should reject oversized images', async function () {
    this.timeout(15000);
    const ws = await connectWs(port);
    await waitForMessage(ws, 'connected');

    send(ws, { type: 'create_session', name: 'img-test-big' });
    await waitForMessage(ws, 'session_created');

    // 6MB base64 string (exceeds the 5.5MB base64 threshold)
    const largeBase64 = 'A'.repeat(6 * 1024 * 1024);
    send(ws, {
      type: 'image_upload',
      base64: largeBase64,
      mimeType: 'image/png',
      fileName: 'huge.png'
    });

    const error = await waitForMessage(ws, 'image_upload_error');
    assert(error.message.toLowerCase().includes('size') || error.message.toLowerCase().includes('large'),
      'Expected size-related error: ' + error.message);

    ws.close();
  });

  it('should reject unsupported MIME types', async function () {
    this.timeout(15000);
    const ws = await connectWs(port);
    await waitForMessage(ws, 'connected');

    send(ws, { type: 'create_session', name: 'img-test-mime' });
    await waitForMessage(ws, 'session_created');

    send(ws, {
      type: 'image_upload',
      base64: 'dGVzdA==',
      mimeType: 'application/pdf',
      fileName: 'doc.pdf'
    });

    const error = await waitForMessage(ws, 'image_upload_error');
    assert(error.message.toLowerCase().includes('unsupported') || error.message.toLowerCase().includes('mime'),
      'Expected MIME type error: ' + error.message);

    ws.close();
  });

  it('should reject SVG uploads', async function () {
    this.timeout(15000);
    const ws = await connectWs(port);
    await waitForMessage(ws, 'connected');

    send(ws, { type: 'create_session', name: 'img-test-svg' });
    await waitForMessage(ws, 'session_created');

    send(ws, {
      type: 'image_upload',
      base64: Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64'),
      mimeType: 'image/svg+xml',
      fileName: 'evil.svg'
    });

    const error = await waitForMessage(ws, 'image_upload_error');
    assert(error.message, 'Expected error for SVG');

    ws.close();
  });

  it('should reject upload without active session', async function () {
    this.timeout(15000);
    const ws = await connectWs(port);
    await waitForMessage(ws, 'connected');
    // Don't create/join a session

    send(ws, {
      type: 'image_upload',
      base64: TINY_PNG_BASE64,
      mimeType: 'image/png',
      fileName: 'test.png'
    });

    const error = await waitForMessage(ws, 'image_upload_error');
    assert(error.message.toLowerCase().includes('session'),
      'Expected session error: ' + error.message);

    ws.close();
  });

  it('should clean up temp files when session is deleted', async function () {
    this.timeout(15000);
    const ws = await connectWs(port);
    await waitForMessage(ws, 'connected');

    send(ws, { type: 'create_session', name: 'img-cleanup-test' });
    const created = await waitForMessage(ws, 'session_created');
    const sessionId = created.sessionId;

    // Upload an image
    send(ws, {
      type: 'image_upload',
      base64: TINY_PNG_BASE64,
      mimeType: 'image/png',
      fileName: 'cleanup.png'
    });

    const response = await waitForMessage(ws, 'image_upload_complete');
    const filePath = response.filePath;
    assert(fs.existsSync(filePath), 'File should exist after upload');

    ws.close();

    // Delete session via REST
    const deleteRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
      method: 'DELETE'
    });
    assert.strictEqual(deleteRes.status, 200);

    // File should be cleaned up
    assert(!fs.existsSync(filePath), 'File should be deleted after session delete');
  });

  it('should create .gitignore in temp directory', async function () {
    this.timeout(15000);
    const ws = await connectWs(port);
    await waitForMessage(ws, 'connected');

    send(ws, { type: 'create_session', name: 'img-gitignore-test' });
    await waitForMessage(ws, 'session_created');

    send(ws, {
      type: 'image_upload',
      base64: TINY_PNG_BASE64,
      mimeType: 'image/png',
      fileName: 'test.png'
    });

    const response = await waitForMessage(ws, 'image_upload_complete');

    // Check .gitignore exists in the image directory
    const imageDir = path.dirname(response.filePath);
    const gitignorePath = path.join(imageDir, '.gitignore');
    assert(fs.existsSync(gitignorePath), '.gitignore should exist in image directory');

    const content = fs.readFileSync(gitignorePath, 'utf8');
    assert(content.includes('*'), '.gitignore should contain *');

    ws.close();
  });

  it('should enforce rate limiting', async function () {
    this.timeout(30000);
    const ws = await connectWs(port);
    await waitForMessage(ws, 'connected');

    send(ws, { type: 'create_session', name: 'img-rate-test' });
    await waitForMessage(ws, 'session_created');

    // Upload 5 images quickly (should all succeed)
    for (let i = 0; i < 5; i++) {
      send(ws, {
        type: 'image_upload',
        base64: TINY_PNG_BASE64,
        mimeType: 'image/png',
        fileName: `rate-${i}.png`
      });
      await waitForMessage(ws, 'image_upload_complete');
    }

    // 6th should be rate limited
    send(ws, {
      type: 'image_upload',
      base64: TINY_PNG_BASE64,
      mimeType: 'image/png',
      fileName: 'rate-5.png'
    });

    const error = await waitForMessage(ws, 'image_upload_error');
    assert(error.message.toLowerCase().includes('rate') || error.message.toLowerCase().includes('limit'),
      'Expected rate limit error: ' + error.message);

    ws.close();
  });

  it('should map MIME types to correct extensions', async function () {
    this.timeout(20000);
    const ws = await connectWs(port);
    await waitForMessage(ws, 'connected');

    send(ws, { type: 'create_session', name: 'img-ext-test' });
    await waitForMessage(ws, 'session_created');

    // Test JPEG extension
    send(ws, {
      type: 'image_upload',
      base64: TINY_PNG_BASE64, // content doesn't matter for extension test
      mimeType: 'image/jpeg',
      fileName: 'photo.jpeg'
    });

    const jpegResponse = await waitForMessage(ws, 'image_upload_complete');
    assert(jpegResponse.filePath.endsWith('.jpg'), 'JPEG should use .jpg extension, got: ' + jpegResponse.filePath);

    ws.close();
  });
});
