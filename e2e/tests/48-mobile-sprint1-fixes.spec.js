// @ts-check
const { test, expect, devices } = require('@playwright/test');
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

test.use({ ...devices['iPhone 14'] });

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await page.evaluate(() => {
    document.body.classList.remove('keyboard-open');
    if (window.app) window.app._overlayExplicitlyHidden = false;
  }).catch(() => {});
  await attachFailureArtifacts(page, testInfo);
});

// ---------------------------------------------------------------------------
// P0-1: Install button does not overlap bottom nav
// ---------------------------------------------------------------------------
test.describe('P0-1: Install button vs bottom nav overlap', () => {
  test('install button sits above the bottom nav at iPhone 14 viewport', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // The install button is injected by the PWA beforeinstallprompt handler.
    // In CI there is no real install prompt, so we inject one matching the
    // real creation (index.html:724) — same id, class, and no inline styles —
    // so the CSS rules apply identically.
    await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.id = 'installBtn';
      btn.className = 'install-btn';
      btn.innerHTML = '<span class="icon" aria-hidden="true">Install</span> Install App';
      document.body.appendChild(btn);
    });

    const installBtn = page.locator('#installBtn');
    const bottomNav = page.locator('.bottom-nav');

    await expect(installBtn).toBeVisible();
    await expect(bottomNav).toBeVisible();

    const installBox = await installBtn.boundingBox();
    const navBox = await bottomNav.boundingBox();

    expect(installBox).not.toBeNull();
    expect(navBox).not.toBeNull();

    // Install button bottom must be above or at the bottom nav top (no overlap)
    expect(installBox.y + installBox.height).toBeLessThanOrEqual(navBox.y + 1); // +1 for rounding
  });

  test('install button CSS bottom offset accounts for bottom nav height', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Inject matching the real PWA install button structure
    await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.id = 'installBtn';
      btn.className = 'install-btn';
      btn.innerHTML = '<span class="icon" aria-hidden="true">Install</span> Install App';
      document.body.appendChild(btn);
    });

    // At mobile viewport the install button CSS sets
    // bottom: calc(52px + 20px + env(safe-area-inset-bottom, 0px))
    // so the resolved bottom value should be >= 72px (52 + 20)
    const installBottom = await page.evaluate(() => {
      const btn = document.getElementById('installBtn');
      if (!btn) return '';
      return getComputedStyle(btn).bottom;
    });

    const numericBottom = parseFloat(installBottom);
    expect(numericBottom).toBeGreaterThanOrEqual(72);
  });
});

// ---------------------------------------------------------------------------
// P0-2: Viewport meta tag allows zoom
// ---------------------------------------------------------------------------
test.describe('P0-2: Viewport meta tag', () => {
  test('viewport meta includes viewport-fit=cover and interactive-widget=resizes-content', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);

    const content = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]');
      return meta ? meta.getAttribute('content') : '';
    });

    expect(content).toContain('viewport-fit=cover');
    expect(content).toContain('interactive-widget=resizes-content');
  });

  test('maximum-scale is greater than 1.0 (WCAG zoom compliance)', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);

    const maxScale = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]');
      if (!meta) return null;
      const content = meta.getAttribute('content') || '';
      const match = content.match(/maximum-scale\s*=\s*([\d.]+)/);
      return match ? parseFloat(match[1]) : null;
    });

    // maximum-scale must exist and be > 1.0 to not block user zoom
    expect(maxScale).not.toBeNull();
    expect(maxScale).toBeGreaterThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// P0-9: Touch targets meet 44px minimum
// ---------------------------------------------------------------------------
test.describe('P0-9: Touch target sizes', () => {
  test('tab-new-main button meets 44px minimum touch target', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const btn = page.locator('.tab-new-main');
    await expect(btn).toBeAttached();

    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('tab-new-dropdown button meets 44px minimum touch target', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const btn = page.locator('.tab-new-dropdown');
    await expect(btn).toBeAttached();

    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});

// ---------------------------------------------------------------------------
// P0-6: Terminal fits mobile viewport
// ---------------------------------------------------------------------------
test.describe('P0-6: fitTerminal mobile column adjustment', () => {
  test('terminal columns are in mobile range at iPhone 14 viewport', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'fit-cols-iphone14');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const dims = await getTerminalDimensions(page);
    // At 390px with no scrollbar subtraction on mobile, expect >= 40 cols
    expect(dims.cols).toBeGreaterThanOrEqual(40);
    // Should still be in mobile range (not desktop-level 80+)
    expect(dims.cols).toBeLessThan(80);
  });

  test('app detects mobile at iPhone 14 viewport', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const isMobile = await page.evaluate(() => window.app.isMobile);
    expect(isMobile).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P0-5: Context menu renders as bottom sheet on mobile
// ---------------------------------------------------------------------------
test.describe('P0-5: Context menu bottom sheet on mobile', () => {
  test('context menu element exists with expected menu items', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const menu = page.locator('#termContextMenu');
    await expect(menu).toBeAttached();
    await expect(menu).toHaveClass(/term-context-menu/);

    const items = menu.locator('.ctx-item');
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
  });

  test('triggering contextmenu on terminal shows bottom sheet', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'ctx-menu-mobile');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Dispatch a contextmenu event on the terminal area
    await page.evaluate(() => {
      const xtermScreen = document.querySelector('.xterm-screen');
      if (xtermScreen) {
        xtermScreen.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 100,
          clientY: 100,
        }));
      }
    });

    // Wait for menu to become visible
    const menu = page.locator('#termContextMenu');
    await expect(menu).toBeVisible({ timeout: 3000 });

    // On mobile, the menu should be positioned as a bottom sheet (fixed, bottom: 0)
    const computedStyles = await page.evaluate(() => {
      const el = document.getElementById('termContextMenu');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        position: cs.position,
        bottom: cs.bottom,
      };
    });

    expect(computedStyles).not.toBeNull();
    expect(computedStyles.position).toBe('fixed');
    expect(computedStyles.bottom).toBe('0px');
  });
});

// ---------------------------------------------------------------------------
// P0-7: Network reconnection settings
// ---------------------------------------------------------------------------
test.describe('P0-7: Network reconnection constants', () => {
  test('maxReconnectAttempts is 10', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const maxAttempts = await page.evaluate(() => window.app.maxReconnectAttempts);
    expect(maxAttempts).toBe(10);
  });

  test('reconnectDelay is 1000ms', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const delay = await page.evaluate(() => window.app.reconnectDelay);
    expect(delay).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// P0-4: Keyboard detection initial state
// ---------------------------------------------------------------------------
test.describe('P0-4: Keyboard detection', () => {
  test('keyboard-open class is not present on body initially', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const body = page.locator('body');
    await expect(body).not.toHaveClass(/keyboard-open/);
  });
});

// ---------------------------------------------------------------------------
// Cross-device: mobile detection and bottom nav
// ---------------------------------------------------------------------------
test.describe('Cross-device mobile detection', () => {
  test('app detects mobile correctly at iPhone 14 viewport', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const viewport = page.viewportSize();
    expect(viewport.width).toBeLessThan(500);

    const isMobile = await page.evaluate(() => window.app.isMobile);
    expect(isMobile).toBe(true);
  });

  test('bottom nav is visible at mobile viewport', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const nav = page.locator('.bottom-nav');
    await expect(nav).toBeVisible();
  });
});
