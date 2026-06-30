const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  setupPageCapture,
  attachFailureArtifacts,
} = require('../helpers/terminal-helpers');

// Real-browser verification of the artifact-review panel CHROME (move / resize /
// minimize / persistence / off-screen clamp). jsdom can't do layout, so these
// behaviors are only meaningfully testable in a real browser. The panel mounts
// on the `artifact_review_opened` broadcast for the ACTIVE session, so each test
// joins a session (which calls _artifactPanel.notifyActiveSessionChanged) and
// POSTs /api/artifact/:sessionId/open with a small HTML file under the repo root
// (validateArtifactPath's baseFolder is process.cwd()).

const LAYOUT_KEY = 'ai-or-die:artifact-panel:layout';

// A temp dir UNDER the repo root so validateArtifactPath (baseFolder = cwd)
// accepts the artifact file. Cleaned up in afterAll.
let artifactDir;
let artifactFile;

function writeArtifactFixture() {
  artifactDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-e2e-artifact-'));
  artifactFile = path.join(artifactDir, 'plan.html');
  fs.writeFileSync(
    artifactFile,
    '<!doctype html><html><head><title>Plan</title></head><body>' +
    '<h1 data-source-line="1">Test plan</h1><p data-source-line="3">Some content to review.</p>' +
    '</body></html>'
  );
}

async function openArtifactForActiveSession(page, port, sessionId) {
  // Make the session active for the panel via the SAME call app.js makes on
  // session_joined (notifyActiveSessionChanged), and dismiss the welcome overlay
  // so the panel header is the topmost element (the overlay's .overlay-content
  // otherwise sits over the panel and swallows the drag mousedown). This drives
  // the REAL panel deterministically without racing the join→navigation flow.
  await page.waitForFunction(
    () => window.app && window.app._artifactPanel && typeof window.app.hideOverlay === 'function',
    { timeout: 20000 }
  );
  await page.evaluate((sid) => {
    window.app.hideOverlay();
    window.app._artifactPanel.notifyActiveSessionChanged(sid);
  }, sessionId);

  // Open the artifact via the server route (broadcasts artifact_review_opened to
  // the client, which the real panel handles).
  const res = await fetch(`http://127.0.0.1:${port}/api/artifact/${encodeURIComponent(sessionId)}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: artifactFile }),
  });
  expect(res.ok).toBeTruthy();

  // The panel becomes visible once the broadcast lands.
  await expect(page.locator('#artifactPanel')).toBeVisible({ timeout: 15000 });
}

test.describe('Artifact panel chrome: move / resize / minimize / persistence', () => {
  let server, port, url;

  test.beforeAll(async () => {
    writeArtifactFixture();
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
    if (artifactDir) { try { fs.rmSync(artifactDir, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  test('drag moves, corner resizes, minimize collapses + restores, geometry persists, off-screen clamps', async ({ page }) => {
    setupPageCapture(page);

    const sessionId = await createSessionViaApi(port, 'Artifact Chrome');

    // Start from a clean persisted layout so we control the geometry.
    await page.goto(url);
    await waitForAppReady(page);
    // Start from a clean persisted layout (one-time, NOT an init script — an
    // init script would re-run on the later reload and wipe the geometry we are
    // trying to verify persists).
    await page.evaluate((key) => { try { window.localStorage.removeItem(key); } catch (_) { /* ignore */ } }, LAYOUT_KEY);
    await openArtifactForActiveSession(page, port, sessionId);

    const panel = page.locator('#artifactPanel');
    const header = page.locator('#artifactPanel .artifact-panel__header');
    const resizeHandle = page.locator('#artifactPanel .artifact-panel__resize');

    // ---- (a) DRAG the header moves the panel ------------------------------
    const before = await panel.boundingBox();
    expect(before).not.toBeNull();

    const headerBox = await header.boundingBox();
    // Grab a point on the header that is NOT over a button (left side, past the title).
    const grabX = headerBox.x + 30;
    const grabY = headerBox.y + headerBox.height / 2;
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    // Move left + up in steps so the drag handler tracks it (no arbitrary sleeps).
    await page.mouse.move(grabX - 120, grabY - 80, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () => {
      const b = await panel.boundingBox();
      return Math.round(b.x);
    }, { timeout: 5000 }).toBeLessThan(Math.round(before.x) - 40);
    const afterMove = await panel.boundingBox();
    expect(afterMove.y).toBeLessThan(before.y - 40);

    // ---- (b) DRAG the resize handle changes size --------------------------
    const sizeBefore = await panel.boundingBox();
    // The iframe content area must grow WITH the panel (flex:1/width:100%) so the
    // artifact reflows into the larger space — capture it before resizing.
    const frame = page.locator('#artifactPanel .artifact-panel__frame');
    const frameBefore = await frame.boundingBox();
    const handleBox = await resizeHandle.boundingBox();
    const hx = handleBox.x + handleBox.width / 2;
    const hy = handleBox.y + handleBox.height / 2;
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx + 90, hy + 70, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () => {
      const b = await panel.boundingBox();
      return Math.round(b.width);
    }, { timeout: 5000 }).toBeGreaterThan(Math.round(sizeBefore.width) + 40);
    const afterResize = await panel.boundingBox();
    expect(afterResize.height).toBeGreaterThan(sizeBefore.height + 40);
    // The iframe (artifact content viewport) grew with the panel, so content reflows.
    const frameAfter = await frame.boundingBox();
    expect(frameAfter.width).toBeGreaterThan(frameBefore.width + 30);
    expect(frameAfter.height).toBeGreaterThan(frameBefore.height + 30);

    // ---- (c) MINIMIZE collapses to the header bar; restore brings it back -
    const fullHeight = (await panel.boundingBox()).height;
    const minBtn = page.locator('#artifactPanel .artifact-panel__btn[aria-label="Minimize panel"]');
    await minBtn.click();
    // Body hidden + panel shrinks to ~header height.
    await expect(page.locator('#artifactPanel .artifact-panel__body')).toBeHidden({ timeout: 5000 });
    await expect.poll(async () => {
      const b = await panel.boundingBox();
      return Math.round(b.height);
    }, { timeout: 5000 }).toBeLessThan(Math.round(fullHeight) - 80);

    const restoreBtn = page.locator('#artifactPanel .artifact-panel__btn[aria-label="Restore panel"]');
    await restoreBtn.click();
    await expect(page.locator('#artifactPanel .artifact-panel__body')).toBeVisible({ timeout: 5000 });
    await expect.poll(async () => {
      const b = await panel.boundingBox();
      return Math.round(b.height);
    }, { timeout: 5000 }).toBeGreaterThan(Math.round(fullHeight) - 40);

    // ---- (d) geometry PERSISTS across a page reload -----------------------
    const persistedBox = await panel.boundingBox();
    const storedRaw = await page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_KEY);
    expect(storedRaw, 'layout persisted to localStorage').toBeTruthy();
    const stored = JSON.parse(storedRaw);
    expect(typeof stored.left).toBe('number');
    expect(typeof stored.width).toBe('number');

    await page.reload();
    await waitForAppReady(page);
    await openArtifactForActiveSession(page, port, sessionId);

    await expect.poll(async () => {
      const b = await panel.boundingBox();
      return Math.round(b.width);
    }, { timeout: 5000 }).toBeGreaterThan(Math.round(sizeBefore.width) + 40);
    const afterReload = await panel.boundingBox();
    // Position + size survived (allow a couple px tolerance for sub-pixel rounding).
    expect(Math.abs(afterReload.x - persistedBox.x)).toBeLessThan(4);
    expect(Math.abs(afterReload.y - persistedBox.y)).toBeLessThan(4);
    expect(Math.abs(afterReload.width - persistedBox.width)).toBeLessThan(4);

    // ---- (e) a persisted OFF-SCREEN position is clamped back on load ------
    const viewport = page.viewportSize();
    await page.evaluate(({ key, w, h }) => {
      window.localStorage.setItem(key, JSON.stringify({ left: 99999, top: 99999, width: 420, height: 360, minimized: false }));
    }, { key: LAYOUT_KEY, w: viewport.width, h: viewport.height });

    await page.reload();
    await waitForAppReady(page);
    await openArtifactForActiveSession(page, port, sessionId);

    await expect.poll(async () => {
      const b = await panel.boundingBox();
      // The header must be on-screen and grabbable.
      return b && b.x >= 0 && b.y >= 0
        && b.x < viewport.width - 40
        && b.y < viewport.height - 20;
    }, { timeout: 5000 }).toBe(true);

    const clamped = await panel.boundingBox();
    expect(clamped.x).toBeGreaterThanOrEqual(0);
    expect(clamped.y).toBeGreaterThanOrEqual(0);
    expect(clamped.x).toBeLessThan(viewport.width - 40);
    expect(clamped.y).toBeLessThan(viewport.height - 20);
  });
});
