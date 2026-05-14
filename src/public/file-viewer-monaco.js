// file-viewer-monaco.js — Monaco AMD loader, theme map, createCodeViewer factory.
// Per ADR-0016. Lazy-loaded on first preview/editor open.
// Dual-export: window.fileViewerMonaco (browser) + module.exports (Node tests).

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration — pin Monaco version to keep CDN behavior reproducible.
  // ---------------------------------------------------------------------------

  var MONACO_VERSION = '0.52.2';
  var MONACO_BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@' + MONACO_VERSION + '/min/';
  var WORKER_SHIM_PATH = '/vendor/monaco-worker-shim.js';
  var LOADER_TIMEOUT_MS = 15000; // CDN cold-start can be slow; matches Ace's old budget.

  // Workers we know Monaco has under the AMD distribution. Anything outside
  // this set is normalised to the generic editor worker — protects the
  // worker shim's `?label=` from being polluted by future Monaco versions.
  var WORKER_LABEL_ALLOWLIST = [
    'editor', 'editorWorkerService',
    'json', 'css', 'html', 'typescript', 'javascript',
  ];

  // ---------------------------------------------------------------------------
  // Language map — replaces the Ace mode map at file-browser.js:23-42 and
  // file-editor.js:7-26. Monaco language IDs differ slightly from Ace's:
  //   Ace 'golang' → Monaco 'go'
  //   Ace 'c_cpp'  → Monaco 'cpp'
  //   Ace 'sh'     → Monaco 'shell'
  //   Ace 'batchfile' → Monaco 'bat'
  //   Ace 'json5'  → Monaco 'json' (no native json5)
  //   Ace 'jsx'    → Monaco 'javascript' (built-in TS service handles JSX)
  //   Ace 'tsx'    → Monaco 'typescript' (ditto)
  //   Ace 'text'   → Monaco 'plaintext'
  // ---------------------------------------------------------------------------

  var MONACO_LANGUAGE_MAP = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.c': 'cpp', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
    '.h': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
    '.cs': 'csharp', '.php': 'php',
    '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
    '.ps1': 'powershell',
    '.bat': 'bat', '.cmd': 'bat',
    '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'plaintext',
    '.xml': 'xml', '.html': 'html', '.htm': 'html', '.svg': 'xml',
    '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql',
    '.swift': 'swift', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala',
    '.r': 'r', '.lua': 'lua', '.pl': 'perl', '.pm': 'perl',
    '.dart': 'dart', '.elm': 'plaintext', '.ex': 'plaintext', '.exs': 'plaintext',
    '.md': 'markdown', '.mdx': 'markdown', '.markdown': 'markdown',
    '.json': 'json', '.json5': 'json', '.jsonc': 'json',
    '.csv': 'plaintext', '.tsv': 'plaintext',
    '.txt': 'plaintext', '.log': 'plaintext',
    '.cfg': 'ini', '.ini': 'ini', '.conf': 'ini',
    '.env': 'plaintext', '.properties': 'plaintext',
    '.dockerfile': 'dockerfile', '.makefile': 'makefile', '.mk': 'makefile',
  };

  // Filenames (no extension) we want to highlight too.
  var MONACO_FILENAME_MAP = {
    'dockerfile': 'dockerfile',
    'makefile': 'makefile',
    'gnumakefile': 'makefile',
    'jenkinsfile': 'plaintext',
  };

  function getMonacoLanguage(extOrPath) {
    if (!extOrPath) return 'plaintext';
    var key = String(extOrPath).toLowerCase();
    if (MONACO_LANGUAGE_MAP[key]) return MONACO_LANGUAGE_MAP[key];
    // Caller may have passed a full path — try extracting the basename.
    var slash = key.replace(/\\/g, '/').lastIndexOf('/');
    var base = slash === -1 ? key : key.slice(slash + 1);
    if (MONACO_FILENAME_MAP[base]) return MONACO_FILENAME_MAP[base];
    var dot = base.lastIndexOf('.');
    if (dot !== -1) {
      var byExt = MONACO_LANGUAGE_MAP[base.slice(dot)];
      if (byExt) return byExt;
    }
    return 'plaintext';
  }

  // ---------------------------------------------------------------------------
  // Theme map — application themes (data-theme attribute) → Monaco theme name.
  // The four custom themes are registered against `monaco.editor.defineTheme`
  // the first time `loadMonaco()` resolves; built-ins (`vs`, `vs-dark`)
  // require no registration.
  // ---------------------------------------------------------------------------

  var THEME_MAP = {
    'midnight':         'vs-dark',
    'classic-dark':     'vs-dark',
    'classic-light':    'vs',
    'monokai':          'aod-monokai',
    'nord':             'aod-nord',
    'solarized-dark':   'aod-solarized-dark',
    'solarized-light':  'aod-solarized-light',
  };

  // Custom palettes — pulled from tokens.css so editor chrome stays in
  // visual sync with the rest of the app surface.
  var CUSTOM_THEMES = {
    'aod-monokai': {
      base: 'vs-dark',
      colors: {
        'editor.background':         '#272822',
        'editor.foreground':         '#f8f8f2',
        'editorLineNumber.foreground': '#75715e',
        'editorLineNumber.activeForeground': '#f8f8f2',
        'editor.selectionBackground': '#49483e',
        'editor.lineHighlightBackground': '#3e3d32',
        'editorCursor.foreground':   '#f8f8f0',
        'editorWhitespace.foreground': '#3b3a32',
        'editorIndentGuide.background': '#3b3a32',
      },
    },
    'aod-nord': {
      base: 'vs-dark',
      colors: {
        'editor.background':         '#2e3440',
        'editor.foreground':         '#d8dee9',
        'editorLineNumber.foreground': '#4c566a',
        'editorLineNumber.activeForeground': '#eceff4',
        'editor.selectionBackground': '#434c5e',
        'editor.lineHighlightBackground': '#3b4252',
        'editorCursor.foreground':   '#88c0d0',
        'editorWhitespace.foreground': '#3b4252',
        'editorIndentGuide.background': '#3b4252',
      },
    },
    'aod-solarized-dark': {
      base: 'vs-dark',
      colors: {
        'editor.background':         '#002b36',
        'editor.foreground':         '#839496',
        'editorLineNumber.foreground': '#586e75',
        'editorLineNumber.activeForeground': '#eee8d5',
        'editor.selectionBackground': '#073642',
        'editor.lineHighlightBackground': '#073642',
        'editorCursor.foreground':   '#268bd2',
        'editorWhitespace.foreground': '#073642',
        'editorIndentGuide.background': '#073642',
      },
    },
    'aod-solarized-light': {
      base: 'vs',
      colors: {
        'editor.background':         '#fdf6e3',
        'editor.foreground':         '#586e75',
        'editorLineNumber.foreground': '#93a1a1',
        'editorLineNumber.activeForeground': '#073642',
        'editor.selectionBackground': '#eee8d5',
        'editor.lineHighlightBackground': '#eee8d5',
        'editorCursor.foreground':   '#268bd2',
        'editorWhitespace.foreground': '#eee8d5',
        'editorIndentGuide.background': '#eee8d5',
      },
    },
  };

  function getCurrentThemeName() {
    if (typeof document === 'undefined' || !document.documentElement) return 'midnight';
    return document.documentElement.getAttribute('data-theme') || 'midnight';
  }

  function resolveMonacoTheme(themeOverride) {
    var key = themeOverride || getCurrentThemeName();
    return THEME_MAP[key] || 'vs-dark';
  }

  // ---------------------------------------------------------------------------
  // Loader — promise-memoised. The first caller pays the CDN cost; subsequent
  // callers get the resolved promise. On failure the cached promise is
  // cleared so the next caller can retry (e.g. user reconnects after a
  // transient CDN blip).
  // ---------------------------------------------------------------------------

  var _monacoPromise = null;
  var _themesDefined = false;

  function _normaliseLabel(label) {
    if (!label) return 'editor';
    return WORKER_LABEL_ALLOWLIST.indexOf(label) === -1 ? 'editor' : label;
  }

  function _registerCustomThemes(monaco) {
    if (_themesDefined) return;
    Object.keys(CUSTOM_THEMES).forEach(function (name) {
      var t = CUSTOM_THEMES[name];
      // `rules: []` keeps Monaco's tokenizer rules from its base theme;
      // we override only chrome colors, not token highlight colors.
      monaco.editor.defineTheme(name, {
        base: t.base,
        inherit: true,
        rules: [],
        colors: t.colors,
      });
    });
    _themesDefined = true;
  }

  function loadMonaco() {
    if (_monacoPromise) return _monacoPromise;
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return Promise.reject(new Error('loadMonaco: not in a browser'));
    }

    _monacoPromise = new Promise(function (resolve, reject) {
      // 1. Configure same-origin worker shim BEFORE Monaco loads. Monaco
      //    reads MonacoEnvironment.getWorker on first model creation.
      window.MonacoEnvironment = {
        getWorker: function (_workerId, label) {
          var safeLabel = _normaliseLabel(label);
          var url = WORKER_SHIM_PATH +
                    '?base=' + encodeURIComponent(MONACO_BASE) +
                    '&label=' + encodeURIComponent(safeLabel);
          return new Worker(url, { name: 'monaco-' + safeLabel });
        },
      };

      // 2. Already loaded? (e.g. caller raced two loadMonaco() before promise
      //    memoisation took effect, or monaco was preloaded via a script tag.)
      if (window.monaco && window.monaco.editor) {
        try { _registerCustomThemes(window.monaco); } catch (_) { /* ignore */ }
        return resolve(window.monaco);
      }

      var timeoutId = setTimeout(function () {
        reject(new Error('loadMonaco: timed out after ' + LOADER_TIMEOUT_MS + 'ms'));
      }, LOADER_TIMEOUT_MS);

      function done(err, monaco) {
        clearTimeout(timeoutId);
        if (err) reject(err); else resolve(monaco);
      }

      function configureAndLoadEditor() {
        try {
          // The AMD loader may already be configured by another caller.
          // Calling require.config a second time with the same paths is
          // a no-op in the Monaco loader.
          window.require.config({ paths: { vs: MONACO_BASE + 'vs' } });
          window.require(['vs/editor/editor.main'], function () {
            try { _registerCustomThemes(window.monaco); } catch (_) { /* ignore */ }
            done(null, window.monaco);
          }, function (err) {
            done(err || new Error('loadMonaco: editor.main load failed'));
          });
        } catch (err) {
          done(err);
        }
      }

      // 3. AMD loader already injected? Reuse it.
      if (window.require && typeof window.require.config === 'function') {
        return configureAndLoadEditor();
      }

      // 4. Inject the AMD loader from the CDN.
      var existing = document.querySelector('script[data-monaco-loader]');
      if (existing) {
        existing.addEventListener('load', configureAndLoadEditor, { once: true });
        existing.addEventListener('error', function () {
          done(new Error('loadMonaco: loader.js fetch failed (existing tag)'));
        }, { once: true });
        return;
      }

      var s = document.createElement('script');
      s.src = MONACO_BASE + 'vs/loader.js';
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.setAttribute('data-monaco-loader', '1');
      s.onload = configureAndLoadEditor;
      s.onerror = function () { done(new Error('loadMonaco: loader.js fetch failed')); };
      document.head.appendChild(s);
    }).catch(function (err) {
      // Reset the cache so a later call can retry — a transient CDN blip
      // shouldn't permanently break the file browser for the session.
      _monacoPromise = null;
      throw err;
    });

    return _monacoPromise;
  }

  // ---------------------------------------------------------------------------
  // Factory — used by both the read-only preview pane (task #17) and the
  // editor pane (task #15). Caller decides readOnly + autosave wiring.
  // Returns a thenable resolving to { editor, monaco, dispose }.
  // ---------------------------------------------------------------------------

  function createCodeViewer(container, options) {
    options = options || {};
    if (!container || !container.appendChild) {
      return Promise.reject(new Error('createCodeViewer: container is required'));
    }

    return loadMonaco().then(function (monaco) {
      var theme = resolveMonacoTheme(options.theme);
      var language = options.language || getMonacoLanguage(options.extension || '');
      var editor = monaco.editor.create(container, {
        value: options.content == null ? '' : String(options.content),
        language: language,
        theme: theme,
        readOnly: !!options.readOnly,
        // Layout: parent must have non-zero height; Monaco uses ResizeObserver.
        automaticLayout: true,
        // Visual / behavior defaults — lifted from the project's tokens.css
        // so editor matches the surrounding UI without per-call tuning.
        fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
        fontSize: options.fontSize || 13,
        lineNumbers: options.lineNumbers || 'on',
        minimap: { enabled: options.minimap == null ? !options.readOnly : !!options.minimap },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        renderWhitespace: 'selection',
        wordWrap: options.wordWrap || 'off',
        tabSize: options.tabSize || 2,
        insertSpaces: options.insertSpaces == null ? true : !!options.insertSpaces,
        contextmenu: options.contextmenu == null ? true : !!options.contextmenu,
        // Mobile / accessibility — keyboard navigation works without a mouse.
        accessibilitySupport: 'auto',
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: 'active', indentation: true },
        // Disable Monaco's built-in command palette key (F1) collision-prone
        // with browser screen readers; the host app owns command palette.
        ariaLabel: options.ariaLabel || 'Code editor',
      });

      function dispose() {
        try { editor.getModel() && editor.getModel().dispose(); } catch (_) { /* ignore */ }
        try { editor.dispose(); } catch (_) { /* ignore */ }
      }

      return { editor: editor, monaco: monaco, dispose: dispose };
    });
  }

  // ---------------------------------------------------------------------------
  // Fallback — render a plain <pre> with line numbers when Monaco is
  // unreachable (CDN blocked, network error, integrity failure). Caller is
  // expected to invoke this from createCodeViewer's .catch().
  // ---------------------------------------------------------------------------

  function renderPlainTextFallback(container, options) {
    options = options || {};
    if (!container || !container.appendChild) return null;
    while (container.firstChild) container.removeChild(container.firstChild);

    var wrap = document.createElement('div');
    wrap.className = 'fb-monaco-fallback';
    wrap.setAttribute('data-fallback', 'monaco-unavailable');

    var notice = document.createElement('div');
    notice.className = 'fb-monaco-fallback-notice';
    notice.textContent = options.notice || 'Code viewer unavailable — falling back to plain text.';
    wrap.appendChild(notice);

    var pre = document.createElement('pre');
    pre.className = 'fb-monaco-fallback-pre';
    pre.style.fontFamily = "var(--font-mono, 'JetBrains Mono', monospace)";
    pre.style.fontSize = '13px';
    pre.style.whiteSpace = 'pre';
    pre.style.overflow = 'auto';
    pre.style.margin = '0';
    pre.style.padding = '8px';

    var content = options.content == null ? '' : String(options.content);
    var lines = content.split('\n');
    var pad = String(lines.length).length;
    var lineNumbered = lines.map(function (line, i) {
      var n = String(i + 1);
      while (n.length < pad) n = ' ' + n;
      return n + '  ' + line;
    }).join('\n');
    pre.textContent = lineNumbered;
    wrap.appendChild(pre);

    container.appendChild(wrap);
    return { fallback: true, dispose: function () { /* noop */ } };
  }

  // ---------------------------------------------------------------------------
  // Theme propagation — when the user changes the app theme, re-apply across
  // all live Monaco instances. Caller subscribes via this small helper.
  // ---------------------------------------------------------------------------

  function applyThemeToAll() {
    if (!window.monaco || !window.monaco.editor) return;
    try {
      window.monaco.editor.setTheme(resolveMonacoTheme());
    } catch (_) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var exportsObj = {
    // Public API
    loadMonaco: loadMonaco,
    createCodeViewer: createCodeViewer,
    renderPlainTextFallback: renderPlainTextFallback,
    getMonacoLanguage: getMonacoLanguage,
    resolveMonacoTheme: resolveMonacoTheme,
    applyThemeToAll: applyThemeToAll,
    // Constants for tests + integration
    MONACO_VERSION: MONACO_VERSION,
    MONACO_BASE: MONACO_BASE,
    WORKER_SHIM_PATH: WORKER_SHIM_PATH,
    WORKER_LABEL_ALLOWLIST: WORKER_LABEL_ALLOWLIST.slice(),
    THEME_MAP: THEME_MAP,
    MONACO_LANGUAGE_MAP: MONACO_LANGUAGE_MAP,
    MONACO_FILENAME_MAP: MONACO_FILENAME_MAP,
    // Internal — exposed only for tests
    _normaliseLabel: _normaliseLabel,
  };

  if (typeof window !== 'undefined') window.fileViewerMonaco = exportsObj;
  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
})();
