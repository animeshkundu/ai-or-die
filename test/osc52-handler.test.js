'use strict';

const assert = require('assert');
const {
  Osc52Parser,
  createOsc52Bridge,
  decodeBase64Utf8,
  OSC52_MAX_B64,
} = require('../src/public/osc52-handler');

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

describe('osc52-handler', function () {
  describe('decodeBase64Utf8', function () {
    it('round-trips unicode text', function () {
      assert.strictEqual(decodeBase64Utf8(b64('hello 😀 終')), 'hello 😀 終');
    });

    it('rejects invalid base64', function () {
      assert.strictEqual(decodeBase64Utf8('!!!not-base64!!!'), null);
    });

    it('rejects empty and oversized payloads', function () {
      assert.strictEqual(decodeBase64Utf8(''), null);
      assert.strictEqual(decodeBase64Utf8('A'.repeat(OSC52_MAX_B64 + 1)), null);
    });
  });

  describe('Osc52Parser', function () {
    it('extracts a BEL-terminated clipboard write', function () {
      const p = new Osc52Parser();
      const out = p.push('before\x1b]52;c;' + b64('copied text') + '\x07after');
      assert.deepStrictEqual(out, ['copied text']);
    });

    it('extracts an ESC-backslash-terminated write', function () {
      const p = new Osc52Parser();
      const out = p.push('\x1b]52;c;' + b64('esc-term') + '\x1b\\');
      assert.deepStrictEqual(out, ['esc-term']);
    });

    it('handles empty Pc as clipboard', function () {
      const p = new Osc52Parser();
      const out = p.push('\x1b]52;;' + b64('no-pc') + '\x07');
      assert.deepStrictEqual(out, ['no-pc']);
    });

    it('reassembles a sequence split across chunks', function () {
      const p = new Osc52Parser();
      const seq = '\x1b]52;c;' + b64('split-copy-payload') + '\x07';
      const cut = 10;
      assert.deepStrictEqual(p.push(seq.slice(0, cut)), []);
      assert.deepStrictEqual(p.push(seq.slice(cut)), ['split-copy-payload']);
    });

    it('reassembles a split inside the base64 payload', function () {
      const p = new Osc52Parser();
      const payload = b64('payload-split-in-the-middle-0123456789');
      const seq = '\x1b]52;c;' + payload + '\x07';
      let out = [];
      for (let i = 0; i < seq.length; i += 5) out = out.concat(p.push(seq.slice(i, i + 5)));
      assert.deepStrictEqual(out, ['payload-split-in-the-middle-0123456789']);
    });

    it('ignores queries (never answers ?)', function () {
      const p = new Osc52Parser();
      assert.deepStrictEqual(p.push('\x1b]52;c;?\x07'), []);
    });

    it('ignores primary/secondary selections', function () {
      const p = new Osc52Parser();
      assert.deepStrictEqual(p.push('\x1b]52;p;' + b64('primary') + '\x07'), []);
      assert.deepStrictEqual(p.push('\x1b]52;s;' + b64('secondary') + '\x07'), []);
    });

    it('ignores empty data and invalid base64', function () {
      const p = new Osc52Parser();
      assert.deepStrictEqual(p.push('\x1b]52;c;\x07'), []);
      assert.deepStrictEqual(p.push('\x1b]52;c;!!!\x07'), []);
    });

    it('extracts multiple sequences in one chunk, in order', function () {
      const p = new Osc52Parser();
      const out = p.push(
        '\x1b]52;c;' + b64('first') + '\x07noise\x1b]52;c;' + b64('second') + '\x1b\\'
      );
      assert.deepStrictEqual(out, ['first', 'second']);
    });

    it('drops oversized payloads', function () {
      const p = new Osc52Parser();
      const big = 'A'.repeat(OSC52_MAX_B64 + 8);
      assert.deepStrictEqual(p.push('\x1b]52;c;' + big + '\x07'), []);
    });

    it('does not retain unbounded state on plain output', function () {
      const p = new Osc52Parser();
      p.push('x'.repeat(10000));
      assert.strictEqual(p._carry, '');
    });

    it('reset() clears a pending partial', function () {
      const p = new Osc52Parser();
      p.push('\x1b]52;c;' + b64('ab').slice(0, 2));
      p.reset();
      assert.strictEqual(p._carry, '');
      assert.deepStrictEqual(p.push('rest\x07'), []);
    });
  });

  describe('createOsc52Bridge', function () {
    it('writes decoded copies and fires onCopied', async function () {
      const written = [];
      const copied = [];
      const bridge = createOsc52Bridge({
        writeText: async (t) => { written.push(t); return true; },
        onCopied: (t) => copied.push(t),
      });
      await bridge.push('out \x1b]52;c;' + b64('from-opencode') + '\x07 more');
      assert.deepStrictEqual(written, ['from-opencode']);
      assert.deepStrictEqual(copied, ['from-opencode']);
    });

    it('fires onDenied when the write fails and keeps working', async function () {
      let denied = 0;
      const copied = [];
      const bridge = createOsc52Bridge({
        writeText: async () => false,
        onCopied: (t) => copied.push(t),
        onDenied: () => denied++,
      });
      await bridge.push('\x1b]52;c;' + b64('one') + '\x07');
      await bridge.push('\x1b]52;c;' + b64('two') + '\x07');
      assert.strictEqual(denied, 2);
      assert.deepStrictEqual(copied, []);
    });

    it('fires onDenied when the clipboard API is missing', async function () {
      let denied = 0;
      const bridge = createOsc52Bridge({
        navigator: {},
        onDenied: () => denied++,
      });
      await bridge.push('\x1b]52;c;' + b64('x') + '\x07');
      assert.strictEqual(denied, 1);
    });

    it('does nothing for output without OSC 52', async function () {
      let calls = 0;
      const bridge = createOsc52Bridge({
        writeText: async () => { calls++; return true; },
      });
      await bridge.push('\x1b[31mred\x1b[0m plain output\n');
      assert.strictEqual(calls, 0);
    });
  });
});
