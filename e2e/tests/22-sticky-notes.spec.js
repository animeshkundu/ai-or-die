// @ts-check
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
  waitForWsMessage,
} = require('../helpers/terminal-helpers');

// ---------------------------------------------------------------------------
// Sticky-note (per-tab local-LLM session summary) E2E.
//
// These tests exercise the REAL client UI (sticky-note-card.js rendering, the
// toolbar toggle, the expand-gating WebSocket protocol, auto tab-titles) WITHOUT
// the 1.49GB LFM2 model: the server runs with both native engines OFF
// (createServer({ stt:false, stickyNotes:false }) — no downloads, fast) and we
// drive the feature deterministically by injecting the server->client messages
// the engine would emit (`sticky_notes_status`, `sticky_note_update`) and
// asserting the rendered DOM + the client->server messages it sends back. The
// SERVER-side emission path (summariser -> engine.infer -> broadcast) is covered
// by the mocha unit/wiring tests (test/sticky-note-*.test.js).
//
// The card DOM (#stickyNoteCard) and toggle (#stickyNoteBtn) are constructed
// unconditionally on the client, so message-driven rendering works regardless of
// the server's engine state.
// ---------------------------------------------------------------------------

/** Inject a server->client WebSocket message into the live app (no real frame). */
async function pushServerMessage(page, msg) {
  await page.evaluate((m) => {
    if (!window.app || !window.app.socket) throw new Error('app/socket not ready');
    window.app.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m) }));
  }, msg);
}

/** Make the toolbar toggle eligible to show (feature enabled + engine 'ready'). */
async function makeStickyReady(page) {
  await page.evaluate(() => {
    window.app.stickyNotesEnabled = true;
    window.app._stickyNotesAvailable = true;
    if (typeof window.app._refreshStickyNoteBtnVisibility === 'function') {
      window.app._refreshStickyNoteBtnVisibility();
    }
  });
}

async function activeSessionId(page) {
  return page.evaluate(() => window.app.currentClaudeSessionId);
}

const SAMPLE_NOTE = {
  title: 'Caching the models',
  goal: 'Cache STT + sticky models so CI stops timing out',
  done: ['Wrote download script', 'Added composite cache action'],
  remaining: ['Wire into ci.yml', 'Add e2e coverage'],
  updates: [
    { text: 'Composite action restores ~/.ai-or-die/models', at: new Date().toISOString() },
    { text: 'Generalised the download script', at: new Date(Date.now() - 90000).toISOString() },
  ],
  updatedAt: new Date().toISOString(),
  rev: 1,
};

test.describe('Sticky Notes', () => {
  /** @type {{ server: any, port: number, url: string }} */
  let serverInfo;

  test.beforeAll(async () => {
    // Both native engines OFF: no STT (640MB) or sticky (1.49GB) download.
    serverInfo = await createServer({ stt: false, stickyNotes: false });
  });

  test.afterAll(async () => {
    if (serverInfo && serverInfo.server) serverInfo.server.close();
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  test('toolbar toggle is hidden until the feature is enabled AND ready', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(serverInfo.url);
    await waitForAppReady(page);

    const btn = page.locator('#stickyNoteBtn');
    await expect(btn).toBeHidden();

    // Let the server's initial (engine-off -> 'unavailable') status settle so our
    // forced-ready state below is the last word, then assert the toggle appears.
    await waitForWsMessage(page, 'recv', 'sticky_notes_status', 3000);
    await page.waitForTimeout(300);
    await makeStickyReady(page);
    await expect(btn).toBeVisible();
  });

  test('clicking the toggle shows/hides the card and reports expand state to the server', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(serverInfo.port, 'Sticky toggle');
    await page.goto(serverInfo.url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await makeStickyReady(page);

    const btn = page.locator('#stickyNoteBtn');
    const card = page.locator('#stickyNoteCard');
    await expect(btn).toBeVisible();
    await expect(card).toBeHidden();

    // Expand -> card visible + set_sticky_active(true) sent to the server.
    // Clear first: the card emits an initial set_sticky_active(false) on bind.
    page._wsMessages.length = 0;
    await btn.click();
    await expect(card).toBeVisible();
    const activeMsg = await waitForWsMessage(page, 'sent', 'set_sticky_active');
    expect(activeMsg).toBeTruthy();
    expect(activeMsg.active).toBe(true);

    // Collapse -> card hidden + set_sticky_active(false) sent.
    page._wsMessages.length = 0;
    await btn.click();
    await expect(card).toBeHidden();
    const inactiveMsg = await waitForWsMessage(page, 'sent', 'set_sticky_active');
    expect(inactiveMsg).toBeTruthy();
    expect(inactiveMsg.active).toBe(false);
  });

  test('renders the note: goal, done, remaining, updates', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(serverInfo.port, 'Sticky render');
    await page.goto(serverInfo.url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await makeStickyReady(page);

    const sid = await activeSessionId(page);
    await pushServerMessage(page, { type: 'sticky_note_update', sessionId: sid, stickyNote: SAMPLE_NOTE, autoTitle: null });

    await page.locator('#stickyNoteBtn').click();
    const card = page.locator('#stickyNoteCard');
    await expect(card).toBeVisible();

    await expect(card.locator('.sn-goal .sn-goal-text')).toContainText('Cache STT + sticky models');

    const done = card.locator('.sn-done .sn-list li');
    await expect(done).toHaveCount(2);
    await expect(done.nth(0)).toContainText('Wrote download script');

    const remaining = card.locator('.sn-remaining .sn-list li');
    await expect(remaining).toHaveCount(2);
    await expect(remaining.nth(1)).toContainText('Add e2e coverage');

    const updates = card.locator('.sn-updates .sn-list li');
    await expect(updates).toHaveCount(2);
    await expect(updates.nth(0)).toContainText('Composite action restores');
  });

  test('auto-title updates the tab name when the user has not renamed it', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(serverInfo.port, 'Original name');
    await page.goto(serverInfo.url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const sid = await activeSessionId(page);
    await pushServerMessage(page, {
      type: 'sticky_note_update',
      sessionId: sid,
      stickyNote: { ...SAMPLE_NOTE, rev: 2 },
      autoTitle: 'Refactor the auth flow',
    });

    const tabName = page.locator(`.session-tab[data-session-id="${sid}"] .tab-name`);
    await expect(tabName).toContainText('Refactor the auth flow', { timeout: 5000 });
  });

  test('drops stale (out-of-order) updates by rev', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(serverInfo.port, 'Sticky rev');
    await page.goto(serverInfo.url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await makeStickyReady(page);
    const sid = await activeSessionId(page);

    // rev 3 first, then a stale rev 2 with a different goal — the stale one must be ignored.
    await pushServerMessage(page, { type: 'sticky_note_update', sessionId: sid, stickyNote: { ...SAMPLE_NOTE, goal: 'NEWEST goal', rev: 3 } });
    await pushServerMessage(page, { type: 'sticky_note_update', sessionId: sid, stickyNote: { ...SAMPLE_NOTE, goal: 'STALE goal', rev: 2 } });

    await page.locator('#stickyNoteBtn').click();
    const card = page.locator('#stickyNoteCard');
    await expect(card).toBeVisible();
    await expect(card.locator('.sn-goal .sn-goal-text')).toContainText('NEWEST goal');
    await expect(card.locator('.sn-goal .sn-goal-text')).not.toContainText('STALE goal');
  });

  test('renders untrusted model text as text, not HTML (no injection)', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(serverInfo.port, 'Sticky xss');
    await page.goto(serverInfo.url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await makeStickyReady(page);
    const sid = await activeSessionId(page);

    await pushServerMessage(page, {
      type: 'sticky_note_update',
      sessionId: sid,
      stickyNote: { ...SAMPLE_NOTE, goal: '<img src=x onerror=window.__xss=1> plain', rev: 4 },
    });

    await page.locator('#stickyNoteBtn').click();
    const goal = page.locator('#stickyNoteCard .sn-goal .sn-goal-text');
    await expect(goal).toContainText('<img src=x onerror=window.__xss=1> plain');
    // No element was created from the payload, and the onerror never fired.
    await expect(page.locator('#stickyNoteCard .sn-goal-text img')).toHaveCount(0);
    const xss = await page.evaluate(() => window.__xss);
    expect(xss).toBeUndefined();
  });

  test('disabling sticky-notes for the session hides the card', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(serverInfo.port, 'Sticky disable');
    await page.goto(serverInfo.url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await makeStickyReady(page);
    const sid = await activeSessionId(page);

    await pushServerMessage(page, { type: 'sticky_note_update', sessionId: sid, stickyNote: SAMPLE_NOTE });
    await page.locator('#stickyNoteBtn').click();
    await expect(page.locator('#stickyNoteCard')).toBeVisible();

    // Turn the feature off for this session -> card hides.
    await page.evaluate(() => window.app._applyStickyNotesSetting(false));
    await expect(page.locator('#stickyNoteCard')).toBeHidden();
  });
});
