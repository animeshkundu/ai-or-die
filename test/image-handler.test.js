const assert = require('assert');
const {
  isAcceptedImageType,
  validateImageSize,
  mimeToExtension,
  formatFileSize,
  detectImageInClipboard,
  IMAGE_MAX_SIZE_BYTES,
  ACCEPTED_MIME_TYPES
} = require('../src/public/image-handler');

// ---------------------------------------------------------------------------
// Mock helpers for detectImageInClipboard
// ---------------------------------------------------------------------------

function mockFile(type) {
  return { type: type, name: 'test.' + (type.split('/')[1] || 'bin') };
}

function mockItem(type) {
  return { kind: 'file', type: type, getAsFile: () => mockFile(type) };
}

function mockClipboardDataWithFiles(files) {
  return { files: files, items: [] };
}

function mockClipboardDataWithItems(items) {
  return { files: [], items: items };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('image-handler pure functions', function () {

  describe('isAcceptedImageType', function () {
    it('should accept image/png', function () {
      assert.strictEqual(isAcceptedImageType('image/png'), true);
    });

    it('should accept image/jpeg', function () {
      assert.strictEqual(isAcceptedImageType('image/jpeg'), true);
    });

    it('should accept image/gif', function () {
      assert.strictEqual(isAcceptedImageType('image/gif'), true);
    });

    it('should accept image/webp', function () {
      assert.strictEqual(isAcceptedImageType('image/webp'), true);
    });

    it('should reject image/svg+xml', function () {
      assert.strictEqual(isAcceptedImageType('image/svg+xml'), false);
    });

    it('should reject application/pdf', function () {
      assert.strictEqual(isAcceptedImageType('application/pdf'), false);
    });

    it('should reject text/plain', function () {
      assert.strictEqual(isAcceptedImageType('text/plain'), false);
    });

    it('should reject empty string', function () {
      assert.strictEqual(isAcceptedImageType(''), false);
    });

    it('should reject undefined', function () {
      assert.strictEqual(isAcceptedImageType(undefined), false);
    });
  });

  describe('validateImageSize', function () {
    it('should accept 0 bytes', function () {
      const result = validateImageSize(0);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.error, undefined);
    });

    it('should accept 1 MB', function () {
      const result = validateImageSize(1 * 1024 * 1024);
      assert.strictEqual(result.valid, true);
    });

    it('should accept exactly 4 MB', function () {
      const result = validateImageSize(4 * 1024 * 1024);
      assert.strictEqual(result.valid, true);
    });

    it('should reject 4 MB + 1 byte', function () {
      const result = validateImageSize(4 * 1024 * 1024 + 1);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error);
      assert.ok(result.sizeFormatted);
    });

    it('should return formatted size in error', function () {
      const size = 5 * 1024 * 1024; // 5 MB
      const result = validateImageSize(size);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('5 MB'));
      assert.strictEqual(result.sizeFormatted, '5 MB');
    });
  });

  describe('mimeToExtension', function () {
    it('should map image/png to .png', function () {
      assert.strictEqual(mimeToExtension('image/png'), '.png');
    });

    it('should map image/jpeg to .jpg', function () {
      assert.strictEqual(mimeToExtension('image/jpeg'), '.jpg');
    });

    it('should map image/gif to .gif', function () {
      assert.strictEqual(mimeToExtension('image/gif'), '.gif');
    });

    it('should map image/webp to .webp', function () {
      assert.strictEqual(mimeToExtension('image/webp'), '.webp');
    });

    it('should return null for unknown type', function () {
      assert.strictEqual(mimeToExtension('application/octet-stream'), null);
    });

    it('should return null for image/svg+xml', function () {
      assert.strictEqual(mimeToExtension('image/svg+xml'), null);
    });
  });

  describe('formatFileSize', function () {
    it('should format bytes', function () {
      assert.strictEqual(formatFileSize(512), '512 B');
    });

    it('should format kilobytes', function () {
      const result = formatFileSize(2048);
      assert.strictEqual(result, '2 KB');
    });

    it('should format megabytes', function () {
      const result = formatFileSize(3.5 * 1024 * 1024);
      assert.strictEqual(result, '3.5 MB');
    });

    it('should handle 0 bytes', function () {
      assert.strictEqual(formatFileSize(0), '0 B');
    });

    it('should not show trailing .0', function () {
      // 1024 bytes = exactly 1 KB, should show "1 KB" not "1.0 KB"
      assert.strictEqual(formatFileSize(1024), '1 KB');
      // 1 MB exactly
      assert.strictEqual(formatFileSize(1024 * 1024), '1 MB');
    });
  });

  describe('detectImageInClipboard', function () {
    it('should return null for null input', function () {
      assert.strictEqual(detectImageInClipboard(null), null);
    });

    it('should return null for undefined input', function () {
      assert.strictEqual(detectImageInClipboard(undefined), null);
    });

    it('should return null for empty clipboard', function () {
      const clipboard = mockClipboardDataWithFiles([]);
      assert.strictEqual(detectImageInClipboard(clipboard), null);
    });

    it('should detect image in files list', function () {
      const file = mockFile('image/png');
      const clipboard = mockClipboardDataWithFiles([file]);
      assert.strictEqual(detectImageInClipboard(clipboard), file);
    });

    it('should detect image in items list', function () {
      const item = mockItem('image/jpeg');
      const clipboard = mockClipboardDataWithItems([item]);
      const result = detectImageInClipboard(clipboard);
      assert.ok(result);
      assert.strictEqual(result.type, 'image/jpeg');
    });

    it('should reject non-image files', function () {
      const file = mockFile('text/plain');
      const clipboard = mockClipboardDataWithFiles([file]);
      assert.strictEqual(detectImageInClipboard(clipboard), null);
    });

    it('should prefer files over items', function () {
      const fileFromFiles = mockFile('image/png');
      fileFromFiles.name = 'from-files.png';
      const itemFile = mockFile('image/jpeg');
      itemFile.name = 'from-items.jpg';
      const item = { kind: 'file', type: 'image/jpeg', getAsFile: () => itemFile };

      const clipboard = {
        files: [fileFromFiles],
        items: [item]
      };

      const result = detectImageInClipboard(clipboard);
      assert.strictEqual(result.name, 'from-files.png');
    });

    it('should skip non-image files and find first image in files list', function () {
      const textFile = mockFile('text/plain');
      const imageFile = mockFile('image/gif');
      const clipboard = mockClipboardDataWithFiles([textFile, imageFile]);
      assert.strictEqual(detectImageInClipboard(clipboard), imageFile);
    });

    it('should skip non-file items in items list', function () {
      const stringItem = { kind: 'string', type: 'text/plain', getAsFile: () => null };
      const imageItem = mockItem('image/webp');
      const clipboard = mockClipboardDataWithItems([stringItem, imageItem]);
      const result = detectImageInClipboard(clipboard);
      assert.ok(result);
      assert.strictEqual(result.type, 'image/webp');
    });
  });

  describe('ACCEPTED_MIME_TYPES', function () {
    it('should not include svg', function () {
      assert.ok(!ACCEPTED_MIME_TYPES.includes('image/svg+xml'));
    });

    it('should include exactly 4 types', function () {
      assert.strictEqual(ACCEPTED_MIME_TYPES.length, 4);
    });

    it('should include png, jpeg, gif, and webp', function () {
      assert.ok(ACCEPTED_MIME_TYPES.includes('image/png'));
      assert.ok(ACCEPTED_MIME_TYPES.includes('image/jpeg'));
      assert.ok(ACCEPTED_MIME_TYPES.includes('image/gif'));
      assert.ok(ACCEPTED_MIME_TYPES.includes('image/webp'));
    });
  });

  describe('IMAGE_MAX_SIZE_BYTES', function () {
    it('should be 4 MB', function () {
      assert.strictEqual(IMAGE_MAX_SIZE_BYTES, 4 * 1024 * 1024);
    });
  });
});
