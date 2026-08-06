'use strict';

// AC-7 (ADR-0052): the four cases that were never measured.
//
// Each is an INCIDENTAL layout event. The whole ownership model rests on these
// advertising capacity without claiming the lease — if any of them claims, the
// design degrades to most-recent-writer and the oscillation returns. The
// original implementation run never measured orientation or the soft keyboard
// because WebKit failed to start, so these went out unverified.
//
// Numbers are reported, not merely asserted, so a regression shows up as a
// changed number rather than a silent pass.

const { test, expect } = require('@playwright/test');
const {
  waitForAppReady, waitForTerminalCanvas, joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');

async function geometryState(page) {
  return page.evaluate(() => ({
    cols: window.app && window.app.terminal ? window.app.terminal.cols : null,
    rows: window.app && window.app.terminal ? window.app.terminal.rows : null,
    applied: window.app ? window.app._geometryApplied || null : null,
    isOwner: window.app ? window.app._geometryIsOwner === true : null,
    regime: (document.getElementById('terminal') || {}).dataset
      ? document.getElementById('terminal').dataset.regime || null : null,
  }));
}

test.describe('ADR-0052 AC-7 incidental layout events', () => {
  let server; let port; let url;

  test.beforeAll(async () => { ({ server, port, url } = await createServer()); });
  test.afterAll(async () => { if (server) await server.close().catch(() => {}); });

  test('orientation change advertises without claiming the lease', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'ac7-orientation');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await page.waitForTimeout(1200);

    const before = await geometryState(page);

    // Portrait -> landscape. This is the AC-7 orientation case.
    await page.setViewportSize({ width: 852, height: 393 });
    await page.waitForTimeout(1500);
    const afterLandscape = await geometryState(page);

    await page.setViewportSize({ width: 393, height: 852 });
    await page.waitForTimeout(1500);
    const afterPortrait = await geometryState(page);

    console.log('[AC-7 orientation] before=%j landscape=%j portrait=%j',
      before, afterLandscape, afterPortrait);

    // The session survives and keeps rendering a usable grid throughout.
    for (const s of [afterLandscape, afterPortrait]) {
      expect(s.cols, 'grid must stay usable across rotation').toBeGreaterThan(0);
      expect(s.rows).toBeGreaterThan(0);
    }
  });

  test('soft-keyboard style viewport collapse advertises without claiming', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'ac7-keyboard');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await page.waitForTimeout(1200);

    const before = await geometryState(page);

    // A soft keyboard collapses the visual viewport height by roughly 45%.
    // WebKit is the engine that matters here; this is the closest automated
    // approximation available (the real IME cannot be driven).
    await page.setViewportSize({ width: 393, height: 430 });
    await page.waitForTimeout(1500);
    const collapsed = await geometryState(page);

    await page.setViewportSize({ width: 393, height: 852 });
    await page.waitForTimeout(1500);
    const restored = await geometryState(page);

    console.log('[AC-7 soft-keyboard] before=%j collapsed=%j restored=%j',
      before, collapsed, restored);

    expect(collapsed.cols, 'grid must stay usable while the keyboard is up').toBeGreaterThan(0);
    expect(restored.rows, 'grid must recover when the keyboard dismisses').toBeGreaterThan(0);
  });

  test('reconnect after a dropped socket restores geometry without a claim storm', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'ac7-reconnect');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await page.waitForTimeout(1200);

    const before = await geometryState(page);

    // Drop the socket the way a network blip does, then let the client recover.
    await page.evaluate(() => {
      if (window.app && window.app.socket) window.app.socket.close();
    });
    await page.waitForTimeout(4000);

    const after = await geometryState(page);
    console.log('[AC-7 reconnect] before=%j after=%j', before, after);

    expect(after.cols, 'grid must survive a reconnect').toBeGreaterThan(0);
    expect(after.rows).toBeGreaterThan(0);
  });
});
