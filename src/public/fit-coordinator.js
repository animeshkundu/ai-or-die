'use strict';

(function (root, factory) {
  const geometry = typeof module === 'object' && module.exports
    ? require('./terminal-geometry')
    : root.TerminalGeometry;
  const api = factory(geometry);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FitCoordinator = api.FitCoordinator;
})(typeof window !== 'undefined' ? window : globalThis, function (geometry) {
  class FitRequestSupersededError extends Error {
    constructor(id, generation) {
      super(`[terminal-fit] request for ${id} was superseded`);
      this.name = 'FitRequestSupersededError';
      this.code = 'FIT_REQUEST_SUPERSEDED';
      this.id = id;
      this.generation = generation;
    }
  }

  class FitRequestTimeoutError extends Error {
    constructor(id, timeoutMs, generation) {
      super(`[terminal-fit] request for ${id} timed out after ${timeoutMs}ms`);
      this.name = 'FitRequestTimeoutError';
      this.code = 'FIT_REQUEST_TIMEOUT';
      this.id = id;
      this.timeoutMs = timeoutMs;
      this.generation = generation;
    }
  }

  class FitRequestCancelledError extends Error {
    constructor(id, generation, reason) {
      super(`[terminal-fit] request for ${id} was cancelled${reason ? ` (${reason})` : ''}`);
      this.name = 'FitRequestCancelledError';
      this.code = 'FIT_REQUEST_CANCELLED';
      this.id = id;
      this.generation = generation;
      this.reason = reason;
    }
  }

  function numericGeneration(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  class FitCoordinator {
    constructor(options) {
      options = options || {};
      this._targets = new Map();
      this._queued = new Set();
      this._forceSend = new Set();
      this._raf = options.requestAnimationFrame
        || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(globalThis) : (fn) => setTimeout(fn, 0));
      this._setTimeout = options.setTimeout
        || (typeof setTimeout === 'function' ? setTimeout.bind(globalThis) : null);
      this._clearTimeout = options.clearTimeout
        || (typeof clearTimeout === 'function' ? clearTimeout.bind(globalThis) : null);
      this._ResizeObserver = options.ResizeObserver
        || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);
      this._document = options.document
        || (typeof document !== 'undefined' ? document : null);
      this._logger = options.logger || console;
      this._scheduled = false;
      // A fit can fail for reasons no ResizeObserver will ever report again:
      // the container was not measurable yet, or the session socket had not
      // finished opening so the geometry could not be put on the wire. Without
      // a retry the PTY keeps a stale size forever (observed on WebKit, where a
      // freshly created split pane never received its geometry). Retries are
      // bounded and stop as soon as a target settles.
      this._retries = new Map();
      this._pendingRetry = new Set();
      this._retryTimer = null;
      this._retryDelayMs = options.retryDelayMs != null ? options.retryDelayMs : 120;
      this._maxRetries = options.maxRetries != null ? options.maxRetries : 12;

      // Completion waiters are deliberately separate from the fit queue. The
      // ordinary request() path must keep its existing coalescing and retry
      // behavior; only the completion notification is generation-fenced.
      this._waitStates = new Map();
      this._waiters = new Map();
      this._latestExplicitGeneration = new Map();
      this._waitSequence = 0;
      const maxWait = options.maxRequestWaitTimeoutMs != null
        ? Number(options.maxRequestWaitTimeoutMs)
        : options.maxWaitTimeoutMs != null ? Number(options.maxWaitTimeoutMs) : 10000;
      this._maxRequestWaitTimeoutMs = Number.isFinite(maxWait) ? Math.max(0, maxWait) : 10000;
      const defaultWait = options.requestWaitTimeoutMs != null
        ? Number(options.requestWaitTimeoutMs)
        : options.waitTimeoutMs != null ? Number(options.waitTimeoutMs)
          : options.requestTimeoutMs != null ? Number(options.requestTimeoutMs) : 1000;
      this._requestWaitTimeoutMs = Number.isFinite(defaultWait)
        ? Math.min(Math.max(0, defaultWait), this._maxRequestWaitTimeoutMs)
        : Math.min(1000, this._maxRequestWaitTimeoutMs);

      this._onVisibilityChange = () => {
        if (!this._document || this._document.visibilityState === 'visible') this.requestAll();
      };
      if (this._document && typeof this._document.addEventListener === 'function') {
        this._document.addEventListener('visibilitychange', this._onVisibilityChange);
      }
    }

    register(id, target) {
      this.unregister(id);
      const record = Object.assign({ reserve: { cols: 0, rows: 0 }, deferred: false, last: null }, target);
      this._targets.set(id, record);
      if (this._ResizeObserver && record.container) {
        record.observer = new this._ResizeObserver(() => {
          if (record.deferred || record.last) this.request(id);
        });
        record.observer.observe(record.container);
      }
      this.request(id);
      return () => this.unregister(id);
    }

    unregister(id) {
      const target = this._targets.get(id);
      if (target && target.observer) target.observer.disconnect();
      this._rejectWaiters(id, 'unregistered');
      this._targets.delete(id);
      this._queued.delete(id);
      this._forceSend.delete(id);
      this._retries.delete(id);
      this._pendingRetry.delete(id);
      this._latestExplicitGeneration.delete(id);
    }

    /**
     * Queue a fit and resolve after this target's requested fit has been
     * measured, applied, and advertised successfully. Multiple callers for
     * one generation share a completion; a newer generation supersedes the
     * older waiters without changing the underlying fit work.
     *
     * @returns {Promise<{cols:number,rows:number}>}
     */
    requestAndWait(id, options) {
      options = options || {};
      if (!this._targets.has(id)) {
        return Promise.reject(new Error(`[terminal-fit] unknown target: ${id}`));
      }

      const explicit = options.generation !== undefined;
      const generation = explicit ? options.generation : ++this._waitSequence;
      if (explicit && this._isStaleGeneration(id, generation)) {
        return Promise.reject(new FitRequestSupersededError(id, generation));
      }

      let state = this._waitStates.get(id);
      if (!state || state.explicit !== explicit || !Object.is(state.generation, generation)) {
        if (state) this._rejectWaiters(id, 'superseded');
        state = { explicit, generation };
        this._waitStates.set(id, state);
        this._rememberExplicitGeneration(id, generation, explicit);
      }

      const timeoutMs = this._boundedWaitTimeout(options.timeoutMs);
      return new Promise((resolve, reject) => {
        const waiter = { id, generation, state, resolve, reject, timer: null };
        let waiters = this._waiters.get(id);
        if (!waiters) {
          waiters = new Set();
          this._waiters.set(id, waiters);
        }
        waiters.add(waiter);
        if (this._setTimeout) {
          waiter.timer = this._setTimeout(() => {
            if (!waiters.delete(waiter)) return;
            waiter.timer = null;
            if (!waiters.size) {
              this._waiters.delete(id);
              if (this._waitStates.get(id) === state) this._waitStates.delete(id);
            }
            reject(new FitRequestTimeoutError(id, timeoutMs, generation));
          }, timeoutMs);
        }
        // Use the public request path so retry reset, forceSend, and queue
        // coalescing remain exactly the same for ordinary callers.
        this.request(id, options);
      });
    }

    _boundedWaitTimeout(timeoutMs) {
      let value;
      try {
        value = timeoutMs == null ? this._requestWaitTimeoutMs : Number(timeoutMs);
      } catch (_) {
        value = this._requestWaitTimeoutMs;
      }
      if (!Number.isFinite(value)) return this._requestWaitTimeoutMs;
      return Math.min(Math.max(0, value), this._maxRequestWaitTimeoutMs);
    }

    _isStaleGeneration(id, generation) {
      const requested = numericGeneration(generation);
      const latest = numericGeneration(this._latestExplicitGeneration.get(id));
      return requested !== null && latest !== null && requested < latest;
    }

    _rememberExplicitGeneration(id, generation, explicit) {
      if (!explicit) return;
      const next = numericGeneration(generation);
      if (next === null) return;
      const latest = numericGeneration(this._latestExplicitGeneration.get(id));
      if (latest === null || next > latest) this._latestExplicitGeneration.set(id, generation);
    }

    _clearWaiterTimer(waiter) {
      if (waiter.timer != null && this._clearTimeout) this._clearTimeout(waiter.timer);
      waiter.timer = null;
    }

    _rejectWaiters(id, reason) {
      const waiters = this._waiters.get(id);
      this._waiters.delete(id);
      this._waitStates.delete(id);
      if (!waiters) return;
      for (const waiter of waiters) {
        this._clearWaiterTimer(waiter);
        if (reason === 'superseded') {
          waiter.reject(new FitRequestSupersededError(id, waiter.generation));
        } else {
          waiter.reject(new FitRequestCancelledError(id, waiter.generation, reason));
        }
      }
    }

    _resolveWaiters(id, next, state) {
      if (!state || this._waitStates.get(id) !== state) return;
      this._waitStates.delete(id);
      const waiters = this._waiters.get(id);
      this._waiters.delete(id);
      if (!waiters) return;
      for (const waiter of waiters) {
        this._clearWaiterTimer(waiter);
        if (waiter.state === state) waiter.resolve(next);
        else waiter.reject(new FitRequestSupersededError(id, waiter.generation));
      }
    }

    /**
     * Apply an AUTHORITATIVE grid from the server (ADR-0052, Layer 3).
     *
     * FitCoordinator remains the sole owner of `terminal.resize` — an inbound
     * applied frame is still a resize, so it is routed here rather than being
     * applied behind the coordinator's back. Two things matter:
     *
     *  - `target.last` is updated to the applied grid, so the coordinator's
     *    dedup agrees with reality. Leaving it stale would make the very next
     *    measurement differ and emit an advertisement that merely echoes what
     *    the server just told us.
     *  - No `send` is issued. Presenting an authoritative grid is not an
     *    advertisement, and it must never be an ownership claim.
     *
     * @returns {boolean} whether the grid changed
     */
    applyAuthoritative(id, geometry) {
      const target = this._targets.get(id);
      if (!target || !geometry) return false;
      const cols = geometry.cols;
      const rows = geometry.rows;
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return false;
      if (target.last && target.last.cols === cols && target.last.rows === rows) return false;

      try {
        target.terminal.resize(cols, rows);
      } catch (error) {
        this._logger.warn('[terminal-fit] authoritative apply failed', error);
        return false;
      }
      target.last = { cols, rows };
      target.deferred = false;
      // A geometry we did not choose is not one we need to re-send.
      this._forceSend.delete(id);
      this._retries.delete(id);
      this._pendingRetry.delete(id);
      return true;
    }

    request(id, options) {
      if (!this._targets.has(id)) return;
      // An external trigger (ResizeObserver, visibilitychange, app code) is new
      // information about this target, so it starts a fresh bounded retry run.
      // The coordinator's own retry timer bypasses this via _requestFromRetry.
      this._retries.delete(id);
      this._enqueue(id, options);
    }

    _enqueue(id, options) {
      if (!this._targets.has(id)) return;
      this._queued.add(id);
      if (options && options.forceSend) this._forceSend.add(id);
      if (this._scheduled) return;
      this._scheduled = true;
      this._raf(() => this._flush());
    }

    requestAll() {
      for (const id of this._targets.keys()) this.request(id);
    }

    destroy() {
      for (const id of Array.from(this._targets.keys())) this.unregister(id);
      this._cancelRetryTimer();
      this._retries.clear();
      this._pendingRetry.clear();
      if (this._document && typeof this._document.removeEventListener === 'function') {
        this._document.removeEventListener('visibilitychange', this._onVisibilityChange);
      }
    }

    _cancelRetryTimer() {
      if (this._retryTimer != null && this._clearTimeout) this._clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }

    // Re-arm a bounded retry for a target that could not settle this pass.
    //
    // The attempt counter records retries this coordinator actually performed,
    // and is only advanced when the timer fires. Incrementing here instead would
    // let a burst of ResizeObserver callbacks arriving while one timer is armed
    // silently spend the whole budget without ever retrying. The counter is
    // per-target so one wedged pane cannot starve the others, and it is cleared
    // both when the target settles and when an external `request` arrives.
    _scheduleRetry(id) {
      if (!this._setTimeout) return;
      if (this._pendingRetry.has(id)) return;
      if ((this._retries.get(id) || 0) >= this._maxRetries) return;
      this._pendingRetry.add(id);
      if (this._retryTimer != null) return;
      this._retryTimer = this._setTimeout(() => {
        this._retryTimer = null;
        const due = Array.from(this._pendingRetry);
        this._pendingRetry.clear();
        for (const pending of due) {
          if (!this._targets.has(pending)) {
            this._retries.delete(pending);
            continue;
          }
          this._retries.set(pending, (this._retries.get(pending) || 0) + 1);
          this._enqueue(pending);
        }
      }, this._retryDelayMs);
    }

    _flush() {
      this._scheduled = false;
      const ids = Array.from(this._queued);
      this._queued.clear();
      for (const id of ids) this._apply(id);
      if (this._queued.size && !this._scheduled) {
        this._scheduled = true;
        this._raf(() => this._flush());
      }
    }

    _apply(id) {
      const target = this._targets.get(id);
      if (!target) return;
      // Snapshot the waiter state. Geometry still applies normally if this
      // state later times out or is superseded; only completion is fenced.
      const waitState = this._waitStates.get(id) || null;
      let proposed = null;
      try {
        // `measureCapacity` measures the OUTER element directly and is preferred
        // when a target supplies it: a target rendering through a Layer 3
        // transform (ADR-0052) must not derive capacity from the transformed
        // stage, because that folds presentation back into measurement.
        // `proposeDimensions` remains the path for targets without a stage.
        proposed = typeof target.measureCapacity === 'function'
          ? target.measureCapacity()
          : target.proposeDimensions();
      } catch (error) {
        this._logger.warn('[terminal-fit] measurement failed', error);
        target.deferred = true;
        if (!target.last) this._scheduleRetry(id);
        return;
      }
      const reserve = typeof target.reserve === 'function' ? target.reserve() : target.reserve;
      const next = geometry.measureTerminalGeometry(target.container, proposed, reserve);
      if (!next || next.cols < 20 || next.rows < 5) {
        target.deferred = true;
        // Only chase a measurement for a target that has NEVER had a valid
        // geometry. Once a target is established, a temporarily unmeasurable
        // container means chrome is overlaying it, and re-fitting it later
        // would reflow a terminal that ADR-0045 requires to stay put; that case
        // waits for ResizeObserver as before.
        if (!target.last) this._scheduleRetry(id);
        return;
      }

      target.deferred = false;
      const unchanged = target.last && target.last.cols === next.cols && target.last.rows === next.rows;
      // May be a function, because ownership is dynamic: a viewer is only
      // authoritative-mode while it does NOT hold the lease.
      const authoritative = typeof target.authoritativeMode === 'function'
        ? !!target.authoritativeMode()
        : !!target.authoritativeMode;
      let sendSucceeded = !this._forceSend.has(id);
      try {
        if (!unchanged) {
          // In authoritative mode the local grid is owned by the server's
          // applied frame (ADR-0052), so a capacity change is an ADVERTISEMENT
          // only — resizing the grid here would fight applyAuthoritative and
          // repeatedly destroy the presented buffer. `target.last` still tracks
          // what we measured so the dedup and retry logic behave normally.
          if (!authoritative) {
            target.terminal.resize(next.cols, next.rows);
          }
          target.last = next;
        }
        if ((!unchanged || this._forceSend.has(id)) && typeof target.send === 'function') {
          const result = target.send(next);
          sendSucceeded = result !== false;
          if (!sendSucceeded) this._forceSend.add(id);
        }
      } catch (error) {
        target.deferred = true;
        this._forceSend.add(id);
        this._logger.warn('[terminal-fit] apply failed', error);
      }
      if (sendSucceeded && !target.deferred) {
        this._forceSend.delete(id);
        this._retries.delete(id);
        this._pendingRetry.delete(id);
        if (waitState) this._resolveWaiters(id, next, waitState);
      } else {
        // The geometry is known but the peer has not received it. Nothing else
        // will re-trigger this target, so keep trying until the socket opens.
        this._scheduleRetry(id);
      }
    }
  }

  return {
    FitCoordinator,
    FitRequestSupersededError,
    FitRequestTimeoutError,
    FitRequestCancelledError,
  };
});
