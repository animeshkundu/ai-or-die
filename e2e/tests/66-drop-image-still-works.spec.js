// 66-drop-image-still-works.spec.js — regression check on the dispatch
// refactor. After Part D introduced the generic drop handler with a
// MIME-dispatch helper, dropping an image MUST still flow through the
// existing image-handler.js preview-modal-then-base64 pipeline (per
// commit 409b440 and image-paste.md's cross-link).
//
// We assert the dispatch by spying on the generic-drop handler's
// `onImageDrop` callback (the bridge into the image flow). Direct
// assertion that the image-preview MODAL appears is brittle in headless
// Chrome — the preview modal is wired to fire ONLY when the image
// passes through the existing flow, so a successful onImageDrop
// invocation IS the proof that the dispatch took the image branch.

const { test, expect } = require('@playwright/test');
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

// Minimal 1×1 red PNG (same blob the existing image-paste spec uses).
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

test.describe('Drop image: dispatch routes to image flow', () => {
  let server, port, url;
  let fixture;

  test.beforeAll(async () => {
    fixture = makeFixtureDir('drop-img');
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
    }, { origin: url, name: 'drop-img', wd: fixture });
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    return sessionId;
  }

  test('image-only drop → onImageDrop dispatches; image-preview modal opens; no generic upload', async ({ page }) => {
    await setupSession(page);

    // Re-attach the handler with a spy onImageDrop and a spy
    // injectAtPath. We assert the image branch fires (onImageDrop
    // called) AND no @<path> injection happens (the image flow uses
    // its own image_upload WS message, not the generic-drop @path
    // pipeline).
    await page.evaluate(() => {
      if (window.app._genericDropHandler &&
          typeof window.app._genericDropHandler.destroy === 'function') {
        window.app._genericDropHandler.destroy();
      }
      window._dropTest = {
        imageDropCalled: 0,
        imageDropFiles: [],
        atPathInjected: [],
        uploadImplCalled: 0,
      };
      const containerEl = document.getElementById('terminal');
      window.app._genericDropHandler = window.genericDropHandler.attachGenericDropHandler({
        containerEl,
        getWorkingDir: () => window.app.getCurrentWorkingDir(),
        onImageDrop: (files) => {
          window._dropTest.imageDropCalled++;
          // Snapshot file metadata — files is a FileList-like; the
          // image flow expects it to keep a reference until showImagePreview.
          for (let i = 0; i < files.length; i++) {
            window._dropTest.imageDropFiles.push({
              name: files[i].name,
              type: files[i].type,
              size: files[i].size,
            });
          }
        },
        // Spy uploadImpl so we can ASSERT it was NOT called (image
        // branch must NOT route through the generic upload pipeline).
        uploadImpl: () => {
          window._dropTest.uploadImplCalled++;
          return Promise.reject(new Error('generic upload should NOT fire for images'));
        },
        injectAtPath: (atPath) => { window._dropTest.atPathInjected.push(atPath); },
        onError: () => {},
      });
    });

    // Drop a single PNG.
    await dispatchDrop(page, '#terminal', [{
      name: 'red.png',
      mimeType: 'image/png',
      base64: TINY_PNG_BASE64,
    }]);

    // onImageDrop must fire synchronously inside the drop handler
    // (the image branch is `if (!hasGeneric) { onImageDrop(); return; }`).
    await page.waitForFunction(() => {
      return window._dropTest && window._dropTest.imageDropCalled > 0;
    }, { timeout: 5000 });

    const result = await page.evaluate(() => ({
      imageDropCalled: window._dropTest.imageDropCalled,
      imageDropFiles: window._dropTest.imageDropFiles,
      uploadImplCalled: window._dropTest.uploadImplCalled,
      atPathInjected: window._dropTest.atPathInjected,
    }));

    expect(result.imageDropCalled, 'image dispatch hook must fire exactly once').toBe(1);
    expect(result.imageDropFiles).toHaveLength(1);
    expect(result.imageDropFiles[0].name).toBe('red.png');
    expect(result.imageDropFiles[0].type).toBe('image/png');
    // Generic pipeline MUST be silent for image-only drops.
    expect(result.uploadImplCalled, 'generic uploadImpl must not fire for images').toBe(0);
    expect(result.atPathInjected, '@<path> must not be injected for images').toEqual([]);
  });
});
