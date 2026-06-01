// generic-drop-handler.js — Part D of the file-browser-v2 iteration.
//
// Sibling to image-handler.js — DO NOT rename or modify the image flow.
// Adversarial review (codex) flagged a rename as unjustified blast radius
// and the image flow just shipped. Instead, this module owns the
// non-image drop pipeline and a tiny MIME-dispatch helper that lets
// app.js route incoming drops to the right handler.
//
// Wire shape (from app.js):
//   attachGenericDropHandler({
//     containerEl,        // terminal container; the drop target
//     getWorkingDir,      // () => string  — for the upload target dir
//     getAuthToken,       // () => string|null  (optional)
//     onImageDrop,        // (FileList) => void  — delegates to attachImageHandler
//     uploadImpl,         // (targetPath, File, { signal }) => Promise<Response>
//                         //   default: POST /api/files/upload (base64 JSON)
//     injectAtPath,       // (string) => void  — write `@<path>` to terminal
//     onError,            // (basename, message) => void  — toast hook
//     fetchImpl,          // (url, opts) => Promise<Response>  (test seam)
//   })
//   → returns { cancelInFlight() }
//
// Behaviour (per docs/specs/file-browser.md "Generic file drop"):
//   - image/* → onImageDrop callback (delegates to attachImageHandler).
//   - other  → upload to <workingDir>/.claude-attachments/<uuid>-<basename>;
//              on success inject `@<absolute-path>` (Claude-native syntax,
//              avoids shell-quoting hazards).
//   - Multi-file drop: hard cap MAX_FILES_PER_DROP=10; uploads MAX_PARALLEL_UPLOADS=4
//     in flight at a time via a small worker queue (Promise.allSettled).
//   - Per-file failure → onError(basename, message); only successful
//     paths are injected.
//   - Cancel: returned controller's cancelInFlight() aborts in-flight
//     uploads via AbortController.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var MAX_FILES_PER_DROP = 10;
  var MAX_PARALLEL_UPLOADS = 4;
  var ATTACHMENTS_DIRNAME = '.claude-attachments';
  var UPLOAD_ENDPOINT = '/api/files/upload';

  // ---------------------------------------------------------------------------
  // Pure helpers (testable under Node)
  // ---------------------------------------------------------------------------

  function isImageMime(file) {
    if (!file || typeof file.type !== 'string' || !file.type) return false;
    return file.type.indexOf('image/') === 0;
  }

  // Strip path separators + control chars; truncate to leave room for a
  // UUID prefix in the final filename. Falls back to "file" so the
  // upload always has *something* to write.
  function sanitizeBasename(name) {
    if (typeof name !== 'string') return 'file';
    // Strip leading dirs, then drop separators / control chars.
    var s = name.replace(/.*[/\\]/, '');
    s = s.replace(/[\x00-\x1f\x7f]/g, '');
    s = s.trim();
    if (!s) return 'file';
    if (s.length > 200) s = s.slice(0, 200);
    return s;
  }

  // `@<path>` is Claude's native file-reference syntax. Quoting is
  // unnecessary because the surrounding bracketed paste in app.js wraps
  // the whole payload — the CLI parses `@<path>` with the trailing
  // whitespace as the boundary, whitespace inside the path included.
  function buildAtPathInjection(absPath) {
    if (typeof absPath !== 'string' || !absPath) return '';
    return '@' + absPath;
  }

  // Build the upload target path: <workingDir>/.claude-attachments/<uuid>-<basename>.
  // Uses POSIX joins (the server normalises). UUID is supplied so the
  // function stays pure / deterministic for tests.
  function buildAttachmentTarget(workingDir, basename, uuid) {
    var clean = sanitizeBasename(basename);
    var dir = (workingDir || '').replace(/[\\/]+$/, '');
    // Honour the dominant separator in workingDir for visual fidelity in
    // the UI; the server normalises back-slashes regardless.
    var sep = (dir.indexOf('\\') !== -1 && dir.indexOf('/') === -1) ? '\\' : '/';
    return dir + sep + ATTACHMENTS_DIRNAME + sep + uuid + '-' + clean;
  }

  // Crude UUIDish — `crypto.randomUUID()` would be nicer but isn't
  // present in older browsers / JSDOM without polyfill. 16 hex chars is
  // plenty of entropy for collision-avoidance in a per-session attachments
  // directory.
  function _shortId() {
    var hex = '';
    for (var i = 0; i < 4; i++) {
      hex += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
    }
    return hex.slice(0, 16);
  }

  // Read a File into base64. Used by the default uploadImpl to build the
  // upload JSON payload (matches POST /api/files/upload's existing
  // contract from the image-paste flow).
  function _fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      if (typeof FileReader === 'undefined') {
        reject(new Error('FileReader not supported'));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        var s = String(reader.result || '');
        var comma = s.indexOf(',');
        // result is `data:<mime>;base64,<payload>` — strip the prefix.
        resolve(comma !== -1 ? s.slice(comma + 1) : s);
      };
      reader.onerror = function () { reject(reader.error || new Error('read failed')); };
      reader.readAsDataURL(file);
    });
  }

  // ---------------------------------------------------------------------------
  // attachGenericDropHandler — the wired entry point (browser-only)
  // ---------------------------------------------------------------------------

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        isImageMime: isImageMime,
        sanitizeBasename: sanitizeBasename,
        buildAtPathInjection: buildAtPathInjection,
        buildAttachmentTarget: buildAttachmentTarget,
        MAX_FILES_PER_DROP: MAX_FILES_PER_DROP,
        MAX_PARALLEL_UPLOADS: MAX_PARALLEL_UPLOADS,
        ATTACHMENTS_DIRNAME: ATTACHMENTS_DIRNAME,
        UPLOAD_ENDPOINT: UPLOAD_ENDPOINT,
      };
    }
    return;
  }

  function attachGenericDropHandler(opts) {
    opts = opts || {};
    if (!opts.containerEl) throw new Error('attachGenericDropHandler: containerEl required');

    var containerEl = opts.containerEl;
    var getWorkingDir = typeof opts.getWorkingDir === 'function'
      ? opts.getWorkingDir : function () { return null; };
    var getAuthToken = typeof opts.getAuthToken === 'function'
      ? opts.getAuthToken : function () { return null; };
    var onImageDrop = typeof opts.onImageDrop === 'function'
      ? opts.onImageDrop : function () {};
    var injectAtPath = typeof opts.injectAtPath === 'function'
      ? opts.injectAtPath : function () {};
    var onError = typeof opts.onError === 'function'
      ? opts.onError : function (basename, msg) {
        if (window.feedback && typeof window.feedback.error === 'function') {
          window.feedback.error(basename + ': ' + msg);
        }
      };
    var fetchImpl = typeof opts.fetchImpl === 'function'
      ? opts.fetchImpl : function (u, o) { return window.fetch(u, o); };
    var uploadImpl = typeof opts.uploadImpl === 'function'
      ? opts.uploadImpl
      : function (targetPath, file, fetchOpts) {
          // Default: base64 JSON to /api/files/upload. Mirrors the image
          // flow's wire contract (server already enforces 10MB cap,
          // blocked-extension list, sanitisation, and validatePath()).
          //
          // FIELD NAME: server reads `content` (src/server.js:2271 →
          // `const { targetDir, fileName, content, overwrite } = req.body`).
          // An earlier draft sent `base64` here and 400-d every drop in
          // production — caught by QA E2E (#5). The unit-test path
          // missed it because it injected a custom uploadImpl; the
          // default-uploadImpl wire-contract test in
          // test/generic-drop-handler.test.js is the regression guard.
          return _fileToBase64(file).then(function (base64) {
            var token = getAuthToken();
            var url = UPLOAD_ENDPOINT;
            if (token) url += '?token=' + encodeURIComponent(token);
            return fetchImpl(url, Object.assign({
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                targetDir: targetPath.replace(/[\\/][^\\/]*$/, ''),
                fileName: targetPath.replace(/.*[\\/]/, ''),
                content: base64,
              }),
            }, fetchOpts || {}));
          });
        };

    // In-flight upload tracker so cancelInFlight() can abort everything
    // that's currently uploading. Each entry: { ctrl: AbortController }.
    var inFlight = new Set();

    function cancelInFlight() {
      var copy = Array.from(inFlight);
      copy.forEach(function (entry) {
        try { entry.ctrl.abort(); } catch (_) { /* ignore */ }
      });
      inFlight.clear();
    }

    function uploadOne(file) {
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var entry = { ctrl: ctrl };
      if (ctrl) inFlight.add(entry);

      var workingDir = getWorkingDir();
      if (!workingDir) {
        if (ctrl) inFlight.delete(entry);
        onError(file.name, 'no working directory');
        return Promise.resolve({ ok: false, file: file });
      }

      var targetPath = buildAttachmentTarget(workingDir, file.name, _shortId());
      var fetchOpts = ctrl ? { signal: ctrl.signal } : {};
      return uploadImpl(targetPath, file, fetchOpts).then(function (resp) {
        if (ctrl) inFlight.delete(entry);
        if (!resp || !resp.ok) {
          var status = resp ? resp.status : 'no response';
          var msg = 'upload failed (' + status + ')';
          // Try to surface server-side error message.
          if (resp && typeof resp.json === 'function') {
            return resp.json().then(function (data) {
              if (data && data.error) msg = data.error;
              onError(file.name, msg);
              return { ok: false, file: file };
            }, function () {
              onError(file.name, msg);
              return { ok: false, file: file };
            });
          }
          onError(file.name, msg);
          return { ok: false, file: file };
        }
        // Resolve the canonical absolute path. Server's response carries
        // the resolved path; fall back to our requested target if the
        // wire shape changes upstream.
        if (typeof resp.json === 'function') {
          return resp.json().then(function (data) {
            var abs = (data && typeof data.path === 'string') ? data.path : targetPath;
            return { ok: true, file: file, path: abs };
          }, function () {
            return { ok: true, file: file, path: targetPath };
          });
        }
        return { ok: true, file: file, path: targetPath };
      }).catch(function (err) {
        if (ctrl) inFlight.delete(entry);
        // AbortError → user cancelled; don't toast it.
        if (err && (err.name === 'AbortError' || err.code === 20)) {
          return { ok: false, file: file, aborted: true };
        }
        onError(file.name, (err && err.message) ? err.message : 'upload error');
        return { ok: false, file: file };
      });
    }

    // Bounded-parallel worker queue. Up to MAX_PARALLEL_UPLOADS in flight
    // at a time; subsequent files start as soon as a slot frees up.
    function runQueue(files, onResult) {
      var idx = 0;
      var done = 0;
      var results = [];
      return new Promise(function (resolve) {
        function next() {
          if (idx >= files.length && done >= files.length) { resolve(results); return; }
          while (idx < files.length && (idx - done) < MAX_PARALLEL_UPLOADS) {
            (function (file, slot) {
              uploadOne(file).then(function (r) {
                results[slot] = r;
                done++;
                if (onResult) onResult(r, slot);
                next();
              });
            }(files[idx], idx));
            idx++;
          }
        }
        next();
      });
    }

    function dispatchDrop(files) {
      // Partition by MIME — image/* always go to the image handler, the
      // rest go through the generic pipeline.
      var imageFiles = [];
      var genericFiles = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (isImageMime(f)) imageFiles.push(f);
        else genericFiles.push(f);
      }
      if (imageFiles.length) {
        try { onImageDrop(imageFiles); } catch (_) { /* best-effort */ }
      }
      if (!genericFiles.length) return;

      // Cap at MAX_FILES_PER_DROP — guard against accidentally dropping
      // a folder of thousands.
      if (genericFiles.length > MAX_FILES_PER_DROP) {
        onError('multi-file drop',
          'too many files (' + genericFiles.length + '); first ' +
          MAX_FILES_PER_DROP + ' will upload');
        genericFiles = genericFiles.slice(0, MAX_FILES_PER_DROP);
      }

      runQueue(genericFiles, function (r) {
        if (r && r.ok && r.path) {
          try { injectAtPath(buildAtPathInjection(r.path)); } catch (_) {}
        }
      });
    }

    function onDrop(e) {
      // Only fire for drops that carry files; otherwise let xterm / the
      // image handler do their thing.
      var dt = e.dataTransfer;
      if (!dt) return;
      var files = dt.files;
      if (!files || !files.length) return;
      // Has at least one non-image file → we own the event. (We still
      // route image files through our dispatch so onImageDrop fires.)
      var hasGeneric = false;
      for (var i = 0; i < files.length; i++) {
        if (!isImageMime(files[i])) { hasGeneric = true; break; }
      }
      // If the drop is image-only, defer to image-handler.js entirely
      // (don't preventDefault — let its own listener run).
      if (!hasGeneric) {
        try { onImageDrop(files); } catch (_) {}
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      dispatchDrop(files);
    }

    // Capture phase so we run before xterm's drop handler (which would
    // otherwise treat the dropped file's name as paste text).
    containerEl.addEventListener('drop', onDrop, true);

    // dragover preventDefault is required for the drop event to fire at all.
    function onDragOver(e) {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.length) {
        // Only prevent default if the drag carries Files — otherwise we'd
        // hijack text selection drags.
        for (var i = 0; i < e.dataTransfer.types.length; i++) {
          if (e.dataTransfer.types[i] === 'Files') { e.preventDefault(); return; }
        }
      }
    }
    containerEl.addEventListener('dragover', onDragOver, true);

    function destroy() {
      try { containerEl.removeEventListener('drop', onDrop, true); } catch (_) {}
      try { containerEl.removeEventListener('dragover', onDragOver, true); } catch (_) {}
      cancelInFlight();
    }

    return {
      cancelInFlight: cancelInFlight,
      destroy: destroy,
      // Public entry point so non-drop surfaces (attach button, paste) can
      // route a FileList/array of File objects through the EXACT same pipeline:
      // image/* → onImageDrop, everything else → upload + @path inject, with the
      // same MAX_FILES_PER_DROP cap and bounded-parallel queue.
      dispatchFiles: dispatchDrop,
    };
  }

  // ---------------------------------------------------------------------------
  // triggerFilePicker — open a hidden <input type="file"> with NO accept filter
  // (any file type), used by the attach button / context menu. Mirrors
  // image-handler.js's picker minus the image-only constraint. Resolves the
  // selected files via the onFiles callback. Browser-only.
  // ---------------------------------------------------------------------------
  function triggerFilePicker(onFiles, opts) {
    if (typeof document === 'undefined') return;
    opts = opts || {};
    var input = document.createElement('input');
    input.type = 'file';
    if (opts.multiple) input.multiple = true;
    input.style.display = 'none';

    function cleanup() {
      if (input.parentNode) input.parentNode.removeChild(input);
    }
    input.addEventListener('change', function () {
      var files = input.files ? Array.prototype.slice.call(input.files) : [];
      if (files.length && typeof onFiles === 'function') onFiles(files);
      cleanup();
    });
    // Safety net: if the dialog is cancelled, no change fires — sweep the
    // detached node shortly after to avoid leaking it.
    document.body.appendChild(input);
    input.click();
    setTimeout(cleanup, 60000);
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  var exportsObj = {
    attachGenericDropHandler: attachGenericDropHandler,
    triggerFilePicker: triggerFilePicker,
    isImageMime: isImageMime,
    sanitizeBasename: sanitizeBasename,
    buildAtPathInjection: buildAtPathInjection,
    buildAttachmentTarget: buildAttachmentTarget,
    MAX_FILES_PER_DROP: MAX_FILES_PER_DROP,
    MAX_PARALLEL_UPLOADS: MAX_PARALLEL_UPLOADS,
    ATTACHMENTS_DIRNAME: ATTACHMENTS_DIRNAME,
    UPLOAD_ENDPOINT: UPLOAD_ENDPOINT,
  };

  window.genericDropHandler = exportsObj;
  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
})();
