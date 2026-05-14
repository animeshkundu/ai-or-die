// file-tabs.js — TabManager for the file browser.
//
// A horizontal tab strip + per-tab content host that sits above the
// preview/editor area. Each tab owns its own FilePreviewPanel or
// FileEditorPanel instance; switching tabs is instant (DOM hide/show)
// and preserves the underlying Monaco model state (cursor, scroll,
// selection, undo history).
//
// Public API (window.fileTabs.TabManager):
//   constructor({ containerEl, authFetch, sessionKey, onActiveChange,
//                 onAllClosed, iconSet, maxTabs })
//   .openFile(path, mode, options)  → tab        — activate-or-create
//   .closeTab(id)                   → boolean    — true if closed
//   .activate(id)                   → boolean
//   .closeAll()                     → void
//   .destroy()                      → void
//   .getTabs()                      → tab[] (snapshot)
//   .getActiveTab()                 → tab | null
//
// `mode` is 'preview' | 'editor'. Diff mode comes in #6.
//
// Persistence: open tabs (path + mode + active index) round-trip through
// localStorage keyed by `fb-tabs-<sessionKey>`, scoped per claude session.
// Restored on construction; rewritten on every mutation (open/close/reorder/
// activate). v1 schema is `{ version, tabs: [{path, mode}], activeIndex }`.
//
// Keyboard (when the tab strip is the active focus area or via document
// listener installed by the host):
//   Cmd/Ctrl+W      — close active tab
//   Cmd/Ctrl+1..9   — jump to tab N (1-based)
//
// Dual-export so pure-JS persistence helpers are testable under Node.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants + pure helpers
  // ---------------------------------------------------------------------------

  var STORAGE_PREFIX = 'fb-tabs-';
  var STORAGE_VERSION = 1;
  var DEFAULT_MAX_TABS = 12;
  var DEFAULT_SESSION_KEY = 'default';

  function storageKey(sessionKey) {
    return STORAGE_PREFIX + (sessionKey || DEFAULT_SESSION_KEY);
  }

  function basenameOf(path) {
    if (!path) return '';
    var s = String(path).replace(/\\/g, '/');
    var i = s.lastIndexOf('/');
    return i === -1 ? s : (s.slice(i + 1) || s);
  }

  // Compose a stable identity for "this open tab". Same (path, mode) always
  // resolves to the same tab so reopening a file just activates it.
  function tabKey(path, mode) {
    return mode + ':' + (path || '');
  }

  // Serialize a TabManager state for localStorage. Pure transformation —
  // the real persistence wrappers handle quota/private-mode failures.
  function serializeState(tabs, activeIndex) {
    var safe = (tabs || []).map(function (t) {
      return { path: t.path, mode: t.mode };
    });
    var idx = (typeof activeIndex === 'number' && activeIndex >= 0 && activeIndex < safe.length)
      ? activeIndex : (safe.length ? 0 : -1);
    return { version: STORAGE_VERSION, tabs: safe, activeIndex: idx };
  }

  // Deserialize defensively — anything unrecognised falls back to an empty
  // state so a stale or corrupted localStorage entry can't poison the panel.
  function deserializeState(raw) {
    if (!raw || typeof raw !== 'object') return { tabs: [], activeIndex: -1 };
    if (raw.version !== STORAGE_VERSION) return { tabs: [], activeIndex: -1 };
    if (!Array.isArray(raw.tabs)) return { tabs: [], activeIndex: -1 };
    var tabs = [];
    for (var i = 0; i < raw.tabs.length; i++) {
      var t = raw.tabs[i];
      if (!t || typeof t.path !== 'string' || !t.path) continue;
      var mode = (t.mode === 'editor' || t.mode === 'preview') ? t.mode : 'preview';
      tabs.push({ path: t.path, mode: mode });
    }
    var idx = (typeof raw.activeIndex === 'number' && raw.activeIndex >= 0 && raw.activeIndex < tabs.length)
      ? raw.activeIndex : (tabs.length ? 0 : -1);
    return { tabs: tabs, activeIndex: idx };
  }

  // ---------------------------------------------------------------------------
  // Browser-only beyond this point
  // ---------------------------------------------------------------------------

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        STORAGE_PREFIX: STORAGE_PREFIX,
        STORAGE_VERSION: STORAGE_VERSION,
        storageKey: storageKey,
        basenameOf: basenameOf,
        tabKey: tabKey,
        serializeState: serializeState,
        deserializeState: deserializeState,
      };
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // TabManager
  // ---------------------------------------------------------------------------

  function TabManager(options) {
    options = options || {};
    if (!options.containerEl) {
      throw new Error('TabManager: options.containerEl is required');
    }
    if (typeof options.authFetch !== 'function') {
      throw new Error('TabManager: options.authFetch is required');
    }

    this.containerEl = options.containerEl;
    this.authFetch = options.authFetch;
    this.sessionKey = options.sessionKey || DEFAULT_SESSION_KEY;
    this.maxTabs = options.maxTabs || DEFAULT_MAX_TABS;
    this.iconSet = options.iconSet || (typeof window !== 'undefined' ? window.icons : null);
    this.onActiveChange = options.onActiveChange || function () {};
    this.onAllClosed = options.onAllClosed || function () {};

    this._tabs = [];                  // [{id, path, mode, name, dirty, contentEl, panel, tabEl}]
    this._activeId = null;
    this._tabSeq = 0;
    this._destroyed = false;
    this._dragSrcId = null;
    this._docKeyHandler = null;

    this._buildDOM();
    this._bindKeyboard();
  }

  TabManager.prototype._buildDOM = function () {
    this.containerEl.classList.add('fb-tabs-host');

    var strip = document.createElement('div');
    strip.className = 'fb-tabs-strip';
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('aria-label', 'Open files');
    this._tabStripEl = strip;
    this.containerEl.appendChild(strip);

    var contentRoot = document.createElement('div');
    contentRoot.className = 'fb-tabs-content';
    this._contentRootEl = contentRoot;
    this.containerEl.appendChild(contentRoot);
  };

  // ---- Keyboard (document-level Ctrl/Cmd shortcuts) ----

  TabManager.prototype._bindKeyboard = function () {
    var self = this;
    this._docKeyHandler = function (e) {
      if (self._destroyed) return;
      if (!self._tabs.length) return;
      // Only fire when the file browser is the active surface (some tab
      // is actually displayed). The host can decide via containerEl
      // visibility.
      if (!self._isHostVisible()) return;

      var meta = e.ctrlKey || e.metaKey;
      if (!meta) return;

      // Cmd/Ctrl+W — close active tab. Some browsers reserve this for
      // window-close; users on those browsers won't see this fire, but we
      // preventDefault when we DO catch it so editor focus stays put.
      if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        if (self._activeId) self.closeTab(self._activeId);
        return;
      }
      // Cmd/Ctrl+1..9 — jump to tab N
      if (e.key >= '1' && e.key <= '9') {
        var n = parseInt(e.key, 10);
        if (n <= self._tabs.length) {
          e.preventDefault();
          self.activate(self._tabs[n - 1].id);
        }
      }
    };
    document.addEventListener('keydown', this._docKeyHandler);
  };

  TabManager.prototype._isHostVisible = function () {
    if (!this.containerEl) return false;
    // offsetParent === null when display:none somewhere up the tree.
    return this.containerEl.offsetParent !== null;
  };

  // ---- Public API ----

  TabManager.prototype.getTabs = function () {
    return this._tabs.map(function (t) {
      return { id: t.id, path: t.path, mode: t.mode, name: t.name, dirty: !!t.dirty };
    });
  };

  TabManager.prototype.getActiveTab = function () {
    return this._findTab(this._activeId);
  };

  TabManager.prototype.openFile = function (path, mode, options) {
    if (!path) return null;
    mode = (mode === 'editor') ? 'editor' : 'preview';
    options = options || {};

    var existing = this._findByKey(path, mode);
    if (existing) {
      this.activate(existing.id);
      // Even when reactivating, allow the caller to push a fresh jumpTo
      // (e.g. terminal click on the same file at a new line).
      if (options.jumpTo && existing.panel && typeof existing.panel.jumpTo === 'function') {
        try { existing.panel.jumpTo(options.jumpTo); } catch (_) { /* ignore */ }
      } else if (options.jumpTo) {
        existing.pendingJumpTo = options.jumpTo;
        // Re-render preview if the panel doesn't expose a jump method yet.
        if (existing.mode === 'preview') this._renderPreviewIntoTab(existing);
      }
      return existing;
    }

    if (this._tabs.length >= this.maxTabs) {
      // LRU eviction: drop the oldest non-dirty tab to make room.
      var evict = null;
      for (var i = 0; i < this._tabs.length; i++) {
        if (!this._tabs[i].dirty) { evict = this._tabs[i]; break; }
      }
      if (evict) this.closeTab(evict.id, { silent: true });
    }
    if (this._tabs.length >= this.maxTabs) {
      // All tabs are dirty — refuse rather than silently lose work.
      return null;
    }

    var tab = this._createTab(path, mode, options);
    this._renderStrip();
    this.activate(tab.id);
    this._persist();
    return tab;
  };

  TabManager.prototype.closeTab = function (id, opts) {
    opts = opts || {};
    var idx = this._indexOf(id);
    if (idx === -1) return false;
    var tab = this._tabs[idx];

    if (tab.dirty && !opts.silent && tab.panel && typeof tab.panel.close === 'function') {
      // Defer to the panel's close logic (FileEditorPanel will prompt).
      // Replace its onClose with a hook that completes the tab close once
      // the panel finishes its dirty prompt.
      var self = this;
      var prevOnClose = tab.panel.onClose;
      tab.panel.onClose = function () {
        if (typeof prevOnClose === 'function') {
          try { prevOnClose(); } catch (_) { /* ignore */ }
        }
        // Re-enter closeTab now that the panel is gone; mark not-dirty so
        // we skip the re-prompt branch.
        tab.dirty = false;
        tab.panel = null;
        self.closeTab(id, { silent: true });
      };
      try { tab.panel.close(); } catch (_) { /* ignore */ }
      return false; // not yet closed
    }

    // Hard close: dispose panel + DOM.
    this._disposeTab(tab);
    this._tabs.splice(idx, 1);

    // Activation: prefer the tab that was to the right of the closed one,
    // else the last tab in the strip, else nothing.
    if (this._activeId === id) {
      this._activeId = null;
      var nextActive = this._tabs[idx] || this._tabs[idx - 1] || null;
      if (nextActive) this.activate(nextActive.id);
    }

    this._renderStrip();
    this._persist();

    if (!this._tabs.length) {
      try { this.onAllClosed(); } catch (_) { /* ignore */ }
    }
    return true;
  };

  TabManager.prototype.activate = function (id) {
    var tab = this._findTab(id);
    if (!tab) return false;
    if (this._activeId === id && tab.contentEl.style.display !== 'none') {
      // Already active — still re-render strip in case dirty/title changed.
      this._renderStrip();
      return true;
    }

    // Hide all other tab content panes; show this one.
    for (var i = 0; i < this._tabs.length; i++) {
      var t = this._tabs[i];
      t.contentEl.style.display = (t.id === id) ? '' : 'none';
    }
    this._activeId = id;
    this._renderStrip();
    this._persist();

    // Lazily render the panel into the tab the first time it's activated
    // (cheap-construction pattern; preview tabs fetch content on first show).
    if (!tab._rendered) {
      tab._rendered = true;
      if (tab.mode === 'preview') {
        this._renderPreviewIntoTab(tab);
      } else if (tab.mode === 'editor') {
        this._renderEditorIntoTab(tab);
      }
    }

    try { this.onActiveChange({ tab: tab }); } catch (_) { /* ignore */ }
    return true;
  };

  TabManager.prototype.closeAll = function () {
    // Iterate over a snapshot since closeTab mutates _tabs.
    var ids = this._tabs.map(function (t) { return t.id; });
    for (var i = 0; i < ids.length; i++) this.closeTab(ids[i], { silent: true });
  };

  TabManager.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._docKeyHandler) {
      document.removeEventListener('keydown', this._docKeyHandler);
      this._docKeyHandler = null;
    }
    this.closeAll();
    if (this.containerEl) {
      this.containerEl.innerHTML = '';
      this.containerEl.classList.remove('fb-tabs-host');
    }
  };

  // ---- Internal: tab creation, rendering, disposal ----

  TabManager.prototype._createTab = function (path, mode, options) {
    var contentEl = document.createElement('div');
    contentEl.className = 'fb-tab-content';
    contentEl.style.display = 'none'; // hidden until activate() shows it
    this._contentRootEl.appendChild(contentEl);

    var tab = {
      id: 't_' + (++this._tabSeq),
      path: path,
      mode: mode,
      name: basenameOf(path) || path,
      dirty: false,
      contentEl: contentEl,
      panel: null,
      tabEl: null,
      _rendered: false,
      pendingJumpTo: options && options.jumpTo ? options.jumpTo : null,
      _initialContent: options && options.content != null ? options.content : null,
      _initialHash: options && options.hash != null ? options.hash : null,
      _initialItem: options && options.item ? options.item : null,
    };
    this._tabs.push(tab);
    return tab;
  };

  TabManager.prototype._renderPreviewIntoTab = function (tab) {
    if (!window.fileBrowser || !window.fileBrowser.FilePreviewPanel) {
      tab.contentEl.innerHTML = '<div class="fb-preview-error">Preview not available.</div>';
      return;
    }
    // Reuse the existing preview panel implementation per-tab. Each tab
    // owns its own panel instance so disposers (Monaco/Panzoom/PDF.js)
    // stay scoped to the tab.
    if (!tab.panel) {
      tab.panel = new window.fileBrowser.FilePreviewPanel({
        authFetch: this.authFetch,
        containerEl: tab.contentEl,
        onEdit: function () { /* TabManager-level edit toggle is a follow-up */ },
        onBack: function () { /* no-op inside a tab */ },
      });
    }
    var item = tab._initialItem || {
      path: tab.path,
      name: tab.name,
      mimeCategory: 'code',
      previewable: true,
      editable: true,
    };
    var jumpTo = tab.pendingJumpTo || null;
    tab.pendingJumpTo = null;
    try {
      tab.panel.showPreview(item, undefined, { jumpTo: jumpTo });
    } catch (_) {
      tab.contentEl.innerHTML = '<div class="fb-preview-error">Preview failed.</div>';
    }
  };

  TabManager.prototype._renderEditorIntoTab = function (tab) {
    var self = this;
    if (!window.fileEditor || !window.fileEditor.FileEditorPanel) {
      tab.contentEl.innerHTML = '<div class="fb-preview-error">Editor not available.</div>';
      return;
    }
    var ensureContent = (tab._initialContent != null && tab._initialHash != null)
      ? Promise.resolve({ content: tab._initialContent, hash: tab._initialHash })
      : this.authFetch('/api/files/content?path=' + encodeURIComponent(tab.path))
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          });

    ensureContent.then(function (data) {
      if (self._destroyed || !self._findTab(tab.id)) return;
      tab.panel = new window.fileEditor.FileEditorPanel({
        authFetch: self.authFetch,
        containerEl: tab.contentEl,
        onClose: function () {
          // FileEditorPanel.destroy() invokes its onClose AFTER the editor
          // is gone; collapse this into a tab close.
          tab.panel = null;
          self.closeTab(tab.id, { silent: true });
        },
        onSave: function () {
          tab.dirty = false;
          self._renderStrip();
        },
      });
      tab.panel.openEditor(tab.path, data.content, data.hash);
      // Polling-free dirty tracking: the panel mutates _dirty in
      // _onContentChange. Wrap that to surface a callback.
      _wrapDirtyTracking(tab.panel, function (isDirty) {
        if (tab.dirty !== isDirty) {
          tab.dirty = isDirty;
          self._renderStrip();
          self._persist();
        }
      });
    }).catch(function (err) {
      tab.contentEl.innerHTML = '<div class="fb-preview-error">Failed to open editor: ' +
        (err && err.message ? _esc(err.message) : 'unknown') + '</div>';
    });
  };

  TabManager.prototype._disposeTab = function (tab) {
    if (!tab) return;
    if (tab.panel) {
      try {
        if (typeof tab.panel.destroy === 'function') tab.panel.destroy();
      } catch (_) { /* ignore */ }
      tab.panel = null;
    }
    if (tab.contentEl && tab.contentEl.parentNode) {
      tab.contentEl.parentNode.removeChild(tab.contentEl);
    }
    if (tab.tabEl && tab.tabEl.parentNode) {
      tab.tabEl.parentNode.removeChild(tab.tabEl);
    }
  };

  // ---- Tab strip rendering ----

  TabManager.prototype._renderStrip = function () {
    var self = this;
    this._tabStripEl.innerHTML = '';
    this._tabs.forEach(function (tab) {
      var btn = document.createElement('div');
      btn.className = 'fb-tab' + (tab.id === self._activeId ? ' active' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', tab.id === self._activeId ? 'true' : 'false');
      btn.setAttribute('tabindex', tab.id === self._activeId ? '0' : '-1');
      btn.setAttribute('draggable', 'true');
      btn.setAttribute('data-tab-id', tab.id);
      btn.title = tab.path;

      var name = document.createElement('span');
      name.className = 'fb-tab-name';
      name.textContent = tab.name;
      btn.appendChild(name);

      if (tab.dirty) {
        var dot = document.createElement('span');
        dot.className = 'fb-tab-dirty-dot';
        dot.setAttribute('aria-label', 'Unsaved changes');
        btn.appendChild(dot);
      }

      var close = document.createElement('button');
      close.className = 'fb-tab-close';
      close.type = 'button';
      close.setAttribute('aria-label', 'Close ' + tab.name);
      close.innerHTML = self.iconSet ? self.iconSet.x(12) : '&times;';
      close.addEventListener('click', function (e) {
        e.stopPropagation();
        self.closeTab(tab.id);
      });
      btn.appendChild(close);

      btn.addEventListener('click', function () { self.activate(tab.id); });
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          self.activate(tab.id);
        }
      });

      // HTML5 drag-reorder
      btn.addEventListener('dragstart', function (e) {
        self._dragSrcId = tab.id;
        try { e.dataTransfer.setData('text/plain', tab.id); } catch (_) {}
        e.dataTransfer.effectAllowed = 'move';
        btn.classList.add('dragging');
      });
      btn.addEventListener('dragend', function () {
        btn.classList.remove('dragging');
        self._dragSrcId = null;
      });
      btn.addEventListener('dragover', function (e) {
        if (!self._dragSrcId || self._dragSrcId === tab.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      btn.addEventListener('drop', function (e) {
        if (!self._dragSrcId || self._dragSrcId === tab.id) return;
        e.preventDefault();
        self._reorder(self._dragSrcId, tab.id);
      });

      tab.tabEl = btn;
      self._tabStripEl.appendChild(btn);
    });
  };

  TabManager.prototype._reorder = function (srcId, dstId) {
    var srcIdx = this._indexOf(srcId);
    var dstIdx = this._indexOf(dstId);
    if (srcIdx === -1 || dstIdx === -1 || srcIdx === dstIdx) return;
    var moved = this._tabs.splice(srcIdx, 1)[0];
    this._tabs.splice(dstIdx, 0, moved);
    this._renderStrip();
    this._persist();
  };

  // ---- Persistence ----

  TabManager.prototype._persist = function () {
    var key = storageKey(this.sessionKey);
    var idx = this._indexOf(this._activeId);
    var state = serializeState(this._tabs, idx);
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch (_) { /* quota / private mode — persistence becomes best-effort */ }
  };

  TabManager.prototype.restoreFromStorage = function () {
    var key = storageKey(this.sessionKey);
    var raw = null;
    try { raw = localStorage.getItem(key); } catch (_) { return false; }
    if (!raw) return false;
    var parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return false; }
    var state = deserializeState(parsed);
    if (!state.tabs.length) return false;
    for (var i = 0; i < state.tabs.length; i++) {
      var t = state.tabs[i];
      // Lazy: don't fetch content yet — let activate() trigger render.
      this._createTab(t.path, t.mode, {});
    }
    this._renderStrip();
    var idx = state.activeIndex >= 0 ? state.activeIndex : 0;
    if (this._tabs[idx]) this.activate(this._tabs[idx].id);
    return true;
  };

  // ---- Internal helpers ----

  TabManager.prototype._findTab = function (id) {
    if (!id) return null;
    for (var i = 0; i < this._tabs.length; i++) {
      if (this._tabs[i].id === id) return this._tabs[i];
    }
    return null;
  };

  TabManager.prototype._findByKey = function (path, mode) {
    var key = tabKey(path, mode);
    for (var i = 0; i < this._tabs.length; i++) {
      if (tabKey(this._tabs[i].path, this._tabs[i].mode) === key) return this._tabs[i];
    }
    return null;
  };

  TabManager.prototype._indexOf = function (id) {
    if (!id) return -1;
    for (var i = 0; i < this._tabs.length; i++) {
      if (this._tabs[i].id === id) return i;
    }
    return -1;
  };

  // ---- Module-private utilities ----

  function _esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Wrap FileEditorPanel._onContentChange to surface dirty transitions to a
  // callback. The editor panel doesn't expose an onDirtyChange option today
  // (~3 lines could add one), so we monkey-patch to keep this commit
  // self-contained — clearly noted so a future cleanup pulls it inside the
  // editor module.
  function _wrapDirtyTracking(panel, callback) {
    if (!panel || typeof panel._onContentChange !== 'function') return;
    var prior = panel._onContentChange;
    panel._onContentChange = function () {
      var wasDirty = !!panel._dirty;
      prior.call(panel);
      var nowDirty = !!panel._dirty;
      if (wasDirty !== nowDirty) {
        try { callback(nowDirty); } catch (_) { /* ignore */ }
      }
    };
    // Fire once with the initial state (an editor opened with a draft is
    // already dirty).
    try { callback(!!panel._dirty); } catch (_) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var exportsObj = {
    TabManager: TabManager,
    // Pure helpers exposed for tests.
    storageKey: storageKey,
    basenameOf: basenameOf,
    tabKey: tabKey,
    serializeState: serializeState,
    deserializeState: deserializeState,
    STORAGE_PREFIX: STORAGE_PREFIX,
    STORAGE_VERSION: STORAGE_VERSION,
  };

  window.fileTabs = exportsObj;
  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
})();
