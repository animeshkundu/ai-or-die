'use strict';

// Layer 3 presentation geometry (ADR-0052).
//
// A non-owner viewer must present the session's AUTHORITATIVE applied grid, not
// its own capacity. This module answers one question, purely:
//
//     given an outer rect, the applied grid, and the cell metric,
//     how should the grid be presented?
//
// Purity is the load-bearing property, not a style preference. The refuted
// design had presentation feed back into measurement, producing an oscillation
// between two attached viewers. There are two distinct routes back into that
// loop and both are closed here:
//
//   1. Scaling the FONT. The vendored fit addon derives the cell metric from the
//      live font size, so changing the font changes the very input the next
//      measurement depends on. This module never returns a font size; it returns
//      a transform scale for an inner stage whose size the outer element does not
//      observe.
//   2. Letting the presented size become the next advertised capacity. This
//      module is not given, and cannot read, any previously applied value — only
//      the outer rect the viewer actually has. Feeding it its own output cannot
//      change its output.
//
// `scale` is continuous and clamped at 1: a viewport larger than the grid never
// magnifies (that would blur text and inflate the cell metric); a viewport
// smaller than the grid shrinks continuously rather than in steps, because a
// stepped scale re-crosses its own threshold under a slow drag and flickers.
//
// Letterboxing is deliberately NOT offered when capacity < applied. It is
// impossible in that direction: a 390px phone cannot letterbox 163 columns.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TerminalPresentation = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Below this, glyphs stop being legible and panning is preferable to shrinking
  // further. Expressed against the un-scaled cell width in CSS pixels.
  const MIN_EFFECTIVE_CELL_WIDTH = 3.5;

  function finitePositive(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
  }

  /**
   * Compute how a non-owner should present the applied grid.
   *
   * Pure: depends only on its arguments, mutates nothing, and returns a fresh
   * object. Callers may invoke it every frame.
   *
   * @param {{width:number,height:number}} outer  the viewer's usable rect, CSS px
   * @param {{cols:number,rows:number}} applied   the authoritative grid
   * @param {{width:number,height:number}} cell   un-scaled cell metric, CSS px
   * @param {{col:number,row:number}} [focus]     cell to keep visible when panning
   * @returns {{regime:string,scale:number,offsetX:number,offsetY:number,
   *            gridWidth:number,gridHeight:number,effectiveCellWidth:number,
   *            visibleCols:number,visibleRows:number,clipped:boolean}|null}
   */
  function computePresentation(outer, applied, cell, focus) {
    if (!outer || !applied || !cell) return null;
    if (!finitePositive(outer.width) || !finitePositive(outer.height)) return null;
    if (!finitePositive(cell.width) || !finitePositive(cell.height)) return null;
    if (!Number.isInteger(applied.cols) || !Number.isInteger(applied.rows)) return null;
    if (applied.cols <= 0 || applied.rows <= 0) return null;

    const gridWidth = applied.cols * cell.width;
    const gridHeight = applied.rows * cell.height;

    // Clamped at 1 — never magnify.
    const fit = Math.min(outer.width / gridWidth, outer.height / gridHeight);
    let scale = Math.min(1, fit);

    // Refuse to shrink past legibility; pan the remainder instead.
    if (cell.width * scale < MIN_EFFECTIVE_CELL_WIDTH) {
      scale = MIN_EFFECTIVE_CELL_WIDTH / cell.width;
      if (scale > 1) scale = 1;
    }

    const shownWidth = gridWidth * scale;
    const shownHeight = gridHeight * scale;
    const overflowX = Math.max(0, shownWidth - outer.width);
    const overflowY = Math.max(0, shownHeight - outer.height);
    const clipped = overflowX > 0.5 || overflowY > 0.5;

    let offsetX = 0;
    let offsetY = 0;
    if (clipped && focus && Number.isFinite(focus.col) && Number.isFinite(focus.row)) {
      // Centre the focused cell, then clamp so panning never exposes dead space.
      const focusX = (focus.col + 0.5) * cell.width * scale;
      const focusY = (focus.row + 0.5) * cell.height * scale;
      offsetX = Math.min(overflowX, Math.max(0, focusX - outer.width / 2));
      offsetY = Math.min(overflowY, Math.max(0, focusY - outer.height / 2));
    }

    return {
      // 'exact'  — the grid fits unscaled; this is what an owner always gets.
      // 'scale'  — shrunk to fit, wholly visible.
      // 'pan'    — cannot fit even at the legibility floor; a window is shown.
      regime: clipped ? 'pan' : (scale === 1 ? 'exact' : 'scale'),
      scale,
      offsetX,
      offsetY,
      gridWidth,
      gridHeight,
      effectiveCellWidth: cell.width * scale,
      visibleCols: Math.min(applied.cols, Math.floor(outer.width / (cell.width * scale))),
      visibleRows: Math.min(applied.rows, Math.floor(outer.height / (cell.height * scale))),
      clipped,
    };
  }

  /**
   * Map a pointer position in the OUTER element's coordinate space to a grid
   * cell, honouring the presentation transform.
   *
   * Coordinate correctness is the invariant, not just visual correctness: a view
   * can render the right pixels and still resolve a tap to the wrong cell.
   * `getBoundingClientRect()` is transform-aware, so a caller that measures the
   * inner stage and divides by the cell metric silently double-counts the scale.
   * Callers must pass OUTER-relative coordinates and let this undo the transform.
   *
   * @returns {{col:number,row:number}|null} clamped to the grid, or null
   */
  function pointerToCell(presentation, applied, cell, pointer) {
    if (!presentation || !applied || !cell || !pointer) return null;
    if (!finitePositive(presentation.scale)) return null;
    if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return null;

    const gridX = (pointer.x + presentation.offsetX) / presentation.scale;
    const gridY = (pointer.y + presentation.offsetY) / presentation.scale;

    const col = Math.floor(gridX / cell.width);
    const row = Math.floor(gridY / cell.height);
    if (!Number.isFinite(col) || !Number.isFinite(row)) return null;

    return {
      col: Math.min(applied.cols - 1, Math.max(0, col)),
      row: Math.min(applied.rows - 1, Math.max(0, row)),
    };
  }

  return { computePresentation, pointerToCell, MIN_EFFECTIVE_CELL_WIDTH };
});
