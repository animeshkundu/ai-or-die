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
  // FileBrowserPanel
  // ---------------------------------------------------------------------------

  function FileBrowserPanel(options) {
    this.app = options.app;
    this.authFetch = options.authFetch;
    this.initialPath = options.initialPath || null;

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
    searchBar.className = 'fb-search-bar';
    searchBar.style.display = 'none';
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
    var p = startPath || this.initialPath || null;
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
    // Refit terminal after transition
    setTimeout(function () {
      if (this.app && this.app.fitAddon) {
        try { this.app.fitAddon.fit(); } catch (e) { /* ignore */ }
      }
    }.bind(this), 250);
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
    // Delegate to the file editor if available
    if (window.fileEditor && window.fileEditor.FileEditorPanel) {
      // Editor integration will be added in Phase 1b
      this._announceToScreenReader('Editor not yet available');
    }
  };

  FileBrowserPanel.prototype._handleBack = function () {
    if (this._currentView === 'preview') {
      this._showBrowseView();
    } else {
      this.navigateUp();
    }
  };

  FileBrowserPanel.prototype._toggleSearch = function () {
    this._searchVisible = !this._searchVisible;
    this._searchBar.style.display = this._searchVisible ? '' : 'none';
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
    var total = files.length;
    var done = 0;

    files.forEach(function (file) {
      self._statusBar.textContent = 'Uploading ' + (done + 1) + ' of ' + total + '...';
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
              // File exists — for now, log; overwrite UI in Phase 1b
              self._statusBar.textContent = file.name + ' already exists';
            } else if (!resp.ok) {
              return resp.json().then(function (err) { throw new Error(err.error); });
            }
            done++;
            if (done === total) {
              self._refresh();
              self._statusBar.textContent = total + ' file' + (total > 1 ? 's' : '') + ' uploaded';
            }
          })
          .catch(function (err) {
            self._statusBar.textContent = 'Upload failed: ' + err.message;
          });
      };
      reader.readAsDataURL(file);
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
  }

  FilePreviewPanel.prototype.showPreview = function (item, currentDir) {
    var self = this;
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
    var img = document.createElement('img');
    img.className = 'fb-preview-image';
    img.alt = item.name;
    img.src = '/api/files/download?path=' + encodeURIComponent(item.path) + '&inline=1';
    img.addEventListener('load', function () {
      var dims = document.createElement('div');
      dims.className = 'fb-preview-dims';
      dims.textContent = img.naturalWidth + ' \u00d7 ' + img.naturalHeight + ' px';
      container.appendChild(dims);
    });
    container.appendChild(img);
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
  // TerminalPathDetector (Phase 1c, stub for now)
  // ---------------------------------------------------------------------------

  function TerminalPathDetector(options) {
    this.fileBrowserPanel = options.fileBrowserPanel;
    this.authFetch = options.authFetch;
    this.terminal = options.terminal;
    this._contextMenu = null;
  }

  TerminalPathDetector.prototype.init = function () {
    // Will be fully implemented in Phase 1c
    // Stub: listens for right-click on terminal
  };

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var exports = {
    FileBrowserPanel: FileBrowserPanel,
    FilePreviewPanel: FilePreviewPanel,
    TerminalPathDetector: TerminalPathDetector,
    // Utilities (for testing)
    getFileIcon: getFileIcon,
    getAceMode: getAceMode,
    formatFileSize: formatFileSize,
    buildBreadcrumbs: buildBreadcrumbs,
    isPreviewable: isPreviewable,
    isEditable: isEditable,
  };

  if (typeof window !== 'undefined') {
    window.fileBrowser = exports;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }
})();
