'use strict';

const assert = require('assert');
const { ControlEventBus } = require('../../src/control/event-bus');

describe('control/event-bus ControlEventBus', function () {
  it('append assigns monotonic seq and since() returns only newer events', function () {
    const bus = new ControlEventBus();
    const start = bus.headCursor();
    bus.append('s1', 'became_busy');
    bus.append('s1', 'turn_ended');
    const out = bus.since(start);
    assert.equal(out.events.length, 2);
    assert.equal(out.events[0].kind, 'became_busy');
    assert.equal(out.events[1].kind, 'turn_ended');
    assert.equal(out.events[1].seq, out.cursor.seq);
    assert.equal(out.gaps.length, 0);
  });

  it('since(undefined) does not replay history', function () {
    const bus = new ControlEventBus();
    bus.append('s1', 'turn_ended');
    const out = bus.since(undefined);
    assert.equal(out.events.length, 0);
    assert.equal(out.cursor.seq, 1);
    assert.equal(out.cursor.epoch, bus.epoch);
  });

  it('epoch mismatch surfaces a restart gap', function () {
    const bus = new ControlEventBus();
    bus.append('s1', 'turn_ended');
    const out = bus.since({ epoch: 'stale-epoch', seq: 5 });
    assert.equal(out.gaps.length, 1);
    assert.equal(out.gaps[0].reason, 'restart');
    assert.equal(out.cursor.epoch, bus.epoch);
  });

  it('ring overflow surfaces an overflow gap', function () {
    const bus = new ControlEventBus({ maxEvents: 3 });
    const start = bus.headCursor(); // seq 0
    for (let i = 0; i < 6; i++) bus.append('s1', 'became_busy'); // seqs 1..6, ring keeps 4..6
    const out = bus.since(start);
    assert.equal(out.gaps.length, 1);
    assert.equal(out.gaps[0].reason, 'overflow');
    assert.ok(out.events.length <= 3);
    assert.equal(out.events[out.events.length - 1].seq, 6);
  });

  it('unknown event kind throws', function () {
    const bus = new ControlEventBus();
    assert.throws(() => bus.append('s1', 'not_a_kind'), /unknown event kind/);
  });

  it('waitFor resolves immediately when events already pending', async function () {
    const bus = new ControlEventBus();
    const start = bus.headCursor();
    bus.append('s1', 'turn_ended');
    const out = await bus.waitFor(start, 1000);
    assert.equal(out.events.length, 1);
  });

  it('waitFor wakes on a later matching event', async function () {
    const bus = new ControlEventBus();
    const start = bus.headCursor();
    const p = bus.waitFor(start, 1000, { sessionIds: ['s2'], kinds: ['turn_ended'] });
    setTimeout(() => {
      bus.append('s1', 'turn_ended'); // filtered out (wrong session)
      bus.append('s2', 'became_busy'); // filtered out (wrong kind)
      bus.append('s2', 'turn_ended'); // match
    }, 10);
    const out = await p;
    assert.equal(out.events.length, 1);
    assert.equal(out.events[0].sessionId, 's2');
    assert.equal(out.events[0].kind, 'turn_ended');
  });

  it('waitFor resolves empty at timeout with an advanced cursor', async function () {
    const bus = new ControlEventBus();
    const start = bus.headCursor();
    const out = await bus.waitFor(start, 20);
    assert.equal(out.events.length, 0);
    assert.equal(out.cursor.epoch, bus.epoch);
  });
});
