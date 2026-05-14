// file-diff.js — DiffViewerPanel for the file browser.
//
// Mounts a monaco.editor.createDiffEditor instance into a host element
// supplied by the caller (TabManager hands it a per-tab .fb-tab-content
// host; can also be invoked standalone). Read-only side-by-side diff with
// intra-line highlighting.
//
// Public API (window.fileDiff):
//   DiffViewerPanel constructor({ authFetch, containerEl, onClose })
//     .openDiff({ originalSource, modifiedSource, originalLabel,
//                 modifiedLabel, language, path })
//     .openHeadVsWorking(path)   convenience: fetches git-show + content
//     .openRefVsWorking(path, ref)
//     .openFileVsFile(originalPath, modifiedPath)
//     .destroy()
//     .isDirty()  → always false (read-only)
//
//   buildGitShowUrl(path, ref)        pure helper; testable
//   buildContentUrl(path)             pure helper; testable
//   parseGitShowError(response)       pure helper; testable; classifies
//                                     404 / 403 / 503 / 504 / etc.
//
// TabManager integration: third tab mode `'diff'` mounts this panel into
// a per-tab content host. Persistence schema v2 records `compareWithRef`
// or `compareWithPath` so reload restores the same diff target.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Pure helpers (testable under Node)
  // ---------------------------------------------------------------------------

  function buildGitShowUrl(path, ref) {
    if (!path) return '';
    var qs = 'path=' + encodeURIComponent(path);
    if (ref && ref !== 'HEAD') qs += '&ref=' + encodeURIComponent(ref);
    return '/api/files/git-show?' + qs;
  }

  function buildContentUrl(path) {
    if (!path) return '';
    return '/api/files/content?path=' + encodeURIComponent(path);
  }

  // Map a git-show fetch response status into a user-facing classification.
  // Helps the diff renderer decide whether to show a "not a git repo"
  // empty-state vs a generic error vs a "ref doesn't exist" hint.
  function parseGitShowError(response) {
    if (!response) return { kind: 'unknown', userMessage: 'Unknown error.' };
    var status = response.status;
    if (status === 404) return {
      kind: 'not-found',
      userMessage: 'File or revision not found at this ref. The directory may not be a git repository, or the file did not exist at this revision.',
    };
    if (status === 400) return {
      kind: 'bad-request',
      userMessage: 'Invalid revision name.',
    };
    if (status === 403) return {
      kind: 'forbidden',
      userMessage: 'Access to this file is not permitted.',
    };
    if (status === 413) return {
      kind: 'too-large',
      userMessage: 'File at this revision exceeds the 5 MB diff cap.',
    };
    if (status === 503) return {
      kind: 'git-missing',
      userMessage: 'Git is not installed on the server.',
    };
    if (status === 504) return {
      kind: 'timeout',
      userMessage: 'Git took too long to read this revision.',
    };
    if (status >= 500) return {
      kind: 'server-error',
      userMessage: 'Server error while fetching the revision.',
    };
    return { kind: 'unknown', userMessage: 'Failed to load revision (HTTP ' + status + ').' };
  }

  // ---------------------------------------------------------------------------
  // Browser-only beyond this point
  // ---------------------------------------------------------------------------

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        buildGitShowUrl: buildGitShowUrl,
        buildContentUrl: buildContentUrl,
        parseGitShowError: parseGitShowError,
      };
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Helpers for derived state
  // ---------------------------------------------------------------------------

  function _basename(p) {
    if (!p) return '';
    var s = String(p).replace(/\\/g, '/');
    var i = s.lastIndexOf('/');
    return i === -1 ? s : (s.slice(i + 1) || s);
  }

  function _languageFor(pathOrExt) {
    if (typeof window !== 'undefined' && window.fileViewerMonaco &&
        typeof window.fileViewerMonaco.getMonacoLanguage === 'function') {
      return window.fileViewerMonaco.getMonacoLanguage(pathOrExt);
    }
    return 'plaintext';
  }

  // ---------------------------------------------------------------------------
  // DiffViewerPanel
  // ---------------------------------------------------------------------------

  function DiffViewerPanel(options) {
    options = options || {};
    if (!options.containerEl) {
      throw new Error('DiffViewerPanel: options.containerEl is required');
    }
    if (typeof options.authFetch !== 'function') {
      throw new Error('DiffViewerPanel: options.authFetch is required');
    }
    this.authFetch = options.authFetch;
    this.containerEl = options.containerEl;
    this.onClose = options.onClose || function () {};
    this._diffEditor = null;
    this._originalModel = null;
    this._modifiedModel = null;
    this._destroyed = false;
    this._headerEl = null;
    this._bodyEl = null;
  }

  DiffViewerPanel.prototype.isDirty = function () { return false; };

  DiffViewerPanel.prototype.close = function () { this.destroy(); };

  DiffViewerPanel.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    this._teardownDiffEditor();
    if (this.containerEl) this.containerEl.innerHTML = '';
    try { this.onClose(); } catch (_) { /* ignore */ }
  };

  DiffViewerPanel.prototype._teardownDiffEditor = function () {
    if (this._diffEditor) {
      try { this._diffEditor.dispose(); } catch (_) { /* ignore */ }
      this._diffEditor = null;
    }
    if (this._originalModel) {
      try { this._originalModel.dispose(); } catch (_) { /* ignore */ }
      this._originalModel = null;
    }
    if (this._modifiedModel) {
      try { this._modifiedModel.dispose(); } catch (_) { /* ignore */ }
      this._modifiedModel = null;
    }
  };

  DiffViewerPanel.prototype._buildShell = function (originalLabel, modifiedLabel) {
    this.containerEl.innerHTML = '';
    this.containerEl.classList.add('fb-diff-host');

    var header = document.createElement('div');
    header.className = 'fb-diff-header';

    var title = document.createElement('span');
    title.className = 'fb-diff-title';
    title.textContent = (originalLabel || 'Original') + ' ↔ ' + (modifiedLabel || 'Modified');
    title.title = title.textContent;
    header.appendChild(title);

    this.containerEl.appendChild(header);
    this._headerEl = header;

    var body = document.createElement('div');
    body.className = 'fb-diff-body';
    this.containerEl.appendChild(body);
    this._bodyEl = body;
  };

  DiffViewerPanel.prototype._showLoading = function (message) {
    var el = document.createElement('div');
    el.className = 'fb-loading';
    el.style.cssText = 'padding:24px;text-align:center';
    el.textContent = message || 'Loading diff...';
    if (this._bodyEl) {
      this._bodyEl.innerHTML = '';
      this._bodyEl.appendChild(el);
    }
  };

  DiffViewerPanel.prototype._showError = function (message) {
    var el = document.createElement('div');
    el.className = 'fb-preview-error';
    el.setAttribute('role', 'alert');
    el.textContent = message || 'Diff failed.';
    if (this._bodyEl) {
      this._bodyEl.innerHTML = '';
      this._bodyEl.appendChild(el);
    }
  };

  DiffViewerPanel.prototype.openDiff = function (opts) {
    opts = opts || {};
    var self = this;
    var original = opts.originalSource == null ? '' : String(opts.originalSource);
    var modified = opts.modifiedSource == null ? '' : String(opts.modifiedSource);
    var language = opts.language || _languageFor(opts.path || opts.modifiedLabel || '');

    this._buildShell(opts.originalLabel, opts.modifiedLabel);
    this._showLoading('Loading diff viewer...');

    if (!window.fileViewerMonaco || typeof window.fileViewerMonaco.loadMonaco !== 'function') {
      this._showError('Diff viewer unavailable: Monaco loader missing.');
      return Promise.resolve(null);
    }

    return window.fileViewerMonaco.loadMonaco().then(function (monaco) {
      if (self._destroyed) return null;

      // Tear down any previous diff state before mounting a new one — caller
      // may invoke openDiff() multiple times on the same panel (e.g. user
      // changes the "Compare with..." target).
      self._teardownDiffEditor();
      self._bodyEl.innerHTML = '';

      var theme = (window.fileViewerMonaco.resolveMonacoTheme &&
                   window.fileViewerMonaco.resolveMonacoTheme()) || 'vs-dark';

      self._diffEditor = monaco.editor.createDiffEditor(self._bodyEl, {
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
        fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
        fontSize: 13,
        minimap: { enabled: false },
        wordWrap: 'off',
        theme: theme,
        ariaLabel: 'Diff: ' + (opts.originalLabel || 'original') +
                   ' vs ' + (opts.modifiedLabel || 'modified'),
        // Disable the editors' own context menus — host UI owns the actions.
        originalEditable: false,
        contextmenu: false,
      });

      self._originalModel = monaco.editor.createModel(original, language);
      self._modifiedModel = monaco.editor.createModel(modified, language);
      self._diffEditor.setModel({
        original: self._originalModel,
        modified: self._modifiedModel,
      });
      return self;
    }).catch(function (err) {
      if (self._destroyed) return null;
      self._showError('Diff viewer failed to load: ' +
        (err && err.message ? err.message : 'unknown error'));
      return null;
    });
  };

  DiffViewerPanel.prototype.openHeadVsWorking = function (path) {
    return this.openRefVsWorking(path, 'HEAD');
  };

  DiffViewerPanel.prototype.openRefVsWorking = function (path, ref) {
    var self = this;
    if (!path) return Promise.reject(new Error('openRefVsWorking: path required'));
    ref = ref || 'HEAD';

    this._buildShell(_basename(path) + ' @ ' + ref, _basename(path) + ' (working)');
    this._showLoading('Fetching ' + ref + '...');

    var originalUrl = buildGitShowUrl(path, ref);
    var modifiedUrl = buildContentUrl(path);

    var originalPromise = this.authFetch(originalUrl).then(function (resp) {
      if (!resp.ok) {
        var classified = parseGitShowError(resp);
        var err = new Error(classified.userMessage);
        err.classified = classified;
        throw err;
      }
      return resp.json().then(function (data) { return data.content || ''; });
    });
    var modifiedPromise = this.authFetch(modifiedUrl).then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' loading working tree');
      return resp.json().then(function (data) { return data.content || ''; });
    });

    return Promise.all([originalPromise, modifiedPromise]).then(function (sources) {
      if (self._destroyed) return null;
      return self.openDiff({
        originalSource: sources[0],
        modifiedSource: sources[1],
        originalLabel: _basename(path) + ' @ ' + ref,
        modifiedLabel: _basename(path) + ' (working)',
        path: path,
      });
    }).catch(function (err) {
      if (self._destroyed) return null;
      self._showError(err && err.message ? err.message :
        'Failed to load ' + ref + ' for diff.');
      return null;
    });
  };

  DiffViewerPanel.prototype.openFileVsFile = function (originalPath, modifiedPath) {
    var self = this;
    if (!originalPath || !modifiedPath) {
      return Promise.reject(new Error('openFileVsFile: both paths required'));
    }
    this._buildShell(_basename(originalPath), _basename(modifiedPath));
    this._showLoading('Fetching files...');

    function fetchContent(p) {
      return self.authFetch(buildContentUrl(p)).then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' loading ' + _basename(p));
        return resp.json().then(function (d) { return d.content || ''; });
      });
    }

    return Promise.all([fetchContent(originalPath), fetchContent(modifiedPath)])
      .then(function (sources) {
        if (self._destroyed) return null;
        return self.openDiff({
          originalSource: sources[0],
          modifiedSource: sources[1],
          originalLabel: _basename(originalPath),
          modifiedLabel: _basename(modifiedPath),
          path: modifiedPath, // language hint
        });
      })
      .catch(function (err) {
        if (self._destroyed) return null;
        self._showError(err && err.message ? err.message : 'File compare failed.');
        return null;
      });
  };

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var exportsObj = {
    DiffViewerPanel: DiffViewerPanel,
    buildGitShowUrl: buildGitShowUrl,
    buildContentUrl: buildContentUrl,
    parseGitShowError: parseGitShowError,
  };

  window.fileDiff = exportsObj;
  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
})();
