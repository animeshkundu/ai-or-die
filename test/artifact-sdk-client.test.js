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

  it('C-P1-2: a data-aod choose control emits ONE structured action, not an annotation', function () {
    const btn = win.document.createElement('button');
    btn.setAttribute('data-aod-action', 'choose');
    btn.setAttribute('data-aod-id', 'decision-1');
    btn.setAttribute('data-aod-value', 'option-b');
    btn.textContent = 'Option B';
    win.document.body.appendChild(btn);
    posted.length = 0;
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    const acts = posted.filter((m) => m && m.type === 'artifact-action');
    assert.equal(acts.length, 1, 'one action emitted');
    assert.equal(acts[0].payload.action, 'choose');
    assert.equal(acts[0].payload.elementId, 'decision-1');
    assert.equal(acts[0].payload.value, 'option-b');
    assert.equal(posted.filter((m) => m && m.type === 'artifact-annotation-queued').length, 0, 'no annotation queued');
  });

  it('C-P1-2: check toggles are UI-local; a submit harvests the checked group set once', function () {
    const mkCheck = (id, val) => {
      const c = win.document.createElement('input');
      c.type = 'checkbox';
      c.setAttribute('data-aod-action', 'check');
      c.setAttribute('data-aod-group', 'tasks');
      c.setAttribute('data-aod-id', id);
      c.setAttribute('data-aod-value', val);
      win.document.body.appendChild(c);
      return c;
    };
    const c1 = mkCheck('task-7', 'retry');
    mkCheck('task-9', 'cache'); // left unchecked
    const submit = win.document.createElement('button');
    submit.setAttribute('data-aod-action', 'submit');
    submit.setAttribute('data-aod-group', 'tasks');
    submit.setAttribute('data-aod-id', 'tasks-go');
    win.document.body.appendChild(submit);

    posted.length = 0;
    c1.checked = true;
    c1.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.equal(posted.filter((m) => m && m.type === 'artifact-action').length, 0, 'a check change emits nothing');

    submit.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    const acts = posted.filter((m) => m && m.type === 'artifact-action');
    assert.equal(acts.length, 1, 'submit emits exactly one action');
    assert.equal(acts[0].payload.action, 'submit');
    assert.equal(acts[0].payload.group, 'tasks');
    assert.deepEqual(acts[0].payload.selected, [{ elementId: 'task-7', value: 'retry' }]);
  });

  it('C-P1-2: a data-aod control missing data-aod-id is ignored', function () {
    const btn = win.document.createElement('button');
    btn.setAttribute('data-aod-action', 'approve'); // no data-aod-id
    win.document.body.appendChild(btn);
    posted.length = 0;
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(posted.filter((m) => m && m.type === 'artifact-action').length, 0, 'ignored without an id');
  });

  it('C-P1-2: an inbound plan-state marks matching data-aod-id elements with data-aod-state', function () {
    const li = win.document.createElement('li');
    li.setAttribute('data-aod-id', 'plan-step-3');
    win.document.body.appendChild(li);
    win.postMessage = win.postMessage; // no-op (kept intercepted)
    // Deliver a host plan-state message (source must be the parent window).
    const evt = new win.MessageEvent('message', {
      data: { source: 'ai-or-die-artifact-host', type: 'plan-state', sessionId: 'sid-9', payload: { steps: [{ elementId: 'plan-step-3', state: 'approved' }] } },
    });
    Object.defineProperty(evt, 'source', { value: win });
    win.dispatchEvent(evt);
    assert.equal(li.getAttribute('data-aod-state'), 'approved');
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
