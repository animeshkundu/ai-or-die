// journey-auth.spec.js — Phase 2 of the user-journey: auth-on rerun.
//
// Per task #9: restart server with `--auth foo`, navigate with
// `?token=foo`, repeat steps 2–7. Confirm WS reconnect after a server
// kill+restart. Confirm token doesn't leak into URL bar / referrer /
// console logs.
//
// PRE-REQ: dev server already running at http://127.0.0.1:11501 with
// --auth foo (a SEPARATE port from the no-auth server on 11500 so the
// two journeys don't trip on each other).

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const APP_URL_BASE = 'http://127.0.0.1:11501';
const TOKEN = 'foo';
const APP_URL = APP_URL_BASE + '/?token=' + TOKEN;
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
  let context;
  let page;
  let consoleSamples = [];
  let networkSamples = [];

  test.beforeAll(async ({ browser }) => {
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
    writeFindings();
  });

  test('Auth-on Step 2 — load with ?token=foo', async () => {
    await page.goto(APP_URL);
    // Wait for either the auth modal OR the app to load.
    await page.waitForTimeout(2000);
    await shot(page, 'auth-02-loaded');

    // Check whether the URL token was honoured automatically.
    const authModalShown = await page.evaluate(() =>
      !!document.getElementById('auth-token'));

    if (authModalShown) {
      recordFinding('P1', 'Auth Step 2 — ?token=URL not honoured by client',
        'CLI prints `http://localhost:11501?token=foo` and tells the user to use that URL. ' +
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
    await page.evaluate(() => window.app.toggleFindPanel());
    await page.waitForTimeout(300);
    await page.evaluate(async () => { await window.app._findPanel.runQuery('package'); });
    await page.waitForTimeout(500);
    const matches = await page.evaluate(() => {
      const p = window.app._findPanel;
      return ((p && p._lastResults) || []).slice(0, 5).map((m) => m.path);
    });
    await shot(page, 'auth-06-cmdp-results');
    if (!matches.length) {
      recordFinding('P1', 'Auth Step 6 — Cmd-P returned 0 matches for "package" under auth',
        'Likely auth header missing on /api/files/find. Check 401/403.');
    } else {
      recordFinding('PASS', 'Auth Step 6 — Cmd-P works under auth',
        matches.length + ' matches for "package": ' + matches.slice(0, 3).join(', '));
    }
    await page.evaluate(() => window.app._findPanel.close());
  });

  test('Auth-on Step 11 — WS reconnect after server kill+restart (real)', async () => {
    // The previous attempt called socket.close(4001) which is a CLEAN
    // close — and app.js correctly skips reconnect on clean closes
    // (see app.js onclose handler ~line 1879: only reconnects when
    // !event.wasClean). To exercise the real reconnect path we need
    // an UNCLEAN close, which requires actually killing the server
    // process. We spawn a child to do it via shell so the test can
    // continue independently.
    const { execSync } = require('child_process');
    const wsBefore = await page.evaluate(() => window.app.socket.readyState);

    // Find and kill the auth server PID, wait briefly, then restart.
    let killed = false;
    let restarted = false;
    try {
      const pids = execSync(
        'pgrep -f "ai-or-die.js --port 11501"', { encoding: 'utf8' }
      ).trim().split('\n').filter(Boolean);
      execSync('pkill -f "ai-or-die.js --port 11501"');
      killed = true;
    } catch (e) {
      recordFinding('NOTE', 'Auth Step 11 — could not pkill server',
        'pkill returned: ' + (e && e.message));
    }

    if (killed) {
      await page.waitForTimeout(2500);
      // Restart the server in the background. We use spawn so this
      // function returns immediately; the actual readiness is detected
      // by the client's reconnect.
      const { spawn } = require('child_process');
      const child = spawn('node',
        [path.resolve(__dirname, '../../../bin/ai-or-die.js'),
         '--port', '11501', '--no-open', '--auth', 'foo', '--dev'],
        { detached: true, stdio: 'ignore' });
      child.unref();
      restarted = true;
    }

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
      recordFinding('P0', 'Auth Step 11 — WS did not reconnect within 30s after real kill+restart',
        `wsBefore=${wsBefore}, killed=${killed}, restarted=${restarted}, no reconnect within 30s. ` +
        'The instant-reconnect feature (commit 444a038) is supposed to recover from server ' +
        'restarts within a few seconds.');
    } else {
      recordFinding('PASS', 'Auth Step 11 — WS reconnect after real kill+restart',
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

    // Console: any token mention?
    const tokenInConsole = consoleSamples.filter((s) => s.text && s.text.includes(TOKEN));
    if (tokenInConsole.length) {
      recordFinding('P1', 'Auth Step 12 — token appears in console logs',
        'Console messages containing "' + TOKEN + '": ' + tokenInConsole.length +
        '. Sample: ' + JSON.stringify(tokenInConsole.slice(0, 2)));
    } else {
      recordFinding('PASS', 'Auth Step 12b — no token in console logs', '');
    }

    // Referer: any cross-origin link followed will leak ?token= via the Referer header.
    // Inspect captured network samples for cross-origin requests with token-bearing referer.
    const referrerLeaks = networkSamples.filter((s) => {
      try {
        const u = new URL(s.url);
        if (u.origin === APP_URL_BASE) return false; // same-origin OK
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
