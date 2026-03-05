'use strict';

const assert = require('assert');
const {
  stripAnsi,
  cleanControl,
  isMeaningfulInput,
  extractActivitySnippet,
  detectCompletionMetadata,
  redactSecrets,
} = require('../src/utils/ansi-utils');

describe('ansi-utils', () => {
  describe('stripAnsi', () => {
    it('should return empty string for falsy input', () => {
      assert.strictEqual(stripAnsi(''), '');
      assert.strictEqual(stripAnsi(null), '');
      assert.strictEqual(stripAnsi(undefined), '');
    });

    it('should strip CSI sequences (colors, cursor)', () => {
      assert.strictEqual(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
      assert.strictEqual(stripAnsi('\x1b[1;32mbold green\x1b[0m'), 'bold green');
    });

    it('should strip OSC sequences (window title, hyperlinks)', () => {
      assert.strictEqual(stripAnsi('\x1b]0;My Title\x07text'), 'text');
      // OSC hyperlink with BEL terminator
      assert.strictEqual(stripAnsi('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'), 'link');
    });

    it('should strip single-character ESC sequences', () => {
      assert.strictEqual(stripAnsi('\x1bMhello'), 'hello');
    });

    it('should handle mixed sequences in a single pass', () => {
      const input = '\x1b]0;title\x07\x1b[32mgreen \x1bMtext\x1b[0m';
      assert.strictEqual(stripAnsi(input), 'green text');
    });

    it('should preserve plain text', () => {
      assert.strictEqual(stripAnsi('hello world'), 'hello world');
    });
  });

  describe('cleanControl', () => {
    it('should normalize \\r to \\n and strip control chars', () => {
      assert.strictEqual(cleanControl('hello\r\nworld'), 'hello\n\nworld');
      assert.strictEqual(cleanControl('hello\rworld'), 'hello\nworld');
      // \x00 and \x08 are control chars that get stripped; 'a', 'b', 'c' remain
      assert.strictEqual(cleanControl('a\x00b\x08c'), 'abc');
    });

    it('should trim whitespace', () => {
      assert.strictEqual(cleanControl('  hello  '), 'hello');
    });

    it('should return empty string for falsy input', () => {
      assert.strictEqual(cleanControl(''), '');
      assert.strictEqual(cleanControl(null), '');
    });
  });

  describe('isMeaningfulInput', () => {
    it('should return false for empty/null/undefined', () => {
      assert.strictEqual(isMeaningfulInput(''), false);
      assert.strictEqual(isMeaningfulInput(null), false);
      assert.strictEqual(isMeaningfulInput(undefined), false);
    });

    it('should return false for control-only input', () => {
      assert.strictEqual(isMeaningfulInput('\x1b[A'), false);
      assert.strictEqual(isMeaningfulInput('\r\n'), false);
      assert.strictEqual(isMeaningfulInput('\x00\x01'), false);
    });

    it('should return true for text input', () => {
      assert.strictEqual(isMeaningfulInput('hello'), true);
      assert.strictEqual(isMeaningfulInput('y'), true);
    });

    it('should return true for text mixed with ANSI', () => {
      assert.strictEqual(isMeaningfulInput('\x1b[32myes\x1b[0m'), true);
    });

    it('should return false for non-string input', () => {
      assert.strictEqual(isMeaningfulInput(42), false);
      assert.strictEqual(isMeaningfulInput({}), false);
    });
  });

  describe('extractActivitySnippet', () => {
    it('should return the last non-empty line, trimmed and collapsed', () => {
      assert.strictEqual(extractActivitySnippet('line1\nline2\n  line3  '), 'line3');
    });

    it('should collapse whitespace', () => {
      assert.strictEqual(extractActivitySnippet('hello   world'), 'hello world');
    });

    it('should truncate to 180 characters', () => {
      const long = 'x'.repeat(200);
      assert.strictEqual(extractActivitySnippet(long).length, 180);
    });

    it('should return empty string for blank input', () => {
      assert.strictEqual(extractActivitySnippet(''), '');
      assert.strictEqual(extractActivitySnippet('\n\n\n'), '');
    });

    it('should skip blank lines', () => {
      assert.strictEqual(extractActivitySnippet('first\n\n\nlast'), 'last');
    });
  });

  describe('detectCompletionMetadata', () => {
    it('should detect "tests passed" as success', () => {
      const result = detectCompletionMetadata('All tests passed');
      assert.deepStrictEqual(result, { kind: 'success', label: 'Tests passed' });
    });

    it('should detect "build successful" as success', () => {
      const result = detectCompletionMetadata('Build successful');
      assert.deepStrictEqual(result, { kind: 'success', label: 'Build completed' });
    });

    it('should detect "Done in Xs" as success', () => {
      const result = detectCompletionMetadata('Done in 3.5s');
      assert.deepStrictEqual(result, { kind: 'success', label: 'Task completed' });
    });

    it('should detect "tests failed" as error', () => {
      const result = detectCompletionMetadata('3 tests failed');
      assert.deepStrictEqual(result, { kind: 'error', label: 'Tests failed' });
    });

    it('should detect "build failed" as error', () => {
      const result = detectCompletionMetadata('build failed with errors');
      assert.deepStrictEqual(result, { kind: 'error', label: 'Build failed' });
    });

    it('should detect "FAIL" as error', () => {
      const result = detectCompletionMetadata('FAIL src/test.js');
      assert.deepStrictEqual(result, { kind: 'error', label: 'Tests failed' });
    });

    it('should return null for non-matching output', () => {
      assert.strictEqual(detectCompletionMetadata('compiling...'), null);
      assert.strictEqual(detectCompletionMetadata('running tests'), null);
    });

    it('should return null for empty/null input', () => {
      assert.strictEqual(detectCompletionMetadata(''), null);
      assert.strictEqual(detectCompletionMetadata(null), null);
    });

    it('should be case insensitive', () => {
      const result = detectCompletionMetadata('BUILD SUCCESSFUL');
      assert.deepStrictEqual(result, { kind: 'success', label: 'Build completed' });
    });
  });

  describe('redactSecrets', () => {
    it('should redact password= patterns', () => {
      assert.strictEqual(redactSecrets('password=hunter2'), 'password=[REDACTED]');
      assert.strictEqual(redactSecrets('PASSWORD=abc123'), 'PASSWORD=[REDACTED]');
    });

    it('should redact token= patterns', () => {
      assert.strictEqual(redactSecrets('token=abc123xyz'), 'token=[REDACTED]');
    });

    it('should redact api_key= patterns', () => {
      assert.strictEqual(redactSecrets('api_key=sk-1234'), 'api_key=[REDACTED]');
    });

    it('should redact secret: patterns (colon separator)', () => {
      assert.strictEqual(redactSecrets('secret: mysecret'), 'secret=[REDACTED]');
    });

    it('should redact bearer patterns', () => {
      assert.strictEqual(redactSecrets('bearer=eyJ0...'), 'bearer=[REDACTED]');
    });

    it('should handle multiple secrets in one string', () => {
      const input = 'password=abc token=xyz';
      const result = redactSecrets(input);
      assert.ok(result.includes('password=[REDACTED]'));
      assert.ok(result.includes('token=[REDACTED]'));
    });

    it('should preserve non-secret text', () => {
      assert.strictEqual(redactSecrets('hello world'), 'hello world');
    });

    it('should return falsy input as-is', () => {
      assert.strictEqual(redactSecrets(''), '');
      assert.strictEqual(redactSecrets(null), null);
    });
  });
});
