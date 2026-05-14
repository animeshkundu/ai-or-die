// file-watcher-client.js — Client-side subscriber for the /api/files/watch
// SSE channel (per ADR-0017 / #100).
//
// One WatcherClient per file-browser session; subscribes to a single
// directory (the panel's current cwd or session.workingDir). The server's
// chokidar watcher emits add / change / unlink for the entire subtree
// recursively, so the single subscription covers all open tabs that live
// under the directory plus the panel's directory listing.
//
// Public API (window.fileWatcherClient.WatcherClient):
//   constructor({ authFetch, getAuthToken })
//   .connect(rootPath)                — open the EventSource
//   .disconnect()                     — close it; clears reconnect timer
//   .isConnected()                    — boolean
//   .currentRoot()                    — the path the live ES is watching
//   .onEvent(handler)                 — register listener; returns off()
//   .switchRoot(newPath)              — disconnect + reconnect at new path
//                                       (used when FileBrowserPanel navigates
//                                       to a different dir; cheaper than
//                                       letting handlers swap on their own)
//
// Reconnect strategy: explicit `eventSource.close()` on `.onerror` to
// avoid the browser's default 3s reconnect storm against 429 / 5xx, then
// our own exponential backoff (1s, 2s, 4s, capped at 30s). On successful
// reopen the backoff resets to 1s. Caller-driven disconnect (`disconnect()`)
// suppresses any pending reconnect.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var WATCH_ENDPOINT = '/api/files/watch';
  var INITIAL_RECONNECT_MS = 1000;
  var MAX_RECONNECT_MS = 30000;

  // Event types we expect from the server (per ADR-0017 / 36856af).
  // Anything outside this set is ignored — defensive against future server
  // additions that the client doesn't yet understand.
  var KNOWN_EVENT_TYPES = ['start', 'add', 'change', 'unlink', 'error', 'end'];

  // ---------------------------------------------------------------------------
  // Pure helpers (testable under Node)
  // ---------------------------------------------------------------------------

  // Build the SSE URL for a watch root + auth token. Pure string assembly.
  function buildWatchUrl(rootPath, token) {
    if (!rootPath) return '';
    var url = WATCH_ENDPOINT + '?path=' + encodeURIComponent(String(rootPath));
    if (token) url += '&token=' + encodeURIComponent(String(token));
    return url;
  }

  // True if the event payload looks valid enough to forward to handlers.
  // Defensive against future-server payload-shape drift; keeps malformed
  // events from crashing handlers.
  function isValidEvent(data) {
    if (!data || typeof data !== 'object') return false;
    if (KNOWN_EVENT_TYPES.indexOf(data.type) === -1) return false;
    // Path-bearing events MUST carry a string path; type-only events
    // (start / end) don't.
    if (data.type === 'add' || data.type === 'change' || data.type === 'unlink') {
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
        isValidEvent: isValidEvent,
        WATCH_ENDPOINT: WATCH_ENDPOINT,
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
    this.getAuthToken = typeof options.getAuthToken === 'function'
      ? options.getAuthToken
      : function () {
          // Default: use AuthManager#appendAuthToUrl-equivalent token read.
          if (window.authManager && window.authManager.token) return window.authManager.token;
          if (window.auth && window.auth.token) return window.auth.token;
          try { return window.sessionStorage && window.sessionStorage.getItem('cc-web-token'); }
          catch (_) { return null; }
        };

    this._es = null;
    this._currentRoot = null;
    this._handlers = [];
    this._reconnectTimer = null;
    this._reconnectDelay = INITIAL_RECONNECT_MS;
    this._destroyed = false;
    this._disconnectRequested = false; // suppresses reconnect after explicit disconnect
  }

  WatcherClient.prototype.isConnected = function () { return !!this._es; };

  WatcherClient.prototype.currentRoot = function () { return this._currentRoot; };

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
    if (this._currentRoot === rootPath && this._es) return true;
    this._tearDownEventSource();
    this._currentRoot = rootPath;
    this._disconnectRequested = false;
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
  };

  WatcherClient.prototype.switchRoot = function (newPath) {
    if (newPath === this._currentRoot) return;
    this.disconnect();
    if (newPath) this.connect(newPath);
  };

  WatcherClient.prototype.destroy = function () {
    this._destroyed = true;
    this.disconnect();
    this._handlers = [];
  };

  // ---- Internal ----

  WatcherClient.prototype._open = function () {
    if (this._destroyed || !this._currentRoot) return;
    if (typeof window.EventSource === 'undefined') return; // no support → silent

    var url = buildWatchUrl(this._currentRoot, this.getAuthToken());
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
      // Successful open resets the backoff. Don't fire a synthetic 'start'
      // event here — the server emits its own.
      self._reconnectDelay = INITIAL_RECONNECT_MS;
    };

    es.onmessage = function (evt) {
      if (self._destroyed || self._es !== es) return;
      var data;
      try { data = JSON.parse(evt.data); } catch (_) { return; }
      if (!isValidEvent(data)) return;
      // Fan out to handlers; defensive try/catch so one bad handler
      // doesn't break the rest.
      for (var i = 0; i < self._handlers.length; i++) {
        try { self._handlers[i](data); } catch (_) { /* swallow */ }
      }
      // Server-side `end` means the channel is closing for this connect
      // cycle; trigger a reconnect if not user-initiated.
      if (data.type === 'end') {
        self._tearDownEventSource();
        if (!self._disconnectRequested) self._scheduleReconnect();
      }
    };

    es.onerror = function () {
      if (self._destroyed || self._es !== es) return;
      // Browser auto-reconnects on errors by default — explicit close
      // prevents a hammering loop against a 429 / 5xx. Our own backoff
      // takes over.
      self._tearDownEventSource();
      if (!self._disconnectRequested) self._scheduleReconnect();
    };
  };

  WatcherClient.prototype._tearDownEventSource = function () {
    if (this._es) {
      try { this._es.close(); } catch (_) { /* ignore */ }
      this._es = null;
    }
  };

  WatcherClient.prototype._scheduleReconnect = function () {
    if (this._destroyed || this._disconnectRequested) return;
    if (!this._currentRoot) return;
    if (this._reconnectTimer) return; // already scheduled
    var self = this;
    var delay = this._reconnectDelay;
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      // Exponential backoff capped at MAX_RECONNECT_MS.
      self._reconnectDelay = Math.min(self._reconnectDelay * 2, MAX_RECONNECT_MS);
      self._open();
    }, delay);
  };

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var exportsObj = {
    WatcherClient: WatcherClient,
    buildWatchUrl: buildWatchUrl,
    isValidEvent: isValidEvent,
    WATCH_ENDPOINT: WATCH_ENDPOINT,
    KNOWN_EVENT_TYPES: KNOWN_EVENT_TYPES,
    INITIAL_RECONNECT_MS: INITIAL_RECONNECT_MS,
    MAX_RECONNECT_MS: MAX_RECONNECT_MS,
  };

  window.fileWatcherClient = exportsObj;
  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
})();
