// @ts-check
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { createServer } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  waitForSentInput,
  wsCursor,
} = require('../helpers/terminal-helpers');

let server, url;

test.use({ permissions: [] });

test.beforeAll(async () => {
  ({ server, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await page.evaluate(() => {
    if (window.MobileMode) window.MobileMode.closeSurface();
  }).catch(() => {});
  await attachFailureArtifacts(page, testInfo);
});

async function startMobileMode(page) {
  setupPageCapture(page);
  await page.goto(url + '?mobileMode=1');
  await waitForAppReady(page, 20000);
  await waitForWebSocket(page, 20000);
  await page.waitForFunction(() => {
    return !!(window.app && window.app.isMobile)
      && document.body.classList.contains('is-mobile')
      && document.body.classList.contains('mobile-mode-active')
      && !!(window.MobileMode && window.MobileMode.getController && window.MobileMode.getController());
  }, null, { timeout: 20000 });
  await page.waitForFunction(() => {
    const controller = window.MobileMode && window.MobileMode.getController && window.MobileMode.getController();
    const sessionId = window.app && window.app.currentClaudeSessionId;
    return !!(controller && sessionId && controller.currentSessionId === String(sessionId));
  }, null, { timeout: 20000 });
}

async function createBoundTranscriptSession(name) {
  const response = await fetch(url + '/api/sessions/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  if (!response.ok) throw new Error('session create failed: HTTP ' + response.status);
  const data = await response.json();
  const sessionId = data.sessionId;
  const transcriptPath = path.join(server._testTempDir, sessionId + '.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  server._stickyJsonl.set(sessionId, { file: transcriptPath });
  return { sessionId, transcriptPath };
}

function appendJsonl(file, records) {
  const text = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  fs.appendFileSync(file, text, 'utf8');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMobileSession(page, sessionId) {
  await page.waitForFunction((sid) => {
    return window.app && window.app.currentClaudeSessionId === sid
      && window.MobileMode && window.MobileMode.getController
      && window.MobileMode.getController().currentSessionId === sid;
  }, sessionId, { timeout: 20000 });
}

async function postControlDecision(sessionId, body) {
  const response = await fetch(url + '/api/control/sessions/' + encodeURIComponent(sessionId) + '/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('decision create failed: HTTP ' + response.status + ' ' + await response.text());
  return response.json();
}

async function awaitDecisionAnswer(decisionId) {
  const response = await fetch(url + '/api/control/decisions/' + encodeURIComponent(decisionId) + '/await?timeoutMs=10000');
  if (!response.ok) throw new Error('decision await failed: HTTP ' + response.status + ' ' + await response.text());
  return response.json();
}

function waitForDecisionAnswerRequest(page, decisionId) {
  return page.waitForRequest((request) => {
    return request.method() === 'POST'
      && request.url().includes('/api/control/decisions/' + encodeURIComponent(decisionId) + '/answer');
  }, { timeout: 20000 });
}

test.describe('Mobile mode client shell', () => {
  test('activates on the iPhone/iPad mobile projects when explicitly opted in', async ({ page }) => {
    await startMobileMode(page);

    const state = await page.evaluate(() => ({
      appIsMobile: !!(window.app && window.app.isMobile),
      bodyIsMobile: document.body.classList.contains('is-mobile'),
      mobileModeActive: document.body.classList.contains('mobile-mode-active'),
      hasController: !!(window.MobileMode && window.MobileMode.getController && window.MobileMode.getController()),
    }));

    expect(state).toEqual({
      appIsMobile: true,
      bodyIsMobile: true,
      mobileModeActive: true,
      hasController: true,
    });
    await expect(page.locator('[data-testid="mobile-mode-shell"]')).toBeVisible();
    await expect(page.locator('[data-testid="mobile-compose-fab"]')).toBeVisible();
  });

  test('composer sends exact Channel-2 bytes for message+Enter and immediate interrupt', async ({ page }) => {
    await startMobileMode(page);

    await page.locator('[data-testid="mobile-compose-fab"]').click();
    await expect(page.locator('[data-testid="mobile-composer-sheet"]')).toHaveClass(/active/);
    await page.locator('[data-testid="mobile-composer-text"]').fill('hello mobile mode');

    const sendStart = wsCursor(page);
    await page.locator('[data-testid="mobile-send-composer"]').click();
    const sent = await waitForSentInput(page, sendStart, 'hello mobile mode\r', 'mobile composer send');
    expect(sent.data).toBe('hello mobile mode\r');

    await page.locator('[data-testid="mobile-compose-fab"]').click();
    await expect(page.locator('[data-testid="mobile-composer-sheet"]')).toHaveClass(/active/);

    const stopStart = wsCursor(page);
    await page.locator('[data-testid="mobile-stop-button"]').click();
    const interrupted = await waitForSentInput(page, stopStart, '\x03', 'mobile composer interrupt');
    expect(interrupted.data).toBe('\x03');
  });

  test('opens and closes reusable mobile sheets', async ({ page }) => {
    await startMobileMode(page);

    await page.evaluate(() => window.MobileMode.openSurface('question'));
    const sheet = page.locator('[data-testid="mobile-question-sheet"]');
    await expect(sheet).toHaveClass(/active/);
    await expect(sheet).toHaveAttribute('aria-hidden', 'false');

    await sheet.locator('[data-close-surface]').first().click();
    await expect(sheet).not.toHaveClass(/active/);
    await expect(sheet).toHaveAttribute('aria-hidden', 'true');
  });

  test('destructive permission data gives Approve the danger styling', async ({ page }) => {
    await startMobileMode(page);

    await page.evaluate(() => {
      window.MobileMode.setDecisionStub('permission', {
        kind: 'permission',
        command: 'npm test -- --watch=false',
        cwd: 'C:\\Users\\anikundu\\Software\\ai-or-die',
        destructive: false,
        risk: 'Read-only-ish test command',
      });
      window.MobileMode.openSurface('permission');
    });

    const approve = page.locator('[data-testid="mobile-approve-permission"]');
    await expect(approve).toHaveClass(/primary/);
    await expect(approve).not.toHaveClass(/danger/);

    await page.evaluate(() => {
      window.MobileMode.setDecisionStub('permission', {
        kind: 'permission',
        command: 'rm -rf build/',
        destructive: true,
        risk: 'Destructive filesystem operation',
      });
    });

    await expect(approve).toHaveClass(/danger/);
    await expect(approve).not.toHaveClass(/primary/);
    const destructiveAttr = await approve.getAttribute('data-destructive');
    expect(destructiveAttr).toBe('true');
  });

  test('answers real Channel-1 mobile decisions without executing command HTML', async ({ page }) => {
    server.claudeSessions.clear();
    server._stickyJsonl.clear();

    const xssCommand = 'rm -rf build && <img src=x onerror="window.__xssd=1">';
    const { sessionId } = await createBoundTranscriptSession('Mobile Channel-1 decisions');
    const firstEventsRequest = page.waitForRequest((request) => request.url().includes('/api/control/events?'), { timeout: 20000 });
    await startMobileMode(page);
    await firstEventsRequest;
    await waitForMobileSession(page, sessionId);

    const toolDecision = await postControlDecision(sessionId, {
      kind: 'tool_approval',
      tool: 'Bash',
      command: xssCommand,
      cwd: 'C:\\Users\\anikundu\\Software\\ai-or-die',
    });
    const toolDecisionId = toolDecision.decisionId;

    const permissionSheet = page.locator('[data-testid="mobile-permission-sheet"]');
    await expect(permissionSheet).toHaveClass(/active/);
    await expect(permissionSheet).toHaveAttribute('aria-hidden', 'false');
    await expect(permissionSheet).toHaveAttribute('data-decision-id', toolDecisionId);
    await expect(page.locator('[data-mobile-needs-pill]')).toHaveCSS('opacity', '1');
    await expect(permissionSheet.locator('[data-mobile-permission-command]')).toHaveText(xssCommand);
    await expect(permissionSheet.locator('[data-mobile-permission-cwd]')).toHaveText('C:\\Users\\anikundu\\Software\\ai-or-die');
    await expect(permissionSheet.locator('img[src="x"]')).toHaveCount(0);
    await expect(await page.evaluate(() => window.__xssd)).toBeUndefined();

    const approve = page.locator('[data-testid="mobile-approve-permission"]');
    await expect(approve).toHaveClass(/danger/);
    await expect(approve).not.toHaveClass(/primary/);
    await expect(approve).toHaveAttribute('data-destructive', 'true');

    const toolAwait = awaitDecisionAnswer(toolDecisionId);
    await delay(20);
    const toolAnswerRequest = waitForDecisionAnswerRequest(page, toolDecisionId);
    await approve.click();
    const toolRequest = await toolAnswerRequest;
    expect(toolRequest.postDataJSON()).toEqual({ choice: 'accept' });
    await expect(permissionSheet).not.toHaveClass(/active/);
    await expect(await toolAwait).toEqual({ answered: true, choice: 'accept' });

    const planText = '### Plan\n- [ ] Reject this mobile-mode plan\n- [ ] Keep Channel-1 first-answer-wins';
    const planDecision = await postControlDecision(sessionId, {
      kind: 'plan_approval',
      plan: planText,
    });
    const planDecisionId = planDecision.decisionId;

    const planSheet = page.locator('[data-testid="mobile-plan-sheet"]');
    await expect(planSheet).toHaveClass(/active/);
    await expect(planSheet).toHaveAttribute('aria-hidden', 'false');
    await expect(planSheet).toHaveAttribute('data-decision-id', planDecisionId);
    await expect(planSheet.locator('[data-mobile-plan-doc]')).toContainText('Reject this mobile-mode plan');

    const planAwait = awaitDecisionAnswer(planDecisionId);
    await delay(20);
    const planAnswerRequest = waitForDecisionAnswerRequest(page, planDecisionId);
    await planSheet.locator('[data-mobile-reject-plan]').click();
    const planRequest = await planAnswerRequest;
    expect(planRequest.postDataJSON()).toEqual({ choice: 'reject' });
    await expect(await planAwait).toEqual({ answered: true, choice: 'reject' });
    await expect(planSheet).not.toHaveClass(/active/);
  });

  test('renders the real turn stream tool card without executing tool-result HTML', async ({ page }) => {
    server.claudeSessions.clear();
    server._stickyJsonl.clear();

    const xss = '<img src=x onerror="window.__xss=1">';
    const { sessionId, transcriptPath } = await createBoundTranscriptSession('Mobile real stream');
    appendJsonl(transcriptPath, [
      {
        type: 'user',
        uuid: 'mobile-user-1',
        timestamp: '2026-07-07T00:00:00.000Z',
        message: { role: 'user', content: 'Please run the mobile stream smoke test.' },
      },
      {
        type: 'assistant',
        uuid: 'mobile-assistant-1',
        timestamp: '2026-07-07T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will run the smoke test now.' },
            { type: 'tool_use', id: 'tool-mobile-1', name: 'Bash', input: { command: 'npm test -- --runInBand', cwd: 'C:\\Users\\anikundu\\Software\\ai-or-die' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'mobile-tool-result-1',
        timestamp: '2026-07-07T00:00:02.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-mobile-1', content: xss, is_error: false }] },
      },
      {
        type: 'assistant',
        uuid: 'mobile-assistant-2',
        timestamp: '2026-07-07T00:00:03.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'The smoke test finished safely.' }] },
      },
    ]);

    const firstEventsRequest = page.waitForRequest((request) => request.url().includes('/api/control/events?'), { timeout: 20000 });
    await startMobileMode(page);
    await firstEventsRequest;

    await page.waitForFunction((sid) => {
      return window.app && window.app.currentClaudeSessionId === sid
        && window.MobileMode && window.MobileMode.getController
        && window.MobileMode.getController().currentSessionId === sid;
    }, sessionId, { timeout: 20000 });

    await expect(page.locator('.message-row.user .bubble')).toContainText('Please run the mobile stream smoke test.');
    await expect(page.locator('.message-row.assistant .bubble').first()).toContainText('I will run the smoke test now.');
    await expect(page.locator('.message-row.assistant .bubble').last()).toContainText('The smoke test finished safely.');

    const toolCards = page.locator('[data-mobile-message-stack] .tool-card');
    await expect(toolCards).toHaveCount(1);
    await expect(toolCards.first().locator('.tool-summary')).toContainText('npm test -- --runInBand');
    await toolCards.first().locator('.tool-summary').click();
    await expect(toolCards.first()).toHaveClass(/expanded/);
    await expect(toolCards.first().locator('.tool-details')).toContainText('npm test -- --runInBand');
    await expect(toolCards.first().locator('pre')).toContainText(xss);
    await expect(toolCards.first().locator('img[src="x"]')).toHaveCount(0);
    await expect(await page.evaluate(() => window.__xss)).toBeUndefined();

    const nextEventsRequest = page.waitForRequest((request) => request.url().includes('/api/control/events?'), { timeout: 20000 });
    server.controlEventBus.append(sessionId, 'became_busy');
    await expect(page.locator('[data-mobile-status-text]')).toHaveText('working…');
    await nextEventsRequest;

    const idleEventsRequest = page.waitForRequest((request) => request.url().includes('/api/control/events?'), { timeout: 20000 });
    server.controlEventBus.append(sessionId, 'waiting_input');
    await expect(page.locator('[data-mobile-status-text]')).toHaveText('needs you');
    await expect(page.locator('[data-mobile-needs-pill]')).toHaveCSS('opacity', '1');
    await idleEventsRequest;

    server.controlEventBus.append(sessionId, 'became_idle');
    await expect(page.locator('[data-mobile-status-text]')).toHaveText('idle');
    await expect(page.locator('[data-mobile-needs-pill]')).toHaveCSS('opacity', '0');
  });
});
