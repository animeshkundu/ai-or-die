'use strict';

// In-process event bus + bounded monotonic event ring for the fleet control
// plane. This is the network-safe generalization of firstmate's durable
// wake-queue: the control plane emits session events (turn_ended, became_busy,
// exited, ...) and a long-poll consumer (`await_turn` at the github-router fleet
// layer) drains them by cursor.
//
// Distributed-safety the 3-lab review required (vs firstmate's single local
// watcher over durable files):
//   - EPOCH: a per-process id. An instance restart mints a new epoch, so a
//     client holding a pre-restart cursor is told `gap: restart` instead of
//     silently resuming a reset sequence (the ABA problem).
//   - GAP REPORTING: when the ring overflows past a client's cursor, `since()`
//     returns `gap: overflow` so the client resyncs (via list_sessions) instead
//     of believing nothing happened.
//   - The cursor is `{ epoch, seq }`; the model never threads it — the fleet
//     layer manages it per-client (contract v1).

const { EventEmitter } = require('events');
const crypto = require('crypto');

const DEFAULT_MAX_EVENTS = 1000;

// Event kinds the control plane emits (mirrors the contract's await_turn `kind`).
const EVENT_KINDS = Object.freeze([
  'turn_ended',
  'became_idle',
  'became_busy',
  'waiting_input',
  'exited',
  'crashed',
  'session_created',
  'session_deleted',
]);

class ControlEventBus extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(0); // many concurrent long-polls
    this._maxEvents = options.maxEvents || DEFAULT_MAX_EVENTS;
    // A fresh, unguessable epoch per process. Math.random/Date are fine here
    // (normal server code), but a crypto id avoids cross-process collisions.
    this._epoch = options.epoch || crypto.randomBytes(8).toString('hex');
    this._seq = 0; // last assigned seq; first event is seq 1
    this._ring = []; // [{ seq, sessionId, kind, at, detail? }], ascending seq
  }

  get epoch() {
    return this._epoch;
  }

  /** Append an event, assign it the next seq, and notify long-poll waiters. */
  append(sessionId, kind, detail) {
    if (!EVENT_KINDS.includes(kind)) {
      throw new Error(`ControlEventBus: unknown event kind "${kind}"`);
    }
    const event = { seq: ++this._seq, sessionId: sessionId || null, kind, at: Date.now() };
    if (detail !== undefined) event.detail = detail;
    this._ring.push(event);
    if (this._ring.length > this._maxEvents) {
      this._ring.splice(0, this._ring.length - this._maxEvents);
    }
    this.emit('event', event);
    return event;
  }

  /** The cursor a fresh consumer should start from (i.e. "only new events"). */
  headCursor() {
    return { epoch: this._epoch, seq: this._seq };
  }

  /**
   * Events strictly after `cursor`, plus any gap markers. Pure read.
   * @param {?{epoch:string, seq:number}} cursor  omitted/null → start at head (no replay)
   * @param {?{sessionIds?:string[], kinds?:string[]}} [filter]
   */
  since(cursor, filter) {
    const gaps = [];
    let events;

    if (!cursor) {
      // First call: do not replay history; subscribe from the current head.
      events = [];
    } else if (cursor.epoch !== this._epoch) {
      // The instance restarted under this consumer. Surface a gap and hand back
      // everything we currently retain so the consumer can resync.
      gaps.push({ reason: 'restart' });
      events = this._ring.slice();
    } else {
      const oldestSeq = this._ring.length ? this._ring[0].seq : this._seq + 1;
      if (cursor.seq < oldestSeq - 1) {
        // The ring rolled past the cursor: events were dropped.
        gaps.push({ reason: 'overflow', fromSeq: cursor.seq, toSeq: oldestSeq - 1 });
      }
      events = this._ring.filter((e) => e.seq > cursor.seq);
    }

    const filtered = applyFilter(events, filter);
    const maxSeq = events.length ? events[events.length - 1].seq : this._seq;
    return { events: filtered, gaps, cursor: { epoch: this._epoch, seq: maxSeq }, more: false };
  }

  /**
   * Long-poll: resolve as soon as there is at least one matching event after
   * `cursor`, or at `timeoutMs` (whichever first). Always resolves (never
   * rejects); on timeout returns an empty set with an advanced cursor.
   * @returns {Promise<{events:Array, gaps:Array, cursor:object, more:boolean}>}
   */
  waitFor(cursor, timeoutMs, filter) {
    const immediate = this.since(cursor, filter);
    if (immediate.events.length || immediate.gaps.length) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.removeListener('event', onEvent);
        clearTimeout(timer);
        resolve(this.since(cursor, filter));
      };
      const onEvent = (event) => {
        if (matches(event, filter)) finish();
      };
      const timer = setTimeout(finish, Math.max(0, timeoutMs || 0));
      if (timer.unref) timer.unref();
      this.on('event', onEvent);
    });
  }
}

function matches(event, filter) {
  if (!filter) return true;
  if (filter.sessionIds && filter.sessionIds.length && !filter.sessionIds.includes(event.sessionId)) {
    return false;
  }
  if (filter.kinds && filter.kinds.length && !filter.kinds.includes(event.kind)) {
    return false;
  }
  return true;
}

function applyFilter(events, filter) {
  if (!filter) return events;
  return events.filter((e) => matches(e, filter));
}

module.exports = { ControlEventBus, EVENT_KINDS, DEFAULT_MAX_EVENTS };
