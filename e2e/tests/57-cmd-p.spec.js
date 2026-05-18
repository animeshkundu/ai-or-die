// 57-cmd-p.spec.js — Cmd+P "Go to File" fuzzy filename picker.
//
// Per docs/specs/file-browser.md §"Fuzzy file-find (Cmd-P)" + commits
// 41993c0 (server) + 55f9df8 (client). Exercises:
//
//   - Toggling the find panel (Cmd/Ctrl+P binding wired in app.js).
//   - Typing a partial filename returns matching files via /api/files/find.
//   - Enter opens the focused file in a preview tab.
//   - Cmd/Ctrl+Enter opens it in an editor tab.
//   - .gitignored entries (e.g. node_modules/) do NOT appear in results
//     because the server's `rg --files` honours .gitignore — but only
//     when the search root is inside a real git repo. The fixture is
//     `git init`'d for that reason (heads-up from systems-engineer).
//
// We invoke `app.toggleFindPanel()` directly to open the panel rather
// than dispatching a Ctrl+P keystroke: when the terminal has focus, the
// global keybinding suppresses itself (target tag is the xterm hidden
// TEXTAREA), so a `keyboard.press('Control+p')` would no-op. The
// keybinding wiring is exercised by the unit tests for app.js; this
// spec validates the panel + endpoint integration.

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
  gitInitFixture,
  writeFileInside,
} = require('../helpers/file-browser-v2-helpers');

test.describe('Cmd+P fuzzy file find', () => {
  let server, port, url;
  let fixture;

  test.beforeAll(async () => {
    fixture = makeFixtureDir('cmdp');
    // Files we DO expect to find.
    writeFileInside(fixture, 'hello-world.js', 'console.log("hi");\n');
    writeFileInside(fixture, 'src/app.js', 'module.exports = {};\n');
    writeFileInside(fixture, 'src/utility.js', 'exports.x = 1;\n');
    writeFileInside(fixture, 'README.md', '# fixture\n');
    // Files inside .gitignored dirs — must NOT appear.
    writeFileInside(fixture, 'node_modules/secret/internal.js', 'leaked = true;\n');
    writeFileInside(fixture, '.gitignore', 'node_modules/\n');
    // git init so rg honours .gitignore (rg only reads .gitignore inside
    // a real git repo — confirmed in commit a166689's review notes).
    gitInitFixture(fixture);

    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
    cleanupFixture(fixture);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  /**
   * Boot a session whose workingDir is the test fixture, so the server's
   * /api/files/find defaults the search root to it.
   */
  async function setupSession(page) {
    setupPageCapture(page);
    const sessionId = await page.evaluate(async ({ origin, name, workingDir }) => {
      const resp = await fetch(origin + '/api/sessions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, workingDir }),
      });
      const data = await resp.json();
      return data.sessionId;
    }, { origin: url, name: 'cmdp-test', workingDir: fixture });
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    return sessionId;
  }

  /** Wait for the find panel to be open + ready. */
  async function openFindPanelAndQuery(page, query) {
    await page.evaluate(() => window.app.toggleFindPanel());
    await page.waitForFunction(() => {
      const p = window.app && window.app._findPanel;
      return p && typeof p.isOpen === 'function' && p.isOpen();
    }, { timeout: 5000 });
    // runQuery sets the input value AND triggers _runQueryNow synchronously;
    // the actual fetch is async, so wait for results to land.
    await page.evaluate((q) => window.app._findPanel.runQuery(q), query);
    await page.waitForFunction(() => {
      const p = window.app && window.app._findPanel;
      return p && Array.isArray(p._lastResults);
    }, { timeout: 5000 });
    // Wait until results have loaded OR the status flips off "Searching…".
    await page.waitForFunction(() => {
      const p = window.app && window.app._findPanel;
      if (!p) return false;
      // Either we got results, or the search completed (possibly empty).
      return (p._lastResults && p._lastResults.length > 0) ||
             (p._statusEl && !p._statusEl.classList.contains('busy'));
    }, { timeout: 8000 });
  }

  test('Cmd+P → query opens panel, gitignored files excluded, Enter opens preview tab', async ({ page }) => {
    await setupSession(page);

    await openFindPanelAndQuery(page, 'hello');

    // Inspect the rendered matches via the panel's last-results cache.
    const seen = await page.evaluate(() => {
      const p = window.app._findPanel;
      const matches = (p && p._lastResults) || [];
      return matches.map((m) => m.path);
    });
    expect(seen.length, 'at least one match for "hello"').toBeGreaterThan(0);
    expect(seen.some((p) => p.endsWith('hello-world.js')),
      'hello-world.js should appear; got: ' + JSON.stringify(seen)).toBe(true);
    // No node_modules path — rg must have honoured .gitignore.
    expect(seen.every((p) => !p.includes('node_modules')),
      'node_modules paths must not appear (.gitignore respected)').toBe(true);

    // Press Enter via the panel's keyboard handler entry point: focus
    // is auto-set to index 0 after a successful query, so _activateFocused
    // mirrors what the Enter key would do.
    await page.evaluate(() => {
      window.app._findPanel._activateFocused('preview');
    });

    // Tab manager opens the file. Assert a tab now exists referencing
    // hello-world.js.
    await page.waitForFunction(() => {
      const fb = window.app._fileBrowserPanel;
      const tm = fb && fb._tabManager;
      if (!tm || !Array.isArray(tm._tabs)) return false;
      for (const t of tm._tabs) {
        if (t.path && t.path.endsWith('hello-world.js')) return true;
      }
      return false;
    }, { timeout: 8000 });
  });

  test('Cmd+Enter variant → opens editor tab (covers nested paths)', async ({ page }) => {
    await setupSession(page);

    // Use the nested file `src/utility.js` — the editor mode + nested
    // path combination was the failure mode of the openToFile rebase
    // bug fixed in commit 2298d2d. Keeping it nested here guards
    // against a regression of that fix.
    await openFindPanelAndQuery(page, 'utility');

    const seen = await page.evaluate(() => {
      const p = window.app._findPanel;
      return (p._lastResults || []).map((m) => m.path);
    });
    expect(seen.some((p) => p.endsWith('utility.js')),
      'utility.js should appear; got: ' + JSON.stringify(seen)).toBe(true);

    // Move focus to the utility.js row explicitly (defensive against
    // fuzzysort score ties).
    await page.evaluate(() => {
      const p = window.app._findPanel;
      const idx = (p._lastResults || []).findIndex((m) => m.path && m.path.endsWith('utility.js'));
      if (idx >= 0) p._focusedIndex = idx;
    });

    // 'editor' mode mirrors Cmd/Ctrl+Enter — _activateFocused inspects
    // mode and routes through onResultClick({ path, mode: 'editor' }).
    await page.evaluate(() => {
      window.app._findPanel._activateFocused('editor');
    });

    await page.waitForFunction(() => {
      const fb = window.app._fileBrowserPanel;
      const tm = fb && fb._tabManager;
      if (!tm || !Array.isArray(tm._tabs)) return false;
      for (const t of tm._tabs) {
        if (t.path && t.path.endsWith('utility.js') && t.mode === 'editor') return true;
      }
      return false;
    }, { timeout: 8000 });
  });
});
