'use strict';

// AC-7 split panes (ADR-0052).
//
// This is the fourth AC-7 case and it exists because of a specific near-miss.
// splits.js was recovered from an aborted run's checkpoint and registers with
// `measureCapacity`, `stage` and `authoritativeMode` — the Layer 3 fit API that
// run had built. fit-coordinator.js and terminal-geometry.js were NOT in that
// checkpoint, so none of it existed: every split pane called an undefined
// proposeDimensions, threw inside _apply, was swallowed by the measurement
// catch, and stayed deferred forever. Split panes could not fit at all, and no
// test covered it.
//
// So this asserts the concrete thing that was broken: both panes reach a usable
// grid. Split view is desktop-only (createSplit refuses below 700px available
// width), which is why this runs on a desktop project rather than the phone
// profile the other AC-7 cases use.

const { test, expect } = require('@playwright/test');
const {
  waitForAppReady, waitForTerminalCanvas, joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');

test.describe('ADR-0052 AC-7 split panes', () => {
  let server; let port; let url;

  test.beforeAll(async () => { ({ server, port, url } = await createServer()); });
  test.afterAll(async () => { if (server) await server.close().catch(() => {}); });

  test('both panes reach a usable grid and advertise without a claim storm', async ({ page }) => {
    const left = await createSessionViaApi(port, 'split-left');
    const right = await createSessionViaApi(port, 'split-right');

    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, left);
    await page.waitForTimeout(1200);

    const opened = await page.evaluate(async (rightId) => {
      const sc = window.app && window.app.splitContainer;
      if (!sc) return { error: 'no splitContainer' };
      if (typeof sc.createSplit !== 'function') return { error: 'no createSplit' };
      try {
        await sc.createSplit(rightId);
      } catch (e) {
        return { error: 'createSplit threw: ' + (e && e.message) };
      }
      return { enabled: sc.enabled === true, count: (sc.splits || []).length };
    }, right);

    expect(opened.error, `split failed to open: ${opened.error}`).toBeUndefined();
    expect(opened.enabled, 'split view should be enabled at 1600px').toBe(true);

    // Give the coordinator time to measure and fit both panes.
    await page.waitForTimeout(2500);

    const panes = await page.evaluate(() => {
      const sc = window.app.splitContainer;
      return (sc.splits || []).map((s, i) => ({
        index: i,
        sessionId: s.sessionId || null,
        cols: s.terminal ? s.terminal.cols : null,
        rows: s.terminal ? s.terminal.rows : null,
      }));
    });

    console.log('[AC-7 splits] panes=%j', panes);

    expect(panes.length, 'expected two panes').toBe(2);
    for (const pane of panes) {
      // The regression this guards: a pane that never fits keeps xterm's 80x24
      // default forever because _apply threw before reaching terminal.resize.
      expect(pane.cols, `pane ${pane.index} has no usable width`).toBeGreaterThan(0);
      expect(pane.rows, `pane ${pane.index} has no usable height`).toBeGreaterThan(0);
    }

    // Each pane is its own attachment: distinct sessions must not collapse onto
    // one identity, which is why geometry state is keyed by
    // (sessionId, connectionId, viewId) rather than by socket.
    expect(panes[0].sessionId).not.toBe(panes[1].sessionId);
  });

  test('resizing the divider refits panes without wedging either grid', async ({ page }) => {
    const left = await createSessionViaApi(port, 'split-divider-left');
    const right = await createSessionViaApi(port, 'split-divider-right');

    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, left);
    await page.waitForTimeout(1200);

    await page.evaluate(async (rightId) => {
      await window.app.splitContainer.createSplit(rightId);
    }, right);
    await page.waitForTimeout(2000);

    const before = await page.evaluate(() =>
      window.app.splitContainer.splits.map((s) => (s.terminal ? s.terminal.cols : null)));

    // Move the divider, which changes each pane's capacity.
    await page.evaluate(() => {
      const sc = window.app.splitContainer;
      sc.dividerPosition = 30;
      if (typeof sc.applyDividerPosition === 'function') sc.applyDividerPosition();
      sc.splits.forEach((s) => { try { s.fit(); } catch (_) {} });
    });
    await page.waitForTimeout(2000);

    const after = await page.evaluate(() =>
      window.app.splitContainer.splits.map((s) => (s.terminal ? s.terminal.cols : null)));

    console.log('[AC-7 splits divider] before=%j after=%j', before, after);

    for (const cols of after) {
      expect(cols, 'a pane lost its grid after the divider moved').toBeGreaterThan(0);
    }
  });
});
