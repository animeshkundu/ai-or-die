const assert = require('assert');
const { normalizeLineEndings, wrapBracketedPaste } = require('../src/public/clipboard-handler');

describe('clipboard-handler pure functions', function () {

  describe('normalizeLineEndings', function () {
    it('should convert \\r\\n to \\r', function () {
      assert.strictEqual(normalizeLineEndings('line1\r\nline2\r\n'), 'line1\rline2\r');
    });

    it('should convert \\n to \\r', function () {
      assert.strictEqual(normalizeLineEndings('line1\nline2\n'), 'line1\rline2\r');
    });

    it('should leave \\r unchanged', function () {
      assert.strictEqual(normalizeLineEndings('line1\rline2\r'), 'line1\rline2\r');
    });

    it('should handle mixed line endings', function () {
      assert.strictEqual(normalizeLineEndings('a\r\nb\nc\r'), 'a\rb\rc\r');
    });

    it('should handle empty string', function () {
      assert.strictEqual(normalizeLineEndings(''), '');
    });

    it('should not modify text without line endings', function () {
      assert.strictEqual(normalizeLineEndings('hello world'), 'hello world');
    });
  });

  describe('wrapBracketedPaste', function () {
    it('should wrap text with ESC[200~ and ESC[201~', function () {
      assert.strictEqual(wrapBracketedPaste('hello'), '\x1b[200~hello\x1b[201~');
    });

    it('should wrap empty string', function () {
      assert.strictEqual(wrapBracketedPaste(''), '\x1b[200~\x1b[201~');
    });

    it('should preserve existing escape sequences in text', function () {
      const text = '\x1b[31mred\x1b[0m';
      assert.strictEqual(wrapBracketedPaste(text), '\x1b[200~\x1b[31mred\x1b[0m\x1b[201~');
    });
  });
});
