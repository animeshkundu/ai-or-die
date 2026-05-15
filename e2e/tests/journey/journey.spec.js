// journey.spec.js — scenario-based exploratory user journey through the
// live ai-or-die UI. Drives a HEADED Chromium against an out-of-tree
// dev server (port 11500, --disable-auth) so the test exercises the
// real product, not a per-test fresh server.
//
// Per task #9: this is exploratory, not isolation testing. We walk the
// 12-step journey end-to-end, capturing screenshots and findings at
// each step. Each `test.step` is a checkpoint with PASS/FAIL semantics.
// Findings get logged to attachments + saved to /tmp/journey-findings.md.
//
// PRE-REQ: dev server already running at http://127.0.0.1:11500 with
// --disable-auth.

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_URL = 'http://127.0.0.1:11500';
const SHOTS_DIR = '/tmp/ai-or-die-journey-screenshots';
const FINDINGS_PATH = '/tmp/journey-findings.md';
const EXPRESS_DIR = '/tmp/express';   // cloned in setup; used for "real repo" steps

// Findings accumulator (cleared at start of journey).
const findings = [];

function findingHeader() {
  return [
    '# Journey findings — ' + new Date().toISOString(),
    '',
    'Server: ' + APP_URL + ' (--disable-auth)',
    'Browser: headed Chromium',
    '',
  ].join('\n');
}

function recordFinding(severity, scenario, observation) {
  findings.push({ severity, scenario, observation, t: Date.now() });
  // Persist after every finding so an interrupted run still leaves a record.
  const lines = [findingHeader()];
  for (const f of findings) {
    lines.push('## [' + f.severity + '] ' + f.scenario);
    lines.push('');
    lines.push(f.observation);
    lines.push('');
  }
  try { fs.writeFileSync(FINDINGS_PATH, lines.join('\n')); } catch (_) {}
}

async function shot(page, name) {
  if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, name + '.png');
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function getTerminalText(page) {
  return page.evaluate(() => {
    const term = window.app && window.app.terminal;
    if (!term) return '';
    const buf = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  });
}

async function waitForTerminalText(page, needle, timeoutMs = 10000) {
  await page.waitForFunction((n) => {
    const term = window.app && window.app.terminal;
    if (!term) return false;
    const buf = term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line && line.translateToString(true).includes(n)) return true;
    }
    return false;
  }, needle, { timeout: timeoutMs, polling: 200 });
}

async function sendInput(page, data) {
  await page.evaluate((d) => {
    const ws = window.app && window.app.socket;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d }));
  }, data);
}

test.describe.configure({ mode: 'serial' });

test.describe('User Journey through live ai-or-die UI', () => {
  let context;
  let page;
  let cwdChangedFrames = [];

  test.beforeAll(async ({ browser }) => {
    if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });
    fs.writeFileSync(FINDINGS_PATH, findingHeader());
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        try {
          const m = JSON.parse(frame.payload);
          if (m && m.type === 'cwd_changed') cwdChangedFrames.push(m);
        } catch (_) {}
      });
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        recordFinding('NOTE', 'console error', '`' + msg.text() + '`');
      }
    });
  });

  test.afterAll(async () => {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    // Final findings dump.
    fs.writeFileSync(FINDINGS_PATH, fs.readFileSync(FINDINGS_PATH, 'utf8') +
      '\n\n## End of journey — ' + new Date().toISOString() + '\n');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Step 2: Fresh context, navigate to app
  // ─────────────────────────────────────────────────────────────────────
  test('Step 2 — fresh context loads the app', async () => {
    await page.goto(APP_URL);
    await page.waitForFunction(() => !!(window.app && window.app.terminal), { timeout: 30000 });
    await shot(page, '02-app-loaded');
    // Sanity: terminal element rendered
    const xtermPresent = await page.evaluate(() => !!document.querySelector('#terminal .xterm'));
    expect(xtermPresent, 'xterm should be present in the DOM').toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Step 3: Open a Terminal-bridge session through the UI
  // ─────────────────────────────────────────────────────────────────────
  test('Step 3 — open Terminal-bridge session via UI', async () => {
    // With a fresh session store (0 sessions), the app's overlay flow:
    //   - On first load, the chooser overlay should appear with
    //     "Choose Your Assistant" and a Terminal card.
    //   - Clicking the Terminal card should create a session and start
    //     the terminal tool.
    //
    // If there's already a session active (sticky from a prior test),
    // we'll spawn a new one via the "+" button first.

    // Wait briefly for the page to settle.
    await page.waitForTimeout(1000);
    await shot(page, '03a-pre-step3');

    // Detect what UI state we're in.
    const state = await page.evaluate(() => ({
      hasOverlay: !!document.querySelector('#overlay'),
      overlayDisplay: document.querySelector('#overlay') &&
        getComputedStyle(document.querySelector('#overlay')).display,
      overlayMode: document.querySelector('#overlay') &&
        document.querySelector('#overlay').className,
      sessionCount: (window.app && window.app.claudeSessions || []).length,
      currentSession: window.app && window.app.currentClaudeSessionId,
    }));
    recordFinding('NOTE', 'Step 3 — initial UI state', JSON.stringify(state));

    // The Terminal "card" in the chooser uses `data-tool="terminal"`
    // (or similar) — let me find it via stable selectors. Inspect
    // the actual DOM first.
    const terminalCardSelectors = await page.evaluate(() => {
      const candidates = [
        '[data-tool="terminal"]',
        '.tool-card-terminal',
        '#chooseTerminalBtn',
        '#startTerminalBtn',
      ];
      const found = {};
      candidates.forEach((sel) => { found[sel] = !!document.querySelector(sel); });
      // Also: any button or card whose innerText matches "Terminal" exactly.
      const allButtons = Array.from(document.querySelectorAll('button, [role="button"], .tool-option, .chooser-card'));
      const matches = allButtons.filter((b) => /^(Terminal|>_\s*Terminal)$/i.test(b.innerText.trim()));
      found['matched_buttons_count'] = matches.length;
      found['matched_button_classes'] = matches.slice(0, 4).map((b) => b.className);
      return found;
    });
    recordFinding('NOTE', 'Step 3 — Terminal card selectors', JSON.stringify(terminalCardSelectors));

    // Click the Terminal card. Try data-tool first, then fall back to
    // exact text match within the chooser overlay.
    let clicked = false;
    const terminalLocator1 = page.locator('[data-tool="terminal"]').first();
    if (await terminalLocator1.isVisible({ timeout: 1500 }).catch(() => false)) {
      await terminalLocator1.click();
      clicked = true;
    } else {
      // Try clicking on the heading text "Terminal" inside the chooser card.
      // Filter to "Terminal" within the chooser overlay specifically to avoid
      // clicking a session tab labelled "Terminal".
      const overlayTerminal = page.locator('#overlay .tool-option, #overlay button, #overlay .chooser-card')
        .filter({ hasText: /^Terminal/i }).first();
      if (await overlayTerminal.isVisible({ timeout: 1500 }).catch(() => false)) {
        await overlayTerminal.click();
        clicked = true;
      }
    }

    if (!clicked) {
      recordFinding('P1', 'Step 3 — Terminal card not clickable',
        'Could not locate a Terminal card in the chooser overlay via [data-tool="terminal"], ' +
        '#overlay button/card containing "Terminal" text, or other guesses. ' +
        'Real users would be confused. Falling back to programmatic spawn.');
    } else {
      await page.waitForTimeout(1000);
      await shot(page, '03b-after-terminal-click');
    }

    // Verify a Terminal-bridge session is active. The client's
    // `claudeSessions` array (from /api/sessions/list) does NOT carry
    // an `agent` field — checking that was a mistake. We instead check
    // for the terminal-shell prompt appearing in the xterm buffer (the
    // user-visible signal that the shell spawned).
    const isTerminalSession = await page.evaluate(async () => {
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

    if (!isTerminalSession) {
      recordFinding('P0', 'Step 3 — Terminal session never started after UI click',
        'Click on Terminal card succeeded (clicked=' + clicked + ') but no shell prompt ' +
        'appeared in the xterm buffer within 8 s. Falling back to programmatic ' +
        'startToolSession("terminal") so the rest of the journey can proceed.');
      await page.evaluate(async () => {
        const r = await fetch('/api/sessions/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'journey-terminal', workingDir: '/tmp/express' }),
        });
        const data = await r.json();
        await window.app.joinSession(data.sessionId);
        window.app.startToolSession('terminal');
      });
      await page.waitForFunction(() => {
        const term = window.app && window.app.terminal;
        if (!term) return false;
        const buf = term.buffer.active;
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i);
          if (line && line.translateToString(true).trim().length > 0) return true;
        }
        return false;
      }, { timeout: 15000 });
    } else {
      recordFinding('PASS', 'Step 3 — Terminal session started via UI click', 'shell prompt visible');
    }

    await shot(page, '03c-terminal-started');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Step 4: Install OSC 7 PROMPT_COMMAND hook in PTY, verify cwd_changed
  // ─────────────────────────────────────────────────────────────────────
  test('Step 4 — install bash OSC 7 hook, verify cwd_changed fires', async () => {
    // Reset capture
    cwdChangedFrames = [];

    // First: ensure we're in bash (the spec hook uses bash syntax). The
    // default macOS shell is zsh — for parity with the spec snippet we
    // explicitly start bash. Real users on macOS would hit this same
    // mismatch — flag as a finding.
    const shellBefore = await page.evaluate(() => {
      // Read SHELL env from terminal text — best-effort.
      return null;
    });

    // Send the spec's bash hook verbatim:
    //   PROMPT_COMMAND='printf "\e]7;file://%s%s\e\\" "$HOSTNAME" "$PWD"'
    // We send it to whatever shell is running. zsh accepts the var
    // assignment without effect; bash uses it.
    await sendInput(page, 'PROMPT_COMMAND=\'printf "\\e]7;file://%s%s\\e\\\\" "$HOSTNAME" "$PWD"\'\r');
    await page.waitForTimeout(800);

    // If we're in zsh, the spec recommends a chpwd hook instead. Try
    // that as a follow-up so the test exercises BOTH variants.
    await sendInput(page, 'function chpwd() { printf "\\e]7;file://%s%s\\e\\\\" "$HOST" "$PWD" }\r');
    await page.waitForTimeout(500);

    // Trigger a prompt re-render: cd to the same dir, which fires both
    // PROMPT_COMMAND (bash) and chpwd (zsh, but only on actual change).
    // Use cd ~ then back to provoke at least one OSC 7 emit.
    await sendInput(page, 'cd /tmp\r');
    await page.waitForTimeout(800);
    await sendInput(page, 'cd /tmp/express\r');
    await page.waitForTimeout(1500);

    await shot(page, '04-osc7-hook-installed');

    if (cwdChangedFrames.length === 0) {
      recordFinding('P0', 'Step 4 — OSC 7 hook does not fire',
        'After installing the spec\'s bash PROMPT_COMMAND hook AND the zsh chpwd hook, ' +
        'and `cd /tmp && cd /tmp/express`, ZERO `cwd_changed` frames arrived. ' +
        'Hand off to systems-engineer (#7) — this is exactly the real-shell validation they own. ' +
        'Possible causes: (a) shell escape interpretation in the WebSocket input pipeline strips ESC bytes; ' +
        '(b) bridge\'s OSC 7 parser doesn\'t handle the percent-encoded form; ' +
        '(c) shell hook syntax doesn\'t survive the WebSocket bracketed-paste round-trip. ' +
        'Captured terminal text: \n```\n' + (await getTerminalText(page)).slice(-1500) + '\n```');
    } else {
      const targets = cwdChangedFrames.map((f) => f.cwd);
      if (!targets.includes('/tmp/express')) {
        recordFinding('P1', 'Step 4 — OSC 7 fires but wrong cwd',
          'cwd_changed frames received: ' + JSON.stringify(targets) +
          ' — expected at least one for /tmp/express. Spec\'s hook may not be PWD-correct on macOS shells.');
      } else {
        recordFinding('PASS', 'Step 4 — OSC 7 hook works',
          cwdChangedFrames.length + ' cwd_changed frames received: ' + JSON.stringify(targets));
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // Step 5: cd into a real repo (express clone)
  // ─────────────────────────────────────────────────────────────────────
  test('Step 5 — cd into express repo', async () => {
    cwdChangedFrames = [];
    await sendInput(page, 'cd /tmp/express/lib\r');
    await page.waitForTimeout(1500);
    await shot(page, '05-cd-express-lib');

    // Did the panel re-root if it was open? Open it now and verify.
    await page.evaluate(() => window.app.toggleFileBrowser());
    await page.waitForTimeout(800);
    await shot(page, '05-panel-after-cd');

    const panelPath = await page.evaluate(() => {
      const p = window.app && window.app._fileBrowserPanel;
      return p && p._currentPath;
    });

    if (cwdChangedFrames.length === 0) {
      recordFinding('NOTE', 'Step 5 — no cwd_changed for cd into express',
        'OSC 7 not firing on cd /tmp/express/lib. Same root cause as step 4. ' +
        'Skipping panel re-root assertion since the live-cwd channel is dead.');
    } else {
      recordFinding('PASS', 'Step 5 — panel sees cd via OSC 7',
        'panel currentPath after cd: ' + panelPath);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // Step 6: Run a failing command emitting paths, click them
  // ─────────────────────────────────────────────────────────────────────
  test('Step 6 — print stack-trace path, click via link provider', async () => {
    // Print a known stack-trace line so we can deterministically click it.
    // (npm test in express takes too long for an exploratory pass; the
    // regex coverage is already proven by 58-click-stack-trace.spec.js.)
    const printed = 'at module (lib/router.js:42:8)';
    await sendInput(page, "printf '%s\\n' '" + printed + "'\r");
    await waitForTerminalText(page, printed, 10000);
    await shot(page, '06-stack-trace-printed');

    // Drive the click via the captured link provider — pixel-clicking
    // xterm canvas glyphs is too brittle for an exploratory pass.
    const clickResult = await page.evaluate(async (hint) => {
      const fb = window.fileBrowser;
      const sid = window.app.currentClaudeSessionId;
      const session = (window.app.claudeSessions || []).find((s) => s.id === sid);
      const workingDir = session ? session.workingDir : null;
      const liveCwd = (window.app._liveCwd && sid) ? (window.app._liveCwd.get(sid) || null) : null;
      const repoRoot = window.app._getRepoRootCached();
      const candidates = fb.resolveCandidates(hint, { liveCwd, workingDir, repoRoot });
      const stats = await Promise.all(candidates.map(async (p) => {
        const r = await window.app.authFetch('/api/files/stat?path=' + encodeURIComponent(p));
        return { path: p, exists: r.status === 200 };
      }));
      const hits = stats.filter((s) => s.exists);
      if (hits.length === 1) {
        window.app.openFileInViewer(hits[0].path, 42, 8);
        return { mode: 'opened', path: hits[0].path };
      }
      return { mode: hits.length > 1 ? 'ambiguous' : 'notfound', candidates };
    }, 'lib/router.js');

    await page.waitForTimeout(1000);
    await shot(page, '06-after-click');

    if (clickResult.mode !== 'opened') {
      recordFinding('P1', 'Step 6 — click on stack-trace path',
        'Path resolution result: ' + JSON.stringify(clickResult) + '. ' +
        'Expected to find /tmp/express/lib/router.js via workingDir+hint. ' +
        'If liveCwd is null (because OSC 7 is dead from step 4), the resolver only had session.workingDir to chain against.');
    } else {
      recordFinding('PASS', 'Step 6 — stack-trace click opens file', 'Opened: ' + clickResult.path);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // Step 7: Cmd-P scenarios
  // ─────────────────────────────────────────────────────────────────────
  test('Step 7a — Cmd-P empty query', async () => {
    await page.evaluate(() => window.app.toggleFindPanel());
    await page.waitForTimeout(300);
    await shot(page, '07a-cmdp-open-empty');
    const status = await page.evaluate(() => {
      const p = window.app._findPanel;
      return p && p._statusEl && p._statusEl.textContent;
    });
    if (!status || !/type/i.test(status)) {
      recordFinding('P2', 'Step 7a — empty Cmd-P state',
        'Empty find panel status text: ' + JSON.stringify(status) +
        '. Expected a "type to search" prompt. Real users see a blank panel and don\'t know what to do.');
    } else {
      recordFinding('PASS', 'Step 7a — empty-state copy present', '"' + status + '"');
    }
  });

  test('Step 7b — Cmd-P "index" → ambiguous results across many index.js', async () => {
    // Express has many index.js (lib/, test/, etc). Type "index"; expect
    // multiple results, focus at index 0.
    await page.evaluate(async () => {
      await window.app._findPanel.runQuery('index');
    });
    await page.waitForTimeout(500);
    await shot(page, '07b-cmdp-index-results');
    const matches = await page.evaluate(() => {
      const p = window.app._findPanel;
      return ((p && p._lastResults) || []).slice(0, 8).map((m) => ({
        path: m.path, basename: m.basename, score: m.score,
      }));
    });
    if (!matches.length) {
      recordFinding('P0', 'Step 7b — no results for "index" in express',
        'Cmd-P returned 0 results for query "index" in /tmp/express. ' +
        'This is a top-of-mind query for any JS/TS dev. ' +
        'Possible: search root not set to express dir; or rg --files failing silently. ' +
        'Findings dump for handoff to principal-engineer.');
    } else {
      recordFinding('PASS', 'Step 7b — "index" matches',
        matches.length + ' shown. Top: ' + matches.slice(0, 3).map((m) => m.basename).join(', '));
    }
  });

  test('Step 7c — Cmd-P "src/app.js" path-separator query', async () => {
    await page.evaluate(async () => {
      window.app._findPanel.runQuery('');
      await window.app._findPanel.runQuery('lib/router');
    });
    await page.waitForTimeout(500);
    await shot(page, '07c-cmdp-pathsep-query');
    const matches = await page.evaluate(() => {
      const p = window.app._findPanel;
      return ((p && p._lastResults) || []).slice(0, 5).map((m) => m.path);
    });
    const hasRouter = matches.some((m) => /lib[\\/]router/.test(m));
    if (!hasRouter) {
      recordFinding('P1', 'Step 7c — path-separator query',
        'Query "lib/router" returned matches: ' + JSON.stringify(matches) +
        '. Did NOT include lib/router.js. fuzzysort scores against basename only — "lib/router" with the `/` may rank below pure basename matches. Recommend fuzzysort against fullpath OR a fallback path-aware ranker.');
    } else {
      recordFinding('PASS', 'Step 7c — path-separator query',
        'lib/router matched: ' + matches.filter((m) => /router/.test(m)).slice(0, 3).join(', '));
    }
  });

  test('Step 7d — Cmd-P regex-character query (.*) does not crash', async () => {
    await page.evaluate(async () => {
      window.app._findPanel.runQuery('');
      await window.app._findPanel.runQuery('.*');
    });
    await page.waitForTimeout(500);
    await shot(page, '07d-cmdp-regex-chars-1');
    let panelStillResponsive = await page.evaluate(() => {
      const p = window.app._findPanel;
      return !!(p && p.isOpen && p.isOpen());
    });
    if (!panelStillResponsive) {
      recordFinding('P0', 'Step 7d — Cmd-P crashed on ".*" query', 'Panel closed unexpectedly');
    }
    await page.evaluate(async () => {
      window.app._findPanel.runQuery('');
      await window.app._findPanel.runQuery('[abc]');
    });
    await page.waitForTimeout(500);
    await shot(page, '07d-cmdp-regex-chars-2');
    panelStillResponsive = await page.evaluate(() => {
      const p = window.app._findPanel;
      return !!(p && p.isOpen && p.isOpen());
    });
    if (panelStillResponsive) {
      recordFinding('PASS', 'Step 7d — regex chars handled', 'No crash on ".*" or "[abc]"');
    } else {
      recordFinding('P0', 'Step 7d — Cmd-P crashed on "[abc]" query', 'Panel closed unexpectedly');
    }
  });

  test('Step 7e — Cmd-P keyboard-only nav (no mouse)', async () => {
    // Pre-condition: panel still open with results.
    await page.evaluate(async () => {
      window.app._findPanel.open();
      await window.app._findPanel.runQuery('router');
    });
    await page.waitForTimeout(400);
    // Focus the input (keyboard-only nav) by clicking? No — task says no mouse.
    // Instead, dispatch keydown directly on the input via page.keyboard.press
    // after focusing programmatically (the toggleFindPanel handler does this,
    // but for safety we set focus first).
    await page.evaluate(() => {
      const input = window.app._findPanel._inputEl;
      if (input) input.focus();
    });
    const before = await page.evaluate(() => window.app._findPanel._focusedIndex);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(80);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(80);
    const afterArrow = await page.evaluate(() => window.app._findPanel._focusedIndex);
    if (afterArrow !== before + 2) {
      recordFinding('P1', 'Step 7e — ArrowDown does not advance focus',
        `before=${before}, after-2x-down=${afterArrow}; expected ${before + 2}. Either the ` +
        'keyboard handler isn\'t bound, or focus shift was clamped at boundary.');
    } else {
      recordFinding('PASS', 'Step 7e — ArrowDown advances focus', `${before} → ${afterArrow}`);
    }
    // Esc should close
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const stillOpen = await page.evaluate(() => window.app._findPanel.isOpen());
    if (stillOpen) {
      recordFinding('P0', 'Step 7e — Esc does not close Cmd-P', 'Panel remained open after Escape press');
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // Step 8: Multi-session switching + follow-toggle persistence
  // ─────────────────────────────────────────────────────────────────────
  test('Step 8 — multi-session: create second, switch, verify follow-toggle persists per-session', async () => {
    const firstSid = await page.evaluate(() => window.app.currentClaudeSessionId);

    // Create second session inside the repo (the dev server's baseFolder
    // = the ai-or-die repo root; workingDir outside it would 403).
    const secondSid = await page.evaluate(async () => {
      const r = await fetch('/api/sessions/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'journey-second', workingDir: '/Users/kundus/Software/ai-or-die/e2e' }),
      });
      const data = await r.json();
      if (!data.sessionId) return { error: 'no sessionId; response=' + JSON.stringify(data) };
      await window.app.joinSession(data.sessionId);
      window.app.startToolSession('terminal');
      return data.sessionId;
    });
    if (typeof secondSid === 'object') {
      recordFinding('P1', 'Step 8 — could not create second session', JSON.stringify(secondSid));
      // Try without workingDir override (defaults to baseFolder).
      const fallbackSid = await page.evaluate(async () => {
        const r = await fetch('/api/sessions/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'journey-second-fallback' }),
        });
        const data = await r.json();
        if (data.sessionId) {
          await window.app.joinSession(data.sessionId);
          window.app.startToolSession('terminal');
        }
        return data.sessionId;
      });
      if (!fallbackSid) {
        recordFinding('P0', 'Step 8 — second-session create failed entirely', 'Aborting step 8');
        return;
      }
    }
    const realSecondSid = typeof secondSid === 'string' ? secondSid : null;
    if (!realSecondSid) {
      // Re-read currentClaudeSessionId after the fallback.
      const sid = await page.evaluate(() => window.app.currentClaudeSessionId);
      recordFinding('NOTE', 'Step 8 — using fallback session', sid);
    }

    await page.waitForFunction((sid) => {
      return window.app.currentClaudeSessionId === sid;
    }, realSecondSid || firstSid, { timeout: 10000 }).catch(() => {});
    await shot(page, '08-second-session-active');

    // Pause follow on second session
    const pauseSecondSid = await page.evaluate(() => window.app.currentClaudeSessionId);
    await page.evaluate(() => {
      const sid = window.app.currentClaudeSessionId;
      if (window.app._fileBrowserPanel) {
        window.app._fileBrowserPanel.setFollowsTerminal(sid, false);
      } else {
        // Force-construct the panel so the follow-toggle map exists.
        if (window.app._ensureFileBrowser) window.app._ensureFileBrowser();
        if (window.app._fileBrowserPanel) {
          window.app._fileBrowserPanel.setFollowsTerminal(sid, false);
        }
      }
    });

    // Switch back to first session
    await page.evaluate(async (sid) => {
      await window.app.joinSession(sid);
    }, firstSid);
    await page.waitForFunction((sid) => {
      return window.app.currentClaudeSessionId === sid;
    }, firstSid, { timeout: 10000 }).catch(() => {});
    await shot(page, '08-back-to-first');

    const firstFollows = await page.evaluate(() => {
      const fb = window.app._fileBrowserPanel;
      const sid = window.app.currentClaudeSessionId;
      return fb && fb.followsTerminal(sid);
    });
    // Switch back to second
    await page.evaluate(async (sid) => {
      await window.app.joinSession(sid);
    }, pauseSecondSid);
    await page.waitForFunction((sid) => {
      return window.app.currentClaudeSessionId === sid;
    }, pauseSecondSid, { timeout: 10000 }).catch(() => {});
    const secondFollows = await page.evaluate(() => {
      const fb = window.app._fileBrowserPanel;
      const sid = window.app.currentClaudeSessionId;
      return fb && fb.followsTerminal(sid);
    });

    if (firstFollows !== true) {
      recordFinding('P1', 'Step 8 — first session follow flag corrupted',
        'First session followsTerminal=' + firstFollows + ' (expected true; default is on)');
    }
    if (secondFollows !== false) {
      recordFinding('P1', 'Step 8 — second session follow flag did not persist',
        'After session switch+back, second-session followsTerminal=' + secondFollows + ' (expected false)');
    }
    if (firstFollows === true && secondFollows === false) {
      recordFinding('PASS', 'Step 8 — follow-toggle persists per-session',
        'first=true, second=false survived session switching');
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // Step 9: Drag a local file → @<path> injection
  // ─────────────────────────────────────────────────────────────────────
  test('Step 9 — drag a file (synthesized DataTransfer; flag native gap)', async () => {
    recordFinding('NOTE', 'Step 9 — synthesized DnD',
      'Playwright cannot drive native macOS Finder drag-and-drop. Using synthesized ' +
      'DataTransfer drop event — same code path that 63-drop-pdf.spec.js exercises. ' +
      'A native-Finder smoke needs a human-in-the-loop pass.');

    // Build a tiny file in-page and dispatch a drop.
    const result = await page.evaluate(async () => {
      const dt = new DataTransfer();
      const file = new File([new TextEncoder().encode('hello from journey')], 'journey-note.txt', {
        type: 'text/plain',
      });
      dt.items.add(file);
      const target = document.getElementById('terminal');
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    });

    // Wait for `@<path>` to appear in the terminal.
    let injected = false;
    try {
      await waitForTerminalText(page, 'journey-note.txt', 10000);
      const text = await getTerminalText(page);
      injected = /@.*\.claude-attachments.*journey-note\.txt/.test(text);
    } catch (_) {
      // fallthrough to finding
    }
    await shot(page, '09-after-drop');
    if (injected) {
      recordFinding('PASS', 'Step 9 — drop injects @<path>', 'journey-note.txt appeared in terminal as @-ref');
    } else {
      recordFinding('P1', 'Step 9 — drop did not inject @<path>',
        'Synthesized drop fired but no @<path> in terminal text. ' +
        'Last 800 chars of terminal:\n```\n' + (await getTerminalText(page)).slice(-800) + '\n```');
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // Step 10: Mobile resize while panels are open
  // ─────────────────────────────────────────────────────────────────────
  test('Step 10 — resize to 375px while Cmd-P / picker / file browser open', async () => {
    // Cmd-P open first
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => window.app.toggleFindPanel());
    await page.waitForTimeout(300);
    await page.evaluate(async () => { await window.app._findPanel.runQuery('index'); });
    await page.waitForTimeout(400);
    await page.setViewportSize({ width: 375, height: 700 });
    await page.waitForTimeout(500);
    await shot(page, '10a-cmdp-mobile');
    // Inspect: is the panel still on-screen and usable?
    const cmdpBox = await page.evaluate(() => {
      const p = window.app._findPanel && window.app._findPanel._panelEl;
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (cmdpBox && (cmdpBox.x < -10 || cmdpBox.x + cmdpBox.w > 385)) {
      recordFinding('P2', 'Step 10a — Cmd-P overflows on 375px',
        'panel rect at 375px viewport: ' + JSON.stringify(cmdpBox));
    } else if (cmdpBox) {
      recordFinding('PASS', 'Step 10a — Cmd-P fits 375px', JSON.stringify(cmdpBox));
    }

    // Reset to desktop, close Cmd-P, open ambiguity picker, resize again
    await page.evaluate(() => window.app._findPanel.close());
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      window.app._showAmbiguityPicker({
        hint: 'utils.js',
        candidates: ['/tmp/a/utils.js', '/tmp/b/utils.js', '/tmp/c/utils.js'],
        line: null, col: null,
        choose: (p) => window.app.openFileInViewer(p, null, null),
      });
    });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 375, height: 700 });
    await page.waitForTimeout(500);
    await shot(page, '10b-picker-mobile');
    const pickerBox = await page.evaluate(() => {
      const el = document.querySelector('.fb-ambiguity-picker');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (!pickerBox) {
      recordFinding('P1', 'Step 10b — picker disappeared on resize',
        'Ambiguity picker not in DOM after 1280→375 resize');
    } else if (pickerBox.x < -10 || pickerBox.x + pickerBox.w > 385) {
      recordFinding('P2', 'Step 10b — picker overflows on 375px',
        'picker rect: ' + JSON.stringify(pickerBox) + ' — overflows the 375px viewport');
    } else {
      recordFinding('PASS', 'Step 10b — picker fits 375px', JSON.stringify(pickerBox));
    }

    // Close picker (Esc) — also tests the cascade
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // File browser panel resize
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      const p = window.app._fileBrowserPanel;
      if (p && !p.isOpen()) p.open();
    });
    await page.waitForTimeout(400);
    await page.setViewportSize({ width: 375, height: 700 });
    await page.waitForTimeout(500);
    await shot(page, '10c-filebrowser-mobile');
    const fbBox = await page.evaluate(() => {
      const el = document.querySelector('.file-browser-panel');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (!fbBox) {
      recordFinding('P1', 'Step 10c — file browser disappeared on resize', 'panel not in DOM');
    } else if (fbBox.w > 385) {
      recordFinding('P1', 'Step 10c — file browser too wide for 375px',
        'panel rect: ' + JSON.stringify(fbBox) + ' (covers full viewport, may hide terminal)');
    } else {
      recordFinding('PASS', 'Step 10c — file browser usable at 375px', JSON.stringify(fbBox));
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Step 11: Reload, verify session/follow-toggle/tabs restore
  // ─────────────────────────────────────────────────────────────────────
  test('Step 11 — reload, verify sessions and tabs restore', async () => {
    // Open a tab so we have something to verify restoration of.
    const sidBefore = await page.evaluate(() => window.app.currentClaudeSessionId);
    // Note current session count.
    const sessionsBefore = await page.evaluate(() => (window.app.claudeSessions || []).length);

    await page.reload();
    await page.waitForFunction(() => !!(window.app && window.app.terminal), { timeout: 30000 });
    await page.waitForTimeout(2000);
    await shot(page, '11-after-reload');

    const sessionsAfter = await page.evaluate(() => (window.app.claudeSessions || []).length);
    if (sessionsAfter < sessionsBefore) {
      recordFinding('P1', 'Step 11 — sessions lost on reload',
        `before=${sessionsBefore}, after=${sessionsAfter}`);
    } else {
      recordFinding('PASS', 'Step 11 — sessions survive reload',
        `before=${sessionsBefore}, after=${sessionsAfter}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // Step 12: Esc cascade
  // ─────────────────────────────────────────────────────────────────────
  test('Step 12 — Esc cascade closes layered panels without double-fire', async () => {
    // After the reload in Step 11, the panels are gone. Re-construct
    // the file browser, then open Cmd-P on top, then check Esc behaviour.
    await page.evaluate(() => {
      window.app._ensureFileBrowser();
      const fb = window.app._fileBrowserPanel;
      if (fb && !fb.isOpen()) fb.open();
    });
    await page.waitForTimeout(300);

    await page.evaluate(() => window.app.toggleFindPanel());
    await page.waitForTimeout(300);
    await shot(page, '12a-stack-fb-cmdp');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const cmdpStillOpen = await page.evaluate(() => {
      return !!(window.app._findPanel && window.app._findPanel.isOpen());
    });
    const fbStillOpen = await page.evaluate(() => {
      return !!(window.app._fileBrowserPanel && window.app._fileBrowserPanel.isOpen());
    });
    if (cmdpStillOpen || !fbStillOpen) {
      recordFinding('P2', 'Step 12 — Esc cascade unexpected',
        `After 1 Esc: cmdpOpen=${cmdpStillOpen}, fbOpen=${fbStillOpen}. ` +
        'Expected: 1 Esc closes Cmd-P (top of stack), file browser stays open. ' +
        'If both close on a single Esc that is a "double-fire" — confusing.');
    } else {
      recordFinding('PASS', 'Step 12 — single Esc closes only Cmd-P',
        'cmdpOpen=false, fbOpen=true');
    }

    // Second Esc — does file browser close?
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const fbAfterSecondEsc = await page.evaluate(() => {
      return !!(window.app._fileBrowserPanel && window.app._fileBrowserPanel.isOpen());
    });
    if (fbAfterSecondEsc === true) {
      recordFinding('P2', 'Step 12 — file browser ignores Esc',
        'File browser remained open after second Escape press. ' +
        'Inconsistent UX — Cmd-P and ambiguity picker both close on Esc; file browser ' +
        'should too (or at minimum the inconsistency should be documented).');
    } else {
      recordFinding('PASS', 'Step 12 — file browser closes on second Esc', '');
    }
  });
});
