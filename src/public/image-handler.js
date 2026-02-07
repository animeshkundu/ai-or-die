'use strict';

/**
 * Image paste/drop handler for Claude Code Web.
 *
 * Attaches to an xterm.js terminal and its container to intercept image
 * paste and drag-and-drop events, presenting a preview modal before
 * sending the image data upstream.
 *
 * Follows the same dual-export pattern as clipboard-handler.js:
 *   - Browser: exposes window.imageHandler
 *   - Node.js:  module.exports for unit testing
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IMAGE_MAX_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB
const ACCEPTED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// ---------------------------------------------------------------------------
// Pure utility functions
// ---------------------------------------------------------------------------

/**
 * Check whether a MIME type is in the accepted list.
 * @param {string} mimeType
 * @returns {boolean}
 */
function isAcceptedImageType(mimeType) {
  return ACCEPTED_MIME_TYPES.indexOf(mimeType) !== -1;
}

/**
 * Validate that an image's byte-size is within the allowed limit.
 * @param {number} size - Size in bytes
 * @returns {{ valid: boolean, error?: string, sizeFormatted?: string }}
 */
function validateImageSize(size) {
  if (size <= IMAGE_MAX_SIZE_BYTES) {
    return { valid: true };
  }
  var formatted = formatFileSize(size);
  return {
    valid: false,
    error: 'Image is too large (' + formatted + '). Maximum size is 4 MB.',
    sizeFormatted: formatted
  };
}

/**
 * Map a MIME type to a file extension string.
 * @param {string} mimeType
 * @returns {string|null}
 */
function mimeToExtension(mimeType) {
  var map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp'
  };
  return map[mimeType] || null;
}

/**
 * Format a byte count into a human-readable string.
 * Examples: "245 KB", "1.2 MB", "512 B"
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (bytes < 1024) {
    return bytes + ' B';
  }
  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';
  }
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' MB';
}

/**
 * Scan a ClipboardData object for the first accepted image file.
 *
 * Precedence: image takes priority over text in the clipboard. We check
 * clipboardData.files first (the direct file list), then fall back to
 * clipboardData.items (DataTransferItemList) for kind === 'file'.
 *
 * @param {DataTransfer} clipboardData
 * @returns {File|null}
 */
function detectImageInClipboard(clipboardData) {
  if (!clipboardData) return null;

  // Primary: check clipboardData.files
  if (clipboardData.files && clipboardData.files.length > 0) {
    for (var i = 0; i < clipboardData.files.length; i++) {
      if (isAcceptedImageType(clipboardData.files[i].type)) {
        return clipboardData.files[i];
      }
    }
  }

  // Fallback: check clipboardData.items for kind === 'file'
  if (clipboardData.items && clipboardData.items.length > 0) {
    for (var j = 0; j < clipboardData.items.length; j++) {
      var item = clipboardData.items[j];
      if (item.kind === 'file' && isAcceptedImageType(item.type)) {
        return item.getAsFile();
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Blob → base64
// ---------------------------------------------------------------------------

/**
 * Convert a Blob to a raw base64 string (no data-URL prefix).
 * Uses blob.arrayBuffer() when available, falls back to FileReader.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
async function blobToBase64(blob) {
  if (typeof blob.arrayBuffer === 'function') {
    var buffer = await blob.arrayBuffer();
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // FileReader fallback for older environments
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      // result is "data:<mime>;base64,<data>" — strip the prefix
      var dataUrl = reader.result;
      var base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = function () {
      reject(reader.error);
    };
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// Image preview modal
// ---------------------------------------------------------------------------

/**
 * Show a modal overlay with an image preview and optional caption field.
 *
 * The modal is created dynamically, appended to document.body, and fully
 * removed from the DOM on close. Object URLs are revoked to prevent leaks.
 *
 * @param {Blob|File} blob - The image blob to preview
 * @param {function} onConfirm - Called with { base64, mimeType, fileName, caption }
 */
function showImagePreview(blob, onConfirm) {
  var objectUrl = URL.createObjectURL(blob);
  var fileName = blob.name || 'pasted-image' + (mimeToExtension(blob.type) || '.png');
  var sizeText = formatFileSize(blob.size);

  // Validate up front
  var sizeCheck = validateImageSize(blob.size);
  var typeCheck = isAcceptedImageType(blob.type);
  var hasError = !sizeCheck.valid || !typeCheck;
  var errorMsg = '';
  if (!typeCheck) {
    errorMsg = 'Unsupported image type: ' + (blob.type || 'unknown') + '.';
  } else if (!sizeCheck.valid) {
    errorMsg = sizeCheck.error;
  }

  // Build modal DOM
  var modal = document.createElement('div');
  modal.className = 'image-preview-modal active';
  modal.id = 'imagePreviewModal';
  modal.innerHTML =
    '<div class="modal-content image-preview-content">' +
      '<div class="modal-header">' +
        '<h2>Paste Image</h2>' +
        '<button class="close-btn" id="closeImagePreviewBtn">&times;</button>' +
      '</div>' +
      '<div class="modal-body">' +
        '<div class="image-preview-container">' +
          '<img class="image-preview-thumbnail" alt="Pasted image preview">' +
        '</div>' +
        '<div class="image-preview-info">' +
          '<span class="image-preview-filename"></span>' +
          '<span class="image-preview-size"></span>' +
          '<span class="image-preview-dimensions"></span>' +
        '</div>' +
        '<div class="image-preview-caption-row">' +
          '<input type="text" class="image-preview-caption" ' +
                 'placeholder="Add a message (optional)..." autofocus>' +
        '</div>' +
        '<div class="image-preview-error" style="display:none"></div>' +
      '</div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-secondary" id="cancelImageBtn">Cancel</button>' +
        '<button class="btn btn-primary" id="sendImageBtn">' +
          '<span class="send-text">Send</span>' +
          '<span class="send-spinner" style="display:none"></span>' +
        '</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);

  // Element references
  var thumbnail = modal.querySelector('.image-preview-thumbnail');
  var filenameEl = modal.querySelector('.image-preview-filename');
  var sizeEl = modal.querySelector('.image-preview-size');
  var dimensionsEl = modal.querySelector('.image-preview-dimensions');
  var captionInput = modal.querySelector('.image-preview-caption');
  var errorEl = modal.querySelector('.image-preview-error');
  var sendBtn = modal.querySelector('#sendImageBtn');
  var sendText = modal.querySelector('.send-text');
  var sendSpinner = modal.querySelector('.send-spinner');
  var cancelBtn = modal.querySelector('#cancelImageBtn');
  var closeBtn = modal.querySelector('#closeImagePreviewBtn');

  // Set thumbnail source (object URL, not base64, for performance)
  thumbnail.src = objectUrl;

  // Populate info fields
  filenameEl.textContent = fileName;
  sizeEl.textContent = sizeText;

  // Load image to read natural dimensions
  var tempImg = new Image();
  tempImg.onload = function () {
    dimensionsEl.textContent = tempImg.naturalWidth + ' x ' + tempImg.naturalHeight + ' px';
  };
  tempImg.src = objectUrl;

  // Show validation error if any
  if (hasError) {
    errorEl.textContent = errorMsg;
    errorEl.style.display = '';
    sendBtn.disabled = true;
  }

  // Focus caption input on open
  setTimeout(function () {
    captionInput.focus();
  }, 0);

  // ------------------------------------------------------------------
  // Cleanup helper
  // ------------------------------------------------------------------
  var destroyed = false;

  function closeModal() {
    if (destroyed) return;
    destroyed = true;
    URL.revokeObjectURL(objectUrl);
    modal.removeEventListener('keydown', onKeyDown, true);
    modal.removeEventListener('mousedown', onBackdropClick);
    if (modal.parentNode) {
      modal.parentNode.removeChild(modal);
    }
  }

  // ------------------------------------------------------------------
  // Focus trap — keep Tab cycling within the modal's interactive elements
  // ------------------------------------------------------------------
  function getFocusableElements() {
    return modal.querySelectorAll(
      'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
  }

  function onKeyDown(e) {
    // Prevent Enter/Escape from bubbling to the terminal
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
    }

    if (e.key === 'Escape') {
      closeModal();
      return;
    }

    if (e.key === 'Enter' && !sendBtn.disabled) {
      sendBtn.click();
      return;
    }

    // Tab / Shift+Tab focus trap
    if (e.key === 'Tab') {
      var focusable = getFocusableElements();
      if (focusable.length === 0) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  modal.addEventListener('keydown', onKeyDown, true);

  // ------------------------------------------------------------------
  // Click outside modal content → close
  // ------------------------------------------------------------------
  function onBackdropClick(e) {
    if (e.target === modal) {
      closeModal();
    }
  }

  modal.addEventListener('mousedown', onBackdropClick);

  // ------------------------------------------------------------------
  // Button handlers
  // ------------------------------------------------------------------
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);

  sendBtn.addEventListener('click', function () {
    if (sendBtn.disabled) return;

    // Disable button and show spinner
    sendBtn.disabled = true;
    sendBtn.classList.add('loading');
    sendText.style.display = 'none';
    sendSpinner.style.display = '';

    blobToBase64(blob)
      .then(function (base64) {
        var caption = captionInput.value.trim();
        closeModal();
        if (typeof onConfirm === 'function') {
          onConfirm({
            base64: base64,
            mimeType: blob.type,
            fileName: fileName,
            caption: caption
          });
        }
      })
      .catch(function (err) {
        console.error('Failed to convert image to base64:', err);
        errorEl.textContent = 'Failed to process image. Please try again.';
        errorEl.style.display = '';
        sendBtn.disabled = false;
        sendBtn.classList.remove('loading');
        sendText.style.display = '';
        sendSpinner.style.display = 'none';
      });
  });
}

// ---------------------------------------------------------------------------
// File picker
// ---------------------------------------------------------------------------

/**
 * Open a native file picker restricted to accepted image types.
 * When a valid image is selected, the preview modal is shown.
 *
 * @param {function} onImageSelected - Passed through to showImagePreview's onConfirm
 */
function triggerFilePicker(onImageSelected) {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/webp';
  input.style.display = 'none';

  function cleanup() {
    if (input.parentNode) {
      input.parentNode.removeChild(input);
    }
    window.removeEventListener('focus', onFocusReturn);
  }

  // Handle the user selecting a file
  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (file && isAcceptedImageType(file.type)) {
      showImagePreview(file, onImageSelected);
    }
    cleanup();
  });

  // Handle cancel: when the user dismisses the native picker, focus returns
  // to the window. We use a one-shot listener with a small delay to allow
  // the change event to fire first if a file was selected.
  function onFocusReturn() {
    setTimeout(function () {
      cleanup();
    }, 300);
  }

  window.addEventListener('focus', onFocusReturn);

  document.body.appendChild(input);
  input.click();
}

// ---------------------------------------------------------------------------
// Drop zone overlay
// ---------------------------------------------------------------------------

/**
 * Create the drop-zone overlay element for a container.
 * @param {HTMLElement} containerEl
 * @returns {HTMLElement}
 */
function createDropZone(containerEl) {
  var zone = document.createElement('div');
  zone.className = 'image-drop-zone';
  zone.style.display = 'none';
  zone.innerHTML =
    '<div class="drop-zone-content">' +
      '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" ' +
           'stroke="currentColor" stroke-width="2">' +
        '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>' +
        '<polyline points="17 8 12 3 7 8"/>' +
        '<line x1="12" y1="3" x2="12" y2="15"/>' +
      '</svg>' +
      '<span>Drop image here</span>' +
    '</div>';
  containerEl.appendChild(zone);
  return zone;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Attach image paste and drag-and-drop handling to an xterm.js terminal.
 *
 * @param {Terminal} terminal  - xterm.js Terminal instance
 * @param {HTMLElement} containerEl - Container element for the terminal (drag-drop target)
 * @param {{ onImageReady: function }} options
 * @returns {{ destroy: function }}
 */
function attachImageHandler(terminal, containerEl, options) {
  if (!terminal || !containerEl || !options || typeof options.onImageReady !== 'function') {
    console.warn('attachImageHandler: missing required arguments');
    return { destroy: function () {} };
  }

  var listeners = [];
  var cleanupFns = [];

  // Helper to register event listeners and track them for cleanup
  function addListener(el, event, handler, opts) {
    el.addEventListener(event, handler, opts || false);
    listeners.push({ el: el, event: event, handler: handler, opts: opts || false });
  }

  // ------------------------------------------------------------------
  // 1. Paste interception on the terminal's textarea
  // ------------------------------------------------------------------
  // xterm.js creates its textarea asynchronously. We poll briefly to
  // find it, then attach our capture-phase paste listener.

  var pasteAttached = false;
  var pollAttempts = 0;
  var maxPollAttempts = 50; // 50 * 50ms = 2.5s
  var pollTimer = null;

  function attachPasteListener() {
    var textarea = terminal.textarea;
    if (!textarea) {
      // Also try querying the DOM directly
      var termEl = terminal.element;
      if (termEl) {
        textarea = termEl.querySelector('textarea.xterm-helper-textarea');
      }
    }

    if (textarea && !pasteAttached) {
      pasteAttached = true;

      function onPaste(e) {
        var image = detectImageInClipboard(e.clipboardData);
        if (image) {
          // Precedence: image takes priority over text in clipboard
          e.preventDefault();
          e.stopPropagation();
          showImagePreview(image, options.onImageReady);
        }
        // No image found — let the normal text paste proceed
      }

      addListener(textarea, 'paste', onPaste, { capture: true });
      return true;
    }
    return false;
  }

  if (!attachPasteListener()) {
    pollTimer = setInterval(function () {
      pollAttempts++;
      if (attachPasteListener() || pollAttempts >= maxPollAttempts) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 50);

    cleanupFns.push(function () {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    });
  }

  // ------------------------------------------------------------------
  // 2. Drag-and-drop on the container element
  // ------------------------------------------------------------------

  var dropZone = createDropZone(containerEl);
  cleanupFns.push(function () {
    if (dropZone.parentNode) {
      dropZone.parentNode.removeChild(dropZone);
    }
  });

  // Track drag enter depth so we only hide the zone when truly leaving
  var dragDepth = 0;

  function hasImageFiles(dataTransfer) {
    if (!dataTransfer || !dataTransfer.types) return false;
    // Must include Files but NOT the session drag marker
    var hasFiles = false;
    for (var i = 0; i < dataTransfer.types.length; i++) {
      if (dataTransfer.types[i] === 'Files') hasFiles = true;
      if (dataTransfer.types[i] === 'application/x-session-id') return false;
    }
    return hasFiles;
  }

  function onDragEnter(e) {
    if (!hasImageFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth++;
    if (dragDepth === 1) {
      dropZone.style.display = '';
    }
  }

  function onDragOver(e) {
    if (!hasImageFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(e) {
    if (!hasImageFiles(e.dataTransfer)) return;
    dragDepth--;
    if (dragDepth <= 0) {
      dragDepth = 0;
      dropZone.style.display = 'none';
    }
  }

  function onDrop(e) {
    e.preventDefault();
    dragDepth = 0;
    dropZone.style.display = 'none';

    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) return;

    // Find first accepted image
    for (var i = 0; i < files.length; i++) {
      if (isAcceptedImageType(files[i].type)) {
        showImagePreview(files[i], options.onImageReady);
        return;
      }
    }
  }

  addListener(containerEl, 'dragenter', onDragEnter);
  addListener(containerEl, 'dragover', onDragOver);
  addListener(containerEl, 'dragleave', onDragLeave);
  addListener(containerEl, 'drop', onDrop);

  // ------------------------------------------------------------------
  // 3. Cleanup / destroy
  // ------------------------------------------------------------------

  function destroy() {
    // Remove all tracked event listeners
    for (var i = 0; i < listeners.length; i++) {
      var l = listeners[i];
      l.el.removeEventListener(l.event, l.handler, l.opts);
    }
    listeners.length = 0;

    // Run additional cleanup functions
    for (var j = 0; j < cleanupFns.length; j++) {
      cleanupFns[j]();
    }
    cleanupFns.length = 0;
  }

  return { destroy: destroy };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

var imageHandlerExports = {
  IMAGE_MAX_SIZE_BYTES: IMAGE_MAX_SIZE_BYTES,
  ACCEPTED_MIME_TYPES: ACCEPTED_MIME_TYPES,
  isAcceptedImageType: isAcceptedImageType,
  validateImageSize: validateImageSize,
  mimeToExtension: mimeToExtension,
  formatFileSize: formatFileSize,
  detectImageInClipboard: detectImageInClipboard,
  blobToBase64: blobToBase64,
  showImagePreview: showImagePreview,
  triggerFilePicker: triggerFilePicker,
  attachImageHandler: attachImageHandler
};

// Browser: expose on window
if (typeof window !== 'undefined') {
  window.imageHandler = imageHandlerExports;
}

// Node.js: CommonJS export for unit testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = imageHandlerExports;
}
