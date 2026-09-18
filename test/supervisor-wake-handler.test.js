'use strict';

const assert = require('assert');
const { WakeHandler } = require('../src/supervisor/wake-handler');

describe('supervisor/wake-handler', function () {
  it('normal ticks do not report wake', function () {
    let now = 1000000;
    const handler = new WakeHandler({ now: () => now, wakeGapMs: 60000 });
    assert.deepStrictEqual(handler.tick(), { woke: false, gapMs: 0 });
    now += 30000;
    assert.deepStrictEqual(handler.tick(), { woke: false, gapMs: 30000 });
    assert.strictEqual(handler.wakeCount, 0);
  });

  it('a tick gap over the threshold reports wake and opens a grace window', function () {
    let now = 1000000;
    const wakes = [];
    const handler = new WakeHandler({
      now: () => now,
      wakeGapMs: 60000,
      resumeGraceMs: 15000,
      onWake: (info) => wakes.push(info),
    });
    handler.tick();
    now += 8 * 3600 * 1000; // 8h sleep
    const result = handler.tick();
    assert.strictEqual(result.woke, true);
    assert.strictEqual(result.gapMs, 8 * 3600 * 1000);
    assert.strictEqual(handler.wakeCount, 1);
    assert.strictEqual(wakes.length, 1);
    assert.strictEqual(handler.inResumeGrace(), true);
    now += 15001;
    assert.strictEqual(handler.inResumeGrace(), false);
  });

  it('onWake errors never break the tick', function () {
    let now = 1000000;
    const handler = new WakeHandler({
      now: () => now,
      wakeGapMs: 60000,
      onWake: () => { throw new Error('boom'); },
    });
    handler.tick();
    now += 120000;
    assert.doesNotThrow(() => handler.tick());
    assert.strictEqual(handler.wakeCount, 1);
  });
});
