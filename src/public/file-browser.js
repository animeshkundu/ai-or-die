// file-browser.js — FileBrowserPanel, FilePreviewPanel, TerminalPathDetector
// Dual-export: window.fileBrowser (browser) + module.exports (Node.js tests)

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Utility functions (shared, testable)
  // ---------------------------------------------------------------------------

  var FILE_ICON_MAP = {
    image: 'fileImage',
    code: 'fileCode',
    markdown: 'fileMarkdown',
    json: 'fileJson',
    csv: 'fileCsv',
    pdf: 'filePdf',
    text: 'fileText',
    binary: 'fileBinary',
  };

  // Monaco language resolution — delegates to window.fileViewerMonaco when
  // available (browser); falls back to require()'ing the loader module
  // directly under Node tests so this file remains testable without a DOM.
  // Replaces the prior Ace mode map (ADR-0016).
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

  // Backward-compat alias preserved for any external consumer that still
  // imports `getAceMode`. Returns the canonical Monaco language id; the
  // ACE-prefixed name is retained per the migration directive (preserve
  // public API surface) and intentionally not removed.
  function getAceMode(extension) {
    return getMonacoLanguage(extension);
  }

  function getFileIcon(item) {
    if (item.isDirectory) return 'folder';
    return FILE_ICON_MAP[item.mimeCategory] || 'file';
  }

  function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes === null || bytes === undefined) return '';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    var size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
    return size + ' ' + units[i];
  }

  function buildBreadcrumbs(currentPath, basePath) {
    // Normalize to forward slashes
    var current = currentPath.replace(/\\/g, '/');
    var base = basePath.replace(/\\/g, '/');

    // Strip trailing slashes
    current = current.replace(/\/+$/, '');
    base = base.replace(/\/+$/, '');

    if (!current.startsWith(base)) return [{ name: current, path: current }];

    var relative = current.slice(base.length);
    var segments = [{ name: base.split('/').pop() || base, path: base }];

    if (relative) {
      var parts = relative.split('/').filter(Boolean);
      var accumulated = base;
      for (var i = 0; i < parts.length; i++) {
        accumulated += '/' + parts[i];
        segments.push({ name: parts[i], path: accumulated });
      }
    }

    return segments;
  }

  function isPreviewable(mimeCategory) {
    return mimeCategory !== 'binary';
  }

  function isEditable(mimeCategory) {
    return ['text', 'code', 'markdown', 'json', 'csv'].indexOf(mimeCategory) !== -1;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------------------
  // Sandboxed-srcdoc helper for HTML preview (#18).
  //
  // Hardens an arbitrary HTML payload before it gets handed to an iframe via
  // srcdoc + sandbox="" by:
  //   1. Stripping every <base ...> tag (case-insensitive). A malicious
  //      <base href="javascript:..."> would otherwise turn every relative
  //      link into a script execution surface.
  //   2. Stripping <meta http-equiv="refresh" ...>. The empty sandbox already
  //      blocks top-level navigation, but a refresh attempt logs a noisy
  //      console error; remove it pre-emptively.
  //   3. Injecting a Content-Security-Policy <meta> at the top of <head>:
  //        default-src 'none' — block everything by default
  //        img-src data: blob: — inline images via data: still work
  //        style-src 'unsafe-inline' — inline <style> still renders (sandbox
  //          empty = null origin, so 'self' would not match; without inline
  //          styles, almost no real HTML file looks right)
  //        font-src data: — embedded data: fonts work
  //      No connect-src/script-src grants — the iframe cannot reach the
  //      network, blocking exfiltration vectors that CSS-injection attacks
  //      depend on (background-image: url(http://attacker), font-display, etc.)
  //
  // Pure string transformation — exported under window.fileBrowser for tests.
  // ---------------------------------------------------------------------------

  // CSP for the sandboxed HTML preview iframe. Locked down to the absolute
  // minimum the iframe needs to render real-world HTML files.
  //   - default-src 'none'         : block everything by default. CSP3 fall-
  //                                  back applies for connect-src/frame-src/
  //                                  worker-src/manifest-src/media-src/
  //                                  object-src — they all inherit 'none'.
  //   - img-src data: blob:        : inline data: images render; no http(s)
  //                                  fetch; no exfiltration via background-
  //                                  image since style-src is also locked.
  //   - style-src 'unsafe-inline'  : intentional. Sandbox makes the iframe
  //                                  origin "null" so 'self' wouldn't match.
  //                                  Without inline styles essentially every
  //                                  real HTML file looks broken. CSS-exfil
  //                                  vectors are closed at the network layer
  //                                  (no img/font/connect-src grant for
  //                                  http(s)). NOT 'self' — that wouldn't
  //                                  resolve under sandbox null origin.
  //   - font-src data:             : embedded data: fonts render.
  //   - form-action 'none'         : per CSP spec form-action does NOT fall
  //                                  back to default-src. Without this it
  //                                  defaults to '*'. Sandbox already blocks
  //                                  form submission today (no allow-forms),
  //                                  but if a future contributor adds
  //                                  allow-forms this becomes the only line
  //                                  of defense.
  //   - base-uri 'none'            : per CSP spec base-uri also doesn't fall
  //                                  back to default-src. Second line of
  //                                  defense behind the regex <base> strip
  //                                  in buildSandboxedSrcdoc — if the regex
  //                                  ever has an edge-case bypass (it can —
  //                                  see the over-strip caveat in that
  //                                  helper), base-uri 'none' still neuters
  //                                  the injected base URL.
  //
  // NOTE: frame-ancestors is intentionally omitted — per CSP spec, it is
  // ignored when the policy is delivered via <meta http-equiv>. Adding it
  // here would mislead a future maintainer into thinking it does anything.
  // The sandbox attribute itself prevents the iframe from being framed.
  var HTML_PREVIEW_CSP = "default-src 'none'; img-src data: blob:; " +
    "style-src 'unsafe-inline'; font-src data:; " +
    "form-action 'none'; base-uri 'none';";

  // KNOWN LIMITATION: this regex strips ANY <base ...> token regardless of
  // HTML context. Literal text inside <p>/<pre>/<code>/<script>/<style>/
  // comments/attribute-values that contains the bytes "<base" will be
  // silently mangled (e.g. an HTML tutorial that quotes `<base>` in a
  // <p>). Security impact is zero — those literals are inert text per the
  // HTML parser, and CSP base-uri 'none' is the second line of defense if
  // a real <base> ever slips through. UX impact is real for tutorial-style
  // HTML files. Switching to DOMParser-based mutation is the proper fix
  // and is tracked as a follow-up; for now the simpler regex wins on
  // worker-thread-free overhead. Same caveat applies to the meta-refresh
  // strip below.
  function buildSandboxedSrcdoc(html) {
    var s = String(html == null ? '' : html);
    s = s.replace(/<base\b[^>]*>/gi, '');
    s = s.replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*['"]?refresh['"]?[^>]*>/gi, '');

    var cspTag = '<meta http-equiv="Content-Security-Policy" content="' + HTML_PREVIEW_CSP + '">';

    if (/<head\b[^>]*>/i.test(s)) {
      s = s.replace(/<head\b[^>]*>/i, function (m) { return m + cspTag; });
    } else if (/<html\b[^>]*>/i.test(s)) {
      s = s.replace(/<html\b[^>]*>/i, function (m) { return m + '<head>' + cspTag + '</head>'; });
    } else {
      s = '<head>' + cspTag + '</head>' + s;
    }
    return s;
  }

  // 1 MB cap — beyond this, the rendered preview is disabled and the user
  // sees the source view only. Large HTML payloads in srcdoc balloon memory
  // and can hang the renderer.
  var HTML_PREVIEW_SRCDOC_CAP_BYTES = 1024 * 1024;

  // UTF-8 byte counter. Browsers always have Blob; Node tests since v18 do
  // too, but older Node CI matrices fall back through Buffer.byteLength
  // (also UTF-8 by default). Final fallback is a hand-rolled UTF-8 byte
  // count — `s.length` would return UTF-16 code units which severely
  // undercounts CJK / emoji / heavy-Unicode HTML (3-4× off) and could let
  // a 1.2 MB Chinese-text file slip past the 1 MB cap and hang the
  // renderer the cap exists to prevent.
  function _measureBytes(s) {
    if (typeof Blob !== 'undefined') {
      try { return new Blob([s]).size; } catch (_) { /* fall through */ }
    }
    if (typeof Buffer !== 'undefined' && Buffer.byteLength) {
      try { return Buffer.byteLength(s, 'utf8'); } catch (_) { /* fall through */ }
    }
    // Final fallback — count UTF-8 bytes by hand.
    var bytes = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if      (c < 0x80)    bytes += 1;
      else if (c < 0x800)   bytes += 2;
      else if (c < 0xD800 || c >= 0xE000) bytes += 3;
      else { bytes += 4; i++; } // surrogate pair → 4 UTF-8 bytes, skip the trailing surrogate
    }
    return bytes;
  }

  function isHtmlExtension(nameOrPath) {
    if (!nameOrPath) return false;
    var n = String(nameOrPath).toLowerCase();
    return n.endsWith('.html') || n.endsWith('.htm') || n.endsWith('.xhtml');
  }

  function isIpynbExtension(nameOrPath) {
    if (!nameOrPath) return false;
    return String(nameOrPath).toLowerCase().endsWith('.ipynb');
  }

  // ---------------------------------------------------------------------------
  // Lazy script loader — used by image panzoom (vendored at /vendor/panzoom.min.js).
  // Returns a Promise that resolves when window[globalCheck] becomes truthy
  // after the script tag finishes loading. Memoised per src so concurrent
  // callers share one fetch.
  // ---------------------------------------------------------------------------

  var _scriptLoadPromises = {};

  function loadVendorScript(src, globalCheck) {
    if (typeof window === 'undefined') return Promise.reject(new Error('not in a browser'));
    if (window[globalCheck]) return Promise.resolve(window[globalCheck]);
    if (_scriptLoadPromises[src]) return _scriptLoadPromises[src];
    _scriptLoadPromises[src] = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-vendor-src="' + src + '"]');
      function done() {
        if (window[globalCheck]) resolve(window[globalCheck]);
        else reject(new Error('loadVendorScript: ' + globalCheck + ' not present after ' + src + ' loaded'));
      }
      if (existing) {
        existing.addEventListener('load', done, { once: true });
        existing.addEventListener('error', function () {
          reject(new Error('loadVendorScript: failed to load ' + src));
        }, { once: true });
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.setAttribute('data-vendor-src', src);
      s.onload = done;
      s.onerror = function () {
        // Reset cache so the next caller can retry on transient failure.
        delete _scriptLoadPromises[src];
        reject(new Error('loadVendorScript: failed to load ' + src));
      };
      document.head.appendChild(s);
    });
    return _scriptLoadPromises[src];
  }

  function loadPanzoom() {
    return loadVendorScript('/vendor/panzoom.min.js', 'Panzoom');
  }

  // ---------------------------------------------------------------------------
  // FileBrowserPanel
  // ---------------------------------------------------------------------------

  function FileBrowserPanel(options) {
    this.app = options.app;
    this.authFetch = options.authFetch;
    this.initialPath = options.initialPath || null;
    // Optional callback returning the active session's working directory at
    // the moment the panel opens. Lets the panel default to *the current*
    // session's cwd rather than the cwd captured at construction time —
    // important for users who switch sessions while the panel is closed.
    // Falsy callbacks (or callbacks returning null/undefined) are tolerated:
    // open() falls back to startPath → initialPath → null. A throwing
    // callback is also tolerated (defensive coding per agent-instructions/05).
    this.getCwd = typeof options.getCwd === 'function' ? options.getCwd : null;

    this._open = false;
    this._currentPath = null;
    this._basePath = null;
    this._items = [];
    this._selectedItem = null;
    this._currentView = 'browse'; // 'browse' | 'preview'
    this._focusedIndex = -1;
    this._searchVisible = false;
    this._searchQuery = '';
    this._dragDepth = 0;

    this._panelEl = null;
    this._backdropEl = null;
    this._previewPanel = null;
    this._tabManager = null; // Lazy-initialized on first preview/editor open.

    this._buildDOM();
  }

  FileBrowserPanel.prototype._buildDOM = function () {
    // Backdrop (for mobile/narrow)
    this._backdropEl = document.createElement('div');
    this._backdropEl.className = 'file-browser-backdrop';
    this._backdropEl.addEventListener('click', this.close.bind(this));
    document.body.appendChild(this._backdropEl);

    // Main panel
    var panel = document.createElement('div');
    panel.className = 'file-browser-panel';
    panel.id = 'fileBrowserPanel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'File Browser');
    panel.tabIndex = -1; // Allow focus for keyboard events

    // Resize handle
    var resizeHandle = document.createElement('div');
    resizeHandle.className = 'file-browser-resize-handle';
    this._setupResizeHandle(resizeHandle, panel);
    panel.appendChild(resizeHandle);

    // Header row (merged breadcrumbs + actions)
    var header = document.createElement('div');
    header.className = 'file-browser-header';

    // Back button
    var backBtn = document.createElement('button');
    backBtn.className = 'fb-header-btn fb-back-btn';
    backBtn.title = 'Back';
    backBtn.setAttribute('aria-label', 'Go back');
    backBtn.innerHTML = window.icons ? window.icons.arrowLeft(16) : '&larr;';
    backBtn.addEventListener('click', this._handleBack.bind(this));
    header.appendChild(backBtn);
    this._backBtn = backBtn;

    // Breadcrumbs container
    var breadcrumbs = document.createElement('div');
    breadcrumbs.className = 'fb-breadcrumbs';
    header.appendChild(breadcrumbs);
    this._breadcrumbsEl = breadcrumbs;

    // Spacer
    var spacer = document.createElement('div');
    spacer.style.flex = '1';
    header.appendChild(spacer);

    // Search toggle
    var searchBtn = document.createElement('button');
    searchBtn.className = 'fb-header-btn';
    searchBtn.title = 'Search';
    searchBtn.setAttribute('aria-label', 'Toggle search');
    searchBtn.innerHTML = window.icons ? window.icons.search(14) : 'S';
    searchBtn.addEventListener('click', this._toggleSearch.bind(this));
    header.appendChild(searchBtn);

    // Upload button
    var uploadBtn = document.createElement('button');
    uploadBtn.className = 'fb-header-btn';
    uploadBtn.title = 'Upload files';
    uploadBtn.setAttribute('aria-label', 'Upload files');
    uploadBtn.innerHTML = window.icons ? window.icons.upload(14) : 'U';
    uploadBtn.addEventListener('click', this._openFilePicker.bind(this));
    header.appendChild(uploadBtn);

    // Refresh button
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'fb-header-btn';
    refreshBtn.title = 'Refresh';
    refreshBtn.setAttribute('aria-label', 'Refresh file list');
    refreshBtn.innerHTML = window.icons ? window.icons.refresh(14) : 'R';
    refreshBtn.addEventListener('click', this._refresh.bind(this));
    header.appendChild(refreshBtn);

    // Close button
    var closeBtn = document.createElement('button');
    closeBtn.className = 'fb-header-btn fb-close-btn';
    closeBtn.title = 'Close (Esc)';
    closeBtn.setAttribute('aria-label', 'Close file browser');
    closeBtn.innerHTML = window.icons ? window.icons.x(14) : '&times;';
    closeBtn.addEventListener('click', this.close.bind(this));
    header.appendChild(closeBtn);

    panel.appendChild(header);

    // Search bar (collapsible)
    var searchBar = document.createElement('div');
    searchBar.className = 'fb-search-bar'; // hidden by default via CSS
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'fb-search-input';
    searchInput.placeholder = 'Filter files...';
    searchInput.setAttribute('aria-label', 'Filter files');
    searchInput.addEventListener('input', this._onSearchInput.bind(this));
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        this._toggleSearch();
        e.stopPropagation();
      }
    }.bind(this));
    searchBar.appendChild(searchInput);
    panel.appendChild(searchBar);
    this._searchBar = searchBar;
    this._searchInput = searchInput;

    // Content area (holds file list or preview)
    var content = document.createElement('div');
    content.className = 'fb-content';

    // File list
    var fileList = document.createElement('div');
    fileList.className = 'fb-file-list';
    fileList.setAttribute('role', 'tree');
    fileList.setAttribute('aria-label', 'File listing');
    fileList.tabIndex = 0;
    fileList.addEventListener('keydown', this._onListKeyDown.bind(this));
    content.appendChild(fileList);
    this._fileListEl = fileList;

    // Preview container
    var previewContainer = document.createElement('div');
    previewContainer.className = 'fb-preview-container';
    previewContainer.style.display = 'none';
    content.appendChild(previewContainer);
    this._previewContainer = previewContainer;

    panel.appendChild(content);

    // Upload overlay (full-panel drag-drop)
    var uploadOverlay = document.createElement('div');
    uploadOverlay.className = 'file-browser-upload-overlay';
    uploadOverlay.innerHTML = '<div class="fb-upload-overlay-content">' +
      (window.icons ? window.icons.upload(48) : '') +
      '<span>Drop files here to upload</span></div>';
    panel.appendChild(uploadOverlay);
    this._uploadOverlay = uploadOverlay;

    // Hidden file input for upload
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', this._onFilesSelected.bind(this));
    panel.appendChild(fileInput);
    this._fileInput = fileInput;

    // Status bar
    var statusBar = document.createElement('div');
    statusBar.className = 'fb-status-bar';
    statusBar.textContent = '';
    panel.appendChild(statusBar);
    this._statusBar = statusBar;

    // Setup drag-drop on the panel
    this._setupDragDrop(panel);

    // Keyboard: Escape to close
    panel.addEventListener('keydown', function (e) {
      // Cmd/Ctrl+Shift+F → toggle the cross-file search panel (#9). Catch
      // here (panel-scope) and at the document level (below) so the
      // shortcut works whether the panel or the surrounding terminal has
      // focus when the user presses it.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleSearchPanel();
        return;
      }
      if (e.key === 'Escape') {
        if (this._searchPanel && this._searchPanel.isOpen()) {
          this._searchPanel.close();
        } else if (this._searchVisible) {
          this._toggleSearch();
        } else if (this._currentView === 'editor') {
          // Don't handle Escape here — Monaco's find widget has its own
          // Escape command. The document-level fallback handler will catch
          // it if Monaco doesn't consume it.
          return;
        } else if (this._currentView === 'preview') {
          this._showBrowseView();
        } else {
          this.close();
        }
        e.stopPropagation();
        e.preventDefault();
      }
    }.bind(this));

    document.body.appendChild(panel);
    this._panelEl = panel;

    // Document-level Escape handler (fallback when panel doesn't have focus)
    var self = this;
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && self._open) {
        if (self._currentView === 'editor') {
          // Check if Monaco's find/replace widget is open inside the editor.
          // Monaco usually consumes Escape itself (stopPropagation), but a
          // belt-and-braces DOM check guards against version drift and
          // ensures we never close the editor out from under an open widget.
          var monacoFind = self._panelEl.querySelector('.monaco-editor .find-widget.visible');
          if (monacoFind) return;
          if (self._editorPanel) self._editorPanel.close();
        } else if (self._currentView === 'preview') {
          self._showBrowseView();
        } else {
          self.close();
        }
        e.stopPropagation();
        e.preventDefault();
      }
    });

    // Setup clipboard paste
    this._setupClipboardPaste();

    // Create preview panel
    this._previewPanel = new FilePreviewPanel({
      authFetch: this.authFetch,
      containerEl: this._previewContainer,
      onEdit: this._onEditRequest.bind(this),
      onBack: this._showBrowseView.bind(this),
      onDiffRequest: this._onDiffRequest.bind(this),
    });
  };

  // Routes a diff-button click from FilePreviewPanel through to TabManager,
  // opening a new diff tab. Falls back to a status-bar error in degraded
  // environments where TabManager couldn't construct.
  FileBrowserPanel.prototype._onDiffRequest = function (req) {
    if (!req || !req.path) return;
    var tm = this._ensureTabManager();
    if (!tm) {
      if (this._statusBar) {
        this._statusBar.textContent = 'Diff requires multi-file tabs (TabManager unavailable).';
      }
      return;
    }
    tm.openFile(req.path, 'diff', {
      compareWithRef:  req.compareWithRef || null,
      compareWithPath: req.compareWithPath || null,
    });
  };

  FileBrowserPanel.prototype._setupResizeHandle = function (handle, panel) {
    var startX, startWidth;
    var onMouseMove = function (e) {
      var delta = startX - e.clientX;
      var newWidth = Math.min(Math.max(startWidth + delta, 280), window.innerWidth * 0.6);
      panel.style.width = newWidth + 'px';
    };
    var onMouseUp = function () {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      // Refit terminal
      if (this.app && this.app.fitAddon) {
        this.app.fitAddon.fit();
      }
    }.bind(this);

    handle.addEventListener('mousedown', function (e) {
      startX = e.clientX;
      startWidth = panel.offsetWidth;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });
  };

  FileBrowserPanel.prototype._setupDragDrop = function (panel) {
    var self = this;
    panel.addEventListener('dragenter', function (e) {
      e.preventDefault();
      self._dragDepth++;
      if (self._dragDepth === 1) {
        self._uploadOverlay.classList.add('active');
      }
    });
    panel.addEventListener('dragleave', function (e) {
      e.preventDefault();
      self._dragDepth--;
      if (self._dragDepth <= 0) {
        self._dragDepth = 0;
        self._uploadOverlay.classList.remove('active');
      }
    });
    panel.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    panel.addEventListener('drop', function (e) {
      e.preventDefault();
      self._dragDepth = 0;
      self._uploadOverlay.classList.remove('active');
      self._handleDrop(e.dataTransfer);
    });
  };

  // -- Open / Close / Toggle --

  FileBrowserPanel.prototype.open = function (startPath) {
    if (this._open) return;
    this._open = true;
    // Resolution order:
    //   1. Explicit startPath argument from the caller (e.g. openToFile)
    //   2. Live cwd from the active session (getCwd is invoked HERE, every
    //      time, so a session switch between opens picks up the new cwd)
    //   3. initialPath captured at construction (kept for tests + tooling)
    //   4. null — the navigateTo handler will fall back to the server's
    //      default base folder
    var cwd = null;
    if (this.getCwd) {
      try { cwd = this.getCwd(); } catch (_) { cwd = null; }
    }
    var p = startPath || cwd || this.initialPath || null;
    this._panelEl.classList.add('open');
    this._updateOverlayMode();
    this.navigateTo(p);
    this._announceToScreenReader('File browser opened');
    // Adjust terminal width
    this._adjustTerminal();
  };

  FileBrowserPanel.prototype.close = function () {
    if (!this._open) return;
    this._open = false;
    this._panelEl.classList.remove('open');
    this._backdropEl.classList.remove('active');
    this._announceToScreenReader('File browser closed');
    this._adjustTerminal();
  };

  FileBrowserPanel.prototype.toggle = function () {
    if (this._open) this.close(); else this.open();
  };

  FileBrowserPanel.prototype.isOpen = function () {
    return this._open;
  };

  FileBrowserPanel.prototype.openToFile = function (filePath) {
    // Navigate to the parent directory and select the file
    var parts = filePath.replace(/\\/g, '/').split('/');
    var fileName = parts.pop();
    var dirPath = parts.join('/') || '/';
    this.open(dirPath);
    // After navigation, auto-select the file
    this._pendingSelectFile = fileName;
  };

  FileBrowserPanel.prototype._adjustTerminal = function () {
    var termContainer = document.querySelector('.terminal-container');
    if (!termContainer) return;
    if (this._open && !this._isOverlayMode()) {
      termContainer.style.marginRight = this._panelEl.offsetWidth + 'px';
    } else {
      termContainer.style.marginRight = '';
    }

    // Clear any pending resize from previous toggle
    var self = this;
    if (this._resizeTimer) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }
    if (this._transitionHandler) {
      this._panelEl.removeEventListener('transitionend', this._transitionHandler);
    }

    // Refit terminals when CSS transition completes (not on a hardcoded timer)
    this._transitionHandler = function (e) {
      if (e.propertyName !== 'transform') return;
      self._panelEl.removeEventListener('transitionend', self._transitionHandler);
      self._transitionHandler = null;
      if (self._resizeTimer) {
        clearTimeout(self._resizeTimer);
        self._resizeTimer = null;
      }
      self._refitAllTerminals();
    };
    this._panelEl.addEventListener('transitionend', this._transitionHandler);

    // Safety fallback (300ms = 200ms transition + 100ms buffer)
    this._resizeTimer = setTimeout(function () {
      self._resizeTimer = null;
      if (self._transitionHandler) {
        self._panelEl.removeEventListener('transitionend', self._transitionHandler);
        self._transitionHandler = null;
      }
      self._refitAllTerminals();
    }, 300);
  };

  FileBrowserPanel.prototype._refitAllTerminals = function () {
    // Refit main terminal
    if (this.app && this.app.fitAddon) {
      try { this.app.fitTerminal(); } catch (e) { /* ignore */ }
    }
    // Refit split pane terminals
    if (this.app && this.app.splitContainer && this.app.splitContainer.splits) {
      this.app.splitContainer.splits.forEach(function (split) {
        try { split.fit(); } catch (e) { /* ignore */ }
      });
    }
  };

  FileBrowserPanel.prototype._isOverlayMode = function () {
    return window.innerWidth <= 1024;
  };

  FileBrowserPanel.prototype._updateOverlayMode = function () {
    if (this._isOverlayMode()) {
      this._backdropEl.classList.add('active');
    } else {
      this._backdropEl.classList.remove('active');
    }
  };

  // -- Navigation --

  FileBrowserPanel.prototype.navigateTo = function (dirPath) {
    var self = this;
    var params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);
    params.append('limit', '500');
    params.append('offset', '0');

    this._statusBar.textContent = 'Loading...';

    this.authFetch('/api/files?' + params.toString())
      .then(function (resp) {
        if (!resp.ok) throw new Error('Failed to load: ' + resp.status);
        return resp.json();
      })
      .then(function (data) {
        self._currentPath = data.currentPath;
        self._basePath = data.baseFolder;
        self._items = data.items;
        self._renderBreadcrumbs();
        self._renderItems();
        self._showBrowseView();
        self._statusBar.textContent = data.totalCount + ' item' + (data.totalCount !== 1 ? 's' : '');

        // Auto-select pending file
        if (self._pendingSelectFile) {
          var target = self._pendingSelectFile;
          self._pendingSelectFile = null;
          for (var i = 0; i < self._items.length; i++) {
            if (self._items[i].name === target) {
              self._onItemClick(self._items[i]);
              break;
            }
          }
        }
      })
      .catch(function (err) {
        self._statusBar.textContent = 'Error: ' + err.message;
      });
  };

  FileBrowserPanel.prototype.navigateUp = function () {
    if (this._currentPath && this._basePath) {
      var parent = this._currentPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      if (parent && parent.length >= this._basePath.replace(/\\/g, '/').length) {
        this.navigateTo(parent);
      }
    }
  };

  FileBrowserPanel.prototype.navigateHome = function () {
    this.navigateTo(this._basePath);
  };

  // -- Rendering --

  FileBrowserPanel.prototype._renderBreadcrumbs = function () {
    var el = this._breadcrumbsEl;
    el.innerHTML = '';
    if (!this._currentPath || !this._basePath) return;
    var segments = buildBreadcrumbs(this._currentPath, this._basePath);
    var self = this;
    segments.forEach(function (seg, idx) {
      if (idx > 0) {
        var sep = document.createElement('span');
        sep.className = 'fb-breadcrumb-sep';
        sep.textContent = '/';
        el.appendChild(sep);
      }
      var span = document.createElement('span');
      span.className = 'fb-breadcrumb' + (idx === segments.length - 1 ? ' active' : '');
      span.textContent = seg.name;
      span.title = seg.path;
      if (idx < segments.length - 1) {
        span.style.cursor = 'pointer';
        span.addEventListener('click', function () {
          self.navigateTo(seg.path);
        });
      }
      el.appendChild(span);
    });

    // Show/hide back button
    var atBase = this._currentPath.replace(/\\/g, '/') === this._basePath.replace(/\\/g, '/');
    this._backBtn.style.display = (this._currentView === 'browse' && atBase) ? 'none' : '';
  };

  FileBrowserPanel.prototype._renderItems = function () {
    var list = this._fileListEl;
    list.innerHTML = '';
    this._focusedIndex = -1;

    var items = this._getFilteredItems();

    if (items.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'fb-empty-message';
      empty.textContent = this._searchQuery ? 'No matching files' : 'Empty directory';
      list.appendChild(empty);
      return;
    }

    var self = this;
    items.forEach(function (item, idx) {
      var row = document.createElement('div');
      row.className = 'file-browser-item';
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-selected', 'false');
      row.setAttribute('tabindex', idx === 0 ? '0' : '-1');
      row.dataset.index = idx;
      row.dataset.path = item.path;

      // Icon
      var iconSpan = document.createElement('span');
      iconSpan.className = 'file-item-icon';
      var iconName = getFileIcon(item);
      iconSpan.innerHTML = window.icons ? window.icons[iconName](18) : '';
      // Color-code icons
      if (item.isDirectory) iconSpan.style.color = 'var(--accent-default)';
      else if (item.mimeCategory === 'image') iconSpan.style.color = 'var(--color-green-400)';
      else if (item.mimeCategory === 'markdown') iconSpan.style.color = 'var(--color-cyan-400)';
      else if (item.mimeCategory === 'json') iconSpan.style.color = 'var(--color-yellow-400)';
      else if (item.mimeCategory === 'pdf') iconSpan.style.color = 'var(--color-red-400)';
      row.appendChild(iconSpan);

      // Name
      var nameSpan = document.createElement('span');
      nameSpan.className = 'file-item-name';
      nameSpan.textContent = item.name + (item.isDirectory ? '/' : '');
      row.appendChild(nameSpan);

      // Size (files only)
      if (!item.isDirectory && item.size !== null) {
        var sizeSpan = document.createElement('span');
        sizeSpan.className = 'file-item-size';
        sizeSpan.textContent = formatFileSize(item.size);
        row.appendChild(sizeSpan);
      }

      // Edit icon (hover-reveal, editable files only)
      if (item.editable) {
        var editBtn = document.createElement('button');
        editBtn.className = 'file-item-edit';
        editBtn.title = 'Edit';
        editBtn.setAttribute('aria-label', 'Edit ' + item.name);
        editBtn.innerHTML = window.icons ? window.icons.edit(14) : 'E';
        editBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          self._onEditRequest(item);
        });
        row.appendChild(editBtn);
      }

      // Click handler
      row.addEventListener('click', function () {
        self._onItemClick(item);
      });

      list.appendChild(row);
    });
  };

  FileBrowserPanel.prototype._getFilteredItems = function () {
    if (!this._searchQuery) return this._items;
    var q = this._searchQuery.toLowerCase();
    return this._items.filter(function (item) {
      return item.name.toLowerCase().indexOf(q) !== -1;
    });
  };

  // -- View switching --

  FileBrowserPanel.prototype._showBrowseView = function () {
    this._currentView = 'browse';
    this._fileListEl.style.display = '';
    this._previewContainer.style.display = 'none';
    this._panelEl.classList.remove('editor-active');
    this._renderBreadcrumbs();
    this._adjustTerminal();
  };

  FileBrowserPanel.prototype._showPreviewView = function (item) {
    this._currentView = 'preview';
    this._selectedItem = item;
    this._fileListEl.style.display = 'none';
    this._previewContainer.style.display = '';
    // Consume any jump-to-line set by a terminal-link click (systems-engineer's
    // #7). The flag lives on the panel; clear it now so a subsequent open of a
    // different file doesn't inherit a stale target line.
    var jumpTo = this._pendingJumpTo || null;
    this._pendingJumpTo = null;
    var tm = this._ensureTabManager();
    if (tm) {
      tm.openFile(item.path, 'preview', { item: item, jumpTo: jumpTo });
    } else {
      // TabManager unavailable — fall through to the legacy single-pane path
      // so previewing still works in degraded environments.
      this._previewPanel.showPreview(item, this._currentPath, { jumpTo: jumpTo });
    }
    this._renderBreadcrumbs();
    this._announceToScreenReader('Previewing ' + item.name);
  };

  // -- Event handlers --

  FileBrowserPanel.prototype._onItemClick = function (item) {
    if (item.isDirectory) {
      this.navigateTo(item.path);
    } else {
      this._showPreviewView(item);
    }
  };

  FileBrowserPanel.prototype._onEditRequest = function (item) {
    if (!item || !item.editable) return;
    var self = this;

    // Fetch file content first
    this.authFetch('/api/files/content?path=' + encodeURIComponent(item.path))
      .then(function (resp) {
        if (!resp.ok) throw new Error('Failed to load file');
        return resp.json();
      })
      .then(function (data) {
        self._showEditorView(item, data.content, data.hash);
      })
      .catch(function (err) {
        self._statusBar.textContent = 'Failed to open editor: ' + err.message;
      });
  };

  FileBrowserPanel.prototype._showEditorView = function (item, content, hash) {
    var self = this;
    this._currentView = 'editor';
    this._selectedItem = item;
    this._fileListEl.style.display = 'none';
    this._previewContainer.style.display = '';
    this._panelEl.classList.add('editor-active');

    var tm = this._ensureTabManager();
    if (tm) {
      var tab = tm.openFile(item.path, 'editor', { item: item, content: content, hash: hash });
      // Track the active editor panel so the existing back-button + Escape
      // flows that reference _editorPanel keep working unchanged.
      if (tab && tab.panel) self._editorPanel = tab.panel;
      this._announceToScreenReader('Editing ' + item.name);
      this._renderBreadcrumbs();
      this._adjustTerminal();
      return;
    }

    // Legacy single-pane fallback (TabManager unavailable).
    this._previewContainer.innerHTML = '';

    if (window.fileEditor && window.fileEditor.FileEditorPanel) {
      this._editorPanel = new window.fileEditor.FileEditorPanel({
        authFetch: this.authFetch,
        containerEl: this._previewContainer,
        onClose: function () {
          self._editorPanel = null;
          self._showBrowseView();
        },
        onSave: function () {
          self._announceToScreenReader('File saved');
        },
      });
      this._editorPanel.openEditor(item.path, content, hash);
      this._announceToScreenReader('Editing ' + item.name);
    } else {
      this._previewContainer.innerHTML = '<div class="fb-preview-error">Editor not available.</div>';
    }

    this._renderBreadcrumbs();
    this._adjustTerminal();
  };

  // TabManager (file-tabs.js) is created lazily on the first preview/editor
  // open so panels with no tab activity never pay the construction cost.
  // Returns null if window.fileTabs hasn't loaded — caller falls back to the
  // legacy single-pane flow.
  FileBrowserPanel.prototype._ensureTabManager = function () {
    if (this._tabManager) return this._tabManager;
    if (!window.fileTabs || typeof window.fileTabs.TabManager !== 'function') return null;
    var self = this;
    var sessionKey = (this.app && this.app.currentClaudeSessionId) ?
      this.app.currentClaudeSessionId : 'default';
    try {
      this._tabManager = new window.fileTabs.TabManager({
        containerEl: this._previewContainer,
        authFetch: this.authFetch,
        sessionKey: sessionKey,
        iconSet: window.icons || null,
        onActiveChange: function (info) {
          // Surface the active editor panel so legacy back-button flows
          // (which call self._editorPanel.close()) still work.
          if (info && info.tab && info.tab.mode === 'editor' && info.tab.panel) {
            self._editorPanel = info.tab.panel;
          } else {
            self._editorPanel = null;
          }
        },
        onAllClosed: function () {
          self._editorPanel = null;
          self._showBrowseView();
        },
      });
    } catch (e) {
      // Construction error (e.g. localStorage broken in private mode) — log
      // once and fall through to legacy single-pane behaviour.
      if (typeof console !== 'undefined') console.warn('TabManager init failed:', e);
      return null;
    }
    return this._tabManager;
  };

  // Cross-file search panel (#9) — lazily mounted on first Cmd/Ctrl+Shift+F
  // press OR header search-button click. The panel sits ABOVE the preview
  // container (and thus above the tab strip when present) so it overlays
  // the active view without disrupting the open tabs.
  FileBrowserPanel.prototype._ensureSearchPanel = function () {
    if (this._searchPanel) return this._searchPanel;
    if (!window.fileSearch || typeof window.fileSearch.SearchPanel !== 'function') return null;
    var self = this;
    try {
      this._searchPanel = new window.fileSearch.SearchPanel({
        containerEl: this._panelEl,
        getAuthToken: function () {
          // Server accepts ?token=… as alternative to Authorization header
          // (server.js:464). Read it from the same place authFetch does.
          // NOTE: this duplicates AuthManager.appendAuthToUrl-style logic
          // INTENTIONALLY — file-search.js loads BEFORE auth.js per the
          // index.html script order, so window.authManager isn't bound at
          // module-load time. If a future reorder makes authManager
          // module-eval-safe (or if this getter becomes call-time-only with
          // a defensive null-check on window.authManager), DRY this out.
          if (window.auth && window.auth.token) return window.auth.token;
          try { return window.sessionStorage && window.sessionStorage.getItem('cc-web-token'); }
          catch (_) { return null; }
        },
        getSearchRoot: function () {
          // Search defaults to the current panel cwd (which honours getCwd
          // per #14). Server falls back to baseFolder if we pass null.
          return self._currentPath || null;
        },
        onResultClick: function (hit) {
          if (!hit || !hit.path) return;
          // Reuse the proven openFileInViewer → _pendingJumpTo →
          // tabManager preview path established for terminal-link clicks
          // (cef62bf). The tab gets a Monaco preview with the cursor at
          // (line, col).
          if (self.app && typeof self.app.openFileInViewer === 'function') {
            self.app.openFileInViewer(hit.path, hit.line, hit.col);
            return;
          }
          // Fallback: route directly through the panel if app's helper
          // isn't reachable (e.g. SearchPanel embedded in a future
          // standalone harness).
          self._pendingJumpTo = { line: hit.line, col: hit.col || 1 };
          self.openToFile(hit.path);
        },
        onClose: function () {
          // Restore focus to the file list / tab strip if the user dismissed
          // the panel, so keyboard nav continues seamlessly.
          if (self._fileListEl && self._fileListEl.style.display !== 'none') {
            try { self._fileListEl.focus(); } catch (_) { /* ignore */ }
          }
        },
      });
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('SearchPanel init failed:', e);
      return null;
    }
    return this._searchPanel;
  };

  // Toggle the search panel, opening + focusing if closed. Public so the
  // app's command palette / keyboard handler can drive it.
  FileBrowserPanel.prototype.toggleSearchPanel = function () {
    var sp = this._ensureSearchPanel();
    if (!sp) return false;
    if (sp.isOpen()) sp.close(); else sp.open();
    return true;
  };

  FileBrowserPanel.prototype._handleBack = function () {
    if (this._currentView === 'editor') {
      if (this._editorPanel) this._editorPanel.close();
    } else if (this._currentView === 'preview') {
      this._showBrowseView();
    } else {
      this.navigateUp();
    }
  };

  FileBrowserPanel.prototype._toggleSearch = function () {
    this._searchVisible = !this._searchVisible;
    if (this._searchVisible) {
      this._searchBar.classList.add('visible');
    } else {
      this._searchBar.classList.remove('visible');
    }
    if (this._searchVisible) {
      this._searchInput.focus();
    } else {
      this._searchQuery = '';
      this._searchInput.value = '';
      this._renderItems();
    }
  };

  FileBrowserPanel.prototype._onSearchInput = function () {
    this._searchQuery = this._searchInput.value;
    this._renderItems();
  };

  FileBrowserPanel.prototype._refresh = function () {
    this.navigateTo(this._currentPath);
  };

  // -- ARIA Tree keyboard navigation (W3C APG pattern) --

  FileBrowserPanel.prototype._onListKeyDown = function (e) {
    var items = this._fileListEl.querySelectorAll('.file-browser-item');
    if (!items.length) return;

    var current = this._focusedIndex;
    if (current < 0) current = 0;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this._setFocusedIndex(Math.min(current + 1, items.length - 1), items);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this._setFocusedIndex(Math.max(current - 1, 0), items);
        break;
      case 'ArrowRight': {
        // Expand / enter directory
        e.preventDefault();
        var filtered = this._getFilteredItems();
        if (filtered[current] && filtered[current].isDirectory) {
          this._onItemClick(filtered[current]);
        }
        break;
      }
      case 'ArrowLeft':
        e.preventDefault();
        this.navigateUp();
        break;
      case 'Home':
        e.preventDefault();
        this._setFocusedIndex(0, items);
        break;
      case 'End':
        e.preventDefault();
        this._setFocusedIndex(items.length - 1, items);
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        var filteredItems = this._getFilteredItems();
        if (filteredItems[current]) {
          this._onItemClick(filteredItems[current]);
        }
        break;
      }
      case 'Backspace':
        e.preventDefault();
        this.navigateUp();
        break;
    }
  };

  FileBrowserPanel.prototype._setFocusedIndex = function (idx, items) {
    // Clear old focus
    if (this._focusedIndex >= 0 && items[this._focusedIndex]) {
      items[this._focusedIndex].setAttribute('tabindex', '-1');
      items[this._focusedIndex].classList.remove('focused');
    }
    this._focusedIndex = idx;
    if (items[idx]) {
      items[idx].setAttribute('tabindex', '0');
      items[idx].classList.add('focused');
      items[idx].focus();
    }
  };

  // -- Upload --

  FileBrowserPanel.prototype._openFilePicker = function () {
    this._fileInput.click();
  };

  FileBrowserPanel.prototype.openFilePicker = function () {
    this._openFilePicker();
  };

  FileBrowserPanel.prototype._onFilesSelected = function (e) {
    var files = e.target.files;
    if (!files || !files.length) return;
    this._uploadFiles(Array.from(files));
    this._fileInput.value = '';
  };

  FileBrowserPanel.prototype._handleDrop = function (dataTransfer) {
    if (!dataTransfer) return;
    var items = dataTransfer.items;
    var self = this;

    // Try directory-aware upload via webkitGetAsEntry
    if (items && items.length && items[0].webkitGetAsEntry) {
      var entries = [];
      for (var i = 0; i < items.length; i++) {
        var entry = items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      if (entries.length) {
        this._uploadEntries(entries, this._currentPath);
        return;
      }
    }

    // Fallback: regular files
    if (dataTransfer.files && dataTransfer.files.length) {
      this._uploadFiles(Array.from(dataTransfer.files));
    }
  };

  FileBrowserPanel.prototype._uploadFiles = function (files) {
    var self = this;
    var queue = Array.from(files);
    var total = queue.length;
    var done = 0;
    var skipped = 0;

    function uploadNext() {
      if (done + skipped >= total) {
        self._hideUploadProgress();
        self._refresh();
        var msg = done + ' uploaded';
        if (skipped > 0) msg += ', ' + skipped + ' skipped';
        self._statusBar.textContent = msg;
        self._announceToScreenReader(msg);
        return;
      }

      var file = queue[done + skipped];
      self._showUploadProgress(done + skipped + 1, total);
      self._statusBar.textContent = 'Uploading ' + (done + skipped + 1) + ' of ' + total + '...';

      var reader = new FileReader();
      reader.onload = function () {
        var base64 = reader.result.split(',')[1];
        self.authFetch('/api/files/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetDir: self._currentPath,
            fileName: file.name,
            content: base64,
            overwrite: false,
          }),
        })
          .then(function (resp) {
            if (resp.status === 409) {
              // File already exists — show overwrite banner
              return self._showOverwriteBanner(file, base64, function onResolved(action) {
                if (action === 'skip') skipped++;
                else done++;
                uploadNext();
              });
            }
            if (!resp.ok) {
              return resp.json().then(function (err) { throw new Error(err.error); });
            }
            done++;
            uploadNext();
          })
          .catch(function (err) {
            self._statusBar.textContent = 'Upload failed: ' + err.message;
            skipped++;
            uploadNext();
          });
      };
      reader.readAsDataURL(file);
    }

    uploadNext();
  };

  FileBrowserPanel.prototype._showOverwriteBanner = function (file, base64, onResolved) {
    var self = this;
    // Remove any existing banner
    this._hideOverwriteBanner();

    var banner = document.createElement('div');
    banner.className = 'file-browser-overwrite-banner';
    banner.setAttribute('role', 'alert');

    var msg = document.createElement('span');
    msg.className = 'fb-overwrite-msg';
    msg.textContent = '"' + file.name + '" already exists.';
    banner.appendChild(msg);

    var actions = document.createElement('div');
    actions.className = 'fb-overwrite-actions';

    var overwriteBtn = document.createElement('button');
    overwriteBtn.className = 'btn btn-small';
    overwriteBtn.style.color = 'var(--status-error)';
    overwriteBtn.textContent = 'Overwrite';
    overwriteBtn.addEventListener('click', function () {
      self._hideOverwriteBanner();
      // Re-upload with overwrite=true
      self.authFetch('/api/files/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDir: self._currentPath,
          fileName: file.name,
          content: base64,
          overwrite: true,
        }),
      }).then(function () {
        onResolved('overwrite');
      }).catch(function () {
        onResolved('skip');
      });
    });
    actions.appendChild(overwriteBtn);

    var keepBothBtn = document.createElement('button');
    keepBothBtn.className = 'btn btn-secondary btn-small';
    var ext = file.name.lastIndexOf('.') > 0 ? file.name.slice(file.name.lastIndexOf('.')) : '';
    var baseName = ext ? file.name.slice(0, -ext.length) : file.name;
    var newName = baseName + ' (1)' + ext;
    keepBothBtn.textContent = 'Keep Both \u2192 ' + newName;
    keepBothBtn.addEventListener('click', function () {
      self._hideOverwriteBanner();
      self.authFetch('/api/files/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDir: self._currentPath,
          fileName: newName,
          content: base64,
          overwrite: false,
        }),
      }).then(function () {
        onResolved('keepBoth');
      }).catch(function () {
        onResolved('skip');
      });
    });
    actions.appendChild(keepBothBtn);

    var skipBtn = document.createElement('button');
    skipBtn.className = 'btn btn-secondary btn-small';
    skipBtn.textContent = 'Skip';
    skipBtn.addEventListener('click', function () {
      self._hideOverwriteBanner();
      onResolved('skip');
    });
    actions.appendChild(skipBtn);

    banner.appendChild(actions);
    this._fileListEl.parentNode.insertBefore(banner, this._fileListEl);
    this._overwriteBanner = banner;
  };

  FileBrowserPanel.prototype._hideOverwriteBanner = function () {
    if (this._overwriteBanner && this._overwriteBanner.parentNode) {
      this._overwriteBanner.parentNode.removeChild(this._overwriteBanner);
    }
    this._overwriteBanner = null;
  };

  FileBrowserPanel.prototype._showUploadProgress = function (current, total) {
    if (!this._uploadProgressBar) {
      var bar = document.createElement('div');
      bar.className = 'fb-upload-progress-bar';
      this._panelEl.insertBefore(bar, this._panelEl.firstChild.nextSibling); // after resize handle
      this._uploadProgressBar = bar;
    }
    var pct = total > 0 ? (current / total) * 100 : 0;
    this._uploadProgressBar.style.width = pct + '%';
    this._uploadProgressBar.style.display = '';
  };

  FileBrowserPanel.prototype._hideUploadProgress = function () {
    if (this._uploadProgressBar) {
      this._uploadProgressBar.style.display = 'none';
      this._uploadProgressBar.style.width = '0%';
    }
  };

  // -- Clipboard paste upload --

  FileBrowserPanel.prototype._setupClipboardPaste = function () {
    var self = this;
    this._panelEl.addEventListener('paste', function (e) {
      if (!self._open || self._currentView !== 'browse') return;
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      var imageFiles = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image/') === 0) {
          var blob = items[i].getAsFile();
          if (blob) imageFiles.push(blob);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        self._uploadFiles(imageFiles);
      }
    });
  };

  FileBrowserPanel.prototype._uploadEntries = function (entries, basePath) {
    var self = this;
    var queue = [];

    function traverse(entry, relativePath) {
      return new Promise(function (resolve) {
        if (entry.isFile) {
          entry.file(function (file) {
            queue.push({ file: file, relativePath: relativePath + file.name });
            resolve();
          });
        } else if (entry.isDirectory) {
          var reader = entry.createReader();
          reader.readEntries(function (children) {
            var promises = children.map(function (child) {
              return traverse(child, relativePath + entry.name + '/');
            });
            Promise.all(promises).then(resolve);
          });
        } else {
          resolve();
        }
      });
    }

    Promise.all(entries.map(function (entry) {
      return traverse(entry, '');
    })).then(function () {
      // Upload all files in queue sequentially
      var idx = 0;
      function next() {
        if (idx >= queue.length) {
          self._refresh();
          self._statusBar.textContent = queue.length + ' file(s) uploaded';
          return;
        }
        var item = queue[idx];
        self._statusBar.textContent = 'Uploading ' + (idx + 1) + ' of ' + queue.length + '...';
        var reader = new FileReader();
        reader.onload = function () {
          var base64 = reader.result.split(',')[1];
          // Compute target dir from relative path
          var parts = item.relativePath.replace(/\\/g, '/').split('/');
          var fileName = parts.pop();
          var subDir = parts.length ? basePath + '/' + parts.join('/') : basePath;

          self.authFetch('/api/files/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              targetDir: subDir,
              fileName: fileName,
              content: base64,
              overwrite: false,
            }),
          })
            .then(function () { idx++; next(); })
            .catch(function () { idx++; next(); });
        };
        reader.readAsDataURL(item.file);
      }
      next();
    });
  };

  // -- Screen reader --

  FileBrowserPanel.prototype._announceToScreenReader = function (message) {
    var el = document.getElementById('srAnnounce');
    if (el) {
      el.textContent = message;
      setTimeout(function () { el.textContent = ''; }, 1000);
    }
  };

  // ---------------------------------------------------------------------------
  // FilePreviewPanel
  // ---------------------------------------------------------------------------

  function FilePreviewPanel(options) {
    this.authFetch = options.authFetch;
    this.containerEl = options.containerEl;
    this.onEdit = options.onEdit || function () {};
    this.onBack = options.onBack || function () {};
    // Diff-request handler — host (FileBrowserPanel) routes through
    // TabManager.openFile(path, 'diff', { compareWithRef|compareWithPath }).
    // Not wired in standalone preview-panel use; the Diff button is hidden
    // when this is missing.
    this.onDiffRequest = options.onDiffRequest || null;
    // Tear-down hooks for renderers that attach state outside the container
    // (Panzoom, Monaco, PDF.js etc. wire document-level event listeners that
    // innerHTML='' won't release). Each renderer pushes a function here;
    // showPreview() drains them before rendering the next file.
    this._activeDisposers = [];
  }

  // Builds the Diff button + popover with three comparison targets:
  //   - Compare with HEAD (one-click)
  //   - Compare with ref… (prompt for any git rev)
  //   - Compare with another file… (prompt for absolute path)
  // The popover uses native event delegation; click-outside closes it via a
  // capture-phase listener installed once per popover lifetime.
  FilePreviewPanel.prototype._buildDiffMenu = function (item) {
    var self = this;
    var wrap = document.createElement('div');
    wrap.className = 'fb-diff-menu-wrap';
    wrap.style.position = 'relative';
    wrap.style.display = 'inline-block';

    var btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-small fb-diff-menu-btn';
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = 'Diff ▾';
    wrap.appendChild(btn);

    var menu = document.createElement('div');
    menu.className = 'fb-diff-menu';
    menu.setAttribute('role', 'menu');
    menu.style.display = 'none';
    wrap.appendChild(menu);

    function mkItem(label, handler) {
      var i = document.createElement('button');
      i.type = 'button';
      i.className = 'fb-diff-menu-item';
      i.setAttribute('role', 'menuitem');
      i.textContent = label;
      i.addEventListener('click', function (e) {
        e.stopPropagation();
        closeMenu();
        try { handler(); } catch (err) {
          if (typeof console !== 'undefined') console.error('diff handler:', err);
        }
      });
      menu.appendChild(i);
    }

    mkItem('Compare with HEAD', function () {
      self.onDiffRequest({ path: item.path, compareWithRef: 'HEAD' });
    });
    mkItem('Compare with ref…', function () {
      var ref = window.prompt('Compare with which git ref?', 'HEAD');
      if (ref == null) return;
      ref = String(ref).trim();
      if (!ref) return;
      self.onDiffRequest({ path: item.path, compareWithRef: ref });
    });
    mkItem('Compare with another file…', function () {
      var other = window.prompt('Path of the other file (absolute):');
      if (other == null) return;
      other = String(other).trim();
      if (!other) return;
      self.onDiffRequest({ path: item.path, compareWithPath: other });
    });

    var docCloser = null;
    function openMenu() {
      menu.style.display = '';
      btn.setAttribute('aria-expanded', 'true');
      docCloser = function (e) {
        if (!wrap.contains(e.target)) closeMenu();
      };
      // Capture phase so we beat any inner click handlers that stopPropagation.
      document.addEventListener('mousedown', docCloser, true);
    }
    function closeMenu() {
      menu.style.display = 'none';
      btn.setAttribute('aria-expanded', 'false');
      if (docCloser) {
        document.removeEventListener('mousedown', docCloser, true);
        docCloser = null;
      }
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menu.style.display === 'none') openMenu(); else closeMenu();
    });
    return wrap;
  };

  FilePreviewPanel.prototype._disposeActive = function () {
    while (this._activeDisposers.length) {
      var fn = this._activeDisposers.pop();
      try { fn(); } catch (_) { /* swallow — disposer should never throw */ }
    }
  };

  FilePreviewPanel.prototype.showPreview = function (item, currentDir, options) {
    var self = this;
    this._disposeActive();
    this.containerEl.innerHTML = '';

    // Capture per-render options. _jumpTo is consumed once by _renderCode
    // when Monaco resolves; it's cleared post-consumption so a switch back
    // and forth between previews doesn't repeat the jump.
    this._jumpTo = (options && options.jumpTo) ? options.jumpTo : null;

    // Header
    var header = document.createElement('div');
    header.className = 'fb-preview-header';

    var title = document.createElement('span');
    title.className = 'fb-preview-title';
    title.textContent = item.name;
    header.appendChild(title);

    var actions = document.createElement('div');
    actions.className = 'fb-preview-actions';

    // Edit button (for editable files)
    if (item.editable) {
      var editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary btn-small';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () { self.onEdit(item); });
      actions.appendChild(editBtn);
    }

    // Diff button — opens a small dropdown with comparison targets. Only
    // shown for editable text-shaped files (mimeCategory text/code/markdown
    // /json/csv); the diff editor would render binary content as garbage.
    // Wired to FilePreviewPanel.onDiffRequest so the FileBrowserPanel can
    // route through TabManager (mode='diff').
    if (item.editable && typeof self.onDiffRequest === 'function') {
      var diffBtn = self._buildDiffMenu(item);
      if (diffBtn) actions.appendChild(diffBtn);
    }

    // Download button
    var dlBtn = document.createElement('button');
    dlBtn.className = 'btn btn-secondary btn-small';
    dlBtn.textContent = 'Download';
    dlBtn.addEventListener('click', function () {
      // Same auth thread-through as inline previews: window.open() spawns
      // a fresh navigation that can't carry an Authorization header, so
      // we append `?token=` if --auth is on.
      var dlUrl = '/api/files/download?path=' + encodeURIComponent(item.path);
      if (window.authManager && typeof window.authManager.appendAuthToUrl === 'function') {
        dlUrl = window.authManager.appendAuthToUrl(dlUrl);
      }
      window.open(dlUrl, '_blank');
    });
    actions.appendChild(dlBtn);

    header.appendChild(actions);
    this.containerEl.appendChild(header);

    // Content area
    var content = document.createElement('div');
    content.className = 'fb-preview-content';
    this.containerEl.appendChild(content);

    // Metadata
    var meta = document.createElement('div');
    meta.className = 'fb-preview-meta';
    var metaParts = [];
    if (item.size !== null) metaParts.push(formatFileSize(item.size));
    if (item.modified) {
      var d = new Date(item.modified);
      metaParts.push('Modified ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString());
    }
    meta.textContent = metaParts.join(' \u00b7 ');
    this.containerEl.appendChild(meta);

    // Dispatch by category
    var category = item.mimeCategory;
    if (category === 'image') {
      this._renderImage(content, item);
    } else if (category === 'pdf') {
      this._renderPdf(content, item);
    } else if (category === 'binary') {
      this._renderBinary(content, item);
    } else {
      // text, code, markdown, json, csv — fetch content
      this._renderTextContent(content, item);
    }
  };

  FilePreviewPanel.prototype._renderImage = function (container, item) {
    var self = this;

    // Viewport: clips the image at the panel boundary so panning stays
    // visually contained. The image itself is the panzoom target.
    var viewport = document.createElement('div');
    viewport.className = 'fb-img-viewport';

    var img = document.createElement('img');
    img.className = 'fb-preview-image';
    img.alt = item.name;
    img.draggable = false; // browser native drag-image conflicts with pan gesture
    // Inline asset URL — `<img src>` can't carry custom headers, so the
    // Bearer token is threaded via `?token=` (auth middleware accepts both,
    // see appendAuthToUrl). Without this, image preview 401s in --auth mode.
    var imgUrl = '/api/files/download?path=' + encodeURIComponent(item.path) + '&inline=1';
    if (window.authManager && typeof window.authManager.appendAuthToUrl === 'function') {
      imgUrl = window.authManager.appendAuthToUrl(imgUrl);
    }
    img.src = imgUrl;
    viewport.appendChild(img);
    container.appendChild(viewport);

    // Dimension readout (preserves the existing UX from before #20).
    var dims = document.createElement('div');
    dims.className = 'fb-preview-dims';
    container.appendChild(dims);

    // Zoom controls \u2014 shown above the viewport. Wired only after Panzoom
    // initialises so a CDN failure keeps the controls hidden rather than
    // showing dead buttons.
    var controls = document.createElement('div');
    controls.className = 'fb-img-controls';
    controls.style.display = 'none';
    var fitBtn = document.createElement('button');
    fitBtn.type = 'button';
    fitBtn.className = 'btn btn-secondary btn-small';
    fitBtn.textContent = 'Fit';
    fitBtn.title = 'Fit to viewport';
    var oneToOneBtn = document.createElement('button');
    oneToOneBtn.type = 'button';
    oneToOneBtn.className = 'btn btn-secondary btn-small';
    oneToOneBtn.textContent = '100%';
    oneToOneBtn.title = 'Actual size';
    var resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn btn-secondary btn-small';
    resetBtn.textContent = 'Reset';
    resetBtn.title = 'Reset zoom and position';
    controls.appendChild(fitBtn);
    controls.appendChild(oneToOneBtn);
    controls.appendChild(resetBtn);
    container.insertBefore(controls, viewport);

    var pz = null;
    var wheelHandler = null;

    img.addEventListener('load', function () {
      dims.textContent = img.naturalWidth + ' \u00d7 ' + img.naturalHeight + ' px';

      // Lazy-load Panzoom only on the first image preview of the session.
      // ~10 KB; if the user never opens an image they never pay it.
      loadPanzoom().then(function (Panzoom) {
        if (!viewport.isConnected) return; // user already navigated away
        pz = Panzoom(img, {
          maxScale: 10,
          minScale: 0.1,
          // Disable focal-point zoom on touch devices so tap-to-fit doesn't
          // accidentally zoom into the wrong region. Pinch still works.
          contain: 'outside',
          startScale: 1,
          step: 0.3,
          // panOnlyWhenZoomed: true is too restrictive \u2014 allow free pan.
        });
        // Wheel zoom is opt-in in @panzoom/panzoom v4 \u2014 wire it on the
        // viewport so scrolling outside the image doesn't intercept page
        // scroll.
        wheelHandler = function (e) { pz.zoomWithWheel(e); };
        viewport.addEventListener('wheel', wheelHandler, { passive: false });

        controls.style.display = '';
        fitBtn.addEventListener('click', function () { pz && pz.reset(); });
        oneToOneBtn.addEventListener('click', function () {
          pz && pz.zoom(1, { animate: true });
          pz && pz.pan(0, 0, { animate: true });
        });
        resetBtn.addEventListener('click', function () { pz && pz.reset(); });

        // Register teardown \u2014 removes wheel listener + tears down internal
        // pointer/touch listeners on document. Without this, switching
        // previews would leak event handlers per image opened.
        self._activeDisposers.push(function () {
          if (wheelHandler) viewport.removeEventListener('wheel', wheelHandler);
          try { pz && pz.destroy(); } catch (_) { /* ignore */ }
          pz = null;
          wheelHandler = null;
        });
      }).catch(function (err) {
        // Degrade gracefully: image stays visible, just no pan/zoom.
        // Matches the panel's "always render something" contract.
        console.warn('[file-browser] panzoom unavailable:', err && err.message);
      });
    });
  };

  FilePreviewPanel.prototype._renderPdf = function (container, item) {
    // Inline asset URL — PDF.js issues fetch() from the worker module
    // pipeline and `<iframe src>` (the fallback) can't carry custom
    // headers, so the Bearer token is threaded via `?token=` (auth
    // middleware accepts both, see appendAuthToUrl). Without this, PDF
    // preview 401s in --auth mode.
    var url = '/api/files/download?path=' + encodeURIComponent(item.path) + '&inline=1';
    if (window.authManager && typeof window.authManager.appendAuthToUrl === 'function') {
      url = window.authManager.appendAuthToUrl(url);
    }
    var self = this;

    // Lazy PDF.js viewer (canvas-based) for cross-browser support — iOS
    // Safari refuses inline iframe PDFs and forces a download. PDF.js
    // bundle (~344KB core + 1.3MB worker) is fetched same-origin only on
    // first PDF preview, then memoized.
    if (window.fbPdfViewer && typeof window.fbPdfViewer.render === 'function') {
      var disposerPushed = false;
      try {
        // render() now returns SYNCHRONOUSLY (peer-review MEDIUM-2 on
        // 913bfdd) — the viewer handle is available immediately and its
        // .destroy() correctly cancels the in-flight LoadingTask, the
        // current RenderTask, and disconnects observers. So a disposer
        // can act mid-load without waiting for page-1 to paint.
        var viewer = window.fbPdfViewer.render(container, { url: url, fileName: item.name });

        // Push the disposer ONLY AFTER render() returned successfully
        // (peer-review MEDIUM-3). Pushing before would leave a stale
        // disposer in the queue if render() threw and execution fell
        // through to the iframe path.
        this._activeDisposers.push(function () {
          if (viewer && typeof viewer.destroy === 'function') {
            try { viewer.destroy(); } catch (_) {}
          }
        });
        disposerPushed = true;

        // The error UI is rendered into the container by render() itself
        // on load failure; swallow the rejection here so the unhandled-
        // rejection warning doesn't fire.
        if (viewer && viewer.ready && typeof viewer.ready.catch === 'function') {
          viewer.ready.catch(function () { /* surfaced inline */ });
        }
        return;
      } catch (_err) {
        // Defensive: if render() threw synchronously AND we already pushed
        // a disposer (shouldn't happen given the order above, but cheap
        // insurance against future refactors), pop it back off so a stale
        // closure doesn't leak into _disposeActive.
        if (disposerPushed) {
          this._activeDisposers.pop();
        }
        // Fall through to iframe fallback.
      }
    }

    // Fallback: legacy iframe path (works on desktop Chrome/Firefox/Safari
    // but NOT iOS Safari). Better than nothing if PDF.js failed to load.
    var iframe = document.createElement('iframe');
    iframe.className = 'fb-preview-pdf';
    iframe.src = url;
    iframe.title = item.name;
    container.appendChild(iframe);
  };

  FilePreviewPanel.prototype._renderBinary = function (container, item) {
    var msg = document.createElement('div');
    msg.className = 'fb-preview-binary';
    msg.innerHTML = (window.icons ? window.icons.fileBinary(48) : '') +
      '<p>Binary file — cannot preview</p>' +
      '<p class="fb-preview-hint">Download to view this file</p>';
    container.appendChild(msg);
  };

  FilePreviewPanel.prototype._renderTextContent = function (container, item) {
    var self = this;
    container.innerHTML = '<div class="fb-loading">Loading...</div>';

    this.authFetch('/api/files/content?path=' + encodeURIComponent(item.path))
      .then(function (resp) {
        if (!resp.ok) throw new Error('Failed to load: ' + resp.status);
        return resp.json();
      })
      .then(function (data) {
        container.innerHTML = '';

        if (isIpynbExtension(item.name) || isIpynbExtension(item.path)) {
          // .ipynb takes precedence over the json mimeCategory the server
          // assigns — a notebook is JSON shape but the user wants the
          // rendered cells, not pretty-printed source.
          self._renderNotebook(container, data.content, item);
        } else if (item.mimeCategory === 'json') {
          self._renderJson(container, data.content, item);
        } else if (item.mimeCategory === 'csv') {
          self._renderCsv(container, data.content);
        } else if (isHtmlExtension(item.name) || isHtmlExtension(item.path)) {
          self._renderHtml(container, data.content, item);
        } else {
          self._renderCode(container, data.content, item);
        }

        if (data.truncated) {
          var notice = document.createElement('div');
          notice.className = 'fb-truncated-notice';
          notice.textContent = 'Showing first ' + formatFileSize(data.content.length) +
            ' of ' + formatFileSize(data.totalSize);
          container.appendChild(notice);
        }
      })
      .catch(function (err) {
        container.innerHTML = '<div class="fb-preview-error">Failed to load: ' + escapeHtml(err.message) + '</div>';
      });
  };

  // Read-only code preview backed by Monaco (ADR-0016). Replaces the prior
  // hand-rolled <pre>+gutter renderer; that renderer is preserved as
  // _renderCodePlainFallback for the CDN-blocked degraded path.
  FilePreviewPanel.prototype._renderCode = function (container, content, item) {
    var self = this;
    var languageHint = '';
    if (item) languageHint = item.path || item.name || '';

    // Loader module missing — degrade to the prior plain renderer rather
    // than show an empty pane.
    if (!window.fileViewerMonaco || typeof window.fileViewerMonaco.createCodeViewer !== 'function') {
      this._renderCodePlainFallback(container, content);
      return;
    }

    // Monaco needs a host element with non-zero dimensions; .fb-code-monaco
    // gives it a flex/min-height contract via file-browser.css.
    var host = document.createElement('div');
    host.className = 'fb-code-monaco';
    container.appendChild(host);

    var loading = document.createElement('div');
    loading.className = 'fb-loading';
    loading.style.cssText = 'padding:24px;text-align:center';
    loading.textContent = 'Loading viewer...';
    host.appendChild(loading);

    // Tracks the resolved Monaco handle so the disposer can tear it down
    // even if showPreview() switches files mid-load.
    var resolvedHandle = null;
    var disposed = false;
    self._activeDisposers.push(function () {
      disposed = true;
      if (resolvedHandle) {
        try { resolvedHandle.dispose(); } catch (_) { /* ignore */ }
        resolvedHandle = null;
      }
    });

    window.fileViewerMonaco.createCodeViewer(host, {
      content: content,
      language: window.fileViewerMonaco.getMonacoLanguage(languageHint),
      readOnly: true,
      minimap: false,
      lineNumbers: 'on',
      wordWrap: 'off',
      ariaLabel: 'Read-only preview of ' + (item ? item.name : 'file'),
      // No context menu in the read-only preview — host UI provides Edit/Download.
      contextmenu: false,
    }).then(function (handle) {
      if (loading.parentNode) loading.parentNode.removeChild(loading);
      if (disposed) {
        // Race: showPreview() switched files while Monaco was loading.
        try { handle.dispose(); } catch (_) { /* ignore */ }
        return;
      }
      resolvedHandle = handle;
      // Consume any pending jump-to-line set by a terminal-link click (#7).
      // The line/col are 1-based (Monaco's convention) AND the values from
      // path tokens like `src/foo.js:42:7` are 1-based, so they map directly.
      // Out-of-range lines are silently clamped by Monaco; we wrap in a
      // try just in case the editor was disposed mid-call.
      var jump = self._jumpTo;
      self._jumpTo = null;
      if (jump && jump.line) {
        var line = parseInt(jump.line, 10);
        var col  = parseInt(jump.col, 10);
        if (isFinite(line) && line > 0) {
          if (!isFinite(col) || col < 1) col = 1;
          try {
            handle.editor.revealLineInCenter(line);
            handle.editor.setPosition({ lineNumber: line, column: col });
            // Selection at a single point doubles as a visual cursor marker;
            // helpful when read-only Monaco doesn't draw a blinking caret.
            if (handle.monaco && handle.monaco.Selection) {
              handle.editor.setSelection(new handle.monaco.Selection(line, col, line, col));
            }
            handle.editor.focus();
          } catch (_) { /* line out of range or editor disposed — non-fatal */ }
        }
      }
    }).catch(function () {
      if (loading.parentNode) loading.parentNode.removeChild(loading);
      if (disposed) return;
      // CDN failure: prefer the loader's plain-text renderer (consistent
      // styling with the editor's fallback); degrade further to the local
      // gutter+<pre> renderer if even that's missing.
      if (window.fileViewerMonaco && typeof window.fileViewerMonaco.renderPlainTextFallback === 'function') {
        window.fileViewerMonaco.renderPlainTextFallback(host, {
          content: content,
          notice: 'Code viewer unavailable — falling back to plain text.',
        });
      } else {
        host.innerHTML = '';
        self._renderCodePlainFallback(host, content);
      }
    });
  };

  FilePreviewPanel.prototype._renderCodePlainFallback = function (container, content) {
    var wrapper = document.createElement('div');
    wrapper.className = 'fb-code-preview';

    var lines = String(content || '').split('\n');
    var gutter = document.createElement('div');
    gutter.className = 'fb-code-gutter';
    var code = document.createElement('pre');
    code.className = 'fb-code-content';

    for (var i = 0; i < lines.length; i++) {
      var lineNum = document.createElement('div');
      lineNum.className = 'fb-line-number';
      lineNum.textContent = i + 1;
      gutter.appendChild(lineNum);
    }

    code.textContent = content;
    wrapper.appendChild(gutter);
    wrapper.appendChild(code);
    container.appendChild(wrapper);
  };

  FilePreviewPanel.prototype._renderJson = function (container, content, item) {
    try {
      var parsed = JSON.parse(content);
      var formatted = JSON.stringify(parsed, null, 2);
      this._renderCode(container, formatted, item);
    } catch (e) {
      this._renderCode(container, content, item);
    }
  };

  // HTML preview (#18) — sandboxed iframe by default with a Source⇄Rendered
  // toggle. The iframe gets `sandbox=""` (strictest: no scripts, no
  // same-origin, no top-nav, no forms, no popups, no downloads), an
  // `referrerpolicy="no-referrer"` attribute, and a CSP <meta> injected via
  // buildSandboxedSrcdoc that further locks down what the (now-inert)
  // document can fetch.
  //
  // Defence in depth:
  //   - sandbox="" — browser-enforced isolation; document origin is "null".
  //   - CSP meta — even if a future browser quirk weakens sandbox, the CSP
  //     blocks every network class except inline data:/blob: assets.
  //   - <base> + <meta refresh> stripping — closes navigation-shaped tricks.
  //   - 1 MB cap — beyond which we disable rendering and show source only,
  //     because srcdoc balloons memory and can hang the renderer.
  // Notebook (.ipynb) preview (#3) — delegates to notebook-render.js
  // which lazy-loads kokes/nbviewer.js + DOMPurify on first use, parses
  // the notebook JSON, renders into a scratch DIV via nbv.render(), then
  // sanitises the resulting HTML before inserting into the live DOM
  // (output cells can carry arbitrary HTML).
  FilePreviewPanel.prototype._renderNotebook = function (container, content, item) {
    var self = this;
    if (!window.notebookRender || typeof window.notebookRender.renderInto !== 'function') {
      // Module never loaded — fall back to JSON-pretty preview so the user
      // can still inspect the notebook source.
      this._renderJson(container, content, item);
      return;
    }

    var host = document.createElement('div');
    host.className = 'fb-notebook-host';
    container.appendChild(host);

    // Track the renderer's teardown so showPreview() drains it on
    // file-switch (matches the Panzoom / PDF.js / Monaco pattern).
    var disposed = false;
    var teardownFn = null;
    self._activeDisposers.push(function () {
      disposed = true;
      if (teardownFn) {
        try { teardownFn(); } catch (_) { /* ignore */ }
        teardownFn = null;
      }
    });

    window.notebookRender.renderInto(host, content, {}).then(function (result) {
      if (disposed) {
        // Race: showPreview() switched files while nbviewer was loading.
        if (result && typeof result.teardown === 'function') {
          try { result.teardown(); } catch (_) { /* ignore */ }
        }
        return;
      }
      if (result && typeof result.teardown === 'function') {
        teardownFn = result.teardown;
      }
    }).catch(function () {
      // notebook-render.js already renders its own fallback inside `host`.
      // Nothing to do here.
    });
  };

  FilePreviewPanel.prototype._renderHtml = function (container, content, item) {
    var self = this;
    var src = String(content == null ? '' : content);
    var bytes = _measureBytes(src);
    var oversize = bytes > HTML_PREVIEW_SRCDOC_CAP_BYTES;

    var wrapper = document.createElement('div');
    wrapper.className = 'fb-html-preview';
    container.appendChild(wrapper);

    // Toggle bar
    var toggleBar = document.createElement('div');
    toggleBar.className = 'fb-html-toggle-bar';

    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn-secondary btn-small fb-html-toggle-btn';
    toggleBtn.type = 'button';
    toggleBar.appendChild(toggleBtn);

    if (oversize) {
      var notice = document.createElement('span');
      notice.className = 'fb-html-toggle-notice';
      notice.textContent = 'Rendered preview disabled (file > ' +
        formatFileSize(HTML_PREVIEW_SRCDOC_CAP_BYTES) + ')';
      toggleBar.appendChild(notice);
    }
    wrapper.appendChild(toggleBar);

    // View host (swapped between rendered iframe and source Monaco viewer).
    var view = document.createElement('div');
    view.className = 'fb-html-view';
    wrapper.appendChild(view);

    var renderedActive = !oversize;

    // HIGH (reviewer audit of 7e73e6f): every toggle into Source view mounts
    // a fresh Monaco editor via _renderCode, which APPENDS its disposer to
    // self._activeDisposers. The pool is only drained by showPreview() →
    // _disposeActive(). Without per-toggle accounting, repeated Source ⇄
    // Rendered cycles accumulate orphaned Monaco editors (with their
    // ResizeObserver + text models + listeners live) until the user finally
    // navigates to a different file. Fix: track the index of the disposer
    // we register on each renderSource() call and drain it before mounting
    // the next editor (or before transitioning to the iframe view).
    var sourceDisposerIdx = -1;

    function disposeSource() {
      if (sourceDisposerIdx >= 0 && sourceDisposerIdx < self._activeDisposers.length) {
        var fn = self._activeDisposers.splice(sourceDisposerIdx, 1)[0];
        try { fn(); } catch (_) { /* swallow */ }
      }
      sourceDisposerIdx = -1;
    }

    function renderRendered() {
      // Drain any prior source-view editor before swapping the DOM. Without
      // this, switching back to Rendered detaches the editor's DOM but
      // leaves its model + ResizeObserver + listeners alive.
      disposeSource();
      view.innerHTML = '';
      toggleBtn.textContent = 'Source';
      toggleBtn.setAttribute('aria-label', 'Show source');
      toggleBtn.setAttribute('aria-pressed', 'false');

      var iframe = document.createElement('iframe');
      iframe.className = 'fb-html-iframe';
      // Empty sandbox = strictest. Every restriction is enabled by default;
      // adding tokens (e.g. allow-scripts) would WEAKEN sandboxing.
      iframe.setAttribute('sandbox', '');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.setAttribute('loading', 'lazy');
      iframe.setAttribute('title', item ? ('Rendered ' + item.name) : 'HTML preview');
      iframe.setAttribute('aria-label', 'HTML rendered preview, sandboxed');
      iframe.setAttribute('srcdoc', buildSandboxedSrcdoc(src));
      view.appendChild(iframe);
    }

    function renderSource() {
      // Drain any PREVIOUS source-view editor first. Important on the
      // back-and-forth case (Source → Rendered → Source); without it we'd
      // leak the original editor since toggling Source again pushes a new
      // disposer rather than reusing the prior one.
      disposeSource();
      view.innerHTML = '';
      toggleBtn.textContent = 'Rendered';
      toggleBtn.setAttribute('aria-label', 'Show rendered preview');
      toggleBtn.setAttribute('aria-pressed', 'true');
      // Capture the index BEFORE _renderCode appends its disposer. The
      // disposer push in _renderCode is synchronous (verify before any
      // refactor that adds awaits in that path).
      sourceDisposerIdx = self._activeDisposers.length;
      // Reuse the Monaco read-only code preview path so HTML source view
      // gets the same syntax highlighting + chrome as any other code file.
      self._renderCode(view, src, item);
    }

    toggleBtn.addEventListener('click', function () {
      if (oversize) return;
      if (renderedActive) {
        renderSource();
        renderedActive = false;
      } else {
        renderRendered();
        renderedActive = true;
      }
    });

    if (oversize) {
      toggleBtn.disabled = true;
      toggleBtn.classList.add('disabled');
      toggleBtn.setAttribute('aria-disabled', 'true');
      renderSource();
    } else {
      renderRendered();
    }
  };

  // ---------------------------------------------------------------------------
  // CSV parsing — RFC 4180-ish (handles quoted fields, embedded separators,
  // and "" escape). Multi-line quoted fields are NOT supported in v1; rows
  // are split on \n before parsing. Per task #5.
  // ---------------------------------------------------------------------------

  function parseCsvLine(line, sep) {
    var cells = [];
    var i = 0;
    var len = line.length;
    while (i < len) {
      var cell;
      if (line.charAt(i) === '"') {
        // Quoted field. Process until matching unescaped closing quote.
        i++;
        var buf = '';
        while (i < len) {
          var c = line.charAt(i);
          if (c === '"') {
            if (line.charAt(i + 1) === '"') { buf += '"'; i += 2; }
            else { i++; break; }
          } else {
            buf += c; i++;
          }
        }
        cell = buf;
        // Skip any trailing junk up to the next separator (defensive).
        while (i < len && line.charAt(i) !== sep) i++;
      } else {
        var start = i;
        while (i < len && line.charAt(i) !== sep) i++;
        cell = line.slice(start, i);
      }
      cells.push(cell);
      if (i < len && line.charAt(i) === sep) i++;
    }
    // Edge case: a trailing separator means an empty trailing field.
    if (line.length > 0 && line.charAt(line.length - 1) === sep) cells.push('');
    return cells;
  }

  function isNumericCell(s) {
    if (s == null || s === '') return false;
    var n = Number(s);
    return !isNaN(n) && isFinite(n);
  }

  function detectColumnIsNumeric(rows, colIdx) {
    // Scan up to 20 rows; treat a column as numeric only if every sampled
    // non-empty value parses as a number. Empty cells are ignored so a
    // column with sparse data still sorts numerically.
    var sample = Math.min(rows.length, 20);
    var sawAny = false;
    for (var r = 0; r < sample; r++) {
      var v = rows[r][colIdx];
      if (v == null || v === '') continue;
      sawAny = true;
      if (!isNumericCell(v)) return false;
    }
    return sawAny;
  }

  // Cap on parsed rows. Beyond this we slice and surface a "showing first N
  // of M" notice — protects the browser from a multi-MB CSV painting the
  // whole DOM on first preview. Virtualisation handles render-side sizing
  // independently; this cap is only about parse + sort cost.
  var CSV_MAX_ROWS = 1000;
  var CSV_INITIAL_WINDOW = 50;
  var CSV_PAGE_SIZE = 50;

  FilePreviewPanel.prototype._renderCsv = function (container, content) {
    var self = this;
    if (!content || !content.length) {
      container.textContent = 'Empty CSV file';
      return;
    }

    // Strip BOM if present (Excel-saved CSVs love this).
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

    // Detect separator: tab-separated takes precedence if a tab appears in
    // the first line (common for .tsv served as text/csv). Otherwise comma.
    var firstNL = content.indexOf('\n');
    var firstLine = firstNL === -1 ? content : content.slice(0, firstNL);
    var sep = firstLine.indexOf('\t') !== -1 ? '\t' : ',';

    // Split on \n and parse. Multi-line quoted fields are NOT supported
    // in v1 — they'd require row-aware tokenisation across line boundaries.
    var rawLines = content.split(/\r?\n/);
    while (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
    if (!rawLines.length) {
      container.textContent = 'Empty CSV file';
      return;
    }

    var headerRow = parseCsvLine(rawLines[0], sep);
    var totalDataRows = rawLines.length - 1;
    var truncated = totalDataRows > CSV_MAX_ROWS;
    var dataRowCount = truncated ? CSV_MAX_ROWS : totalDataRows;

    var dataRows = new Array(dataRowCount);
    for (var i = 0; i < dataRowCount; i++) {
      dataRows[i] = parseCsvLine(rawLines[i + 1], sep);
    }

    // Cache numeric-column detection up front so repeated sorts don't re-scan.
    var colIsNumeric = new Array(headerRow.length);
    for (var c = 0; c < headerRow.length; c++) {
      colIsNumeric[c] = detectColumnIsNumeric(dataRows, c);
    }

    var sortState = null;             // null | { col, dir: 'asc'|'desc' }
    var sortedRows = dataRows.slice();
    var renderedCount = 0;
    var observer = null;
    var sentinel = null;
    var initialWindow = CSV_INITIAL_WINDOW;

    var wrapper = document.createElement('div');
    wrapper.className = 'fb-csv-wrapper';
    var table = document.createElement('table');
    table.className = 'fb-csv-table';
    var thead = document.createElement('thead');
    var headerTr = document.createElement('tr');
    var tbody = document.createElement('tbody');

    function renderHeader() {
      headerTr.innerHTML = '';
      headerRow.forEach(function (h, idx) {
        var th = document.createElement('th');
        th.className = 'fb-csv-th-sortable';
        th.tabIndex = 0;
        th.setAttribute('role', 'columnheader');
        var label = document.createElement('span');
        label.className = 'fb-csv-th-label';
        label.textContent = h;
        var arrow = document.createElement('span');
        arrow.className = 'fb-csv-th-arrow';
        if (sortState && sortState.col === idx) {
          arrow.textContent = sortState.dir === 'asc' ? ' ▲' : ' ▼';
          th.setAttribute('aria-sort', sortState.dir === 'asc' ? 'ascending' : 'descending');
        } else {
          arrow.textContent = '';
          th.setAttribute('aria-sort', 'none');
        }
        th.appendChild(label);
        th.appendChild(arrow);
        function activate() {
          if (sortState && sortState.col === idx) {
            // toggle: asc → desc → unsorted (third click)
            if (sortState.dir === 'asc') sortState = { col: idx, dir: 'desc' };
            else sortState = null;
          } else {
            sortState = { col: idx, dir: 'asc' };
          }
          applySort();
          renderHeader();
          resetWindow();
        }
        th.addEventListener('click', activate);
        th.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
        });
        headerTr.appendChild(th);
      });
    }

    function applySort() {
      if (!sortState) {
        sortedRows = dataRows.slice();
        return;
      }
      var col = sortState.col;
      var dir = sortState.dir === 'asc' ? 1 : -1;
      var numeric = colIsNumeric[col];
      sortedRows = dataRows.slice().sort(function (a, b) {
        var av = a[col];
        var bv = b[col];
        // Empty cells always sort last regardless of direction (matches
        // user expectation in spreadsheet apps).
        if (av == null || av === '') return 1;
        if (bv == null || bv === '') return -1;
        if (numeric) {
          var an = Number(av);
          var bn = Number(bv);
          return an === bn ? 0 : (an < bn ? -1 : 1) * dir;
        }
        return String(av).localeCompare(String(bv)) * dir;
      });
    }

    function appendRows(from, to) {
      var frag = document.createDocumentFragment();
      for (var r = from; r < to; r++) {
        var tr = document.createElement('tr');
        var cells = sortedRows[r];
        for (var c2 = 0; c2 < headerRow.length; c2++) {
          var td = document.createElement('td');
          td.textContent = cells[c2] != null ? cells[c2] : '';
          tr.appendChild(td);
        }
        frag.appendChild(tr);
      }
      tbody.appendChild(frag);
      renderedCount = to;
      updateSentinel();
    }

    function updateSentinel() {
      if (renderedCount >= sortedRows.length) {
        if (sentinel && sentinel.parentNode) sentinel.parentNode.removeChild(sentinel);
        if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
      } else if (sentinel && !sentinel.parentNode) {
        wrapper.appendChild(sentinel);
      }
    }

    function resetWindow() {
      tbody.innerHTML = '';
      renderedCount = 0;
      appendRows(0, Math.min(initialWindow, sortedRows.length));
    }

    sentinel = document.createElement('div');
    sentinel.className = 'fb-csv-sentinel';
    sentinel.setAttribute('aria-hidden', 'true');

    if (typeof window.IntersectionObserver === 'function') {
      observer = new window.IntersectionObserver(function (entries) {
        for (var e = 0; e < entries.length; e++) {
          if (entries[e].isIntersecting && renderedCount < sortedRows.length) {
            appendRows(renderedCount,
                       Math.min(renderedCount + CSV_PAGE_SIZE, sortedRows.length));
          }
        }
      }, { root: wrapper, rootMargin: '200px 0px' });
      observer.observe(sentinel);
    } else {
      // Old browser fallback — render everything up front.
      initialWindow = sortedRows.length;
    }

    renderHeader();
    thead.appendChild(headerTr);
    table.appendChild(thead);
    table.appendChild(tbody);
    wrapper.appendChild(table);
    wrapper.appendChild(sentinel);
    container.appendChild(wrapper);

    appendRows(0, Math.min(initialWindow, sortedRows.length));

    if (truncated) {
      var notice = document.createElement('div');
      notice.className = 'fb-truncated-notice';
      notice.textContent = 'Showing first ' + CSV_MAX_ROWS + ' of ' + totalDataRows + ' rows';
      container.appendChild(notice);
    }

    // Register teardown so navigating to another file releases the
    // IntersectionObserver. Per the FilePreviewPanel _activeDisposers
    // contract.
    if (self._activeDisposers) {
      self._activeDisposers.push(function () {
        if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Terminal path linking — TerminalPathDetector (right-click selection menu)
  // and attachLinkProvider (xterm registerLinkProvider for clickable links).
  //
  // Both share the same regex/extraction logic. CRITICAL: the link provider
  // performs ZERO network I/O inside provideLinks (it scans every visible
  // line on every render — synchronous regex only). Validation against the
  // server (/api/files/stat) happens lazily in the click handler.
  // ---------------------------------------------------------------------------

  // Known file-extension allowlist. Used as a precondition so that path-shaped
  // tokens like `react/jsx-runtime` (npm specifier with no extension) and
  // `1.2.3` (version) are not flagged as links.
  var KNOWN_FILE_EXTENSIONS = [
    // Code
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'd.ts',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift',
    'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hh', 'hxx', 'm', 'mm',
    'cs', 'fs', 'php', 'pl', 'pm', 'r', 'lua', 'dart', 'ex', 'exs',
    'erl', 'hs', 'elm', 'clj', 'cljs', 'edn', 'jl', 'nim', 'zig', 'v',
    // Shell / config
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'env', 'ini', 'cfg', 'conf', 'properties', 'toml',
    'yaml', 'yml', 'json', 'json5', 'jsonc',
    // Web
    'html', 'htm', 'xhtml', 'xml', 'svg',
    'css', 'scss', 'sass', 'less', 'styl',
    // Markup / docs
    'md', 'mdx', 'markdown', 'rst', 'tex', 'org', 'adoc',
    // Data / DB
    'csv', 'tsv', 'sql', 'graphql', 'gql', 'proto', 'avsc',
    // Logs / text
    'txt', 'log', 'patch', 'diff', 'lock',
    // Build files
    'gradle', 'cmake', 'mk', 'make', 'ninja', 'bazel', 'bzl',
    // Binary previews
    'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'avif',
    // Notebooks
    'ipynb',
  ];

  var EXT_ALT = KNOWN_FILE_EXTENSIONS
    .map(function (e) { return e.replace(/\./g, '\\.'); })
    .join('|');

  // Single canonical pattern: a path-shaped token that ends with a known
  // extension and may have an optional ":line" or ":line:col" suffix.
  //
  // Left and right boundaries are matched as separate groups so we can
  // recover the precise start column of the captured path inside the line.
  //
  // Group 1 = leading boundary (single char or empty at line start)
  // Group 2 = the path text
  // Group 3 = optional line number
  // Group 4 = optional column number
  //
  // Note: the path body intentionally does NOT permit spaces. Terminal
  // copy/paste of paths with spaces is uncommon; supporting them would
  // require quote-aware parsing and isn't worth the false-positive cost.
  var LINK_BODY = '(?:[A-Za-z]:[\\\\/]|~[\\\\/]|\\.{0,2}[\\\\/])?[\\w./\\\\-]*?\\.(?:' + EXT_ALT + ')';
  var LINK_TAIL = '(?::(\\d+)(?::(\\d+))?)?';
  var LINK_LEFT = '(^|[\\s\'"`(\\[<,;])';
  var LINK_RIGHT = '(?=[\\s\'"`)\\]>,;]|[.:](?:\\s|$)|$)';

  // Single-match version (for the right-click selection extractor).
  var LINK_RE_SINGLE = new RegExp(LINK_LEFT + '(' + LINK_BODY + ')' + LINK_TAIL + LINK_RIGHT, 'i');
  // Global version (for the link provider). Each provideLinks call gets a
  // fresh lastIndex via String.prototype.matchAll for correctness.
  var LINK_RE_GLOBAL = new RegExp(LINK_LEFT + '(' + LINK_BODY + ')' + LINK_TAIL + LINK_RIGHT, 'gi');

  // Tokens that look like a path but should NEVER be treated as a file link.
  // (Belt-and-braces: the regex already excludes most via extension allowlist,
  // but version-like strings ending in digits-with-dots can otherwise sneak
  // through if a digit happens to match an extension via case insensitivity.)
  var VERSION_RE = /^v?\d+\.\d+(?:\.\d+)+$/;

  // Legacy export — kept so any existing callers (and tests) still resolve
  // a usable pattern. Now produces a single tightened pattern.
  var PATH_PATTERNS = [LINK_RE_SINGLE];

  /**
   * Extract a file path (and optional line/col) from a free-form string.
   * Returns null if no match.
   *
   * @param {string} text
   * @returns {{path: string, line: ?number, col: ?number}|null}
   */
  function extractPathFromText(text) {
    if (!text || !text.trim()) return null;
    var trimmed = text.trim();

    // Strip surrounding matched quotes (single, double, backtick).
    if ((trimmed[0] === '"' || trimmed[0] === "'" || trimmed[0] === '`') &&
        trimmed[trimmed.length - 1] === trimmed[0]) {
      trimmed = trimmed.slice(1, -1);
    }

    var m = trimmed.match(LINK_RE_SINGLE);
    if (!m) return null;
    var pathOnly = m[2];
    if (VERSION_RE.test(pathOnly)) return null;

    return {
      path: pathOnly,
      line: m[3] ? parseInt(m[3], 10) : null,
      col: m[4] ? parseInt(m[4], 10) : null,
    };
  }

  function TerminalPathDetector(options) {
    // Either pass `fileBrowserPanel` (eager) or `getFileBrowserPanel`
    // (lazy — preferred so we don't create the panel until first use).
    this._panel = options.fileBrowserPanel || null;
    this._getPanel = options.getFileBrowserPanel || null;
    this.authFetch = options.authFetch;
    this.terminal = options.terminal;
    this.app = options.app || null;       // optional, for cwd resolution
    this._menuEl = null;
  }

  TerminalPathDetector.prototype._resolvePanel = function () {
    if (this._panel) return this._panel;
    if (typeof this._getPanel === 'function') {
      this._panel = this._getPanel();
    }
    return this._panel;
  };

  TerminalPathDetector.prototype.init = function () {
    if (!this.terminal) return;
    var self = this;

    // Build context menu element
    var menu = document.createElement('div');
    menu.className = 'fb-terminal-context-menu';
    menu.style.display = 'none';
    menu.setAttribute('role', 'menu');

    var viewItem = document.createElement('div');
    viewItem.className = 'ctx-item';
    viewItem.setAttribute('role', 'menuitem');
    viewItem.innerHTML = (window.icons ? '<span class="ctx-icon">' + window.icons.file(14) + '</span>' : '') +
      '<span>Open in File Viewer</span>';
    menu.appendChild(viewItem);
    this._viewItem = viewItem;

    var editItem = document.createElement('div');
    editItem.className = 'ctx-item';
    editItem.setAttribute('role', 'menuitem');
    editItem.innerHTML = (window.icons ? '<span class="ctx-icon">' + window.icons.edit(14) + '</span>' : '') +
      '<span>Edit in Editor</span>';
    menu.appendChild(editItem);
    this._editItem = editItem;

    var downloadItem = document.createElement('div');
    downloadItem.className = 'ctx-item';
    downloadItem.setAttribute('role', 'menuitem');
    downloadItem.innerHTML = (window.icons ? '<span class="ctx-icon">' + window.icons.download(14) + '</span>' : '') +
      '<span>Download</span>';
    menu.appendChild(downloadItem);
    this._downloadItem = downloadItem;

    document.body.appendChild(menu);
    this._menuEl = menu;

    // Right-click handler on the terminal element. We must run BEFORE the
    // generic terminal context menu (`setupTerminalContextMenu` in app.js,
    // which is delegated on <main>). When we recognize a path-shaped
    // selection, stopImmediatePropagation prevents the generic menu from
    // ALSO appearing on top of ours.
    var termEl = this.terminal.element;
    if (!termEl) return;

    // Hold named references for later removeEventListener — anonymous
    // closures here would leak the terminal+detector graph forever
    // (peer-review MEDIUM-1: long-lived sessions that create+destroy
    // splits accumulate document-level listeners and orphaned menu nodes).
    this._onContextMenu = function (e) {
      var selection = self.terminal.getSelection();
      var detected = extractPathFromText(selection);

      if (detected) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') {
          e.stopImmediatePropagation();
        }
        self._showMenu(e.clientX, e.clientY, detected);
      }
    };
    this._onDocumentClick = function () { self._hideMenu(); };
    this._onDocumentKeyDown = function (e) { if (e.key === 'Escape') self._hideMenu(); };

    termEl.addEventListener('contextmenu', this._onContextMenu, true /* capture */);
    document.addEventListener('click', this._onDocumentClick);
    document.addEventListener('keydown', this._onDocumentKeyDown);
    this._termEl = termEl;        // remember for symmetric removeEventListener
  };

  /**
   * Tear down the path detector: removes the document-level listeners,
   * removes the contextmenu listener from the terminal element, and
   * removes the menu node from <body>. Safe to call multiple times.
   *
   * Hooked from app._setupTerminalLinking via terminal.onDispose so
   * disposing a split or session doesn't leak handlers / DOM nodes
   * (peer-review MEDIUM-1).
   */
  TerminalPathDetector.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    try {
      if (this._termEl && this._onContextMenu) {
        this._termEl.removeEventListener('contextmenu', this._onContextMenu, true);
      }
    } catch (_) {}
    try {
      if (this._onDocumentClick) document.removeEventListener('click', this._onDocumentClick);
      if (this._onDocumentKeyDown) document.removeEventListener('keydown', this._onDocumentKeyDown);
    } catch (_) {}
    try {
      if (this._menuEl && this._menuEl.parentNode) {
        this._menuEl.parentNode.removeChild(this._menuEl);
      }
    } catch (_) {}
    this._menuEl = null;
    this._termEl = null;
    this._onContextMenu = null;
    this._onDocumentClick = null;
    this._onDocumentKeyDown = null;
  };

  // Kept for backward compatibility with any external callers / tests.
  // Returns the path string only (no line/col).
  TerminalPathDetector.prototype._extractPath = function (text) {
    var d = extractPathFromText(text);
    return d ? d.path : null;
  };

  TerminalPathDetector.prototype._showMenu = function (x, y, detected) {
    var self = this;
    var menu = this._menuEl;
    // Tolerate legacy callers that pass a bare string.
    if (typeof detected === 'string') detected = { path: detected, line: null, col: null };
    var filePath = detected.path;

    // Position the menu
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.display = '';

    // Initially show items as disabled (checking)
    var items = menu.querySelectorAll('.ctx-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.add('disabled');
    }

    // Validate the path asynchronously
    this.authFetch('/api/files/stat?path=' + encodeURIComponent(filePath))
      .then(function (resp) {
        if (!resp.ok) throw new Error('not found');
        return resp.json();
      })
      .then(function (stat) {
        // Enable items
        for (var j = 0; j < items.length; j++) {
          items[j].classList.remove('disabled');
        }

        // Wire click handlers
        self._viewItem.onclick = function () {
          self._hideMenu();
          var panel = self._resolvePanel();
          if (panel) panel.openToFile(filePath);
        };
        self._editItem.onclick = function () {
          self._hideMenu();
          var panel = self._resolvePanel();
          if (panel) {
            panel.openToFile(filePath);
            // The edit will be triggered after preview loads
          }
        };
        self._downloadItem.onclick = function () {
          self._hideMenu();
          // window.open spawns a fresh navigation; thread the Bearer
          // token via ?token= so --auth mode doesn't 401 the new tab.
          var dlUrl = '/api/files/download?path=' + encodeURIComponent(filePath);
          if (window.authManager && typeof window.authManager.appendAuthToUrl === 'function') {
            dlUrl = window.authManager.appendAuthToUrl(dlUrl);
          }
          window.open(dlUrl, '_blank');
        };

        // Hide edit for non-editable files
        if (!stat.editable) {
          self._editItem.style.display = 'none';
        } else {
          self._editItem.style.display = '';
        }
      })
      .catch(function () {
        // Path doesn't exist — disable all items
        for (var k = 0; k < items.length; k++) {
          items[k].classList.add('disabled');
        }
      });

    // Ensure menu stays within viewport
    requestAnimationFrame(function () {
      var rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
      }
    });
  };

  TerminalPathDetector.prototype._hideMenu = function () {
    if (this._menuEl) {
      this._menuEl.style.display = 'none';
    }
  };

  // ---------------------------------------------------------------------------
  // Path resolution helper (module scope so unit tests can call it directly).
  // ---------------------------------------------------------------------------
  // Used by attachLinkProvider's click handler to turn a regex-matched
  // relative path (e.g. `./src/foo.ts:42`) into an absolute path against
  // the active session's cwd.
  //
  //  - Absolute paths (Unix `/`, Windows `C:\` or `C:/`, `~/`) pass through.
  //  - Relative paths are joined to cwd; `..` and `.` segments are
  //    collapsed to avoid leaking ugly paths into the 404 toast/URL.
  //  - The dominant separator in cwd is honored. When both `/` and `\`
  //    appear (common for cygwin/git-bash-style cwds), whichever occurs
  //    first wins. This avoids the MEDIUM-2 mixed-separator footgun
  //    flagged in the #7 review.
  function _resolveAgainstCwd(p, cwd) {
    if (typeof p !== 'string' || !p) return p;
    if (/^([A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(p)) return p;
    if (!cwd) return p;

    var firstFwd = cwd.indexOf('/');
    var firstBwd = cwd.indexOf('\\');
    var sep = '/';
    if (firstBwd !== -1 && (firstFwd === -1 || firstBwd < firstFwd)) sep = '\\';

    var trimmedCwd = cwd.replace(/[\\/]+$/, '');
    var cwdParts = trimmedCwd.split(/[\\/]+/);
    var pParts = p.split(/[\\/]+/);
    var stack = cwdParts.slice();
    for (var i = 0; i < pParts.length; i++) {
      var seg = pParts[i];
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      stack.push(seg);
    }
    var joined = stack.join(sep);
    if (sep === '/' && cwdParts[0] === '' && joined[0] !== '/') joined = '/' + joined;
    return joined;
  }

  // ---------------------------------------------------------------------------
  // attachLinkProvider — register an xterm link provider for clickable paths
  // ---------------------------------------------------------------------------
  //
  // Behavior:
  //  - Scans each visible terminal line synchronously with LINK_RE_GLOBAL.
  //  - Returns ILink objects with start/end columns. NO network I/O here —
  //    if we hit /api/files/stat per match, a scrolling `npm install`
  //    log would self-DDoS the browser's 6-connection cap (peer-review HIGH-1).
  //  - On click (`activate`), validates lazily via /api/files/stat, then
  //    calls `openInViewer(path, line, col)`. On 404 → toast.
  //
  // Required options:
  //   terminal       xterm Terminal instance
  //   authFetch      (url, opts?) => Promise<Response>
  //   openInViewer   (path, line?, col?) => void
  //   getCwd         () => string|null   (for resolving relatives)
  //   feedback       optional { error(msg), info(msg) } notifier
  //
  // Returns a disposable: { dispose() }
  // ---------------------------------------------------------------------------
  function attachLinkProvider(options) {
    var terminal = options.terminal;
    var authFetch = options.authFetch;
    var openInViewer = options.openInViewer;
    var getCwd = options.getCwd || function () { return null; };
    var feedback = options.feedback || (typeof window !== 'undefined' ? window.feedback : null);

    if (!terminal || typeof terminal.registerLinkProvider !== 'function') return null;
    if (typeof authFetch !== 'function' || typeof openInViewer !== 'function') return null;

    function findLinksInText(text) {
      // Returns an array of { startCol, endCol, path, line, col } for the line.
      // Cols are 0-based against the input string; the caller adds +1 for xterm.
      //
      // Uses String.prototype.matchAll, which constructs a stateless iterator
      // over the regex — `LINK_RE_GLOBAL` is module-scoped and shared, so a
      // manual exec()+lastIndex loop has a latent re-entrancy hazard if any
      // future async refactor allows two providers to interleave on the same
      // regex (peer-review LOW-3). matchAll closes that hole.
      var matches = [];
      var iter;
      try {
        iter = text.matchAll(LINK_RE_GLOBAL);
      } catch (_) {
        return matches;
      }
      for (var m of iter) {
        var leadLen = m[1] ? m[1].length : 0;
        var pathOnly = m[2];
        if (!pathOnly || VERSION_RE.test(pathOnly)) continue;

        // Suppress git-diff pseudo-paths `a/<file>` and `b/<file>` that
        // appear in `diff --git` headers. They never resolve to real files
        // and the user gets two underlined-but-broken links per diff
        // header otherwise (peer-review LOW-2).
        if (/^[ab][\\/]/.test(pathOnly)) continue;

        var pathStart = m.index + leadLen;
        var pathEnd = pathStart + pathOnly.length;       // exclusive
        var line = m[3] ? parseInt(m[3], 10) : null;
        var col = m[4] ? parseInt(m[4], 10) : null;

        // Extend the link region to cover the trailing :line[:col] suffix
        // so the user clicks the whole "path:42:5" rather than just the path.
        var fullEnd = pathEnd;
        if (m[3]) {
          fullEnd += 1 /* ':' */ + m[3].length;
          if (m[4]) fullEnd += 1 + m[4].length;
        }

        matches.push({
          startCol: pathStart,
          endCol: fullEnd,        // exclusive
          path: pathOnly,
          line: line,
          col: col,
        });
      }
      return matches;
    }

    /**
     * Resolve a relative path against the terminal cwd, with consistent
     * separators and `..` collapsing.
     *
     * Fixes peer-review MEDIUM-2 (mixed separators when cwd contains both
     * `/` and `\` — common on Windows under tooling that normalizes one
     * way) and LOW-1 (`./` was stripped but `../` was not, leaking
     * un-collapsed paths into the 404 toast and the URL).
     *
     * (Defined at module scope as `_resolveAgainstCwd` for testability;
     * this local alias exists only so the closure body reads naturally.)
     */
    var resolveAgainstCwd = _resolveAgainstCwd;

    function activate(_event, _text, detected) {
      var p = detected.path;
      var cwd = getCwd();
      var resolved = resolveAgainstCwd(p, cwd);

      authFetch('/api/files/stat?path=' + encodeURIComponent(resolved))
        .then(function (resp) {
          if (resp.status === 404) {
            if (feedback && typeof feedback.error === 'function') {
              feedback.error('File not found: ' + p);
            }
            return null;
          }
          if (!resp.ok) throw new Error('stat failed: ' + resp.status);
          return resp.json();
        })
        .then(function (stat) {
          if (!stat) return;
          openInViewer(resolved, detected.line, detected.col);
        })
        .catch(function (err) {
          if (feedback && typeof feedback.error === 'function') {
            feedback.error('Could not open ' + p + ': ' + (err && err.message ? err.message : err));
          }
        });
    }

    var provider = {
      provideLinks: function (bufferLineNumber, callback) {
        try {
          // xterm: bufferLineNumber is 1-based row index in the active buffer.
          var buf = terminal.buffer && terminal.buffer.active;
          if (!buf || typeof buf.getLine !== 'function') {
            callback(undefined);
            return;
          }
          var line = buf.getLine(bufferLineNumber - 1);
          if (!line) {
            callback(undefined);
            return;
          }
          var text = line.translateToString(false);
          if (!text) {
            callback(undefined);
            return;
          }

          var found = findLinksInText(text);
          if (!found.length) {
            callback(undefined);
            return;
          }

          var links = found.map(function (m) {
            var displayText = text.substring(m.startCol, m.endCol);
            return {
              // xterm uses 1-based, inclusive column ranges.
              range: {
                start: { x: m.startCol + 1, y: bufferLineNumber },
                end: { x: m.endCol, y: bufferLineNumber },
              },
              text: displayText,
              decorations: { underline: true, pointerCursor: true },
              activate: function (e, t) { activate(e, t, m); },
            };
          });
          callback(links);
        } catch (_err) {
          // Never let the link provider throw — would disable terminal rendering.
          callback(undefined);
        }
      },
    };

    var disposable = terminal.registerLinkProvider(provider);
    return disposable;
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var exports = {
    FileBrowserPanel: FileBrowserPanel,
    FilePreviewPanel: FilePreviewPanel,
    TerminalPathDetector: TerminalPathDetector,
    attachLinkProvider: attachLinkProvider,
    extractPathFromText: extractPathFromText,
    // Utilities (for testing)
    getFileIcon: getFileIcon,
    getMonacoLanguage: getMonacoLanguage,
    getAceMode: getAceMode,
    formatFileSize: formatFileSize,
    buildBreadcrumbs: buildBreadcrumbs,
    isPreviewable: isPreviewable,
    isEditable: isEditable,
    isHtmlExtension: isHtmlExtension,
    isIpynbExtension: isIpynbExtension,
    // CSV parsing — exposed for unit tests (task #5)
    parseCsvLine: parseCsvLine,
    detectColumnIsNumeric: detectColumnIsNumeric,
    buildSandboxedSrcdoc: buildSandboxedSrcdoc,
    HTML_PREVIEW_CSP: HTML_PREVIEW_CSP,
    HTML_PREVIEW_SRCDOC_CAP_BYTES: HTML_PREVIEW_SRCDOC_CAP_BYTES,
    KNOWN_FILE_EXTENSIONS: KNOWN_FILE_EXTENSIONS,
    LINK_RE_SINGLE: LINK_RE_SINGLE,
    LINK_RE_GLOBAL: LINK_RE_GLOBAL,
    _resolveAgainstCwd: _resolveAgainstCwd,
  };

  if (typeof window !== 'undefined') {
    window.fileBrowser = exports;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }
})();
