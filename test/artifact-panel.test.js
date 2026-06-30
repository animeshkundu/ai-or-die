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

  it('queues an iframe annotation as a pill; Send POSTs the structured array to /prompts', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });

    const annotation = {
      uid: '3', selector: 'main > p:nth-of-type(2)', tag: 'p',
      text: 'The footer is misaligned', prompt: 'make the header bigger', sourceLine: 12,
    };
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-annotation-queued', sessionId: 'sid-1', payload: { annotation } },
    }));
    await Promise.resolve();

    // Queued, not yet sent: a pill is rendered and nothing POSTed.
    const pills = document.querySelectorAll('#artifactPills .artifact-panel__pill');
    assert.equal(pills.length, 1, 'one pill rendered');
    assert.ok(pills[0].textContent.includes('make the header bigger'));
    assert.equal(posted.filter((p) => String(p.url).includes('/prompts')).length, 0, 'nothing POSTed on queue');

    // Send requests a DOM snapshot from the iframe, then flushes on the reply.
    document.querySelector('#artifactPanel .artifact-panel__send').click();
    await Promise.resolve();
    assert.equal(posted.filter((p) => String(p.url).includes('/prompts')).length, 0, 'waits for the snapshot reply');
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-snapshot', sessionId: 'sid-1', payload: { domSnapshot: { bodyText: 'live' } } },
    }));
    await Promise.resolve();

    const call = posted.find((p) => String(p.url).includes('/prompts'));
    assert.ok(call, 'POSTed to /prompts on Send');
    assert.ok(String(call.url).includes('token=tok-123'));
    const body = JSON.parse(call.opts.body);
    assert.ok(Array.isArray(body.prompts) && body.prompts.length === 1, 'sends the structured annotation array');
    assert.deepEqual(body.prompts[0], annotation);
    assert.deepEqual(body.domSnapshot, { bodyText: 'live' }, 'panel Send carries the iframe snapshot');
    assert.equal(document.querySelectorAll('#artifactPills .artifact-panel__pill').length, 0, 'queue cleared after send');
  });

  it('artifact-annotations-send from the iframe flushes the queue', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });

    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-annotation-queued', sessionId: 'sid-1', payload: { annotation: { prompt: 'fix spacing', selector: 'h1' } } },
    }));
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-annotations-send', sessionId: 'sid-1', payload: { domSnapshot: { bodyText: 'snap' } } },
    }));
    await Promise.resolve();

    const call = posted.find((p) => String(p.url).includes('/prompts'));
    assert.ok(call, 'POSTed to /prompts');
    const body = JSON.parse(call.opts.body);
    assert.equal(body.prompts[0].prompt, 'fix spacing');
    assert.deepEqual(body.domSnapshot, { bodyText: 'snap' });
  });

  it('a queued pill can be removed before sending', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-annotation-queued', sessionId: 'sid-1', payload: { annotation: { prompt: 'remove me', selector: 'div' } } },
    }));
    await Promise.resolve();
    assert.equal(document.querySelectorAll('#artifactPills .artifact-panel__pill').length, 1);
    document.querySelector('#artifactPills .artifact-panel__pill-x').click();
    assert.equal(document.querySelectorAll('#artifactPills .artifact-panel__pill').length, 0, 'pill removed');
    // Send with an empty queue does not POST.
    document.querySelector('#artifactPanel .artifact-panel__send').click();
    await Promise.resolve();
    assert.equal(posted.filter((p) => String(p.url).includes('/prompts')).length, 0);
  });

  it('restores the queue to the front when the Send POST fails', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-annotation-queued', sessionId: 'sid-1', payload: { annotation: { prompt: 'will fail', selector: 'p' } } },
    }));
    await Promise.resolve();
    assert.equal(document.querySelectorAll('#artifactPills .artifact-panel__pill').length, 1);

    // Make the next POST fail (non-ok response).
    const failFetch = (url, opts) => { posted.push({ url, opts }); return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }); };
    global.fetch = failFetch;
    global.window.fetch = failFetch;

    document.querySelector('#artifactPanel .artifact-panel__send').click();
    // Drive the snapshot reply so the (failing) POST fires.
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-snapshot', sessionId: 'sid-1', payload: { domSnapshot: {} } },
    }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The annotation is restored to the queue so the user can retry.
    assert.equal(document.querySelectorAll('#artifactPills .artifact-panel__pill').length, 1, 'failed batch restored to the queue');
    assert.ok(document.getElementById('artifactPills').textContent.includes('will fail'));
  });

  it('panel Send falls back to sending without a snapshot if the iframe never replies', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-annotation-queued', sessionId: 'sid-1', payload: { annotation: { prompt: 'no snapshot', selector: 'p' } } },
    }));
    await Promise.resolve();

    document.querySelector('#artifactPanel .artifact-panel__send').click();
    // No artifact-snapshot reply is dispatched; the fallback timer (250ms) sends.
    await new Promise((r) => setTimeout(r, 300));

    const call = posted.find((p) => String(p.url).includes('/prompts'));
    assert.ok(call, 'fallback POSTed without a snapshot');
    const body = JSON.parse(call.opts.body);
    assert.equal(body.prompts[0].prompt, 'no snapshot');
    assert.ok(!('domSnapshot' in body) || body.domSnapshot === undefined, 'no snapshot attached on fallback');
  });

  it('re-enables Send after a successful send + agent reply (no permanent disable)', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    // Agent is connected/listening, so a send transitions presence -> working.
    panel._setPresence('listening');
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-annotation-queued', sessionId: 'sid-1', payload: { annotation: { prompt: 'do it', selector: 'p' } } },
    }));
    await Promise.resolve();

    panel._sendQueue(); // direct send (skip the snapshot round-trip for determinism)
    assert.equal(panel._presence, 'working', 'presence goes working on send');
    // Mock fetch resolves ok:true; the .then() should clear working -> listening.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.notEqual(panel._presence, 'working', 'presence cleared after POST settles');
    assert.equal(panel._sendBtn.disabled, true, 'Send disabled only because queue is now empty, not because working');

    // Queue another and confirm Send is enabled (not stuck disabled).
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-annotation-queued', sessionId: 'sid-1', payload: { annotation: { prompt: 'again', selector: 'p' } } },
    }));
    await Promise.resolve();
    assert.equal(panel._sendBtn.disabled, false, 'Send re-enabled with a non-empty queue');
  });

  it('an agent reply clears a working presence so Send is usable again', function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    panel._setPresence('working');
    assert.equal(panel._presence, 'working');
    panel.agentReply({ sessionId: 'sid-1', text: 'on it' });
    assert.equal(panel._presence, 'listening', 'agent reply clears working');
  });

  it('a stale POST resolution from a switched-away session does not mutate the new session', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    panel.open({ sessionId: 'sid-2', viewUrl: 'x' });

    // Defer session-1's POST so it resolves AFTER we switch to session 2.
    let resolvePost;
    const deferred = new Promise((res) => { resolvePost = res; });
    const slowFetch = (url, opts) => { posted.push({ url, opts }); return deferred; };
    global.fetch = slowFetch;
    global.window.fetch = slowFetch;

    panel._setPresence('listening');
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-annotation-queued', sessionId: 'sid-1', payload: { annotation: { prompt: 'a1', selector: 'p' } } },
    }));
    await Promise.resolve();
    panel._sendQueue(); // sid-1 send in flight, presence -> working
    assert.equal(panel._presence, 'working');

    // Switch to sid-2 and put it into 'working' independently.
    panel.notifyActiveSessionChanged('sid-2');
    panel._setPresence('working');

    // Now resolve sid-1's POST. It must NOT touch sid-2's presence.
    resolvePost({ ok: true, json: () => Promise.resolve({}) });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(panel._presence, 'working', 'stale resolution left the active session untouched');
  });

  it('switching sessions cancels a pending snapshot request (no cross-session flush)', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    panel.open({ sessionId: 'sid-2', viewUrl: 'x' });
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-annotation-queued', sessionId: 'sid-1', payload: { annotation: { prompt: 'q1', selector: 'p' } } },
    }));
    await Promise.resolve();
    panel._sendQueueWithSnapshot(); // request-snapshot pending for sid-1
    assert.equal(panel._snapshotPending, true);

    panel.notifyActiveSessionChanged('sid-2'); // switch — must cancel the pending snapshot
    assert.equal(panel._snapshotPending, false, 'pending snapshot cancelled on switch');

    // A late snapshot reply (for the old session) must not POST anything.
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-snapshot', sessionId: 'sid-2', payload: { domSnapshot: {} } },
    }));
    await Promise.resolve();
    assert.equal(posted.filter((p) => String(p.url).includes('/prompts')).length, 0, 'no cross-session flush');
  });

  it('legacy artifact-prompts message still POSTs to /prompts (backward-compat)', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-prompts', sessionId: 'sid-1', payload: { prompts: ['legacy note'], domSnapshot: { bodyText: 'old' } } },
    }));
    await Promise.resolve();
    const call = posted.find((p) => String(p.url).includes('/prompts'));
    assert.ok(call, 'legacy artifact-prompts POSTed to /prompts');
    const body = JSON.parse(call.opts.body);
    assert.deepEqual(body.prompts, ['legacy note']);
    assert.deepEqual(body.domSnapshot, { bodyText: 'old' });
    assert.ok(document.getElementById('artifactChat').textContent.includes('legacy note'));
  });

  it('legacy artifact-layout-warnings message forwards to /layout-warnings', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-layout-warnings', sessionId: 'sid-1', payload: { layout_warnings: [{ selector: '#root', severity: 'error' }] } },
    }));
    await Promise.resolve();
    const call = posted.find((p) => String(p.url).includes('/layout-warnings'));
    assert.ok(call, 'forwarded to /layout-warnings');
    assert.deepEqual(JSON.parse(call.opts.body).layout_warnings, [{ selector: '#root', severity: 'error' }]);
  });

  it('ignores postMessages from a foreign source', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    window.dispatchEvent(new window.MessageEvent('message', {
      source: panel._iframe.contentWindow,
      data: { source: 'evil', type: 'artifact-prompts', sessionId: 'sid-1', payload: { prompts: ['x'] } },
    }));
    await Promise.resolve();
    assert.equal(posted.filter((p) => String(p.url).includes('/prompts')).length, 0);
  });

  it('ignores an SDK-shaped message from a window other than our iframe (source spoof)', async function () {
    const panel = new ArtifactPanel(app);
    panel.notifyActiveSessionChanged('sid-1');
    panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
    // Correct data.source string, but event.source is NOT our iframe.
    window.dispatchEvent(new window.MessageEvent('message', {
      source: window, // a foreign window
      data: { source: 'ai-or-die-artifact-sdk', type: 'artifact-annotation-queued', sessionId: 'sid-1', payload: { annotation: { prompt: 'spoofed', selector: 'x' } } },
    }));
    await Promise.resolve();
    assert.equal(document.querySelectorAll('#artifactPills .artifact-panel__pill').length, 0, 'spoofed annotation must not queue');
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

  describe('floating-window chrome', function () {
    function hasStorage() {
      try { return !!(global.window && global.window.localStorage); } catch (_) { return false; }
    }

    it('minimize hides the body and persists; restore brings it back', function () {
      if (!hasStorage()) { this.skip(); return; }
      const panel = new ArtifactPanel(app);
      panel.notifyActiveSessionChanged('sid-1');
      panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
      assert.equal(panel._body.hidden, false);

      panel.toggleMinimize();
      assert.equal(panel._minimized, true);
      assert.equal(panel._body.hidden, true);
      assert.ok(panel.el.classList.contains('artifact-panel--minimized'));
      const stored = JSON.parse(window.localStorage.getItem('ai-or-die:artifact-panel:layout'));
      assert.equal(stored.minimized, true, 'minimized persisted to localStorage');

      panel.toggleMinimize();
      assert.equal(panel._minimized, false);
      assert.equal(panel._body.hidden, false);
    });

    it('maximize fills the wrapper and is mutually exclusive with minimize', function () {
      if (!hasStorage()) { this.skip(); return; }
      const panel = new ArtifactPanel(app);
      panel.notifyActiveSessionChanged('sid-1');
      panel.open({ sessionId: 'sid-1', viewUrl: 'x' });

      // Maximize toggles the class + button affordance.
      panel.toggleMaximize();
      assert.equal(panel._maximized, true);
      assert.ok(panel.el.classList.contains('artifact-panel--maximized'));
      assert.equal(panel._maxBtn.getAttribute('aria-label'), 'Restore panel size');

      // Minimizing while maximized clears maximized (mutually exclusive).
      panel.toggleMinimize();
      assert.equal(panel._minimized, true);
      assert.equal(panel._maximized, false);
      assert.ok(!panel.el.classList.contains('artifact-panel--maximized'));

      // Maximizing while minimized clears minimized.
      panel.toggleMaximize();
      assert.equal(panel._maximized, true);
      assert.equal(panel._minimized, false);
      assert.equal(panel._body.hidden, false);

      // Restore.
      panel.toggleMaximize();
      assert.equal(panel._maximized, false);
      assert.ok(!panel.el.classList.contains('artifact-panel--maximized'));
      assert.equal(panel._maxBtn.getAttribute('aria-label'), 'Maximize panel');
    });

    it('restores persisted position + size + minimized on construction', function () {
      if (!hasStorage()) { this.skip(); return; }
      window.localStorage.setItem('ai-or-die:artifact-panel:layout', JSON.stringify({
        left: 40, top: 24, width: 500, height: 360, minimized: true,
      }));
      const panel = new ArtifactPanel(app);
      assert.equal(panel.el.style.left, '40px');
      assert.equal(panel.el.style.top, '24px');
      assert.equal(panel.el.style.width, '500px');
      assert.equal(panel.el.style.height, '360px');
      assert.equal(panel._minimized, true, 'minimized restored');
      assert.equal(panel._body.hidden, true);
    });

    it('clamps a persisted width below the minimum up to MIN_W', function () {
      if (!hasStorage()) { this.skip(); return; }
      window.localStorage.setItem('ai-or-die:artifact-panel:layout', JSON.stringify({ width: 100, height: 50 }));
      const panel = new ArtifactPanel(app);
      assert.equal(panel.el.style.width, '320px', 'width clamped to MIN_W');
      assert.equal(panel.el.style.height, '240px', 'height clamped to MIN_H');
    });

    it('survives a corrupt localStorage payload', function () {
      if (!hasStorage()) { this.skip(); return; }
      window.localStorage.setItem('ai-or-die:artifact-panel:layout', '{not json');
      assert.doesNotThrow(() => new ArtifactPanel(app));
    });

    it('clamps a persisted off-screen position back into the wrapper on show', function () {
      if (!hasStorage()) { this.skip(); return; }
      // A position saved when the window was larger (or after the wrapper shrank)
      // would otherwise restore off-screen and strand the header.
      window.localStorage.setItem('ai-or-die:artifact-panel:layout', JSON.stringify({
        left: 5000, top: 5000, width: 420, height: 400,
      }));
      const panel = new ArtifactPanel(app);
      // jsdom rects are 0x0; stub real sizes so _clampToBounds can compute.
      const wrapper = panel.el.parentElement;
      wrapper.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
      panel.el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 420, height: 400, right: 420, bottom: 400 });

      panel.notifyActiveSessionChanged('sid-1');
      panel.open({ sessionId: 'sid-1', viewUrl: 'x' }); // triggers _show -> _clampToBounds

      // left clamps to <= 800-420 = 380, top to <= 600-400 = 200.
      assert.ok(panel._layout.left <= 380 && panel._layout.left >= 0, 'left clamped into wrapper, got ' + panel._layout.left);
      assert.ok(panel._layout.top <= 200 && panel._layout.top >= 0, 'top clamped into wrapper, got ' + panel._layout.top);
      assert.equal(panel.el.style.left, panel._layout.left + 'px');
      // The corrected position is persisted.
      const stored = JSON.parse(window.localStorage.getItem('ai-or-die:artifact-panel:layout'));
      assert.equal(stored.left, panel._layout.left, 'clamped left persisted');
    });

    it('re-clamps on window resize', function () {
      if (!hasStorage()) { this.skip(); return; }
      window.localStorage.setItem('ai-or-die:artifact-panel:layout', JSON.stringify({
        left: 300, top: 150, width: 420, height: 400,
      }));
      const panel = new ArtifactPanel(app);
      panel.notifyActiveSessionChanged('sid-1');
      panel.open({ sessionId: 'sid-1', viewUrl: 'x' });
      const wrapper = panel.el.parentElement;
      panel.el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 420, height: 400, right: 420, bottom: 400 });
      // Shrink the wrapper so the panel now hangs off the right/bottom edge.
      wrapper.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 450, right: 500, bottom: 450 });
      window.dispatchEvent(new window.Event('resize'));
      assert.ok(panel._layout.left <= 80, 'left re-clamped to <= 500-420 on resize, got ' + panel._layout.left);
      assert.ok(panel._layout.top <= 50, 'top re-clamped to <= 450-400 on resize, got ' + panel._layout.top);
    });
  });
});
