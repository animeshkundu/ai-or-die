const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  waitForTerminalText,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Client performance report', () => {
  let server;
  let port;
  let url;

  test.beforeAll(async () => {
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
  });

  test('records cold readiness and flood frame timing', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      window.__frameProbe = { gaps: [], longTasks: [] };
      let previous = 0;
      const tick = (now) => {
        if (previous) window.__frameProbe.gaps.push(now - previous);
        previous = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      if ('PerformanceObserver' in window) {
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              window.__frameProbe.longTasks.push(entry.duration);
            }
          }).observe({ type: 'longtask', buffered: true });
        } catch (_) { /* unsupported on WebKit */ }
      }
    });

    const wire = { frames: 0, bytes: 0 };
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        if (Buffer.isBuffer(payload)) {
          wire.frames++;
          wire.bytes += payload.byteLength;
        }
      });
    });

    const results = [];
    for (const viewport of [
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'iphone-portrait', width: 393, height: 852 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const sessionId = await createSessionViaApi(port, `Perf ${viewport.name}`);
      await page.goto(url);
      await waitForAppReady(page);
      await waitForTerminalCanvas(page);
      await joinSessionAndStartTerminal(page, sessionId);

      const ttiMs = await page.evaluate(() => performance.now());
      const beforeFrames = wire.frames;
      const beforeBytes = wire.bytes;
      await page.evaluate(() => {
        window.__frameProbe.gaps.length = 0;
        window.__frameProbe.longTasks.length = 0;
      });
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        window.__frameProbe.gaps.length = 0;
        window.__frameProbe.longTasks.length = 0;
      });

      const marker = `PERF_${viewport.name.replace(/\W/g, '_')}_${Date.now()}`;
      const command = `node -e "process.stdout.write(Array.from({length:4000},(_,j)=>'${marker}_'+String(j+1).padStart(4,'0')+'_'+\'x\'.repeat(50)).join('\\\\n')+'\\\\n')"`;
      const started = Date.now();
      await page.evaluate((value) => window.app.send({ type: 'input', data: value + '\r' }), command);
      await waitForTerminalText(page, `${marker}_4000`, 60000);
      await page.waitForFunction(() => window.app._pendingWriteBytes === 0);
      const floodMs = Date.now() - started;
      const floodWire = {
        frames: wire.frames - beforeFrames,
        bytes: wire.bytes - beforeBytes,
      };

      const echoMarker = `ECHO_${viewport.name.replace(/\W/g, '_')}_${Date.now()}`;
      const keystrokeToEchoMs = await page.evaluate((marker) => new Promise((resolve, reject) => {
        const startedAt = performance.now();
        const timeout = setTimeout(() => {
          subscription.dispose();
          reject(new Error('Timed out waiting for terminal echo'));
        }, 5000);
        const subscription = window.app.terminal.onWriteParsed(() => {
          const buffer = window.app.terminal.buffer.active;
          const startLine = Math.max(0, buffer.length - 12);
          for (let line = startLine; line < buffer.length; line++) {
            if (buffer.getLine(line)?.translateToString(true).includes(marker)) {
              clearTimeout(timeout);
              subscription.dispose();
              resolve(performance.now() - startedAt);
              return;
            }
          }
        });
        window.app.send({ type: 'input', data: `printf '${marker}\\n'\r` });
      }), echoMarker);

      const scroll = await page.evaluate(async () => {
        const terminal = window.app.terminal;
        terminal.scrollToBottom();
        const gaps = [];
        let previous = 0;
        for (let index = 0; index < 60; index++) {
          const now = await new Promise((resolve) => requestAnimationFrame(resolve));
          if (previous) gaps.push(now - previous);
          previous = now;
          terminal.scrollLines(-3);
        }
        const sorted = gaps.slice().sort((a, b) => a - b);
        return {
          maxGapMs: Math.max(0, ...gaps),
          p95GapMs: sorted[Math.floor(sorted.length * 0.95)] || 0,
          scrollbackLines: terminal.buffer.active.length,
        };
      });

      const browser = await page.evaluate(() => ({
        maxRafGapMs: Math.max(0, ...window.__frameProbe.gaps),
        maxLongTaskMs: Math.max(0, ...window.__frameProbe.longTasks),
        longTaskCount: window.__frameProbe.longTasks.length,
        pendingWriteBytes: window.app._pendingWriteBytes,
        planDetectBytes: window.app._planDetectBytes,
      }));
      results.push({
        viewport: viewport.name,
        ttiMs: Math.round(ttiMs),
        floodMs,
        keystrokeToEchoMs: Math.round(keystrokeToEchoMs * 10) / 10,
        scroll,
        wireFrames: floodWire.frames,
        wireBytes: floodWire.bytes,
        ...browser,
      });
    }

    await testInfo.attach('client-performance.json', {
      body: Buffer.from(JSON.stringify(results, null, 2)),
      contentType: 'application/json',
    });
    console.log('[client-performance] ' + JSON.stringify(results));
    expect(results.every((result) => result.pendingWriteBytes === 0)).toBeTruthy();
    expect(results.every((result) => result.planDetectBytes < 256 * 1024)).toBeTruthy();
    expect(results.every((result) => result.maxLongTaskMs <= 100)).toBeTruthy();
    expect(results.every((result) => result.maxRafGapMs <= 50.5)).toBeTruthy();
    expect(results.every((result) => result.scroll.p95GapMs <= 50.5)).toBeTruthy();
  });
});
