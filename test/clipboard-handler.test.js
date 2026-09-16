const assert = require('assert');
const { normalizeLineEndings, wrapBracketedPaste, attachClipboardHandler, copySelectionKeepOnFailure } = require('../src/public/clipboard-handler');

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

  describe('copySelectionKeepOnFailure', function () {
    function fakeTerminal() {
      return { cleared: 0, clearSelection() { this.cleared++; } };
    }

    async function withNavigator(nav, fn) {
      const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      try {
        Object.defineProperty(globalThis, 'navigator', { value: nav, writable: true, configurable: true });
        await fn();
      } finally {
        try {
          if (desc) Object.defineProperty(globalThis, 'navigator', desc);
          else delete globalThis.navigator;
        } catch (_) { /* ignore */ }
      }
    }

    it('clears selection only after a successful write', async function () {
      const term = fakeTerminal();
      await withNavigator({ clipboard: { writeText: async () => {} } }, async () => {
        const ok = await copySelectionKeepOnFailure(term, 'hello');
        assert.strictEqual(ok, true);
        assert.strictEqual(term.cleared, 1);
      });
    });

    it('keeps selection when the write rejects', async function () {
      const term = fakeTerminal();
      await withNavigator({ clipboard: { writeText: async () => { throw new Error('denied'); } } }, async () => {
        const ok = await copySelectionKeepOnFailure(term, 'hello');
        assert.strictEqual(ok, false);
        assert.strictEqual(term.cleared, 0);
      });
    });

    it('keeps selection when the clipboard API is missing (insecure http)', async function () {
      const term = fakeTerminal();
      await withNavigator({}, async () => {
        const ok = await copySelectionKeepOnFailure(term, 'hello');
        assert.strictEqual(ok, false);
        assert.strictEqual(term.cleared, 0);
      });
    });
  });

  describe('attachClipboardHandler key routing', function () {
    function setup(selection, writeImpl) {
      let handler = null;
      const writes = [];
      const term = {
        hasSelection: () => selection !== null,
        getSelection: () => selection,
        cleared: 0,
        clearSelection() { this.cleared++; },
        attachCustomKeyEventHandler(h) { handler = h; },
      };
      const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: async (t) => { writes.push(t); if (writeImpl) await writeImpl(t); } } },
        writable: true,
        configurable: true,
      });
      attachClipboardHandler(term, () => {});
      return { handler, term, writes, restore: () => {
        try {
          if (desc) Object.defineProperty(globalThis, 'navigator', desc);
          else delete globalThis.navigator;
        } catch (_) { /* ignore */ }
      } };
    }

    it('Ctrl+C with selection returns false (suppress SIGINT), clears on success', async function () {
      const s = setup('sel-text');
      const ret = s.handler({ type: 'keydown', key: 'c', ctrlKey: true, shiftKey: false });
      assert.strictEqual(ret, false);
      await new Promise((r) => setTimeout(r, 10));
      assert.deepStrictEqual(s.writes, ['sel-text']);
      assert.strictEqual(s.term.cleared, 1);
      s.restore();
    });

    it('Ctrl+C with selection returns false and keeps selection on failure (no SIGINT)', async function () {
      const s = setup('sel-text', async () => { throw new Error('denied'); });
      const ret = s.handler({ type: 'keydown', key: 'c', ctrlKey: true, shiftKey: false });
      assert.strictEqual(ret, false);
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(s.term.cleared, 0);
      s.restore();
    });

    it('Ctrl+C without selection returns true (SIGINT path)', function () {
      const s = setup(null);
      const ret = s.handler({ type: 'keydown', key: 'c', ctrlKey: true, shiftKey: false });
      assert.strictEqual(ret, true);
      assert.deepStrictEqual(s.writes, []);
      s.restore();
    });

    it('Ctrl+Shift+C never sends SIGINT and returns false', function () {
      const s = setup(null);
      const ret = s.handler({ type: 'keydown', key: 'C', ctrlKey: true, shiftKey: true });
      assert.strictEqual(ret, false);
      s.restore();
    });

    it('non-keydown events fall through', function () {
      const s = setup('x');
      const ret = s.handler({ type: 'keyup', key: 'c', ctrlKey: true, shiftKey: false });
      assert.strictEqual(ret, true);
      s.restore();
    });
  });
});
