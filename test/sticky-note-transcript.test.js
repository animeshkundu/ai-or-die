'use strict';

const assert = require('assert');
const TranscriptBuffer = require('../src/sticky-note-transcript');

describe('sticky-note transcript buffer', function () {
  it('collapses carriage-return spinner redraws to the final line', async function () {
    const tb = new TranscriptBuffer();
    // A spinner that rewrites one line, clearing to EOL each time (\r + ESC[K).
    tb.write('⠋ working...');
    tb.write('\r\x1b[K⠙ working...');
    tb.write('\r\x1b[K⠹ working...');
    tb.write('\r\x1b[Kdone\r\n');
    const out = await tb.snapshot();
    assert.strictEqual(out, 'done', `expected single collapsed line, got: ${JSON.stringify(out)}`);
    assert.ok(!out.includes('working'), 'overwritten spinner text must not survive');
    tb.dispose();
  });

  it('reassembles a multi-byte UTF-8 sequence split across writes', async function () {
    const tb = new TranscriptBuffer();
    tb.write(Buffer.from([0xc3])); // first byte of 'é'
    tb.write(Buffer.from([0xa9])); // second byte of 'é'
    tb.write(' café\r\n');
    const out = await tb.snapshot();
    assert.ok(out.includes('é café'), `expected reassembled UTF-8, got: ${JSON.stringify(out)}`);
    tb.dispose();
  });

  it('returns only the last maxDeltaLines rendered lines (sliding window)', async function () {
    const tb = new TranscriptBuffer({ maxDeltaLines: 5 });
    for (let i = 1; i <= 100; i++) tb.write(`line ${i}\r\n`);
    const out = await tb.snapshot();
    const lines = out.split('\n');
    assert.strictEqual(lines.length, 5, `expected 5 lines, got ${lines.length}`);
    assert.strictEqual(lines[0], 'line 96');
    assert.strictEqual(lines[4], 'line 100');
    tb.dispose();
  });

  it('counts committed lines (LF) and resets after snapshot', async function () {
    const tb = new TranscriptBuffer();
    tb.write('a\r\nb\r\nc\r\n');
    await tb.snapshot(); // drain
    assert.strictEqual(tb.newLineCount(), 0, 'snapshot resets the line counter');
    assert.strictEqual(tb.hasNew(), false);

    tb.write('d\r\ne\r\n');
    await tb._drain();
    assert.strictEqual(tb.newLineCount(), 2);
    assert.strictEqual(tb.hasNew(), true);
    tb.dispose();
  });

  it('does NOT count carriage-return-only redraws as new lines', async function () {
    const tb = new TranscriptBuffer();
    tb.write('spin');
    tb.write('\rspin.');
    tb.write('\rspin..');
    await tb._drain();
    assert.strictEqual(tb.newLineCount(), 0, 'CR redraws are not line feeds');
    assert.strictEqual(tb.hasNew(), true, 'but there is still new output');
    tb.dispose();
  });

  it('captures a partial line with no trailing newline', async function () {
    const tb = new TranscriptBuffer();
    tb.write('in progress, no newline yet');
    const out = await tb.snapshot();
    assert.ok(out.includes('in progress, no newline yet'), out);
    tb.dispose();
  });

  it('bounds memory via scrollback (does not grow unbounded)', async function () {
    const tb = new TranscriptBuffer({ scrollback: 50, rows: 24 });
    for (let i = 0; i < 5000; i++) tb.write(`row ${i}\r\n`);
    await tb._drain();
    // buffer length = scrollback + rows at most
    assert.ok(
      tb._term.buffer.active.length <= 50 + 24 + 1,
      `buffer length ${tb._term.buffer.active.length} exceeded scrollback bound`
    );
    const out = await tb.snapshot();
    assert.ok(out.includes('row 4999'), 'most recent line still present');
    tb.dispose();
  });
});
