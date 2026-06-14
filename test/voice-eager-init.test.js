// test/voice-eager-init.test.js
//
// Unit tests for the eager, pull-on-startup STT/sticky model init helpers on the
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

describe('server eager model init', function () {
  it('_ensureSttModel calls initialize when not ready, no-ops while in-flight/ready', function () {
    const { server, tmp } = makeServer();
    try {
      let calls = 0;
      let status = 'unavailable';
      server.sttEngine = {
        _enabled: true, _sttEndpoint: null,
        getStatus: () => status,
        getDownloadProgress: () => null,
        initialize: () => { calls++; status = 'downloading'; return Promise.resolve(); },
      };
      server.broadcastAll = () => {};

      server._ensureSttModel();
      assert.strictEqual(calls, 1, 'initialize called when unavailable');

      server._ensureSttModel(); // status is now 'downloading'
      assert.strictEqual(calls, 1, 'no-op while downloading');

      status = 'loading';
      server._ensureSttModel();
      assert.strictEqual(calls, 1, 'no-op while loading');

      status = 'ready';
      server._ensureSttModel();
      assert.strictEqual(calls, 1, 'no-op when ready');
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

  it('_ensureStickyNoteEngine triggers engine init once (deduped)', function () {
    const { server, tmp } = makeServer();
    try {
      let calls = 0;
      server.stickyNoteEngine = {
        _enabled: true,
        getStatus: () => 'loading',
        getDownloadProgress: () => null,
        initialize: () => { calls++; return Promise.resolve(); },
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

  it('_ensureStickyNoteEngine is a no-op when the engine is disabled (Bun/test/--no-sticky-notes)', function () {
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
