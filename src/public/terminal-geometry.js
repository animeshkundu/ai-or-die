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

  return { isLaidOut, measureTerminalGeometry };
});
