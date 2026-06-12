'use strict';

// Off-hot-path scheduler that turns a session's terminal output into a sticky
// note via the local LLM engine. Deterministic triggers + guards keep it from
// livelocking the CPU or starving sessions. NOTHING here blocks the PTY path:
// feed() only buffers + arms timers; inference runs asynchronously.
//
// Dependencies are injected so the whole trigger/guard state machine can be
// unit-tested with a fake clock + fake engine (no model, no real timers).

const TranscriptBuffer = require('./sticky-note-transcript');
const { buildPrompt, parseNote, NOTE_SCHEMA } = require('./sticky-note-prompt');

const DEFAULTS = {
  quietMs: 4000, // (1) quiet trigger: idle after a burst
  volumeLines: 80, // (2) volume trigger: committed lines since last summary
  maxStaleMs: 90000, // (3) max-staleness backstop while output pends
  minIntervalMs: 20000, // floor between inferences for one session
  intervalFactor: 3, // adaptive: minInterval = max(floor, factor * lastDurationMs)
  inferTimeoutMs: 75000, // backstop ABOVE the engine's own 60s timeout, so the
  // engine times out first (one timeout owner); this only fires if the engine
  // promise hangs entirely. Worker-side serialisation prevents concurrent runs.
  failureThreshold: 3, // consecutive failures -> open circuit breaker
  cooldownMs: 60000, // breaker open duration
  notReadyPollMs: 10000, // re-check cadence while the engine is still loading
  cols: 120,
  rows: 40,
  maxDeltaLines: 80,
  scrollback: 500,
};

class StickyNoteSummarizer {
  constructor(options = {}) {
    this._engine = options.engine; // { isReady(): bool, getStatus(): string, infer(prompt, schema): Promise<string> }
    this._redact = options.redact || ((s) => s);
    this._onResult = options.onResult || (() => {}); // (sessionId, { note, autoTitle, rev })
    this._getForeground = options.getForeground || (() => null);
    this._now = options.now || Date.now;
    this._timers = options.timers || {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (id) => clearTimeout(id),
    };
    // Injectable for tests (default: the real headless-xterm transcript).
    this._createTranscript = options.createTranscript || ((opts) => new TranscriptBuffer(opts));
    this._cfg = Object.assign({}, DEFAULTS, options.config || {});

    this._states = new Map(); // sessionId -> state
    this._globalBusy = false; // one inference at a time (single shared worker)
    this._pending = new Map(); // sessionId -> reason, waiting for the worker
  }

  /** Begin summarising a session (idempotent). */
  enable(sessionId, opts = {}) {
    if (this._states.has(sessionId)) return;
    this._states.set(sessionId, {
      transcript: this._createTranscript({
        cols: opts.cols || this._cfg.cols,
        rows: opts.rows || this._cfg.rows,
        scrollback: this._cfg.scrollback,
        maxDeltaLines: this._cfg.maxDeltaLines,
      }),
      note: opts.note || null,
      rev: opts.rev || 0,
      debounceTimer: null,
      staleTimer: null,
      retryTimer: null,
      lastRunStartedAt: -Infinity,
      lastDurationMs: 0,
      lastUpdatedAt: 0,
      inFlight: false,
      // `needsSummary` survives failed inferences and re-enable, so un-summarised
      // output is never stranded (it is cleared ONLY on a successful summary that
      // captured all output up to that point). `feedSeq` detects output arriving
      // mid-inference.
      needsSummary: false,
      feedSeq: 0,
      failures: 0,
      breakerOpenUntil: 0,
      cancelled: false,
    });
  }

  /** Seed the previous note (e.g. after restore) for summary continuity. */
  setNote(sessionId, note, rev) {
    const s = this._states.get(sessionId);
    if (!s) return;
    s.note = note || null;
    if (typeof rev === 'number') s.rev = rev;
  }

  isEnabled(sessionId) {
    return this._states.has(sessionId);
  }

  /** Feed raw PTY output. Hot path: buffer + arm timers only, never inference. */
  feed(sessionId, chunk) {
    const s = this._states.get(sessionId);
    if (!s || s.cancelled) return;
    s.transcript.write(chunk);
    s.feedSeq++;
    s.needsSummary = true;

    // (1) quiet debounce — reset on every chunk
    if (s.debounceTimer) this._timers.clear(s.debounceTimer);
    s.debounceTimer = this._timers.set(() => {
      s.debounceTimer = null;
      this._attempt(sessionId, 'quiet');
    }, this._cfg.quietMs);

    // (3) max-staleness backstop — arm once while output is pending
    if (!s.staleTimer) {
      s.staleTimer = this._timers.set(() => {
        s.staleTimer = null;
        this._attempt(sessionId, 'stale');
      }, this._cfg.maxStaleMs);
    }

    // (2) volume — flush immediately on a long continuous stream
    if (s.transcript.newLineCount() >= this._cfg.volumeLines) {
      this._attempt(sessionId, 'volume');
    }
  }

  resize(sessionId, cols, rows) {
    const s = this._states.get(sessionId);
    if (s) s.transcript.resize(cols, rows);
  }

  /** (6) Focus/peek trigger — refresh if the tab has new output. */
  focus(sessionId) {
    this._attempt(sessionId, 'focus');
  }

  /** (4) Final flush when the PTY process exits. */
  flushExit(sessionId) {
    this._attempt(sessionId, 'exit');
  }

  /** Tear down a session: cancel timers, discard any in-flight result. */
  cancel(sessionId) {
    const s = this._states.get(sessionId);
    if (!s) return;
    s.cancelled = true;
    this._clearTimers(s);
    this._pending.delete(sessionId);
    try {
      s.transcript.dispose();
    } catch {
      /* ignore */
    }
    this._states.delete(sessionId);
  }

  disable(sessionId) {
    this.cancel(sessionId);
  }

  // --- internals -----------------------------------------------------------

  _minInterval(s) {
    return Math.max(this._cfg.minIntervalMs, this._cfg.intervalFactor * s.lastDurationMs);
  }

  _redactNote(note) {
    const r = this._redact;
    return {
      title: r(note.title || ''),
      goal: r(note.goal || ''),
      progress: (note.progress || []).map((b) => r(b)),
      waitingOn: (note.waitingOn || []).map((b) => r(b)),
    };
  }

  _attempt(sessionId, reason) {
    const s = this._states.get(sessionId);
    if (!s || s.cancelled) return;
    if (s.inFlight) return; // single-flight; the post-run check re-runs if needed
    if (!s.needsSummary) return; // nothing un-summarised

    if (!this._engine || !this._engine.isReady()) {
      // Still downloading/loading -> poll back. Permanently unavailable -> stop.
      const status = this._engine && this._engine.getStatus ? this._engine.getStatus() : 'unavailable';
      if (status !== 'unavailable') this._scheduleRetry(sessionId, this._cfg.notReadyPollMs);
      return;
    }
    if (this._now() < s.breakerOpenUntil) {
      this._scheduleRetry(sessionId, s.breakerOpenUntil - this._now()); // wake when the breaker closes
      return;
    }
    if (reason !== 'exit') {
      const elapsed = this._now() - s.lastRunStartedAt;
      const wait = this._minInterval(s) - elapsed;
      if (wait > 0) {
        this._scheduleRetry(sessionId, wait); // wake when minInterval elapses
        return;
      }
    }
    this._dispatch(sessionId, reason);
  }

  _dispatch(sessionId, reason) {
    if (this._globalBusy) {
      // Fair queue, drained foreground-first. Preserve an 'exit' reason so a
      // closing tab keeps its minInterval bypass when it finally runs.
      const existing = this._pending.get(sessionId);
      this._pending.set(sessionId, existing === 'exit' ? 'exit' : reason);
      return;
    }
    this._run(sessionId, reason);
  }

  async _run(sessionId, reason) {
    const s = this._states.get(sessionId);
    if (!s || s.cancelled) {
      this._drainPending();
      return;
    }

    this._globalBusy = true;
    s.inFlight = true;
    s.lastRunStartedAt = this._now();
    const seqAtStart = s.feedSeq;
    this._clearScheduling(s);

    const start = this._now();
    let produced = null;
    try {
      const text = await s.transcript.snapshot();
      const prompt = buildPrompt(s.note, this._redact(text));
      const raw = await this._inferWithTimeout(prompt);
      produced = parseNote(raw);
      // Redact the model OUTPUT too: a small model routinely echoes a token/
      // path/secret from the transcript into the note, which is then persisted
      // + broadcast + rendered. Input-redaction alone is not enough.
      if (produced) produced = this._redactNote(produced);
    } catch (err) {
      produced = null; // timeout or engine error
    }

    s.lastDurationMs = Math.max(0, this._now() - start);

    // Session may have been cancelled while inference ran — discard.
    const live = this._states.get(sessionId);
    if (live === s && !s.cancelled) {
      if (produced) {
        s.note = produced;
        s.rev += 1;
        s.lastUpdatedAt = this._now();
        s.failures = 0;
        // Clear the flag ONLY if no new output arrived during this run; else
        // the new output still needs summarising.
        if (s.feedSeq === seqAtStart) s.needsSummary = false;
        try {
          this._onResult(sessionId, { note: produced, autoTitle: produced.title, rev: s.rev });
        } catch {
          /* never let a consumer error break the loop */
        }
      } else {
        // Failure: needsSummary stays true so we retry (after backoff) rather
        // than strand the un-summarised output.
        s.failures += 1;
        if (s.failures >= this._cfg.failureThreshold) {
          s.breakerOpenUntil = this._now() + this._cfg.cooldownMs;
          s.failures = 0;
        }
      }
      s.inFlight = false;
      if (s.needsSummary) {
        // Schedule the next attempt; _attempt re-checks the breaker so a failure
        // that just opened it will be deferred to cooldown, not retried now.
        const wait = Math.max(0, this._minInterval(s) - (this._now() - s.lastRunStartedAt));
        this._scheduleRetry(sessionId, wait);
      }
    }

    this._globalBusy = false;
    this._drainPending();
  }

  _drainPending() {
    // Drain until we dispatch one (which flips _globalBusy true) or the queue
    // empties. Skipping gated sessions here (rather than stopping at the first)
    // prevents a throttled session from stalling the others.
    while (!this._globalBusy && this._pending.size > 0) {
      const fg = this._getForeground();
      const nextId = fg && this._pending.has(fg) ? fg : this._pending.keys().next().value;
      const reason = this._pending.get(nextId);
      this._pending.delete(nextId);
      this._attempt(nextId, reason);
    }
  }

  _scheduleRetry(sessionId, wait) {
    const s = this._states.get(sessionId);
    if (!s || s.cancelled || s.retryTimer) return;
    s.retryTimer = this._timers.set(() => {
      s.retryTimer = null;
      this._attempt(sessionId, 'interval');
    }, Math.max(0, wait));
  }

  _inferWithTimeout(prompt) {
    return new Promise((resolve, reject) => {
      let done = false;
      const t = this._timers.set(() => {
        if (!done) {
          done = true;
          reject(new Error('inference timed out'));
        }
      }, this._cfg.inferTimeoutMs);
      Promise.resolve(this._engine.infer(prompt, NOTE_SCHEMA)).then(
        (r) => {
          if (!done) {
            done = true;
            this._timers.clear(t);
            resolve(r);
          }
        },
        (e) => {
          if (!done) {
            done = true;
            this._timers.clear(t);
            reject(e);
          }
        }
      );
    });
  }

  _clearScheduling(s) {
    if (s.debounceTimer) {
      this._timers.clear(s.debounceTimer);
      s.debounceTimer = null;
    }
    if (s.staleTimer) {
      this._timers.clear(s.staleTimer);
      s.staleTimer = null;
    }
    if (s.retryTimer) {
      this._timers.clear(s.retryTimer);
      s.retryTimer = null;
    }
  }

  _clearTimers(s) {
    this._clearScheduling(s);
  }

  /** Cancel everything (server shutdown). */
  shutdown() {
    for (const sessionId of Array.from(this._states.keys())) {
      this.cancel(sessionId);
    }
  }
}

module.exports = StickyNoteSummarizer;
module.exports.DEFAULTS = DEFAULTS;
