'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ViewportRegime = api.ViewportRegime;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  class ViewportRegime {
    constructor(options) {
      options = options || {};
      this.viewport = options.visualViewport;
      this.document = options.document;
      this.window = options.window;
      this.onChange = options.onChange || function () {};
      this._raf = options.requestAnimationFrame
        || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(globalThis) : (fn) => setTimeout(fn, 0));
      this._baselineHeight = this.viewport
        ? this.viewport.height * (this.viewport.scale || 1)
        : 0;
      this._baselineWidth = this.viewport ? this.viewport.width : 0;
      this._keyboardOpen = false;
      this._scheduled = false;
      this._listener = () => this.schedule();
      if (this.viewport) {
        this.viewport.addEventListener('resize', this._listener);
        this.viewport.addEventListener('scroll', this._listener);
      }
      this.schedule();
    }

    schedule() {
      if (this._scheduled) return;
      this._scheduled = true;
      this._raf(() => {
        this._scheduled = false;
        this.onChange(this.read());
      });
    }

    read() {
      if (!this.viewport) return { supported: false, keyboardOpen: false };
      const height = this.viewport.height;
      const width = this.viewport.width || 0;
      const offsetTop = this.viewport.offsetTop || 0;
      const scale = this.viewport.scale || 1;
      const effectiveHeight = height * scale;
      const zoomed = scale > 1.01;
      const wasKeyboardOpen = this._keyboardOpen;
      const orientationChanged = width > 0 && this._baselineWidth > 0
        && Math.abs(width - this._baselineWidth) > Math.min(width, this._baselineWidth) * 0.25;
      if (orientationChanged && !zoomed) {
        this._baselineWidth = width;
        this._baselineHeight = effectiveHeight;
        this._keyboardOpen = false;
      }
      if (!wasKeyboardOpen && effectiveHeight > this._baselineHeight) this._baselineHeight = effectiveHeight;
      const threshold = Math.max(this._baselineHeight * 0.22, 100);
      const keyboardOpen = zoomed
        ? wasKeyboardOpen
        : this._baselineHeight - effectiveHeight > threshold;
      this._keyboardOpen = keyboardOpen;
      if (!keyboardOpen && !zoomed) this._baselineHeight = Math.max(this._baselineHeight, effectiveHeight);

      const style = this.document && this.document.documentElement && this.document.documentElement.style;
      if (style) {
        style.setProperty('--visual-viewport-height', (zoomed ? effectiveHeight : height) + 'px');
        style.setProperty('--visual-viewport-offset-top', offsetTop + 'px');
      }
      if (!zoomed && wasKeyboardOpen && !keyboardOpen && offsetTop !== 0
          && this.window && typeof this.window.scrollTo === 'function') {
        this.window.scrollTo(0, 0);
      }
      return {
        supported: true,
        height,
        offsetTop,
        scale,
        zoomed,
        keyboardOpen,
        baselineHeight: this._baselineHeight,
      };
    }

    resetBaseline() {
      if (this.viewport) {
        this._baselineHeight = this.viewport.height * (this.viewport.scale || 1);
        this._baselineWidth = this.viewport.width || 0;
      }
      this._keyboardOpen = false;
      this.schedule();
    }

    destroy() {
      if (!this.viewport) return;
      this.viewport.removeEventListener('resize', this._listener);
      this.viewport.removeEventListener('scroll', this._listener);
    }
  }

  return { ViewportRegime };
});
