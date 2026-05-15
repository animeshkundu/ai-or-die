// 15-file-browser-rich-viewers.spec.js — server-side scenarios for the
// rich-viewer + cross-file search work: terminal-link click (#7), PDF.js
// preview (#19), Compare-with-HEAD diff (#8 git-show), Cmd+Shift+F search
// (#13 SSE).
//
// These are intentionally focused on the SERVER-touching paths (link
// validation hits /api/files/stat, PDF.js fetches /api/files/download,
// diff hits /api/files/git-show, search consumes /api/search SSE).
// Engineer's #11 covers the non-server scenarios in a separate spec.
//
// Ports: createServer() picks port 0 → kernel-assigned high port, always
// >11000 in practice. Per CLAUDE.md / team-lead protocol, NEVER touches
// port 7777.

const { test, expect } = require('@playwright/test');
const { createServer } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  attachFailureArtifacts,
} = require('../helpers/terminal-helpers');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

test.describe('File browser — rich viewers + search (#7, #19, #8, #13)', () => {
  let server, port, url;

  // Self-contained fixture dir with: a JS file (for the terminal click
  // test), a tiny PDF (for PDF.js), and a git repo for Compare-with-HEAD.
  const fixtureDir = path.join(__dirname, '..', 'fixtures', 'file-browser-rich-test');
  const repoDir = path.join(fixtureDir, 'repo');
  const jsTarget = path.join(fixtureDir, 'app.js');
  const searchTarget1 = path.join(fixtureDir, 'haystack1.txt');
  const searchTarget2 = path.join(fixtureDir, 'haystack2.txt');
  const pdfPath = path.join(fixtureDir, 'sample.pdf');

  // Detect git availability for the diff test (skip cleanly otherwise).
  let gitAvailable = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); }
  catch (_) { gitAvailable = false; }

  test.beforeAll(async () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });

    // Multi-line JS file so the link "app.js:42" makes sense visually.
    const lines = [];
    for (let i = 1; i <= 60; i++) {
      lines.push(`// line ${i} of app.js fixture for terminal-link test`);
    }
    fs.writeFileSync(jsTarget, lines.join('\n') + '\n');

    // Search corpus.
    fs.writeFileSync(searchTarget1, 'alpha\nNEEDLE-PRESENT in line two\nbeta\n');
    fs.writeFileSync(searchTarget2, 'gamma\ndelta NEEDLE-PRESENT here\n');

    // Tiny valid PDF (just header + minimal trailer is enough for PDF.js
    // to refuse politely; we want a real-but-tiny PDF that PDF.js can at
    // least START loading. Use a synthesized minimal PDF.)
    const pdfBytes = Buffer.from(
      '%PDF-1.4\n' +
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj\n' +
      '4 0 obj<</Length 44>>stream\n' +
      'BT /F1 24 Tf 50 100 Td (e2e PDF) Tj ET\n' +
      'endstream\nendobj\n' +
      'xref\n0 5\n' +
      '0000000000 65535 f \n' +
      '0000000010 00000 n \n' +
      '0000000053 00000 n \n' +
      '0000000098 00000 n \n' +
      '0000000165 00000 n \n' +
      'trailer<</Size 5/Root 1 0 R>>\nstartxref\n245\n%%EOF\n',
      'utf-8'
    );
    fs.writeFileSync(pdfPath, pdfBytes);

    // git repo with one committed file, mutated in working tree → diff
    // visible. Skip if git absent.
    if (gitAvailable) {
      const gitFile = path.join(repoDir, 'tracked.txt');
      execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: repoDir });
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
      fs.writeFileSync(gitFile, 'committed-line-1\ncommitted-line-2\n');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: repoDir });
      execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: repoDir });
      // Mutate working tree.
      fs.writeFileSync(gitFile, 'committed-line-1\nworking-tree-modification\n');
    }

    const result = await createServer();
    server = result.server;
    port = result.port;
    url = result.url;
  });

  test.afterAll(async () => {
    if (server) await server.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  async function setupPage(page) {
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await page.waitForFunction(() => {
      const overlay = document.getElementById('overlay');
      return !overlay || overlay.style.display === 'none' || overlay.offsetParent === null;
    }, { timeout: 30000 });
  }

  // ──────────────────────────────────────────────────────────────────────
  // (b) Terminal link-provider — write `<jsTarget>:42` into the terminal,
  //     simulate the activate handler firing on it, verify the file
  //     browser opens to that file. We can't easily click on rendered
  //     xterm canvas glyphs, so we exercise the path by directly invoking
  //     the link provider's activation through the public `openFileInViewer`
  //     surface — this is what the click handler ultimately calls after
  //     the /api/files/stat validation.
  // ──────────────────────────────────────────────────────────────────────
  test('(b) terminal link click → opens viewer at the right file (#7)', async ({ page }) => {
    await setupPage(page);

    // Sanity: the link provider AND TerminalPathDetector must be wired.
    const wired = await page.evaluate(() => {
      const term = window.app && window.app.terminal;
      return {
        linkProvider: !!(term && term._fbLinkProvider),
        pathDetector: !!(term && term._fbPathDetector),
      };
    });
    expect(wired.linkProvider, 'xterm link provider should be attached').toBe(true);
    expect(wired.pathDetector, 'TerminalPathDetector should be wired').toBe(true);

    // Resolve the absolute path the regex would extract from terminal text.
    // The activate handler resolves relatives against getCurrentWorkingDir();
    // since our fixture is absolute, that's a no-op. Forward-slash the
    // path so it's a valid URL-encodable form on every platform.
    const targetPath = jsTarget.replace(/\\/g, '/');
    const targetLine = 42;

    // Trigger what `activate()` does: validate via /api/files/stat, then
    // call openFileInViewer(path, line, col). This is the user-observable
    // outcome of clicking an underlined link.
    //
    // We pass path + line as STRUCTURED data via the evaluate arg instead
    // of as `path:line` and splitting on `:` inside the page — that split
    // breaks on Windows because the drive-letter prefix (`C:\...`)
    // contains a colon that the simple `split(':')` would mistake for
    // the line separator. The activate flow's actual `path:line:col`
    // parser uses a regex anchored at the end of the string to handle
    // Windows drives correctly; this test just exercises the wiring
    // downstream of that parser.
    //
    // We capture `_pendingJumpTo` synchronously inside the same evaluate
    // because file-browser.js consumes the flag on the next event-loop
    // tick when the auto-opened preview mounts (commit cef62bf wired the
    // jump-to-line through to the Monaco viewer + cleared the flag on
    // consume). Reading the flag from a separate `page.evaluate` after
    // the panel opens would race the consume — pendingJumpTo would
    // already be null.
    const result = await page.evaluate(async ({ pathPart, line }) => {
      const stat = await window.app.authFetch('/api/files/stat?path=' + encodeURIComponent(pathPart));
      if (!stat.ok) return { ok: false, status: stat.status };
      window.app.openFileInViewer(pathPart, line, 1);
      // Snapshot the field BEFORE the async preview-mount consumes it.
      const panel = window.app._fileBrowserPanel;
      const pj = panel && panel._pendingJumpTo;
      return {
        ok: true,
        pendingJumpTo: pj ? { line: pj.line, col: pj.col } : null,
      };
    }, { pathPart: targetPath, line: targetLine });

    expect(result.ok, 'stat should succeed for fixture path; status was ' + (result.status || 'n/a')).toBe(true);
    expect(result.pendingJumpTo, 'pendingJumpTo should be set with line 42').toBeTruthy();
    expect(result.pendingJumpTo.line).toBe(42);

    // Panel opens, navigates to the parent dir, and registers the pending
    // file via openToFile. We assert the panel is open as a sanity check;
    // the jump-to-line assertion above was the load-bearing one.
    await expect(page.locator('.file-browser-panel.open')).toBeVisible({ timeout: 10000 });
  });

  // ──────────────────────────────────────────────────────────────────────
  // (g) PDF.js viewer — open a PDF, ensure the viewer chrome appears and
  //     a canvas is rendered (PDF.js rendered page 1 to <canvas>).
  // ──────────────────────────────────────────────────────────────────────
  test('(g) PDF preview → PDF.js viewer renders page 1 (#19)', async ({ page }) => {
    await setupPage(page);

    // Confirm the PDF viewer module exposed itself globally.
    const hasViewer = await page.evaluate(() => !!(window.fbPdfViewer && typeof window.fbPdfViewer.render === 'function'));
    expect(hasViewer, 'window.fbPdfViewer.render must be defined').toBe(true);

    // Open the file browser to the fixture dir + select the PDF.
    const fixturePath = fixtureDir.replace(/\\/g, '/');
    await page.evaluate((dir) => {
      window.app._ensureFileBrowser();
      window.app._fileBrowserPanel.open(dir);
    }, fixturePath);
    await page.waitForSelector('.file-browser-panel.open', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.file-browser-item').length > 0, { timeout: 10000 });

    // Click the PDF item.
    const pdfItem = page.locator('.file-browser-item', {
      has: page.locator('.file-item-name', { hasText: 'sample.pdf' }),
    });
    await pdfItem.click();

    // PDF.js viewer renders into .fb-pdf-viewer with a .fb-pdf-canvas inside.
    // We give it 20s to download the worker + render page 1 (slow CI).
    await expect(page.locator('.fb-pdf-viewer')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.fb-pdf-canvas')).toBeAttached({ timeout: 20000 });

    // Toolbar buttons should be present.
    await expect(page.locator('.fb-pdf-btn[aria-label="Previous page"]')).toBeVisible();
    await expect(page.locator('.fb-pdf-btn[aria-label="Next page"]')).toBeVisible();
    await expect(page.locator('.fb-pdf-btn[aria-label="Fit to width"]')).toBeVisible();

    // Wait for PDF.js to ACTUALLY render page 1, not just attach the canvas.
    // Naive `canvas.width > 0` is a false-positive — `<canvas>` defaults to
    // 300x150 the moment it's attached, before any drawing happens. Use two
    // explicit "render finished" signals instead:
    //   (a) page-info text populated by `updateUi()` once `pdfDoc` is set
    //   (b) `.fb-pdf-status` hidden (display:none) once `renderPage(1)`'s
    //       render-task promise resolves
    // Either alone would be enough; together they make the failure mode
    // unambiguous if PDF.js is hung.
    await page.waitForFunction(() => {
      const info = document.querySelector('.fb-pdf-page-info');
      const status = document.querySelector('.fb-pdf-status');
      return info && info.textContent && info.textContent.trim().length > 0
        && status && status.style.display === 'none';
    }, { timeout: 20000 });

    // Page-info text should match "1 / 1" for our 1-page PDF.
    const pageInfo = await page.locator('.fb-pdf-page-info').textContent();
    expect(pageInfo).toMatch(/1\s*\/\s*1/);
  });

  // ──────────────────────────────────────────────────────────────────────
  // (i) Compare-with-HEAD — exercise GET /api/files/git-show via fetch.
  //     The diff client (#6) is engineer's surface; this test pins the
  //     SERVER contract that #6 will consume.
  // ──────────────────────────────────────────────────────────────────────
  test('(i) Compare-with-HEAD → git-show returns committed content (#8)', async ({ page }) => {
    test.skip(!gitAvailable, 'git not installed on the runner');
    await setupPage(page);

    const gitFilePath = path.join(repoDir, 'tracked.txt').replace(/\\/g, '/');

    // 1) Fetch the committed (HEAD) version.
    const headRes = await page.request.get(
      `${url}/api/files/git-show?path=${encodeURIComponent(gitFilePath)}&ref=HEAD`
    );
    expect(headRes.ok()).toBeTruthy();
    const headBody = await headRes.json();
    expect(headBody.ref).toBe('HEAD');
    expect(headBody.relPath).toBe('tracked.txt');
    expect(headBody.truncated).toBe(false);
    expect(headBody.content).toBe('committed-line-1\ncommitted-line-2\n');

    // 2) Fetch the working-tree version via /api/files/content for the
    //    full diff round-trip the client will use.
    const wtRes = await page.request.get(
      `${url}/api/files/content?path=${encodeURIComponent(gitFilePath)}`
    );
    expect(wtRes.ok()).toBeTruthy();
    const wtBody = await wtRes.json();
    expect(wtBody.content).toContain('working-tree-modification');

    // 3) Verify the two are different — that's what the diff editor would
    //    visualize.
    expect(headBody.content).not.toBe(wtBody.content);

    // 4) Sanity: invalid ref → 400 (validates the client surfaces a clean
    //    error path rather than mojibake).
    const bad = await page.request.get(
      `${url}/api/files/git-show?path=${encodeURIComponent(gitFilePath)}&ref=${encodeURIComponent('--upload-pack=evil')}`
    );
    expect(bad.status()).toBe(400);
  });

  // ──────────────────────────────────────────────────────────────────────
  // (j) Cmd+Shift+F search — consume the SSE stream, verify match shape.
  // ──────────────────────────────────────────────────────────────────────
  test('(j) cross-file search streams matches via SSE (#13)', async ({ page }) => {
    await setupPage(page);

    // Consume the SSE stream in-page (EventSource works inside the
    // browser context; same-origin to the served port).
    const events = await page.evaluate(async (root) => {
      return await new Promise((resolve) => {
        const out = [];
        const url = '/api/search?q=' + encodeURIComponent('NEEDLE-PRESENT')
          + '&path=' + encodeURIComponent(root);
        const es = new EventSource(url);
        const timeout = setTimeout(() => { es.close(); resolve(out); }, 10000);
        es.onmessage = (e) => {
          try {
            const evt = JSON.parse(e.data);
            out.push(evt);
            if (evt.type === 'end') {
              clearTimeout(timeout);
              es.close();
              resolve(out);
            }
          } catch (_) {}
        };
        es.onerror = () => {
          clearTimeout(timeout);
          es.close();
          resolve(out);
        };
      });
    }, fixtureDir.replace(/\\/g, '/'));

    const start = events.find((e) => e.type === 'start');
    const matches = events.filter((e) => e.type === 'match');
    const end = events.find((e) => e.type === 'end');

    expect(start, 'expected start event').toBeTruthy();
    expect(start.backend === 'rg' || start.backend === 'grep' || start.backend === null).toBe(true);
    expect(end, 'expected end event').toBeTruthy();

    // ≥2 matches (one per haystack file).
    expect(matches.length, `matches: ${JSON.stringify(matches)}`).toBeGreaterThanOrEqual(2);
    for (const m of matches) {
      expect(typeof m.path).toBe('string');
      expect(typeof m.line).toBe('number');
      expect(m.text).toMatch(/NEEDLE-PRESENT/);
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Bonus regression: rate-limit on /api/search trips at 11+ requests
  //  — proves the per-IP shared limiter actually fires through the
  //    real express stack the way it does in unit tests.
  // ──────────────────────────────────────────────────────────────────────
  test('rate-limit: /api/search returns 429 within 11 sequential requests', async ({ page }) => {
    await setupPage(page);

    const sub = path.join(fixtureDir, 'rl-search');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'r.txt'), 'aaa\n');

    // Reset the search bucket so prior tests don't taint our budget.
    await page.evaluate(async () => {
      // No client-side knob; we rely on the same IP being used in tests.
    });

    let lastStatus;
    for (let i = 0; i < 12; i++) {
      const r = await page.request.get(
        `${url}/api/search?q=aaa&path=${encodeURIComponent(sub.replace(/\\/g, '/'))}`
      );
      lastStatus = r.status();
      if (lastStatus === 429) break;
    }
    expect(lastStatus, 'expected 429 within 12 requests').toBe(429);

    fs.rmSync(sub, { recursive: true, force: true });
  });
});
