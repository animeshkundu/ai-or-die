// markdown-render.js — Markdown renderer for the file browser.
//
// Pipeline:
//   1. Lazy-load marked + DOMPurify (already vendored at vendor/{marked,purify}.min.js).
//   2. Parse via marked (GFM, tables, task lists, line breaks).
//   3. Sanitise via DOMPurify with a one-time-registered afterSanitizeAttributes
//      hook that rewrites RELATIVE <img src> and <a href> values inside the
//      sanitisation pipeline (NOT post-sanitise — a post-walk innerHTML rewrite
//      reopens the XSS surface DOMPurify just closed).
//   4. Replace any code.language-mermaid blocks with Mermaid SVG (lazy-load
//      mermaid.esm.min.mjs from CDN on first occurrence; ~500 KB only when
//      needed).
//   5. Render KaTeX for $..$ / $$..$$ if the source contains math markers
//      (lazy-load katex from CDN on first occurrence; ~70 KB only when needed).
//   6. Wire click handler so internal-resolved <a> tags fire opts.onInternalLink
//      instead of navigating away.
//
// Public surface (window.markdownRender):
//   - renderInto(container, source, opts): Promise<{ teardown }>
//   - loadDependencies(): Promise<boolean>
//   - isInternalRelative(url): boolean
//   - resolveRelative(url, basePath): string
//
// Dual-export so tests can require() the pure-JS helpers without a DOM.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var MARKED_SCRIPT = 'vendor/marked.min.js';
  var PURIFY_SCRIPT = 'vendor/purify.min.js';

  // Pin Mermaid / KaTeX versions to keep CDN behaviour reproducible. Only
  // ever loaded if the document actually uses the feature.
  var MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
  var KATEX_CSS_CDN  = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
  var KATEX_JS_CDN   = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
  var KATEX_AUTO_CDN = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js';

  var DEPENDENCY_TIMEOUT_MS = 10000;
  var MERMAID_TIMEOUT_MS = 15000;
  var KATEX_TIMEOUT_MS = 10000;

  // Sentinel attribute used to mark internal-resolved <a> tags. Read by the
  // click delegation handler; chosen to be a fixed, namespaced data-* name so
  // DOMPurify's allow-list-by-default for data-* attributes preserves it.
  var INTERNAL_LINK_ATTR = 'data-fb-internal-path';

  // ---------------------------------------------------------------------------
  // Pure-function helpers (testable under Node)
  // ---------------------------------------------------------------------------

  // True if `url` looks like a path that should be resolved against the local
  // file tree. Returns false for absolute URLs, protocol-relative URLs,
  // anchor fragments, mailto:/javascript:/data: pseudo-schemes, and truly
  // empty values.
  function isInternalRelative(url) {
    if (typeof url !== 'string') return false;
    var u = url.trim();
    if (!u) return false;
    if (u.charAt(0) === '#') return false;                        // anchor
    if (u.indexOf('//') === 0) return false;                      // protocol-relative
    if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return false;            // scheme:foo (mailto:, javascript:, data:, http:, https:, etc.)
    return true;
  }

  // Resolve a relative POSIX-ish path against a base directory. Pure string
  // logic — keep it deterministic and testable. Strips leading `./`, walks
  // `..` segments, normalises slashes. Returns the resolved path with forward
  // slashes; the server's validatePath() handles realpath/symlink resolution
  // on the receive side.
  //
  // basePath should be the DIRECTORY of the markdown file (caller responsibility).
  function resolveRelative(url, basePath) {
    if (!url) return '';
    if (!basePath) return url;
    var clean = String(url).replace(/\\/g, '/').replace(/^\.\//, '');

    // Detect the absolute-path signal BEFORE we strip trailing slashes —
    // otherwise the lone "/" base degrades into "" and we lose the signal.
    var baseRaw = String(basePath).replace(/\\/g, '/');
    var leadingSlash = baseRaw.charAt(0) === '/';
    var base = baseRaw.replace(/\/+$/, '');

    // Already-absolute (Unix /, or Windows-style /C:/) — caller passed an
    // absolute path; preserve it.
    if (clean.charAt(0) === '/') return clean;

    var baseSegs = base.split('/').filter(function (s) { return s.length > 0; });
    var urlSegs = clean.split('/');

    for (var i = 0; i < urlSegs.length; i++) {
      var seg = urlSegs[i];
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (baseSegs.length > 0) baseSegs.pop();
        continue;
      }
      baseSegs.push(seg);
    }
    var joined = baseSegs.join('/');
    return leadingSlash ? '/' + joined : joined;
  }

  // ---------------------------------------------------------------------------
  // Browser-only beyond this point
  // ---------------------------------------------------------------------------

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        isInternalRelative: isInternalRelative,
        resolveRelative: resolveRelative,
      };
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Lazy script loader (single-flight, promise-memoised, retries on failure)
  // ---------------------------------------------------------------------------

  var _scriptPromises = {}; // url -> Promise

  function loadScript(url, opts) {
    opts = opts || {};
    if (_scriptPromises[url]) return _scriptPromises[url];

    var p = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-mr-src="' + url + '"]');
      if (existing) {
        existing.addEventListener('load', function () { resolve(); }, { once: true });
        existing.addEventListener('error', function () { reject(new Error('script load failed: ' + url)); }, { once: true });
        return;
      }
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      if (opts.crossOrigin) s.crossOrigin = 'anonymous';
      s.setAttribute('data-mr-src', url);
      var timer = setTimeout(function () {
        reject(new Error('script load timed out (' + (opts.timeout || DEPENDENCY_TIMEOUT_MS) + 'ms): ' + url));
      }, opts.timeout || DEPENDENCY_TIMEOUT_MS);
      s.onload = function () { clearTimeout(timer); resolve(); };
      s.onerror = function () { clearTimeout(timer); reject(new Error('script load failed: ' + url)); };
      document.head.appendChild(s);
    }).catch(function (err) {
      // Reset memoisation on failure so a later call can retry — transient
      // CDN blip shouldn't permanently break markdown for the session.
      delete _scriptPromises[url];
      throw err;
    });

    _scriptPromises[url] = p;
    return p;
  }

  function loadStylesheet(url) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('link[data-mr-href="' + url + '"]');
      if (existing) { resolve(); return; }
      var l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = url;
      l.crossOrigin = 'anonymous';
      l.setAttribute('data-mr-href', url);
      l.onload = function () { resolve(); };
      l.onerror = function () { reject(new Error('stylesheet load failed: ' + url)); };
      document.head.appendChild(l);
    });
  }

  function loadDependencies() {
    if (typeof window.marked !== 'undefined' && typeof window.DOMPurify !== 'undefined') {
      return Promise.resolve(true);
    }
    return Promise.all([
      typeof window.marked !== 'undefined' ? Promise.resolve() : loadScript(MARKED_SCRIPT),
      typeof window.DOMPurify !== 'undefined' ? Promise.resolve() : loadScript(PURIFY_SCRIPT),
    ]).then(function () {
      return typeof window.marked !== 'undefined' && typeof window.DOMPurify !== 'undefined';
    });
  }

  // ---------------------------------------------------------------------------
  // DOMPurify hook — registered ONCE per page lifetime. Reads per-render
  // context from `_currentRenderContext` (set immediately before sanitize(),
  // cleared in `finally`). Hook is global by DOMPurify design; this pattern
  // is the documented way to safely keep it scoped.
  // ---------------------------------------------------------------------------

  var _hookRegistered = false;
  var _currentRenderContext = null; // { basePath: string|null, internalLinks: Set<HTMLElement> }

  function _ensureHook() {
    if (_hookRegistered || typeof window.DOMPurify === 'undefined') return;
    _hookRegistered = true;

    window.DOMPurify.addHook('afterSanitizeAttributes', function (node) {
      var ctx = _currentRenderContext;
      if (!ctx || !node.hasAttribute) return;

      var tag = (node.tagName || '').toUpperCase();

      // <img src=...> — rewrite relative refs to /api/files/download?inline=1
      if (tag === 'IMG' && node.hasAttribute('src')) {
        var src = node.getAttribute('src');
        if (isInternalRelative(src)) {
          var resolvedImg = resolveRelative(src, ctx.basePath);
          if (resolvedImg) {
            node.setAttribute(
              'src',
              '/api/files/download?path=' + encodeURIComponent(resolvedImg) + '&inline=1'
            );
          }
        }
      }

      // <a href=...> — tag relative links with INTERNAL_LINK_ATTR so the
      // click delegator can route them through onInternalLink. Replace the
      // user-visible href with '#' so a fallback navigation can't escape.
      if (tag === 'A' && node.hasAttribute('href')) {
        var href = node.getAttribute('href');
        if (isInternalRelative(href)) {
          var resolvedHref = resolveRelative(href, ctx.basePath);
          if (resolvedHref) {
            node.setAttribute(INTERNAL_LINK_ATTR, resolvedHref);
            node.setAttribute('href', '#');
            // Friendly title showing the resolved path on hover.
            if (!node.hasAttribute('title')) node.setAttribute('title', resolvedHref);
          }
        } else {
          // External links always open in a new tab; rel hardens the link
          // against tabnabbing.
          if (!node.hasAttribute('target')) node.setAttribute('target', '_blank');
          var rel = node.getAttribute('rel') || '';
          if (rel.indexOf('noopener') === -1) {
            node.setAttribute('rel', (rel + ' noopener noreferrer').trim());
          }
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Mermaid lazy-render
  // ---------------------------------------------------------------------------

  var _mermaidPromise = null;

  function _loadMermaid() {
    if (_mermaidPromise) return _mermaidPromise;
    _mermaidPromise = (function () {
      // Use dynamic import for the ESM build so we get a real module reference,
      // not a global. Fall back to script-tag loading is unnecessary because
      // import() is supported in every browser this app targets.
      var p = Promise.race([
        import(/* webpackIgnore: true */ MERMAID_CDN),
        new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('mermaid load timed out')); }, MERMAID_TIMEOUT_MS);
        }),
      ]).then(function (mod) {
        var mermaid = mod && (mod.default || mod);
        if (!mermaid || typeof mermaid.run !== 'function') {
          throw new Error('mermaid module shape unexpected');
        }
        // Inherit page theme: dark vs light decided by data-theme.
        var themeName = document.documentElement.getAttribute('data-theme') || 'midnight';
        var darkLike = ['midnight', 'classic-dark', 'monokai', 'nord', 'solarized-dark'];
        var theme = darkLike.indexOf(themeName) === -1 ? 'default' : 'dark';
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme });
        return mermaid;
      });
      return p.catch(function (err) {
        _mermaidPromise = null; // allow retry next time
        throw err;
      });
    })();
    return _mermaidPromise;
  }

  // The marked renderer emits ```mermaid blocks as <pre><code class="language-mermaid">.
  // We hand each one to Mermaid for SVG conversion, replacing the <pre> with
  // the rendered SVG (or a small error badge if rendering fails).
  function _renderMermaidBlocks(container) {
    var nodes = container.querySelectorAll('pre code.language-mermaid');
    if (!nodes.length) return Promise.resolve();
    return _loadMermaid().then(function (mermaid) {
      var promises = [];
      Array.prototype.forEach.call(nodes, function (codeEl, i) {
        var pre = codeEl.parentElement;
        if (!pre) return;
        var src = codeEl.textContent || '';
        var id = 'fb-mermaid-' + Date.now() + '-' + i;
        var wrapper = document.createElement('div');
        wrapper.className = 'fb-mermaid-block';
        wrapper.id = id + '-wrap';
        pre.replaceWith(wrapper);
        promises.push(
          mermaid.render(id, src).then(function (out) {
            wrapper.innerHTML = out.svg;
            if (out.bindFunctions) { try { out.bindFunctions(wrapper); } catch (_) { /* ignore */ } }
          }).catch(function (err) {
            wrapper.className = 'fb-mermaid-block fb-mermaid-error';
            wrapper.textContent = 'Mermaid render failed: ' + (err && err.message ? err.message : 'unknown');
          })
        );
      });
      return Promise.all(promises);
    }).catch(function (err) {
      // Mermaid couldn't load — leave the raw code blocks visible and add a
      // single small badge above the first one so the user knows why.
      var first = container.querySelector('pre code.language-mermaid');
      if (first && first.parentElement) {
        var badge = document.createElement('div');
        badge.className = 'fb-md-feature-unavailable';
        badge.textContent = 'Mermaid diagrams unavailable: ' +
          (err && err.message ? err.message : 'CDN load failed');
        first.parentElement.parentElement.insertBefore(badge, first.parentElement);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // KaTeX lazy-render
  // ---------------------------------------------------------------------------

  var _katexPromise = null;

  function _hasMath(source) {
    if (typeof source !== 'string' || !source) return false;
    // Cheap detectors: $$..$$ blocks, $..$ inline, \(..\), \[..\].
    return /\$\$[\s\S]+?\$\$/.test(source) ||
           /(?:^|[^\\$])\$[^\s$][^$]*[^\s$]\$(?:[^$]|$)/.test(source) ||
           /\\\([^\)]+\\\)/.test(source) ||
           /\\\[[^\]]+\\\]/.test(source);
  }

  function _loadKatex() {
    if (_katexPromise) return _katexPromise;
    _katexPromise = Promise.all([
      loadStylesheet(KATEX_CSS_CDN),
      loadScript(KATEX_JS_CDN, { crossOrigin: true, timeout: KATEX_TIMEOUT_MS }),
    ]).then(function () {
      return loadScript(KATEX_AUTO_CDN, { crossOrigin: true, timeout: KATEX_TIMEOUT_MS });
    }).then(function () {
      if (!window.renderMathInElement || !window.katex) {
        throw new Error('katex globals missing after load');
      }
      return window.renderMathInElement;
    }).catch(function (err) {
      _katexPromise = null;
      throw err;
    });
    return _katexPromise;
  }

  function _renderKatex(container, source) {
    if (!_hasMath(source)) return Promise.resolve();
    return _loadKatex().then(function (renderMathInElement) {
      try {
        renderMathInElement(container, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$',  right: '$',  display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true },
          ],
          throwOnError: false,
          // Don't try to typeset inside <pre> / <code> / our internal anchors.
          ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        });
      } catch (_) { /* swallow individual render failures */ }
    }).catch(function (err) {
      var badge = document.createElement('div');
      badge.className = 'fb-md-feature-unavailable';
      badge.textContent = 'Math preview unavailable: ' +
        (err && err.message ? err.message : 'CDN load failed');
      if (container.firstChild) container.insertBefore(badge, container.firstChild);
      else container.appendChild(badge);
    });
  }

  // ---------------------------------------------------------------------------
  // Internal-link click delegation
  // ---------------------------------------------------------------------------

  function _attachInternalLinkHandler(container, onInternalLink) {
    if (typeof onInternalLink !== 'function') return function () {};
    function handler(e) {
      var target = e.target;
      while (target && target !== container) {
        if (target.tagName === 'A' && target.hasAttribute(INTERNAL_LINK_ATTR)) {
          e.preventDefault();
          var resolved = target.getAttribute(INTERNAL_LINK_ATTR);
          try { onInternalLink(resolved, e); } catch (_) { /* don't break the page */ }
          return;
        }
        target = target.parentElement;
      }
    }
    container.addEventListener('click', handler);
    return function () { container.removeEventListener('click', handler); };
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  function renderInto(container, source, opts) {
    opts = opts || {};
    if (!container || !container.appendChild) {
      return Promise.reject(new Error('renderInto: container is required'));
    }
    var src = source == null ? '' : String(source);
    var basePath = opts.basePath || null;
    var enableMermaid = opts.enableMermaid !== false;
    var enableKatex   = opts.enableKatex   !== false;

    // Insert a placeholder so the DOM isn't empty during the load.
    while (container.firstChild) container.removeChild(container.firstChild);
    var loading = document.createElement('div');
    loading.className = 'fb-md-loading';
    loading.textContent = 'Rendering markdown...';
    container.appendChild(loading);

    return loadDependencies().then(function (ok) {
      if (!ok) throw new Error('marked / DOMPurify unavailable');
      _ensureHook();

      var wrapper = document.createElement('div');
      wrapper.className = opts.wrapperClass || 'fb-markdown-rendered';

      // marked configuration — GFM with line breaks. Code-block highlighting
      // is intentionally NOT pulled in here: the file browser previews code
      // files via Monaco, and rendering an in-page highlighter for fenced
      // blocks pulls in another large dependency for marginal value. The
      // mermaid pass below catches the only fenced-block special case we
      // actively need.
      try {
        if (typeof window.marked.setOptions === 'function') {
          window.marked.setOptions({ gfm: true, breaks: true });
        }
      } catch (_) { /* older marked APIs — fall back to defaults */ }

      var rawHtml;
      try {
        rawHtml = window.marked.parse(src);
      } catch (err) {
        throw new Error('marked.parse failed: ' + (err && err.message ? err.message : 'unknown'));
      }

      // Sanitise with the per-render context active.
      _currentRenderContext = { basePath: basePath };
      var safeHtml;
      try {
        safeHtml = window.DOMPurify.sanitize(rawHtml, {
          USE_PROFILES: { html: true },
          ADD_ATTR: ['target', INTERNAL_LINK_ATTR],
          // Keep <img loading="lazy"> as a hint when emitted by marked.
          ALLOWED_ATTR: undefined,
        });
      } finally {
        _currentRenderContext = null;
      }

      wrapper.innerHTML = safeHtml;

      // Replace the placeholder with the rendered wrapper.
      while (container.firstChild) container.removeChild(container.firstChild);
      container.appendChild(wrapper);

      // Wire internal-link click delegation; capture the unbinder for teardown.
      var unbindClicks = _attachInternalLinkHandler(wrapper, opts.onInternalLink);

      // Lazy enrichment passes — both swallow their own failures so a missing
      // mermaid/katex doesn't cascade-break the rendered markdown body.
      var passes = [];
      if (enableMermaid && wrapper.querySelector('pre code.language-mermaid')) {
        passes.push(_renderMermaidBlocks(wrapper));
      }
      if (enableKatex) passes.push(_renderKatex(wrapper, src));

      return Promise.all(passes).then(function () {
        return {
          wrapper: wrapper,
          teardown: function () {
            try { unbindClicks(); } catch (_) { /* ignore */ }
            // Caller is responsible for removing the wrapper from its
            // container; we don't unmount here so callers can do their own
            // transitions.
          },
        };
      });
    }).catch(function (err) {
      // Hard failure: fall back to a plain <pre> with the source content so
      // the user can still read the file.
      while (container.firstChild) container.removeChild(container.firstChild);
      var fallback = document.createElement('div');
      fallback.className = 'fb-md-fallback';
      var msg = document.createElement('div');
      msg.className = 'fb-md-feature-unavailable';
      msg.textContent = 'Markdown rendering unavailable (' +
        (err && err.message ? err.message : 'unknown error') +
        '); showing raw source.';
      fallback.appendChild(msg);
      var pre = document.createElement('pre');
      pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);font-size:13px;margin:0;padding:8px';
      pre.textContent = src;
      fallback.appendChild(pre);
      container.appendChild(fallback);
      return { wrapper: fallback, teardown: function () {} };
    });
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var exportsObj = {
    renderInto: renderInto,
    loadDependencies: loadDependencies,
    isInternalRelative: isInternalRelative,
    resolveRelative: resolveRelative,
    INTERNAL_LINK_ATTR: INTERNAL_LINK_ATTR,
    // Constants for tests + integration.
    MARKED_SCRIPT: MARKED_SCRIPT,
    PURIFY_SCRIPT: PURIFY_SCRIPT,
    MERMAID_CDN: MERMAID_CDN,
    KATEX_JS_CDN: KATEX_JS_CDN,
    KATEX_CSS_CDN: KATEX_CSS_CDN,
  };

  window.markdownRender = exportsObj;
  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
})();
