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
//   - GAP REPORTING: when retention rolls past a client's cursor, `since()`
//     returns `gap: overflow` so the client resyncs (via snapshot) instead of
//     believing nothing happened.
//   - The cursor is `{ epoch, seq }`; the model never threads it - the fleet
//     layer manages it per-client (contract v1). Cursors are PER-WATCHER:
//     `since()` / `waitFor()` are pure reads parameterised by the caller's
//     cursor, with NO shared global watcher position, so many concurrent
//     watchers each resume from their own `{epoch,seq}` without interfering
//     (F22).
//
// RETENTION IS PER SESSION (F15). The naive single global ring let one chatty
// session roll the buffer and evict another session's last `turn_ended`, forcing
// an avoidable resync. Instead each session keeps its OWN bounded ring, so a busy
// session only evicts its own old events - never another session's turn boundary.
// A global monotonic `seq` still orders events across sessions for the cursor,
// and `_maxEvictedSeq` (the highest seq ever dropped from ANY ring) drives
// overflow detection: a cursor older than it has provably missed an event. Whole
// idle-session rings are evicted (LRU) only past a large session cap, also
// bumping `_maxEvictedSeq` so the drop is never silent.

const { EventEmitter } = require('events');
const crypto = require('crypto');

// Per-SESSION ring depth. ~85 turns of busy/idle/turn_ended history per session,
// so a session's last turn_ended survives any realistic fan-out burst by OTHER
// sessions. (Back-compat: the old `maxEvents` option maps to this.)
const DEFAULT_MAX_EVENTS_PER_SESSION = 256;
// Whole-session bucket cap. Past this many distinct sessions, the least-recently
// active session's ring is evicted wholesale (its events are old/dead). Sized for
// the scale bar (100+ live sessions) with generous headroom for exited ones.
const DEFAULT_MAX_SESSIONS = 1024;
// Bucket key for session-less events (defensive; current emitters always pass an id).
const GLOBAL_KEY = '__global__';

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
    // `maxEvents` is the legacy single-ring cap; it now sizes the PER-SESSION ring
    // (a chatty session evicts only its own old events, never another's turn_ended).
    this._maxPerSession = options.maxEventsPerSession || options.maxEvents || DEFAULT_MAX_EVENTS_PER_SESSION;
    this._maxSessions = options.maxSessions || DEFAULT_MAX_SESSIONS;
    // A fresh, unguessable epoch per process. Math.random/Date are fine here
    // (normal server code), but a crypto id avoids cross-process collisions.
    this._epoch = options.epoch || crypto.randomBytes(8).toString('hex');
    this._seq = 0; // last assigned seq; first event is seq 1
    this._buckets = new Map(); // sessionKey -> [{ seq, sessionId, kind, at, detail? }] ascending; Map order = LRU
    this._maxEvictedSeq = 0; // highest seq dropped from ANY ring (GLOBAL overflow floor, for unfiltered watchers)
    this._evictedBySession = new Map(); // sessionKey -> highest seq evicted from THAT bucket (filter-aware overflow)
  }

  get epoch() {
    return this._epoch;
  }

  /** Per-session ring depth (the retention contract surfaced via /capabilities). */
  get maxEventsPerSession() {
    return this._maxPerSession;
  }

  /** Append an event, assign it the next seq, and notify long-poll waiters. */
  append(sessionId, kind, detail) {
    if (!EVENT_KINDS.includes(kind)) {
      throw new Error(`ControlEventBus: unknown event kind "${kind}"`);
    }
    const event = { seq: ++this._seq, sessionId: sessionId || null, kind, at: Date.now() };
    if (detail !== undefined) event.detail = detail;

    const key = event.sessionId || GLOBAL_KEY;
    let bucket = this._buckets.get(key);
    if (bucket) {
      this._buckets.delete(key); // re-insert to mark this session most-recently-active (LRU order)
    } else {
      bucket = [];
    }
    bucket.push(event);
    if (bucket.length > this._maxPerSession) {
      // Evict THIS session's oldest events only - never another session's.
      const dropped = bucket.splice(0, bucket.length - this._maxPerSession);
      this._bumpEvictedFor(key, dropped[dropped.length - 1].seq);
    }
    this._buckets.set(key, bucket);

    // Whole-session eviction: past the session cap, drop the least-recently-active
    // session's ring entirely (its events are stale). Bump the floor so a watcher
    // holding a cursor into that range gets an overflow gap, not a silent loss.
    while (this._buckets.size > this._maxSessions) {
      const oldestKey = this._buckets.keys().next().value;
      const oldest = this._buckets.get(oldestKey);
      this._buckets.delete(oldestKey);
      if (oldest && oldest.length) this._bumpEvictedFor(oldestKey, oldest[oldest.length - 1].seq);
    }

    this.emit('event', event);
    return event;
  }

  _bumpEvicted(seq) {
    if (seq > this._maxEvictedSeq) this._maxEvictedSeq = seq;
  }

  /** Bump BOTH the global overflow floor and the per-bucket evicted watermark. */
  _bumpEvictedFor(key, seq) {
    this._bumpEvicted(seq);
    const cur = this._evictedBySession.get(key) || 0;
    if (seq > cur) this._evictedBySession.set(key, seq);
  }

  /** The cursor a fresh consumer should start from (i.e. "only new events"). */
  headCursor() {
    return { epoch: this._epoch, seq: this._seq };
  }

  /**
   * Retained events with seq strictly greater than `minSeq`, merged across all
   * session rings and returned ascending by seq. Each ring is already ascending,
   * so we walk it from the tail and stop once we pass `minSeq` - only the new tail
   * of each session is collected, not the whole fleet history.
   */
  _collectAfter(minSeq) {
    const out = [];
    for (const bucket of this._buckets.values()) {
      for (let i = bucket.length - 1; i >= 0; i--) {
        if (bucket[i].seq <= minSeq) break;
        out.push(bucket[i]);
      }
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** All retained events, ascending by seq (diagnostics / restart resync). */
  listEvents() {
    return this._collectAfter(0);
  }

  /**
   * Events strictly after `cursor`, plus any gap markers. Pure read - no shared
   * cursor state, so concurrent watchers are independent (F22).
   * @param {?{epoch:string, seq:number}} cursor  omitted/null -> start at head (no replay)
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
      events = this._collectAfter(0);
    } else {
      // Overflow is FILTER-AWARE: a session-filtered watcher must only see overflow
      // caused by eviction in a session IT watches, not by another chatty session's
      // eviction. Unfiltered watchers use the global floor.
      const overflowFloor = (filter && Array.isArray(filter.sessionIds) && filter.sessionIds.length)
        ? Math.max(0, ...filter.sessionIds.map((id) => this._evictedBySession.get(id || GLOBAL_KEY) || 0))
        : this._maxEvictedSeq;
      if (cursor.seq < overflowFloor) {
        // At least one event the watcher cares about was evicted: it must resync
        // via the snapshot endpoint.
        gaps.push({ reason: 'overflow', fromSeq: cursor.seq, toSeq: overflowFloor });
      }
      // Collect AFTER the gap boundary so returned events never contradict the gap
      // (an event with seq inside [cursor.seq, overflowFloor] would overlap the
      // claimed-lost range). With no overflow this is just cursor.seq - unchanged.
      events = this._collectAfter(Math.max(cursor.seq, overflowFloor));
    }

    const filtered = applyFilter(events, filter);
    // Advance the cursor to the global head (`_seq`) past EVERY event seen, so a
    // filtered watcher never re-scans and a stale cursor can't re-trigger overflow.
    // The newest event is always retained (a ring evicts only its own oldest, and
    // the just-active bucket is never the LRU whole-session victim), so in every
    // reachable state `events[last].seq === _seq` whenever anything is newer than
    // the cursor; setting it unconditionally removes that fragile invariant-reasoning
    // with zero behaviour change.
    const maxSeq = this._seq;
    return { events: filtered, gaps, cursor: { epoch: this._epoch, seq: maxSeq }, more: false };
  }

  /**
   * Long-poll: resolve as soon as there is at least one matching event after
   * `cursor`, or at `timeoutMs` (whichever first). Always resolves (never
   * rejects); on timeout returns an empty set with an advanced cursor.
   * @returns {Promise<{events:Array, gaps:Array, cursor:object, more:boolean}>}
   */
  waitFor(cursor, timeoutMs, filter) {
    // A fresh watcher (no cursor) must still RECEIVE the event that wakes the
    // long-poll. since(undefined) returns []; without anchoring to the current
    // head, the woken poll would resolve since(undefined) again and drop the very
    // event it woke for. Anchor to head: only events AFTER wait-start are returned
    // (no history replay), and the waking event is delivered.
    const baseCursor = cursor || this.headCursor();
    const immediate = this.since(baseCursor, filter);
    // Return immediately when there's already something to deliver, OR when this is
    // a non-blocking poll (timeoutMs <= 0): a 0-timeout caller wants "what's there
    // now", and entering the wait with no armed timer (FIX D) would otherwise hang.
    if (immediate.events.length || immediate.gaps.length || timeoutMs <= 0) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.removeListener('event', onEvent);
        if (timer) clearTimeout(timer);
        resolve(this.since(baseCursor, filter));
      };
      const onEvent = (event) => {
        if (matches(event, filter)) finish();
      };
      // FIX D: only arm the timer when a positive timeout is given; setTimeout(0)
      // would resolve on the next macrotask and turn the long-poll into a hot loop.
      const timer = timeoutMs > 0 ? setTimeout(finish, timeoutMs) : null;
      if (timer && timer.unref) timer.unref();
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

module.exports = { ControlEventBus, EVENT_KINDS, DEFAULT_MAX_EVENTS_PER_SESSION, DEFAULT_MAX_SESSIONS };
