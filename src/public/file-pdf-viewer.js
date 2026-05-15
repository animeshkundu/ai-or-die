// file-pdf-viewer.js — lazy PDF.js viewer for FilePreviewPanel.
//
// Why we don't use a plain `<iframe src=".pdf">`: iOS Safari (and some
// other mobile browsers) refuse to render PDFs inline in an iframe and
// instead force a download. PDF.js parses the bytes itself and renders
// to <canvas>, which works cross-browser including iOS Safari.
//
// Bundle cost (PDF.js v4.10.38): ~344 KB (core, .min.mjs) + ~1.3 MB
// (worker, .min.mjs) on disk. Lazy-loaded — only paid when the user
// actually previews a PDF. Memoized after first load.
//
// Public API (window.fbPdfViewer):
//
//   render(container, { url, fileName }) -> viewer            (synchronous)
//     Mounts loading-state chrome IMMEDIATELY and returns a viewer handle.
//     The async load runs in the background; observe completion via
//     `viewer.ready` (a Promise resolving to the same viewer). The viewer
//     handle exposes:
//       .destroy()             — abort + tear down (works at every stage)
//       .goToPage(n)           — page navigation
//       .ready                 — Promise<viewer> resolved when page 1 paints
//       .currentPage / .numPages
//
//   canAttemptDynamicImport() -> boolean
//     Best-effort: returns true if dynamic-import SYNTAX is supported in
//     the current document (i.e., a `<script type="module">` shim was
//     installable). Does NOT guarantee that the import will actually
//     resolve at runtime — that depends on the network + worker policy.

(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  // Path constants — loaded lazily, served same-origin.
  var PDFJS_URL = '/vendor/pdfjs/pdf.min.mjs';
  var PDFJS_WORKER_URL = '/vendor/pdfjs/pdf.worker.min.mjs';

  // -------------------------------------------------------------------------
  // CSP-safe dynamic importer (peer-review MEDIUM-1 on 913bfdd)
  //
  // The previous implementation used `new Function('u','return import(u)')`
  // to defer the parse of `import(...)` past legacy browsers that would
  // otherwise crash this whole IIFE at parse time. That works, but the
  // Function constructor is treated as `eval` by CSP — adding a future
  // host-page `script-src` policy without `'unsafe-eval'` would silently
  // break PDF preview AND fall through to the iframe path that doesn't
  // work on iOS Safari, defeating the point of this whole module.
  //
  // Replacement: install a `<script type="module">` shim once, lazily, that
  // assigns a real `import(u)` thunk onto a known global. Module scripts
  // legally use top-level `import` without eval. Memoized so we install
  // exactly one shim per page-load even if many PDFs are previewed.
  // -------------------------------------------------------------------------
  var IMPORTER_GLOBAL = '__fbPdfjsImporter';
  var _importerPromise = null;
  var _importerInstallTried = false;

  function _ensureImporter() {
    if (window[IMPORTER_GLOBAL]) return Promise.resolve(window[IMPORTER_GLOBAL]);
    if (_importerPromise) return _importerPromise;
    if (_importerInstallTried) {
      // Earlier install failed (e.g., CSP rejected the inline module).
      // Don't retry — return a rejected promise so the caller can fall
      // back to the iframe path.
      return Promise.reject(new Error('PDF.js importer shim unavailable (CSP?)'));
    }
    _importerInstallTried = true;

    _importerPromise = new Promise(function (resolve, reject) {
      var script;
      var settled = false;
      function settle(fn, value) {
        if (settled) return;
        settled = true;
        fn(value);
      }

      // Inline `<script type="module">` so the browser parses `import()`
      // as a module-level expression (no eval). On all browsers that
      // support modules at all (≥2018 evergreen + iOS Safari ≥ 11),
      // dynamic import is available.
      try {
        script = document.createElement('script');
        script.type = 'module';
        script.textContent =
          "window['" + IMPORTER_GLOBAL + "']=function(u){return import(u)};" +
          "window.dispatchEvent(new Event('" + IMPORTER_GLOBAL + "-ready'));";

        function onReady() {
          window.removeEventListener(IMPORTER_GLOBAL + '-ready', onReady);
          if (window[IMPORTER_GLOBAL]) settle(resolve, window[IMPORTER_GLOBAL]);
          else settle(reject, new Error('importer shim did not assign global'));
        }
        window.addEventListener(IMPORTER_GLOBAL + '-ready', onReady);

        script.onerror = function () {
          settle(reject, new Error('importer shim script element errored'));
        };
        document.head.appendChild(script);

        // Belt-and-braces: if the event listener never fires (some CSP
        // configurations block inline module execution silently), poll
        // for the global with a short bounded timeout.
        var deadline = Date.now() + 3000;
        function poll() {
          if (settled) return;
          if (window[IMPORTER_GLOBAL]) return settle(resolve, window[IMPORTER_GLOBAL]);
          if (Date.now() > deadline) return settle(reject, new Error('importer shim install timed out'));
          setTimeout(poll, 50);
        }
        setTimeout(poll, 50);
      } catch (err) {
        settle(reject, err);
      }
    }).catch(function (err) {
      // Reset memoization so a future call can retry (e.g., after CSP
      // is relaxed at runtime, or as a "user navigated to PDF, then
      // reloaded the app" recovery).
      _importerPromise = null;
      throw err;
    });

    return _importerPromise;
  }

  /**
   * Best-effort: returns true if dynamic-import SYNTAX is supported in
   * this document (i.e., a `<script type="module">` shim is installable).
   * Does NOT guarantee that the import will actually resolve at runtime —
   * that depends on the network + worker policy. Used by callers as a
   * pre-flight check before mounting the viewer.
   *
   * (Renamed from `isAvailable()` for honesty per peer-review LOW.)
   */
  function canAttemptDynamicImport() {
    // Modules are supported in every evergreen browser since ~2018 plus
    // iOS Safari ≥ 11. Test for HTMLScriptElement.supports if available
    // (a 2021+ method), otherwise feature-detect noModule (a stable
    // proxy for module-script support).
    try {
      if (typeof HTMLScriptElement !== 'undefined' &&
          typeof HTMLScriptElement.supports === 'function') {
        return HTMLScriptElement.supports('module');
      }
      return 'noModule' in document.createElement('script');
    } catch (_) {
      return false;
    }
  }

  // Memoized PDF.js library load. The first viewer to mount pays the
  // cost; subsequent viewers reuse the same module instance.
  var _pdfjsPromise = null;

  function loadPdfJs() {
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = _ensureImporter()
      .then(function (importer) { return importer(PDFJS_URL); })
      .then(function (mod) {
        // pdfjs-dist exports as either default-namespace or named.
        var lib = mod && (mod.default || mod);
        if (!lib || typeof lib.getDocument !== 'function') {
          throw new Error('pdf.min.mjs missing getDocument export');
        }
        if (lib.GlobalWorkerOptions) {
          lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        }
        return lib;
      })
      .catch(function (err) {
        // Reset so a future render() retries (e.g., transient network).
        _pdfjsPromise = null;
        throw err;
      });
    return _pdfjsPromise;
  }

  /**
   * Build the viewer chrome (toolbar + canvas viewport).
   * Returns DOM elements for the renderer to write into.
   */
  function buildChrome(container, fileName) {
    container.innerHTML = '';
    container.classList.add('fb-pdf-viewer');

    var toolbar = document.createElement('div');
    toolbar.className = 'fb-pdf-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'PDF controls');

    function makeBtn(label, ariaLabel) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'fb-pdf-btn';
      b.textContent = label;
      b.setAttribute('aria-label', ariaLabel);
      return b;
    }

    var prevBtn = makeBtn('‹', 'Previous page');
    var pageInfo = document.createElement('span');
    pageInfo.className = 'fb-pdf-page-info';
    pageInfo.setAttribute('aria-live', 'polite');
    var nextBtn = makeBtn('›', 'Next page');

    var sep1 = document.createElement('span');
    sep1.className = 'fb-pdf-sep';

    var zoomOutBtn = makeBtn('−', 'Zoom out');
    var zoomInfo = document.createElement('span');
    zoomInfo.className = 'fb-pdf-zoom-info';
    var zoomInBtn = makeBtn('+', 'Zoom in');
    var fitBtn = makeBtn('Fit', 'Fit to width');

    toolbar.appendChild(prevBtn);
    toolbar.appendChild(pageInfo);
    toolbar.appendChild(nextBtn);
    toolbar.appendChild(sep1);
    toolbar.appendChild(zoomOutBtn);
    toolbar.appendChild(zoomInfo);
    toolbar.appendChild(zoomInBtn);
    toolbar.appendChild(fitBtn);

    var viewport = document.createElement('div');
    viewport.className = 'fb-pdf-viewport';
    viewport.setAttribute('aria-label', fileName ? ('PDF: ' + fileName) : 'PDF document');
    viewport.tabIndex = 0;

    var canvas = document.createElement('canvas');
    canvas.className = 'fb-pdf-canvas';
    viewport.appendChild(canvas);

    var status = document.createElement('div');
    status.className = 'fb-pdf-status';
    status.textContent = 'Loading PDF…';
    viewport.appendChild(status);

    container.appendChild(toolbar);
    container.appendChild(viewport);

    return {
      toolbar: toolbar,
      prevBtn: prevBtn, nextBtn: nextBtn, pageInfo: pageInfo,
      zoomOutBtn: zoomOutBtn, zoomInBtn: zoomInBtn, fitBtn: fitBtn,
      zoomInfo: zoomInfo,
      viewport: viewport, canvas: canvas, status: status,
    };
  }

  function renderError(container, message) {
    container.innerHTML = '';
    container.classList.add('fb-pdf-viewer', 'fb-pdf-error');
    var msg = document.createElement('div');
    msg.className = 'fb-preview-error';
    msg.textContent = 'PDF preview unavailable: ' + message;
    container.appendChild(msg);
  }

  /**
   * Mount a PDF viewer into `container`. SYNCHRONOUS return so the
   * caller can attach a disposer immediately and have it cancel the
   * in-flight load if the user navigates away before page 1 paints
   * (peer-review MEDIUM-2 on 913bfdd: the previous Promise-return
   * meant disposers couldn't reach the viewer until AFTER the full
   * download + parse + page-1 render had completed, wasting bandwidth
   * and CPU on rapid clicks).
   */
  function render(container, options) {
    options = options || {};
    var url = options.url;
    var fileName = options.fileName || '';
    if (!container || !url) {
      var bad = { destroy: function () {}, ready: Promise.reject(new Error('container and url required')) };
      // Swallow unhandled-rejection warning if the caller doesn't await ready.
      bad.ready.catch(function () {});
      return bad;
    }

    // Mount loading-state chrome immediately so the user sees feedback.
    var chrome = buildChrome(container, fileName);

    var pdfDoc = null;
    var loadingTask = null;        // PDF.js LoadingTask (cancellable mid-flight)
    var currentPage = 1;
    var scaleMode = 'fit';   // 'fit' | 'manual'
    var manualScale = 1.0;
    var MIN_SCALE = 0.25;
    var MAX_SCALE = 4.0;

    var renderTask = null;     // current PDF.js RenderTask, for cancellation
    var disposed = false;
    var resizeObs = null;

    function updateUi() {
      if (!pdfDoc) return;
      chrome.pageInfo.textContent = currentPage + ' / ' + pdfDoc.numPages;
      chrome.prevBtn.disabled = currentPage <= 1;
      chrome.nextBtn.disabled = currentPage >= pdfDoc.numPages;
      var s = scaleMode === 'fit' ? '(fit)' : Math.round(manualScale * 100) + '%';
      chrome.zoomInfo.textContent = s;
    }

    function effectiveScale(page) {
      if (scaleMode === 'manual') return manualScale;
      var unscaled = page.getViewport({ scale: 1 });
      var avail = chrome.viewport.clientWidth || 600;
      var target = Math.max(120, avail - 16);
      return target / unscaled.width;
    }

    function renderPage(num) {
      if (disposed || !pdfDoc) return Promise.resolve();
      if (num < 1) num = 1;
      if (num > pdfDoc.numPages) num = pdfDoc.numPages;
      currentPage = num;

      if (renderTask && typeof renderTask.cancel === 'function') {
        try { renderTask.cancel(); } catch (_) {}
        renderTask = null;
      }

      chrome.status.style.display = '';
      chrome.status.textContent = 'Rendering page ' + num + '…';

      return pdfDoc.getPage(num).then(function (page) {
        if (disposed) return;
        var scale = effectiveScale(page);
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var viewport = page.getViewport({ scale: scale * dpr });
        var canvas = chrome.canvas;
        var ctx = canvas.getContext('2d');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = Math.floor(viewport.width / dpr) + 'px';
        canvas.style.height = Math.floor(viewport.height / dpr) + 'px';

        renderTask = page.render({ canvasContext: ctx, viewport: viewport });
        return renderTask.promise.then(function () {
          renderTask = null;
          if (disposed) return;
          chrome.status.style.display = 'none';
          updateUi();
        });
      }).catch(function (err) {
        if (err && err.name === 'RenderingCancelledException') return;
        chrome.status.textContent = 'Render error: ' + (err && err.message || err);
      });
    }

    chrome.prevBtn.addEventListener('click', function () { renderPage(currentPage - 1); });
    chrome.nextBtn.addEventListener('click', function () { renderPage(currentPage + 1); });
    chrome.zoomInBtn.addEventListener('click', function () {
      scaleMode = 'manual';
      manualScale = Math.min(MAX_SCALE, manualScale * 1.25);
      renderPage(currentPage);
    });
    chrome.zoomOutBtn.addEventListener('click', function () {
      scaleMode = 'manual';
      manualScale = Math.max(MIN_SCALE, manualScale / 1.25);
      renderPage(currentPage);
    });
    chrome.fitBtn.addEventListener('click', function () {
      scaleMode = 'fit';
      renderPage(currentPage);
    });

    chrome.viewport.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        renderPage(currentPage - 1);
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        renderPage(currentPage + 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        renderPage(1);
      } else if (e.key === 'End' && pdfDoc) {
        e.preventDefault();
        renderPage(pdfDoc.numPages);
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      var resizeT = null;
      resizeObs = new ResizeObserver(function () {
        if (scaleMode !== 'fit' || !pdfDoc) return;
        clearTimeout(resizeT);
        resizeT = setTimeout(function () {
          if (!disposed) renderPage(currentPage);
        }, 100);
      });
      resizeObs.observe(chrome.viewport);
    }

    // Build the viewer handle SYNCHRONOUSLY so the caller's disposer
    // can reach it before any async work completes (peer-review MEDIUM-2).
    var viewer = {
      destroy: function () {
        if (disposed) return;
        disposed = true;
        // Cancel render task (page-1 in flight, page-N in flight).
        if (renderTask && typeof renderTask.cancel === 'function') {
          try { renderTask.cancel(); } catch (_) {}
        }
        // Cancel mid-load: PDF.js LoadingTask exposes .destroy() which
        // aborts the in-flight network fetch + parse. Without this,
        // closing the panel during the initial download still incurs
        // the full download cost.
        if (loadingTask && typeof loadingTask.destroy === 'function') {
          try { loadingTask.destroy(); } catch (_) {}
        }
        if (resizeObs) {
          try { resizeObs.disconnect(); } catch (_) {}
        }
        if (pdfDoc && typeof pdfDoc.destroy === 'function') {
          try { pdfDoc.destroy(); } catch (_) {}
        }
        pdfDoc = null;
        loadingTask = null;
      },
      goToPage: function (n) { return renderPage(n); },
      get currentPage() { return currentPage; },
      get numPages() { return pdfDoc ? pdfDoc.numPages : 0; },
      ready: null,        // assigned below
    };

    // Kick off the async load. `viewer.ready` resolves to `viewer` when
    // page 1 has rendered (or rejects with a load/render error). Returns
    // the same handle for chaining convenience.
    viewer.ready = loadPdfJs().then(function (pdfjs) {
      if (disposed) return viewer;
      // PDF.js v4 accepts either a string URL or an object with `url`/`data`.
      // We pass `withCredentials: true` so the browser sends cookies if any
      // (no-op for our token-based auth, but safer for future deployments).
      loadingTask = pdfjs.getDocument({ url: url, withCredentials: true });
      return loadingTask.promise.then(function (doc) {
        if (disposed) {
          try { doc.destroy(); } catch (_) {}
          return viewer;
        }
        pdfDoc = doc;
        chrome.status.textContent = 'Loaded ' + doc.numPages + ' page' + (doc.numPages === 1 ? '' : 's');
        updateUi();
        return renderPage(1).then(function () { return viewer; });
      });
    }).catch(function (err) {
      // Distinguish "user cancelled mid-load" (PDF.js raises errors with
      // names like 'AbortError' / 'WorkerTransport.destroy') from real
      // failures. If we destroyed the loadingTask, surface nothing — the
      // user's already gone.
      if (disposed) return viewer;
      renderError(container, err && err.message || String(err));
      throw err;
    });

    // Swallow unhandled-rejection warnings if the caller doesn't await
    // ready (most callers attach their own .catch via _activeDisposers).
    if (viewer.ready && typeof viewer.ready.catch === 'function') {
      viewer.ready.catch(function () {});
    }

    return viewer;
  }

  window.fbPdfViewer = {
    render: render,
    canAttemptDynamicImport: canAttemptDynamicImport,
    // Back-compat alias — `isAvailable` was the previous name; kept so
    // any third-party / test code still works while we migrate callers.
    isAvailable: canAttemptDynamicImport,
  };
})();
