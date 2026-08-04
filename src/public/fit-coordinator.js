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
      this._ResizeObserver = options.ResizeObserver
        || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);
      this._document = options.document
        || (typeof document !== 'undefined' ? document : null);
      this._logger = options.logger || console;
      this._scheduled = false;
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
    }

    request(id, options) {
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
      if (this._document && typeof this._document.removeEventListener === 'function') {
        this._document.removeEventListener('visibilitychange', this._onVisibilityChange);
      }
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
        return;
      }
      const reserve = typeof target.reserve === 'function' ? target.reserve() : target.reserve;
      const next = geometry.measureTerminalGeometry(target.container, proposed, reserve);
      if (!next || next.cols < 20 || next.rows < 5) {
        target.deferred = true;
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
      if (sendSucceeded) this._forceSend.delete(id);
    }
  }

  return { FitCoordinator };
});
