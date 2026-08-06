'use strict';

// AC-10 (Part B): per-component visual evidence.
//
// The existing evidence captures the whole shell at several viewports. That
// proves the layout holds, but a reviewer cannot judge a modal, a menu or a
// panel from a full-page screenshot where it occupies a tenth of the frame —
// and half of these surfaces never appear in a shell capture at all because
// they must be opened first.
//
// This drives each surface open and captures THAT ELEMENT, in both themes at
// desktop and mobile widths. Every attachment is named
// <component>-<viewport>-<theme>.png so a review can diff a single component
// across themes rather than hunting for it inside a page.
//
// Surfaces that cannot be opened in a given viewport (a desktop-only dock, a
// mobile-only key panel) are recorded as skipped with the reason, so the
// matrix is honest about its own coverage instead of silently thinning.

const { test, expect } = require('@playwright/test');
const { waitForAppReady, waitForTerminalCanvas } = require('../helpers/terminal-helpers');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 393, height: 852 },
];
const THEMES = ['dark', 'light'];

// Each surface: how to reveal it, and what element to frame.
const SURFACES = [
  {
    name: 'session-tab-bar',
    selector: '#sessionTabsBar',
    open: async () => {},
  },
  {
    name: 'tool-cards',
    selector: '.overlay-content',
    open: async () => {},
  },
  {
    name: 'settings-modal',
    selector: '#settingsModal',
    open: async (page) => page.evaluate(() => window.app.setupSettingsModal
      ? document.getElementById('settingsBtn')?.click()
      : null),
  },
  {
    name: 'new-session-modal',
    selector: '#newSessionModal',
    open: async (page) => page.evaluate(() => window.app.showNewSessionModal
      && window.app.showNewSessionModal()),
  },
  {
    name: 'file-browser-panel',
    selector: '.file-browser-panel',
    open: async (page) => page.evaluate(async () => {
      const fb = window.app._ensureFileBrowser
        ? window.app._ensureFileBrowser() : window.app._fileBrowserPanel;
      if (fb) await fb.open();
    }),
  },
  {
    name: 'bottom-nav',
    selector: '.bottom-nav',
    open: async () => {},
  },
  {
    name: 'extra-keys',
    selector: '.extra-keys-container, #extraKeys',
    open: async () => {},
  },
];

test.describe('AC-10 per-component visual evidence', () => {
  let server; let port; let url;

  test.beforeAll(async () => { ({ server, port, url } = await createServer()); });
  test.afterAll(async () => { if (server) await server.close().catch(() => {}); });

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      test(`${viewport.name} ${theme}: captures each component surface`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await createSessionViaApi(port, `evidence-${viewport.name}-${theme}`);
        await page.goto(url);
        await waitForAppReady(page);
        await waitForTerminalCanvas(page);
        await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
        await page.evaluate(() => document.fonts && document.fonts.ready);
        await page.waitForTimeout(300);

        const captured = [];
        const skipped = [];

        for (const surface of SURFACES) {
          try {
            await surface.open(page);
            await page.waitForTimeout(350);
          } catch (_) {
            skipped.push(`${surface.name} (could not open)`);
            continue;
          }

          const el = page.locator(surface.selector).first();
          const visible = await el.isVisible().catch(() => false);
          if (!visible) {
            // Genuinely absent at this viewport (desktop-only dock, mobile-only
            // key panel). Recorded rather than silently dropped.
            skipped.push(`${surface.name} (not present at ${viewport.name})`);
            continue;
          }

          const box = await el.boundingBox().catch(() => null);
          if (!box || box.width < 8 || box.height < 8) {
            skipped.push(`${surface.name} (zero-sized)`);
            continue;
          }

          await testInfo.attach(`${surface.name}-${viewport.name}-${theme}.png`, {
            body: await el.screenshot({ animations: 'disabled' }),
            contentType: 'image/png',
          });
          captured.push(surface.name);

          // Close modal-ish surfaces so the next capture is not occluded.
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(200);
        }

        console.log(`[AC-10 ${viewport.name}/${theme}] captured=${captured.length} (${captured.join(', ')})`);
        if (skipped.length) console.log(`[AC-10 ${viewport.name}/${theme}] skipped: ${skipped.join('; ')}`);

        // The matrix must actually produce evidence. If selectors drift, this
        // fails rather than quietly attaching nothing.
        expect(captured.length,
          `no component evidence captured for ${viewport.name}/${theme}; skipped: ${skipped.join('; ')}`)
          .toBeGreaterThanOrEqual(2);
      });
    }
  }
});
