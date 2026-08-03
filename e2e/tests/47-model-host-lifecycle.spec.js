'use strict';

const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const { installLegacyClientRoutes } = require('../helpers/legacy-client');
const { joinSessionAndStartTerminal } = require('../helpers/terminal-helpers');

test.describe('model-host lifecycle compatibility', () => {
  let instance;

  test.afterEach(async () => {
    if (instance && instance.server) await instance.server.close();
    instance = null;
  });

  test('a pre-change page keeps voice and sticky affordances against the upgraded server', async ({ page }) => {
    instance = await createServer({ stt: false, stickyNotes: false });
    await installLegacyClientRoutes(page);
    await page.goto(instance.url);
    await page.waitForFunction(() => window.app && window.app.socket && window.app.socket.readyState === 1);
    const sessionId = await createSessionViaApi(instance.port, 'Legacy lifecycle');
    await joinSessionAndStartTerminal(page, sessionId);

    await page.evaluate(() => {
      window.app.stickyNotesEnabled = true;
      window.app.handleMessage({ type: 'sticky_notes_status', status: 'ready' });
      window.app.handleMessage({
        type: 'voice_status',
        status: 'ready',
        voiceInput: { localStatus: 'ready', localEnabled: true, cloudAvailable: false }
      });
      window.app.handleMessage({ type: 'model_lifecycle_status', stt: 'idle', stickyNotes: 'idle' });
    });

    const sticky = page.locator('#stickyNoteBtn');
    const mic = page.locator('#voiceInputBtn');
    await expect(sticky).toBeVisible();
    await expect(mic).toBeVisible();
    await sticky.click();
    await expect(sticky).toHaveAttribute('aria-pressed', 'true');
  });

  test('a negotiated page labels demand and reconnect lifecycle states', async ({ page }) => {
    instance = await createServer({ stt: false, stickyNotes: false });
    await page.goto(instance.url);
    await page.waitForFunction(() => window.app && window.app.socket && window.app.socket.readyState === 1);
    const sessionId = await createSessionViaApi(instance.port, 'Lifecycle labels');
    await joinSessionAndStartTerminal(page, sessionId);

    await page.evaluate(() => {
      window.app.handleMessage({
        type: 'voice_status',
        status: 'ready',
        voiceInput: { localStatus: 'ready', localEnabled: true, cloudAvailable: false }
      });
      window.app.handleMessage({
        type: 'model_lifecycle_status',
        stt: 'idle',
        stickyNotes: 'idle',
      });
    });
    const sticky = page.locator('#stickyNoteBtn');
    const mic = page.locator('#voiceInputBtn');
    await expect(mic).toHaveAttribute('data-model-state', 'idle');
    await expect(mic).toHaveAttribute('title', /starts when recording/);
    await expect(sticky).toHaveAttribute('title', /starts when opened/);

    await page.evaluate(() => {
      window.app.handleMessage({
        type: 'model_lifecycle_status',
        stt: 'restarting',
        stickyNotes: 'restarting',
      });
    });
    await expect(mic).toBeEnabled();
    await expect(mic).toHaveAttribute('title', /reconnecting/);
    await expect(sticky).toHaveAttribute('title', /reconnecting/);
  });

  test('mobile users can open and close the lifecycle-aware status card', async ({ browser }) => {
    instance = await createServer({ stt: false, stickyNotes: false });
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36',
    });
    const mobilePage = await context.newPage();
    try {
      await mobilePage.goto(instance.url);
      await mobilePage.waitForFunction(() => window.app && window.app.socket && window.app.socket.readyState === 1);
      const sessionId = await createSessionViaApi(instance.port, 'Mobile lifecycle');
      await joinSessionAndStartTerminal(mobilePage, sessionId);
      await mobilePage.evaluate(() => {
        window.app.stickyNotesEnabled = true;
        window.app.handleMessage({
          type: 'model_lifecycle_status',
          stt: 'idle',
          stickyNotes: 'idle',
        });
      });
      const status = mobilePage.locator('#navSticky');
      await expect(status).toBeVisible();
      await status.click();
      await expect(mobilePage.locator('#stickyNoteCard')).toBeVisible();
      await expect(status).toHaveAttribute('aria-pressed', 'true');
      await mobilePage.getByRole('button', { name: 'Minimize status note' }).click();
      await expect(mobilePage.locator('#stickyNoteCard')).toBeHidden();
    } finally {
      await context.close();
    }
  });
});
