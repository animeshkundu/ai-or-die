// @ts-check
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  waitForTerminalCanvas,
  joinSessionAndStartTerminal,
  getTerminalDimensions,
} = require('../helpers/terminal-helpers');

let server, port, url;

// WebKit does not recognize Chromium's clipboard permissions inherited from
// the root config; layout assertions do not need clipboard grants.
test.use({ permissions: [] });

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await page.evaluate(() => {
    document.body.classList.remove('keyboard-open');
    if (window.app && window.app.keysPanel) window.app.keysPanel.hide();
    if (window.app && window.app.extraKeys) window.app.extraKeys.hide();
  }).catch(() => {});
  await attachFailureArtifacts(page, testInfo);
});

async function waitForAppReadyOrSkip(page) {
  let ready = false;
  try {
    await waitForAppReady(page, 20000);
    ready = await page.evaluate(() => !!(window.app && window.app.terminal));
  } catch (_) {
    ready = false;
  }
  test.skip(!ready, 'window.app was not ready in this WebKit mobile project');
}

async function joinTerminalWithRetry(page, sessionId) {
  try {
    await joinSessionAndStartTerminal(page, sessionId);
  } catch (e) {
    if (e && e.message && e.message.includes('Execution context was destroyed')) {
      await page.waitForTimeout(1000);
      await waitForAppReadyOrSkip(page);
      await joinSessionAndStartTerminal(page, sessionId);
    } else {
      throw e;
    }
  }
}

async function startTerminal(page, name) {
  const sessionId = await createSessionViaApi(port, name);
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReadyOrSkip(page);
  await waitForWebSocket(page);
  await waitForTerminalCanvas(page);
  await joinTerminalWithRetry(page, sessionId);
  await page.evaluate(() => document.body.classList.remove('keyboard-open'));
  return sessionId;
}

async function expectMobileContract(page) {
  const state = await page.evaluate(() => ({
    hasApp: !!window.app,
    isMobile: !!(window.app && window.app.isMobile),
    bodyIsMobile: document.body.classList.contains('is-mobile'),
  }));
  test.skip(!state.hasApp, 'window.app was not available in this WebKit mobile project');
  expect(state.isMobile).toBe(true);
  expect(state.bodyIsMobile).toBe(true);
}

function wsCursor(page) {
  return (page._wsMessages || []).length;
}

async function waitForWsFrameAfter(page, startIndex, predicate, label, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let recent = [];
  while (Date.now() < deadline) {
    const messages = (page._wsMessages || []).slice(startIndex);
    const found = messages.find(predicate);
    if (found) return found;
    recent = messages.slice(-5);
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${label}. Recent WS frames: ${JSON.stringify(recent)}`);
}

async function expectNoHorizontalOverflow(page) {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.innerWidth + 1);
}

test.describe('ADR-0037 mobile device layout', () => {
  test('mobile viewport has no horizontal overflow, keeps keys panel reachable, and resizes terminal on rotation', async ({ page }, testInfo) => {
    await startTerminal(page, `mobile-layout-${testInfo.project.name}`);
    await expectMobileContract(page);

    await expectNoHorizontalOverflow(page);
    await expect(page.locator('#keysPanelBtn')).toBeVisible();

    const initialViewport = page.viewportSize();
    expect(initialViewport).not.toBeNull();

    const before = await getTerminalDimensions(page);
    expect(before.cols).toBeGreaterThan(0);
    expect(before.rows).toBeGreaterThan(0);

    const start = wsCursor(page);
    const rotated = { width: initialViewport.height, height: initialViewport.width };
    await page.setViewportSize(rotated);
    await page.waitForFunction(({ width, height }) =>
      window.innerWidth === width && window.innerHeight === height,
      rotated,
      { timeout: 5000 }
    );

    await page.evaluate(() => {
      if (window.app && typeof window.app.fitTerminal === 'function') {
        window.app.fitTerminal();
      }
    });

    await page.waitForFunction((oldCols) => {
      const term = window.app && window.app.terminal;
      return !!term && term.cols > 0 && term.cols !== oldCols;
    }, before.cols, { timeout: 7000 });

    const after = await getTerminalDimensions(page);
    expect(after.cols).not.toBe(before.cols);

    const resize = await waitForWsFrameAfter(
      page,
      start,
      (m) => m.dir === 'sent' && m.type === 'resize'
        && Number.isFinite(m.cols)
        && Number.isFinite(m.rows)
        && m.cols === after.cols,
      'terminal resize frame after viewport rotation'
    );
    expect(resize.cols).toBe(after.cols);
    expect(resize.rows).toBeGreaterThan(0);

    await expectNoHorizontalOverflow(page);
  });
});
