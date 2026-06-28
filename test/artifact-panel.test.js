'use strict';

// jsdom unit tests for the Track A artifact-review panel (src/public/artifact-panel.js):
// DOM mount, client-token URL construction, the iframe<->server postMessage bridge,
// SSE agent-reply rendering, and per-session show/hide. Mirrors the sticky-note-card
// test harness. Skips cleanly when jsdom isn't installed.

const assert = require('assert');
const path = require('path');

let JSDOM = null;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (_) {
  /* skip below */
}

const PANEL_SRC = path.join(__dirname, '..', 'src', 'public', 'artifact-panel.js');

describe('artifact-panel.js (DOM: iframe + SSE + postMessage bridge)', function () {
  if (!JSDOM) {
    it('skipped — jsdom not installed', function () { this.skip(); });
    return;
  }

  let ArtifactPanel;
  let app;
  let posted; // captured fetch() calls
  let sseInstances;
  let origFetch; // native Node fetch — must be RESTORED, not deleted (would break later suites)

  beforeEach(function () {
    const dom = new JSDOM('<!DOCTYPE html><body><div class="terminal-wrapper"></div></body>', { url: 'http://localhost' });
    global.window = dom.window;
    global.document = dom.window.document;

    global.window.authManager = {
      getToken: () => 'tok-123',
      appendAuthToUrl: (u) => u + (u.includes('?') ? '&' : '?') + 'token=tok-123',
      getAuthHeaders: () => ({ Authorization: 'Bearer tok-123' }),
    };

    posted = [];
    const mockFetch = (url, opts) => {
      posted.push({ url, opts });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    };
    global.window.fetch = mockFetch;
    origFetch = global.fetch;       // save the native global
    global.fetch = mockFetch;       // the panel calls bare fetch() (=> global in node)

    sseInstances = [];
    global.window.EventSource = class {
      constructor(url) { this.url = url; this.listeners = {}; sseInstances.push(this); }
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
      emit(type, data) { (this.listeners[type] || []).forEach((fn) => fn({ data })); }
      close() { this.closed = true; }
    };

    delete require.cache[require.resolve(PANEL_SRC)];
    ArtifactPanel = require(PANEL_SRC);
    app = {};
  });

  afterEach(function () {
    delete global.window;
    delete global.document;
    if (origFetch === undefined) delete global.fetch; else global.fetch = origFetch; // restore native fetch
  });

  it('mounts hidden inside .terminal-wrapper', function () {
    const panel = new ArtifactPanel(app);
    const node = document.querySelector('.terminal-wrapper #artifactPanel');
    assert.ok(node, 'panel mounted');
    assert.equal(node.hidden, true);
  });

  it('open() + active session shows the iframe with the CLIENT token (not the broadcast token)', function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: '/api/artifact/sid-1/view?token=AGENT-TOKEN', file: '/ws/a.html' });
    const iframe = document.getElementById('artifactFrame');
    assert.equal(panel.el.hidden, false);
    assert.ok(iframe.src.includes('/api/artifact/sid-1/view'));
    assert.ok(iframe.src.includes('token=tok-123'), 'uses the client token');
    assert.ok(!iframe.src.includes('AGENT-TOKEN'), 'does NOT reuse the broadcast/agent token');
  });

  it('does NOT show a panel for a non-active tab', function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-2', viewUrl: 'x' });
    assert.equal(panel.el.hidden, true);
  });

  it('forwards an iframe artifact-prompts message to POST /prompts', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });

    window.dispatchEvent(new window.MessageEvent('message', {
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-prompts', sessionId: 'sid-1', payload: { prompts: ['make the header bigger'] } },
    }));
    await Promise.resolve();

    const call = posted.find((p) => String(p.url).includes('/prompts'));
    assert.ok(call, 'POSTed to /prompts');
    assert.ok(String(call.url).includes('token=tok-123'));
    const body = JSON.parse(call.opts.body);
    assert.deepEqual(body.prompts, ['make the header bigger']);
    assert.ok(document.getElementById('artifactChat').textContent.includes('make the header bigger'));
  });

  it('ignores postMessages from a foreign source', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { source: 'evil', type: 'artifact-prompts', sessionId: 'sid-1', payload: { prompts: ['x'] } },
    }));
    await Promise.resolve();
    assert.equal(posted.filter((p) => String(p.url).includes('/prompts')).length, 0);
  });

  it('renders an SSE agent-reply into the chat log', function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    assert.equal(sseInstances.length, 1);
    assert.ok(sseInstances[0].url.includes('/api/artifact/sid-1/events'));
    sseInstances[0].emit('agent-reply', JSON.stringify({ text: 'updated the layout' }));
    assert.ok(document.getElementById('artifactChat').textContent.includes('updated the layout'));
  });

  it('a user note POSTs to /prompts and echoes into chat', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    document.getElementById('artifactInput').value = 'please fix the footer';
    panel._submitNote();
    await Promise.resolve();
    const call = posted.find((p) => String(p.url).includes('/prompts'));
    assert.ok(call);
    assert.deepEqual(JSON.parse(call.opts.body).prompts, ['please fix the footer']);
  });

  it('endReview() hides the panel and tears down SSE', function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    const sse = sseInstances[0];
    panel.endReview({ sessionId: 'sid-1' });
    assert.equal(panel.el.hidden, true);
    assert.equal(sse.closed, true);
    assert.equal(panel.reviews.has('sid-1'), false);
  });

  it('switching away from a tab hides the panel; switching back reshows it', function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    assert.equal(panel.el.hidden, false);
    panel.notifyActiveSessionChanged('sid-2');
    assert.equal(panel.el.hidden, true);
    panel.notifyActiveSessionChanged('sid-1');
    assert.equal(panel.el.hidden, false);
  });

  it('reloadReview() cache-busts the active iframe and ignores other/inactive sessions', function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: '/api/artifact/sid-1/view' });
    const before = panel._iframe.src;
    panel.reloadReview({ sessionId: 'sid-2' }); // foreign session: no-op
    assert.equal(panel._iframe.src, before);
    panel.reloadReview({ sessionId: 'sid-1' }); // active: cache-busted
    assert.ok(panel._iframe.src.includes('_r='), 'iframe src should be cache-busted');
  });
});
