'use strict';

const assert = require('assert');
const StickyNoteSummarizer = require('../src/sticky-note-summarizer');

// ---- deterministic fake clock + injectable timers ------------------------
function tick() {
  // One setImmediate await drains the ENTIRE pending microtask queue, so a
  // microtask-only async chain (fake transcript + Promise.resolve engine)
  // completes deterministically with no real timers involved.
  return new Promise((r) => setImmediate(r));
}
async function flush() {
  for (let i = 0; i < 3; i++) await tick();
}

// Synchronous transcript stand-in (the real xterm-backed one is covered by
// test/sticky-note-transcript.test.js). Keeps scheduler tests deterministic.
class FakeTranscript {
  constructor() {
    this._buf = '';
    this._lines = 0;
    this._consumed = 0;
    this._dirty = false;
  }
  write(d) {
    const s = typeof d === 'string' ? d : String(d);
    this._buf += s;
    this._dirty = true;
    this._lines += (s.match(/\n/g) || []).length;
  }
  resize() {}
  hasNew() {
    return this._dirty;
  }
  newLineCount() {
    return this._lines - this._consumed;
  }
  async snapshot() {
    this._consumed = this._lines;
    this._dirty = false;
    return this._buf.slice(-2000);
  }
  dispose() {}
}

class FakeClock {
  constructor() {
    this.t = 0;
    this.timers = new Map();
    this.seq = 0;
  }
  now() {
    return this.t;
  }
  set(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clear(id) {
    this.timers.delete(id);
  }
  async advance(ms) {
    const target = this.t + ms;
    for (;;) {
      let pick = null;
      for (const [id, tm] of this.timers) {
        if (tm.at <= target && (!pick || tm.at < pick.tm.at)) pick = { id, tm };
      }
      if (!pick) break;
      this.timers.delete(pick.id);
      this.t = pick.tm.at;
      try {
        pick.tm.fn();
      } catch {
        /* ignore */
      }
      await flush();
    }
    this.t = target;
    await flush();
  }
}

// ---- configurable fake engine -------------------------------------------
function makeEngine() {
  const calls = [];
  const e = {
    _ready: true,
    _mode: 'auto', // 'auto' | 'hang'
    _auto: JSON.stringify({ title: 'T', goal: 'g', progress: ['p'], waitingOn: [] }),
    calls,
    isReady() {
      return e._ready;
    },
    getStatus() {
      return e._ready ? 'ready' : 'unavailable';
    },
    infer(prompt) {
      const rec = { prompt };
      calls.push(rec);
      if (e._mode === 'hang') {
        return new Promise((res, rej) => {
          rec.resolve = res;
          rec.reject = rej;
        });
      }
      return Promise.resolve(typeof e._auto === 'function' ? e._auto(prompt) : e._auto);
    },
  };
  return e;
}

function makeSummarizer(config, opts = {}) {
  const clock = new FakeClock();
  const engine = makeEngine();
  const results = [];
  const sum = new StickyNoteSummarizer({
    engine,
    redact: opts.redact || ((s) => s),
    onResult: (sessionId, payload) => results.push(Object.assign({ sessionId }, payload)),
    getForeground: opts.getForeground || (() => null),
    now: () => clock.now(),
    timers: { set: (fn, ms) => clock.set(fn, ms), clear: (id) => clock.clear(id) },
    createTranscript: () => new FakeTranscript(),
    config,
  });
  return { sum, engine, clock, results };
}

const FAST = {
  quietMs: 100,
  volumeLines: 1000,
  maxStaleMs: 100000,
  minIntervalMs: 1000,
  intervalFactor: 3,
  inferTimeoutMs: 100000,
  failureThreshold: 2,
  cooldownMs: 5000,
};

describe('sticky-note summarizer scheduler', function () {
  it('quiet trigger produces a summary after the debounce', async function () {
    const { sum, engine, clock, results } = makeSummarizer(FAST);
    sum.enable('s1');
    sum.feed('s1', 'building the project\r\n');
    assert.strictEqual(engine.calls.length, 0, 'no inference before quiet');
    await clock.advance(100);
    assert.strictEqual(engine.calls.length, 1, 'one inference after quiet');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].note.title, 'T');
    assert.strictEqual(results[0].rev, 1);
    assert.strictEqual(results[0].autoTitle, 'T');
  });

  it('does nothing when there is no new output', async function () {
    const { sum, engine, clock } = makeSummarizer(FAST);
    sum.enable('s1');
    await clock.advance(100000); // no feed -> no timers armed
    assert.strictEqual(engine.calls.length, 0);

    sum.feed('s1', 'x\r\n');
    await clock.advance(100); // first summary
    assert.strictEqual(engine.calls.length, 1);
    await clock.advance(100000); // nothing new -> no second summary
    assert.strictEqual(engine.calls.length, 1);
  });

  it('volume trigger fires without waiting for quiet', async function () {
    const { sum, engine, clock, results } = makeSummarizer(
      Object.assign({}, FAST, { volumeLines: 5, quietMs: 100000 })
    );
    sum.enable('s1');
    for (let i = 0; i < 5; i++) sum.feed('s1', `line ${i}\r\n`);
    await flush(); // volume calls _run synchronously inside feed; let it settle
    assert.strictEqual(engine.calls.length, 1, 'volume should trigger immediately');
    assert.strictEqual(results.length, 1);
  });

  it('max-staleness backstop fires for a slow drizzle', async function () {
    const { sum, engine, clock } = makeSummarizer(
      Object.assign({}, FAST, { quietMs: 100000, volumeLines: 1000, maxStaleMs: 500 })
    );
    sum.enable('s1');
    sum.feed('s1', 'slow output\r\n');
    await clock.advance(500);
    assert.strictEqual(engine.calls.length, 1, 'stale backstop should fire');
  });

  it('respects minInterval, sets dirty, and retries once after cooldown', async function () {
    const { sum, engine, clock } = makeSummarizer(FAST);
    sum.enable('s1');
    sum.feed('s1', 'a\r\n');
    await clock.advance(100); // infer #1 at t=100
    assert.strictEqual(engine.calls.length, 1);

    sum.feed('s1', 'b\r\n');
    await clock.advance(100); // quiet at t=200, but elapsed 100 < minInterval 1000 -> deferred
    assert.strictEqual(engine.calls.length, 1, 'throttled, not yet re-run');

    await clock.advance(900); // reach t=1100 -> retry fires
    assert.strictEqual(engine.calls.length, 2, 'retry after minInterval');
  });

  it('single-flight: coalesces output during in-flight inference', async function () {
    const { sum, engine, clock } = makeSummarizer(FAST);
    engine._mode = 'hang';
    sum.enable('s1');
    sum.feed('s1', 'first\r\n');
    await clock.advance(100); // _run starts, infer #1 hangs
    assert.strictEqual(engine.calls.length, 1);

    sum.feed('s1', 'second\r\n');
    await clock.advance(100); // in-flight -> dirty, no second infer
    assert.strictEqual(engine.calls.length, 1, 'no concurrent second inference');

    engine.calls[0].resolve(engine._auto); // finish #1
    await flush();
    await clock.advance(1000); // dirty -> retry after minInterval
    assert.strictEqual(engine.calls.length, 2, 'coalesced re-run after completion');
  });

  it('timeout backs off, opens the breaker, and recovers after cooldown (no storm)', async function () {
    const cfg = Object.assign({}, FAST, {
      inferTimeoutMs: 200,
      minIntervalMs: 1000,
      intervalFactor: 1, // minInterval = max(1000, lastDurationMs)
      failureThreshold: 2,
      cooldownMs: 5000,
    });
    const { sum, engine, clock } = makeSummarizer(cfg);
    engine._mode = 'hang'; // never resolves -> always times out
    sum.enable('s1');

    sum.feed('s1', 'a\r\n');
    await clock.advance(100); // run #1 at t=100, timeout at t=300
    await clock.advance(200); // t=300: timeout #1 -> failure 1, retry scheduled ~t=1100
    assert.strictEqual(engine.calls.length, 1);

    await clock.advance(800); // t=1100: auto-retry WITHOUT new feed -> run #2 (proves no stranding)
    assert.strictEqual(engine.calls.length, 2, 'failed content is retried, not stranded');

    await clock.advance(200); // t=1300: timeout #2 -> failure 2 -> breaker opens until ~t=6300
    await clock.advance(2000); // t=3300: still within cooldown -> blocked
    assert.strictEqual(engine.calls.length, 2, 'breaker holds; no retry-storm');

    await clock.advance(3100); // t=6400: just past cooldown (~6300) -> run #3 fires
    assert.strictEqual(engine.calls.length, 3, 'resumes after cooldown');
  });

  it('recovers a failed summary on retry once the engine responds (no new output)', async function () {
    const cfg = Object.assign({}, FAST, { inferTimeoutMs: 200, minIntervalMs: 500, intervalFactor: 1, failureThreshold: 5 });
    const { sum, engine, clock, results } = makeSummarizer(cfg);
    engine._mode = 'hang';
    sum.enable('s1');
    sum.feed('s1', 'important output\r\n');
    await clock.advance(100); // run #1 starts
    await clock.advance(200); // timeout #1 -> failure, retry scheduled ~t=600

    engine._mode = 'auto'; // model becomes responsive again
    await clock.advance(300); // t=600: retry runs and succeeds WITHOUT any new feed
    assert.strictEqual(results.length, 1, 'the previously-failed content gets summarised');
    assert.strictEqual(engine.calls.length, 2);
  });

  it('preserves the exit-priority bypass for a queued (busy) session', async function () {
    const cfg = Object.assign({}, FAST, { minIntervalMs: 10000, quietMs: 100 });
    const { sum, engine, clock } = makeSummarizer(cfg);
    sum.enable('s1');
    sum.feed('s1', 'aaa\r\n');
    await clock.advance(100); // run #1 for s1 succeeds at t=100
    assert.strictEqual(engine.calls.length, 1);

    // Occupy the single worker with another session.
    engine._mode = 'hang';
    sum.enable('z');
    sum.feed('z', 'zzz\r\n');
    await clock.advance(100); // z is running, worker busy
    assert.strictEqual(engine.calls.length, 2);

    // s1 gets new output then its tab exits — within minInterval (so a normal
    // trigger would be throttled), and queued behind z.
    sum.feed('s1', 'more aaa\r\n');
    sum.flushExit('s1'); // reason 'exit' -> queued as 'exit'
    await clock.advance(50);
    assert.strictEqual(engine.calls.length, 2, 's1 is queued behind the busy worker');

    // Finish z -> draining must run s1 despite minInterval, because it's 'exit'.
    engine.calls[1].resolve(engine._auto);
    await flush();
    assert.strictEqual(engine.calls.length, 3, 'queued exit bypassed minInterval on drain');
    assert.ok(engine.calls[2].prompt.includes('aaa'), 's1 ran');
  });

  it('cancel during in-flight discards the result and removes state', async function () {
    const { sum, engine, clock, results } = makeSummarizer(FAST);
    engine._mode = 'hang';
    sum.enable('s1');
    sum.feed('s1', 'work\r\n');
    await clock.advance(100); // run starts, hangs
    assert.strictEqual(engine.calls.length, 1);

    sum.cancel('s1');
    engine.calls[0].resolve(engine._auto); // late completion
    await flush();
    assert.strictEqual(results.length, 0, 'cancelled session must not emit a result');
    assert.strictEqual(sum.isEnabled('s1'), false);
  });

  it('exit trigger does a final flush bypassing minInterval', async function () {
    const { sum, engine, clock, results } = makeSummarizer(FAST);
    sum.enable('s1');
    sum.feed('s1', 'a\r\n');
    await clock.advance(100); // infer #1 at t=100
    assert.strictEqual(engine.calls.length, 1);

    sum.feed('s1', 'final output\r\n'); // new output, within minInterval window
    sum.flushExit('s1');
    await flush();
    assert.strictEqual(engine.calls.length, 2, 'exit bypasses minInterval for a final summary');
  });

  it('foreground-first fairness when draining the pending queue', async function () {
    const { sum, engine, clock, results } = makeSummarizer(FAST, { getForeground: () => 'B' });
    engine._mode = 'hang';
    sum.enable('A');
    sum.enable('B');
    sum.enable('Z');

    // Occupy the single worker with Z.
    sum.feed('Z', 'zzz\r\n');
    await clock.advance(100); // Z running, worker busy
    assert.strictEqual(engine.calls.length, 1);

    // A then B both become pending while busy.
    sum.feed('A', 'aaa\r\n');
    await clock.advance(100);
    sum.feed('B', 'bbb\r\n');
    await clock.advance(100);
    assert.strictEqual(engine.calls.length, 1, 'both queued behind Z');

    // Finish Z -> foreground B should be picked before A.
    engine.calls[0].resolve(engine._auto);
    await flush();
    assert.strictEqual(engine.calls.length, 2);
    assert.ok(engine.calls[1].prompt.includes('bbb'), 'foreground B runs before background A');

    // Finish B -> A runs next.
    engine.calls[1].resolve(engine._auto);
    await flush();
    assert.strictEqual(engine.calls.length, 3);
    assert.ok(engine.calls[2].prompt.includes('aaa'), 'background A runs last');
  });

  it('skips inference entirely when the engine is not ready', async function () {
    const { sum, engine, clock } = makeSummarizer(FAST);
    engine._ready = false;
    sum.enable('s1');
    sum.feed('s1', 'output\r\n');
    await clock.advance(100);
    assert.strictEqual(engine.calls.length, 0, 'no inference while model unavailable');
  });

  it('redacts the model OUTPUT before emitting the note', async function () {
    const { sum, engine, clock, results } = makeSummarizer(FAST, {
      redact: (s) => String(s).split('AKIASECRET').join('[R]'),
    });
    engine._auto = JSON.stringify({
      title: 'tok AKIASECRET',
      goal: 'leaked AKIASECRET here',
      progress: ['did AKIASECRET'],
      waitingOn: [],
    });
    sum.enable('s1');
    sum.feed('s1', 'normal output\r\n');
    await clock.advance(100);
    assert.strictEqual(results.length, 1);
    const note = results[0].note;
    assert.ok(!JSON.stringify(note).includes('AKIASECRET'), 'model output must be redacted');
    assert.ok(note.title.includes('[R]') && note.goal.includes('[R]'));
  });
});
