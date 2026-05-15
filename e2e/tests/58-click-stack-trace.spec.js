// 58-click-stack-trace.spec.js — clicking a Node-style stack-trace path
// like `at Function (src/app.js:42:8)` opens that file at line 42.
//
// Per docs/specs/file-browser.md "Universal terminal-path detection"
// (Part C): the link-provider regex now recognises the stack-trace
// `(path:line:col)` form, the resolver chain stat-validates the
// candidate paths, and the click outcome routes through
// app.openFileInViewer(path, line, col) → file-viewer-monaco's
// revealLineInCenter (line 2494). The Monaco viewer consumes the line
// from `_pendingJumpTo` set by openFileInViewer.
//
// The xterm regex itself is exhaustively covered by the unit tests in
// test/link-provider-regex.test.js (25 cases). This E2E spec walks the
// integration: regex matches the printed line → resolver builds a
// candidate that exists → openFileInViewer fires with line=42.

const { test, expect } = require('@playwright/test');
const path = require('path');
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

test.describe('Terminal click: stack-trace path', () => {
  let server, port, url;
  let fixture;
  const targetRel = 'src/app.js';
  const targetLine = 42;
  // 50-line file so line 42 is real (Monaco silently clamps but a real
  // line is the right cross-check for revealLineInCenter behaviour).
  const fileBody = Array.from({ length: 50 }, (_, i) => `// line ${i + 1}\n`).join('');

  test.beforeAll(async () => {
    fixture = makeFixtureDir('click-trace');
    writeFileInside(fixture, targetRel, fileBody);
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
    const sessionId = await page.evaluate(async ({ origin, name, workingDir }) => {
      const resp = await fetch(origin + '/api/sessions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, workingDir }),
      });
      const data = await resp.json();
      return data.sessionId;
    }, { origin: url, name: 'click-trace', workingDir: fixture });
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    return sessionId;
  }

  test('clicking `at Function (src/app.js:42:8)` opens src/app.js at line 42', async ({ page }) => {
    await setupSession(page);

    // Print the stack-trace line into the terminal via printf so the
    // bytes flow through the PTY → onOutput → terminal.write(...) →
    // xterm buffer. Wait for the buffer to actually contain the text
    // before driving the link click.
    const printed = `at Function (${targetRel}:${targetLine}:8)`;
    await page.evaluate((line) => {
      window.app.socket.send(JSON.stringify({
        type: 'input',
        data: "printf '%s\\n' '" + line.replace(/'/g, "'\\''") + "'\r",
      }));
    }, printed);
    await waitForTerminalText(page, printed, 8000);

    // Sanity 1: the link provider IS wired on the active terminal —
    // matches the convention from 15-file-browser-rich-viewers.spec.js.
    const wired = await page.evaluate(() => ({
      linkProvider: !!(window.app.terminal && window.app.terminal._fbLinkProvider),
    }));
    expect(wired.linkProvider, 'link provider must be attached').toBe(true);

    // Sanity 2: the regex detects the printed text. We assert against
    // LINK_RE_SINGLE (the single-match variant) since matchAll uses the
    // same body; this catches future regressions in the broadened set
    // of patterns Part C added.
    const regexHit = await page.evaluate((text) => {
      const fb = window.fileBrowser;
      if (!fb || !fb.LINK_RE_SINGLE) return null;
      const m = text.match(fb.LINK_RE_SINGLE);
      if (!m) return null;
      // m[2] is the captured path body; the regex appends :line[:col] in
      // the tail group (m[3], m[4]).
      return { path: m[2], line: m[3] ? parseInt(m[3], 10) : null,
               col:  m[4] ? parseInt(m[4], 10) : null };
    }, printed);
    expect(regexHit, 'regex should match the printed stack-trace line').toBeTruthy();
    expect(regexHit.path).toBe(targetRel);
    expect(regexHit.line).toBe(targetLine);

    // Drive the click: replicate exactly what attachLinkProvider's
    // activate handler does (resolveCandidates → stat each → if 1 hit,
    // openFileInViewer; if many, ambiguity picker).
    const result = await page.evaluate(async ({ hint, line, col }) => {
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
        window.app.openFileInViewer(hits[0].path, line, col);
        // Snapshot _pendingJumpTo synchronously — file-viewer-monaco
        // consumes it inside the Monaco mount callback (microtask).
        const panel = window.app._fileBrowserPanel;
        return {
          mode: 'opened',
          path: hits[0].path,
          pendingJumpTo: panel && panel._pendingJumpTo
            ? { line: panel._pendingJumpTo.line, col: panel._pendingJumpTo.col }
            : null,
        };
      }
      return { mode: hits.length > 1 ? 'ambiguous' : 'notfound', candidates: hits.map((h) => h.path) };
    }, { hint: targetRel, line: targetLine, col: 8 });

    expect(result.mode, 'should resolve to exactly one match').toBe('opened');
    expect(result.path.endsWith(targetRel)).toBe(true);
    expect(result.pendingJumpTo, '_pendingJumpTo set with line+col').toBeTruthy();
    expect(result.pendingJumpTo.line).toBe(targetLine);
    expect(result.pendingJumpTo.col).toBe(8);

    // Panel opens as a side-effect of openFileInViewer.
    await expect(page.locator('.file-browser-panel.open')).toBeVisible({ timeout: 10000 });
  });
});
