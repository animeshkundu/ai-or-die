// @ts-check
const { test, expect, devices } = require('@playwright/test');
const { createServer } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
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
// Helper: simulate mobile keyboard opening
// Note: Playwright on desktop Chromium cannot trigger a real mobile keyboard.
// visualViewport.height always equals innerHeight in desktop browsers.
// We simulate by applying the keyboard-open class (which is what the app does
// when it detects the keyboard via visualViewport resize on real devices)
// and then test that the CSS correctly hides the chrome elements.
// ---------------------------------------------------------------------------
async function simulateKeyboardOpen(page) {
  await page.evaluate(() => {
    document.body.classList.add('keyboard-open');
  });
  // Wait for CSS transitions (200ms) + margin
  await page.waitForTimeout(350);
}

// ---------------------------------------------------------------------------
// 1. Keyboard hides chrome
// ---------------------------------------------------------------------------
test('keyboard open hides bottom nav and tab bar', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  // Before keyboard: bottom nav should be visible on mobile
  const nav = page.locator('.bottom-nav');
  await expect(nav).toBeVisible();

  // Simulate keyboard opening (applies keyboard-open class as the app does)
  await simulateKeyboardOpen(page);

  // After keyboard: bottom nav and tab bar should be collapsed to 0px
  const navHeight = await page.evaluate(() => {
    const el = document.querySelector('.bottom-nav');
    return el ? getComputedStyle(el).height : null;
  });
  expect(navHeight).toBe('0px');

  const tabBarHeight = await page.evaluate(() => {
    const el = document.querySelector('.session-tabs-bar');
    return el ? getComputedStyle(el).height : null;
  });
  expect(tabBarHeight).toBe('0px');
});

// ---------------------------------------------------------------------------
// 2. Extra keys bar renders with 2 rows and dismiss button
// ---------------------------------------------------------------------------
test('extra keys bar renders two rows and dismiss button', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  // Extra keys bar should exist
  const bar = page.locator('.extra-keys-bar');
  await expect(bar).toBeAttached();

  // Two rows should exist
  const rows = bar.locator('.extra-keys-row');
  await expect(rows).toHaveCount(2);

  // Dismiss button should exist
  const dismissBtn = page.locator('[aria-label="Dismiss keyboard"]');
  await expect(dismissBtn).toBeAttached();
});

// ---------------------------------------------------------------------------
// 3. Extra keys are tappable (>= 44px touch target)
// ---------------------------------------------------------------------------
test('extra key buttons meet 44px minimum touch target', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  // Make extra keys visible so we can measure them
  await page.evaluate(() => {
    if (window.app.extraKeys) window.app.extraKeys.show();
  });
  await page.waitForTimeout(100);

  // Measure the first few keys with boundingBox
  const keys = page.locator('.extra-key');
  const count = await keys.count();
  expect(count).toBeGreaterThan(0);

  // Check at least a few representative keys
  const samplesToCheck = Math.min(count, 5);
  for (let i = 0; i < samplesToCheck; i++) {
    const box = await keys.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});

// ---------------------------------------------------------------------------
// 4. Dismiss button is accessible
// ---------------------------------------------------------------------------
test('dismiss button is accessible with correct aria-label', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  const dismissBtn = page.locator('[aria-label="Dismiss keyboard"]');
  await expect(dismissBtn).toBeAttached();

  // Verify it is a button element
  const tagName = await dismissBtn.evaluate(el => el.tagName.toLowerCase());
  expect(tagName).toBe('button');
});

// ---------------------------------------------------------------------------
// 5. Dynamic font sizing — 360 -> 12, 390 -> 13, 820 -> 14
// ---------------------------------------------------------------------------
test.describe('dynamic font sizing', () => {
  test('returns 12 at 360px width', async ({ page }) => {
    setupPageCapture(page);
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(url);
    await waitForAppReady(page);

    const fontSize = await page.evaluate(() =>
      window.app._getMobileFontSize()
    );
    expect(fontSize).toBe(12);
  });

  test('returns 13 at 390px width', async ({ page }) => {
    setupPageCapture(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await waitForAppReady(page);

    const fontSize = await page.evaluate(() =>
      window.app._getMobileFontSize()
    );
    expect(fontSize).toBe(13);
  });

  test('returns 14 at 820px width', async ({ page }) => {
    setupPageCapture(page);
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto(url);
    await waitForAppReady(page);

    const fontSize = await page.evaluate(() =>
      window.app._getMobileFontSize()
    );
    expect(fontSize).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// 6. Overlay allows tab switching — tab bar z-index > overlay z-index
// ---------------------------------------------------------------------------
test('tab bar z-index is above overlay when overlay is shown', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  // Show overlay
  await page.evaluate(() => {
    window.app.showOverlay('startPrompt');
  });

  // Read tab bar z-index
  const tabBarZ = await page.evaluate(() => {
    const tabBar = document.getElementById('sessionTabsBar');
    return tabBar ? parseInt(tabBar.style.zIndex, 10) : null;
  });

  // Read overlay z-index
  const overlayZ = await page.evaluate(() => {
    const overlay = document.getElementById('overlay');
    return overlay ? parseInt(getComputedStyle(overlay).zIndex, 10) : null;
  });

  expect(tabBarZ).not.toBeNull();
  expect(overlayZ).not.toBeNull();
  expect(tabBarZ).toBeGreaterThan(overlayZ);
});

// ---------------------------------------------------------------------------
// 7. Hide overlay restores z-index
// ---------------------------------------------------------------------------
test('hiding overlay resets tab bar z-index', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  // Show overlay first
  await page.evaluate(() => {
    window.app.showOverlay('startPrompt');
  });

  // Verify z-index is elevated
  const elevatedZ = await page.evaluate(() => {
    const tabBar = document.getElementById('sessionTabsBar');
    return tabBar ? tabBar.style.zIndex : null;
  });
  expect(elevatedZ).toBe('301');

  // Hide overlay (separate evaluate block — safe after _overlayExplicitlyHidden fix)
  await page.evaluate(() => {
    window.app.hideOverlay();
  });

  // Verify z-index is reset
  const resetZ = await page.evaluate(() => {
    const tabBar = document.getElementById('sessionTabsBar');
    return tabBar ? tabBar.style.zIndex : null;
  });
  expect(resetZ).toBe('');
});

// ---------------------------------------------------------------------------
// 8. iPad breakpoint — 768px visible, 821px hidden
// ---------------------------------------------------------------------------
test.describe('iPad breakpoint', () => {
  test('bottom nav is visible at 768px', async ({ page }) => {
    setupPageCapture(page);
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(url);
    await waitForAppReady(page);

    const nav = page.locator('.bottom-nav');
    await expect(nav).toBeVisible();
  });

  test('bottom nav is hidden at 821px', async ({ page }) => {
    setupPageCapture(page);
    await page.setViewportSize({ width: 821, height: 1024 });
    await page.goto(url);
    await waitForAppReady(page);

    const nav = page.locator('.bottom-nav');
    await expect(nav).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// 9. Folder buttons are accessible via aria-label
// ---------------------------------------------------------------------------
test('folder browser buttons have accessible labels', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  const parentBtn = page.locator('[aria-label*="parent"]');
  await expect(parentBtn).toBeAttached();

  const homeBtn = page.locator('[aria-label*="home"]');
  await expect(homeBtn).toBeAttached();

  const folderBtn = page.locator('[aria-label*="folder"]');
  await expect(folderBtn.first()).toBeAttached();
});

// ---------------------------------------------------------------------------
// 10. Swipe gestures switch sessions
// ---------------------------------------------------------------------------
test('horizontal swipe triggers session switch', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  // Verify swipe gesture handling is wired up
  const container = page.locator('.terminal-container');
  await expect(container).toBeAttached();

  // Track whether switchToNextTab was called
  await page.evaluate(() => {
    window._swipeSwitchCalled = false;
    if (window.app.sessionTabManager) {
      const orig = window.app.sessionTabManager.switchToNextTab;
      window.app.sessionTabManager.switchToNextTab = function () {
        window._swipeSwitchCalled = true;
        return orig?.call(this);
      };
    }
  });

  // Simulate a left swipe (finger moves right-to-left, dx < -80)
  const box = await container.boundingBox();
  expect(box).not.toBeNull();

  const startX = box.x + box.width * 0.8;
  const startY = box.y + box.height / 2;
  const endX = box.x + box.width * 0.1;

  await page.touchscreen.tap(startX, startY);
  // Use dispatchEvent for a proper touch drag sequence
  await page.evaluate(({ sx, sy, ex }) => {
    const el = document.querySelector('.terminal-container');
    if (!el) return;
    el.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      touches: [new Touch({ identifier: 1, target: el, clientX: sx, clientY: sy })],
    }));
    // Brief delay simulated by immediate touchend
    el.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      changedTouches: [new Touch({ identifier: 1, target: el, clientX: ex, clientY: sy })],
    }));
  }, { sx: startX, sy: startY, ex: endX });

  const called = await page.evaluate(() => window._swipeSwitchCalled);
  expect(called).toBe(true);
});

// ---------------------------------------------------------------------------
// 11. Settings stacked on mobile
// ---------------------------------------------------------------------------
test('setting groups stack vertically at 480px', async ({ page }) => {
  setupPageCapture(page);
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto(url);
  await waitForAppReady(page);

  // Open the settings modal by making it visible
  await page.evaluate(() => {
    const modal = document.querySelector('.settings-modal');
    if (modal) modal.style.display = 'flex';
  });

  const flexDir = await page.evaluate(() => {
    const group = document.querySelector('.setting-group');
    return group ? getComputedStyle(group).flexDirection : null;
  });

  expect(flexDir).toBe('column');
});

// ---------------------------------------------------------------------------
// 12. Ctrl modifier timeout — deactivates after 5 seconds
// ---------------------------------------------------------------------------
test('Ctrl modifier deactivates after 5 second timeout', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  // Show extra keys and activate Ctrl
  await page.evaluate(() => {
    if (window.app.extraKeys) window.app.extraKeys.show();
  });

  const ctrlBtn = page.locator('.extra-key-modifier[data-modifier="ctrl"]');
  await expect(ctrlBtn).toBeAttached();

  // Tap Ctrl to activate
  await page.evaluate(() => {
    const btn = document.querySelector('.extra-key-modifier[data-modifier="ctrl"]');
    if (btn) btn.click();
  });

  // Verify Ctrl is active
  const isActive = await page.evaluate(() =>
    window.app.extraKeys ? window.app.extraKeys.ctrlActive : false
  );
  expect(isActive).toBe(true);

  // Wait for 5s timeout to expire
  await page.waitForTimeout(5200);

  // Verify Ctrl has been deactivated
  const isStillActive = await page.evaluate(() =>
    window.app.extraKeys ? window.app.extraKeys.ctrlActive : true
  );
  expect(isStillActive).toBe(false);
});
