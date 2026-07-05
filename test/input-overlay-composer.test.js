'use strict';

// test/input-overlay-composer.test.js — the InputOverlay IS the native composer
// (multi-line textarea, STT target, bracketed-paste delivery). These tests lock
// the iOS hardening (autocorrect/IME off), the voice→overlay routing, and the
// multi-line send path. Skips when jsdom is unavailable.

const path = require('path');
const fs = require('fs');
const assert = require('assert');

let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (_) { /* skip below */ }

const OVERLAY_SRC = path.join(__dirname, '..', 'src', 'public', 'input-overlay.js');
const INDEX_HTML = path.join(__dirname, '..', 'src', 'public', 'index.html');

describe('input-overlay composer: iOS textarea attributes (static)', function () {
  it('the composer textarea disables autocorrect/autocapitalize/spellcheck', function () {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    // Grab the <textarea id="inputOverlayText" ...> opening tag.
    const m = html.match(/<textarea[^>]*id="inputOverlayText"[\s\S]*?>/);
    assert.ok(m, 'inputOverlayText textarea should exist');
    const tag = m[0];
    assert.ok(/autocorrect="off"/.test(tag), 'autocorrect must be off (iOS mangles terminal input)');
    assert.ok(/autocapitalize="none"/.test(tag), 'autocapitalize must be none');
    assert.ok(/spellcheck="false"/.test(tag), 'spellcheck must be false');
    assert.ok(/autocomplete="off"/.test(tag), 'autocomplete must be off');
  });
});

(JSDOM ? describe : describe.skip)('input-overlay composer behavior (JSDOM)', function () {
  this.timeout(15000);

  let window, document, InputOverlay, app, sent;

  const OVERLAY_DOM = `
    <div class="input-overlay-backdrop" id="inputOverlayBackdrop" style="display:none;"></div>
    <div id="inputOverlay" class="input-overlay" style="display:none;">
      <textarea id="inputOverlayText"
        autocorrect="off" autocapitalize="none" autocomplete="off" spellcheck="false"></textarea>
      <span id="inputCharCount">0</span>
      <button class="input-overlay-voice" id="inputOverlayVoice"></button>
      <button class="input-overlay-cancel">Cancel</button>
      <button class="input-overlay-insert">Insert</button>
      <button class="input-overlay-send">Send</button>
    </div>
    <button id="inputOverlayBtn"></button>
    <button id="voiceInputBtn"></button>`;

  beforeEach(function () {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${OVERLAY_DOM}</body></html>`, {
      url: 'http://localhost/',
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    window = dom.window;
    document = window.document;
    global.window = window;
    global.document = document;
    window.WebSocket = { OPEN: 1 };
    window.eval(fs.readFileSync(OVERLAY_SRC, 'utf8'));
    InputOverlay = window.InputOverlay;

    sent = [];
    app = {
      _voiceTarget: 'terminal',
      terminal: { focus() {}, modes: { bracketedPasteMode: true } },
      socket: { readyState: 1 },
      send: (msg) => sent.push(msg),
    };
  });

  afterEach(function () {
    delete global.window;
    delete global.document;
  });

  it('routes voice to the overlay while open, restores terminal on close', function () {
    const ov = new InputOverlay(app);
    ov.show();
    assert.strictEqual(app._voiceTarget, 'overlay', 'voice dictation targets the composer when open');
    ov.hide();
    assert.strictEqual(app._voiceTarget, 'terminal');
  });

  it('sends multi-line text bracketed-paste wrapped + Enter in Send mode', function () {
    const ov = new InputOverlay(app);
    ov.show();
    ov._textarea.value = 'line one\nline two';
    ov._deliverText('send');
    assert.strictEqual(sent.length, 1);
    const data = sent[0].data;
    assert.ok(data.startsWith('\x1b[200~'), 'wrapped with bracketed-paste start');
    assert.ok(data.endsWith('\x1b[201~\r'), 'ends with bracketed-paste end + CR');
    assert.ok(data.includes('line one\rline two'), 'newlines normalized to CR inside the paste');
  });

  it('does not send when disconnected', function () {
    app.socket.readyState = 0; // not OPEN
    const ov = new InputOverlay(app);
    ov.show();
    ov._textarea.value = 'hello';
    ov._deliverText('send');
    assert.strictEqual(sent.length, 0, 'no frame sent while disconnected');
  });
});
