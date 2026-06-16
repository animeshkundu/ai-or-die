'use strict';

// Integration tests for the binary voice-frame path (client mic -> server STT).
// The success-path cases need a "ready" STT engine, but STT is force-disabled
// under test (server.js underTest), so we swap server.sttEngine for a ready stub
// after start() — the injection seam. Close-code cases (1009/1003) fire in the
// ws dispatcher BEFORE any session/STT logic, so they need neither.

const assert = require('assert');
const WebSocket = require('ws');
const { ClaudeCodeWebServer } = require('../src/server');
const {
  MAX_VOICE_BINARY_FRAME_BYTES,
} = require('../src/utils/ws-voice-frame');

const VOICE_HEADER = Buffer.from([0x56, 0x55, 0x50, 0x31, 0x01, 0x01]); // "VUP1" v1 type1

function buildFrame(pcm) {
  return Buffer.concat([VOICE_HEADER, pcm]);
}

function wsSend(ws, data) {
  ws.send(JSON.stringify(data));
}

function connectWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('connect timeout')); }, 5000);
    ws.on('open', () => {
      ws.once('message', (raw) => {
        clearTimeout(timer);
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'connected') resolve(ws);
        else reject(new Error(`expected connected, got ${msg.type}`));
      });
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitForMessage(ws, type, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${type}`)); }, timeoutMs);
    function onMessage(raw, isBinary) {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.type === type) { cleanup(); resolve(msg); }
    }
    function onClose() { cleanup(); reject(new Error(`closed while waiting for ${type}`)); }
    function cleanup() {
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      ws.removeListener('close', onClose);
    }
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

// Resolve with the WS close code; register the listener BEFORE sending so the
// close can never be missed (avoids the close-vs-message ordering race).
function expectClose(ws, frame, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no close within timeout')), timeoutMs);
    ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
    ws.send(frame);
  });
}

async function setupActiveSession(ws) {
  wsSend(ws, { type: 'create_session', name: 'Voice Binary' });
  await waitForMessage(ws, 'session_created');
  wsSend(ws, { type: 'start_terminal' });
  await waitForMessage(ws, 'terminal_started', 15000);
}

function closeWs(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', () => resolve());
    try { ws.close(); } catch (_) {}
    setTimeout(() => { try { ws.terminate(); } catch (_) {} resolve(); }, 2000);
  });
}

describe('voice-binary: inbound binary voice frame', function () {
  this.timeout(30000);

  let server;
  let port;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
    // Injection seam: a ready STT stub so the success paths are reachable.
    server.sttEngine = {
      isReady: () => true,
      getStatus: () => 'ready',
      transcribePcm16: async () => 'ok-binary',
      transcribe: async () => 'ok-binary',
    };
  });

  after(function () {
    server.close();
  });

  it('transcribes a ~30 s binary frame and keeps the socket open (the case that crashed)', async function () {
    const ws = await connectWs(port);
    await setupActiveSession(ws);

    const pcm = Buffer.alloc(30 * 16000 * 2); // 30 s @ 16 kHz / 16-bit = 960,000 bytes
    ws.send(buildFrame(pcm));

    const msg = await waitForMessage(ws, 'voice_transcription');
    assert.strictEqual(msg.text, 'ok-binary');
    assert.strictEqual(ws.readyState, WebSocket.OPEN, 'socket must stay open');

    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'terminal_stopped', 10000).catch(() => {});
    await closeWs(ws);
  });

  it('closes 1009 on an over-size binary frame', async function () {
    const ws = await connectWs(port);
    const frame = Buffer.alloc(MAX_VOICE_BINARY_FRAME_BYTES + 1);
    VOICE_HEADER.copy(frame, 0);
    const code = await expectClose(ws, frame);
    assert.strictEqual(code, 1009);
    await closeWs(ws);
  });

  it('closes 1003 on a bad-magic binary frame', async function () {
    const ws = await connectWs(port);
    const frame = Buffer.concat([Buffer.from([0x58, 0x58, 0x58, 0x58, 1, 1]), Buffer.from([0, 0])]);
    const code = await expectClose(ws, frame);
    assert.strictEqual(code, 1003);
    await closeWs(ws);
  });

  it('closes 1003 on a too-short binary frame (< 6 bytes)', async function () {
    const ws = await connectWs(port);
    const code = await expectClose(ws, Buffer.from([0x56, 0x55, 0x50, 0x31]));
    assert.strictEqual(code, 1003);
    await closeWs(ws);
  });

  it('returns "too short" (socket open) for a valid header with zero PCM', async function () {
    const ws = await connectWs(port);
    await setupActiveSession(ws);

    ws.send(buildFrame(Buffer.alloc(0)));

    const err = await waitForMessage(ws, 'voice_transcription_error');
    assert.ok(/too short/i.test(err.message), `got: ${err.message}`);
    assert.strictEqual(ws.readyState, WebSocket.OPEN);

    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'terminal_stopped', 10000).catch(() => {});
    await closeWs(ws);
  });

  it('returns "invalid" (socket open) for odd-length PCM', async function () {
    const ws = await connectWs(port);
    await setupActiveSession(ws);

    ws.send(buildFrame(Buffer.from([1, 2, 3]))); // 3 bytes = odd

    const err = await waitForMessage(ws, 'voice_transcription_error');
    assert.ok(/even|invalid/i.test(err.message), `got: ${err.message}`);
    assert.strictEqual(ws.readyState, WebSocket.OPEN);

    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'terminal_stopped', 10000).catch(() => {});
    await closeWs(ws);
  });

  it('rate-limits the binary path (11th upload errors on an OPEN socket)', async function () {
    const ws = await connectWs(port);
    await setupActiveSession(ws);

    const pcm = Buffer.alloc(0.5 * 16000 * 2); // 0.5 s
    let rateLimited = false;
    const onMsg = (raw, isBinary) => {
      if (isBinary) return;
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'voice_transcription_error' && /Rate limit/i.test(m.message)) rateLimited = true;
      } catch (_) { /* ignore */ }
    };
    ws.on('message', onMsg);

    for (let i = 0; i < 11; i++) {
      ws.send(buildFrame(pcm));
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 1500));
    ws.removeListener('message', onMsg);

    assert.ok(rateLimited, 'expected a Rate limit error on the 11th binary upload');
    assert.strictEqual(ws.readyState, WebSocket.OPEN, 'rate limit must not close the socket');

    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'terminal_stopped', 10000).catch(() => {});
    await closeWs(ws);
  });
});
