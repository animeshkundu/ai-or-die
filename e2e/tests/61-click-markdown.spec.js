// 61-click-markdown.spec.js — markdown link `[label](src/app.js:10)`
// is detected and opens at line 10. Per Pattern #3 in
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

test.describe('Terminal click: markdown link', () => {
  let server, port, url;
  let fixture;
  const targetRel = 'src/app.js';
  const targetLine = 10;

  test.beforeAll(async () => {
    fixture = makeFixtureDir('click-md');
    // 20-line file so line 10 is real.
    const body = Array.from({ length: 20 }, (_, i) => `// line ${i + 1}\n`).join('');
    writeFileInside(fixture, targetRel, body);
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
    }, { origin: url, name: 'click-md', wd: fixture });
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    return sessionId;
  }

  test('clicking `[label](src/app.js:10)` opens src/app.js at line 10', async ({ page }) => {
    await setupSession(page);

    const printed = `[label](${targetRel}:${targetLine})`;
    // Single-quote the printf format so the brackets stay literal in
    // the shell. Use printf %s to avoid backslash interpretation.
    await page.evaluate((line) => {
      window.app.socket.send(JSON.stringify({
        type: 'input',
        data: "printf '%s\\n' '" + line.replace(/'/g, "'\\''") + "'\r",
      }));
    }, printed);
    await waitForTerminalText(page, printed, 8000);

    // Regex extracts path + line.
    const regexHit = await page.evaluate((text) => {
      const fb = window.fileBrowser;
      const m = text.match(fb.LINK_RE_SINGLE);
      if (!m) return null;
      return { path: m[2], line: m[3] ? parseInt(m[3], 10) : null };
    }, printed);
    expect(regexHit, 'markdown-link form should match the link regex').toBeTruthy();
    expect(regexHit.path).toBe(targetRel);
    expect(regexHit.line).toBe(targetLine);

    const result = await page.evaluate(async ({ hint, line }) => {
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
        window.app.openFileInViewer(hits[0].path, line, null);
        const panel = window.app._fileBrowserPanel;
        return {
          mode: 'opened',
          path: hits[0].path,
          pendingJumpTo: panel && panel._pendingJumpTo
            ? { line: panel._pendingJumpTo.line }
            : null,
        };
      }
      return { mode: hits.length > 1 ? 'ambiguous' : 'notfound' };
    }, { hint: targetRel, line: targetLine });

    expect(result.mode).toBe('opened');
    expect(result.pendingJumpTo).toBeTruthy();
    expect(result.pendingJumpTo.line).toBe(targetLine);

    await expect(page.locator('.file-browser-panel.open')).toBeVisible({ timeout: 10000 });
  });
});
