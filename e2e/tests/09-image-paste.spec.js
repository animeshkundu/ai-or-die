const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
  focusTerminal,
} = require('../helpers/terminal-helpers');

// Minimal 1x1 red PNG encoded as base64 for clipboard tests
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const ONE_MIB = 1024 * 1024;

/**
 * Helper: write a PNG blob to the system clipboard via the Clipboard API.
 * Must be called inside page.evaluate().
 */
async function writeImageToClipboard(page, options = {}) {
  if (options.large) {
    return page.evaluate(async ({ minSize, maxSize }) => {
      async function createNoisyPng(width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(width, height);
        const data = imageData.data;
        let seed = 0x12345678;

        for (let i = 0; i < data.length; i += 4) {
          seed = (seed + 0x6D2B79F5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          const rnd = (t ^ (t >>> 14)) >>> 0;
          data[i] = rnd & 0xff;
          data[i + 1] = (rnd >>> 8) & 0xff;
          data[i + 2] = (rnd >>> 16) & 0xff;
          data[i + 3] = 0xff;
        }

        ctx.putImageData(imageData, 0, 0);
        return new Promise((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Failed to create PNG blob'));
          }, 'image/png');
        });
      }

      const candidates = [
        { width: 720, height: 720 },
        { width: 800, height: 700 },
        { width: 900, height: 700 },
      ];
      let blob = null;
      for (const candidate of candidates) {
        blob = await createNoisyPng(candidate.width, candidate.height);
        if (blob.size > minSize && blob.size < maxSize) break;
      }
      if (!blob || blob.size <= minSize) {
        throw new Error(`Large test PNG was only ${blob ? blob.size : 0} bytes`);
      }
      if (blob.size >= maxSize) {
        throw new Error(`Large test PNG was too large: ${blob.size} bytes`);
      }

      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob })
      ]);
      return blob.size;
    }, { minSize: ONE_MIB, maxSize: 4 * ONE_MIB });
  }

  return page.evaluate(async (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob })
    ]);
    return blob.size;
  }, TINY_PNG_BASE64);
}

async function waitForImageInputMessage(page, caption, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const msg = page._wsMessages.find(
      m => m.dir === 'sent'
        && m.type === 'input'
        && typeof m.data === 'string'
        && m.data.includes('.claude-images/')
        && m.data.includes('.png')
        && (!caption || m.data.includes(caption))
    );
    if (msg) return msg;
    await page.waitForTimeout(100);
  }
  return null;
}

function extractImagePathFromInput(data) {
  const quoted = data.match(/"([^"]*\.claude-images\/[^\"]+\.png)"/);
  if (quoted) return quoted[1];

  const unquoted = data.match(/([^\s"]*\.claude-images\/[^\s"]+\.png)/);
  return unquoted ? unquoted[1] : null;
}

test.describe('Image paste: preview modal and upload', () => {
  let server, port, url;

  test.beforeAll(async () => {
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  async function setupTerminalPage(page) {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, `ImgTest_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    return sessionId;
  }

  test('Ctrl+V with image in clipboard shows preview modal', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTerminalPage(page);

    // Write a PNG blob to the clipboard
    await writeImageToClipboard(page);

    // Focus terminal and paste
    await focusTerminal(page);
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(1000);

    // The image preview modal should appear
    const modal = page.locator('#imagePreviewModal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Verify key elements inside the modal
    await expect(modal.locator('.image-preview-thumbnail')).toBeVisible();
    await expect(modal.locator('#sendImageBtn')).toBeVisible();
    await expect(modal.locator('#cancelImageBtn')).toBeVisible();
    await expect(modal.locator('.image-preview-caption')).toBeFocused();
  });

  test('Cancel button closes modal without upload', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTerminalPage(page);

    await writeImageToClipboard(page);

    await focusTerminal(page);
    await page.keyboard.press('Control+v');

    const modal = page.locator('#imagePreviewModal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Click Cancel
    await page.click('#cancelImageBtn');
    await expect(modal).not.toBeVisible();
  });

  test('Escape key closes preview modal', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTerminalPage(page);

    await writeImageToClipboard(page);

    await focusTerminal(page);
    await page.keyboard.press('Control+v');

    const modal = page.locator('#imagePreviewModal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Wait for modal's keydown listener to be attached, then press Escape
    await page.waitForTimeout(500);
    await modal.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 5000 });
  });

  test('Context menu shows Paste Image and Attach Image items', async ({ page }) => {
    await setupTerminalPage(page);

    // Right-click the terminal canvas to open the context menu
    const terminalArea = page.locator('[data-tid="terminal"] .xterm-screen, #terminal .xterm-screen').first();
    await terminalArea.click({ button: 'right', position: { x: 100, y: 50 } });

    const menu = page.locator('[data-tid="context-menu"]');
    await expect(menu).toBeVisible();

    // Verify image-related menu items are present
    await expect(menu.locator('[data-action="pasteImage"]')).toBeVisible();
    await expect(menu.locator('[data-action="attachImage"]')).toBeVisible();
  });

  test('Attach Image button is visible in toolbar', async ({ page }) => {
    await setupTerminalPage(page);

    const attachBtn = page.locator('#attachImageBtn');
    await expect(attachBtn).toBeVisible();
  });

  test('Send button uploads image and closes modal', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTerminalPage(page);

    // Write a PNG blob to the clipboard and paste
    await writeImageToClipboard(page);

    await focusTerminal(page);
    await page.keyboard.press('Control+v');

    const modal = page.locator('#imagePreviewModal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Type a caption
    await page.fill('.image-preview-caption', 'What is this?');

    // Click Send
    await page.click('#sendImageBtn');

    // Modal should close after the image is processed
    await expect(modal).not.toBeVisible({ timeout: 5000 });

    // Verify via WebSocket input message (more reliable than terminal text
    // which may be line-wrapped at different widths)
    const inputMsg = await waitForImageInputMessage(page, 'What is this?');
    expect(inputMsg).toBeTruthy();

    // Verify the path uses forward slashes and .png extension
    expect(inputMsg.data).toContain('.claude-images/');
    expect(inputMsg.data).toContain('.png');
    expect(inputMsg.data).not.toContain('\\');

    // Verify caption was included in the terminal input
    expect(inputMsg.data).toContain('What is this?');
  });

  test('Close button (x) dismisses the preview modal', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTerminalPage(page);

    await writeImageToClipboard(page);

    await focusTerminal(page);
    await page.keyboard.press('Control+v');

    const modal = page.locator('#imagePreviewModal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Click the X close button in the modal header
    await page.click('#closeImagePreviewBtn');
    await expect(modal).not.toBeVisible();
  });

  test('Modal shows file name and size info', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTerminalPage(page);

    await writeImageToClipboard(page);

    await focusTerminal(page);
    await page.keyboard.press('Control+v');

    const modal = page.locator('#imagePreviewModal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Verify info fields are populated
    const filename = await modal.locator('.image-preview-filename').textContent();
    expect(filename.length).toBeGreaterThan(0);

    const size = await modal.locator('.image-preview-size').textContent();
    expect(size.length).toBeGreaterThan(0);

    // Clean up
    await page.click('#cancelImageBtn');
  });

  test('Large image (>1MB) uploads over HTTP without dropping the socket', async ({ page, context }) => {
    const wsClosed = [];
    page.on('websocket', ws => {
      ws.on('close', () => wsClosed.push(ws.url()));
    });

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTerminalPage(page);

    const closeCountBeforeUpload = wsClosed.length;
    const imageSize = await writeImageToClipboard(page, { large: true });
    expect(imageSize).toBeGreaterThan(ONE_MIB);

    await focusTerminal(page);
    await page.keyboard.press('Control+v');

    const modal = page.locator('#imagePreviewModal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    await page.fill('.image-preview-caption', 'Large image upload');
    await page.click('#sendImageBtn');
    await expect(modal).not.toBeVisible({ timeout: 5000 });

    // The large image should upload over HTTP and inject a path via the still-open socket.
    const inputMsg = await waitForImageInputMessage(page, 'Large image upload', 15000);
    expect(inputMsg).toBeTruthy();
    expect(inputMsg.data).toContain('.claude-images/');
    expect(inputMsg.data).toContain('.png');

    const uploadError = page._wsMessages.find(
      m => m.dir === 'recv' && m.type === 'image_upload_error'
    );
    expect(uploadError).toBeFalsy();
    expect(wsClosed.length).toBe(closeCountBeforeUpload);
  });

  test('Complete flow: paste, upload, file on disk, path in terminal', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTerminalPage(page);

    await writeImageToClipboard(page);
    await focusTerminal(page);
    await page.keyboard.press('Control+v');

    const modal = page.locator('#imagePreviewModal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    await page.fill('.image-preview-caption', 'Describe this image');
    await page.click('#sendImageBtn');
    await expect(modal).not.toBeVisible({ timeout: 5000 });

    // Verify no image_upload_error was received
    const uploadError = page._wsMessages.find(
      m => m.dir === 'recv' && m.type === 'image_upload_error'
    );
    expect(uploadError).toBeFalsy();

    // Verify the terminal input message was sent via WebSocket (more reliable
    // than reading terminal text which may be line-wrapped)
    const inputMsg = await waitForImageInputMessage(page, 'Describe this image');
    expect(inputMsg).toBeTruthy();

    // The input message should contain the path with forward slashes and .png
    expect(inputMsg.data).toContain('.claude-images/');
    expect(inputMsg.data).toContain('.png');
    expect(inputMsg.data).not.toContain('\\');

    // Verify caption text was included alongside the path
    expect(inputMsg.data).toContain('Describe this image');

    // Derive the server path from the injected terminal input and verify it exists
    const serverPath = extractImagePathFromInput(inputMsg.data);
    expect(serverPath).toBeTruthy();
    expect(serverPath).toContain('.claude-images/');
    expect(serverPath).toMatch(/\.png$/);

    const fs = require('fs');
    expect(fs.existsSync(serverPath)).toBe(true);
    const stat = fs.statSync(serverPath);
    expect(stat.size).toBeGreaterThan(0);
  });
});
