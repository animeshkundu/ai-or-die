// file-search.js — Cross-file search panel for the file browser.
//
// Streams results from GET /api/search (SSE; ripgrep with grep fallback)
// into a results list inside the file browser panel. Each result row shows
// `path:line` + matched line context; clicking opens the file in a Monaco
// preview tab via the host's onResultClick callback (which routes through
// TabManager.openFile(path, 'preview', { jumpTo: { line, col } }), reusing
// the same jump-to-line plumbing established in cef62bf for terminal-link
// clicks).
//
// Public API (window.fileSearch):
//   SearchPanel constructor({ containerEl, getAuthToken, onResultClick,
//                              onClose, debounceMs })
//     .open()              — show panel + focus input
//     .close()             — hide + abort any active stream
//     .destroy()           — full cleanup
//     .isOpen()            — boolean
//     .runQuery(q, opts?)  — programmatic query (useful from a header
//                            "Search…" button or command palette)
//
//   buildSearchUrl(query, opts)  — pure helper, testable
//
// The search input debounces at 200 ms by default. Each new query aborts
// the previous EventSource. The component caps rendered results at 500
// (matches the server's per-request cap) and truncates beyond that with a
// "showing first 500 of N" notice. Streamed matches are appended in batches
// via DocumentFragment to keep the UI smooth on big result sets.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var SEARCH_ENDPOINT = '/api/search';
  var DEFAULT_DEBOUNCE_MS = 200;
  var MAX_RENDERED_MATCHES = 500;
  var FLUSH_INTERVAL_MS = 64;       // batch DOM appends ~16/frame

  // ---------------------------------------------------------------------------
  // Pure helpers (testable under Node)
  // ---------------------------------------------------------------------------

  // Build the SSE URL for a given query and options. Pure string assembly
  // — no DOM, no fetch — so the test suite can exercise the encoding +
  // parameter wiring without spinning up a browser.
  function buildSearchUrl(query, opts) {
    opts = opts || {};
    if (!query) return '';
    var parts = ['q=' + encodeURIComponent(String(query))];
    if (opts.regex) parts.push('regex=1');
    if (opts.caseSensitive) parts.push('caseSensitive=1');
    if (opts.glob) {
      // Server validates glob shape — we just URL-encode the value.
      parts.push('glob=' + encodeURIComponent(String(opts.glob)));
    }
    if (opts.path) {
      parts.push('path=' + encodeURIComponent(String(opts.path)));
    }
    if (opts.token) {
      // EventSource has no API for setting Authorization headers; the
      // server accepts ?token= as an alternative (server.js:464 shared
      // with /api/files/git-show + the rest).
      parts.push('token=' + encodeURIComponent(String(opts.token)));
    }
    return SEARCH_ENDPOINT + '?' + parts.join('&');
  }

  // Format the location label shown on each result row.
  // Returns "path:line" or "path:line:col" depending on whether col exists.
  function formatLocation(path, line, col) {
    var p = path || '';
    var l = line == null ? '' : String(line);
    var c = col == null || col === '' ? '' : String(col);
    if (!l) return p;
    if (!c) return p + ':' + l;
    return p + ':' + l + ':' + c;
  }

  // ---------------------------------------------------------------------------
  // Browser-only beyond this point
  // ---------------------------------------------------------------------------

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        buildSearchUrl: buildSearchUrl,
        formatLocation: formatLocation,
        SEARCH_ENDPOINT: SEARCH_ENDPOINT,
      };
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // SearchPanel
  // ---------------------------------------------------------------------------

  function SearchPanel(options) {
    options = options || {};
    if (!options.containerEl) {
      throw new Error('SearchPanel: options.containerEl is required');
    }
    this.containerEl = options.containerEl;
    this.onResultClick = options.onResultClick || function () {};
    this.onClose = options.onClose || function () {};
    this.getAuthToken = typeof options.getAuthToken === 'function'
      ? options.getAuthToken
      : function () { return null; };
    this.getSearchRoot = typeof options.getSearchRoot === 'function'
      ? options.getSearchRoot
      : function () { return null; };
    this.debounceMs = typeof options.debounceMs === 'number' ? options.debounceMs : DEFAULT_DEBOUNCE_MS;

    this._open = false;
    this._destroyed = false;
    this._eventSource = null;
    this._currentQuery = '';
    this._regex = false;
    this._caseSensitive = false;
    this._matches = 0;
    this._truncated = false;
    this._debounceTimer = null;
    this._flushTimer = null;
    this._pending = null;            // DocumentFragment batched between flushes

    this._panelEl = null;
    this._inputEl = null;
    this._regexBtn = null;
    this._caseBtn = null;
    this._globEl = null;
    this._statusEl = null;
    this._resultsEl = null;
    this._notice = null;             // "showing first 500 of N" element

    this._buildDOM();
  }

  SearchPanel.prototype.isOpen = function () { return !!this._open; };

  SearchPanel.prototype._buildDOM = function () {
    var self = this;

    var panel = document.createElement('div');
    panel.className = 'fb-search-panel';
    panel.style.display = 'none';
    panel.setAttribute('role', 'search');
    panel.setAttribute('aria-label', 'Cross-file search');
    this._panelEl = panel;

    // Header: input + regex toggle + case toggle + glob + close
    var header = document.createElement('div');
    header.className = 'fb-search-panel-header';

    var input = document.createElement('input');
    input.type = 'search';
    input.className = 'fb-search-panel-input';
    input.placeholder = 'Search across files (Cmd+Shift+F)';
    input.setAttribute('aria-label', 'Search query');
    input.addEventListener('input', function () { self._scheduleQuery(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); self.close(); }
    });
    header.appendChild(input);
    this._inputEl = input;

    function makeToggle(label, title, ariaLabel) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'fb-search-toggle';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', ariaLabel);
      return b;
    }

    var regexBtn = makeToggle('.*', 'Regex (treat query as regex)', 'Toggle regex mode');
    regexBtn.addEventListener('click', function () {
      self._regex = !self._regex;
      regexBtn.setAttribute('aria-pressed', self._regex ? 'true' : 'false');
      regexBtn.classList[self._regex ? 'add' : 'remove']('active');
      self._scheduleQuery(true);
    });
    header.appendChild(regexBtn);
    this._regexBtn = regexBtn;

    var caseBtn = makeToggle('Aa', 'Match case', 'Toggle case-sensitive match');
    caseBtn.addEventListener('click', function () {
      self._caseSensitive = !self._caseSensitive;
      caseBtn.setAttribute('aria-pressed', self._caseSensitive ? 'true' : 'false');
      caseBtn.classList[self._caseSensitive ? 'add' : 'remove']('active');
      self._scheduleQuery(true);
    });
    header.appendChild(caseBtn);
    this._caseBtn = caseBtn;

    var globEl = document.createElement('input');
    globEl.type = 'text';
    globEl.className = 'fb-search-glob';
    globEl.placeholder = 'glob (e.g. *.ts)';
    globEl.setAttribute('aria-label', 'File glob filter');
    globEl.addEventListener('input', function () { self._scheduleQuery(); });
    globEl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); self.close(); }
    });
    header.appendChild(globEl);
    this._globEl = globEl;

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'fb-search-close';
    closeBtn.title = 'Close (Esc)';
    closeBtn.setAttribute('aria-label', 'Close search panel');
    closeBtn.innerHTML = window.icons ? window.icons.x(14) : '&times;';
    closeBtn.addEventListener('click', function () { self.close(); });
    header.appendChild(closeBtn);

    panel.appendChild(header);

    var status = document.createElement('div');
    status.className = 'fb-search-status';
    status.setAttribute('aria-live', 'polite');
    panel.appendChild(status);
    this._statusEl = status;

    var results = document.createElement('div');
    results.className = 'fb-search-results';
    results.setAttribute('role', 'list');
    panel.appendChild(results);
    this._resultsEl = results;

    this.containerEl.appendChild(panel);
  };

  // -- Public API --

  SearchPanel.prototype.open = function () {
    if (this._destroyed) return;
    this._open = true;
    this._panelEl.style.display = '';
    // setTimeout to outwit auto-focus from a global keyboard handler that
    // may have just fired the open.
    var self = this;
    setTimeout(function () {
      if (self._inputEl && !self._destroyed) self._inputEl.focus();
    }, 0);
  };

  SearchPanel.prototype.close = function () {
    if (!this._open) return;
    this._open = false;
    this._panelEl.style.display = 'none';
    this._abortStream();
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    try { this.onClose(); } catch (_) { /* ignore */ }
  };

  SearchPanel.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    this.close();
    if (this._panelEl && this._panelEl.parentNode) {
      this._panelEl.parentNode.removeChild(this._panelEl);
    }
  };

  SearchPanel.prototype.runQuery = function (q, opts) {
    if (this._destroyed) return;
    opts = opts || {};
    if (typeof q === 'string') {
      this._inputEl.value = q;
      if ('regex' in opts) {
        this._regex = !!opts.regex;
        this._regexBtn.setAttribute('aria-pressed', this._regex ? 'true' : 'false');
        this._regexBtn.classList[this._regex ? 'add' : 'remove']('active');
      }
      if ('caseSensitive' in opts) {
        this._caseSensitive = !!opts.caseSensitive;
        this._caseBtn.setAttribute('aria-pressed', this._caseSensitive ? 'true' : 'false');
        this._caseBtn.classList[this._caseSensitive ? 'add' : 'remove']('active');
      }
      if ('glob' in opts && this._globEl) this._globEl.value = String(opts.glob || '');
    }
    this._runQueryNow();
  };

  // -- Query scheduling --

  SearchPanel.prototype._scheduleQuery = function (immediate) {
    var self = this;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    if (immediate) { this._runQueryNow(); return; }
    this._debounceTimer = setTimeout(function () {
      self._debounceTimer = null;
      self._runQueryNow();
    }, this.debounceMs);
  };

  SearchPanel.prototype._runQueryNow = function () {
    if (this._destroyed) return;
    var query = (this._inputEl.value || '').trim();
    var glob = (this._globEl.value || '').trim() || null;

    // Always abort the in-flight stream when state changes.
    this._abortStream();
    this._matches = 0;
    this._truncated = false;
    this._currentQuery = query;
    if (this._notice && this._notice.parentNode) {
      this._notice.parentNode.removeChild(this._notice);
      this._notice = null;
    }
    this._resultsEl.innerHTML = '';

    if (!query) {
      this._setStatus('Enter a search query.', false);
      return;
    }

    var url = buildSearchUrl(query, {
      regex: this._regex,
      caseSensitive: this._caseSensitive,
      glob: glob,
      path: this.getSearchRoot() || null,
      token: this.getAuthToken() || null,
    });

    this._setStatus('Searching…', true);
    this._openStream(url);
  };

  // -- SSE wiring --

  SearchPanel.prototype._openStream = function (url) {
    var self = this;
    if (typeof window.EventSource === 'undefined') {
      this._setStatus('EventSource not supported in this browser.', false, true);
      return;
    }
    var es;
    try {
      es = new window.EventSource(url);
    } catch (e) {
      this._setStatus('Search failed: ' + (e && e.message ? e.message : 'unknown'), false, true);
      return;
    }
    this._eventSource = es;

    es.onmessage = function (evt) {
      if (self._destroyed || self._eventSource !== es) return;
      var data;
      try { data = JSON.parse(evt.data); } catch (_) { return; }
      self._handleEvent(data);
    };
    es.onerror = function () {
      if (self._destroyed || self._eventSource !== es) return;
      // EventSource auto-reconnects on transport error; explicitly close so
      // a 429 / 500 doesn't trigger a reconnect storm.
      self._abortStream();
      // If we haven't received any matches yet, surface a generic error;
      // otherwise leave the partial results visible.
      if (self._matches === 0) {
        self._setStatus('Search connection failed (rate limit or server error).', false, true);
      } else {
        self._setStatus('Connection dropped after ' + self._matches + ' matches.', false, true);
      }
    };
  };

  SearchPanel.prototype._abortStream = function () {
    if (this._eventSource) {
      try { this._eventSource.close(); } catch (_) { /* ignore */ }
      this._eventSource = null;
    }
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._pending) {
      // Flush any unflushed batch so partial results stay visible after
      // an abort/close.
      this._resultsEl.appendChild(this._pending);
      this._pending = null;
    }
  };

  SearchPanel.prototype._handleEvent = function (data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'start') {
      // Server announced backend; nothing to render yet.
      return;
    }
    if (data.type === 'match') {
      this._addMatch(data);
      return;
    }
    if (data.type === 'end') {
      this._abortStream();
      var n = (typeof data.matches === 'number') ? data.matches : this._matches;
      var msg = n + ' match' + (n === 1 ? '' : 'es');
      if (data.truncated) {
        msg += ' (truncated; refine query)';
        this._truncated = true;
      }
      // `droppedLines` arrived in the SSE end-event in d84f7e2 (#13 DoS
      // fix-up). Counts stdout lines skipped because they exceeded the
      // 256 KB per-line cap — typically minified-JS / packed-JSON files
      // that would otherwise stall the event loop. Surface non-zero
      // values so users know results may be incomplete and can narrow
      // their query / add a glob filter. Defensive number-coerce: a
      // missing field (older servers) reads as undefined → !( > 0).
      if (typeof data.droppedLines === 'number' && data.droppedLines > 0) {
        msg += ' — ' + data.droppedLines + ' line' +
          (data.droppedLines === 1 ? '' : 's') +
          ' too long to scan (refine query / add glob filter)';
      }
      this._setStatus(msg, false);
      return;
    }
    if (data.type === 'error') {
      this._abortStream();
      this._setStatus('Search error: ' + (data.message || 'unknown'), false, true);
      return;
    }
  };

  SearchPanel.prototype._addMatch = function (m) {
    if (this._matches >= MAX_RENDERED_MATCHES) {
      // Stop appending DOM beyond the cap to keep the panel responsive;
      // server-side cap is also 500 so this is mostly defensive.
      this._matches++;
      return;
    }
    this._matches++;

    if (!this._pending) this._pending = document.createDocumentFragment();
    var row = this._renderMatchRow(m);
    this._pending.appendChild(row);
    this._scheduleFlush();
  };

  SearchPanel.prototype._scheduleFlush = function () {
    var self = this;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(function () {
      self._flushTimer = null;
      if (!self._pending) return;
      self._resultsEl.appendChild(self._pending);
      self._pending = null;
      // Update status with running match count for visual feedback.
      if (self._eventSource) {
        self._setStatus('Searching… (' + self._matches + ' matches so far)', true);
      }
    }, FLUSH_INTERVAL_MS);
  };

  SearchPanel.prototype._renderMatchRow = function (m) {
    var self = this;
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'fb-search-result';
    row.setAttribute('role', 'listitem');

    var loc = document.createElement('div');
    loc.className = 'fb-search-result-loc';
    loc.textContent = formatLocation(m.path, m.line, m.col);
    row.appendChild(loc);

    var text = document.createElement('div');
    text.className = 'fb-search-result-text';
    // Strip leading whitespace for display so wide indentation doesn't
    // push the match off-screen; preserve the line text itself for
    // user comprehension.
    text.textContent = (m.text || '').replace(/^\s+/, '');
    row.appendChild(text);

    row.addEventListener('click', function () {
      // Server emits relative path; the host's onResultClick is responsible
      // for resolving against the search root if needed (it routes through
      // tabManager.openFile which hits /api/files/content with whatever
      // path it gets — server validatePath() is the authoritative gate).
      try {
        self.onResultClick({
          path: m.absPath || m.path,
          line: m.line,
          col: m.col,
          relPath: m.path,
        });
      } catch (_) { /* ignore */ }
    });

    return row;
  };

  SearchPanel.prototype._setStatus = function (text, busy, isError) {
    if (!this._statusEl) return;
    this._statusEl.textContent = text || '';
    this._statusEl.classList.toggle('busy', !!busy);
    this._statusEl.classList.toggle('error', !!isError);
  };

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var exportsObj = {
    SearchPanel: SearchPanel,
    buildSearchUrl: buildSearchUrl,
    formatLocation: formatLocation,
    SEARCH_ENDPOINT: SEARCH_ENDPOINT,
    DEFAULT_DEBOUNCE_MS: DEFAULT_DEBOUNCE_MS,
    MAX_RENDERED_MATCHES: MAX_RENDERED_MATCHES,
  };

  window.fileSearch = exportsObj;
  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
})();
