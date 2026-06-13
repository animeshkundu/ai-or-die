'use strict';

const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { ClaudeCodeWebServer } = require('../src/server');

// ---------------------------------------------------------------------------
// Helpers (reuse patterns from e2e.test.js)
// ---------------------------------------------------------------------------

function waitForMessage(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for message type "${type}" after ${timeoutMs}ms`));
    }, timeoutMs);

    function onMessage(raw, isBinary) {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        cleanup();
        resolve(msg);
      }
    }

    function onClose() {
      cleanup();
      reject(new Error(`WebSocket closed while waiting for "${type}"`));
    }

    function cleanup() {
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      ws.removeListener('close', onClose);
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

function wsSend(ws, data) {
  ws.send(JSON.stringify(data));
}

function connectWs(port, token, sessionId) {
  return new Promise((resolve, reject) => {
    let url = `ws://127.0.0.1:${port}/`;
    const params = [];
    if (token) params.push(`token=${encodeURIComponent(token)}`);
    if (sessionId) params.push(`sessionId=${encodeURIComponent(sessionId)}`);
    if (params.length) url += '?' + params.join('&');

    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket connection timed out'));
    }, 5000);

    ws.on('open', () => {
      ws.once('message', (raw) => {
        clearTimeout(timer);
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'connected') {
          resolve({ ws, connectionId: msg.connectionId });
        } else {
          reject(new Error(`Expected 'connected', got '${msg.type}'`));
        }
      });
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function closeWs(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      return resolve();
    }
    ws.on('close', () => resolve());
    ws.close();
    setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      resolve();
    }, 2000);
  });
}

/**
 * Create a minimal base64-encoded Int16 PCM audio buffer.
 * @param {number} durationSec - Duration in seconds
 * @param {number} [sampleRate=16000] - Sample rate
 * @returns {string} base64-encoded buffer
 */
function createTestAudio(durationSec, sampleRate = 16000) {
  const numSamples = Math.floor(durationSec * sampleRate);
  const buf = Buffer.alloc(numSamples * 2); // Int16 = 2 bytes per sample
  // Fill with a simple sine wave to simulate real audio
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 16000);
    buf.writeInt16LE(sample, i * 2);
  }
  return buf.toString('base64');
}

// ---------------------------------------------------------------------------
// Integration: voice WebSocket protocol
// ---------------------------------------------------------------------------

describe('voice-integration: WebSocket voice protocol', function () {
  this.timeout(30000);

  let server;
  let port;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    server.close();
  });

  it('voice_upload without active session returns error', async function () {
    const { ws } = await connectWs(port);

    // Create and join a session, but do NOT start a terminal
    wsSend(ws, { type: 'create_session', name: 'Voice No Agent' });
    await waitForMessage(ws, 'session_created');

    wsSend(ws, {
      type: 'voice_upload',
      audio: createTestAudio(1)
    });

    const err = await waitForMessage(ws, 'voice_transcription_error');
    assert(
      err.message.includes('No agent') || err.message.includes('not ready'),
      `Expected agent/ready error, got: ${err.message}`
    );

    await closeWs(ws);
  });

  it('voice_upload without joined session returns error', async function () {
    const { ws } = await connectWs(port);

    // Don't join any session
    wsSend(ws, {
      type: 'voice_upload',
      audio: createTestAudio(1)
    });

    const err = await waitForMessage(ws, 'voice_transcription_error');
    assert(err.message.includes('No session'), `Expected session error, got: ${err.message}`);

    await closeWs(ws);
  });

  it('voice_upload with oversized buffer returns error', async function () {
    const { ws } = await connectWs(port);

    wsSend(ws, { type: 'create_session', name: 'Voice Oversized' });
    await waitForMessage(ws, 'session_created');

    // Start terminal so agent is active
    wsSend(ws, { type: 'start_terminal' });
    await waitForMessage(ws, 'terminal_started', 15000);

    // Create oversized audio (>3,840,000 bytes = >120s at 16kHz 16-bit mono).
    // Once base64-encoded and JSON-wrapped, the frame is ~5 MB — well over
    // the 1 MB MAX_WS_MESSAGE_BYTES guard introduced in HOT-08 (see
    // docs/audits/hot-03-ws-frame-size.md). Pre-HOT-08, the voice handler
    // rejected with `voice_transcription_error` once it parsed the frame.
    // Post-HOT-08, the WS guard rejects the entire frame BEFORE the
    // handler runs and the connection closes with WS-standard 1009
    // ("message too big"). Accept either outcome.
    const oversizedSamples = 120 * 16000 + 1; // just over limit
    const oversizedBuf = Buffer.alloc(oversizedSamples * 2);
    const oversizedAudio = oversizedBuf.toString('base64');

    // Race the three possible terminal signals before sending:
    const terminalSignal = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No terminal signal within 8s')), 8000);
      function onMessage(raw, isBinary) {
        if (isBinary) return;
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
        if (msg.type === 'error' && msg.code === 'message_too_large') {
          cleanup(); resolve({ kind: 'guard_error', msg });
        } else if (msg.type === 'voice_transcription_error') {
          cleanup(); resolve({ kind: 'handler_error', msg });
        }
      }
      function onClose(code) {
        cleanup(); resolve({ kind: 'close', code });
      }
      function cleanup() {
        clearTimeout(timeout);
        ws.removeListener('message', onMessage);
        ws.removeListener('close', onClose);
      }
      ws.on('message', onMessage);
      ws.on('close', onClose);
    });

    wsSend(ws, {
      type: 'voice_upload',
      audio: oversizedAudio
    });

    const outcome = await terminalSignal;

    if (outcome.kind === 'guard_error') {
      assert.strictEqual(outcome.msg.code, 'message_too_large',
        `Expected HOT-08 message_too_large code; got ${JSON.stringify(outcome.msg)}`);
    } else if (outcome.kind === 'handler_error') {
      // Pre-HOT-08 path — preserved for back-compat if HOT-08 is reverted.
      assert(
        outcome.msg.message.includes('too long') || outcome.msg.message.includes('not ready'),
        `Expected size error, got: ${outcome.msg.message}`
      );
    } else {
      assert.strictEqual(outcome.code, 1009,
        `Expected WS-standard 1009 close ("message too big"); got ${outcome.code}`);
    }

    // Connection may already be closed by HOT-08's 1009 — stop is best-effort.
    if (ws.readyState === WebSocket.OPEN) {
      wsSend(ws, { type: 'stop' });
      await waitForMessage(ws, 'terminal_stopped', 5000).catch(() => {});
    }
    await closeWs(ws);
  });

  it('voice_upload rate limiting works (11th request rejected)', async function () {
    const { ws } = await connectWs(port);

    wsSend(ws, { type: 'create_session', name: 'Voice Rate Limit' });
    await waitForMessage(ws, 'session_created');

    wsSend(ws, { type: 'start_terminal' });
    await waitForMessage(ws, 'terminal_started', 15000);

    // Send 10 voice uploads with small delays to ensure server processes each
    // (they will all get errors since STT is not ready, but they count toward rate limit)
    for (let i = 0; i < 10; i++) {
      wsSend(ws, {
        type: 'voice_upload',
        audio: createTestAudio(0.5)
      });
      // Small delay between sends to avoid overwhelming the server
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Wait for all 10 to be processed server-side
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 11th should hit rate limit
    wsSend(ws, {
      type: 'voice_upload',
      audio: createTestAudio(0.5)
    });

    // Collect errors — look for the rate limit one
    const errors = [];
    const collectTimer = setTimeout(() => {}, 3000);

    await new Promise((resolve) => {
      let found = false;
      const onMsg = (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'voice_transcription_error') {
            errors.push(msg);
            if (msg.message.includes('Rate limit')) {
              found = true;
              ws.removeListener('message', onMsg);
              resolve();
            }
          }
        } catch { /* binary frame */ }
      };
      ws.on('message', onMsg);
      setTimeout(() => {
        ws.removeListener('message', onMsg);
        resolve();
      }, 3000);
    });
    clearTimeout(collectTimer);

    const rateLimitErrors = errors.filter(e => e.message.includes('Rate limit'));
    assert(rateLimitErrors.length >= 1, `Expected at least one rate limit error, got ${errors.length} total errors`);

    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'terminal_stopped', 10000).catch(() => {});
    await closeWs(ws);
  });

  it('voice_status returns current engine status', async function () {
    const { ws } = await connectWs(port);

    wsSend(ws, { type: 'create_session', name: 'Voice Status' });
    await waitForMessage(ws, 'session_created');

    wsSend(ws, { type: 'voice_status' });
    const status = await waitForMessage(ws, 'voice_status');

    assert(typeof status.status === 'string', 'Expected status string');
    // Without --stt flag, status should be 'unavailable'
    assert.strictEqual(status.status, 'unavailable');
    // The reply carries the voiceInput gate fields the client needs.
    assert(status.voiceInput, 'Expected voiceInput in voice_status reply');
    assert.strictEqual(typeof status.voiceInput.localEnabled, 'boolean');
    assert.strictEqual(status.voiceInput.localStatus, 'unavailable');

    await closeWs(ws);
  });

  it('voice_download_model triggers download attempt', async function () {
    const { ws } = await connectWs(port);

    wsSend(ws, { type: 'create_session', name: 'Voice Download' });
    await waitForMessage(ws, 'session_created');

    wsSend(ws, { type: 'voice_download_model' });

    // Should get a voice_status back (either downloading or error)
    const status = await waitForMessage(ws, 'voice_status');
    assert(typeof status.status === 'string');

    await closeWs(ws);
  });

  it('voice_upload with missing audio data returns error', async function () {
    const { ws } = await connectWs(port);

    wsSend(ws, { type: 'create_session', name: 'Voice Missing Audio' });
    await waitForMessage(ws, 'session_created');

    wsSend(ws, { type: 'start_terminal' });
    await waitForMessage(ws, 'terminal_started', 15000);

    // Send without audio field
    wsSend(ws, { type: 'voice_upload' });

    const err = await waitForMessage(ws, 'voice_transcription_error');
    assert(
      err.message.includes('Missing audio') || err.message.includes('not ready'),
      `Expected missing audio error, got: ${err.message}`
    );

    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'terminal_stopped', 10000).catch(() => {});
    await closeWs(ws);
  });

  it('voice_upload with too-short audio returns error', async function () {
    const { ws } = await connectWs(port);

    wsSend(ws, { type: 'create_session', name: 'Voice Short Audio' });
    await waitForMessage(ws, 'session_created');

    wsSend(ws, { type: 'start_terminal' });
    await waitForMessage(ws, 'terminal_started', 15000);

    // Send 1 byte of audio (below minimum of 2 bytes)
    wsSend(ws, {
      type: 'voice_upload',
      audio: Buffer.alloc(1).toString('base64')
    });

    const err = await waitForMessage(ws, 'voice_transcription_error');
    assert(
      err.message.includes('too short') || err.message.includes('not ready'),
      `Expected too-short error, got: ${err.message}`
    );

    wsSend(ws, { type: 'stop' });
    await waitForMessage(ws, 'terminal_stopped', 10000).catch(() => {});
    await closeWs(ws);
  });
});


describe('voice-integration: config endpoint voice fields', function () {
  this.timeout(15000);

  let server;
  let port;

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    server.close();
  });

  it('GET /api/config includes voiceInput with expected shape', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/config`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        });
      }).on('error', reject);
    });

    assert.strictEqual(res.statusCode, 200);
    assert(res.body.voiceInput, 'Expected voiceInput in config');
    assert(typeof res.body.voiceInput.localStatus === 'string');
    assert.strictEqual(typeof res.body.voiceInput.cloudAvailable, 'boolean');
    assert.strictEqual(res.body.voiceInput.cloudAvailable, true);
    // localEnabled tells the client whether the server is pulling/serving a
    // local model (mic stays disabled until ready) vs. STT being off entirely
    // (cloud fallback). Must always be present so the client can gate the mic.
    assert.strictEqual(typeof res.body.voiceInput.localEnabled, 'boolean');
  });
});
