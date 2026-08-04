// journey-auth.spec.js — Phase 2 of the user-journey: auth-on rerun.
//
// Boots an isolated auth-mode server on an ephemeral port, navigates with
// `?token=foo`, and repeats steps 2–7. Confirms token doesn't leak into the
// URL bar, referrer, or console logs.

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const { createServer } = require('../../helpers/server-factory');

const TOKEN = 'foo';
let appUrlBase;
let appUrl;
const SHOTS_DIR = '/tmp/ai-or-die-journey-screenshots';
const FINDINGS_PATH = '/tmp/journey-findings-auth.md';

const findings = [];

function writeFindings() {
  const lines = ['# Journey findings (auth-on) — ' + new Date().toISOString(), ''];
  for (const f of findings) {
    lines.push('## [' + f.severity + '] ' + f.scenario);
    lines.push('');
    lines.push(f.observation);
    lines.push('');
  }
  try { fs.writeFileSync(FINDINGS_PATH, lines.join('\n')); } catch (_) {}
}

function recordFinding(severity, scenario, observation) {
  findings.push({ severity, scenario, observation, t: Date.now() });
  writeFindings();
}

async function shot(page, name) {
  if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, name + '.png');
  await page.screenshot({ path: file, fullPage: false });
}

test.describe.configure({ mode: 'serial' });

test.describe('User Journey (auth-on rerun)', () => {
  let server;
  let context;
  let page;
  let consoleSamples = [];
  let networkSamples = [];

  test.beforeAll(async ({ browser }) => {
    ({ server, url: appUrlBase } = await createServer({ auth: TOKEN }));
    appUrl = appUrlBase + '/?token=' + TOKEN;
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    page.on('console', (msg) => {
      const text = msg.text();
      consoleSamples.push({ type: msg.type(), text });
    });
    page.on('request', (req) => {
      networkSamples.push({ url: req.url(), method: req.method(), referer: req.headers()['referer'] });
    });
  });

  test.afterAll(async () => {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (server) await server.close();
    writeFindings();
  });

  test('Auth-on Step 2 — load with ?token=foo', async () => {
    await page.goto(appUrl);
    // Wait for either the auth modal OR the app to load.
    await page.waitForTimeout(2000);
    await shot(page, 'auth-02-loaded');

    // Check whether the URL token was honoured automatically.
    const authModalShown = await page.evaluate(() =>
      !!document.getElementById('auth-token'));

    if (authModalShown) {
      recordFinding('P1', 'Auth Step 2 — ?token=URL not honoured by client',
        'The authenticated launch URL includes `?token=foo`. ' +
        'But the client (src/public/auth.js) only reads from sessionStorage (`cc-web-token`) — ' +
        'no code reads `URLSearchParams.get("token")`. The auth modal shows even with the ' +
        '?token= param present, forcing the user to copy the token manually from the URL bar ' +
        'into the input field. Recommend: on first load, parse `?token=` and call ' +
        'AuthManager.verifyToken() automatically; then strip the param so it doesn\'t leak ' +
        '(addresses Step 12\'s URL-bar concern simultaneously).');
      // Type the token manually so the rest of the journey can proceed.
      await page.fill('#auth-token', TOKEN);
      await page.click('button:has-text("Authenticate")');
      await page.waitForTimeout(1500);
      await shot(page, 'auth-02-after-manual-token');
    }

    // Now the app should load.
    await page.waitForFunction(() => !!(window.app && window.app.terminal), { timeout: 30000 });
    await page.waitForFunction(
      () => window.app && window.app.socket && window.app.socket.readyState === 1,
      { timeout: 10000 }
    );
    if (!authModalShown) {
      recordFinding('PASS', 'Auth Step 2 — page loads with ?token=foo (auto-authenticated)',
        'WebSocket OPEN, app.terminal mounted');
    } else {
      recordFinding('NOTE', 'Auth Step 2 — recovered via manual token entry',
        'After typing "foo" in the auth modal, app loaded. Continuing journey.');
    }
  });

  test('Auth-on Step 3 — start Terminal session via UI', async () => {
    const overlay = page.locator('#overlay');
    if (await overlay.isVisible({ timeout: 2000 }).catch(() => false)) {
      const termCard = page.locator('[data-tool="terminal"]').first();
      await termCard.click();
      await page.waitForTimeout(800);
    }

    // Verify terminal-shell prompt shows up
    const ok = await page.evaluate(async () => {
      const start = Date.now();
      while (Date.now() - start < 8000) {
        const term = window.app && window.app.terminal;
        if (term) {
          const buf = term.buffer.active;
          for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i);
            if (line && line.translateToString(true).trim().length > 0) return true;
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    });
    if (!ok) {
      recordFinding('P1', 'Auth Step 3 — Terminal session did not start under auth',
        'Click on Terminal card produced no shell prompt within 8s.');
    } else {
      recordFinding('PASS', 'Auth Step 3 — Terminal session started under auth', '');
    }
    await shot(page, 'auth-03-terminal');
  });

  test('Auth-on Step 6 — Cmd-P works under auth', async () => {
    // Capture network for diagnostic if the request fails.
    const findRequests = [];
    page.on('response', async (res) => {
      if (res.url().includes('/api/files/find')) {
        try {
          const status = res.status();
          findRequests.push({ url: res.url(), status });
        } catch (_) {}
      }
    });

    await page.evaluate(() => window.app.toggleFindPanel());
    await page.waitForTimeout(300);
    await page.evaluate(async () => { await window.app._findPanel.runQuery('package'); });
    // Wait for results to actually land (debounce + fetch) rather than a
    // fixed timer. The find panel sets a busy flag during the request and
    // clears it on completion; await that instead of guessing latency.
    await page.waitForFunction(() => {
      const p = window.app && window.app._findPanel;
      if (!p) return false;
      // Either results populated, or the status flipped to non-busy.
      const haveResults = Array.isArray(p._lastResults) && p._lastResults.length > 0;
      const settled = p._statusEl && !p._statusEl.classList.contains('busy');
      return haveResults || settled;
    }, { timeout: 8000 });
    const matches = await page.evaluate(() => {
      const p = window.app._findPanel;
      return ((p && p._lastResults) || []).slice(0, 5).map((m) => m.path);
    });
    const token = await page.evaluate(() => window.authManager && window.authManager.getToken && window.authManager.getToken());
    const sid = await page.evaluate(() => window.app.currentClaudeSessionId);
    await shot(page, 'auth-06-cmdp-results');
    if (!matches.length) {
      recordFinding('P1', 'Auth Step 6 — Cmd-P returned 0 matches for "package" under auth',
        'token=' + JSON.stringify(token) + ', sid=' + JSON.stringify(sid) +
        ', findRequests=' + JSON.stringify(findRequests));
    } else {
      recordFinding('PASS', 'Auth Step 6 — Cmd-P works under auth',
        matches.length + ' matches for "package": ' + matches.slice(0, 3).join(', '));
    }
    await page.evaluate(() => window.app._findPanel.close());
  });

  test('Auth-on Step 11 — WS reconnect after unclean disconnect', async () => {
    // Terminating the server-side socket produces the same unclean-close signal
    // that drives restart recovery, while keeping the in-process ephemeral-port
    // server alive to accept the reconnect. Killing this test process would also
    // kill Playwright, and restarting createServer() would allocate a new port.
    const wsBefore = await page.evaluate(() => window.app.socket.readyState);
    for (const client of server.wss.clients) client.terminate();

    // Wait up to 30s for reconnect (covers worst-case backoff after
    // a few attempts).
    let reconnected = false;
    const start = Date.now();
    while (Date.now() - start < 30000) {
      const ready = await page.evaluate(() =>
        !!(window.app && window.app.socket && window.app.socket.readyState === 1));
      if (ready) { reconnected = true; break; }
      await page.waitForTimeout(500);
    }
    if (!reconnected) {
      recordFinding('P0', 'Auth Step 11 — WS did not reconnect within 30s after unclean disconnect',
        `wsBefore=${wsBefore}, no reconnect within 30s. ` +
        'The instant-reconnect feature (commit 444a038) is supposed to recover within a few seconds.');
    } else {
      recordFinding('PASS', 'Auth Step 11 — WS reconnect after unclean disconnect',
        'reconnected within ' + (Date.now() - start) + 'ms');
    }
    await shot(page, 'auth-11-reconnect');
  });

  test('Auth-on Step 12 — token does not leak in URL bar / console / referer', async () => {
    // URL bar: page.url() reflects the address bar.
    const urlNow = page.url();
    const urlHasToken = /[?&]token=/.test(urlNow);
    if (urlHasToken) {
      recordFinding('P1', 'Auth Step 12 — token visible in URL bar',
        'URL: ' + urlNow + '. Token leaks to anyone screen-sharing or screenshotting. ' +
        'Consider stripping the token from the URL after the initial app boot, or storing ' +
        'in sessionStorage and clearing the query param.');
    } else {
      recordFinding('PASS', 'Auth Step 12a — URL bar clean', urlNow);
    }

    // Console: any token mention? Distinguish OUR logs (which PE's
    // sanitizeAuthLog now scrubs) from BROWSER-NATIVE logs (Chromium
    // logs `WebSocket connection to 'ws://…?token=foo' failed: …` on
    // every failed reconnect attempt — the WS URL has to carry the
    // token for authentication, and Chromium's connection-failure log
    // is below the application's reach).
    const tokenInConsole = consoleSamples.filter((s) => s.text && s.text.includes(TOKEN));
    const wsNativeLeaks = tokenInConsole.filter(
      (s) => /WebSocket connection to/i.test(s.text) || /Failed to load resource/i.test(s.text)
    );
    const appLogLeaks = tokenInConsole.filter((s) => !wsNativeLeaks.includes(s));
    if (appLogLeaks.length) {
      recordFinding('P1', 'Auth Step 12b — token appears in APP console logs',
        'App-originated console messages containing "' + TOKEN + '": ' + appLogLeaks.length +
        '. Sample: ' + JSON.stringify(appLogLeaks.slice(0, 2)));
    } else if (wsNativeLeaks.length) {
      recordFinding('KNOWN-LIMITATION', 'Auth Step 12b — token in Chromium-native WS error log',
        wsNativeLeaks.length + ' Chromium WS-connection-failure messages contain the token. ' +
        'Browser logs the full WS URL on failed reconnect; the application can\'t intercept this. ' +
        'Mitigation requires a server-side switch to Bearer-token auth via WS upgrade headers ' +
        '(currently the WS uses `?token=` because browsers don\'t support custom headers on WS). ' +
        'PE\'s sanitizeAuthLog covers all application-emitted logs.');
    } else {
      recordFinding('PASS', 'Auth Step 12b — no token in console logs', '');
    }

    // Referer: any cross-origin link followed will leak ?token= via the Referer header.
    // Inspect captured network samples for cross-origin requests with token-bearing referer.
    const referrerLeaks = networkSamples.filter((s) => {
      try {
        const u = new URL(s.url);
        if (u.origin === appUrlBase) return false; // same-origin OK
        return s.referer && s.referer.includes('token=');
      } catch (_) { return false; }
    });
    if (referrerLeaks.length) {
      recordFinding('P0', 'Auth Step 12 — token leaks via Referer header',
        referrerLeaks.length + ' cross-origin requests carry a token-bearing Referer. Sample: ' +
        JSON.stringify(referrerLeaks.slice(0, 2)));
    } else {
      recordFinding('PASS', 'Auth Step 12c — no token leak via Referer header',
        'no cross-origin requests with token in referer (in this short journey)');
    }
  });
});
