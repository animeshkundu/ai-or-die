'use strict';

// Per-tab artifact-review panel (Track A / ADR-0033). When the server broadcasts
// `artifact_review_opened` for a tab (the in-session agent called artifact_open),
// this panel renders the agent's HTML artifact in an iframe — served + SDK-injected
// by ai-or-die at /api/artifact/:sessionId/view — and runs the human-in-the-loop
// review loop over the existing authed tunnel:
//
//   iframe SDK  --postMessage-->  panel  --authed POST-->  /api/artifact/:id/prompts
//   /api/artifact/:id/events (SSE)  -->  panel  --postMessage-->  iframe SDK (agent-reply)
//
// The browser never trusts the agent's token from the broadcast viewUrl; every URL
// is (re)built with the client's own auth token (window.authManager). Modeled on
// StickyNoteCard: self-builds DOM, self-mounts to .terminal-wrapper, one instance,
// per-session state keyed by claude sessionId, shown only for the active tab.

(function () {
  const SDK_SOURCE_IN = 'ai-or-die-artifact-sdk';   // messages FROM the iframe
  const HOST_SOURCE_OUT = 'ai-or-die-artifact-host'; // messages TO the iframe

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach((c) => node.appendChild(c));
    return node;
  }

  class ArtifactPanel {
    constructor(app) {
      this.app = app;
      // Per-session review state: sessionId -> { sessionId, viewUrl, file, ready }
      this.reviews = new Map();
      this.activeSessionId = null;
      this._sse = null;          // active EventSource (for the shown session)
      this._sseSessionId = null;
      this._collapsed = false;
      this.onStateChange = null;

      this._buildDom();
      this._onWindowMessage = (e) => this._handleIframeMessage(e);
      window.addEventListener('message', this._onWindowMessage);
    }

    _buildDom() {
      this.el = el('div', { class: 'artifact-panel', id: 'artifactPanel', hidden: 'hidden' });

      const title = el('span', { class: 'artifact-panel__title', text: 'Artifact review' });
      const presence = el('span', { class: 'artifact-panel__presence', id: 'artifactPresence', text: '' });
      const spacer = el('span', { class: 'artifact-panel__spacer' });
      const reloadBtn = el('button', { class: 'artifact-panel__btn', title: 'Reload artifact', type: 'button', text: '⟳' });
      const closeBtn = el('button', { class: 'artifact-panel__btn', title: 'Close panel', type: 'button', text: '×' });
      reloadBtn.addEventListener('click', () => this.reload());
      closeBtn.addEventListener('click', () => this.collapse());
      const header = el('div', { class: 'artifact-panel__header' }, [title, presence, spacer, reloadBtn, closeBtn]);

      this._iframe = el('iframe', {
        class: 'artifact-panel__frame',
        id: 'artifactFrame',
        sandbox: 'allow-scripts allow-forms allow-same-origin',
        referrerpolicy: 'no-referrer',
      });

      this._chatLog = el('div', { class: 'artifact-panel__chat', id: 'artifactChat' });
      this._chatInput = el('input', {
        class: 'artifact-panel__input', id: 'artifactInput', type: 'text',
        placeholder: 'Send a note to the agent…', autocomplete: 'off',
      });
      const sendBtn = el('button', { class: 'artifact-panel__send', type: 'button', text: 'Send' });
      sendBtn.addEventListener('click', () => this._submitNote());
      this._chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._submitNote(); });
      const chatBar = el('div', { class: 'artifact-panel__chatbar' }, [this._chatInput, sendBtn]);

      this.el.appendChild(header);
      this.el.appendChild(this._iframe);
      this.el.appendChild(this._chatLog);
      this.el.appendChild(chatBar);
      this._refs = { presence };

      const wrapper = document.querySelector('.terminal-wrapper') || document.getElementById('terminalContainer') || document.body;
      if (wrapper) wrapper.appendChild(this.el);
    }

    // ---- token / url helpers (always the CLIENT's own token) --------------
    _authUrl(suffix, sessionId) {
      const base = '/api/artifact/' + encodeURIComponent(sessionId) + suffix;
      const am = window.authManager;
      return am && typeof am.appendAuthToUrl === 'function' ? am.appendAuthToUrl(base) : base;
    }
    _authHeaders() {
      const am = window.authManager;
      const h = { 'Content-Type': 'application/json' };
      if (am && typeof am.getAuthHeaders === 'function') Object.assign(h, am.getAuthHeaders());
      return h;
    }

    // ---- server-driven lifecycle (called from app.js WS handler) ---------
    open(message) {
      if (!message || !message.sessionId) return;
      const sessionId = String(message.sessionId);
      this.reviews.set(sessionId, {
        sessionId,
        viewUrl: this._authUrl('/view', sessionId), // client-token URL, not the broadcast's
        file: message.file || null,
        ready: false,
      });
      if (sessionId === this.activeSessionId) this._show(sessionId);
      this._emitState();
    }

    endReview(message) {
      const sessionId = message && message.sessionId ? String(message.sessionId) : this.activeSessionId;
      if (!sessionId) return;
      this.reviews.delete(sessionId);
      if (sessionId === this._sseSessionId) this._teardownSse();
      if (sessionId === this.activeSessionId) this._hide();
      this._emitState();
    }

    agentReply(message) {
      if (!message) return;
      const sessionId = String(message.sessionId || this.activeSessionId || '');
      const text = message.text == null ? '' : String(message.text);
      if (sessionId === this.activeSessionId) {
        this._appendChat('agent', text);
        this._postToIframe('agent-reply', { text });
      }
    }

    notifyActiveSessionChanged(sessionId) {
      this.activeSessionId = sessionId ? String(sessionId) : null;
      if (this.activeSessionId && this.reviews.has(this.activeSessionId)) this._show(this.activeSessionId);
      else this._hide();
    }

    // ---- show / hide -----------------------------------------------------
    _show(sessionId) {
      const review = this.reviews.get(sessionId);
      if (!review) return;
      if (this._iframe.getAttribute('data-session') !== sessionId) {
        this._chatLog.innerHTML = '';
        this._iframe.setAttribute('data-session', sessionId);
        this._iframe.src = review.viewUrl;
      }
      this._connectSse(sessionId);
      this._collapsed = false;
      this.el.hidden = false;
    }
    _hide() {
      this.el.hidden = true;
      this._teardownSse();
    }
    collapse() { this._collapsed = true; this._hide(); this._emitState(); }
    expand() {
      this._collapsed = false;
      if (this.activeSessionId && this.reviews.has(this.activeSessionId)) this._show(this.activeSessionId);
      this._emitState();
    }
    isOpenForActive() { return !!(this.activeSessionId && this.reviews.has(this.activeSessionId)); }

    reload() {
      const sessionId = this.activeSessionId;
      if (!sessionId || !this.reviews.has(sessionId)) return;
      // Cache-bust so the agent's latest edit shows.
      const review = this.reviews.get(sessionId);
      const sep = review.viewUrl.includes('?') ? '&' : '?';
      this._iframe.src = review.viewUrl + sep + '_r=' + Date.now();
    }

    // Server-driven auto live-reload: file changed under review. Only the active
    // tab's iframe is cache-busted; the chat/feedback box is untouched.
    reloadReview(message) {
      const sessionId = message && message.sessionId ? String(message.sessionId) : this.activeSessionId;
      if (!sessionId || sessionId !== this.activeSessionId || !this.reviews.has(sessionId)) return;
      this.reload();
    }

    // ---- iframe <-> server bridge ----------------------------------------
    _handleIframeMessage(event) {
      const data = event && event.data;
      if (!data || data.source !== SDK_SOURCE_IN) return;
      const sessionId = data.sessionId ? String(data.sessionId) : this.activeSessionId;
      if (!sessionId || !this.reviews.has(sessionId)) return;
      const payload = data.payload || {};

      if (data.type === 'artifact-ready') {
        const review = this.reviews.get(sessionId);
        if (review) review.ready = true;
        return;
      }
      if (data.type === 'artifact-prompts') {
        const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
        if (prompts.length) {
          this._post('/prompts', sessionId, { prompts, domSnapshot: payload.domSnapshot });
          prompts.forEach((p) => this._appendChat('you', typeof p === 'string' ? p : JSON.stringify(p)));
        }
        return;
      }
      if (data.type === 'artifact-layout-warnings') {
        const warnings = Array.isArray(payload.layout_warnings) ? payload.layout_warnings : [];
        this._post('/layout-warnings', sessionId, { layout_warnings: warnings });
        return;
      }
    }

    _postToIframe(type, payload) {
      try {
        const win = this._iframe && this._iframe.contentWindow;
        if (win) win.postMessage({ source: HOST_SOURCE_OUT, type, sessionId: this.activeSessionId, payload: payload || {} }, '*');
      } catch (_) { /* iframe cross-origin / not ready */ }
    }

    _post(suffix, sessionId, body) {
      return fetch(this._authUrl(suffix, sessionId), {
        method: 'POST',
        headers: this._authHeaders(),
        body: JSON.stringify(body || {}),
      }).catch(() => { /* surfaced via the agent's poll cadence; non-fatal in UI */ });
    }

    _submitNote() {
      const text = (this._chatInput.value || '').trim();
      if (!text || !this.activeSessionId) return;
      this._chatInput.value = '';
      this._post('/prompts', this.activeSessionId, { prompts: [text] });
      this._appendChat('you', text);
    }

    _appendChat(role, text) {
      const line = el('div', { class: 'artifact-panel__msg artifact-panel__msg--' + role });
      line.appendChild(el('span', { class: 'artifact-panel__role', text: role === 'agent' ? 'agent' : 'you' }));
      line.appendChild(el('span', { class: 'artifact-panel__text', text: String(text) }));
      this._chatLog.appendChild(line);
      this._chatLog.scrollTop = this._chatLog.scrollHeight;
    }

    // ---- SSE (agent replies + presence + end) ----------------------------
    _connectSse(sessionId) {
      if (this._sseSessionId === sessionId && this._sse) return;
      this._teardownSse();
      if (typeof window.EventSource !== 'function') return;
      let src;
      try {
        src = new window.EventSource(this._authUrl('/events', sessionId));
      } catch (_) { return; }
      this._sse = src;
      this._sseSessionId = sessionId;
      src.addEventListener('agent-reply', (e) => {
        const d = this._parse(e.data);
        if (d && typeof d.text === 'string') { this._appendChat('agent', d.text); this._postToIframe('agent-reply', { text: d.text }); }
      });
      src.addEventListener('presence', (e) => {
        const d = this._parse(e.data);
        if (d && d.presence && this._refs.presence) {
          this._refs.presence.textContent = d.presence.connected ? '● live' : '';
        }
        this._postToIframe('presence', (d && d.presence) || {});
      });
      src.addEventListener('ended', () => this.endReview({ sessionId }));
    }
    _teardownSse() {
      if (this._sse) { try { this._sse.close(); } catch (_) { /* already closed */ } }
      this._sse = null;
      this._sseSessionId = null;
    }
    _parse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

    _emitState() {
      if (typeof this.onStateChange === 'function') {
        this.onStateChange({ open: this.isOpenForActive(), collapsed: this._collapsed });
      }
    }

    destroy() {
      window.removeEventListener('message', this._onWindowMessage);
      this._teardownSse();
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = ArtifactPanel;
  if (typeof window !== 'undefined') window.ArtifactPanel = ArtifactPanel;
})();
