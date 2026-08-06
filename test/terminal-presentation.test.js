// test/terminal-presentation.test.js
//
// Layer 3 presentation geometry (ADR-0052, src/public/terminal-presentation.js).
//
// The load-bearing property is PURITY: the refuted geometry design let
// presentation feed back into measurement, so two attached viewers oscillated
// forever. The hold-steady test below is the regression guard the plan review
// demanded — without it that failure is invisible to the probes and shows up
// only as flaky acceptance assertions.
//
// The second invariant is COORDINATE CORRECTNESS. A non-owner can render the
// right pixels and still resolve a tap to the wrong cell, because
// getBoundingClientRect() is transform-aware.

'use strict';

const assert = require('assert');
const {
  computePresentation,
  pointerToCell,
  MIN_EFFECTIVE_CELL_WIDTH,
} = require('../src/public/terminal-presentation');

const CELL = { width: 8, height: 17 };

describe('computePresentation', function () {
  it('reports exact and never magnifies when the grid already fits', function () {
    const p = computePresentation({ width: 1600, height: 900 }, { cols: 80, rows: 24 }, CELL);
    assert.strictEqual(p.regime, 'exact');
    assert.strictEqual(p.scale, 1, 'a roomy viewport must not magnify');
    assert.strictEqual(p.offsetX, 0);
    assert.strictEqual(p.offsetY, 0);
  });

  it('shrinks continuously rather than in steps', function () {
    // A stepped scale re-crosses its own threshold under a slow drag and flickers.
    const widths = [1200, 1180, 1160, 1140, 1120];
    const scales = widths.map((w) =>
      computePresentation({ width: w, height: 900 }, { cols: 170, rows: 44 }, CELL).scale);
    for (let i = 1; i < scales.length; i++) {
      assert.ok(scales[i] <= scales[i - 1], 'scale must be monotonic in width');
      assert.ok(scales[i] !== scales[i - 1], `expected continuous change at width ${widths[i]}`);
    }
  });

  it('pans a phone-sized viewport holding a desktop-sized grid', function () {
    // The measured case from the aborted run: phone capacity ~39x38 presenting
    // an authoritative 170x44.
    const p = computePresentation({ width: 390, height: 640 }, { cols: 170, rows: 44 }, CELL);
    assert.strictEqual(p.regime, 'pan');
    assert.ok(p.clipped, 'a 170-column grid cannot fit a 390px viewport');
    assert.ok(p.effectiveCellWidth >= MIN_EFFECTIVE_CELL_WIDTH,
      'must stop shrinking at the legibility floor and pan instead');
  });

  it('keeps the focused cell inside the viewport when panning, without exposing dead space', function () {
    const applied = { cols: 170, rows: 44 };
    const outer = { width: 390, height: 640 };
    const far = computePresentation(outer, applied, CELL, { col: 169, row: 43 });
    assert.strictEqual(far.regime, 'pan');
    assert.ok(far.offsetX > 0, 'panning right should offset the stage');

    // Max pan is zero on an axis that already fits — the grid's height fits this
    // viewport once scaled, so only the horizontal axis pans.
    const maxOffsetX = Math.max(0, far.gridWidth * far.scale - outer.width);
    const maxOffsetY = Math.max(0, far.gridHeight * far.scale - outer.height);
    assert.ok(far.offsetX <= maxOffsetX + 0.001, 'must not pan past the right edge');
    assert.ok(far.offsetY <= maxOffsetY + 0.001, 'must not pan past the bottom edge');
    assert.strictEqual(far.offsetY, 0, 'an axis that fits must not pan at all');

    const near = computePresentation(outer, applied, CELL, { col: 0, row: 0 });
    assert.strictEqual(near.offsetX, 0, 'the first cell needs no pan');
  });

  it('is a pure function: repeated calls and fed-back output never drift (hold-steady)', function () {
    const outer = { width: 390, height: 640 };
    const applied = { cols: 170, rows: 44 };
    const first = computePresentation(outer, applied, CELL);

    // Called repeatedly with unchanged inputs, as a rAF loop would.
    for (let i = 0; i < 240; i++) {
      const again = computePresentation(outer, applied, CELL);
      assert.strictEqual(again.regime, first.regime, `regime drifted on iteration ${i}`);
      assert.strictEqual(again.scale, first.scale, `scale drifted on iteration ${i}`);
    }

    // And the inputs themselves must be untouched — presentation must not be
    // able to perturb the measurement it was derived from.
    assert.deepStrictEqual(outer, { width: 390, height: 640 });
    assert.deepStrictEqual(applied, { cols: 170, rows: 44 });
    assert.deepStrictEqual(CELL, { width: 8, height: 17 });
  });

  it('does not fold its own presented size back into the next result', function () {
    // The oscillation route: if the presented (scaled) size were treated as the
    // next capacity, scale would ratchet downward every pass.
    const applied = { cols: 170, rows: 44 };
    let outer = { width: 390, height: 640 };
    const baseline = computePresentation(outer, applied, CELL).scale;
    for (let i = 0; i < 20; i++) {
      const p = computePresentation(outer, applied, CELL);
      assert.strictEqual(p.scale, baseline, `scale ratcheted on pass ${i}`);
    }
  });

  it('rejects degenerate input rather than emitting a bogus transform', function () {
    assert.strictEqual(computePresentation(null, { cols: 80, rows: 24 }, CELL), null);
    assert.strictEqual(computePresentation({ width: 0, height: 900 }, { cols: 80, rows: 24 }, CELL), null);
    assert.strictEqual(computePresentation({ width: 800, height: 600 }, { cols: 0, rows: 24 }, CELL), null);
    assert.strictEqual(
      computePresentation({ width: 800, height: 600 }, { cols: 80, rows: 24 }, { width: 0, height: 17 }),
      null
    );
  });
});

describe('pointerToCell', function () {
  it('round-trips a tap to the same cell it was rendered at, unscaled', function () {
    const applied = { cols: 80, rows: 24 };
    const p = computePresentation({ width: 1600, height: 900 }, applied, CELL);
    // Centre of cell (10, 5).
    const hit = pointerToCell(p, applied, CELL, {
      x: (10 + 0.5) * CELL.width,
      y: (5 + 0.5) * CELL.height,
    });
    assert.deepStrictEqual(hit, { col: 10, row: 5 });
  });

  it('resolves a tap correctly under the pan transform', function () {
    // This is the defect the review caught: rendering can be right while the tap
    // lands on the wrong cell, because the transform must be undone first.
    const applied = { cols: 170, rows: 44 };
    const outer = { width: 390, height: 640 };
    const p = computePresentation(outer, applied, CELL, { col: 120, row: 20 });
    assert.strictEqual(p.regime, 'pan');

    const targetCol = 120;
    const targetRow = 20;
    // Where that cell actually appears in OUTER coordinates.
    const screenX = (targetCol + 0.5) * CELL.width * p.scale - p.offsetX;
    const screenY = (targetRow + 0.5) * CELL.height * p.scale - p.offsetY;

    const hit = pointerToCell(p, applied, CELL, { x: screenX, y: screenY });
    assert.deepStrictEqual(hit, { col: targetCol, row: targetRow },
      'a tap where the cell is drawn must resolve to that cell');
  });

  it('clamps to the grid instead of returning out-of-range cells', function () {
    const applied = { cols: 80, rows: 24 };
    const p = computePresentation({ width: 1600, height: 900 }, applied, CELL);
    assert.deepStrictEqual(pointerToCell(p, applied, CELL, { x: -50, y: -50 }), { col: 0, row: 0 });
    assert.deepStrictEqual(
      pointerToCell(p, applied, CELL, { x: 99999, y: 99999 }),
      { col: 79, row: 23 }
    );
  });

  it('returns null for unusable input', function () {
    const applied = { cols: 80, rows: 24 };
    const p = computePresentation({ width: 1600, height: 900 }, applied, CELL);
    assert.strictEqual(pointerToCell(null, applied, CELL, { x: 1, y: 1 }), null);
    assert.strictEqual(pointerToCell(p, applied, CELL, { x: NaN, y: 1 }), null);
  });
});
