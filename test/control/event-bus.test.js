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

  it('FIX A: a fresh (cursor-less) watcher RECEIVES the event that wakes it (no drop, no double-deliver)', async function () {
    const bus = new ControlEventBus();
    const p = bus.waitFor(undefined, 1000, undefined); // fresh watcher, no cursor
    bus.append('s1', 'turn_ended');
    const r = await p;
    assert.equal(r.events.length, 1, 'the waking event is delivered');
    assert.equal(r.events[0].kind, 'turn_ended');
    // Resuming from the returned cursor must not re-deliver it.
    const r2 = await bus.waitFor(r.cursor, 50);
    assert.equal(r2.events.length, 0, 'no double-delivery, no loss');
  });

  it('FIX D: a 0-timeout poll resolves immediately (no hang, no hot-loop)', async function () {
    const bus = new ControlEventBus();
    const out = await bus.waitFor(bus.headCursor(), 0);
    assert.equal(out.events.length, 0);
    assert.equal(out.cursor.epoch, bus.epoch);
  });

  it('FIX B (symmetry): a sessionIds:[null] filter sees the GLOBAL bucket overflow', function () {
    const bus = new ControlEventBus({ maxEventsPerSession: 3 });
    const start = bus.headCursor(); // seq 0
    for (let i = 0; i < 10; i++) bus.append(null, 'session_created'); // null -> GLOBAL_KEY bucket; overflows + evicts
    const out = bus.since(start, { sessionIds: [null] });
    assert.ok(out.gaps.some((g) => g.reason === 'overflow'), 'null filter maps to the GLOBAL_KEY evicted watermark');
  });

  it('FIX B: a session-FILTERED watcher gets NO overflow from another session\'s eviction', function () {
    const bus = new ControlEventBus({ maxEventsPerSession: 3 });
    const start = bus.headCursor(); // seq 0
    bus.append('q', 'turn_ended'); // seq 1, quiet session (never overflows)
    for (let i = 0; i < 10; i++) bus.append('chatty', 'became_busy'); // floods + evicts chatty's own
    // Watcher filtered to the QUIET session, polling from an old cursor.
    const quiet = bus.since(start, { sessionIds: ['q'] });
    assert.equal(quiet.gaps.length, 0, 'no overflow — the quiet session lost nothing');
    assert.ok(quiet.events.some((e) => e.sessionId === 'q' && e.kind === 'turn_ended'));
  });

  it('FIX B: a FILTERED watcher on the evicted session sees overflow, and no returned event is inside the gap', function () {
    const bus = new ControlEventBus({ maxEventsPerSession: 3 });
    const start = bus.headCursor(); // seq 0
    for (let i = 0; i < 10; i++) bus.append('chatty', 'became_busy'); // evicts chatty's own oldest
    const out = bus.since(start, { sessionIds: ['chatty'] });
    assert.ok(out.gaps.some((g) => g.reason === 'overflow'), 'overflow surfaced for the evicted session');
    const gap = out.gaps.find((g) => g.reason === 'overflow');
    for (const e of out.events) {
      assert.ok(e.seq > gap.toSeq, `returned event seq ${e.seq} must be strictly after gap.toSeq ${gap.toSeq}`);
    }
  });

  it('FIX B: unfiltered overflow never overlaps — every returned event.seq > gap.toSeq', function () {
    const bus = new ControlEventBus({ maxEventsPerSession: 3 });
    const start = bus.headCursor(); // seq 0
    bus.append('a', 'became_busy'); // seq 1
    for (let i = 0; i < 10; i++) bus.append('b', 'became_busy'); // evicts b's oldest → global floor bumps
    const out = bus.since(start); // unfiltered, cursor older than the floor
    assert.ok(out.gaps.some((g) => g.reason === 'overflow'));
    const gap = out.gaps.find((g) => g.reason === 'overflow');
    for (const e of out.events) {
      assert.ok(e.seq > gap.toSeq, `event seq ${e.seq} overlaps the claimed-lost range up to ${gap.toSeq}`);
    }
  });

  // ---- F15 per-session retention --------------------------------------------
  it('F15: a chatty session evicts only its OWN events, never another session\'s turn_ended', function () {
    const bus = new ControlEventBus({ maxEventsPerSession: 3 });
    bus.append('quiet', 'turn_ended'); // the one turn boundary we must not lose
    for (let i = 0; i < 50; i++) bus.append('chatty', 'became_busy'); // floods well past the cap
    const quietEvents = bus.listEvents().filter((e) => e.sessionId === 'quiet');
    assert.equal(quietEvents.length, 1, 'quiet session retained its event');
    assert.equal(quietEvents[0].kind, 'turn_ended');
    const chattyEvents = bus.listEvents().filter((e) => e.sessionId === 'chatty');
    assert.equal(chattyEvents.length, 3, 'chatty session capped to its own ring depth');
  });

  it('F15: a stale unfiltered cursor → overflow gap; the quiet turn_ended is RETAINED (resynced via snapshot, not the in-gap stream)', function () {
    const bus = new ControlEventBus({ maxEventsPerSession: 3 });
    const start = bus.headCursor(); // seq 0
    bus.append('quiet', 'turn_ended'); // seq 1
    for (let i = 0; i < 50; i++) bus.append('chatty', 'became_busy'); // evicts chatty's own → bumps the global floor
    const out = bus.since(start);
    assert.equal(out.gaps.length, 1);
    assert.equal(out.gaps[0].reason, 'overflow');
    // FIX B: under overflow, in-gap events are deferred to the snapshot resync, so
    // the incremental stream must NOT contradict the gap (nothing <= gap.toSeq).
    for (const e of out.events) assert.ok(e.seq > out.gaps[0].toSeq);
    // The quiet turn_ended was NEVER evicted — it is still retained (snapshot path).
    const retained = bus.listEvents().find((e) => e.sessionId === 'quiet' && e.kind === 'turn_ended');
    assert.ok(retained, 'the quiet session turn_ended survived the chatty flood (retained for snapshot resync)');
    // And a watcher FILTERED to the quiet session sees it with NO overflow.
    const quietView = bus.since(start, { sessionIds: ['quiet'] });
    assert.equal(quietView.gaps.length, 0);
    assert.ok(quietView.events.some((e) => e.kind === 'turn_ended'));
  });

  it('F15: whole-session bucket eviction past the session cap bumps the overflow floor', function () {
    const bus = new ControlEventBus({ maxEventsPerSession: 4, maxSessions: 2 });
    bus.append('a', 'turn_ended'); // seq 1, bucket a
    const start = bus.headCursor(); // after seq 1
    bus.append('b', 'became_busy'); // seq 2, bucket b
    bus.append('c', 'became_busy'); // seq 3, bucket c → evicts bucket a (LRU)
    assert.equal(bus.listEvents().some((e) => e.sessionId === 'a'), false, 'bucket a evicted wholesale');
    const out = bus.since(start);
    assert.equal(out.gaps.length === 0, true, 'cursor after seq1 lost nothing newer (a was seq1, evicted but pre-cursor)');
    // A cursor BEFORE seq 1 must see the overflow (a's seq 1 was dropped).
    const stale = bus.since({ epoch: bus.epoch, seq: 0 });
    assert.equal(stale.gaps[0].reason, 'overflow');
  });

  it('F15: the returned cursor always reaches the global head and never re-triggers overflow', function () {
    // Multiple session rings, one of which OVERFLOWS its per-session cap, queried
    // from a cursor older than the eviction floor.
    const bus = new ControlEventBus({ maxEventsPerSession: 3 });
    const older = bus.headCursor(); // seq 0, before anything
    bus.append('quiet', 'turn_ended'); // seq 1 (retained — quiet ring never overflows)
    for (let i = 0; i < 10; i++) bus.append('chatty', 'became_busy'); // seqs 2..11, ring keeps 9..11, evicts up to seq 8
    const head = bus._seq;
    assert.ok(head > 0);

    const out = bus.since(older);
    // The returned cursor advances to the global head regardless of which events
    // survived per-session eviction or got filtered.
    assert.equal(out.cursor.seq, head, 'returned cursor === global head (_seq)');
    assert.equal(out.cursor.seq, bus._seq);
    assert.ok(out.gaps.some((g) => g.reason === 'overflow'), 'stale cursor saw the overflow once');

    // Resuming from the returned cursor must be fully caught up: no events, NO
    // spurious overflow re-trigger.
    const next = bus.since(out.cursor);
    assert.equal(next.events.length, 0, 'no events after catching up to head');
    assert.equal(next.gaps.length, 0, 'no spurious overflow re-trigger from the advanced cursor');
    assert.equal(next.cursor.seq, head, 'cursor stays at the head');
  });

  // ---- F22 per-watcher independent cursors ----------------------------------
  it('F22: concurrent watchers resume independently from their own cursors (no shared position)', function () {
    const bus = new ControlEventBus();
    bus.append('s1', 'became_busy'); // seq 1
    const watcherA = bus.since(bus.headCursor()).cursor; // A caught up at seq 1
    bus.append('s1', 'turn_ended'); // seq 2
    const outB = bus.since({ epoch: bus.epoch, seq: 0 }); // B started from the very beginning
    const outA = bus.since(watcherA);                      // A resumes from seq 1
    assert.equal(outB.events.length, 2, 'watcher B sees both events');
    assert.equal(outA.events.length, 1, 'watcher A sees only the new event');
    assert.equal(outA.events[0].kind, 'turn_ended');
    // Reading either watcher did not advance the other — the bus holds no global cursor.
    assert.equal(bus.since(watcherA).events.length, 1, 'A is still independently resumable');
  });

  it('F22: per-watcher filters are independent (each cursor + filter is a pure read)', async function () {
    const bus = new ControlEventBus();
    const start = bus.headCursor();
    bus.append('s1', 'turn_ended');
    bus.append('s2', 'became_busy');
    const onlyS1 = bus.since(start, { sessionIds: ['s1'] });
    const onlyBusy = bus.since(start, { kinds: ['became_busy'] });
    assert.equal(onlyS1.events.length, 1);
    assert.equal(onlyS1.events[0].sessionId, 's1');
    assert.equal(onlyBusy.events.length, 1);
    assert.equal(onlyBusy.events[0].kind, 'became_busy');
    // Both advance their cursor past ALL events (so a filtered watcher won't re-scan).
    assert.equal(onlyS1.cursor.seq, 2);
    assert.equal(onlyBusy.cursor.seq, 2);
  });
});
