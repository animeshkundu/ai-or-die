// 62-click-git-diff.spec.js — clicking `--- a/src/app.js` (or the `+++
// b/...` form) resolves via stripGitDiffPrefix → working-tree file. Per
// Pattern #5 (git diff prefixes) in docs/specs/file-browser.md
// "Universal terminal-path detection". Pre-Part-C the regex EXCLUDED
// these; commit cdccede flips the policy: keep the prefix in the
// regex, strip it during resolution, try the working-tree file.

const { test, expect } = require('@playwright/test');
const { createServer } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
  waitForTerminalText,
} = require('../helpers/terminal-helpers');
const {
  makeFixtureDir,
  cleanupFixture,
  gitInitFixture,
  writeFileInside,
} = require('../helpers/file-browser-v2-helpers');

test.describe('Terminal click: git-diff path', () => {
  let server, port, url;
  let fixture;

  test.beforeAll(async () => {
    fixture = makeFixtureDir('click-diff');
    writeFileInside(fixture, 'src/app.js', 'module.exports = {};\n');
    // .git presence isn't strictly required for the working-tree resolve,
    // but a real diff would be inside a repo — initialise to keep the
    // fixture's invariants realistic.
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
    }, { origin: url, name: 'click-diff', wd: fixture });
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    return sessionId;
  }

  test('clicking `--- a/src/app.js` resolves to working-tree src/app.js', async ({ page }) => {
    await setupSession(page);

    // Print both lines so we can assert either side resolves correctly.
    // Using printf with %s ensures the leading dashes don't get
    // interpreted as flags.
    const lineA = '--- a/src/app.js';
    const lineB = '+++ b/src/app.js';
    await page.evaluate(({ a, b }) => {
      const send = (s) => window.app.socket.send(JSON.stringify({
        type: 'input',
        data: "printf '%s\\n' '" + s.replace(/'/g, "'\\''") + "'\r",
      }));
      send(a);
      send(b);
    }, { a: lineA, b: lineB });
    await waitForTerminalText(page, lineA, 8000);
    await waitForTerminalText(page, lineB, 8000);

    // Regex must now keep the diff prefix (it used to skip it).
    const regexHits = await page.evaluate(({ a, b }) => {
      const fb = window.fileBrowser;
      const ma = a.match(fb.LINK_RE_SINGLE);
      const mb = b.match(fb.LINK_RE_SINGLE);
      return {
        aPath: ma ? ma[2] : null,
        bPath: mb ? mb[2] : null,
      };
    }, { a: lineA, b: lineB });
    expect(regexHits.aPath, '`a/src/app.js` must be captured by the regex').toBe('a/src/app.js');
    expect(regexHits.bPath, '`b/src/app.js` must be captured by the regex').toBe('b/src/app.js');

    // resolveCandidates must produce a working-tree candidate after
    // stripping `a/` (handled internally via stripGitDiffPrefix).
    const aResolved = await page.evaluate(() => {
      const fb = window.fileBrowser;
      const sid = window.app.currentClaudeSessionId;
      const liveCwd = (window.app._liveCwd && sid) ? (window.app._liveCwd.get(sid) || null) : null;
      const session = (window.app.claudeSessions || []).find((s) => s.id === sid);
      const workingDir = session ? session.workingDir : null;
      const repoRoot = window.app._getRepoRootCached();
      return fb.resolveCandidates('a/src/app.js', { liveCwd, workingDir, repoRoot });
    });
    expect(aResolved.length).toBeGreaterThan(0);
    // At least one candidate should end with src/app.js (the stripped form).
    expect(aResolved.some((p) => /[/\\]src[/\\]app\.js$/.test(p)),
      'expected a candidate ending with src/app.js, got: ' + JSON.stringify(aResolved)).toBe(true);

    // Drive the full activate flow on the `a/` form.
    const result = await page.evaluate(async (hint) => {
      const fb = window.fileBrowser;
      const sid = window.app.currentClaudeSessionId;
      const liveCwd = (window.app._liveCwd && sid) ? (window.app._liveCwd.get(sid) || null) : null;
      const session = (window.app.claudeSessions || []).find((s) => s.id === sid);
      const workingDir = session ? session.workingDir : null;
      const repoRoot = window.app._getRepoRootCached();
      const candidates = fb.resolveCandidates(hint, { liveCwd, workingDir, repoRoot });
      const stats = await Promise.all(candidates.map(async (p) => {
        const r = await window.app.authFetch('/api/files/stat?path=' + encodeURIComponent(p));
        return { path: p, exists: r.status === 200 };
      }));
      const hits = stats.filter((s) => s.exists);
      if (hits.length === 1) {
        window.app.openFileInViewer(hits[0].path, null, null);
        return { mode: 'opened', path: hits[0].path };
      }
      return { mode: hits.length > 1 ? 'ambiguous' : 'notfound', count: hits.length };
    }, 'a/src/app.js');

    expect(result.mode, 'a/src/app.js should resolve to the working-tree file').toBe('opened');
    // Resolved path is the working-tree file (no leading `a/`).
    expect(result.path.replace(/\\/g, '/').endsWith('/src/app.js')).toBe(true);
    // And it lives inside our fixture, not somewhere else with the same name.
    expect(result.path.startsWith(fixture)).toBe(true);

    await expect(page.locator('.file-browser-panel.open')).toBeVisible({ timeout: 10000 });
  });
});
