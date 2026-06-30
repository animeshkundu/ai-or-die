'use strict';

// jsdom unit test for the in-iframe annotation SDK (src/artifact-sdk-client.js).
// The SDK is an IIFE served at /sdk.js that turns a click / text-selection into a
// structured annotation and posts it to the parent (the panel) via postMessage.
// We load it into a jsdom window, simulate a click + Queue, and assert the
// structured annotation shape on the captured postMessage. Skips when jsdom is
// not installed.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let JSDOM = null;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (_) {
  /* skip below */
}

const SDK_SRC = path.join(__dirname, '..', 'src', 'artifact-sdk-client.js');

describe('artifact-sdk-client.js (annotation payload shape)', function () {
  if (!JSDOM) {
    it('skipped — jsdom not installed', function () { this.skip(); });
    return;
  }

  let dom;
  let win;
  let posted;

  beforeEach(function () {
    dom = new JSDOM(
      '<!DOCTYPE html><html><head>' +
      '<script>window.__AI_OR_DIE_ARTIFACT_REVIEW__={sessionId:"sid-9",key:"k9"};</script>' +
      '</head><body>' +
      '<main><p id="para" data-source-line="7">The footer is misaligned and too wide for the column.</p></main>' +
      '</body></html>',
      { url: 'http://localhost', runScripts: 'dangerously', pretendToBeVisual: true }
    );
    win = dom.window;

    // Capture messages the SDK posts to the parent. In jsdom, parent === window
    // for a top-level document, so intercept window.postMessage.
    posted = [];
    const origPost = win.postMessage.bind(win);
    win.postMessage = function (message, targetOrigin) {
      posted.push(message);
      // Don't actually dispatch a MessageEvent — we only need the payload.
      return undefined;
    };
    void origPost;

    // getBoundingClientRect / getClientRects are stubbed by jsdom to zeros,
    // which is fine — the card still positions and the payload is unaffected.

    const code = fs.readFileSync(SDK_SRC, 'utf8');
    const script = win.document.createElement('script');
    script.textContent = code;
    win.document.body.appendChild(script);
  });

  afterEach(function () {
    try { win.close(); } catch (_) { /* ignore */ }
  });

  it('posts artifact-ready on load', function () {
    const ready = posted.find((m) => m && m.type === 'artifact-ready');
    assert.ok(ready, 'artifact-ready posted');
    assert.equal(ready.source, 'ai-or-die-artifact-sdk');
    assert.equal(ready.sessionId, 'sid-9');
  });

  it('clicking a block then Queue posts a structured annotation with sourceLine', function () {
    const para = win.document.getElementById('para');

    // Click the block — the SDK opens its shadow-DOM card.
    para.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

    const host = win.document.querySelector('[data-ai-or-die-ui="annotation-root"]');
    assert.ok(host && host.shadowRoot, 'annotation shadow host created');
    const card = host.shadowRoot.querySelector('.aod-annotation-card');
    assert.ok(card, 'annotation card rendered');

    const textarea = card.querySelector('textarea');
    const queueBtn = card.querySelector('.aod-send');
    assert.ok(textarea && queueBtn);

    textarea.value = 'Widen the column and fix the footer';
    queueBtn.click();

    const queued = posted.find((m) => m && m.type === 'artifact-annotation-queued');
    assert.ok(queued, 'artifact-annotation-queued posted');
    assert.equal(queued.source, 'ai-or-die-artifact-sdk');
    assert.equal(queued.sessionId, 'sid-9');

    const a = queued.payload.annotation;
    assert.ok(a, 'annotation present');
    assert.equal(a.prompt, 'Widen the column and fix the footer');
    assert.equal(a.tag, 'p');
    assert.equal(a.selector, 'p#para', 'selector short-circuits at the id');
    assert.equal(a.sourceLine, 7, 'sourceLine read from data-source-line');
    assert.ok(typeof a.text === 'string' && a.text.length <= 240);
    assert.ok(a.text.includes('footer is misaligned'));
    assert.ok(!('target' in a), 'element annotation has no text-range target');
  });

  it('Queue with an empty comment posts nothing', function () {
    const para = win.document.getElementById('para');
    para.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    const host = win.document.querySelector('[data-ai-or-die-ui="annotation-root"]');
    const card = host.shadowRoot.querySelector('.aod-annotation-card');
    card.querySelector('.aod-send').click(); // textarea is empty
    assert.equal(posted.filter((m) => m && m.type === 'artifact-annotation-queued').length, 0);
  });

  it('does not annotate clicks on native interactive controls', function () {
    const btn = win.document.createElement('button');
    btn.textContent = 'Submit';
    win.document.querySelector('main').appendChild(btn);
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    const host = win.document.querySelector('[data-ai-or-die-ui="annotation-root"]');
    const card = host && host.shadowRoot && host.shadowRoot.querySelector('.aod-annotation-card');
    assert.ok(!card, 'no card opened for a native control click');
  });

  it('a text selection yields a text-range target annotation', function () {
    const para = win.document.getElementById('para');
    const sel = win.document.getSelection();
    const range = win.document.createRange();
    range.selectNodeContents(para);
    sel.removeAllRanges();
    sel.addRange(range);

    // mouseup over the selection opens the card (text-range path).
    para.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, cancelable: true }));

    const host = win.document.querySelector('[data-ai-or-die-ui="annotation-root"]');
    const card = host && host.shadowRoot && host.shadowRoot.querySelector('.aod-annotation-card');
    if (!card) { this.skip(); return; } // jsdom selection support is partial; skip if no card
    const textarea = card.querySelector('textarea');
    textarea.value = 'Reword this sentence';
    card.querySelector('.aod-send').click();

    const queued = posted.find((m) => m && m.type === 'artifact-annotation-queued');
    assert.ok(queued, 'annotation queued');
    const a = queued.payload.annotation;
    assert.equal(a.tag, 'text');
    assert.ok(a.target && a.target.type === 'text-range', 'carries a text-range target');
    assert.ok(typeof a.target.commonAncestorSelector === 'string');
    assert.ok(a.target.start && a.target.end, 'target has start/end boundaries');
  });

  it('exposes legacy aliases (window.lavish + queuePrompts/recordLayoutWarnings) posting the old message types', function () {
    assert.ok(win.lavish, 'window.lavish present');
    ['prompt', 'queuePrompts', 'ask', 'warnLayout', 'recordLayoutWarnings'].forEach((k) => {
      assert.equal(typeof win.lavish[k], 'function', 'legacy alias ' + k);
    });

    win.lavish.queuePrompts(['make it bigger'], { domSnapshot: { bodyText: 'x' } });
    const pm = posted.find((m) => m && m.type === 'artifact-prompts');
    assert.ok(pm, 'queuePrompts posts artifact-prompts');
    assert.deepEqual(pm.payload.prompts, ['make it bigger']);
    assert.deepEqual(pm.payload.domSnapshot, { bodyText: 'x' });

    win.lavish.recordLayoutWarnings([{ selector: '#a', severity: 'error' }]);
    const lm = posted.find((m) => m && m.type === 'artifact-layout-warnings');
    assert.ok(lm, 'recordLayoutWarnings posts artifact-layout-warnings');
    assert.deepEqual(lm.payload.layout_warnings, [{ selector: '#a', severity: 'error' }]);
  });

  it('queuePrompts coerces a non-array prompt to a single-element array', function () {
    win.lavish.queuePrompts('just a string', { domSnapshot: {} });
    const pm = posted.find((m) => m && m.type === 'artifact-prompts');
    assert.ok(pm);
    assert.deepEqual(pm.payload.prompts, ['just a string']);
  });
});
