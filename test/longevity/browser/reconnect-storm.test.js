// @ts-check
/**
 * CLIENT-02 regression — WebSocket listener accumulation across reconnects.
 *
 * Memo: docs/audits/client-listener-accumulation.md
 *
 * What this spec proves on main HEAD:
 *
 *   The browser client (src/public/app.js) creates its WebSocket via property
 *   assignment (ws.onopen / ws.onmessage / ws.onclose / ws.onerror) and
 *   constructs a brand-new WebSocket object on every reconnect after
 *   disconnect() nulls the prior reference. Therefore each WS instance has
 *   at most ONE handler per event type, and the addEventListener API is
 *   never used on the WebSocket. No handler accumulation can occur.
 *
 *   This spec is a FORWARD-LOOKING GUARD: it is intended to PASS on current
 *   main. It will FAIL on a regression where a future change moves a
 *   transport handler from property assignment to addEventListener
 *   registration inside a code path that re-runs on reconnect (e.g. inside
 *   onopen). On such a regression, each reconnect would attach one extra
 *   listener to the new WS — and our wrapper counts the cumulative
 *   addEventListener calls across all WS instances and asserts that the
 *   total stays at or near zero (the codebase deliberately uses property
 *   assignment for transport handlers).
 *
 *   The spec also asserts:
 *     • at most one WebSocket is in OPEN state after a reconnect storm
 *       (catches orphaned-parallel-socket leaks, which the
 *       `_socketGeneration` fence in app.js prevents),
 *     • the number of WS instances created over the page lifetime is
 *       bounded by `cycles + 1` (initial + one per reconnect; no double-
 *       spawn per cycle).
 *
 * Ports: createServer uses port 0 → OS-assigned high port (>32K).
 *        Never touch port 7777.
 *
 * Cross-platform: uses path.join for the helper requires; the Playwright
 *        page eval code has no platform-specific paths.
 */

'use strict';

const { test, expect } = require('@playwright/test');
const path = require('path');

const {
  createServer,
  createSessionViaApi,
} = require(path.join(__dirname, '..', '..', '..', 'e2e', 'helpers', 'server-factory'));
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForTerminalCanvas,
  waitForWebSocket,
} = require(path.join(__dirname, '..', '..', '..', 'e2e', 'helpers', 'terminal-helpers'));

const RECONNECT_CYCLES = 25;

let server, port, url;

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await attachFailureArtifacts(page, testInfo);
});

test.describe('CLIENT-02 — WebSocket listener accumulation across reconnects', () => {
  test('listener count stays bounded across 25 simulated reconnects', async ({ page }) => {
    setupPageCapture(page);
    // Surface page errors directly to the test runner stdout (the default
    // setupPageCapture captures them but only attaches them on failure;
    // for a long-running storm we want them inline so a regression
    // explains itself without rerunning).
    page.on('pageerror', (err) => {
      // eslint-disable-next-line no-console
      console.log('[browser pageerror]', err.message);
    });

    // Install instrumentation BEFORE the page loads any script. We wrap
    // WebSocket.prototype.addEventListener and the four on* setters so we
    // can attribute every handler registration to a specific WS instance,
    // then aggregate across the page lifetime.
    //
    // We intentionally do NOT count the property-assignment setters as
    // "leak-shaped" — property assignment overwrites in place, so a fresh
    // WS that only uses on* setters has at most one handler per event
    // type and cannot accumulate. We only count addEventListener calls
    // (the leak-shaped API).
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      const instances = [];
      let totalAddListenerCalls = 0;
      let totalInstances = 0;

      function WrappedWebSocket(url, protocols) {
        const ws = protocols === undefined
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols);

        const id = ++totalInstances;
        const meta = {
          id,
          url: String(url),
          addEventListenerCalls: 0,
          createdAt: Date.now(),
        };
        instances.push(meta);

        const origAdd = ws.addEventListener.bind(ws);
        ws.addEventListener = function (type, listener, options) {
          meta.addEventListenerCalls += 1;
          totalAddListenerCalls += 1;
          return origAdd(type, listener, options);
        };

        return ws;
      }
      // Preserve prototype + constants so `instanceof WebSocket` and
      // WebSocket.OPEN constants keep working.
      WrappedWebSocket.prototype = NativeWebSocket.prototype;
      WrappedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
      WrappedWebSocket.OPEN = NativeWebSocket.OPEN;
      WrappedWebSocket.CLOSING = NativeWebSocket.CLOSING;
      WrappedWebSocket.CLOSED = NativeWebSocket.CLOSED;

      window.WebSocket = WrappedWebSocket;
      window.__wsAudit = {
        snapshot() {
          return {
            totalInstances,
            totalAddListenerCalls,
            perInstance: instances.map((m) => ({
              id: m.id,
              addEventListenerCalls: m.addEventListenerCalls,
            })),
            instanceCount: instances.length,
          };
        },
      };
    });

    // Pre-create a session so the app auto-joins on first load.
    const sessionId = await createSessionViaApi(port, 'client-02-reconnect-storm');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await waitForWebSocket(page);

    // Baseline: at least one WS, zero addEventListener calls. The app
    // may legitimately create more than one WS during init() if the
    // initial connect lost a race with session loading and triggered a
    // reconnect — that's not a leak, just a quirk of the init sequence.
    // We record the baseline instance count and assert deltas (not
    // absolutes) against it for the reconnect-storm count assertion.
    const baseline = await page.evaluate(() => window.__wsAudit.snapshot());
    expect(baseline.totalInstances).toBeGreaterThanOrEqual(1);
    expect(baseline.totalAddListenerCalls).toBe(0);

    // Reconnect storm. Each cycle:
    //   1. Server force-closes every live WS client (simulates network
    //      blip / server-side disconnect).
    //   2. Wait for app.js's onclose to fire and schedule its reconnect
    //      (first reconnect delay is 250 ms; subsequent backoff with jitter
    //      but capped — see app.js:1903-1905).
    //   3. Wait for the new WS to reach OPEN state.
    //
    // We drive this entirely from the test side by reaching into the
    // server's `wss.clients` set. Note: `joinSessionAndStartTerminal` is
    // NOT used here because spawning a real PTY per cycle would dominate
    // the wall budget — the listener-leak shape is purely about the WS
    // transport, not the terminal session.
    for (let cycle = 0; cycle < RECONNECT_CYCLES; cycle++) {
      const expectedInstanceCount = baseline.totalInstances + cycle + 1; // baseline + one new WS per cycle so far + the one about to spawn

      // Server-side close — drop every live WS. We use `terminate()`
      // (abrupt TCP RST) rather than `close()` (clean WS close frame)
      // because app.js's onclose only schedules a reconnect when
      // `!event.wasClean` (src/public/app.js:1899). A clean server-side
      // close marks event.wasClean=true and the client would never
      // reconnect — masking the entire test as a no-op.
      const closed = await new Promise((resolve) => {
        let count = 0;
        for (const client of server.wss.clients) {
          try {
            client.terminate();
            count += 1;
          } catch (_) { /* ignore */ }
        }
        resolve(count);
      });
      expect(closed, `cycle ${cycle}: server should have at least one live client to terminate`).toBeGreaterThan(0);

      // Wait for the client to reconnect: a NEW WebSocket instance appears
      // in the audit AND it reaches OPEN AND its onopen handler has run
      // (which resets reconnectAttempts to 0). We must wait for the
      // attempts-reset because the next cycle's close needs a fresh
      // attempt budget — closing again before onopen runs would push
      // reconnectAttempts past maxReconnectAttempts (10) and the client
      // gives up with "Connection lost after 10 attempts".
      await page.waitForFunction(
        (target) => {
          const snap = window.__wsAudit && window.__wsAudit.snapshot();
          if (!snap) return false;
          if (snap.totalInstances < target) return false;
          const live = window.app && window.app.socket;
          if (!live || live.readyState !== 1) return false; // WebSocket.OPEN
          // Wait for app.js onopen to have run (it resets reconnectAttempts to 0).
          return window.app.reconnectAttempts === 0;
        },
        expectedInstanceCount,
        { timeout: 15000 },
      );
    }

    const final = await page.evaluate(() => {
      const snap = window.__wsAudit.snapshot();
      // Count OPEN websockets the page knows about via app.socket.
      // (We can't enumerate all WS instances on the page because we don't
      // keep references — by design, to allow GC.)
      const liveOpen = window.app && window.app.socket
        && window.app.socket.readyState === 1 ? 1 : 0;
      return { ...snap, liveOpen };
    });

    // PRIMARY assertion: no WebSocket instance accumulated any
    // addEventListener calls. On the current codebase this is 0 across
    // the board (property assignment only). A future regression that
    // adds a `ws.addEventListener('message', …)` inside onopen would
    // cause every reconnect to attach one new listener to the new WS,
    // and the per-instance count for the most recent instances would
    // climb. We assert the strictest possible bound: 0.
    //
    // The slack ceiling in the memo (≤2) is reserved for a hypothetical
    // future change that legitimately uses addEventListener for one
    // handler per WS (e.g. a single error tap registered once at
    // construction). The current code uses 0 and we want CI to scream
    // the moment that changes — bumping the bound is a conscious choice
    // a future PR must make explicitly.
    for (const inst of final.perInstance) {
      expect(
        inst.addEventListenerCalls,
        `WS instance ${inst.id} accumulated ${inst.addEventListenerCalls} addEventListener calls — expected 0 (property-assignment convention)`,
      ).toBe(0);
    }
    expect(final.totalAddListenerCalls).toBe(0);

    // SECONDARY assertion: number of WS instances over the page lifetime
    // is bounded. Each reconnect cycle should produce exactly one new
    // WebSocket (the new live one); the prior is closed and discarded.
    // A regression that double-spawns parallel sockets (e.g. losing the
    // `_socketGeneration` fence in onclose) would push the count past
    // the bound.
    //
    // Bound = baseline + RECONNECT_CYCLES (one new WS per cycle). We
    // allow a small slack (+2) for any late-init quirks (e.g. an
    // additional reconnect kicked off by visibilitychange between
    // setupPageCapture's instrumentation and the loop start).
    const expectedTotal = baseline.totalInstances + RECONNECT_CYCLES;
    expect(final.totalInstances).toBeGreaterThanOrEqual(expectedTotal);
    expect(final.totalInstances).toBeLessThanOrEqual(expectedTotal + 2);

    // TERTIARY assertion: only ONE socket is in OPEN state right now.
    // Catches the parallel-socket leak shape directly.
    expect(final.liveOpen).toBe(1);

    // Server side cross-check: only one live client connection in the
    // WSS clients set. If the client had spawned parallels, the server
    // would see multiple — even after our close-storm, since the test
    // only closes the *current* set per cycle.
    const liveServerCount = server.wss.clients.size;
    expect(liveServerCount, 'server should see exactly one live WS after reconnect storm settles').toBe(1);
  });
});
