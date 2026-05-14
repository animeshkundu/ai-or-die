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

  // Ace Editor language mode mapping
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

  function getFileIcon(item) {
    if (item.isDirectory) return 'folder';
    return FILE_ICON_MAP[item.mimeCategory] || 'file';
  }

  function getAceMode(extension) {
    if (!extension) return 'text';
    return ACE_MODE_MAP[extension.toLowerCase()] || 'text';
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
      if (e.key === 'Escape') {
        if (this._searchVisible) {
          this._toggleSearch();
        } else if (this._currentView === 'editor') {
          // Don't handle Escape here — Ace Editor has its own Escape
          // command that handles closing search bar vs closing editor.
          // The document-level fallback handler will catch it if Ace
          // doesn't consume it.
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
          // Check if Ace has an internal popup open (search bar)
          var aceSearch = self._panelEl.querySelector('.ace_search');
          if (aceSearch && aceSearch.offsetParent !== null) {
            // Ace search is visible — let Ace handle this Escape, don't close editor
            return;
          }
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
    this._previewPanel.showPreview(item, this._currentPath);
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

    // Clear preview container and render editor
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
      this._previewContainer.innerHTML = '<div class="fb-preview-error">Editor not available. Ace Editor may not have loaded.</div>';
    }

    this._renderBreadcrumbs();
    this._adjustTerminal();
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
    // Tear-down hooks for renderers that attach state outside the container
    // (Panzoom, Monaco, PDF.js etc. wire document-level event listeners that
    // innerHTML='' won't release). Each renderer pushes a function here;
    // showPreview() drains them before rendering the next file.
    this._activeDisposers = [];
  }

  FilePreviewPanel.prototype._disposeActive = function () {
    while (this._activeDisposers.length) {
      var fn = this._activeDisposers.pop();
      try { fn(); } catch (_) { /* swallow — disposer should never throw */ }
    }
  };

  FilePreviewPanel.prototype.showPreview = function (item, currentDir) {
    var self = this;
    this._disposeActive();
    this.containerEl.innerHTML = '';

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

    // Download button
    var dlBtn = document.createElement('button');
    dlBtn.className = 'btn btn-secondary btn-small';
    dlBtn.textContent = 'Download';
    dlBtn.addEventListener('click', function () {
      window.open('/api/files/download?path=' + encodeURIComponent(item.path), '_blank');
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
    img.src = '/api/files/download?path=' + encodeURIComponent(item.path) + '&inline=1';
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
    var iframe = document.createElement('iframe');
    iframe.className = 'fb-preview-pdf';
    iframe.src = '/api/files/download?path=' + encodeURIComponent(item.path) + '&inline=1';
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

        if (item.mimeCategory === 'json') {
          self._renderJson(container, data.content);
        } else if (item.mimeCategory === 'csv') {
          self._renderCsv(container, data.content);
        } else {
          self._renderCode(container, data.content);
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

  FilePreviewPanel.prototype._renderCode = function (container, content) {
    var wrapper = document.createElement('div');
    wrapper.className = 'fb-code-preview';

    var lines = content.split('\n');
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

  FilePreviewPanel.prototype._renderJson = function (container, content) {
    try {
      var parsed = JSON.parse(content);
      var formatted = JSON.stringify(parsed, null, 2);
      this._renderCode(container, formatted);
    } catch (e) {
      this._renderCode(container, content);
    }
  };

  FilePreviewPanel.prototype._renderCsv = function (container, content) {
    var lines = content.split('\n').filter(function (l) { return l.trim(); });
    if (!lines.length) {
      container.textContent = 'Empty CSV file';
      return;
    }

    var table = document.createElement('table');
    table.className = 'fb-csv-table';

    var maxRows = Math.min(lines.length, 101); // 1 header + 100 data rows
    for (var i = 0; i < maxRows; i++) {
      var row = document.createElement('tr');
      var cells = lines[i].split(',');
      for (var j = 0; j < cells.length; j++) {
        var cell = document.createElement(i === 0 ? 'th' : 'td');
        cell.textContent = cells[j].replace(/^"|"$/g, '').trim();
        row.appendChild(cell);
      }
      table.appendChild(row);
    }

    var tableWrapper = document.createElement('div');
    tableWrapper.className = 'fb-csv-wrapper';
    tableWrapper.appendChild(table);
    container.appendChild(tableWrapper);

    if (lines.length > 101) {
      var notice = document.createElement('div');
      notice.className = 'fb-truncated-notice';
      notice.textContent = 'Showing first 100 rows of ' + (lines.length - 1);
      container.appendChild(notice);
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

    termEl.addEventListener('contextmenu', function (e) {
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
    }, true /* capture, so we run before main bubble handlers */);

    // Dismiss menu on click elsewhere
    document.addEventListener('click', function () {
      self._hideMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') self._hideMenu();
    });
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
          window.open('/api/files/download?path=' + encodeURIComponent(filePath), '_blank');
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
      var matches = [];
      // Reset lastIndex for safety; we re-execute in a loop below.
      LINK_RE_GLOBAL.lastIndex = 0;
      var m;
      while ((m = LINK_RE_GLOBAL.exec(text)) !== null) {
        var leadLen = m[1] ? m[1].length : 0;
        var pathOnly = m[2];
        if (!pathOnly || VERSION_RE.test(pathOnly)) continue;

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

        // Guard: degenerate empty match could loop forever.
        if (m.index === LINK_RE_GLOBAL.lastIndex) LINK_RE_GLOBAL.lastIndex++;
      }
      return matches;
    }

    function activate(_event, _text, detected) {
      var p = detected.path;
      // Resolve relative paths against the terminal's cwd.
      var resolved = p;
      var cwd = getCwd();
      if (cwd && !/^([A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(p)) {
        // Relative — join with cwd. Use forward slashes uniformly; the
        // server normalizes both.
        var sep = cwd.indexOf('\\') !== -1 && cwd.indexOf('/') === -1 ? '\\' : '/';
        var trimmedCwd = cwd.replace(/[\\/]+$/, '');
        var stripped = p.replace(/^\.[\\/]/, '');
        resolved = trimmedCwd + sep + stripped;
      }

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
    getAceMode: getAceMode,
    formatFileSize: formatFileSize,
    buildBreadcrumbs: buildBreadcrumbs,
    isPreviewable: isPreviewable,
    isEditable: isEditable,
    KNOWN_FILE_EXTENSIONS: KNOWN_FILE_EXTENSIONS,
    LINK_RE_SINGLE: LINK_RE_SINGLE,
    LINK_RE_GLOBAL: LINK_RE_GLOBAL,
  };

  if (typeof window !== 'undefined') {
    window.fileBrowser = exports;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }
})();
