// file-editor.js — FileEditorPanel (Ace Editor integration for file browser)
// Dual-export: window.fileEditor (browser) + module.exports (Node.js tests)

(function () {
  'use strict';

  var ACE_MODE_MAP = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
    '.ts': 'typescript', '.tsx': 'tsx',
    '.py': 'python', '.rb': 'ruby', '.go': 'golang', '.rs': 'rust',
    '.java': 'java', '.c': 'c_cpp', '.cpp': 'c_cpp', '.h': 'c_cpp', '.hpp': 'c_cpp',
    '.cs': 'csharp', '.php': 'php',
    '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh', '.ps1': 'powershell',
    '.bat': 'batchfile', '.cmd': 'batchfile',
    '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
    '.xml': 'xml', '.html': 'html', '.htm': 'html',
    '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.sql': 'sql', '.graphql': 'graphql',
    '.swift': 'swift', '.kt': 'kotlin', '.scala': 'scala',
    '.r': 'r', '.lua': 'lua', '.pl': 'perl',
    '.md': 'markdown', '.mdx': 'markdown',
    '.json': 'json', '.json5': 'json5',
    '.csv': 'text', '.tsv': 'text',
    '.txt': 'text', '.log': 'text', '.cfg': 'text', '.ini': 'ini',
    '.env': 'text', '.properties': 'properties',
  };

  var ACE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.36.5/ace.min.js';
  var _aceScriptInjected = false;

  function getAceMode(ext) { return ext ? (ACE_MODE_MAP[ext.toLowerCase()] || 'text') : 'text'; }
  function getExtension(p) { var i = p.lastIndexOf('.'); return i === -1 ? '' : p.slice(i); }
  function getFileName(p) { var s = p.replace(/\\/g, '/').split('/'); return s[s.length - 1] || p; }

  function _getAceTheme() {
    var t = document.documentElement.getAttribute('data-theme') || 'midnight';
    var m = { 'midnight': 'tomorrow_night', 'classic-dark': 'tomorrow_night',
      'classic-light': 'tomorrow', 'monokai': 'monokai', 'nord': 'nord_dark',
      'solarized-dark': 'solarized_dark', 'solarized-light': 'solarized_light' };
    return 'ace/theme/' + (m[t] || 'tomorrow_night');
  }

  // Reusable modal overlay helper — returns { overlay, closeModal }
  function _createModal(opts) {
    var overlay = document.createElement('div');
    overlay.className = 'image-preview-modal active';
    overlay.style.zIndex = '9999';
    var box = document.createElement('div');
    box.className = 'modal-content';
    if (opts.maxWidth) box.style.maxWidth = opts.maxWidth;
    if (opts.maxHeight) box.style.maxHeight = opts.maxHeight;
    if (opts.flex) { box.style.display = 'flex'; box.style.flexDirection = 'column'; }
    overlay.appendChild(box);

    function closeModal() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
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
    this._filePath = null;    this._fileHash = null;
    this._lastSavedContent = null;
    this._aceEditor = null;   this._aceLoaded = false;
    this._autoSave = true;    this._autoSaveTimer = null;
    this._saving = false;     this._dirty = false;
    this._destroyed = false;  this._retryCount = 0;
    this._toolbarEl = null;   this._editorEl = null;
    this._statusEl = null;    this._dirtyDot = null;
    this._conflictBanner = null;
    this._autoSaveBtn = null; this._filenameEl = null;
  }

  FileEditorPanel.prototype.openEditor = function (filePath, content, fileHash) {
    this._filePath = filePath;
    this._fileHash = fileHash;
    this._lastSavedContent = content;
    this._dirty = false; this._saving = false;
    this._retryCount = 0; this._destroyed = false;
    this._buildEditorDOM();
    var draft = localStorage.getItem('fb-draft-' + filePath);
    var initial = (draft !== null) ? draft : content;
    this._restoredDraft = draft !== null && draft !== content;
    if (this._restoredDraft) this._dirty = true;
    this._loadAce(initial);
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
    return this._aceEditor ? this._aceEditor.getValue() !== this._lastSavedContent : false;
  };

  FileEditorPanel.prototype.close = function () {
    if (!this.isDirty()) { this.destroy(); return; }
    this._showUnsavedDialog();
  };

  FileEditorPanel.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._autoSaveTimer) { clearTimeout(this._autoSaveTimer); this._autoSaveTimer = null; }
    if (this._aceEditor) { this._aceEditor.destroy(); this._aceEditor = null; }
    if (this._filePath) localStorage.removeItem('fb-draft-' + this._filePath);
    this.containerEl.innerHTML = '';
    this.onClose();
  };

  // -- DOM construction --

  FileEditorPanel.prototype._buildEditorDOM = function () {
    var self = this;
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
    editorEl.id = 'fb-ace-editor-' + Date.now();
    this.containerEl.appendChild(editorEl);
    this._editorEl = editorEl;

    var statusEl = document.createElement('div');
    statusEl.className = 'file-browser-editor-status';
    statusEl.textContent = 'Loading editor...';
    this.containerEl.appendChild(statusEl);
    this._statusEl = statusEl;
  };

  // -- Ace loading --

  FileEditorPanel.prototype._loadAce = function (content) {
    var self = this;
    if (window.ace) { this._initAce(content); return; }

    // Show spinner
    this._editorEl.innerHTML = '';
    var sp = document.createElement('div');
    sp.className = 'file-browser-loading';
    var s = document.createElement('div');
    s.className = 'file-browser-spinner';
    sp.appendChild(s);
    this._editorEl.appendChild(sp);

    if (!_aceScriptInjected) {
      _aceScriptInjected = true;
      var sc = document.createElement('script');
      sc.src = ACE_CDN; sc.async = true;
      document.head.appendChild(sc);
    }

    var elapsed = 0, interval = 100;
    var poll = setInterval(function () {
      if (self._destroyed) { clearInterval(poll); return; }
      elapsed += interval;
      if (window.ace) { clearInterval(poll); self._initAce(content); }
      else if (elapsed >= 5000) {
        clearInterval(poll);
        self._editorEl.innerHTML = '';
        var err = document.createElement('div');
        err.className = 'file-browser-empty';
        err.textContent = 'Editor could not be loaded. Check your internet connection.';
        self._editorEl.appendChild(err);
        self._updateStatus('Load failed', '');
      }
    }, interval);
  };

  FileEditorPanel.prototype._initAce = function (content) {
    if (this._destroyed) return;
    var self = this;
    this._editorEl.innerHTML = '';
    this._aceLoaded = true;

    var editor = window.ace.edit(this._editorEl);
    this._aceEditor = editor;

    editor.setOptions({
      fontSize: 13,
      fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
      tabSize: 2, useSoftTabs: true,
      showPrintMargin: false, wrap: true,
      showGutter: true, highlightActiveLine: true,
    });
    editor.setTheme(_getAceTheme());

    var ext = getExtension(this._filePath);
    var mode = getAceMode(ext);
    editor.session.setMode('ace/mode/' + mode);
    editor.setValue(content, -1);

    editor.on('change', function () { self._onContentChange(); });
    editor.selection.on('changeCursor', function () { self._updateCursorPosition(); });

    editor.commands.addCommand({
      name: 'save', bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
      exec: function () { self.save(); }
    });
    editor.commands.addCommand({
      name: 'closeEditor', bindKey: { win: 'Escape', mac: 'Escape' },
      exec: function () {
        var sb = self._editorEl.querySelector('.ace_search');
        if (sb && sb.style.display !== 'none') { editor.execCommand('find'); return; }
        self.close();
      }
    });

    this._updateStatus('Ready', mode);
    this._updateCursorPosition();
    if (this._restoredDraft) {
      this._updateStatus('Recovered local draft (unsaved)', mode);
      this._announceToScreenReader('Recovered local draft loaded. Review and save when ready.');
    }
    if (this._dirty) this._dirtyDot.classList.add('visible');
    editor.focus();
  };

  // -- Content change / auto-save --

  FileEditorPanel.prototype._onContentChange = function () {
    if (this._destroyed) return;
    this._dirty = true;
    this._dirtyDot.classList.add('visible');
    if (this._aceEditor) localStorage.setItem('fb-draft-' + this._filePath, this._aceEditor.getValue());
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
    var val = this._aceEditor ? this._aceEditor.getValue() : '';
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
          localStorage.removeItem('fb-draft-' + self._filePath);
          self._updateStatus('Saved', getAceMode(getExtension(self._filePath)));
          self._announceToScreenReader('File saved');
          self.onSave();
        });
      } else if (resp.status === 409) {
        return resp.json().then(function (d) { self._saving = false; self._announceToScreenReader('File was modified externally'); self._showConflictDialog(d); });
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
        self._fileHash = d.hash || null;
        self._lastSavedContent = d.content;
        self._dirty = false;
        self._dirtyDot.classList.remove('visible');
        localStorage.removeItem('fb-draft-' + self._filePath);
        if (self._aceEditor) self._aceEditor.setValue(d.content, -1);
        self._updateStatus('Reloaded', getAceMode(getExtension(self._filePath)));
      })
      .catch(function (e) { self._updateStatus('Reload failed: ' + e.message, '', true); });
  };

  FileEditorPanel.prototype._showCompare = function () {
    var self = this;
    var mine = this._aceEditor ? this._aceEditor.getValue() : '';
    this.authFetch('/api/files/content?path=' + encodeURIComponent(this._filePath))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { if (!self._destroyed) self._buildCompare(mine, d.content); })
      .catch(function (e) { self._updateStatus('Compare failed: ' + e.message, '', true); });
  };

  FileEditorPanel.prototype._buildCompare = function (mine, theirs) {
    var m = _createModal({ maxWidth: '90vw', maxHeight: '80vh', flex: true });
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

    var body = document.createElement('div');
    body.style.cssText = 'display:flex;gap:8px;flex:1;min-height:0;overflow:hidden;padding:8px';

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
    m.box.appendChild(body);
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
      localStorage.removeItem('fb-draft-' + self._filePath);
      self._dirty = false;
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
    this._statusEl.textContent = parts.join(' \u00b7 ');
    this._statusEl.style.color = isError ? 'var(--status-error)' : '';
  };

  FileEditorPanel.prototype._updateCursorPosition = function () {
    if (!this._aceEditor || !this._statusEl || this._destroyed) return;
    var pos = this._aceEditor.getCursorPosition();
    var mode = getAceMode(getExtension(this._filePath));
    var state = this._saving ? 'Saving...' : (this._dirty ? 'Editing' : 'Ready');
    this._statusEl.textContent = [state, mode, 'UTF-8',
      'Ln ' + (pos.row + 1) + ', Col ' + (pos.column + 1)].join(' \u00b7 ');
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
    getAceMode: getAceMode,
    getExtension: getExtension,
    getFileName: getFileName,
  };

  if (typeof window !== 'undefined') window.fileEditor = exports;
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
})();
