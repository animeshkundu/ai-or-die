'use strict';

// Fix B: TranscriptBuffer.peek() is a read-only rendered-tail view used to
// repaint a tab on refresh/join. It must return the rendered screen WITHOUT
// resetting the delta counters (snapshot does reset), so it never steals lines
// from the sticky-note volume trigger.

const assert = require('assert');
const TranscriptBuffer = require('../src/sticky-note-transcript');

describe('TranscriptBuffer.peek (repaint-on-join)', function () {
  it('returns the rendered tail and does NOT reset new-output counters', async function () {
    const t = new TranscriptBuffer({ cols: 40, rows: 10 });
    t.write('alpha\r\nbravo\r\ncharlie\r\n');
    const peeked = await t.peek(5); // peek drains; counters preserved
    const before = t.newLineCount();
    assert.ok(/charlie/.test(peeked), 'peek shows rendered content');
    assert.ok(before > 0, 'lines counted after drain');
    await t.peek(5);
    assert.strictEqual(t.newLineCount(), before, 'peek leaves counters intact');
  });

  it('snapshot DOES reset counters (contrast)', async function () {
    const t = new TranscriptBuffer({ cols: 40, rows: 10 });
    t.write('one\r\ntwo\r\n');
    await t.peek(5); // drain so the LF counter is committed
    assert.ok(t.newLineCount() > 0);
    await t.snapshot(5);
    assert.strictEqual(t.newLineCount(), 0, 'snapshot consumes the delta');
  });
});
