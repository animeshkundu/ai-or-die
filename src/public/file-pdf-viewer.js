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
//   render(container, { url, fileName }) -> Promise<viewer>
//     Mounts a PDF viewer into `container`. Returns a viewer handle
//     with .destroy() for tab/preview teardown.
//
//   isAvailable() -> boolean — quick env check.

(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  // Path constants — loaded lazily, served same-origin.
  var PDFJS_URL = '/vendor/pdfjs/pdf.min.mjs';
  var PDFJS_WORKER_URL = '/vendor/pdfjs/pdf.worker.min.mjs';

  // Memoized PDF.js library load. The first viewer to mount pays the
  // cost; subsequent viewers reuse the same module instance.
  var _pdfjsPromise = null;

  function loadPdfJs() {
    if (_pdfjsPromise) return _pdfjsPromise;
    if (typeof window.import === 'function' || true) {
      // Use dynamic import. In modern browsers this resolves to the
      // ES module exports. We wrap in a function so syntax errors on
      // legacy browsers don't blow up at script-parse time.
      _pdfjsPromise = (new Function('u', 'return import(u)'))(PDFJS_URL)
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
    }
    return _pdfjsPromise;
  }

  function isAvailable() {
    // Dynamic import is required. Modern browsers all support it.
    try {
      // eslint-disable-next-line no-new-func
      return typeof (new Function('return import')) === 'function';
    } catch (_) {
      return false;
    }
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

  function render(container, options) {
    options = options || {};
    var url = options.url;
    var fileName = options.fileName || '';
    if (!container || !url) {
      return Promise.reject(new Error('container and url required'));
    }

    // Mount loading-state chrome immediately so the user sees feedback.
    var chrome = buildChrome(container, fileName);

    var pdfDoc = null;
    var currentPage = 1;
    // Scale state. `fit` recomputes scale from viewport width on each render.
    var scaleMode = 'fit';   // 'fit' | 'manual'
    var manualScale = 1.0;
    // Cap manual zoom so users can't accidentally allocate huge canvases.
    var MIN_SCALE = 0.25;
    var MAX_SCALE = 4.0;

    var renderTask = null;     // current PDF.js RenderTask, for cancellation
    var disposed = false;

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
      // Fit-to-width: scale so that page width == viewport width.
      var unscaled = page.getViewport({ scale: 1 });
      var avail = chrome.viewport.clientWidth || 600;
      // Subtract a small padding so scrollbar doesn't clip.
      var target = Math.max(120, avail - 16);
      return target / unscaled.width;
    }

    function renderPage(num) {
      if (disposed || !pdfDoc) return Promise.resolve();
      if (num < 1) num = 1;
      if (num > pdfDoc.numPages) num = pdfDoc.numPages;
      currentPage = num;

      // Cancel an in-flight render before starting a new one.
      if (renderTask && typeof renderTask.cancel === 'function') {
        try { renderTask.cancel(); } catch (_) {}
        renderTask = null;
      }

      chrome.status.style.display = '';
      chrome.status.textContent = 'Rendering page ' + num + '…';

      return pdfDoc.getPage(num).then(function (page) {
        if (disposed) return;
        var scale = effectiveScale(page);
        // Account for device pixel ratio so the canvas isn't blurry on
        // HiDPI screens; cap DPR contribution to keep memory bounded.
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

    // Keyboard nav inside the viewport.
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

    // Re-fit on container resize when in 'fit' mode.
    var resizeObs = null;
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

    var viewer = {
      destroy: function () {
        disposed = true;
        if (renderTask && typeof renderTask.cancel === 'function') {
          try { renderTask.cancel(); } catch (_) {}
        }
        if (resizeObs) {
          try { resizeObs.disconnect(); } catch (_) {}
        }
        if (pdfDoc && typeof pdfDoc.destroy === 'function') {
          try { pdfDoc.destroy(); } catch (_) {}
        }
        pdfDoc = null;
      },
      goToPage: function (n) { return renderPage(n); },
      get currentPage() { return currentPage; },
      get numPages() { return pdfDoc ? pdfDoc.numPages : 0; },
    };

    return loadPdfJs().then(function (pdfjs) {
      if (disposed) return viewer;
      // PDF.js v4 accepts either a string URL or an object with `url`/`data`.
      // We pass `{ url, withCredentials: true }` so the browser sends the
      // session cookie if any (no-op for our token-based auth, but safer).
      var loadingTask = pdfjs.getDocument({ url: url, withCredentials: true });
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
      renderError(container, err && err.message || String(err));
      throw err;
    });
  }

  window.fbPdfViewer = { render: render, isAvailable: isAvailable };
})();
