'use strict';

(function (root, factory) {
  const geometry = typeof module === 'object' && module.exports
    ? require('./terminal-geometry')
    : root.TerminalGeometry;
  const api = factory(geometry);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FitCoordinator = api.FitCoordinator;
})(typeof window !== 'undefined' ? window : globalThis, function (geometry) {
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
      this._targets.delete(id);
      this._queued.delete(id);
      this._forceSend.delete(id);
      this._retries.delete(id);
      this._pendingRetry.delete(id);
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
      let proposed = null;
      try {
        proposed = target.proposeDimensions();
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
      let sendSucceeded = !this._forceSend.has(id);
      try {
        if (!unchanged) {
          target.terminal.resize(next.cols, next.rows);
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
      } else {
        // The geometry is known but the peer has not received it. Nothing else
        // will re-trigger this target, so keep trying until the socket opens.
        this._scheduleRetry(id);
      }
    }
  }

  return { FitCoordinator };
});
