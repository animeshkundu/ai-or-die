const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  attachFailureArtifacts,
} = require('../helpers/terminal-helpers');
const fs = require('fs');
const path = require('path');

test.describe('File browser', () => {
  let server, port, url;

  // Create a temp fixture directory with known files for deterministic testing
  const fixtureDir = path.join(__dirname, '..', 'fixtures', 'file-browser-test');
  const subDir = path.join(fixtureDir, 'subdir');

  test.beforeAll(async () => {
    // Create fixture files
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'hello.txt'), 'Hello, world!\nLine two.\n');
    fs.writeFileSync(path.join(fixtureDir, 'sample.js'), 'const x = 42;\nconsole.log(x);\n');
    fs.writeFileSync(path.join(fixtureDir, 'data.json'), '{"key":"value","count":1}\n');
    fs.writeFileSync(path.join(fixtureDir, 'readme.md'), '# Test\n\nSome markdown content.\n');
    fs.writeFileSync(path.join(subDir, 'nested.txt'), 'Nested file content.\n');

    const result = await createServer();
    server = result.server;
    port = result.port;
    url = result.url;
  });

  test.afterAll(async () => {
    if (server) server.close();
    // Clean up fixture directory
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  /**
   * Helper: navigate to the app, create a session, and wait for ready state.
   */
  async function setupPage(page) {
    await createSessionViaApi(port, 'File Browser Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    // Wait for the terminal overlay to be hidden (connection established)
    await page.waitForFunction(() => {
      const overlay = document.getElementById('overlay');
      return !overlay || overlay.style.display === 'none' || overlay.offsetParent === null;
    }, { timeout: 30000 });
  }

  /**
   * Helper: open the file browser panel via the browseFilesBtn button,
   * then wait for the panel to have the 'open' class.
   */
  async function openFileBrowser(page) {
    await page.click('#browseFilesBtn');
    await page.waitForSelector('.file-browser-panel.open', { timeout: 10000 });
  }

  /**
   * Helper: open file browser and navigate to the test fixtures directory.
   * Uses the client-side navigateTo API for deterministic path targeting.
   */
  async function openFileBrowserToFixtures(page) {
    // Ensure the file browser panel is instantiated and opened
    await page.evaluate(() => {
      if (!window.app._fileBrowserPanel && window.fileBrowser) {
        window.app._fileBrowserPanel = new window.fileBrowser.FileBrowserPanel({
          app: window.app,
          authFetch: (u, o) => window.app.authFetch(u, o),
          initialPath: null,
        });
      }
    });

    // Open the panel and navigate to the fixture directory
    const fixturePath = fixtureDir.replace(/\\/g, '/');
    await page.evaluate((dir) => {
      const panel = window.app._fileBrowserPanel;
      panel.open(dir);
    }, fixturePath);

    await page.waitForSelector('.file-browser-panel.open', { timeout: 10000 });

    // Wait for file list to be populated (items rendered)
    await page.waitForFunction(() => {
      const items = document.querySelectorAll('.file-browser-item');
      return items.length > 0;
    }, { timeout: 10000 });
  }

  // ── Test 1: Ctrl+B opens file browser panel ─────────────────────────

  test('Ctrl+B opens file browser panel', async ({ page }) => {
    await setupPage(page);

    // Press Ctrl+B to toggle the file browser
    await page.keyboard.press('Control+b');

    // Verify the panel opens
    const panel = page.locator('.file-browser-panel.open');
    await expect(panel).toBeVisible({ timeout: 10000 });

    // Wait for items to load (the API call to /api/files)
    await page.waitForFunction(() => {
      const statusBar = document.querySelector('.fb-status-bar');
      return statusBar && statusBar.textContent && !statusBar.textContent.includes('Loading');
    }, { timeout: 10000 });

    // Verify status bar shows an item count
    const statusText = await page.locator('.fb-status-bar').textContent();
    expect(statusText).toMatch(/\d+ items?/);
  });

  // ── Test 2: Clicking a directory navigates into it ──────────────────

  test('clicking a directory navigates into it', async ({ page }) => {
    await setupPage(page);
    await openFileBrowserToFixtures(page);

    // Find the 'subdir' directory item and click it
    const subdirItem = page.locator('.file-browser-item', { has: page.locator('.file-item-name', { hasText: 'subdir/' }) });
    await expect(subdirItem).toBeVisible({ timeout: 5000 });
    await subdirItem.click();

    // Wait for the breadcrumbs to update — they should contain 'subdir'
    await page.waitForFunction(() => {
      const crumbs = document.querySelectorAll('.fb-breadcrumb');
      for (const c of crumbs) {
        if (c.textContent === 'subdir') return true;
      }
      return false;
    }, { timeout: 10000 });

    // Verify the nested file appears in the listing
    const nestedItem = page.locator('.file-item-name', { hasText: 'nested.txt' });
    await expect(nestedItem).toBeVisible({ timeout: 5000 });
  });

  // ── Test 3: Clicking a text file shows preview ──────────────────────

  test('clicking a text file shows preview', async ({ page }) => {
    await setupPage(page);
    await openFileBrowserToFixtures(page);

    // Click on sample.js
    const jsItem = page.locator('.file-browser-item', { has: page.locator('.file-item-name', { hasText: 'sample.js' }) });
    await expect(jsItem).toBeVisible({ timeout: 5000 });
    await jsItem.click();

    // Wait for preview container to be visible
    const previewContainer = page.locator('.fb-preview-container');
    await expect(previewContainer).toBeVisible({ timeout: 10000 });

    // Verify the preview title shows the file name
    const previewTitle = page.locator('.fb-preview-title');
    await expect(previewTitle).toHaveText('sample.js');

    // Wait for code content to load (the /api/files/content call)
    const codeContent = page.locator('.fb-code-content');
    await expect(codeContent).toBeVisible({ timeout: 10000 });

    // Verify the actual file content is shown
    const codeText = await codeContent.textContent();
    expect(codeText).toContain('const x = 42');

    // Verify line numbers are rendered
    const gutter = page.locator('.fb-code-gutter');
    await expect(gutter).toBeVisible();
  });

  // ── Test 4: Binary/image files show download button ─────────────────

  test('binary files show the download button in preview', async ({ page }) => {
    // Create a fake binary file in the fixture dir
    const binPath = path.join(fixtureDir, 'data.bin');
    const binContent = Buffer.alloc(128);
    binContent[0] = 0x00; // null byte to ensure binary detection
    binContent[1] = 0x01;
    binContent[2] = 0xFF;
    fs.writeFileSync(binPath, binContent);

    await setupPage(page);
    await openFileBrowserToFixtures(page);

    // Click the binary file
    const binItem = page.locator('.file-browser-item', { has: page.locator('.file-item-name', { hasText: 'data.bin' }) });
    await expect(binItem).toBeVisible({ timeout: 5000 });
    await binItem.click();

    // Wait for preview container
    const previewContainer = page.locator('.fb-preview-container');
    await expect(previewContainer).toBeVisible({ timeout: 10000 });

    // Verify download button is present
    const downloadBtn = page.locator('.fb-preview-actions button', { hasText: 'Download' });
    await expect(downloadBtn).toBeVisible({ timeout: 5000 });

    // Clean up the binary file
    fs.unlinkSync(binPath);
  });

  // ── Test 5: Files button in tab bar opens/closes file browser ───────

  test('Files button in tab bar opens and closes file browser', async ({ page }) => {
    await setupPage(page);

    // Click the Browse Files button
    await page.click('#browseFilesBtn');

    // Verify panel opens
    const panel = page.locator('.file-browser-panel.open');
    await expect(panel).toBeVisible({ timeout: 10000 });

    // Click the close button inside the panel
    const closeBtn = page.locator('.fb-close-btn');
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();

    // Verify panel is closed (no 'open' class)
    await expect(page.locator('.file-browser-panel.open')).not.toBeVisible({ timeout: 5000 });
  });

  // ── Test 6: Escape key closes the file browser ──────────────────────

  test('Escape key closes file browser', async ({ page }) => {
    await setupPage(page);

    // Open the browser
    await page.click('#browseFilesBtn');
    await page.waitForSelector('.file-browser-panel.open', { timeout: 10000 });

    // Focus the panel so keydown events reach it
    await page.locator('.file-browser-panel').focus();

    // Press Escape
    await page.keyboard.press('Escape');

    // Verify panel is closed
    await expect(page.locator('.file-browser-panel.open')).not.toBeVisible({ timeout: 5000 });
  });

  // ── Test 7: Search/filter works ─────────────────────────────────────

  test('search filters file list', async ({ page }) => {
    await setupPage(page);
    await openFileBrowserToFixtures(page);

    // Count initial items
    const initialCount = await page.locator('.file-browser-item').count();
    expect(initialCount).toBeGreaterThan(1);

    // Click the search toggle button
    const searchBtn = page.locator('.fb-header-btn[aria-label="Toggle search"]');
    await searchBtn.click();

    // Verify search bar becomes visible
    const searchInput = page.locator('.fb-search-input');
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    // Type a filter query that matches only one file
    await searchInput.fill('sample');

    // Wait for the file list to be filtered
    await page.waitForFunction(() => {
      const items = document.querySelectorAll('.file-browser-item');
      return items.length === 1;
    }, { timeout: 5000 });

    // Verify the remaining item is sample.js
    const remaining = page.locator('.file-item-name');
    await expect(remaining).toHaveText('sample.js');
  });

  // ── Test 8: Download button triggers file download ──────────────────

  test('download button triggers file download', async ({ page }) => {
    await setupPage(page);
    await openFileBrowserToFixtures(page);

    // Click hello.txt to preview it
    const txtItem = page.locator('.file-browser-item', { has: page.locator('.file-item-name', { hasText: 'hello.txt' }) });
    await txtItem.click();

    // Wait for preview to appear
    await expect(page.locator('.fb-preview-container')).toBeVisible({ timeout: 10000 });

    // Set up download listener before clicking
    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });

    // Click the Download button
    const downloadBtn = page.locator('.fb-preview-actions button', { hasText: 'Download' });
    await expect(downloadBtn).toBeVisible();
    await downloadBtn.click();

    // Verify download was initiated
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('hello.txt');
  });

  // ── Test 9: JSON file preview renders formatted JSON ────────────────

  test('JSON file preview renders formatted content', async ({ page }) => {
    await setupPage(page);
    await openFileBrowserToFixtures(page);

    // Click data.json
    const jsonItem = page.locator('.file-browser-item', { has: page.locator('.file-item-name', { hasText: 'data.json' }) });
    await expect(jsonItem).toBeVisible({ timeout: 5000 });
    await jsonItem.click();

    // Wait for preview
    const previewContainer = page.locator('.fb-preview-container');
    await expect(previewContainer).toBeVisible({ timeout: 10000 });

    // Wait for code content to load
    const codeContent = page.locator('.fb-code-content');
    await expect(codeContent).toBeVisible({ timeout: 10000 });

    // The JSON content should be formatted (pretty-printed)
    const text = await codeContent.textContent();
    expect(text).toContain('"key"');
    expect(text).toContain('"value"');
  });

  // ── Test 10: File save via PUT /api/files/content ───────────────────

  test('editing and saving updates file content via API', async ({ page }) => {
    // Create a dedicated test file for editing
    const editFile = path.join(fixtureDir, 'editable.txt');
    fs.writeFileSync(editFile, 'original content\n');

    await setupPage(page);
    await openFileBrowserToFixtures(page);

    // Click the editable.txt file to preview it
    const editItem = page.locator('.file-browser-item', { has: page.locator('.file-item-name', { hasText: 'editable.txt' }) });
    await expect(editItem).toBeVisible({ timeout: 5000 });
    await editItem.click();

    // Wait for preview and content to load
    const codeContent = page.locator('.fb-code-content');
    await expect(codeContent).toBeVisible({ timeout: 10000 });
    const initialText = await codeContent.textContent();
    expect(initialText).toContain('original content');

    // Use the server API directly to save new content (simulates editor save)
    // First, get the file stat to obtain the hash
    const fixturePath = fixtureDir.replace(/\\/g, '/');
    const filePath = fixturePath + '/editable.txt';

    const statRes = await page.request.get(`${url}/api/files/stat?path=${encodeURIComponent(filePath)}`);
    expect(statRes.ok()).toBeTruthy();
    const statData = await statRes.json();
    const hash = statData.hash;

    // Save new content with hash
    const saveRes = await page.request.put(`${url}/api/files/content`, {
      data: {
        path: filePath,
        content: 'updated content\n',
        hash: hash,
      },
    });
    expect(saveRes.ok()).toBeTruthy();
    const saveData = await saveRes.json();
    expect(saveData.hash).toBeTruthy();

    // Verify the file was actually updated on disk
    const diskContent = fs.readFileSync(editFile, 'utf-8');
    expect(diskContent).toBe('updated content\n');
  });

  // ── Test 11: Back button returns from preview to browse ─────────────

  test('back button returns from preview to file list', async ({ page }) => {
    await setupPage(page);
    await openFileBrowserToFixtures(page);

    // Click a file to enter preview mode
    const txtItem = page.locator('.file-browser-item', { has: page.locator('.file-item-name', { hasText: 'hello.txt' }) });
    await txtItem.click();

    // Verify we're in preview mode
    await expect(page.locator('.fb-preview-container')).toBeVisible({ timeout: 10000 });

    // Click the back button
    const backBtn = page.locator('.fb-back-btn');
    await expect(backBtn).toBeVisible();
    await backBtn.click();

    // Verify we're back in browse mode — file list should be visible
    await expect(page.locator('.fb-file-list')).toBeVisible({ timeout: 5000 });
    // And preview container should be hidden
    await expect(page.locator('.fb-preview-container')).not.toBeVisible();
  });

  // ── Test 12: Status bar shows correct item count ────────────────────

  test('status bar shows correct item count', async ({ page }) => {
    await setupPage(page);
    await openFileBrowserToFixtures(page);

    // The fixture dir has: hello.txt, sample.js, data.json, readme.md, subdir/
    // (editable.txt may or may not exist depending on test ordering, so check >= 5)
    const statusText = await page.locator('.fb-status-bar').textContent();
    const match = statusText.match(/(\d+) items?/);
    expect(match).toBeTruthy();
    const count = parseInt(match[1], 10);
    expect(count).toBeGreaterThanOrEqual(5);
  });

  // ── Test 13: Breadcrumbs allow navigating back to parent ────────────

  test('breadcrumb click navigates to ancestor directory', async ({ page }) => {
    await setupPage(page);
    await openFileBrowserToFixtures(page);

    // Navigate into subdir first
    const subdirItem = page.locator('.file-browser-item', { has: page.locator('.file-item-name', { hasText: 'subdir/' }) });
    await subdirItem.click();

    // Wait for nested content
    await expect(page.locator('.file-item-name', { hasText: 'nested.txt' })).toBeVisible({ timeout: 10000 });

    // Click the parent breadcrumb (the one before 'subdir') to go back
    // The fixture dir's basename should be the clickable breadcrumb
    const parentCrumb = page.locator('.fb-breadcrumb:not(.active)').last();
    await expect(parentCrumb).toBeVisible();
    await parentCrumb.click();

    // Verify we're back in the parent directory
    await expect(page.locator('.file-item-name', { hasText: 'subdir/' })).toBeVisible({ timeout: 10000 });
  });

  // ── Test 14: File API returns correct listing data ──────────────────

  test('GET /api/files returns correct directory listing', async ({ page }) => {
    await setupPage(page);

    const fixturePath = fixtureDir.replace(/\\/g, '/');
    const res = await page.request.get(`${url}/api/files?path=${encodeURIComponent(fixturePath)}&limit=100`);
    expect(res.ok()).toBeTruthy();

    const data = await res.json();
    expect(data.currentPath).toBeTruthy();
    expect(data.baseFolder).toBeTruthy();
    expect(data.items).toBeInstanceOf(Array);
    expect(data.totalCount).toBeGreaterThanOrEqual(5);

    // Verify directories come first in the sorting
    const dirItems = data.items.filter(i => i.isDirectory);
    const fileItems = data.items.filter(i => !i.isDirectory);
    if (dirItems.length > 0 && fileItems.length > 0) {
      const lastDirIndex = data.items.lastIndexOf(dirItems[dirItems.length - 1]);
      const firstFileIndex = data.items.indexOf(fileItems[0]);
      expect(lastDirIndex).toBeLessThan(firstFileIndex);
    }

    // Verify a known file has expected metadata
    const sampleJs = data.items.find(i => i.name === 'sample.js');
    expect(sampleJs).toBeTruthy();
    expect(sampleJs.isDirectory).toBe(false);
    expect(sampleJs.extension).toBe('.js');
    expect(sampleJs.mimeCategory).toBe('code');
    expect(sampleJs.editable).toBe(true);
    expect(sampleJs.size).toBeGreaterThan(0);
  });

  // ── Test 15: File content API returns text with hash ────────────────

  test('GET /api/files/content returns file content with hash', async ({ page }) => {
    await setupPage(page);

    const fixturePath = fixtureDir.replace(/\\/g, '/');
    const filePath = fixturePath + '/hello.txt';
    const res = await page.request.get(`${url}/api/files/content?path=${encodeURIComponent(filePath)}`);
    expect(res.ok()).toBeTruthy();

    const data = await res.json();
    expect(data.content).toContain('Hello, world!');
    expect(data.hash).toBeTruthy();
    expect(data.truncated).toBe(false);
    expect(data.mimeCategory).toBe('text');
    expect(data.editable).toBe(true);
  });
});
