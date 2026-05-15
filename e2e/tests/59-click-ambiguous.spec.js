// 59-click-ambiguous.spec.js — when a clicked path resolves to MULTIPLE
// existing files via the resolver chain, the ambiguity picker MUST be
// shown (no silent auto-pick — explicit anti-footgun rule from the
// adversarial review baked into the contract — see commit cdccede +
// docs/specs/file-browser.md "Ambiguity picker").
//
// Setup: three `utils.js` files reachable through the three different
// resolver candidates:
//
//   - workingDir/utils.js         (session spawn dir)
//   - subA/utils.js                (set as liveCwd via direct app patch)
//   - repoRoot/utils.js            (set via .git in the fixture root)
//
// Then a bare `utils.js` reference resolves to all three candidates,
// each stats 200, the activate path calls onAmbiguous → app's
// _showAmbiguityPicker renders the floating lozenge. Clicking the second
// row opens THAT file.

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
  gitInitFixture,
  writeFileInside,
} = require('../helpers/file-browser-v2-helpers');

test.describe('Terminal click: ambiguous path → picker', () => {
  let server, port, url;
  let fixture;       // = repoRoot
  let workingDir;    // subdir 1
  let liveDir;       // subdir 2

  test.beforeAll(async () => {
    fixture = makeFixtureDir('click-ambig');
    workingDir = path.join(fixture, 'work');
    liveDir = path.join(fixture, 'live');

    // utils.js in all three places — distinct contents so the assertion
    // can verify the *correct* one opens after the user picks a row.
    writeFileInside(fixture,    'utils.js', 'module.exports = "repoRoot";\n');
    writeFileInside(workingDir, 'utils.js', 'module.exports = "workingDir";\n');
    writeFileInside(liveDir,    'utils.js', 'module.exports = "liveDir";\n');

    // Repo root needs an actual .git so /api/sessions/:id/repo-root
    // returns it.
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
    }, { origin: url, name: 'click-ambig', wd: workingDir });
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    return sessionId;
  }

  test('three matching utils.js files → picker lists all three; selection opens the chosen one', async ({ page }) => {
    await setupSession(page);

    // Inject a synthetic liveCwd for the session so the resolver chain
    // produces the third candidate. (We could also emit OSC 7 via a
    // printf — covered by 56-cwd-osc7.spec.js — but skipping that here
    // keeps the spec focused on the picker logic.)
    await page.evaluate((cwd) => {
      const sid = window.app.currentClaudeSessionId;
      if (!window.app._liveCwd) window.app._liveCwd = new Map();
      window.app._liveCwd.set(sid, cwd);
    }, liveDir);

    // Prime the repo-root cache by calling the API directly so it
    // returns synchronously on the next read (the cache is populated
    // when the in-flight fetch resolves).
    await page.evaluate(async () => {
      const sid = window.app.currentClaudeSessionId;
      // Touch the cached helper to fire the fetch.
      window.app._getRepoRootCached();
      // Wait for it to settle.
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const root = window.app._getRepoRootCached();
        if (root) return root;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    });

    // Verify resolveCandidates produces three distinct paths for "utils.js".
    const candidates = await page.evaluate(() => {
      const fb = window.fileBrowser;
      const sid = window.app.currentClaudeSessionId;
      const liveCwd = window.app._liveCwd.get(sid) || null;
      const session = (window.app.claudeSessions || []).find((s) => s.id === sid);
      const workingDir = session ? session.workingDir : null;
      const repoRoot = window.app._getRepoRootCached();
      return fb.resolveCandidates('utils.js', { liveCwd, workingDir, repoRoot });
    });
    expect(candidates.length, 'three candidates: liveCwd, workingDir, repoRoot').toBe(3);
    // Set form to dedupe + spot-check each comes from a different scope.
    const set = new Set(candidates.map((p) => p.replace(/\\/g, '/')));
    expect(set.size).toBe(3);
    expect(candidates.some((p) => p.endsWith('live' + path.sep + 'utils.js')
                                 || p.endsWith('live/utils.js'))).toBe(true);
    expect(candidates.some((p) => p.endsWith('work' + path.sep + 'utils.js')
                                 || p.endsWith('work/utils.js'))).toBe(true);

    // Run the click (resolver + stat + ambiguity dispatch) — same as
    // attachLinkProvider's activate path. Crucially, the picker contract
    // requires a `choose` callback in the info object: the picker invokes
    // info.choose(selectedPath) on row click. Production wires this to
    // openInViewer (file-browser.js:3708-3710); the test does the same so
    // a row click actually opens the file.
    const result = await page.evaluate(async () => {
      const fb = window.fileBrowser;
      const sid = window.app.currentClaudeSessionId;
      const liveCwd = window.app._liveCwd.get(sid) || null;
      const session = (window.app.claudeSessions || []).find((s) => s.id === sid);
      const workingDir = session ? session.workingDir : null;
      const repoRoot = window.app._getRepoRootCached();
      const candidates = fb.resolveCandidates('utils.js', { liveCwd, workingDir, repoRoot });
      const stats = await Promise.all(candidates.map(async (p) => {
        const r = await window.app.authFetch('/api/files/stat?path=' + encodeURIComponent(p));
        return { path: p, exists: r.status === 200 };
      }));
      const hits = stats.filter((s) => s.exists);
      if (hits.length > 1) {
        window.app._showAmbiguityPicker({
          hint: 'utils.js',
          candidates: hits.map((h) => h.path),
          line: null, col: null,
          // Mirrors file-browser.js:3708 — the picker calls this on selection.
          choose: function (chosen) {
            if (chosen) window.app.openFileInViewer(chosen, null, null);
          },
        });
        return { mode: 'ambiguous', count: hits.length, paths: hits.map((h) => h.path) };
      }
      return { mode: 'opened', count: 1 };
    });
    expect(result.mode).toBe('ambiguous');
    expect(result.count).toBe(3);

    // Picker DOM is rendered. Class names per file-browser.js Part C.
    const picker = page.locator('.fb-ambiguity-picker');
    await expect(picker).toBeVisible({ timeout: 5000 });
    const rows = picker.locator('.fb-ambiguity-row');
    await expect(rows).toHaveCount(3);

    // Header announces the count.
    await expect(picker.locator('.fb-ambiguity-header'))
      .toContainText('3 matches');

    // Pick the second row — assert that file opens. Get its path text
    // first so we can assert the right tab opens (the row's data-path
    // attribute, falling back to whatever data the picker stamps on it).
    const targetPath = result.paths[1];
    await rows.nth(1).click();

    // Tab opens with the chosen path.
    await page.waitForFunction((expectedPath) => {
      const fb = window.app._fileBrowserPanel;
      const tm = fb && fb._tabManager;
      if (!tm || !Array.isArray(tm._tabs)) return false;
      const norm = (p) => String(p).replace(/\\/g, '/');
      return tm._tabs.some((t) => t.path && norm(t.path) === norm(expectedPath));
    }, targetPath, { timeout: 8000 });

    // Picker dismisses after pick.
    await expect(picker).toBeHidden({ timeout: 5000 });
  });
});
