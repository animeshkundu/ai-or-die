'use strict';

// Layer 3 coordinate correctness (ADR-0052).
//
// Rendering the right pixels is not sufficient. A non-owner viewer presents the
// authoritative grid through a transform on the inner stage, and
// getBoundingClientRect() is transform-aware — so a caller that measures the
// stage and divides by the cell metric silently double-counts the scale and
// resolves a tap to the wrong cell. The plan review called this out explicitly:
// AC-2's grid-equality assertion does not cover it, and it is invisible to both
// geometry probes.
//
// This runs on the WebKit phone profile because that is where a non-owner
// actually pans: a phone attached to a desktop-owned session cannot fit the
// applied grid, so scale < 1 and the offsets are non-zero. On a desktop profile
// the regime is 'exact' and the mapping is trivially correct, which would make
// the test pass without exercising anything.

const { test, expect } = require('@playwright/test');
const {
  waitForAppReady, waitForTerminalCanvas, joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');

test.describe('ADR-0052 Layer 3 pointer mapping', () => {
  let server; let port; let url;

  test.beforeAll(async () => {
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close().catch(() => {});
  });

  test('a tap where a cell is drawn resolves to that cell under the presentation transform', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'pointer-mapping');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await page.waitForTimeout(1500);

    // The pure module must be loaded in the page — it is what both the renderer
    // and any hit-testing path depend on.
    const hasModule = await page.evaluate(() => typeof window.TerminalPresentation === 'object');
    expect(hasModule, 'TerminalPresentation must be available to the client').toBe(true);

    const result = await page.evaluate(() => {
      const P = window.TerminalPresentation;
      const outerEl = document.querySelector('.terminal-wrapper');
      const term = window.app && window.app.terminal;
      if (!outerEl || !term) return { error: 'missing terminal or wrapper' };

      const dims = term._core && term._core._renderService && term._core._renderService.dimensions;
      const cell = dims && dims.css && dims.css.cell;
      if (!cell || !(cell.width > 0)) return { error: 'cell metric unavailable' };

      const rect = outerEl.getBoundingClientRect();
      // Present a grid deliberately wider than this viewport so the regime is
      // not 'exact'; this is the situation a phone is in against a desktop.
      const applied = { cols: 170, rows: 44 };
      const p = P.computePresentation(
        { width: rect.width, height: rect.height },
        applied,
        { width: cell.width, height: cell.height },
        { col: 120, row: 20 }
      );
      if (!p) return { error: 'no presentation computed' };

      // For a spread of cells, compute where each is drawn in OUTER coordinates
      // and confirm the inverse maps back to the same cell.
      const probes = [
        { col: 0, row: 0 },
        { col: 1, row: 1 },
        { col: 84, row: 21 },
        { col: 120, row: 20 },
        { col: applied.cols - 1, row: applied.rows - 1 },
      ];
      const mismatches = [];
      for (const cellRef of probes) {
        const x = (cellRef.col + 0.5) * cell.width * p.scale - p.offsetX;
        const y = (cellRef.row + 0.5) * cell.height * p.scale - p.offsetY;
        const hit = P.pointerToCell(p, applied, { width: cell.width, height: cell.height }, { x, y });
        if (!hit || hit.col !== cellRef.col || hit.row !== cellRef.row) {
          mismatches.push({ want: cellRef, got: hit });
        }
      }
      return {
        regime: p.regime,
        scale: p.scale,
        effectiveCellWidth: p.effectiveCellWidth,
        outerWidth: rect.width,
        mismatches,
      };
    });

    expect(result.error).toBeUndefined();
    // If the grid happened to fit, this profile is not exercising the transform
    // and the assertion below would be vacuous — surface that rather than pass.
    expect(result.regime, 'phone profile must not present a desktop grid exactly').not.toBe('exact');
    expect(result.scale).toBeLessThan(1);
    expect(result.mismatches, `cells resolved to the wrong grid position: ${JSON.stringify(result.mismatches)}`).toEqual([]);
  });

  test('the presented regime holds steady while the viewer sits idle', async ({ page }) => {
    // The refuted design oscillated because presentation perturbed measurement.
    // A non-owner left alone must not drift between regimes or scales.
    const sessionId = await createSessionViaApi(port, 'hold-steady');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await page.waitForTimeout(1500);

    const samples = await page.evaluate(async () => {
      const P = window.TerminalPresentation;
      const outerEl = document.querySelector('.terminal-wrapper');
      const term = window.app.terminal;
      const applied = { cols: 170, rows: 44 };
      const out = [];
      for (let i = 0; i < 24; i++) {
        const dims = term._core._renderService.dimensions;
        const cell = dims.css.cell;
        const rect = outerEl.getBoundingClientRect();
        const p = P.computePresentation(
          { width: rect.width, height: rect.height },
          applied,
          { width: cell.width, height: cell.height }
        );
        out.push(p ? `${p.regime}:${p.scale.toFixed(6)}` : 'null');
        await new Promise((r) => setTimeout(r, 100));
      }
      return out;
    });

    const distinct = Array.from(new Set(samples));
    expect(distinct, `regime/scale drifted while idle: ${JSON.stringify(distinct)}`).toHaveLength(1);
  });
});
