const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
  focusTerminal,
  readTerminalContent,
  waitForWsMessage,
} = require('../helpers/terminal-helpers');

// Minimal 1x1 red PNG encoded as base64 for clipboard tests
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

/**
 * Helper: write a tiny PNG blob to the system clipboard via the Clipboard API.
 * Must be called inside page.evaluate().
 */
async function writeImageToClipboard(page) {
  await page.evaluate(async (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob })
    ]);
  }, TINY_PNG_BASE64);
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

    // Wait for the server to respond with image_upload_complete via WebSocket
    const uploadComplete = await waitForWsMessage(page, 'recv', 'image_upload_complete', 10000);
    expect(uploadComplete).toBeTruthy();
    expect(uploadComplete.filePath).toBeTruthy();
    expect(uploadComplete.filePath).toContain('.claude-images');

    // Wait for the file path to be injected into the terminal
    await page.waitForTimeout(3000);

    // Read the terminal buffer to find the injected path
    const terminalContent = await readTerminalContent(page);

    // Verify the path was injected with .claude-images directory
    expect(terminalContent).toContain('.claude-images/');
    expect(terminalContent).toContain('.png"');  // quoted path with .png extension

    // Verify forward slashes (no backslashes in the path)
    const pathMatch = terminalContent.match(/"([^"]+\.claude-images[^"]*\.png)"/);
    expect(pathMatch).toBeTruthy();
    if (pathMatch) {
      expect(pathMatch[1]).not.toContain('\\');
      expect(pathMatch[1]).toContain('/');
    }

    // Verify caption was included in the terminal input
    expect(terminalContent).toContain('What is this?');
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

  test('Complete flow: paste, upload, file on disk, path in terminal', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const sessionId = await setupTerminalPage(page);

    await writeImageToClipboard(page);
    await focusTerminal(page);
    await page.keyboard.press('Control+v');

    const modal = page.locator('#imagePreviewModal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    await page.fill('.image-preview-caption', 'Describe this image');
    await page.click('#sendImageBtn');
    await expect(modal).not.toBeVisible({ timeout: 5000 });

    // Verify the WebSocket image_upload message was sent by the client
    const uploadSent = page._wsMessages.find(
      m => m.dir === 'sent' && m.type === 'image_upload'
    );
    expect(uploadSent).toBeTruthy();
    expect(uploadSent.base64).toBeTruthy();
    expect(uploadSent.mimeType).toBe('image/png');

    // Wait for the server to respond with image_upload_complete
    const uploadComplete = await waitForWsMessage(page, 'recv', 'image_upload_complete', 10000);
    expect(uploadComplete).toBeTruthy();
    expect(uploadComplete.filePath).toBeTruthy();
    expect(uploadComplete.mimeType).toBe('image/png');
    expect(uploadComplete.size).toBeGreaterThan(0);

    // Verify no image_upload_error was received
    const uploadError = page._wsMessages.find(
      m => m.dir === 'recv' && m.type === 'image_upload_error'
    );
    expect(uploadError).toBeFalsy();

    // The server returned an absolute file path; verify it points to .claude-images
    const serverPath = uploadComplete.filePath;
    expect(serverPath).toContain('.claude-images');
    expect(serverPath).toMatch(/\.png$/);

    // Verify the file actually exists on disk via the server API
    const fs = require('fs');
    expect(fs.existsSync(serverPath)).toBe(true);
    const stat = fs.statSync(serverPath);
    expect(stat.size).toBeGreaterThan(0);

    // Wait for the path to be injected into the terminal
    await page.waitForTimeout(3000);

    // Read terminal content to verify the path was injected
    const terminalContent = await readTerminalContent(page);

    // Path should be in terminal, quoted, with forward slashes
    expect(terminalContent).toContain('.claude-images/');
    expect(terminalContent).toContain('.png"');

    // Extract the full path from terminal and verify formatting
    const pathMatch = terminalContent.match(/"([^"]*\.claude-images[^"]*\.png)"/);
    expect(pathMatch).toBeTruthy();
    if (pathMatch) {
      // Must use forward slashes (cross-platform normalization)
      expect(pathMatch[1]).not.toContain('\\');
      expect(pathMatch[1]).toContain('/');
    }

    // Verify caption text was included alongside the path
    expect(terminalContent).toContain('Describe this image');

    // Verify the terminal input message was sent via WebSocket
    const inputMsg = page._wsMessages.find(
      m => m.dir === 'sent' && m.type === 'input' && typeof m.data === 'string' && m.data.includes('.claude-images')
    );
    expect(inputMsg).toBeTruthy();
  });
});
