// 65-drop-blocked.spec.js — dropping a blocked-extension file (e.g. .exe)
// surfaces a toast with the server's blocked-extension error and does
// NOT inject any `@<path>`. Per docs/specs/file-browser.md "Generic file
// drop" — the upload endpoint enforces the existing blocked-extension
// list (mirrors image-paste.md's policy) and the handler swallows the
// failure to onError(basename, msg) only.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { createServer } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');
const {
  makeFixtureDir,
  cleanupFixture,
  dispatchDrop,
} = require('../helpers/file-browser-v2-helpers');

test.describe('Drop blocked-extension file', () => {
  let server, port, url;
  let fixture;

  test.beforeAll(async () => {
    fixture = makeFixtureDir('drop-blocked');
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
    cleanupFixture(fixture);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  async function setupSession(page) {
    setupPageCapture(page);
    const sessionId = await page.evaluate(async ({ origin, name, wd }) => {
      const resp = await fetch(origin + '/api/sessions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, workingDir: wd }),
      });
      const data = await resp.json();
      return data.sessionId;
    }, { origin: url, name: 'drop-blocked', wd: fixture });
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    return sessionId;
  }

  test('drop a .exe → onError fires, no @<path> injection, no file on disk', async ({ page }) => {
    await setupSession(page);

    // Re-attach with an onError SPY so we can assert without coupling
    // to the project's toast surface (window.feedback may be absent in
    // some test bootstraps). We keep the production handler's other
    // semantics intact (real uploadImpl → real /api/files/upload).
    await page.evaluate(() => {
      // Dispose production handler first so only the spy fires.
      if (window.app._genericDropHandler &&
          typeof window.app._genericDropHandler.destroy === 'function') {
        window.app._genericDropHandler.destroy();
      }
      window._dropTest = { errors: [], injected: [] };
      const containerEl = document.getElementById('terminal');
      window.app._genericDropHandler = window.genericDropHandler.attachGenericDropHandler({
        containerEl,
        getWorkingDir: () => window.app.getCurrentWorkingDir(),
        getAuthToken: () => (window.authManager && window.authManager.getToken
          ? window.authManager.getToken() : null),
        injectAtPath: (atPath) => { window._dropTest.injected.push(atPath); },
        onError: (basename, msg) => { window._dropTest.errors.push({ basename, msg }); },
      });
    });

    // Drop a .exe — server's blocked-extension list rejects it (per
    // POST /api/files/upload's existing contract).
    const b64 = Buffer.from('MZ\x90\x00\x03\x00\x00').toString('base64');
    await dispatchDrop(page, '#terminal', [{
      name: 'malware.exe',
      mimeType: 'application/octet-stream',
      base64: b64,
    }]);

    // Wait for either the error to surface or a generous timeout.
    await page.waitForFunction(() => {
      return window._dropTest && window._dropTest.errors.length > 0;
    }, { timeout: 8000 });

    const result = await page.evaluate(() => ({
      errors: window._dropTest.errors,
      injected: window._dropTest.injected,
    }));

    expect(result.errors.length, 'onError must fire for blocked extension').toBe(1);
    expect(result.errors[0].basename).toBe('malware.exe');
    // Server's blocked-extension message can vary slightly across
    // versions; assert the meaningful keywords.
    expect(result.errors[0].msg.toLowerCase())
      .toMatch(/(blocked|not allowed|extension|denied|forbidden)/);

    // Critical: no injection happened.
    expect(result.injected.length, 'blocked uploads must NOT inject @<path>').toBe(0);

    // Critical: no file landed on disk under .claude-attachments/.
    const attachmentsDir = path.join(fixture, '.claude-attachments');
    if (fs.existsSync(attachmentsDir)) {
      const files = fs.readdirSync(attachmentsDir);
      expect(files.some((f) => f.endsWith('malware.exe')),
        'no .exe should have been written to disk').toBe(false);
    }
  });
});
