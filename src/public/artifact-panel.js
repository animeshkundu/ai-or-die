'use strict';

// Per-tab artifact-review panel (Track A / ADR-0033). When the server broadcasts
// `artifact_review_opened` for a tab (the in-session agent called artifact_open),
// this panel renders the agent's artifact in an iframe — served + SDK-injected by
// ai-or-die at /api/artifact/:sessionId/view — and runs the human-in-the-loop
// review loop over the existing authed tunnel:
//
//   iframe SDK  --postMessage-->  panel (queue + pills)  --Send--> POST /prompts
//   /api/artifact/:id/events (SSE)  -->  panel  --postMessage-->  iframe SDK
//
// The panel is a floating window: drag the header to move, drag the corner to
// resize, minimize to the header bar. Position/size/minimized persist in
// localStorage. The panel owns the annotation queue (rendered as removable pills);
// the SDK only emits queue/send intents. The browser never trusts the agent's
// token from the broadcast viewUrl; every URL is (re)built with the client's own
// auth token (window.authManager).

(function () {
  const SDK_SOURCE_IN = 'ai-or-die-artifact-sdk';   // messages FROM the iframe
  const HOST_SOURCE_OUT = 'ai-or-die-artifact-host'; // messages TO the iframe
  const STORE_KEY = 'ai-or-die:artifact-panel:layout';

  const MIN_W = 320;
  const MIN_H = 240;

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

  function clampNumber(value, min, max) {
    if (typeof value !== 'number' || !isFinite(value)) return min;
    return Math.min(Math.max(value, min), max);
  }

  class ArtifactPanel {
    constructor(app) {
      this.app = app;
      // Per-session review state: sessionId -> { sessionId, viewUrl, file, ready, scroll }
      this.reviews = new Map();
      this.activeSessionId = null;
      this._sse = null;          // active EventSource (for the shown session)
      this._sseSessionId = null;
      this._collapsed = false;   // session-show gate (switched-away / closed)
      this._minimized = false;   // window minimized to header bar
      this._maximized = false;   // window expanded to fill the wrapper
      // Annotation queue + chat are per-session (see reviews Map / C-P0-2), not
      // a single shared array — switching tabs must not drop another tab's state.
      this._presence = 'waiting';
      this.onStateChange = null;

      this._layout = this._loadLayout();
      this._buildDom();
      this._applyLayout();
      this._minimized = !!this._layout.minimized;
      this._applyMinimized();

      this._onWindowMessage = (e) => this._handleIframeMessage(e);
      window.addEventListener('message', this._onWindowMessage);
      // Re-clamp on viewport/wrapper resize so a shrinking window can't strand
      // the panel header out of reach.
      this._onWindowResize = () => { if (!this.el.hidden) this._clampToBounds(); };
      window.addEventListener('resize', this._onWindowResize);
    }

    // ---- persisted layout -------------------------------------------------
    _loadLayout() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (_) { /* storage unavailable / corrupt */ }
      return {};
    }
    _saveLayout() {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({
          left: this._layout.left,
          top: this._layout.top,
          width: this._layout.width,
          height: this._layout.height,
          minimized: this._minimized,
        }));
      } catch (_) { /* non-fatal */ }
    }

    _buildDom() {
      this.el = el('div', { class: 'artifact-panel', id: 'artifactPanel', hidden: 'hidden', role: 'dialog', 'aria-label': 'Artifact review' });

      const title = el('span', { class: 'artifact-panel__title', text: 'Artifact review' });
      const presence = el('span', { class: 'artifact-panel__presence', id: 'artifactPresence', text: '' });
      const spacer = el('span', { class: 'artifact-panel__spacer' });
      const reloadBtn = el('button', { class: 'artifact-panel__btn', title: 'Reload artifact', 'aria-label': 'Reload artifact', type: 'button', text: '↻' });
      this._maxBtn = el('button', { class: 'artifact-panel__btn', title: 'Maximize', 'aria-label': 'Maximize panel', type: 'button', text: '⤢' });
      this._minBtn = el('button', { class: 'artifact-panel__btn', title: 'Minimize', 'aria-label': 'Minimize panel', type: 'button', text: '–' });
      const closeBtn = el('button', { class: 'artifact-panel__btn', title: 'Close panel', 'aria-label': 'Close panel', type: 'button', text: '×' });
      reloadBtn.addEventListener('click', () => this.reload());
      this._maxBtn.addEventListener('click', () => this.toggleMaximize());
      this._minBtn.addEventListener('click', () => this.toggleMinimize());
      closeBtn.addEventListener('click', () => this.collapse());
      this._header = el('div', { class: 'artifact-panel__header' }, [title, presence, spacer, reloadBtn, this._maxBtn, this._minBtn, closeBtn]);
      this._wireDrag(this._header);

      this._iframe = el('iframe', {
        class: 'artifact-panel__frame',
        id: 'artifactFrame',
        sandbox: 'allow-scripts allow-forms allow-same-origin',
        referrerpolicy: 'no-referrer',
        title: 'Artifact preview',
      });
      this._iframe.addEventListener('load', () => this._onIframeLoad());

      // Queued-annotation pills + Send.
      this._pills = el('div', { class: 'artifact-panel__pills', id: 'artifactPills' });
      this._sendBtn = el('button', { class: 'artifact-panel__send', type: 'button', text: 'Send to agent' });
      this._sendBtn.addEventListener('click', () => this._sendQueueWithSnapshot());
      this._pillBar = el('div', { class: 'artifact-panel__pillbar', hidden: 'hidden' }, [this._pills, this._sendBtn]);

      this._chatLog = el('div', { class: 'artifact-panel__chat', id: 'artifactChat' });
      this._chatInput = el('input', {
        class: 'artifact-panel__input', id: 'artifactInput', type: 'text',
        placeholder: 'Send a note to the agent…', autocomplete: 'off', 'aria-label': 'Note to the agent',
      });
      const noteBtn = el('button', { class: 'artifact-panel__send artifact-panel__send--note', type: 'button', text: 'Send' });
      noteBtn.addEventListener('click', () => this._submitNote());
      this._chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._submitNote(); });
      const chatBar = el('div', { class: 'artifact-panel__chatbar' }, [this._chatInput, noteBtn]);

      this._resizeHandle = el('div', { class: 'artifact-panel__resize', 'aria-hidden': 'true' });
      this._wireResize(this._resizeHandle);

      this._body = el('div', { class: 'artifact-panel__body' }, [this._iframe, this._pillBar, this._chatLog, chatBar]);

      this.el.appendChild(this._header);
      this.el.appendChild(this._body);
      this.el.appendChild(this._resizeHandle);
      this._refs = { presence };

      const wrapper = document.querySelector('.terminal-wrapper') || document.getElementById('terminalContainer') || document.body;
      if (wrapper) wrapper.appendChild(this.el);

      // Re-open badge (C-P0-3): a small affordance shown when the panel is
      // dismissed, so × is no longer a dead-end. Click restores the panel.
      this._reopenBadge = el('button', {
        class: 'artifact-panel__reopen', type: 'button', hidden: 'hidden',
        title: 'Reopen artifact review', 'aria-label': 'Reopen artifact review',
        text: '⤢ Artifact review',
      });
      this._reopenBadge.addEventListener('click', () => this.expand());
      if (wrapper) wrapper.appendChild(this._reopenBadge);
    }

    // Active review record (or null). All per-session state (queue, chat) hangs
    // off this, so tab switches never touch another session's state.
    _activeReview() {
      return this.activeSessionId ? (this.reviews.get(this.activeSessionId) || null) : null;
    }

    // ---- floating-window geometry ----------------------------------------
    _applyLayout() {
      const L = this._layout;
      if (typeof L.width === 'number') this.el.style.width = clampNumber(L.width, MIN_W, 4000) + 'px';
      if (typeof L.height === 'number') this.el.style.height = clampNumber(L.height, MIN_H, 4000) + 'px';
      // Position only when explicitly placed; otherwise the CSS default
      // (anchored bottom-right) applies.
      if (typeof L.left === 'number' && typeof L.top === 'number') {
        this.el.style.left = L.left + 'px';
        this.el.style.top = L.top + 'px';
        this.el.style.right = 'auto';
        this.el.style.bottom = 'auto';
      }
    }

    // Keep the panel within the wrapper so a persisted off-screen position (e.g.
    // saved on a larger window, or after the wrapper shrank) can't strand the
    // header out of reach. No-op until a position has been set; clamps using the
    // live panel size, then persists the corrected value. Safe to call when the
    // panel is visible (a hidden panel measures 0x0, so we skip then).
    _clampToBounds() {
      const L = this._layout;
      if (typeof L.left !== 'number' || typeof L.top !== 'number') return;
      if (this.el.hidden) return;
      const b = this._bounds();
      const rect = this.el.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0 || rect.width <= 0 || rect.height <= 0) return;
      const left = clampNumber(L.left, 0, Math.max(0, b.width - rect.width));
      const top = clampNumber(L.top, 0, Math.max(0, b.height - rect.height));
      if (left !== L.left || top !== L.top) {
        L.left = left;
        L.top = top;
        this._saveLayout();
      }
      this.el.style.left = left + 'px';
      this.el.style.top = top + 'px';
      this.el.style.right = 'auto';
      this.el.style.bottom = 'auto';
    }

    _bounds() {
      const wrapper = this.el.parentElement || document.body;
      const wr = wrapper.getBoundingClientRect();
      return { width: wr.width, height: wr.height };
    }

    _wireDrag(handle) {
      let startX = 0, startY = 0, originLeft = 0, originTop = 0, dragging = false;
      const onMove = (e) => {
        if (!dragging) return;
        const p = this._point(e);
        const b = this._bounds();
        const rect = this.el.getBoundingClientRect();
        let left = clampNumber(originLeft + (p.x - startX), 0, Math.max(0, b.width - rect.width));
        let top = clampNumber(originTop + (p.y - startY), 0, Math.max(0, b.height - rect.height));
        this._layout.left = left;
        this._layout.top = top;
        this.el.style.left = left + 'px';
        this.el.style.top = top + 'px';
        this.el.style.right = 'auto';
        this.el.style.bottom = 'auto';
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        this._dragCleanup = null;
        this._saveLayout();
      };
      handle.addEventListener('mousedown', (e) => {
        // Ignore drags that start on a header button.
        if (e.target && e.target.closest && e.target.closest('.artifact-panel__btn')) return;
        e.preventDefault();
        const p = this._point(e);
        const wrapper = this.el.parentElement || document.body;
        const wr = wrapper.getBoundingClientRect();
        const rect = this.el.getBoundingClientRect();
        // Convert current rect to wrapper-relative left/top so the first drag
        // doesn't jump when the panel was positioned via right/bottom CSS.
        originLeft = rect.left - wr.left;
        originTop = rect.top - wr.top;
        startX = p.x;
        startY = p.y;
        dragging = true;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        // Let destroy() detach an in-progress drag (mouseup may never fire if
        // the panel is torn down or the pointer leaves the window).
        this._dragCleanup = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
      });
    }

    _wireResize(handle) {
      let startX = 0, startY = 0, originW = 0, originH = 0, resizing = false;
      const onMove = (e) => {
        if (!resizing) return;
        const p = this._point(e);
        const b = this._bounds();
        const rect = this.el.getBoundingClientRect();
        const wrapper = this.el.parentElement || document.body;
        const wr = wrapper.getBoundingClientRect();
        const maxW = Math.max(MIN_W, b.width - (rect.left - wr.left));
        const maxH = Math.max(MIN_H, b.height - (rect.top - wr.top));
        const width = clampNumber(originW + (p.x - startX), MIN_W, maxW);
        const height = clampNumber(originH + (p.y - startY), MIN_H, maxH);
        this._layout.width = width;
        this._layout.height = height;
        this.el.style.width = width + 'px';
        this.el.style.height = height + 'px';
      };
      const onUp = () => {
        if (!resizing) return;
        resizing = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        this._resizeCleanup = null;
        this._saveLayout();
      };
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const p = this._point(e);
        const rect = this.el.getBoundingClientRect();
        originW = rect.width;
        originH = rect.height;
        startX = p.x;
        startY = p.y;
        resizing = true;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        this._resizeCleanup = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
      });
    }

    _point(e) {
      if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      return { x: e.clientX, y: e.clientY };
    }

    // ---- minimize ---------------------------------------------------------
    toggleMinimize() {
      this._minimized = !this._minimized;
      // Minimize and maximize are mutually exclusive.
      if (this._minimized && this._maximized) { this._maximized = false; this._applyMaximized(); }
      this._applyMinimized();
      this._saveLayout();
      this._emitState();
    }
    _applyMinimized() {
      this.el.classList.toggle('artifact-panel--minimized', this._minimized);
      if (this._body) this._body.hidden = this._minimized;
      if (this._resizeHandle) this._resizeHandle.hidden = this._minimized || this._maximized;
      if (this._minBtn) {
        this._minBtn.textContent = this._minimized ? '□' : '–';
        this._minBtn.setAttribute('title', this._minimized ? 'Restore' : 'Minimize');
        this._minBtn.setAttribute('aria-label', this._minimized ? 'Restore panel' : 'Minimize panel');
      }
    }

    // ---- maximize ---------------------------------------------------------
    // Expand the panel to fill the wrapper for a focused, lavish-style full view;
    // toggle back to the prior size. The CSS class overrides the inline
    // left/top/width/height with !important, so restoring just removes the class
    // and the previous geometry reappears — no manual save/restore needed.
    toggleMaximize() {
      this._maximized = !this._maximized;
      if (this._maximized && this._minimized) { this._minimized = false; this._applyMinimized(); }
      this._applyMaximized();
      this._emitState();
    }
    _applyMaximized() {
      this.el.classList.toggle('artifact-panel--maximized', this._maximized);
      if (this._resizeHandle) this._resizeHandle.hidden = this._maximized || this._minimized;
      if (this._maxBtn) {
        this._maxBtn.textContent = this._maximized ? '❐' : '⤢';
        this._maxBtn.setAttribute('title', this._maximized ? 'Restore size' : 'Maximize');
        this._maxBtn.setAttribute('aria-label', this._maximized ? 'Restore panel size' : 'Maximize panel');
      }
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
      const existing = this.reviews.get(sessionId);
      this.reviews.set(sessionId, {
        sessionId,
        viewUrl: this._authUrl('/view', sessionId), // client-token URL, not the broadcast's
        file: message.file || null,
        ready: false,
        scroll: { x: 0, y: 0 },
        // Per-session panel state (C-P0-2): the queue (pills) and chat log live
        // with the review, so switching tabs never drops queued annotations or
        // wipes chat. Preserved across re-open of the same session.
        queue: (existing && Array.isArray(existing.queue)) ? existing.queue : [],
        chat: (existing && Array.isArray(existing.chat)) ? existing.chat : [],
        chatCursor: (existing && typeof existing.chatCursor === 'number') ? existing.chatCursor : 0,
        dismissed: false,
      });
      if (sessionId === this.activeSessionId) this._show(sessionId);
      this._emitState();
    }

    endReview(message) {
      const sessionId = message && message.sessionId ? String(message.sessionId) : this.activeSessionId;
      if (!sessionId) return;
      this.reviews.delete(sessionId);
      if (sessionId === this._sseSessionId) this._teardownSse();
      if (sessionId === this.activeSessionId) { this._renderQueue(); this._hide(); this._updateReopenBadge(); }
      this._emitState();
    }

    // Server-driven dismiss/show (C-P0-3): another device (or the artifact_dismiss
    // tool) changed panel visibility. Mirror it so all viewers agree.
    dismissedByServer(message) {
      const sessionId = message && message.sessionId ? String(message.sessionId) : this.activeSessionId;
      if (!sessionId) return;
      const review = this.reviews.get(sessionId);
      if (review) review.dismissed = !!(message && message.dismissed);
      if (sessionId !== this.activeSessionId) return;
      if (review && review.dismissed) { this._collapsed = true; this._hide(); }
      else { this._collapsed = false; if (this.reviews.has(sessionId)) this._show(sessionId); }
      this._updateReopenBadge();
      this._emitState();
    }

    notifyActiveSessionChanged(sessionId) {
      this.activeSessionId = sessionId ? String(sessionId) : null;
      this._cancelPendingSnapshot();
      const review = this._activeReview();
      // Per-session state (C-P0-2): do NOT clear the queue or wipe chat on switch.
      // A dismissed review stays hidden (badge shown); otherwise show + repaint.
      if (this.activeSessionId && review && !review.dismissed) this._show(this.activeSessionId);
      else this._hide();
      this._updateReopenBadge();
    }

    _cancelPendingSnapshot() {
      if (this._snapshotTimer) { clearTimeout(this._snapshotTimer); this._snapshotTimer = null; }
      this._snapshotPending = false;
      this._snapshotSession = null;
    }

    // ---- show / hide -----------------------------------------------------
    _show(sessionId) {
      const review = this.reviews.get(sessionId);
      if (!review) return;
      if (this._iframe.getAttribute('data-session') !== sessionId) {
        this._iframe.setAttribute('data-session', sessionId);
        this._iframe.src = review.viewUrl;
      }
      // Repaint per-session chat + queue (never wipe to empty on switch/re-open).
      this._repaintChat(review);
      this._renderQueue();
      this._connectSse(sessionId);
      // Rehydrate from the server ONLY on a first, empty render of this session in
      // this client (fresh load / reload). During live use chat is client-owned,
      // so we never re-fetch and can't double-render.
      if (!review.chat || review.chat.length === 0) this._loadHistory(sessionId);
      this._collapsed = false;
      review.dismissed = false;
      this.el.hidden = false;
      this._updateReopenBadge();
      // Now that the panel is visible (and measurable), pull any off-screen
      // persisted position back into the wrapper so the header stays grabbable.
      this._clampToBounds();
    }
    _hide() {
      this.el.hidden = true;
      this._teardownSse();
    }
    // × dismiss: server-authoritative hide, review stays alive, re-open badge shown.
    collapse() {
      this._collapsed = true;
      const sessionId = this.activeSessionId;
      const review = this._activeReview();
      if (review) review.dismissed = true;
      if (sessionId) this._post('/dismiss', sessionId, { dismissed: true });
      this._hide();
      this._updateReopenBadge();
      this._emitState();
    }
    expand() {
      this._collapsed = false;
      const sessionId = this.activeSessionId;
      const review = this._activeReview();
      if (review) review.dismissed = false;
      if (sessionId && this.reviews.has(sessionId)) {
        this._post('/dismiss', sessionId, { dismissed: false });
        this._show(sessionId);
      }
      this._updateReopenBadge();
      this._emitState();
    }
    _updateReopenBadge() {
      if (!this._reopenBadge) return;
      const review = this._activeReview();
      const show = !!(review && review.dismissed);
      this._reopenBadge.hidden = !show;
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
    // tab's iframe is cache-busted; the chat/queue box is untouched.
    reloadReview(message) {
      const sessionId = message && message.sessionId ? String(message.sessionId) : this.activeSessionId;
      if (!sessionId || sessionId !== this.activeSessionId || !this.reviews.has(sessionId)) return;
      this.reload();
    }

    _onIframeLoad() {
      const sessionId = this.activeSessionId;
      if (!sessionId || !this.reviews.has(sessionId)) return;
      const review = this.reviews.get(sessionId);
      // Replay the pre-reload scroll position so hot reloads don't jump to top.
      const scroll = (review && review.scroll) || { x: 0, y: 0 };
      this._postToIframe('restore-scroll', { x: scroll.x, y: scroll.y });
      this._postToIframe('set-annotation-mode', { enabled: true });
    }

    // ---- iframe <-> server bridge ----------------------------------------
    _handleIframeMessage(event) {
      const data = event && event.data;
      if (!data || data.source !== SDK_SOURCE_IN) return;
      // Authenticate the sender: only our own artifact iframe may drive the
      // queue / network. A foreign window that knows the source string can't
      // spoof annotations or trigger an authed POST. (lavish chrome pattern.)
      if (!this._iframe || event.source !== this._iframe.contentWindow) return;
      const sessionId = data.sessionId ? String(data.sessionId) : this.activeSessionId;
      if (!sessionId || !this.reviews.has(sessionId) || sessionId !== this.activeSessionId) return;
      const payload = data.payload || {};

      if (data.type === 'artifact-ready') {
        const review = this.reviews.get(sessionId);
        if (review) review.ready = true;
        return;
      }
      if (data.type === 'artifact-annotation-queued') {
        if (payload.annotation) this._enqueueAnnotation(payload.annotation);
        return;
      }
      if (data.type === 'artifact-annotations-send') {
        this._sendQueue(payload.domSnapshot);
        return;
      }
      if (data.type === 'artifact-snapshot') {
        // Reply to a panel-initiated snapshot request: flush the queue with it,
        // but only if we still have a request pending for the CURRENT session.
        if (this._snapshotPending) {
          if (this._snapshotTimer) { clearTimeout(this._snapshotTimer); this._snapshotTimer = null; }
          this._snapshotPending = false;
          if (this._snapshotSession === this.activeSessionId) this._sendQueue(payload.domSnapshot);
        }
        return;
      }
      if (data.type === 'artifact-scroll') {
        const review = this.reviews.get(sessionId);
        if (review) review.scroll = { x: Number(payload.x) || 0, y: Number(payload.y) || 0 };
        return;
      }
      if (data.type === 'artifact-action') {
        this._handleAction(sessionId, payload);
        return;
      }
      // Legacy message types (backward-compat with the pre-annotation SDK and
      // existing artifacts). 'artifact-prompts' POSTs immediately (the old
      // contract had no queue); 'artifact-layout-warnings' forwards to the
      // layout-warnings endpoint. The new annotation API is primary; these stay
      // so older artifacts still deliver feedback to /poll.
      if (data.type === 'artifact-prompts') {
        const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
        if (prompts.length) {
          this._post('/prompts', sessionId, { prompts, domSnapshot: payload.domSnapshot });
          prompts.forEach((p) => this._appendChat('you', typeof p === 'string' ? p : (p && (p.prompt || p.text)) || JSON.stringify(p)));
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
      }).then(
        (res) => !!(res && res.ok),
        () => false
      );
    }

    // ---- annotation queue + pills (per-session; C-P0-2) ------------------
    _enqueueAnnotation(annotation) {
      if (!annotation || typeof annotation !== 'object') return;
      const review = this._activeReview();
      if (!review) return;
      if (!Array.isArray(review.queue)) review.queue = [];
      review.queue.push(annotation);
      this._renderQueue();
    }
    _clearQueue() {
      const review = this._activeReview();
      if (review) review.queue = [];
      this._renderQueue();
    }
    _renderQueue() {
      if (!this._pills) return;
      const review = this._activeReview();
      const queue = (review && Array.isArray(review.queue)) ? review.queue : [];
      this._pills.innerHTML = '';
      queue.forEach((annotation, index) => {
        const label = (annotation.prompt || annotation.text || annotation.selector || 'annotation').toString();
        const pill = el('div', { class: 'artifact-panel__pill' });
        const preview = el('span', { class: 'artifact-panel__pill-text', title: annotation.selector || '', text: label });
        const remove = el('button', { class: 'artifact-panel__pill-x', type: 'button', 'aria-label': 'Remove queued annotation', text: '×' });
        remove.addEventListener('click', () => { queue.splice(index, 1); this._renderQueue(); });
        pill.appendChild(preview);
        pill.appendChild(remove);
        this._pills.appendChild(pill);
      });
      this._pillBar.hidden = queue.length === 0;
      if (this._sendBtn) this._sendBtn.disabled = queue.length === 0 || this._presence === 'working';
    }
    // Panel "Send to agent": ask the iframe SDK for a live DOM snapshot, then
    // flush the queue with it — so panel-Send carries the same context the SDK's
    // own Cmd/Ctrl+Enter send does. Falls back to sending without a snapshot if
    // the iframe doesn't reply promptly (sandboxed / not ready).
    _sendQueueWithSnapshot() {
      const review = this._activeReview();
      const sessionId = this.activeSessionId;
      if (!sessionId || !review || !Array.isArray(review.queue) || review.queue.length === 0) return;
      if (this._snapshotPending) return; // a request is already in flight
      this._snapshotPending = true;
      this._snapshotSession = sessionId;
      this._postToIframe('request-snapshot', {});
      this._snapshotTimer = setTimeout(() => {
        this._snapshotTimer = null;
        if (!this._snapshotPending) return;
        this._snapshotPending = false;
        // Bail if the user switched sessions while we waited — don't flush a
        // different session's queue.
        if (this._snapshotSession !== this.activeSessionId) return;
        this._sendQueue(); // no snapshot — it is optional metadata
      }, 250);
    }
    _sendQueue(domSnapshot) {
      const sessionId = this.activeSessionId;
      const review = this._activeReview();
      if (!sessionId || !review || !Array.isArray(review.queue) || review.queue.length === 0) return;
      const prompts = review.queue.slice();
      // Optimistically clear so the pills reflect "sending"; restore them to the
      // FRONT of the queue if the POST fails (network error or non-2xx) so the
      // user's annotations are never silently lost and can be retried.
      review.queue = [];
      this._renderQueue();
      prompts.forEach((p) => this._appendChat('you', (p && (p.prompt || p.text)) ? String(p.prompt || p.text) : JSON.stringify(p)));
      if (this._presence === 'listening') this._setPresence('working');
      let settle;
      try {
        settle = this._post('/prompts', sessionId, { prompts, domSnapshot: domSnapshot });
      } catch (err) {
        // A synchronous failure (e.g. JSON.stringify on a bad payload) must still
        // clear the optimistic 'working' state and restore the queue.
        settle = Promise.resolve(false);
      }
      settle.then((ok) => {
        // Only touch presence/queue if this is still the SAME active session — a
        // stale resolution after a tab switch must not mutate the new session.
        if (sessionId !== this.activeSessionId) return;
        // Clear the optimistic 'working' state once the round-trip settles so
        // Send is never left permanently disabled (an agent-reply also clears it,
        // but the POST may complete with no reply, or fail).
        if (this._presence === 'working') this._setPresence('listening');
        if (ok) return;
        const cur = this._activeReview();
        if (cur) { cur.queue = prompts.concat(Array.isArray(cur.queue) ? cur.queue : []); }
        this._renderQueue();
        this._appendChat('agent', 'Could not send your annotations. They were restored to the queue — press Send to retry.');
      });
    }

    // Note composer: restore the note + surface a retry on POST failure (C-P0-7),
    // mirroring _sendQueue — a dropped note is never silently lost.
    _submitNote() {
      const sessionId = this.activeSessionId;
      const text = (this._chatInput.value || '').trim();
      if (!text || !sessionId) return;
      this._chatInput.value = '';
      this._appendChat('you', text);
      let settle;
      try {
        settle = this._post('/prompts', sessionId, { prompts: [text] });
      } catch (err) {
        settle = Promise.resolve(false);
      }
      settle.then((ok) => {
        if (ok) return;
        // Restore the note into the composer so the user can retry.
        if (sessionId === this.activeSessionId && !(this._chatInput.value || '').trim()) {
          this._chatInput.value = text;
        }
        this._appendChat('agent', 'Could not send your note — it was restored to the box. Press Send to retry.');
      });
    }

    // ---- chat (per-session; single render path via SSE) -------------------
    // Record + render a locally-originated chat line (optimistic 'you' sends and
    // local status notices). Agent replies arrive via _applyAgentReply (id-deduped).
    _appendChat(role, text) {
      const review = this._activeReview();
      const entry = { role, text: String(text) };
      if (review) { if (!Array.isArray(review.chat)) review.chat = []; review.chat.push(entry); }
      this._renderChatEntry(entry);
    }
    _renderChatEntry(entry) {
      const role = entry.role === 'agent' ? 'agent' : 'you';
      const line = el('div', { class: 'artifact-panel__msg artifact-panel__msg--' + role });
      line.appendChild(el('span', { class: 'artifact-panel__role', text: role }));
      line.appendChild(el('span', { class: 'artifact-panel__text', text: String(entry.text) }));
      this._chatLog.appendChild(line);
      this._chatLog.scrollTop = this._chatLog.scrollHeight;
    }
    _repaintChat(review) {
      this._chatLog.innerHTML = '';
      const chat = (review && Array.isArray(review.chat)) ? review.chat : [];
      chat.forEach((entry) => this._renderChatEntry(entry));
    }
    // Apply an agent reply from SSE, de-duplicated by server event id so the
    // native EventSource reconnect replay (Last-Event-ID) can't render it twice.
    _applyAgentReply(sessionId, id, text) {
      const review = this.reviews.get(sessionId);
      if (!review) return;
      const numId = Number(id);
      if (Number.isFinite(numId) && numId > 0) {
        if (numId <= (review.chatCursor || 0)) return; // already seen
        review.chatCursor = numId;
      }
      if (!Array.isArray(review.chat)) review.chat = [];
      const entry = { role: 'agent', text: String(text == null ? '' : text), id: id };
      review.chat.push(entry);
      if (sessionId === this.activeSessionId) {
        this._renderChatEntry(entry);
        this._postToIframe('agent-reply', { text: entry.text });
        if (this._presence === 'working') this._setPresence('listening');
      }
    }
    // Rehydrate chat from the server on a first/empty render (fresh load / reload).
    // De-dupes agent replies by id against chatCursor so a later SSE frame for the
    // same reply is ignored.
    _loadHistory(sessionId) {
      const url = this._authUrl('/history', sessionId);
      fetch(url, { headers: this._authHeaders() }).then(
        (res) => (res && res.ok ? res.json() : null),
        () => null
      ).then((data) => {
        if (!data || sessionId !== this.activeSessionId) return;
        const review = this.reviews.get(sessionId);
        if (!review) return;
        const hist = Array.isArray(data.chat) ? data.chat.map((c) => ({
          role: c.role === 'agent' ? 'agent' : 'you',
          text: String(c.text == null ? '' : c.text),
          id: c.id,
        })) : [];
        // MERGE with any live entries that landed during the fetch, de-duped by id,
        // so a reply arriving mid-fetch can't discard the prior history (or be
        // dropped). History is the authoritative prefix; live-only entries follow.
        const histIds = new Set(hist.filter((c) => c.id != null).map((c) => String(c.id)));
        const live = (Array.isArray(review.chat) ? review.chat : [])
          .filter((c) => c.id == null || !histIds.has(String(c.id)));
        review.chat = hist.concat(live);
        // Advance the cursor past the highest agent-reply id we now hold so SSE
        // won't re-add any of them.
        review.chatCursor = review.chat.reduce((m, c) => {
          const n = Number(c.id);
          return (c.role === 'agent' && Number.isFinite(n)) ? Math.max(m, n) : m;
        }, review.chatCursor || 0);
        this._repaintChat(review);
      });
    }

    // ---- structured actions (data-aod-*; C-P1-3) --------------------------
    // Handle an 'artifact-action' from the iframe SDK: optimistically reflect the
    // step/selection state back into the artifact, echo to chat, and POST the
    // structured action to /actions (the server routes approvals or drains it).
    _handleAction(sessionId, payload) {
      if (!payload || sessionId !== this.activeSessionId) return;
      const review = this._activeReview();
      if (!review) return;
      const action = { action: String(payload.action || ''), elementId: String(payload.elementId || '') };
      if (!action.action || !action.elementId) return;
      if (typeof payload.value === 'string') action.value = payload.value;
      if (typeof payload.group === 'string') action.group = payload.group;
      if (Array.isArray(payload.selected)) action.selected = payload.selected;
      const ctx = payload.context || {};
      if (typeof ctx.selector === 'string') action.selector = ctx.selector;
      if (typeof ctx.sourceLine === 'number') action.sourceLine = ctx.sourceLine;

      // Optimistic plan-state reflect back into the iframe.
      if (!review.planState) review.planState = {};
      const stateMap = { approve: 'approved', reject: 'rejected', choose: 'approved', submit: 'done' };
      const steps = [];
      const setState = (id, st) => { review.planState[id] = st; steps.push({ elementId: id, state: st }); };
      if (action.action === 'submit' && Array.isArray(action.selected)) {
        action.selected.forEach((s) => { if (s && s.elementId) setState(String(s.elementId), 'done'); });
        setState(action.elementId, 'done');
      } else {
        setState(action.elementId, stateMap[action.action] || 'done');
      }
      this._postToIframe('plan-state', { steps });

      // Echo to chat for visibility.
      const label = action.action === 'submit'
        ? 'submitted ' + (action.group || '') + ' (' + (Array.isArray(action.selected) ? action.selected.length : 0) + ' selected)'
        : action.action + ': ' + action.elementId + (action.value ? ' = ' + action.value : '');
      this._appendChat('you', '[' + label + ']');

      this._post('/actions', sessionId, { actions: [action], domSnapshot: payload.domSnapshot });
    }

    // ---- presence ---------------------------------------------------------
    _setPresence(state) {
      this._presence = (state === 'listening' || state === 'working') ? state : 'waiting';
      if (this._refs && this._refs.presence) {
        const label = this._presence === 'working' ? 'Working…'
          : this._presence === 'listening' ? 'Listening'
          : 'Waiting';
        this._refs.presence.textContent = label;
        this._refs.presence.setAttribute('data-state', this._presence);
      }
      const review = this._activeReview();
      const queueLen = (review && Array.isArray(review.queue)) ? review.queue.length : 0;
      if (this._sendBtn) this._sendBtn.disabled = queueLen === 0 || this._presence === 'working';
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
        if (d && typeof d.text === 'string') {
          // SSE is the SOLE render path (C-P0-1); id-deduped so the native
          // EventSource reconnect replay can't double-render (C-P0-4).
          this._applyAgentReply(sessionId, d.id, d.text);
        }
      });
      src.addEventListener('presence', (e) => {
        const d = this._parse(e.data);
        const presence = (d && d.presence) || {};
        // SSE presence carries { connected, lastSeen, ... }. Map to a coarse
        // agent state when available, else just reflect connectivity.
        if (typeof presence.state === 'string') this._setPresence(presence.state);
        else if (presence.connected) this._setPresence('listening');
        else this._setPresence('waiting');
        this._postToIframe('presence', presence);
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
        this.onStateChange({ open: this.isOpenForActive(), collapsed: this._collapsed, minimized: this._minimized });
      }
    }

    destroy() {
      window.removeEventListener('message', this._onWindowMessage);
      if (this._onWindowResize) window.removeEventListener('resize', this._onWindowResize);
      this._teardownSse();
      if (this._dragCleanup) { try { this._dragCleanup(); } catch (_) { /* ignore */ } this._dragCleanup = null; }
      if (this._resizeCleanup) { try { this._resizeCleanup(); } catch (_) { /* ignore */ } this._resizeCleanup = null; }
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = ArtifactPanel;
  if (typeof window !== 'undefined') window.ArtifactPanel = ArtifactPanel;
})();
