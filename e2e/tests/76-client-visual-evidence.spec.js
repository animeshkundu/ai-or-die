const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const { waitForAppReady, waitForTerminalCanvas } = require('../helpers/terminal-helpers');

test.describe('Client visual evidence', () => {
  let server;
  let port;
  let url;

  test.beforeAll(async () => {
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
  });

  test('captures terminal-first shell at desktop and phone orientations', async ({ page }, testInfo) => {
    const cases = [
      { name: 'desktop-dark', width: 1280, height: 800, theme: null },
      { name: 'desktop-light', width: 1280, height: 800, theme: 'light' },
      { name: 'iphone-portrait-dark', width: 393, height: 852, theme: null },
      { name: 'iphone-portrait-light', width: 393, height: 852, theme: 'light' },
      { name: 'iphone-landscape-dark', width: 852, height: 393, theme: null },
      { name: 'iphone-landscape-light', width: 852, height: 393, theme: 'light' },
      { name: 'compact-landscape-dark', width: 780, height: 493, theme: null },
    ];

    for (const item of cases) {
      await page.setViewportSize({ width: item.width, height: item.height });
      await createSessionViaApi(port, `Visual ${item.name}`);
      await page.goto(url);
      await waitForAppReady(page);
      await waitForTerminalCanvas(page);
      await page.evaluate((theme) => {
        if (theme) document.documentElement.setAttribute('data-theme', theme);
        else document.documentElement.removeAttribute('data-theme');
      }, item.theme);
      await page.evaluate(() => document.fonts && document.fonts.ready);

      const bounds = await page.evaluate(() => {
        const overlay = document.getElementById('overlay').getBoundingClientRect();
        const content = document.querySelector('.overlay-content').getBoundingClientRect();
        const tab = document.getElementById('sessionTabsBar').getBoundingClientRect();
        return {
          overlay: { top: overlay.top, left: overlay.left, right: overlay.right, bottom: overlay.bottom },
          content: { top: content.top, left: content.left, right: content.right },
          tabBottom: tab.bottom,
        };
      });
      expect(bounds.overlay.left).toBeGreaterThanOrEqual(0);
      expect(bounds.overlay.right).toBeLessThanOrEqual(item.width);
      expect(bounds.content.left).toBeGreaterThanOrEqual(0);
      expect(bounds.content.right).toBeLessThanOrEqual(item.width);
      if (item.height <= 480) expect(bounds.content.top).toBeGreaterThanOrEqual(bounds.tabBottom);
      if (item.name.includes('landscape')) {
        const chrome = await page.evaluate(() => {
          const overlay = document.getElementById('overlay').getBoundingClientRect();
          const navigation = document.querySelector('.bottom-nav').getBoundingClientRect();
          const cards = Array.from(document.querySelectorAll('.tool-card'));
          const lastCard = cards[cards.length - 1].getBoundingClientRect();
          return {
            overlayBottom: overlay.bottom,
            navigationTop: navigation.top,
            lastCardBottom: lastCard.bottom,
          };
        });
        expect(chrome.overlayBottom).toBeLessThanOrEqual(chrome.navigationTop);
        expect(chrome.lastCardBottom).toBeLessThanOrEqual(chrome.overlayBottom);
      }

      await testInfo.attach(`${item.name}.png`, {
        body: await page.screenshot({ animations: 'disabled' }),
        contentType: 'image/png',
      });
    }
  });
});
