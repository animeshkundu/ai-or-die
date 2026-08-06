'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TerminalGeometry = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function isLaidOut(container) {
    if (!container || typeof container.getBoundingClientRect !== 'function') return false;
    if ('isConnected' in container && !container.isConnected) return false;
    const rect = container.getBoundingClientRect();
    return !!(rect && rect.width > 0 && rect.height > 0);
  }

  function measureTerminalGeometry(container, proposed, reserve) {
    if (!isLaidOut(container) || !proposed) return null;
    const naturalCols = Number(proposed.cols);
    const naturalRows = Number(proposed.rows);
    if (!Number.isFinite(naturalCols) || !Number.isFinite(naturalRows)
        || naturalCols < 1 || naturalRows < 1) return null;

    const reserveCols = Math.max(0, Number(reserve && reserve.cols) || 0);
    const reserveRows = Math.max(0, Number(reserve && reserve.rows) || 0);
    const cols = Math.floor(naturalCols - reserveCols);
    const rows = Math.floor(naturalRows - reserveRows);
    return cols > 0 && rows > 0 ? { cols, rows } : null;
  }

  /**
   * Capacity of an OUTER element, in cells, derived from its own rect and the
   * terminal's cell metric.
   *
   * Used by targets that render through a Layer 3 presentation transform
   * (ADR-0052). The fit addon's proposeDimensions() measures the element xterm
   * renders into — which is exactly the element a non-owner transforms — so
   * using it there would feed presentation back into measurement and reproduce
   * the oscillation the ownership model exists to prevent. This reads an
   * untransformed ancestor instead, so capacity stays true regardless of how
   * the grid is currently presented.
   *
   * @param {Element} outer
   * @param {{_core?:object}} terminal xterm instance, for the cell metric
   * @returns {{cols:number,rows:number}|null}
   */
  function measureOuterTerminalCapacity(outer, terminal) {
    if (!isLaidOut(outer) || !terminal) return null;
    let cell = null;
    try {
      const dims = terminal._core
        && terminal._core._renderService
        && terminal._core._renderService.dimensions;
      cell = dims && dims.css && dims.css.cell;
    } catch (_) {
      return null;
    }
    if (!cell || !(cell.width > 0) || !(cell.height > 0)) return null;

    const rect = outer.getBoundingClientRect();
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(outer) : null;
    const padX = style
      ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) : 0;
    const padY = style
      ? (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0) : 0;

    const cols = Math.floor(Math.max(0, rect.width - padX) / cell.width);
    const rows = Math.floor(Math.max(0, rect.height - padY) / cell.height);
    return cols > 0 && rows > 0 ? { cols, rows } : null;
  }

  return { isLaidOut, measureTerminalGeometry, measureOuterTerminalCapacity };
});
