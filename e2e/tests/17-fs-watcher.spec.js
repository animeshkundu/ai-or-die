// 17-fs-watcher.spec.js — e2e scenarios for the fs-watcher push channel
// (ADR-0017, issue #100, slice-2 of architect's plate per team-lead).
//
// These tests exercise the SERVER + CLIENT integration end-to-end:
// scenarios (a)-(d) drive external file writes / adds / unlinks via the
// test harness's `fs.writeFile` / `fs.unlink` directly to the fixture dir
// (which is also the served session's workingDir) so chokidar fires
// legitimately without test mocking. The server's SSE channel + the
// client's TabManager + FileBrowserPanel subscribers should react.
//
// Scenarios (e) and (f) drive the rate-limit + auth surfaces directly via
// page.evaluate + EventSource — no UI clicks needed.
//
// At commit time, this spec is written speculatively against the ADR-0017
// contract (`/api/files/watch?session=<id>` SSE + subscribe/unsubscribe
// POST control, single EventSource per session, event payload shape, etc.).
// It will fail until systems-engineer's server-side endpoint AND engineer's
// client-side TabManager subscriber both land and pass local verification.
// At that point the test is the final integration gate.
//
// Conventions match 15-/16- specs: createServer() picks port 0 →
// kernel-assigned high port (always >11000); never touches port 7777.

const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  attachFailureArtifacts,
} = require('../helpers/terminal-helpers');
const fs = require('fs');
const path = require('path');
const os = require('os');

test.describe('File browser — fs-watcher reactive sync (#100, ADR-0017)', () => {
  let server, port, url;

  // Auth-mode server for scenario (f). Held separately because the existing
  // server-factory hardcodes noAuth:true; we construct a second server
  // inline here with auth:<token> set so the watch endpoint requires a
  // ?token= query param. Same port-0 convention.
  let authServer, authPort, authUrl;
  const AUTH_TOKEN = 'fs-watcher-test-token-' + Date.now();

  // Fixture dir IS the served session's workingDir for the standard server.
  // We write into it from the test harness to trigger chokidar.
  const fixtureDir = path.join(__dirname, '..', 'fixtures', 'fs-watcher-test');
  const cleanFile = path.join(fixtureDir, 'clean-tab.txt');
  const dirtyFile = path.join(fixtureDir, 'dirty-tab.txt');

  test.beforeAll(async () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(cleanFile, 'initial clean content\n');
    fs.writeFileSync(dirtyFile, 'initial dirty content\n');

    const standard = await createServer();
    server = standard.server;
    port = standard.port;
    url = standard.url;

    // Auth-mode server for scenario (f). Construct inline so we don't have
    // to extend the shared server-factory for one test.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-watcher-auth-'));
    const { ClaudeCodeWebServer } = require('../../src/server');
    authServer = new ClaudeCodeWebServer({
      port: 0,
      auth: AUTH_TOKEN,           // require this token
      noAuth: false,
      sessionStoreOptions: { storageDir: tempDir },
    });
    const authHttp = await authServer.start();
    authPort = authHttp.address().port;
    authUrl = `http://127.0.0.1:${authPort}`;
    authServer._testTempDir = tempDir;
  });

  test.afterAll(async () => {
    if (server) await server.close();
    if (authServer) await authServer.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  async function setupPage(page, targetUrl) {
    await createSessionViaApi(port, 'fs-watcher e2e');
    await page.goto(targetUrl || url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await page.waitForFunction(() => {
      const overlay = document.getElementById('overlay');
      return !overlay || overlay.style.display === 'none' || overlay.offsetParent === null;
    }, { timeout: 30000 });
  }

  async function openPanelToFixtures(page) {
    await page.evaluate((dir) => {
      window.app._ensureFileBrowser();
      window.app._fileBrowserPanel.open(dir);
    }, fixtureDir.replace(/\\/g, '/'));
    await page.waitForSelector('.file-browser-panel.open', { timeout: 10000 });
    await page.waitForFunction(
      () => document.querySelectorAll('.file-browser-item').length > 0,
      { timeout: 10000 }
    );
  }

  async function clickFile(page, filename) {
    const item = page.locator('.file-browser-item', {
      has: page.locator('.file-item-name', { hasText: filename }),
    });
    await item.click();
  }

  // ────────────────────────────────────────────────────────────────────────
  // (a) Auto-reload-clean: external write to a clean editor tab triggers
  //     a silent re-fetch + Monaco model swap; cursor + scroll preserved.
  // ────────────────────────────────────────────────────────────────────────
  test('(a) external write to clean tab → silent reload preserves cursor', async ({ page }) => {
    await setupPage(page);
    await openPanelToFixtures(page);
    await clickFile(page, 'clean-tab.txt');

    // Wait for the editor / preview Monaco surface (or the immediate-pre
    // fallback per 7bfd634) to mount with the initial content.
    await page.waitForFunction(() => {
      const host = document.querySelector('.fb-code-content');
      return host && (host.textContent || '').includes('initial clean content');
    }, { timeout: 15000 });

    // Set Monaco cursor to a known position so we can prove preservation.
    // Monaco model line 1 col 1 is the only line for this tiny fixture;
    // we'll grow the file content first to give the cursor somewhere
    // interesting to be.
    fs.writeFileSync(cleanFile, [
      'line one initial',
      'line two initial',
      'line three initial',
      '',
    ].join('\n'));
    // Wait for the reactive re-sync of the multi-line content.
    await page.waitForFunction(() => {
      const host = document.querySelector('.fb-code-content');
      return host && (host.textContent || '').includes('line three initial');
    }, { timeout: 5000 });

    // Move cursor to line 2 col 5.
    await page.evaluate(() => {
      const tm = window.app._fileBrowserPanel && window.app._fileBrowserPanel._tabManager;
      const tab = tm && tm.getActiveTab && tm.getActiveTab();
      const ed = tab && tab.panel && tab.panel._monacoEditor;
      if (!ed) throw new Error('Monaco editor not mounted');
      ed.setPosition({ lineNumber: 2, column: 5 });
    });

    // Trigger external write — this is the "agent edits the file" simulation.
    fs.writeFileSync(cleanFile, [
      'line one CHANGED by agent',
      'line two CHANGED by agent',
      'line three CHANGED by agent',
      '',
    ].join('\n'));

    // Watcher latency budget per ADR-0017: chokidar awaitWriteFinish 80ms
    // + per-path debounce 100ms + SSE delivery + client re-fetch round-trip.
    // Allow up to 2s for the silent reload.
    await page.waitForFunction(() => {
      const host = document.querySelector('.fb-code-content');
      return host && (host.textContent || '').includes('CHANGED by agent');
    }, { timeout: 5000 });

    // Cursor should still be at line 2 col 5 (or as close as bounds-checking
    // allows — line 2 still exists with ≥5 columns in the new content).
    const finalPos = await page.evaluate(() => {
      const tm = window.app._fileBrowserPanel && window.app._fileBrowserPanel._tabManager;
      const tab = tm && tm.getActiveTab && tm.getActiveTab();
      const ed = tab && tab.panel && tab.panel._monacoEditor;
      const pos = ed && ed.getPosition();
      return pos ? { line: pos.lineNumber, col: pos.column } : null;
    });
    expect(finalPos).not.toBeNull();
    expect(finalPos.line).toBe(2);
    expect(finalPos.col).toBe(5);
  });

  // ────────────────────────────────────────────────────────────────────────
  // (b) Toast-on-dirty: external write to a dirty tab surfaces a non-blocking
  //     toast on the tab strip with 3 buttons; clicking Reload(discard)
  //     swaps to disk content + clears dirty.
  // ────────────────────────────────────────────────────────────────────────
  test('(b) external write to dirty tab → toast with 3 buttons', async ({ page }) => {
    await setupPage(page);
    await openPanelToFixtures(page);
    await clickFile(page, 'dirty-tab.txt');

    await page.waitForFunction(() => {
      const host = document.querySelector('.fb-code-content');
      return host && (host.textContent || '').includes('initial dirty content');
    }, { timeout: 15000 });

    // Make the tab dirty by typing into Monaco.
    await page.evaluate(() => {
      const tm = window.app._fileBrowserPanel && window.app._fileBrowserPanel._tabManager;
      const tab = tm && tm.getActiveTab && tm.getActiveTab();
      const ed = tab && tab.panel && tab.panel._monacoEditor;
      if (!ed) throw new Error('Monaco editor not mounted');
      ed.setValue(ed.getValue() + '\n// dirty edit by user\n');
    });

    // Wait for the dirty dot to appear (engineer's TabManager fires this).
    await expect(
      page.locator('.fb-tab .fb-tab-dirty-dot').first()
    ).toBeVisible({ timeout: 5000 });

    // Trigger external write — agent collision.
    fs.writeFileSync(dirtyFile, 'agent rewrote dirty-tab.txt\n');

    // Toast appears on the tab strip per ADR-0017 client-side reaction.
    // CSS class .fb-tab-toast (per the spec's CSS section).
    await expect(
      page.locator('.fb-tab-toast').first()
    ).toBeVisible({ timeout: 5000 });

    // Toast has 3 buttons: Reload (discard) / Compare / Keep mine.
    // Match by visible text rather than CSS class so engineer's exact
    // button-class names don't bind us.
    const reloadBtn = page.getByRole('button', { name: /Reload.*discard|Reload \(discard\)/i }).first();
    const compareBtn = page.getByRole('button', { name: /^Compare$/i }).first();
    const keepBtn = page.getByRole('button', { name: /Keep mine|Keep $|^Keep/i }).first();
    await expect(reloadBtn).toBeVisible({ timeout: 5000 });
    await expect(compareBtn).toBeVisible();
    await expect(keepBtn).toBeVisible();

    // Click Reload(discard) — discards the user's edit, swaps in agent content.
    await reloadBtn.click();

    // Editor now shows the agent's content; dirty dot cleared.
    await page.waitForFunction(() => {
      const host = document.querySelector('.fb-code-content');
      return host && (host.textContent || '').includes('agent rewrote dirty-tab.txt');
    }, { timeout: 5000 });
    await expect(
      page.locator('.fb-tab .fb-tab-dirty-dot').first()
    ).toBeHidden({ timeout: 5000 });
  });

  // ────────────────────────────────────────────────────────────────────────
  // (c) File-list reactive add: external `fs.writeFile` of a new file in the
  //     panel's current dir → list refreshes with the new entry.
  // ────────────────────────────────────────────────────────────────────────
  test('(c) external add → file list refreshes with new file', async ({ page }) => {
    await setupPage(page);
    await openPanelToFixtures(page);

    // Confirm baseline: only the seed files visible.
    const newFile = path.join(fixtureDir, 'agent-created.md');
    // Defensive cleanup in case a prior run left it.
    try { fs.unlinkSync(newFile); } catch (_) { /* ignore */ }

    await expect(
      page.locator('.file-item-name', { hasText: 'agent-created.md' })
    ).toHaveCount(0, { timeout: 1000 });

    // External add — agent creates a new file in the watched dir.
    fs.writeFileSync(newFile, '# Created by agent\n');

    // List refresh within ADR-0017 latency budget.
    await expect(
      page.locator('.file-item-name', { hasText: 'agent-created.md' })
    ).toBeVisible({ timeout: 5000 });

    // Cleanup so other tests aren't affected.
    fs.unlinkSync(newFile);
  });

  // ────────────────────────────────────────────────────────────────────────
  // (d) File-list reactive unlink: external delete → list removes the entry.
  // ────────────────────────────────────────────────────────────────────────
  test('(d) external unlink → file list removes the deleted file', async ({ page }) => {
    await setupPage(page);

    // Create a file specifically for this test so we don't impact other
    // scenarios' fixtures.
    const transientFile = path.join(fixtureDir, 'transient-' + Date.now() + '.txt');
    fs.writeFileSync(transientFile, 'will be deleted externally\n');

    await openPanelToFixtures(page);

    const transientName = path.basename(transientFile);
    await expect(
      page.locator('.file-item-name', { hasText: transientName })
    ).toBeVisible({ timeout: 5000 });

    // External delete.
    fs.unlinkSync(transientFile);

    // Listing reflects the unlink.
    await expect(
      page.locator('.file-item-name', { hasText: transientName })
    ).toHaveCount(0, { timeout: 5000 });
  });

  // ────────────────────────────────────────────────────────────────────────
  // (e) Concurrent-watcher cap: 5 open EventSources per IP allowed; the 6th
  //     returns 429 per ADR-0017.
  // ────────────────────────────────────────────────────────────────────────
  test('(e) rate-limit: 6th concurrent watcher → 429', async ({ page }) => {
    await setupPage(page);

    // Open 5 watchers from the page context (same IP), then attempt a 6th.
    // Use page.request for the 6th so we can synchronously observe the
    // status code without EventSource's async lifecycle.
    const result = await page.evaluate(async () => {
      const opened = [];
      // Open 5 EventSources to distinct session ids.
      for (let i = 0; i < 5; i++) {
        const sid = 'watcher-cap-test-' + i + '-' + Date.now();
        const es = new EventSource('/api/files/watch?session=' + encodeURIComponent(sid));
        opened.push(es);
      }
      // Wait briefly for them to actually establish.
      await new Promise((r) => setTimeout(r, 500));
      // The 6th attempt should be rejected with 429.
      const res = await fetch('/api/files/watch?session=watcher-cap-test-OVERFLOW', {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      });
      const status = res.status;
      // Cleanup so we don't leak watchers between tests.
      opened.forEach((es) => { try { es.close(); } catch (_) {} });
      return { status, openedCount: opened.length };
    });

    expect(result.openedCount).toBe(5);
    expect(result.status, '6th concurrent /api/files/watch must return 429').toBe(429);
  });

  // ────────────────────────────────────────────────────────────────────────
  // (f) Auth: in --auth mode, GET /api/files/watch without a ?token= query
  //     param returns 401. Uses the auth-mode server constructed in
  //     beforeAll.
  // ────────────────────────────────────────────────────────────────────────
  test('(f) auth mode: subscribe with no token → 401', async ({ page }) => {
    // Hit the auth server directly via the request fixture (no page setup
    // needed — this is a pure auth-middleware check).
    const res = await page.request.get(
      `${authUrl}/api/files/watch?session=auth-test-no-token`,
      { headers: { Accept: 'text/event-stream' } }
    );
    expect(res.status(), 'no-token request must be rejected with 401').toBe(401);

    // Sanity: the same request WITH the token should NOT 401 (it may 200
    // with the SSE stream, or could return a different status if the
    // endpoint isn't fully wired yet, but it must NOT be 401).
    const okRes = await page.request.get(
      `${authUrl}/api/files/watch?session=auth-test-with-token&token=${encodeURIComponent(AUTH_TOKEN)}`,
      { headers: { Accept: 'text/event-stream' } }
    );
    expect(okRes.status(), 'with-token request must NOT be 401').not.toBe(401);
  });
});
