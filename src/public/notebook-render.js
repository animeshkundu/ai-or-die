// notebook-render.js — read-only Jupyter notebook (.ipynb) viewer.
//
// Lazy-loads kokes/nbviewer.js from CDN on first .ipynb preview (~50 KB
// gz). Parses the notebook JSON, hands it to nbv.render() into a detached
// scratch DIV, then pipes the resulting HTML through the vendored
// DOMPurify with the same FORBID_ATTR/FORBID_TAGS profile as
// markdown-render.js (#1) before inserting into the real container.
// Rendering directly with nbv.render(notebook, container) would skip the
// sanitisation pass entirely — and notebook output cells can contain
// arbitrary HTML, so this is the security boundary.
//
// Public API (window.notebookRender):
//   renderInto(container, source, opts)  → Promise<{ wrapper, teardown }>
//   loadDependencies()                   → Promise<boolean>
//   parseNotebook(source)                → { ok, notebook, error }   pure
//
// `source` can be a JSON string OR a parsed notebook object. `opts.basePath`
// is reserved for future relative-link rewriting (notebook attachments
// with `attachment:` URIs); v1 only renders text + outputs.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  // Vendor pinning. nbviewer.js (kokes) is small and stable; pinning avoids
  // surprise breaks on a major-version bump.
  var NBV_CDN = 'https://cdn.jsdelivr.net/npm/nbviewer.js@1.0.0/dist/nbv.min.js';
  var DEPENDENCY_TIMEOUT_MS = 12000;

  // Reuse vendored DOMPurify if present (markdown-render.js loads it on
  // demand); fall back to loading it ourselves so the notebook viewer
  // works even when no markdown file has been previewed yet.
  var PURIFY_SCRIPT = '/vendor/purify.min.js';

  var SANITIZE_CONFIG = {
    USE_PROFILES: { html: true },
    // Same defenses as markdown-render.js (#1 fix-up):
    //   - 'style'  : CSS-exfil via inline background-image: url(...).
    //   - 'srcset' : protocol-relative leak; outputs only need src.
    FORBID_ATTR: ['style', 'srcset'],
    FORBID_TAGS: [
      'style', 'form', 'input', 'button',
      'select', 'textarea', 'fieldset', 'label',
    ],
  };

  // ---------------------------------------------------------------------------
  // Pure helpers (testable under Node)
  // ---------------------------------------------------------------------------

  // Parse a notebook source (JSON string or object) into a normalised
  // shape. Returns { ok, notebook?, error? } so the caller doesn't need
  // try/catch around JSON.parse for the common case.
  function parseNotebook(source) {
    if (source == null) return { ok: false, error: 'empty notebook source' };
    if (typeof source === 'object') {
      // Already parsed. Sanity-check minimal shape.
      if (!Array.isArray(source.cells)) {
        return { ok: false, error: 'notebook is missing cells[]' };
      }
      return { ok: true, notebook: source };
    }
    if (typeof source !== 'string') {
      return { ok: false, error: 'notebook source must be string or object (got ' + typeof source + ')' };
    }
    var trimmed = source.trim();
    if (!trimmed) return { ok: false, error: 'notebook source is empty' };
    var parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      return { ok: false, error: 'invalid JSON: ' + (e && e.message ? e.message : 'parse failed') };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'notebook root must be an object' };
    }
    if (!Array.isArray(parsed.cells)) {
      return { ok: false, error: 'notebook is missing cells[]' };
    }
    return { ok: true, notebook: parsed };
  }

  // ---------------------------------------------------------------------------
  // Browser-only beyond this point
  // ---------------------------------------------------------------------------

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        parseNotebook: parseNotebook,
        NBV_CDN: NBV_CDN,
        SANITIZE_CONFIG: SANITIZE_CONFIG,
      };
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Lazy script loader (single-flight, promise-memoised, retries on failure)
  // ---------------------------------------------------------------------------

  var _scriptPromises = {};

  function loadScript(url, opts) {
    opts = opts || {};
    if (_scriptPromises[url]) return _scriptPromises[url];
    var p = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-nb-src="' + url + '"]');
      if (existing) {
        existing.addEventListener('load', function () { resolve(); }, { once: true });
        existing.addEventListener('error', function () {
          reject(new Error('script load failed: ' + url));
        }, { once: true });
        return;
      }
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      if (opts.crossOrigin) s.crossOrigin = 'anonymous';
      s.setAttribute('data-nb-src', url);
      var timer = setTimeout(function () {
        reject(new Error('script load timed out (' +
          (opts.timeout || DEPENDENCY_TIMEOUT_MS) + 'ms): ' + url));
      }, opts.timeout || DEPENDENCY_TIMEOUT_MS);
      s.onload = function () { clearTimeout(timer); resolve(); };
      s.onerror = function () { clearTimeout(timer); reject(new Error('script load failed: ' + url)); };
      document.head.appendChild(s);
    }).catch(function (err) {
      // Reset memoisation on failure so a later call can retry.
      delete _scriptPromises[url];
      throw err;
    });
    _scriptPromises[url] = p;
    return p;
  }

  function loadDependencies() {
    var needPurify = typeof window.DOMPurify === 'undefined';
    var needNbv    = typeof window.nbv === 'undefined' || typeof window.nbv.render !== 'function';
    var promises = [];
    if (needPurify) promises.push(loadScript(PURIFY_SCRIPT));
    if (needNbv)    promises.push(loadScript(NBV_CDN, { crossOrigin: true }));
    return Promise.all(promises).then(function () {
      return typeof window.DOMPurify !== 'undefined' &&
             typeof window.nbv !== 'undefined' &&
             typeof window.nbv.render === 'function';
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function renderInto(container, source, opts) {
    opts = opts || {};
    if (!container || !container.appendChild) {
      return Promise.reject(new Error('renderInto: container is required'));
    }

    // Show a loading placeholder for the CDN cold-start window.
    while (container.firstChild) container.removeChild(container.firstChild);
    var loading = document.createElement('div');
    loading.className = 'fb-nb-loading';
    loading.textContent = 'Rendering notebook...';
    container.appendChild(loading);

    // Parse FIRST so a malformed notebook doesn't pull in nbv.js needlessly.
    var parsed = parseNotebook(source);
    if (!parsed.ok) {
      return Promise.resolve(_renderFallback(container, source, parsed.error));
    }

    return loadDependencies().then(function (ok) {
      if (!ok) throw new Error('nbviewer.js or DOMPurify unavailable after load');

      // Render into a detached scratch container so we can sanitise the
      // resulting HTML before inserting into the live DOM. nbv.render()
      // mutates the container directly, so this is the only way to keep
      // its output behind the DOMPurify boundary.
      var scratch = document.createElement('div');
      try {
        window.nbv.render(parsed.notebook, scratch);
      } catch (err) {
        throw new Error('nbv.render failed: ' + (err && err.message ? err.message : 'unknown'));
      }

      var safeHtml = window.DOMPurify.sanitize(scratch.innerHTML, SANITIZE_CONFIG);

      while (container.firstChild) container.removeChild(container.firstChild);
      var wrapper = document.createElement('div');
      wrapper.className = 'fb-notebook-rendered';
      wrapper.innerHTML = safeHtml;
      container.appendChild(wrapper);

      return {
        wrapper: wrapper,
        teardown: function () {
          // Caller owns container removal; we just clear our wrapper if it
          // still belongs to it.
          if (wrapper.parentNode === container) {
            container.removeChild(wrapper);
          }
        },
      };
    }).catch(function (err) {
      return _renderFallback(container, source, err && err.message ? err.message : 'render failed');
    });
  }

  // Hard-failure fallback: render the notebook source as pretty-printed
  // JSON so the user can still read the file. Mirrors markdown-render.js's
  // .fb-md-fallback pattern.
  function _renderFallback(container, source, reason) {
    while (container.firstChild) container.removeChild(container.firstChild);
    var fallback = document.createElement('div');
    fallback.className = 'fb-nb-fallback';

    var msg = document.createElement('div');
    msg.className = 'fb-md-feature-unavailable';
    msg.textContent = 'Notebook viewer unavailable (' + (reason || 'unknown') +
      '); showing raw source.';
    fallback.appendChild(msg);

    var pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;' +
      'font-family:var(--font-mono);font-size:12px;margin:0;padding:8px';

    // Pretty-print JSON when we can; otherwise dump verbatim.
    var src = source == null ? '' : (typeof source === 'string' ? source : '');
    try {
      if (src) pre.textContent = JSON.stringify(JSON.parse(src), null, 2);
      else if (typeof source === 'object') pre.textContent = JSON.stringify(source, null, 2);
      else pre.textContent = String(source);
    } catch (_) {
      pre.textContent = src || '';
    }
    fallback.appendChild(pre);
    container.appendChild(fallback);
    return { wrapper: fallback, teardown: function () {} };
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var exportsObj = {
    renderInto: renderInto,
    loadDependencies: loadDependencies,
    parseNotebook: parseNotebook,
    NBV_CDN: NBV_CDN,
    SANITIZE_CONFIG: SANITIZE_CONFIG,
  };

  window.notebookRender = exportsObj;
  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
})();
