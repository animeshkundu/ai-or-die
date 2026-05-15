// 64-drop-multi-cancel.spec.js — drop multiple files, cancel mid-upload
// via the controller's cancelInFlight() → only the uploads that
// succeeded before the cancel inject their `@<path>`. Per
// docs/specs/file-browser.md "Generic file drop" + commit 409b440's
// description "Cancel: returned controller exposes cancelInFlight()
// that aborts all in-flight uploads via per-upload AbortController.
// Already-uploaded files keep their @path injection (per spec)."
//
// We re-attach a test-controlled handler with a custom uploadImpl that
// resolves a fixed number of uploads instantly and HANGS the rest until
// their AbortController fires. This gives us deterministic timing
// instead of racing real network I/O.

const { test, expect } = require('@playwright/test');
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

test.describe('Drop multiple files + cancel mid-upload', () => {
  let server, port, url;
  let fixture;

  test.beforeAll(async () => {
    fixture = makeFixtureDir('drop-cancel');
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
    }, { origin: url, name: 'drop-cancel', wd: fixture });
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    return sessionId;
  }

  test('drop 5 files + cancel → only completed uploads inject (< 5)', async ({ page }) => {
    await setupSession(page);

    // Re-attach a TEST handler with a controlled uploadImpl. The
    // production handler is also still listening — to avoid a duplicate
    // upload pipeline contaminating the test, dispose it first via the
    // `destroy` method exposed by the production handler.
    await page.evaluate(() => {
      if (window.app._genericDropHandler &&
          typeof window.app._genericDropHandler.destroy === 'function') {
        window.app._genericDropHandler.destroy();
        window.app._genericDropHandler = null;
      }

      // Tracker arrays for the test to drive resolution timing.
      window._dropTest = {
        completed: [],   // set of file basenames whose upload resolved ok
        aborted:   [],   // set of file basenames whose abort signal fired
        injected:  [],   // set of @<path> strings the handler injected
      };

      // Custom uploadImpl: first 2 succeed instantly; rest hang until
      // their AbortController fires (then reject with AbortError).
      let callCount = 0;
      const uploadImpl = (targetPath, file, fetchOpts) => {
        callCount++;
        const idx = callCount;
        if (idx <= 2) {
          // Synthesize a 201 Response with a JSON body the handler can
          // unwrap to get the absolute path back.
          window._dropTest.completed.push(file.name);
          const body = JSON.stringify({ path: targetPath });
          return Promise.resolve(new Response(body, {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        // Index 3+: hang until aborted.
        return new Promise((_resolve, reject) => {
          const sig = fetchOpts && fetchOpts.signal;
          if (sig) {
            sig.addEventListener('abort', () => {
              window._dropTest.aborted.push(file.name);
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      };

      // Re-create the handler with the custom uploadImpl.
      const containerEl = document.getElementById('terminal');
      window.app._genericDropHandler = window.genericDropHandler.attachGenericDropHandler({
        containerEl,
        getWorkingDir: () => window.app.getCurrentWorkingDir(),
        uploadImpl,
        injectAtPath: (atPath) => {
          if (atPath) window._dropTest.injected.push(atPath);
        },
        onError: () => {},
      });
    });

    // Drop 5 small distinct files. base64 of a 4-byte payload is plenty.
    const b64 = Buffer.from('test').toString('base64');
    await dispatchDrop(page, '#terminal', [
      { name: 'a.txt', mimeType: 'text/plain', base64: b64 },
      { name: 'b.txt', mimeType: 'text/plain', base64: b64 },
      { name: 'c.txt', mimeType: 'text/plain', base64: b64 },
      { name: 'd.txt', mimeType: 'text/plain', base64: b64 },
      { name: 'e.txt', mimeType: 'text/plain', base64: b64 },
    ]);

    // Let the worker queue dispatch through MAX_PARALLEL_UPLOADS (=4)
    // and process the 2 instant-success uploads.
    await page.waitForFunction(() => {
      return window._dropTest && window._dropTest.injected.length >= 2;
    }, { timeout: 5000 });

    // Now cancel. The 2 successes have ALREADY injected; remaining
    // in-flight uploads (the 3rd and 4th, the 5th hasn't started yet
    // because parallel cap is 4 and 2 of those slots are held by the
    // hanging promises) get aborted.
    await page.evaluate(() => {
      window.app._genericDropHandler.cancelInFlight();
    });

    // Brief settle window — give the abort handlers a tick to record
    // and the queue a chance to (correctly) NOT process the 5th file.
    await page.waitForTimeout(500);

    const final = await page.evaluate(() => {
      const t = window._dropTest;
      return {
        injected: t.injected.slice(),
        completed: t.completed.slice(),
        aborted: t.aborted.slice(),
      };
    });

    // Spec contract:
    //   - At least one but strictly fewer than 5 paths injected (partial).
    //   - Injected paths correspond to the 2 completed uploads only.
    expect(final.injected.length, 'partial injection: ≥1 and <5').toBeGreaterThanOrEqual(1);
    expect(final.injected.length, 'partial injection: <5').toBeLessThan(5);
    expect(final.completed.length).toBe(2);
    // Abort fires for the in-flight slot occupants. With MAX_PARALLEL_UPLOADS=4,
    // initial dispatch fills slots 1-4. As slots 1 + 2 resolve (instant),
    // the queue dispatches slot 5. Then 3, 4, AND 5 are all hanging — so
    // cancel aborts all 3.
    expect(final.aborted.length, 'all hanging slots get aborted').toBe(3);
    // Each injected path must include the .claude-attachments prefix
    // and start with `@` (Claude's native file-reference syntax).
    final.injected.forEach((p) => {
      expect(p.startsWith('@'),
        'injected ref must start with @, got: ' + JSON.stringify(p)).toBe(true);
      expect(p.includes('.claude-attachments'),
        'injected ref must contain .claude-attachments').toBe(true);
    });
  });
});
