// diagnostics-shape.test.js — regression for window.__diagnostics().
//
// Spec: docs/specs/client-longevity.md (CLIENT-03 / SUP-CLIENT).
// Loads the app via the shared server factory, awaits app readiness, then
// asserts the shape returned by window.__diagnostics(). Also asserts
// pre-session-open behavior so SUP-SOAK can sample from page load forward.
//
// Port: createServer() picks a random port; helper binds to 127.0.0.1 with
// port 0 → ephemeral high port (always > 11000 once the OS allocates from
// the dynamic range; never collides with the user's :7777 dev server).

const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../../../e2e/helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  joinSessionAndStartTerminal,
} = require('../../../e2e/helpers/terminal-helpers');

test.describe('window.__diagnostics() shape', () => {
  let server, url;

  test.beforeAll(async () => {
    ({ server, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
  });

  test('returns the expected shape before any session is opened', async ({ page }) => {
    await page.goto(url);
    // Wait only for the function to install — do NOT wait for a session.
    await page.waitForFunction(
      () => typeof window.__diagnostics === 'function',
      { timeout: 15000 }
    );

    const snap = await page.evaluate(() => window.__diagnostics());

    // Top-level keys
    expect(snap).toBeTruthy();
    expect(typeof snap.ts).toBe('number');
    expect(snap.ts).toBeGreaterThan(0);
    expect(snap.dom).toBeTruthy();
    expect(snap.buffers).toBeTruthy();
    expect(snap.ws).toBeTruthy();
    expect(snap.sse).toBeTruthy();
    // memory may be null on this browser/config; just must be present
    expect('memory' in snap).toBe(true);

    // dom
    expect(typeof snap.dom.total_nodes).toBe('number');
    expect(snap.dom.total_nodes).toBeGreaterThan(0);
    // listeners_tracked is OMITTED unless a tracker exists; do not assert
    // either way — just verify if present it is a number.
    if ('listeners_tracked' in snap.dom) {
      expect(typeof snap.dom.listeners_tracked).toBe('number');
    }

    // buffers
    expect(typeof snap.buffers.plan_detector_bytes).toBe('number');
    expect(snap.buffers.plan_detector_bytes).toBeGreaterThanOrEqual(0);
    expect(typeof snap.buffers.xterm_scrollback_lines).toBe('number');
    expect(snap.buffers.xterm_scrollback_lines).toBeGreaterThanOrEqual(0);

    // ws — pre-session, the app may or may not have opened its socket yet.
    // state must be one of {0,1,2,3,null}.
    expect([0, 1, 2, 3, null]).toContain(snap.ws.state);
    expect(snap.ws.url === null || typeof snap.ws.url === 'string').toBe(true);

    // sse
    expect(typeof snap.sse.connected).toBe('boolean');
    expect(typeof snap.sse.streams).toBe('number');
    expect(snap.sse.streams).toBeGreaterThanOrEqual(0);

    // memory: object or null
    expect(snap.memory === null || typeof snap.memory === 'object').toBe(true);

    // JSON-serializable
    expect(() => JSON.stringify(snap)).not.toThrow();
  });

  test('returns the expected shape after a session is opened', async ({ page }) => {
    const port = parseInt(new URL(url).port, 10);
    const sessionId = await createSessionViaApi(port, 'diagnostics-shape-test');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const snap = await page.evaluate(() => window.__diagnostics());

    // Same top-level shape, but now we have stricter expectations on the
    // post-session fields.
    expect(typeof snap.ts).toBe('number');

    // Terminal exists post-join — scrollback line count must be > 0.
    expect(snap.buffers.xterm_scrollback_lines).toBeGreaterThan(0);

    // WebSocket should be OPEN (readyState === 1) once joinSessionAnd...
    // returns.
    expect(snap.ws.state).toBe(1);
    expect(typeof snap.ws.url).toBe('string');
    expect(snap.ws.url.startsWith('ws')).toBe(true);

    // plan_detector_bytes — plan detector is initialized after setupUI(),
    // so it should be a number (may be 0 if no output buffered).
    expect(typeof snap.buffers.plan_detector_bytes).toBe('number');

    // DOM grew compared to pre-session, but we only assert > 0.
    expect(snap.dom.total_nodes).toBeGreaterThan(0);

    // JSON-serializable end-to-end.
    expect(() => JSON.stringify(snap)).not.toThrow();
  });

  test('is callable repeatedly without side effects on the socket', async ({ page }) => {
    const port = parseInt(new URL(url).port, 10);
    const sessionId = await createSessionViaApi(port, 'diagnostics-idempotent-test');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const a = await page.evaluate(() => window.__diagnostics());
    const b = await page.evaluate(() => window.__diagnostics());
    const c = await page.evaluate(() => window.__diagnostics());

    // Three back-to-back calls — none should crash; ws.url is stable; the
    // socket state should not flap (READY stays READY).
    expect(a.ws.state).toBe(1);
    expect(b.ws.state).toBe(1);
    expect(c.ws.state).toBe(1);
    expect(a.ws.url).toBe(b.ws.url);
    expect(b.ws.url).toBe(c.ws.url);
  });
});
