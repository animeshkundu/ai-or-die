// 60-click-bare-path.spec.js — bare relative path with allowlisted
// extension (e.g. `src/app.js`) is detected and opened via the resolver
// chain (workingDir → liveCwd → repoRoot). Per Pattern #1 in
// docs/specs/file-browser.md "Universal terminal-path detection".

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
  writeFileInside,
} = require('../helpers/file-browser-v2-helpers');

test.describe('Terminal click: bare relative path', () => {
  let server, port, url;
  let fixture;

  test.beforeAll(async () => {
    fixture = makeFixtureDir('click-bare');
    writeFileInside(fixture, 'src/app.js', 'module.exports = {};\n');
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
    }, { origin: url, name: 'click-bare', wd: fixture });
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    return sessionId;
  }

  test('clicking `src/app.js` resolves via workingDir and opens that file', async ({ page }) => {
    await setupSession(page);

    const printed = 'src/app.js';
    await page.evaluate((p) => {
      window.app.socket.send(JSON.stringify({
        type: 'input',
        data: "printf '%s\\n' '" + p + "'\r",
      }));
    }, printed);
    await waitForTerminalText(page, printed, 8000);

    // Regex must match the bare path.
    const regexHit = await page.evaluate((text) => {
      const fb = window.fileBrowser;
      const m = text.match(fb.LINK_RE_SINGLE);
      return m ? { path: m[2] } : null;
    }, printed);
    expect(regexHit).toBeTruthy();
    expect(regexHit.path).toBe(printed);

    // Drive the click flow.
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
    }, printed);

    expect(result.mode, 'bare path resolves to exactly one file via workingDir').toBe('opened');
    // Path should be inside our fixture (workingDir) — not somewhere else.
    expect(result.path.replace(/\\/g, '/').endsWith('/src/app.js')).toBe(true);
    expect(result.path.startsWith(fixture)).toBe(true);

    await expect(page.locator('.file-browser-panel.open')).toBeVisible({ timeout: 10000 });
  });
});
