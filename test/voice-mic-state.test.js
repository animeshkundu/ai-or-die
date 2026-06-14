// test/voice-mic-state.test.js
//
// Unit tests for VoiceHandler.computeMicButtonState — the pure decision that
// drives the mic button's visible/enabled/mode/title from the STT backend
// status. Local-first with "disabled unless ready": the model is pulled on
// startup and the mic stays DISABLED until the local model is `ready`.

'use strict';

const assert = require('assert');
const VH = require('../src/public/voice-handler');
const state = VH.computeMicButtonState;

describe('computeMicButtonState (mic availability gating)', function () {
  it('local ready → enabled, local mode', function () {
    const s = state({ localStatus: 'ready', localEnabled: true, cloudAvailable: true });
    assert.deepStrictEqual(
      { visible: s.visible, enabled: s.enabled, mode: s.mode },
      { visible: true, enabled: true, mode: 'local' }
    );
  });

  it('local downloading → visible but DISABLED with a downloading hint (no cloud fallback)', function () {
    const s = state({ localStatus: 'downloading', localEnabled: true, cloudAvailable: true });
    assert.strictEqual(s.visible, true);
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.mode, null);
    assert.match(s.title, /downloading/i);
  });

  it('local loading → visible but DISABLED with a loading hint', function () {
    const s = state({ localStatus: 'loading', localEnabled: true, cloudAvailable: true });
    assert.strictEqual(s.enabled, false);
    assert.match(s.title, /loading/i);
  });

  it('local enabled but unavailable (failed) → DISABLED, does not fall back to cloud', function () {
    const s = state({ localStatus: 'unavailable', localEnabled: true, cloudAvailable: true });
    assert.strictEqual(s.visible, true);
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.mode, null);
    assert.match(s.title, /unavailable/i);
  });

  it('local NOT the backend + cloud available → enabled, cloud mode', function () {
    const s = state({ localStatus: 'unavailable', localEnabled: false, cloudAvailable: true });
    assert.deepStrictEqual(
      { visible: s.visible, enabled: s.enabled, mode: s.mode },
      { visible: true, enabled: true, mode: 'cloud' }
    );
  });

  it('no local backend and no cloud → hidden', function () {
    const s = state({ localStatus: 'unavailable', localEnabled: false, cloudAvailable: false });
    assert.strictEqual(s.visible, false);
    assert.strictEqual(s.enabled, false);
  });

  it('explicit cloud preference wins even when local is ready', function () {
    const s = state({ localStatus: 'ready', localEnabled: true, cloudAvailable: true, voiceMethod: 'cloud' });
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.mode, 'cloud');
  });

  it('explicit cloud preference but no cloud → falls back to local-first (ready→local)', function () {
    const s = state({ localStatus: 'ready', localEnabled: true, cloudAvailable: false, voiceMethod: 'cloud' });
    assert.strictEqual(s.mode, 'local');
    assert.strictEqual(s.enabled, true);
  });

  it('explicit local preference + local not the backend → does NOT use cloud (hidden)', function () {
    const s = state({ localStatus: 'unavailable', localEnabled: false, cloudAvailable: true, voiceMethod: 'local' });
    assert.strictEqual(s.visible, false);
  });

  it('insecure context → visible, disabled, HTTPS hint, regardless of backend', function () {
    const s = state({ secureContext: false, localStatus: 'ready', localEnabled: true, cloudAvailable: true });
    assert.strictEqual(s.visible, true);
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.mode, null);
    assert.match(s.title, /HTTPS/i);
  });

  it('defaults: secureContext defaults true; missing opts → hidden (no backend)', function () {
    const s = state({});
    assert.strictEqual(s.visible, false);
  });
});
