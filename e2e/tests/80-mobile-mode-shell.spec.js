// @ts-check
const { test, expect } = require('@playwright/test');
const { createServer } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  waitForSentInput,
  wsCursor,
} = require('../helpers/terminal-helpers');

let server, url;

test.use({ permissions: [] });

test.beforeAll(async () => {
  ({ server, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await page.evaluate(() => {
    if (window.MobileMode) window.MobileMode.closeSurface();
  }).catch(() => {});
  await attachFailureArtifacts(page, testInfo);
});

async function startMobileMode(page) {
  setupPageCapture(page);
  await page.goto(url + '?mobileMode=1');
  await waitForAppReady(page, 20000);
  await waitForWebSocket(page, 20000);
  await page.waitForFunction(() => {
    return !!(window.app && window.app.isMobile)
      && document.body.classList.contains('is-mobile')
      && document.body.classList.contains('mobile-mode-active')
      && !!(window.MobileMode && window.MobileMode.getController && window.MobileMode.getController());
  }, null, { timeout: 20000 });
}

test.describe('Mobile mode client shell', () => {
  test('activates on the iPhone/iPad mobile projects when explicitly opted in', async ({ page }) => {
    await startMobileMode(page);

    const state = await page.evaluate(() => ({
      appIsMobile: !!(window.app && window.app.isMobile),
      bodyIsMobile: document.body.classList.contains('is-mobile'),
      mobileModeActive: document.body.classList.contains('mobile-mode-active'),
      hasController: !!(window.MobileMode && window.MobileMode.getController && window.MobileMode.getController()),
    }));

    expect(state).toEqual({
      appIsMobile: true,
      bodyIsMobile: true,
      mobileModeActive: true,
      hasController: true,
    });
    await expect(page.locator('[data-testid="mobile-mode-shell"]')).toBeVisible();
    await expect(page.locator('[data-testid="mobile-compose-fab"]')).toBeVisible();
  });

  test('composer sends exact Channel-2 bytes for message+Enter and immediate interrupt', async ({ page }) => {
    await startMobileMode(page);

    await page.locator('[data-testid="mobile-compose-fab"]').click();
    await expect(page.locator('[data-testid="mobile-composer-sheet"]')).toHaveClass(/active/);
    await page.locator('[data-testid="mobile-composer-text"]').fill('hello mobile mode');

    const sendStart = wsCursor(page);
    await page.locator('[data-testid="mobile-send-composer"]').click();
    const sent = await waitForSentInput(page, sendStart, 'hello mobile mode\r', 'mobile composer send');
    expect(sent.data).toBe('hello mobile mode\r');

    await page.locator('[data-testid="mobile-compose-fab"]').click();
    await expect(page.locator('[data-testid="mobile-composer-sheet"]')).toHaveClass(/active/);

    const stopStart = wsCursor(page);
    await page.locator('[data-testid="mobile-stop-button"]').click();
    const interrupted = await waitForSentInput(page, stopStart, '\x03', 'mobile composer interrupt');
    expect(interrupted.data).toBe('\x03');
  });

  test('opens and closes reusable mobile sheets', async ({ page }) => {
    await startMobileMode(page);

    await page.evaluate(() => window.MobileMode.openSurface('question'));
    const sheet = page.locator('[data-testid="mobile-question-sheet"]');
    await expect(sheet).toHaveClass(/active/);
    await expect(sheet).toHaveAttribute('aria-hidden', 'false');

    await sheet.locator('[data-close-surface]').first().click();
    await expect(sheet).not.toHaveClass(/active/);
    await expect(sheet).toHaveAttribute('aria-hidden', 'true');
  });

  test('destructive permission data gives Approve the danger styling', async ({ page }) => {
    await startMobileMode(page);

    await page.evaluate(() => {
      window.MobileMode.setDecisionStub('permission', {
        kind: 'permission',
        command: 'npm test -- --watch=false',
        cwd: 'C:\\Users\\anikundu\\Software\\ai-or-die',
        destructive: false,
        risk: 'Read-only-ish test command',
      });
      window.MobileMode.openSurface('permission');
    });

    const approve = page.locator('[data-testid="mobile-approve-permission"]');
    await expect(approve).toHaveClass(/primary/);
    await expect(approve).not.toHaveClass(/danger/);

    await page.evaluate(() => {
      window.MobileMode.setDecisionStub('permission', {
        kind: 'permission',
        command: 'rm -rf build/',
        destructive: true,
        risk: 'Destructive filesystem operation',
      });
    });

    await expect(approve).toHaveClass(/danger/);
    await expect(approve).not.toHaveClass(/primary/);
    const destructiveAttr = await approve.getAttribute('data-destructive');
    expect(destructiveAttr).toBe('true');
  });
});
