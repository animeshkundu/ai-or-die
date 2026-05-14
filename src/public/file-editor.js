// file-editor.js — FileEditorPanel (Monaco Editor integration; ADR-0016).
// Dual-export: window.fileEditor (browser) + module.exports (Node.js tests).
//
// Public API preserved across the Ace → Monaco migration:
//   FileEditorPanel { openEditor, save, toggleAutoSave, isDirty, close, destroy }
// The hash-based 409 conflict flow (Keep / Reload / Compare Changes) is
// preserved end-to-end. The "Compare Changes" modal swaps its hand-rolled
// twin-<pre> view for monaco.editor.createDiffEditor — same data path,
// proper intra-line diff highlighting at zero extra cost.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function getExtension(p) {
    if (!p) return '';
    var i = p.lastIndexOf('.');
    return i === -1 ? '' : p.slice(i);
  }

  function getFileName(p) {
    if (!p) return '';
    var s = String(p).replace(/\\/g, '/').split('/');
    return s[s.length - 1] || p;
  }

  // Resolve the Monaco language id for an extension or path. Delegates to
  // window.fileViewerMonaco when available (browser); falls back to
  // require()'ing the loader module directly under Node tests so this file
  // remains testable without a DOM. Returns 'plaintext' if neither is
  // available — matches Monaco's default language id.
  function getMonacoLanguage(extOrPath) {
    if (typeof window !== 'undefined' && window.fileViewerMonaco &&
        typeof window.fileViewerMonaco.getMonacoLanguage === 'function') {
      return window.fileViewerMonaco.getMonacoLanguage(extOrPath);
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./file-viewer-monaco').getMonacoLanguage(extOrPath);
      } catch (_) { /* fall through */ }
    }
    return 'plaintext';
  }

  // Backward-compat alias. Pre-migration callers asked for an "Ace mode";
  // the closest meaningful answer post-migration is the Monaco language id
  // (used identically for status-bar display and code-coloring decisions).
  // Intentionally not removed — the public API contract is preserved per
  // the migration directive.
  function getAceMode(ext) {
    return getMonacoLanguage(ext);
  }

  // Reusable modal overlay helper — returns { overlay, box, close }.
  // `opts.onClose` is invoked whenever the modal is dismissed (overlay click,
  // Escape, or programmatic `close()`), letting callers tear down associated
  // resources (e.g. dispose a Monaco diff editor + its models).
  function _createModal(opts) {
    opts = opts || {};
    var overlay = document.createElement('div');
    overlay.className = 'image-preview-modal active';
    overlay.style.zIndex = '9999';
    var box = document.createElement('div');
    box.className = 'modal-content';
    if (opts.maxWidth) box.style.maxWidth = opts.maxWidth;
    if (opts.maxHeight) box.style.maxHeight = opts.maxHeight;
    if (opts.flex) { box.style.display = 'flex'; box.style.flexDirection = 'column'; }
    overlay.appendChild(box);

    var closed = false;
    function closeModal() {
      if (closed) return;
      closed = true;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (typeof opts.onClose === 'function') {
        try { opts.onClose(); } catch (_) { /* swallow — user code already ran */ }
      }
    }
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeModal(); });
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
    });
    document.body.appendChild(overlay);
    return { overlay: overlay, box: box, close: closeModal };
  }

  // ---------------------------------------------------------------------------
  // FileEditorPanel
  // ---------------------------------------------------------------------------

  function FileEditorPanel(options) {
    this.authFetch = options.authFetch;
    this.containerEl = options.containerEl;
    this.onClose = options.onClose || function () {};
    this.onSave = options.onSave || function () {};
    this._filePath = null;        this._fileHash = null;
    this._lastSavedContent = null;
    this._editor = null;          // Monaco IStandaloneCodeEditor instance
    this._monacoEditor = null;    // alias of _editor; see _wireMonaco for rationale
    this._monacoHandle = null;    // { editor, monaco, dispose } from createCodeViewer
    this._monacoLoaded = false;
    this._disposables = [];       // Monaco IDisposable handles to dispose on teardown
    this._autoSave = true;        this._autoSaveTimer = null;
    this._saving = false;         this._dirty = false;
    this._destroyed = false;      this._retryCount = 0;
    this._toolbarEl = null;       this._editorEl = null;
    this._statusEl = null;        this._dirtyDot = null;
    this._conflictBanner = null;
    this._autoSaveBtn = null;     this._filenameEl = null;
    this._loaderSpinnerEl = null;
  }

  FileEditorPanel.prototype.openEditor = function (filePath, content, fileHash) {
    this._filePath = filePath;
    this._fileHash = fileHash;
    this._lastSavedContent = content;
    this._dirty = false; this._saving = false;
    this._retryCount = 0; this._destroyed = false;
    this._buildEditorDOM();
    var draft = null;
    try { draft = localStorage.getItem('fb-draft-' + filePath); } catch (_) { /* private mode */ }
    var initial = (draft !== null) ? draft : content;
    if (draft !== null && draft !== content) this._dirty = true;
    this._loadMonaco(initial);
  };

  FileEditorPanel.prototype.save = function () {
    if (this._saving || !this._dirty || this._destroyed) return;
    this._saving = true; this._retryCount = 0;
    this._updateStatus('Saving...', '');
    this._announceToScreenReader('Saving');
    this._doSave();
  };

  FileEditorPanel.prototype.toggleAutoSave = function () {
    this._autoSave = !this._autoSave;
    if (this._autoSaveBtn) {
      this._autoSaveBtn.textContent = 'Auto-save: ' + (this._autoSave ? 'ON' : 'OFF');
      this._autoSaveBtn.classList[this._autoSave ? 'add' : 'remove']('active');
    }
    if (this._autoSave && this._dirty) this._scheduleAutoSave();
  };

  FileEditorPanel.prototype.isDirty = function () {
    return this._editor ? this._editor.getValue() !== this._lastSavedContent : false;
  };

  FileEditorPanel.prototype.close = function () {
    if (!this.isDirty()) { this.destroy(); return; }
    this._showUnsavedDialog();
  };

  FileEditorPanel.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._autoSaveTimer) { clearTimeout(this._autoSaveTimer); this._autoSaveTimer = null; }
    // Dispose Monaco event listeners FIRST so late-firing callbacks don't
    // touch a half-disposed editor.
    for (var i = 0; i < this._disposables.length; i++) {
      try { this._disposables[i].dispose(); } catch (_) { /* ignore */ }
    }
    this._disposables = [];
    if (this._monacoHandle) {
      try { this._monacoHandle.dispose(); } catch (_) { /* ignore */ }
      this._monacoHandle = null;
      this._editor = null;
      this._monacoEditor = null;
    }
    if (this._filePath) {
      try { localStorage.removeItem('fb-draft-' + this._filePath); } catch (_) { /* private mode */ }
    }
    this.containerEl.innerHTML = '';
    this.onClose();
  };

  // -- DOM construction --

  FileEditorPanel.prototype._buildEditorDOM = function () {
    this.containerEl.innerHTML = '';

    var toolbar = document.createElement('div');
    toolbar.className = 'file-browser-editor-toolbar';

    var backBtn = document.createElement('button');
    backBtn.className = 'fb-header-btn';
    backBtn.title = 'Back';
    backBtn.setAttribute('aria-label', 'Close editor');
    backBtn.innerHTML = window.icons ? window.icons.arrowLeft(16) : '&larr;';
    backBtn.addEventListener('click', this.close.bind(this));
    toolbar.appendChild(backBtn);

    var fnEl = document.createElement('span');
    fnEl.className = 'file-browser-editor-filename';
    fnEl.textContent = 'Editing: ' + getFileName(this._filePath);
    fnEl.title = this._filePath;
    toolbar.appendChild(fnEl);
    this._filenameEl = fnEl;

    var dot = document.createElement('span');
    dot.className = 'file-browser-editor-dirty';
    toolbar.appendChild(dot);
    this._dirtyDot = dot;

    var asBtn = document.createElement('button');
    asBtn.className = 'file-browser-editor-autosave' + (this._autoSave ? ' active' : '');
    asBtn.textContent = 'Auto-save: ' + (this._autoSave ? 'ON' : 'OFF');
    asBtn.title = 'Toggle auto-save';
    asBtn.setAttribute('aria-label', 'Toggle auto-save');
    asBtn.addEventListener('click', this.toggleAutoSave.bind(this));
    toolbar.appendChild(asBtn);
    this._autoSaveBtn = asBtn;

    var saveBtn = document.createElement('button');
    saveBtn.className = 'fb-header-btn';
    saveBtn.title = 'Save (Ctrl+S)';
    saveBtn.setAttribute('aria-label', 'Save file');
    saveBtn.innerHTML = window.icons ? window.icons.save(14) : 'S';
    saveBtn.addEventListener('click', this.save.bind(this));
    toolbar.appendChild(saveBtn);

    var xBtn = document.createElement('button');
    xBtn.className = 'fb-header-btn fb-close-btn';
    xBtn.title = 'Close editor';
    xBtn.setAttribute('aria-label', 'Close editor');
    xBtn.innerHTML = window.icons ? window.icons.x(14) : '&times;';
    xBtn.addEventListener('click', this.close.bind(this));
    toolbar.appendChild(xBtn);

    this.containerEl.appendChild(toolbar);
    this._toolbarEl = toolbar;

    var editorEl = document.createElement('div');
    editorEl.className = 'file-browser-editor-content';
    editorEl.id = 'fb-monaco-editor-' + Date.now();
    this.containerEl.appendChild(editorEl);
    this._editorEl = editorEl;

    var statusEl = document.createElement('div');
    statusEl.className = 'file-browser-editor-status';
    statusEl.textContent = 'Loading editor...';
    this.containerEl.appendChild(statusEl);
    this._statusEl = statusEl;
  };

  // -- Monaco loading --

  FileEditorPanel.prototype._showLoaderSpinner = function () {
    var sp = document.createElement('div');
    sp.className = 'file-browser-loading';
    var s = document.createElement('div');
    s.className = 'file-browser-spinner';
    sp.appendChild(s);
    this._editorEl.appendChild(sp);
    this._loaderSpinnerEl = sp;
  };

  FileEditorPanel.prototype._removeLoaderSpinner = function () {
    if (this._loaderSpinnerEl && this._loaderSpinnerEl.parentNode) {
      this._loaderSpinnerEl.parentNode.removeChild(this._loaderSpinnerEl);
    }
    this._loaderSpinnerEl = null;
  };

  FileEditorPanel.prototype._loadMonaco = function (content) {
    var self = this;

    // Defensive: if the loader module never registered itself, give the user
    // an actionable error rather than a blank editor pane.
    if (!window.fileViewerMonaco || typeof window.fileViewerMonaco.createCodeViewer !== 'function') {
      this._renderLoaderError(
        'Code editor is unavailable: Monaco loader script is missing. ' +
        'Reload the page; if the problem persists, the file-viewer-monaco.js asset failed to ship.'
      );
      return;
    }

    // Clear any prior state, then show a spinner while the CDN load happens.
    this._editorEl.innerHTML = '';
    this._showLoaderSpinner();

    var ext = getExtension(this._filePath);
    var language = getMonacoLanguage(ext);

    window.fileViewerMonaco.createCodeViewer(this._editorEl, {
      content: content,
      language: language,
      readOnly: false,
      ariaLabel: 'Editing ' + getFileName(this._filePath),
      // Editor pane wants the minimap by default; preview will turn it off.
      minimap: true,
    }).then(function (handle) {
      if (self._destroyed) {
        // Race: caller closed the editor while Monaco was loading.
        try { handle.dispose(); } catch (_) { /* ignore */ }
        return;
      }
      self._removeLoaderSpinner();
      self._wireMonaco(handle);
    }).catch(function (err) {
      if (self._destroyed) return;
      self._removeLoaderSpinner();
      var detail = err && err.message ? err.message : 'unknown error';
      self._renderLoaderError(
        'Editor could not be loaded: ' + detail + '. ' +
        'Check your network connection or use the terminal to edit this file.'
      );
    });
  };

  FileEditorPanel.prototype._renderLoaderError = function (message) {
    if (!this._editorEl) return;
    this._editorEl.innerHTML = '';
    var err = document.createElement('div');
    err.className = 'file-browser-empty';
    err.setAttribute('role', 'alert');
    err.textContent = message;
    this._editorEl.appendChild(err);
    this._updateStatus('Load failed', '', true);
    this._announceToScreenReader('Editor failed to load');
  };

  FileEditorPanel.prototype._wireMonaco = function (handle) {
    var self = this;
    this._monacoHandle = handle;
    this._editor = handle.editor;
    // Friendly alias so e2e tests + future TabManager-side helpers can
    // read the live Monaco IStandaloneCodeEditor without knowing that the
    // panel renames it `_editor` internally. Matches the
    // `_monacoEditor` name fa35745's #11 UI-half scenario (h) reaches
    // for at `tab.panel._monacoEditor`.
    this._monacoEditor = handle.editor;
    this._monacoLoaded = true;

    var monaco = handle.monaco;

    // Content + cursor change observers — collect disposables for clean teardown.
    this._disposables.push(this._editor.onDidChangeModelContent(function () {
      self._onContentChange();
    }));
    this._disposables.push(this._editor.onDidChangeCursorPosition(function () {
      self._updateCursorPosition();
    }));

    // Ctrl+S / Cmd+S — save. addCommand returns a string id, not a disposable,
    // so the registration is dropped together with the editor on dispose().
    try {
      this._editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        function () { self.save(); }
      );
    } catch (_) { /* keybinding registration failed — non-fatal */ }

    // Escape behaviour mirrors the prior Ace contract:
    //   - if the find widget is open, defer to it (it closes itself);
    //   - otherwise, close the editor (which prompts on unsaved changes).
    // Monaco's find widget calls preventDefault internally when it consumes
    // Escape, so the document-level handler in file-browser.js won't double-fire.
    this._disposables.push(this._editor.onKeyDown(function (e) {
      if (e.keyCode !== monaco.KeyCode.Escape) return;
      var findRevealed = false;
      try {
        var findCtrl = self._editor.getContribution('editor.contrib.findController');
        findRevealed = !!(findCtrl && findCtrl.getState && findCtrl.getState().isRevealed);
      } catch (_) { /* contribution not loaded yet */ }
      if (findRevealed) return;
      e.preventDefault();
      e.stopPropagation();
      self.close();
    }));

    // Position the cursor at the start. Monaco places it at (1,1) by default
    // — explicit setPosition guards against version drift.
    try { this._editor.setPosition({ lineNumber: 1, column: 1 }); } catch (_) { /* ignore */ }

    var languageId = getMonacoLanguage(getExtension(this._filePath));
    this._updateStatus('Ready', languageId);
    this._updateCursorPosition();
    if (this._dirty) this._dirtyDot.classList.add('visible');
    try { this._editor.focus(); } catch (_) { /* ignore */ }
  };

  // -- Content change / auto-save --

  FileEditorPanel.prototype._onContentChange = function () {
    if (this._destroyed) return;
    // Suppress writes triggered by our own setValue (e.g. _reloadFile,
    // future programmatic updates). Without this, Monaco's synchronous
    // onDidChangeModelContent re-creates the draft we just removed and
    // sets _dirty=true even though no user input occurred.
    if (this._suppressContentChange) return;
    this._dirty = true;
    this._dirtyDot.classList.add('visible');
    if (this._editor) {
      try {
        localStorage.setItem('fb-draft-' + this._filePath, this._editor.getValue());
      } catch (_) { /* quota or private mode — draft recovery becomes best-effort */ }
    }
    if (this._autoSave) this._scheduleAutoSave();
  };

  FileEditorPanel.prototype._scheduleAutoSave = function () {
    var self = this;
    if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
    this._autoSaveTimer = setTimeout(function () {
      self._autoSaveTimer = null;
      if (!self._destroyed && self._dirty && !self._saving) self.save();
    }, 3000);
  };

  // -- Save --

  FileEditorPanel.prototype._doSave = function () {
    var self = this;
    var val = this._editor ? this._editor.getValue() : '';
    this.authFetch('/api/files/content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: this._filePath, content: val, hash: this._fileHash }),
    }).then(function (resp) {
      if (self._destroyed) return;
      if (resp.ok) {
        return resp.json().then(function (d) {
          self._fileHash = d.hash || self._fileHash;
          self._lastSavedContent = val;
          self._dirty = false; self._saving = false; self._retryCount = 0;
          self._dirtyDot.classList.remove('visible');
          try { localStorage.removeItem('fb-draft-' + self._filePath); } catch (_) { /* ignore */ }
          self._updateStatus('Saved', getMonacoLanguage(getExtension(self._filePath)));
          self._announceToScreenReader('File saved');
          self.onSave();
        });
      } else if (resp.status === 409) {
        return resp.json().then(function (d) {
          self._saving = false;
          self._announceToScreenReader('File was modified externally');
          self._showConflictDialog(d);
        });
      } else { throw new Error('HTTP ' + resp.status); }
    }).catch(function () {
      if (self._destroyed) return;
      self._retryCount++;
      if (self._retryCount < 3) {
        setTimeout(function () { if (!self._destroyed) self._doSave(); }, 1000 * self._retryCount);
      } else {
        self._saving = false; self._retryCount = 0;
        self._updateStatus('SAVE FAILED', '', true);
        self._announceToScreenReader('Save failed');
      }
    });
  };

  // -- Conflict dialog --

  FileEditorPanel.prototype._showConflictDialog = function (conflictData) {
    var self = this;
    // conflictData may contain { error, currentHash, yourHash } from 409 response
    if (conflictData && conflictData.currentHash) {
      this._serverHash = conflictData.currentHash;
    }
    this._removeConflictBanner();
    var banner = document.createElement('div');
    banner.className = 'file-browser-conflict-banner';
    banner.setAttribute('role', 'alert');
    var msg = document.createElement('span');
    msg.textContent = 'This file was modified externally.';
    banner.appendChild(msg);

    var actions = document.createElement('div');
    actions.className = 'file-browser-conflict-banner-actions';

    var keepBtn = document.createElement('button');
    keepBtn.className = 'btn btn-primary btn-small';
    keepBtn.textContent = 'Keep My Changes';
    keepBtn.addEventListener('click', function () {
      self._removeConflictBanner();
      self._fileHash = null;
      self._saving = true; self._updateStatus('Saving...', '');
      self._doSave();
    });
    actions.appendChild(keepBtn);

    var reloadBtn = document.createElement('button');
    reloadBtn.className = 'btn btn-secondary btn-small';
    reloadBtn.textContent = 'Reload File';
    reloadBtn.addEventListener('click', function () { self._removeConflictBanner(); self._reloadFile(); });
    actions.appendChild(reloadBtn);

    var cmpBtn = document.createElement('button');
    cmpBtn.className = 'btn btn-secondary btn-small';
    cmpBtn.textContent = 'Compare Changes';
    cmpBtn.addEventListener('click', function () { self._removeConflictBanner(); self._showCompare(); });
    actions.appendChild(cmpBtn);

    banner.appendChild(actions);
    this.containerEl.insertBefore(banner, this._editorEl);
    this._conflictBanner = banner;
  };

  FileEditorPanel.prototype._removeConflictBanner = function () {
    if (this._conflictBanner && this._conflictBanner.parentNode) {
      this._conflictBanner.parentNode.removeChild(this._conflictBanner);
      this._conflictBanner = null;
    }
  };

  FileEditorPanel.prototype._reloadFile = function () {
    var self = this;
    this._updateStatus('Reloading...', '');
    this.authFetch('/api/files/content?path=' + encodeURIComponent(this._filePath))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        if (self._destroyed) return;
        self.applyDiskContent({ content: d.content, hash: d.hash });
        self._updateStatus('Reloaded', getMonacoLanguage(getExtension(self._filePath)));
      })
      .catch(function (e) { self._updateStatus('Reload failed: ' + e.message, '', true); });
  };

  // Apply already-fetched disk content into the live Monaco model with
  // cursor + scroll preserved. Public surface used by both the explicit
  // "Reload File" button (via _reloadFile, which fetches first) AND the
  // fs-watcher integration (#41) — when an external `change` event arrives
  // for a clean tab, the SSE handler can call applyDiskContent directly
  // with the content it already has from the server payload (or a
  // fresh fetch if `hash` doesn't match `_fileHash`), no need to
  // re-implement the cursor-preservation pattern at the call site.
  //
  // Inputs: { content: string, hash?: string }. Both required for the
  // optimistic-concurrency invariant — `_fileHash` MUST be advanced or
  // the next user save will trip a 409 against the new on-disk hash.
  FileEditorPanel.prototype.applyDiskContent = function (data) {
    if (this._destroyed || !data) return false;
    this._fileHash = data.hash || null;
    this._lastSavedContent = data.content == null ? '' : String(data.content);
    this._dirty = false;
    if (this._dirtyDot) this._dirtyDot.classList.remove('visible');
    if (this._editor) {
      // Preserve cursor position + selection + scroll across the reload
      // where feasible. Cursor + selection survive setValue if we re-apply
      // them; scroll is tracked via the editor's view state.
      var pos = null;
      var selection = null;
      var viewState = null;
      try { pos = this._editor.getPosition(); } catch (_) { /* ignore */ }
      try { selection = this._editor.getSelection(); } catch (_) { /* ignore */ }
      try { viewState = this._editor.saveViewState(); } catch (_) { /* ignore */ }
      // Suppress draft writes during the synchronous setValue — Monaco
      // fires onDidChangeModelContent INSIDE setValue, which would
      // otherwise re-write the just-loaded server content into the
      // localStorage draft slot AND set _dirty=true. The suppress flag
      // covers both paths in _onContentChange.
      this._suppressContentChange = true;
      try {
        this._editor.setValue(this._lastSavedContent);
      } finally {
        this._suppressContentChange = false;
      }
      // Restore view state first (it includes scroll) then position +
      // selection on top — restoring viewState alone may stomp the
      // explicit cursor we just captured if Monaco's saveViewState chose
      // a different anchor.
      if (viewState) {
        try { this._editor.restoreViewState(viewState); } catch (_) { /* ignore */ }
      }
      if (selection) {
        try { this._editor.setSelection(selection); } catch (_) { /* line may no longer exist */ }
      } else if (pos) {
        try { this._editor.setPosition(pos); } catch (_) { /* line may no longer exist */ }
      }
    }
    // Drop any stale draft AFTER the setValue + suppress block — this
    // ordering guarantees no draft slot races back in via a synchronous
    // onDidChangeModelContent.
    if (this._filePath) {
      try { localStorage.removeItem('fb-draft-' + this._filePath); } catch (_) { /* ignore */ }
    }
    return true;
  };

  FileEditorPanel.prototype._showCompare = function () {
    var self = this;
    var mine = this._editor ? this._editor.getValue() : '';
    this.authFetch('/api/files/content?path=' + encodeURIComponent(this._filePath))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { if (!self._destroyed) self._buildCompare(mine, d.content); })
      .catch(function (e) { self._updateStatus('Compare failed: ' + e.message, '', true); });
  };

  FileEditorPanel.prototype._buildCompare = function (mine, theirs) {
    var self = this;

    // Resources to dispose when the modal closes — captured here so the
    // _createModal onClose hook can tear them down regardless of which
    // dismiss path the user takes (overlay click, Escape, X button).
    var diffEditor = null;
    var originalModel = null;
    var modifiedModel = null;
    // Explicit lifecycle flag — replaces the prior `loading.parentNode`
    // DOM-attachment proxy that the modal-close path used to detect a
    // bail. The proxy worked today but coupled the async-completion check
    // to a specific child node; if the spinner UI is ever refactored, the
    // bail path silently breaks and leaks the diff editor + 2 models per
    // close. Flag is set inside the onClose hook so every dismiss path
    // (overlay click, Escape, X button) goes through it.
    var modalClosed = false;

    var m = _createModal({
      maxWidth: '90vw',
      maxHeight: '80vh',
      flex: true,
      onClose: function () {
        modalClosed = true;
        if (diffEditor) { try { diffEditor.dispose(); } catch (_) { /* ignore */ } }
        if (originalModel) { try { originalModel.dispose(); } catch (_) { /* ignore */ } }
        if (modifiedModel) { try { modifiedModel.dispose(); } catch (_) { /* ignore */ } }
      },
    });

    var hdr = document.createElement('div');
    hdr.className = 'modal-header';
    var t = document.createElement('h2');
    t.textContent = 'Compare Changes';
    hdr.appendChild(t);
    var xb = document.createElement('button');
    xb.className = 'close-btn'; xb.innerHTML = '&times;';
    xb.addEventListener('click', m.close);
    hdr.appendChild(xb);
    m.box.appendChild(hdr);

    var diffContainer = document.createElement('div');
    diffContainer.style.cssText =
      'flex:1;min-height:400px;min-width:0;overflow:hidden;padding:8px';
    m.box.appendChild(diffContainer);

    var loading = document.createElement('div');
    loading.className = 'fb-loading';
    loading.style.cssText = 'padding:24px;text-align:center';
    loading.textContent = 'Loading diff viewer...';
    diffContainer.appendChild(loading);

    if (!window.fileViewerMonaco || typeof window.fileViewerMonaco.loadMonaco !== 'function') {
      diffContainer.removeChild(loading);
      self._renderFallbackCompare(diffContainer, mine, theirs);
      return;
    }

    var language = getMonacoLanguage(getExtension(this._filePath));

    window.fileViewerMonaco.loadMonaco().then(function (monaco) {
      // Modal could have been closed before Monaco resolved; bail gracefully.
      if (modalClosed) return;
      while (diffContainer.firstChild) diffContainer.removeChild(diffContainer.firstChild);

      diffEditor = monaco.editor.createDiffEditor(diffContainer, {
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
        fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
        fontSize: 13,
        minimap: { enabled: false },
        wordWrap: 'on',
        theme: window.fileViewerMonaco.resolveMonacoTheme(),
        ariaLabel: 'Diff: server version vs your changes',
      });

      // Monaco's diff convention: original = baseline (server), modified = working.
      originalModel = monaco.editor.createModel(theirs, language);
      modifiedModel = monaco.editor.createModel(mine, language);
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    }).catch(function () {
      if (modalClosed) return;
      while (diffContainer.firstChild) diffContainer.removeChild(diffContainer.firstChild);
      self._renderFallbackCompare(diffContainer, mine, theirs);
    });
  };

  // Fallback compare view used when Monaco is unreachable. Visually inferior
  // to createDiffEditor (no intra-line highlighting), but preserves the
  // ability to manually compare server vs editor content.
  FileEditorPanel.prototype._renderFallbackCompare = function (container, mine, theirs) {
    var body = document.createElement('div');
    body.style.cssText = 'display:flex;gap:8px;flex:1;min-height:0;overflow:hidden';

    function makePane(label, text) {
      var pane = document.createElement('div');
      pane.style.cssText = 'flex:1;display:flex;flex-direction:column;min-width:0';
      var lbl = document.createElement('div');
      lbl.style.cssText = 'font-weight:bold;margin-bottom:4px;font-size:12px';
      lbl.textContent = label;
      pane.appendChild(lbl);
      var pre = document.createElement('pre');
      pre.style.cssText = 'flex:1;overflow:auto;font-size:12px;padding:8px;' +
        'background:var(--surface-tertiary);border-radius:4px;margin:0;white-space:pre-wrap;word-break:break-all';
      pre.textContent = text;
      pane.appendChild(pre);
      return pane;
    }
    body.appendChild(makePane('Your version', mine));
    body.appendChild(makePane('Server version', theirs));
    container.appendChild(body);
  };

  // -- Unsaved changes dialog --

  FileEditorPanel.prototype._showUnsavedDialog = function () {
    var self = this;
    var m = _createModal({ maxWidth: '400px' });

    var hdr = document.createElement('div');
    hdr.className = 'modal-header';
    var t = document.createElement('h2');
    t.textContent = 'Unsaved Changes';
    hdr.appendChild(t);
    m.box.appendChild(hdr);

    var body = document.createElement('div');
    body.className = 'modal-body';
    var p = document.createElement('p');
    p.textContent = 'You have unsaved changes. What would you like to do?';
    body.appendChild(p);
    m.box.appendChild(body);

    var footer = document.createElement('div');
    footer.className = 'modal-footer';
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

    function btn(cls, txt) {
      var b = document.createElement('button');
      b.className = cls; b.textContent = txt;
      footer.appendChild(b);
      return b;
    }
    btn('btn btn-secondary btn-small', 'Cancel').addEventListener('click', m.close);
    btn('btn btn-secondary btn-small', 'Discard').addEventListener('click', function () {
      m.close();
      // Clear the draft slot before destroy() so any future programmatic
      // re-open of this same path doesn't see stale draft content. destroy()
      // already removes it, but doing it here too is cheap and explicit.
      try { localStorage.removeItem('fb-draft-' + self._filePath); } catch (_) { /* ignore */ }
      // Note: previously also set `self._dirty = false` here. destroy()
      // doesn't read _dirty (it unconditionally tears down), so the
      // assignment was a dead store. Removed to keep the intent obvious
      // — if a future destroy() variant gates on _dirty, the discard
      // path must NOT silently mask that gate.
      self.destroy();
    });
    btn('btn btn-primary btn-small', 'Save & Close').addEventListener('click', function () {
      m.close();
      var orig = self.onSave;
      self.onSave = function () { self.onSave = orig; self.destroy(); };
      self._saving = false; self._dirty = true;
      self.save();
    });

    m.box.appendChild(footer);
  };

  // -- Status bar --

  FileEditorPanel.prototype._updateStatus = function (state, mode, isError) {
    if (!this._statusEl || this._destroyed) return;
    var parts = [];
    if (state) parts.push(state);
    if (mode) parts.push(mode);
    parts.push('UTF-8');
    this._statusEl.textContent = parts.join(' · ');
    this._statusEl.style.color = isError ? 'var(--status-error)' : '';
  };

  FileEditorPanel.prototype._updateCursorPosition = function () {
    if (!this._editor || !this._statusEl || this._destroyed) return;
    var pos = null;
    try { pos = this._editor.getPosition(); } catch (_) { /* ignore */ }
    var mode = getMonacoLanguage(getExtension(this._filePath));
    var state = this._saving ? 'Saving...' : (this._dirty ? 'Editing' : 'Ready');
    var parts = [state, mode, 'UTF-8'];
    if (pos) {
      // Monaco positions are 1-based already, no off-by-one adjustment needed.
      parts.push('Ln ' + pos.lineNumber + ', Col ' + pos.column);
    }
    this._statusEl.textContent = parts.join(' · ');
    this._statusEl.style.color = '';
  };

  FileEditorPanel.prototype._announceToScreenReader = function (message) {
    var el = document.getElementById('srAnnounce');
    if (el) { el.textContent = message; setTimeout(function () { el.textContent = ''; }, 1000); }
  };

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var exports = {
    FileEditorPanel: FileEditorPanel,
    // Canonical post-migration helper.
    getMonacoLanguage: getMonacoLanguage,
    // Backward-compat aliases — preserved so external callers don't break.
    getAceMode: getAceMode,
    getExtension: getExtension,
    getFileName: getFileName,
  };

  if (typeof window !== 'undefined') window.fileEditor = exports;
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
})();
