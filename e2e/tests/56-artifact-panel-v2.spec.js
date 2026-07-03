const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const { waitForAppReady, setupPageCapture, attachFailureArtifacts } = require('../helpers/terminal-helpers');

// Real-browser smoke for artifact panel v2 (feat/artifact-panel-v2). Each test
// gets its OWN server (isolated session store) so there is exactly ONE session —
// the app auto-joins it and the panel does not re-hide (the multi-session join
// race that broke a shared-server 2nd test). Mirrors 55-artifact-panel-chrome's
// single-session pattern.
//
// Browser-drivable here: the composer human→agent comment, the typed /await drain,
// SSE-only single reply render, dismiss/re-open + /history, and the data-aod-*
// interactive controls (choose-one + multi-select) with cursor single-delivery.
// NOT browser-drivable (covered by passing unit tests instead, see the report):
//   - idle-gate decline with a mocked detectAwaiting → ExitPlanMode pending
//     (test/control/artifact-routes.test.js "artifact push idle gate")
//   - artifact_update INVALID_REQUEST tagged-400
//     (test/control/artifact-routes.test.js "v2 P1 ... update ... INVALID_REQUEST")
//   - SSE Last-Event-ID reconnect replay of exactly the gap
//     (test/control/artifact-routes.test.js "SSE frames carry event ids ...")

let artifactDir;
let staticFile;
let interactiveFile;

test.beforeAll(() => {
  artifactDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-e2e-artifact-v2-'));
  staticFile = path.join(artifactDir, 'plan.html');
  fs.writeFileSync(
    staticFile,
    '<!doctype html><html><head><title>Plan v2</title></head><body>' +
    '<h1 data-source-line="1">Plan</h1><p data-source-line="3">Review me.</p></body></html>'
  );
  interactiveFile = path.join(artifactDir, 'interactive.html');
  fs.writeFileSync(
    interactiveFile,
    '<!doctype html><html><head><title>Interactive</title></head><body>' +
    '<button id="approveBtn" data-aod-action="choose" data-aod-value="approve" data-aod-id="plan-step-3">Approve step 3</button>' +
    '<input id="chk7" type="checkbox" data-aod-action="check" data-aod-group="tasks" data-aod-id="task-7" data-aod-value="retry">' +
    '<input id="chk9" type="checkbox" data-aod-action="check" data-aod-group="tasks" data-aod-id="task-9" data-aod-value="cache">' +
    '<button id="submitBtn" data-aod-action="submit" data-aod-group="tasks" data-aod-id="tasks-go">Apply selected</button>' +
    '</body></html>'
  );
});

test.afterAll(() => {
  if (artifactDir) { try { fs.rmSync(artifactDir, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
});

// Per-test isolated server → exactly one session → deterministic panel mount.
let server, port, url;
test.beforeEach(async () => {
  ({ server, port, url } = await createServer());
});
test.afterEach(async ({ page }, testInfo) => {
  await attachFailureArtifacts(page, testInfo);
  if (server) { try { await server.close(); } catch (_) { /* ignore */ } server = null; }
});

async function openArtifact(page, sessionId, file) {
  await page.waitForFunction(
    () => window.app && window.app._artifactPanel && typeof window.app.hideOverlay === 'function',
    { timeout: 20000 }
  );
  await page.evaluate((sid) => {
    window.app.hideOverlay();
    window.app._artifactPanel.notifyActiveSessionChanged(sid);
  }, sessionId);
  const res = await fetch(`http://127.0.0.1:${port}/api/artifact/${encodeURIComponent(sessionId)}/open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: file || staticFile }),
  });
  expect(res.ok).toBeTruthy();
  await expect(page.locator('#artifactPanel')).toBeVisible({ timeout: 15000 });
}

function awaitDrain(page, sessionId, cursor) {
  return page.evaluate(async ({ p, sid, c }) => {
    const r = await fetch(`http://127.0.0.1:${p}/api/artifact/${encodeURIComponent(sid)}/await?cursor=${c}`);
    return r.json();
  }, { p: port, sid: sessionId, c: cursor == null ? 0 : cursor });
}

test.describe('Artifact panel v2 smoke', () => {
  test('HAPPY: comment -> /await -> single SSE reply -> dismiss -> re-open keeps chat/history', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'v2 happy');
    await page.goto(url);
    await waitForAppReady(page);
    await openArtifact(page, sessionId, staticFile);

    // Human -> agent comment via the composer.
    await page.fill('#artifactInput', 'please tighten the plan');
    await page.click('#artifactPanel .artifact-panel__send--note');
    await expect(page.locator('#artifactChat')).toContainText('please tighten the plan', { timeout: 10000 });

    // Agent drains the TYPED /await and sees the comment event.
    const drained = await awaitDrain(page, sessionId, 0);
    const comment = drained.events.find((e) => e.kind === 'comment');
    expect(comment).toBeTruthy();
    expect(comment.prompt).toContain('please tighten the plan');
    expect(comment.id).toBeTruthy();

    // Agent -> human reply renders EXACTLY ONCE (SSE is the sole path).
    await page.evaluate(async ({ p, sid }) => {
      await fetch(`http://127.0.0.1:${p}/api/artifact/${encodeURIComponent(sid)}/agent-reply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'on it now' }),
      });
    }, { p: port, sid: sessionId });
    await expect(page.locator('#artifactChat')).toContainText('on it now', { timeout: 10000 });
    const replyCount = await page.evaluate(() => document.getElementById('artifactChat').textContent.split('on it now').length - 1);
    expect(replyCount).toBe(1);

    // Dismiss (×) -> hidden + re-open badge + server visibility flips.
    await page.click('#artifactPanel .artifact-panel__btn[aria-label="Close panel"]');
    await expect(page.locator('#artifactPanel')).toBeHidden({ timeout: 10000 });
    await expect(page.locator('.artifact-panel__reopen')).toBeVisible({ timeout: 10000 });
    const vis = await page.evaluate(async ({ p, sid }) => {
      const r = await fetch(`http://127.0.0.1:${p}/api/artifact/${encodeURIComponent(sid)}/history`);
      return (await r.json()).visibility;
    }, { p: port, sid: sessionId });
    expect(vis).toBe('dismissed');

    // Re-open -> panel back, chat/history intact.
    await page.click('.artifact-panel__reopen');
    await expect(page.locator('#artifactPanel')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.artifact-panel__reopen')).toBeHidden();
    await expect(page.locator('#artifactChat')).toContainText('please tighten the plan');
    await expect(page.locator('#artifactChat')).toContainText('on it now');
  });

  test('EDGE choose-one + single delivery: one data-aod choose -> ONE action, re-drain empty', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'v2 choose');
    await page.goto(url);
    await waitForAppReady(page);
    await openArtifact(page, sessionId, interactiveFile);

    const frame = page.frameLocator('#artifactFrame');
    await frame.locator('#approveBtn').click();
    await expect(page.locator('#artifactChat')).toContainText('choose: plan-step-3', { timeout: 10000 });

    const drained = await awaitDrain(page, sessionId, 0);
    const actions = drained.events.filter((e) => e.kind === 'action' && e.action === 'choose');
    expect(actions.length).toBe(1);
    expect(actions[0].elementId).toBe('plan-step-3');
    expect(actions[0].value).toBe('approve');

    // Single delivery: draining again from the returned cursor yields nothing —
    // the same event is never re-delivered (cursor ack).
    const again = await awaitDrain(page, sessionId, drained.cursor);
    expect(again.events).toEqual([]);
  });

  test('EDGE multi-select: check a group then submit -> ONE action carrying {group, selected}', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'v2 multi');
    await page.goto(url);
    await waitForAppReady(page);
    await openArtifact(page, sessionId, interactiveFile);

    const frame = page.frameLocator('#artifactFrame');
    await frame.locator('#chk7').check();
    await frame.locator('#submitBtn').click();
    await expect(page.locator('#artifactChat')).toContainText('submitted tasks', { timeout: 10000 });

    const drained = await awaitDrain(page, sessionId, 0);
    const submits = drained.events.filter((e) => e.kind === 'action' && e.action === 'submit');
    expect(submits.length).toBe(1);
    expect(submits[0].group).toBe('tasks');
    expect(submits[0].selected).toEqual([{ elementId: 'task-7', value: 'retry' }]);
  });
});
