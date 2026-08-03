// test/voice-eager-init.test.js
//
// Unit tests for download-only startup preparation of STT/sticky models on the
// server (_ensureSttModel, _broadcastVoiceStatus, _ensureStickyNoteEngine). These
// replaced the lazy/deferred init (whose "eager load hung the terminal" premise
// was disproven — the hang was a Bun/node-pty bug). Both load in worker threads,
// so pulling on startup never blocks the event loop; the client gates the feature
// on readiness.

'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');

function makeServer() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-eager-')));
  const server = new ClaudeCodeWebServer({
    port: 0,
    noAuth: true,
    stt: false,
    stickyNotes: false,
    sessionStoreOptions: { storageDir: path.join(tmp, '.sessions') },
  });
  return { server, tmp };
}
function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

describe('server lazy model preparation', function () {
  it('_ensureSttModel starts download preparation once without demanding a host', function () {
    const { server, tmp } = makeServer();
    try {
      let calls = 0;
      server.sttEngine = {
        _enabled: true, _sttEndpoint: null,
        getStatus: () => 'ready',
        getDownloadProgress: () => null,
        ensureDownloaded: () => { calls++; return Promise.resolve(); },
      };
      server.broadcastAll = () => {};
      server._sttPrepStarted = false;

      server._ensureSttModel();
      assert.strictEqual(calls, 1, 'initialize called when unavailable');

      server._ensureSttModel();
      assert.strictEqual(calls, 1, 'preparation is deduplicated');
    } finally {
      cleanup(tmp);
    }
  });

  it('_broadcastVoiceStatus broadcasts localStatus + localEnabled', function () {
    const { server, tmp } = makeServer();
    try {
      server.sttEngine = {
        _enabled: true, _sttEndpoint: null,
        getStatus: () => 'loading',
        getDownloadProgress: () => null,
      };
      let sent = null;
      server.broadcastAll = (m) => { sent = m; };

      server._broadcastVoiceStatus();
      assert.ok(sent, 'broadcast sent');
      assert.strictEqual(sent.type, 'voice_status');
      assert.strictEqual(sent.status, 'loading');
      assert.strictEqual(sent.voiceInput.localStatus, 'loading');
      assert.strictEqual(sent.voiceInput.localEnabled, true);
    } finally {
      cleanup(tmp);
    }
  });

  it('localEnabled is false for an external STT endpoint (no local model)', function () {
    const { server, tmp } = makeServer();
    try {
      server.sttEngine = {
        _enabled: true, _sttEndpoint: 'https://example/stt',
        getStatus: () => 'ready',
        getDownloadProgress: () => null,
      };
      let sent = null;
      server.broadcastAll = (m) => { sent = m; };
      server._broadcastVoiceStatus();
      assert.strictEqual(sent.voiceInput.localEnabled, false, 'endpoint → no local model to gate on');
    } finally {
      cleanup(tmp);
    }
  });

  it('voice warm requires an active joined session and shares its rate limit across sockets', async function () {
    const { server, tmp } = makeServer();
    try {
      let warms = 0;
      server.sttEngine = {
        _enabled: true,
        _sttEndpoint: null,
        warm: async () => { warms++; },
      };
      server.claudeSessions.set('session-1', { active: true, agent: 'terminal' });
      server.webSocketConnections.set('ws-1', { claudeSessionId: 'session-1' });
      server.webSocketConnections.set('ws-2', { claudeSessionId: 'session-1' });
      for (let i = 0; i < 4; i++) await server._handleVoiceWarm('ws-1');
      await server._handleVoiceWarm('ws-2');
      assert.strictEqual(warms, 4, 'a second socket cannot reset the session warm budget');
      server.webSocketConnections.set('lobby', { claudeSessionId: null });
      await server._handleVoiceWarm('lobby');
      assert.strictEqual(warms, 4, 'a lobby socket cannot load the local model');
    } finally {
      cleanup(tmp);
    }
  });

  it('_ensureStickyNoteEngine triggers engine init once (deduped)', function () {
    const { server, tmp } = makeServer();
    try {
      let calls = 0;
      server.stickyNoteEngine = {
        _enabled: true,
        getStatus: () => 'loading',
        getDownloadProgress: () => null,
        ensureDownloaded: () => { calls++; return Promise.resolve(); },
      };
      server.broadcastToAll = () => {};
      server._stickyInitStarted = false;

      server._ensureStickyNoteEngine();
      server._ensureStickyNoteEngine();
      assert.strictEqual(calls, 1, 'sticky init deduped via _stickyInitStarted');
    } finally {
      cleanup(tmp);
    }
  });

  it('_ensureStickyNoteEngine is a no-op when the engine is disabled (default/Bun/test)', function () {
    const { server, tmp } = makeServer();
    try {
      let calls = 0;
      server.stickyNoteEngine = {
        _enabled: false,
        getStatus: () => 'unavailable',
        getDownloadProgress: () => null,
        initialize: () => { calls++; return Promise.resolve(); },
      };
      server._stickyInitStarted = false;
      server._ensureStickyNoteEngine();
      assert.strictEqual(calls, 0, 'disabled engine never initializes');
    } finally {
      cleanup(tmp);
    }
  });
});
