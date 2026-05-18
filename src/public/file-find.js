// file-find.js — Cmd-P "Go to File" fuzzy filename picker.
//
// Reuses SearchPanel's UI shell pattern (input + scrollable results +
// keyboard nav) for the fuzzy-find experience modeled on VS Code /
// Sublime Text's Cmd-P. Backed by the server's GET /api/files/find
// endpoint (rg --files + fuzzysort under the hood — see
// docs/specs/file-browser.md "Fuzzy file-find (Cmd-P)").
//
// Public API (window.fileFind):
//   FindPanel constructor({ containerEl, getAuthToken, getSearchPath,
//                            getSession, onResultClick, onClose,
//                            tabManager, debounceMs, fetchImpl })
//     .open()              — show panel + focus input
//     .close()             — hide + abort any in-flight fetch
//     .destroy()           — full cleanup
//     .isOpen()            — boolean
//     .runQuery(q)         — programmatic query (test seam too)
//
//   buildFindUrl(query, opts)        — pure helper, testable
//   splitBasenameParent(absPath)     — pure helper, testable
//   formatTruncationBanner(resp, n)  — pure helper, testable
//
// Keybinding lives outside this module — app.js binds Cmd/Ctrl+P
// globally and invokes the panel's open() so the panel itself stays
// agnostic of the host wiring (mirrors SearchPanel's posture).
//
// 120 ms debounce + AbortController per keystroke matches the spec.
// Enter opens preview tab; Cmd/Ctrl+Enter opens editor tab — both
// route through the host-supplied `onResultClick({ path, mode })`
// callback so the panel doesn't need a direct TabManager reference.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var FIND_ENDPOINT = '/api/files/find';
  var DEFAULT_DEBOUNCE_MS = 120;
  var DEFAULT_LIMIT = 50;
  var MAX_RENDERED = 200;        // server caps at 200; mirror it client-side.

  // ---------------------------------------------------------------------------
  // Pure helpers (testable under Node)
  // ---------------------------------------------------------------------------

  // Build the GET /api/files/find URL. opts.session is required for the
  // server's per-session rate limiter. opts.path overrides the default
  // (server resolves liveCwd ?? session.workingDir when omitted).
  function buildFindUrl(query, opts) {
    if (!query) return '';
    opts = opts || {};
    var parts = ['q=' + encodeURIComponent(String(query))];
    if (opts.session) parts.push('session=' + encodeURIComponent(String(opts.session)));
    if (opts.path) parts.push('path=' + encodeURIComponent(String(opts.path)));
    if (typeof opts.limit === 'number' && opts.limit > 0) {
      parts.push('limit=' + String(opts.limit | 0));
    }
    if (opts.token) parts.push('token=' + encodeURIComponent(String(opts.token)));
    return FIND_ENDPOINT + '?' + parts.join('&');
  }

  // Split an absolute path into { basename, parent }. Honours both POSIX
  // and Windows separators; for the parent we keep the original separator
  // style for visual fidelity (the user pasted them; they recognise their
  // own path).
  function splitBasenameParent(absPath) {
    if (!absPath) return { basename: '', parent: '' };
    var s = String(absPath);
    // Find the last separator (either / or \).
    var lastSep = -1;
    for (var i = s.length - 1; i >= 0; i--) {
      var c = s.charCodeAt(i);
      if (c === 47 /* / */ || c === 92 /* \ */) { lastSep = i; break; }
    }
    if (lastSep === -1) return { basename: s, parent: '' };
    return { basename: s.slice(lastSep + 1), parent: s.slice(0, lastSep) };
  }

  // Banner text when the server returns truncated=true. Returns null
  // when no truncation occurred so the caller can hide the banner.
  function formatTruncationBanner(resp, shownCount) {
    if (!resp || !resp.truncated) return null;
    var total = resp.totalFound != null ? resp.totalFound : '?';
    var n = shownCount != null ? shownCount : 0;
    return 'Showing top ' + n + ' of ' + total + ' files — refine your search to narrow.';
  }

  // ---------------------------------------------------------------------------
  // dispatchFindHit — Cmd-P → file-browser dispatch helper.
  //
  // Encapsulates the "what to do with a Cmd-P selection" decision so the
  // editor-vs-preview branch can be regression-tested without dragging
  // app.js into a JSDOM scenario. Called from app.js's onResultClick on
  // every Cmd-P activation.
  //
  // Preview mode (default): hand off to FileBrowserPanel.openToFile, which
  //   navigates the panel to the file's parent dir and auto-opens a
  //   preview tab via the existing _onItemClick → _ensureTabManager() →
  //   tabManager.openFile(path, 'preview') chain.
  //
  // Editor mode (Cmd/Ctrl+Enter): force-bootstrap the panel's tabManager
  //   via _ensureTabManager() and open directly with mode='editor'. We
  //   skip openToFile entirely — calling it would open BOTH a preview
  //   tab (from its async onItemClick) AND an editor tab (from us),
  //   and an earlier draft that did `panel._tabManager` synchronously
  //   (without _ensure*) raced with the lazy init and silently degraded
  //   to preview-only on first use (QA finding #6).
  //
  // Pure / sync — accepts any object that quacks like FileBrowserPanel.
  // Defensive against null panel / null hit / missing path. Swallows
  // tabManager.openFile errors (consistent with the rest of file-find's
  // fire-and-forget posture).
  function dispatchFindHit(panel, hit) {
    if (!panel || !hit || !hit.path) return;
    if (hit.mode === 'editor') {
      try {
        if (typeof panel.isOpen === 'function' && !panel.isOpen() &&
            typeof panel.open === 'function') {
          panel.open();
        }
      } catch (_) { /* ignore — we still try the tab open */ }
      if (typeof panel._ensureTabManager !== 'function') return;
      var tm;
      try { tm = panel._ensureTabManager(); } catch (_) { tm = null; }
      if (!tm || typeof tm.openFile !== 'function') return;
      try { tm.openFile(hit.path, 'editor'); } catch (_) { /* ignore */ }
      return;
    }
    // Preview (default).
    if (typeof panel.openToFile === 'function') {
      try { panel.openToFile(hit.path); } catch (_) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Browser-only beyond this point
  // ---------------------------------------------------------------------------

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        FIND_ENDPOINT: FIND_ENDPOINT,
        DEFAULT_DEBOUNCE_MS: DEFAULT_DEBOUNCE_MS,
        DEFAULT_LIMIT: DEFAULT_LIMIT,
        MAX_RENDERED: MAX_RENDERED,
        buildFindUrl: buildFindUrl,
        splitBasenameParent: splitBasenameParent,
        formatTruncationBanner: formatTruncationBanner,
        dispatchFindHit: dispatchFindHit,
      };
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // FindPanel
  // ---------------------------------------------------------------------------

  function FindPanel(options) {
    options = options || {};
    if (!options.containerEl) {
      throw new Error('FindPanel: options.containerEl is required');
    }
    this.containerEl = options.containerEl;
    this.onResultClick = typeof options.onResultClick === 'function'
      ? options.onResultClick
      : function () {};
    this.onClose = typeof options.onClose === 'function'
      ? options.onClose
      : function () {};
    this.getAuthToken = typeof options.getAuthToken === 'function'
      ? options.getAuthToken
      : function () { return null; };
    this.getSearchPath = typeof options.getSearchPath === 'function'
      ? options.getSearchPath
      : function () { return null; };
    this.getSession = typeof options.getSession === 'function'
      ? options.getSession
      : function () { return null; };
    this.debounceMs = typeof options.debounceMs === 'number'
      ? options.debounceMs
      : DEFAULT_DEBOUNCE_MS;
    // Inject fetch impl for tests; default to window.fetch.
    this._fetch = typeof options.fetchImpl === 'function'
      ? options.fetchImpl
      : function (u, o) { return window.fetch(u, o); };

    this._open = false;
    this._destroyed = false;
    this._debounceTimer = null;
    this._abortCtrl = null;
    this._lastResults = [];
    this._focusedIndex = -1;
    this._lastResp = null;

    this._panelEl = null;
    this._inputEl = null;
    this._resultsEl = null;
    this._statusEl = null;
    this._truncEl = null;

    this._buildDOM();
  }

  FindPanel.prototype.isOpen = function () { return !!this._open; };

  FindPanel.prototype._buildDOM = function () {
    var self = this;

    var panel = document.createElement('div');
    panel.className = 'fb-find-panel';
    panel.style.display = 'none';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Go to File');
    this._panelEl = panel;

    var header = document.createElement('div');
    header.className = 'fb-find-panel-header';

    var input = document.createElement('input');
    input.type = 'search';
    input.className = 'fb-find-panel-input';
    input.placeholder = 'Go to File (Cmd/Ctrl+P)';
    input.setAttribute('aria-label', 'Filename to find');
    input.setAttribute('autocomplete', 'off');
    input.addEventListener('input', function () { self._scheduleQuery(); });
    input.addEventListener('keydown', function (e) { self._onInputKeyDown(e); });
    header.appendChild(input);
    this._inputEl = input;

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'fb-find-close';
    closeBtn.title = 'Close (Esc)';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = window.icons ? window.icons.x(14) : '&times;';
    closeBtn.addEventListener('click', function () { self.close(); });
    header.appendChild(closeBtn);

    panel.appendChild(header);

    // Truncation banner — sticky top, hidden by default.
    var trunc = document.createElement('div');
    trunc.className = 'fb-find-truncation';
    trunc.style.display = 'none';
    panel.appendChild(trunc);
    this._truncEl = trunc;

    var status = document.createElement('div');
    status.className = 'fb-find-status';
    status.setAttribute('aria-live', 'polite');
    panel.appendChild(status);
    this._statusEl = status;

    var results = document.createElement('div');
    results.className = 'fb-find-results';
    results.setAttribute('role', 'listbox');
    panel.appendChild(results);
    this._resultsEl = results;

    this.containerEl.appendChild(panel);
  };

  // -- Public API --

  FindPanel.prototype.open = function () {
    if (this._destroyed) return;
    if (this._open) {
      // Re-open while already open (Cmd-P pressed twice) → just refocus.
      try { this._inputEl.focus(); this._inputEl.select(); } catch (_) {}
      return;
    }
    this._open = true;
    this._panelEl.style.display = '';
    this._setStatus('Type to search files in this directory.');
    var self = this;
    setTimeout(function () {
      if (self._inputEl && !self._destroyed) self._inputEl.focus();
    }, 0);
  };

  FindPanel.prototype.close = function () {
    if (!this._open) return;
    this._open = false;
    this._panelEl.style.display = 'none';
    this._abort();
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    try { this.onClose(); } catch (_) { /* ignore */ }
  };

  FindPanel.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    this.close();
    if (this._panelEl && this._panelEl.parentNode) {
      this._panelEl.parentNode.removeChild(this._panelEl);
    }
  };

  FindPanel.prototype.runQuery = function (q) {
    if (this._destroyed) return;
    if (typeof q === 'string') this._inputEl.value = q;
    this._runQueryNow();
  };

  // -- Keyboard --

  FindPanel.prototype._onInputKeyDown = function (e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._moveFocus(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._moveFocus(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      var mode = (e.metaKey || e.ctrlKey) ? 'editor' : 'preview';
      this._activateFocused(mode);
      return;
    }
  };

  FindPanel.prototype._moveFocus = function (delta) {
    if (!this._lastResults.length) return;
    var n = this._lastResults.length;
    var next = this._focusedIndex + delta;
    if (next < 0) next = 0;
    if (next >= n) next = n - 1;
    this._focusedIndex = next;
    this._renderResults();   // cheap re-render to update aria-selected + scroll
  };

  FindPanel.prototype._activateFocused = function (mode) {
    if (this._focusedIndex < 0 || this._focusedIndex >= this._lastResults.length) return;
    var hit = this._lastResults[this._focusedIndex];
    if (!hit || !hit.path) return;
    try { this.onResultClick({ path: hit.path, mode: mode }); } catch (_) { /* ignore */ }
    this.close();
  };

  // -- Query lifecycle --

  FindPanel.prototype._scheduleQuery = function () {
    var self = this;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(function () {
      self._debounceTimer = null;
      self._runQueryNow();
    }, this.debounceMs);
  };

  FindPanel.prototype._runQueryNow = function () {
    if (this._destroyed) return;
    var q = (this._inputEl.value || '').trim();
    // Always abort the prior request — even when the new query is empty
    // we want to drop a stale-result write that could otherwise land
    // after we cleared the panel (re-entrancy hazard from the spec).
    this._abort();

    if (!q) {
      this._lastResults = [];
      this._focusedIndex = -1;
      this._truncEl.style.display = 'none';
      this._renderResults();
      this._setStatus('Type to search files in this directory.');
      return;
    }

    var url = buildFindUrl(q, {
      session: this.getSession() || null,
      path: this.getSearchPath() || null,
      limit: DEFAULT_LIMIT,
      token: this.getAuthToken() || null,
    });

    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    this._abortCtrl = ctrl;
    var self = this;
    this._setStatus('Searching…', true);

    var fetchOpts = {};
    if (ctrl) fetchOpts.signal = ctrl.signal;

    this._fetch(url, fetchOpts).then(function (resp) {
      if (self._destroyed) return null;
      if (self._abortCtrl !== ctrl) return null;
      if (!resp || !resp.ok) {
        if (resp && resp.status === 429) {
          self._setStatus('Rate limited — slow down a bit.', false, true);
          return null;
        }
        self._setStatus('Search failed (' + (resp && resp.status) + ').', false, true);
        return null;
      }
      return resp.json();
    }).then(function (data) {
      if (!data) return;
      if (self._destroyed) return;
      if (self._abortCtrl !== ctrl) return;
      self._abortCtrl = null;
      self._lastResp = data;
      var matches = Array.isArray(data.matches) ? data.matches.slice(0, MAX_RENDERED) : [];
      self._lastResults = matches;
      self._focusedIndex = matches.length ? 0 : -1;
      self._renderResults();
      self._renderTruncation(data, matches.length);
      var msg;
      if (!matches.length) {
        msg = 'No matches.';
      } else {
        msg = matches.length + ' match' + (matches.length === 1 ? '' : 'es');
        if (typeof data.queryMs === 'number') msg += ' (' + data.queryMs + ' ms)';
      }
      self._setStatus(msg);
    }).catch(function (err) {
      if (self._destroyed) return;
      // Swallow AbortError — superseded queries are not user-visible failures.
      if (err && (err.name === 'AbortError' || err.code === 20)) return;
      self._setStatus('Search failed: ' + (err && err.message ? err.message : err), false, true);
    });
  };

  FindPanel.prototype._abort = function () {
    if (this._abortCtrl) {
      try { this._abortCtrl.abort(); } catch (_) { /* ignore */ }
      this._abortCtrl = null;
    }
  };

  // -- Rendering --

  FindPanel.prototype._renderResults = function () {
    var resultsEl = this._resultsEl;
    while (resultsEl.firstChild) resultsEl.removeChild(resultsEl.firstChild);

    var self = this;
    this._lastResults.forEach(function (hit, idx) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'fb-find-result' + (idx === self._focusedIndex ? ' focused' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', idx === self._focusedIndex ? 'true' : 'false');

      var split = splitBasenameParent(hit.path || '');
      var basenameSpan = document.createElement('span');
      basenameSpan.className = 'fb-find-result-basename';
      basenameSpan.textContent = hit.basename || split.basename;
      row.appendChild(basenameSpan);

      if (split.parent) {
        var parentSpan = document.createElement('span');
        parentSpan.className = 'fb-find-result-parent';
        parentSpan.textContent = ' ' + split.parent;
        row.appendChild(parentSpan);
      }

      row.addEventListener('click', function (e) {
        var mode = (e.metaKey || e.ctrlKey) ? 'editor' : 'preview';
        self._focusedIndex = idx;
        self._activateFocused(mode);
      });

      resultsEl.appendChild(row);
    });

    // Scroll the focused row into view.
    if (this._focusedIndex >= 0) {
      var children = resultsEl.children;
      var focusedEl = children && children[this._focusedIndex];
      if (focusedEl && typeof focusedEl.scrollIntoView === 'function') {
        try { focusedEl.scrollIntoView({ block: 'nearest' }); } catch (_) {}
      }
    }
  };

  FindPanel.prototype._renderTruncation = function (resp, n) {
    var msg = formatTruncationBanner(resp, n);
    if (msg) {
      this._truncEl.textContent = msg;
      this._truncEl.style.display = '';
    } else {
      this._truncEl.style.display = 'none';
    }
  };

  FindPanel.prototype._setStatus = function (text, busy, isError) {
    if (!this._statusEl) return;
    this._statusEl.textContent = text || '';
    this._statusEl.classList.toggle('busy', !!busy);
    this._statusEl.classList.toggle('error', !!isError);
  };

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var exportsObj = {
    FindPanel: FindPanel,
    buildFindUrl: buildFindUrl,
    splitBasenameParent: splitBasenameParent,
    formatTruncationBanner: formatTruncationBanner,
    dispatchFindHit: dispatchFindHit,
    FIND_ENDPOINT: FIND_ENDPOINT,
    DEFAULT_DEBOUNCE_MS: DEFAULT_DEBOUNCE_MS,
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    MAX_RENDERED: MAX_RENDERED,
  };

  window.fileFind = exportsObj;
  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
})();
