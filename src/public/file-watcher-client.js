// file-watcher-client.js — Client-side subscriber for /api/files/watch
// (per ADR-0017 amendment, server-side at ff79038).
//
// Architecture:
//   - ONE EventSource per file-browser session at
//     `GET /api/files/watch?session=<id>&path=<rootDir>&token=<auth>`.
//   - Path-level subscriptions via
//     `POST /api/files/watch/subscribe?session=<id>&path=<abs>` and
//     `/unsubscribe`. Server filters events to only the subscribed paths.
//   - Multiplexes any number of file paths over the single SSE so the
//     client never hits Chromium's 6-EventSource-per-origin cap.
//
// Subscription lifecycle:
//   - subscribe(path)   → POST on transition 0→1 (refcount-based — same
//                          path may be subscribed by both the listing and
//                          a tab; we want both to release before the
//                          server-side subscription is dropped).
//   - unsubscribe(path) → POST on transition 1→0.
//   - On reconnect, the server-side subscription Set is fresh; we
//     re-issue subscribe for every path with refcount > 0 once the
//     ES emits its `start` event again.
//   - Subscribes called before `start` are queued and drained after.
//
// Public API (window.fileWatcherClient.WatcherClient):
//   constructor({ getAuthToken?, getSessionId?, authFetch })
//   .connect(rootPath)                — open the EventSource (no-op if
//                                        already connected to same root)
//   .disconnect()                     — close ES; clears reconnect timer
//                                        AND the client-side subscription
//                                        refcounts (server-side is gone
//                                        with the session entry anyway)
//   .subscribe(path)                  → Promise<boolean>  fires POST on
//                                        0→1 transition; resolves true on
//                                        2xx. Same path-from-different-
//                                        callers is refcounted.
//   .unsubscribe(path)                → Promise<boolean>  fires POST on
//                                        1→0; idempotent server-side.
//   .onEvent(handler)                 → off()  register listener
//   .isConnected() / .isReady()       → state queries
//   .currentRoot() / .currentSession() → introspection
//   .destroy()                        — full teardown
//
// Reconnect strategy: explicit `eventSource.close()` on `.onerror` to
// avoid the browser's default 3s reconnect storm; our own exponential
// backoff (1s → 2s → 4s, capped at 30s). Successful open resets the
// backoff. Re-subscribes happen automatically after the post-reconnect
// `start` event.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var WATCH_ENDPOINT = '/api/files/watch';
  var SUBSCRIBE_ENDPOINT = '/api/files/watch/subscribe';
  var UNSUBSCRIBE_ENDPOINT = '/api/files/watch/unsubscribe';
  var INITIAL_RECONNECT_MS = 1000;
  var MAX_RECONNECT_MS = 30000;

  var KNOWN_EVENT_TYPES = ['start', 'add', 'change', 'unlink', 'rename', 'error', 'end'];

  // ---------------------------------------------------------------------------
  // Pure helpers (testable under Node)
  // ---------------------------------------------------------------------------

  // Build the SSE URL for a session + watch root + auth token.
  function buildWatchUrl(sessionId, rootPath, token) {
    if (!sessionId || !rootPath) return '';
    var url = WATCH_ENDPOINT +
      '?session=' + encodeURIComponent(String(sessionId)) +
      '&path=' + encodeURIComponent(String(rootPath));
    if (token) url += '&token=' + encodeURIComponent(String(token));
    return url;
  }

  // Build the subscribe / unsubscribe URL.
  function buildControlUrl(action, sessionId, path, token) {
    var endpoint = action === 'unsubscribe' ? UNSUBSCRIBE_ENDPOINT : SUBSCRIBE_ENDPOINT;
    if (!sessionId || !path) return '';
    var url = endpoint +
      '?session=' + encodeURIComponent(String(sessionId)) +
      '&path=' + encodeURIComponent(String(path));
    if (token) url += '&token=' + encodeURIComponent(String(token));
    return url;
  }

  // Forward-slash-normalize a path so client-side comparisons match
  // server-side `validatePath` output (server normalizes to forward
  // slashes regardless of platform input).
  function normalizePath(p) {
    if (!p) return '';
    return String(p).replace(/\\/g, '/');
  }

  // Validates an SSE event payload against the known types + required
  // fields. Defensive against future server-payload drift; malformed
  // events are silently ignored upstream.
  function isValidEvent(data) {
    if (!data || typeof data !== 'object') return false;
    if (KNOWN_EVENT_TYPES.indexOf(data.type) === -1) return false;
    if (data.type === 'add' || data.type === 'change' ||
        data.type === 'unlink' || data.type === 'rename') {
      if (typeof data.path !== 'string' || !data.path) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Browser-only beyond this point
  // ---------------------------------------------------------------------------

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        buildWatchUrl: buildWatchUrl,
        buildControlUrl: buildControlUrl,
        normalizePath: normalizePath,
        isValidEvent: isValidEvent,
        WATCH_ENDPOINT: WATCH_ENDPOINT,
        SUBSCRIBE_ENDPOINT: SUBSCRIBE_ENDPOINT,
        UNSUBSCRIBE_ENDPOINT: UNSUBSCRIBE_ENDPOINT,
        KNOWN_EVENT_TYPES: KNOWN_EVENT_TYPES,
      };
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // WatcherClient
  // ---------------------------------------------------------------------------

  function WatcherClient(options) {
    options = options || {};
    this.authFetch = typeof options.authFetch === 'function'
      ? options.authFetch
      : (typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : null);
    this.getAuthToken = typeof options.getAuthToken === 'function'
      ? options.getAuthToken
      : function () {
          if (window.authManager && window.authManager.token) return window.authManager.token;
          if (window.auth && window.auth.token) return window.auth.token;
          try { return window.sessionStorage && window.sessionStorage.getItem('cc-web-token'); }
          catch (_) { return null; }
        };
    this.getSessionId = typeof options.getSessionId === 'function'
      ? options.getSessionId
      : function () { return 'default'; };

    this._es = null;
    this._currentRoot = null;
    this._currentSession = null;
    this._handlers = [];
    this._reconnectTimer = null;
    this._reconnectDelay = INITIAL_RECONNECT_MS;
    this._destroyed = false;
    this._disconnectRequested = false;
    this._ready = false;                 // true after `start` event arrives
    this._subscriptionRefs = {};         // path → refcount
    this._pendingControl = [];           // queue of {action, path} until ready
  }

  WatcherClient.prototype.isConnected = function () { return !!this._es; };
  WatcherClient.prototype.isReady = function () { return this._ready; };
  WatcherClient.prototype.currentRoot = function () { return this._currentRoot; };
  WatcherClient.prototype.currentSession = function () { return this._currentSession; };

  WatcherClient.prototype.onEvent = function (handler) {
    if (typeof handler !== 'function') return function () {};
    var self = this;
    this._handlers.push(handler);
    return function off() {
      var i = self._handlers.indexOf(handler);
      if (i !== -1) self._handlers.splice(i, 1);
    };
  };

  WatcherClient.prototype.connect = function (rootPath) {
    if (this._destroyed) return false;
    if (!rootPath) return false;
    var sessionId = this.getSessionId();
    if (!sessionId) return false;

    if (this._es && this._currentRoot === rootPath && this._currentSession === sessionId) {
      return true;
    }
    this._tearDownEventSource();
    this._currentRoot = rootPath;
    this._currentSession = sessionId;
    this._disconnectRequested = false;
    this._ready = false;
    this._open();
    return true;
  };

  WatcherClient.prototype.disconnect = function () {
    this._disconnectRequested = true;
    this._tearDownEventSource();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectDelay = INITIAL_RECONNECT_MS;
    this._currentRoot = null;
    this._currentSession = null;
    this._ready = false;
    this._subscriptionRefs = {};
    this._pendingControl = [];
  };

  WatcherClient.prototype.destroy = function () {
    this._destroyed = true;
    this.disconnect();
    this._handlers = [];
  };

  // Refcount-based subscribe — same path subscribed twice from different
  // callers (listing + tab, two tabs of the same file) only POSTs once.
  // Server-side subscribe is idempotent so the duplicate-POST cost is
  // bounded, but skipping the call entirely keeps network noise down.
  WatcherClient.prototype.subscribe = function (path) {
    if (this._destroyed || !path) return Promise.resolve(false);
    var key = normalizePath(path);
    var prev = this._subscriptionRefs[key] || 0;
    this._subscriptionRefs[key] = prev + 1;
    if (prev > 0) return Promise.resolve(true); // already subscribed; no POST
    return this._sendControl('subscribe', key);
  };

  WatcherClient.prototype.unsubscribe = function (path) {
    if (this._destroyed || !path) return Promise.resolve(false);
    var key = normalizePath(path);
    var prev = this._subscriptionRefs[key] || 0;
    if (prev === 0) return Promise.resolve(true); // not subscribed; no-op
    this._subscriptionRefs[key] = prev - 1;
    if (prev > 1) return Promise.resolve(true); // still subscribed by others
    delete this._subscriptionRefs[key];
    return this._sendControl('unsubscribe', key);
  };

  // Read the live subscription set (for diagnostics / tests / replay-on-
  // reconnect).
  WatcherClient.prototype.subscribedPaths = function () {
    return Object.keys(this._subscriptionRefs);
  };

  // ---- Internal ----

  WatcherClient.prototype._open = function () {
    if (this._destroyed || !this._currentRoot || !this._currentSession) return;
    if (typeof window.EventSource === 'undefined') return;

    var url = buildWatchUrl(this._currentSession, this._currentRoot, this.getAuthToken());
    var self = this;
    var es;
    try {
      es = new window.EventSource(url);
    } catch (_) {
      this._scheduleReconnect();
      return;
    }
    this._es = es;

    es.onopen = function () {
      self._reconnectDelay = INITIAL_RECONNECT_MS;
      // `_ready` flips on `start` event, not on TCP open — server may
      // emit start a few ms after accepting. Subscribe POSTs queue
      // until then.
    };

    es.onmessage = function (evt) {
      if (self._destroyed || self._es !== es) return;
      var data;
      try { data = JSON.parse(evt.data); } catch (_) { return; }
      if (!isValidEvent(data)) return;

      if (data.type === 'start') {
        self._ready = true;
        // Drain pending control calls + replay all known subscriptions
        // (handles BOTH the initial connect AND post-reconnect re-sync
        // since the server's subscription Set is fresh for each session
        // entry — the server creates a new one when 1st EventSource for
        // a session lands, and tears it down when ES closes).
        self._replayAfterReady();
      }

      // Fan out to handlers.
      for (var i = 0; i < self._handlers.length; i++) {
        try { self._handlers[i](data); } catch (_) { /* swallow */ }
      }

      if (data.type === 'end') {
        // Server-initiated end. `replaced` means a 2nd ES for the same
        // session displaced us; we shouldn't reconnect (the new client
        // owns the session). For other reasons, reconnect.
        var displaced = data.reason === 'replaced';
        self._tearDownEventSource();
        if (!self._disconnectRequested && !displaced) self._scheduleReconnect();
      }
    };

    es.onerror = function () {
      if (self._destroyed || self._es !== es) return;
      self._tearDownEventSource();
      if (!self._disconnectRequested) self._scheduleReconnect();
    };
  };

  WatcherClient.prototype._tearDownEventSource = function () {
    if (this._es) {
      try { this._es.close(); } catch (_) { /* ignore */ }
      this._es = null;
    }
    this._ready = false;
  };

  WatcherClient.prototype._scheduleReconnect = function () {
    if (this._destroyed || this._disconnectRequested) return;
    if (!this._currentRoot || !this._currentSession) return;
    if (this._reconnectTimer) return;
    var self = this;
    var delay = this._reconnectDelay;
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      self._reconnectDelay = Math.min(self._reconnectDelay * 2, MAX_RECONNECT_MS);
      self._open();
    }, delay);
  };

  // Drain queued subscribe/unsubscribe calls AND replay all known
  // subscriptions to the freshly-ready server. The replay is unconditional
  // because the server's per-session subscription Set is recreated on
  // each ES open (the entry is keyed on session id but cleared when the
  // prior ES closed). Refcount-aware: only paths with count > 0 get
  // re-subscribed.
  WatcherClient.prototype._replayAfterReady = function () {
    var self = this;
    // Process the explicit pending queue first so any
    // subscribe-before-ready calls observe their order. Then replay.
    var pending = this._pendingControl.slice();
    this._pendingControl = [];
    for (var i = 0; i < pending.length; i++) {
      this._sendControlImmediate(pending[i].action, pending[i].path);
    }
    var paths = Object.keys(this._subscriptionRefs);
    for (var j = 0; j < paths.length; j++) {
      this._sendControlImmediate('subscribe', paths[j]);
    }
  };

  WatcherClient.prototype._sendControl = function (action, path) {
    // If the watcher isn't ready yet, queue the call to drain on `start`.
    // Server's POST endpoint returns 404 until the EventSource has
    // landed (no-active-watcher); queueing avoids racy 404s on cold
    // connect and is also the natural reconnect-replay path.
    if (!this._ready) {
      this._pendingControl.push({ action: action, path: path });
      return Promise.resolve(true);
    }
    return this._sendControlImmediate(action, path);
  };

  WatcherClient.prototype._sendControlImmediate = function (action, path) {
    if (!this.authFetch || !this._currentSession) return Promise.resolve(false);
    var token = this.getAuthToken();
    var url = buildControlUrl(action, this._currentSession, path, token);
    if (!url) return Promise.resolve(false);
    // Best-effort POST; 404 (no-active-watcher) is benign during
    // reconnect — the next `start` re-replays.
    return this.authFetch(url, { method: 'POST' }).then(
      function (resp) { return resp && (resp.ok || resp.status === 204); },
      function () { return false; }
    );
  };

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var exportsObj = {
    WatcherClient: WatcherClient,
    buildWatchUrl: buildWatchUrl,
    buildControlUrl: buildControlUrl,
    normalizePath: normalizePath,
    isValidEvent: isValidEvent,
    WATCH_ENDPOINT: WATCH_ENDPOINT,
    SUBSCRIBE_ENDPOINT: SUBSCRIBE_ENDPOINT,
    UNSUBSCRIBE_ENDPOINT: UNSUBSCRIBE_ENDPOINT,
    KNOWN_EVENT_TYPES: KNOWN_EVENT_TYPES,
    INITIAL_RECONNECT_MS: INITIAL_RECONNECT_MS,
    MAX_RECONNECT_MS: MAX_RECONNECT_MS,
  };

  window.fileWatcherClient = exportsObj;
  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
})();
