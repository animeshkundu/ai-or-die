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

  test('records cold readiness and flood frame timing', async ({ page, browserName }, testInfo) => {
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
      // Detect the drain AND snapshot the flood-window frame gaps inside one
      // in-page call. Doing the drain wait from the harness and the snapshot in
      // a second `page.evaluate` charged the cross-process round-trip to the
      // flood window as a spurious multi-frame gap.
      //
      // The probe keeps running for the rest of the test, and the scroll phase
      // below janks the main thread on purpose, so a whole-test maximum reports
      // the scroll loop rather than the output pipeline this budget is about.
      // The whole-test figure is still reported below for context.
      //
      // One extra frame is awaited after the queue empties: the gap created by
      // the LAST write task is only recorded when the following rAF fires, and
      // `longtask` entries are delivered asynchronously, so snapshotting the
      // instant the queue drains would drop the most expensive sample.
      const floodFrames = await page.evaluate(() => new Promise((resolve) => {
        const snapshot = () => {
          const gaps = window.__frameProbe.gaps.slice();
          const longTasks = window.__frameProbe.longTasks.slice();
          const sorted = gaps.slice().sort((a, b) => a - b);
          resolve({
            maxGapMs: Math.max(0, ...gaps),
            p95GapMs: sorted[Math.floor(sorted.length * 0.95)] || 0,
            medianGapMs: sorted[Math.floor(sorted.length * 0.5)] || 0,
            maxLongTaskMs: Math.max(0, ...longTasks),
            longTaskCount: longTasks.length,
            sampleCount: gaps.length,
          });
        };
        const waitForDrain = () => {
          if (window.app._pendingWriteBytes === 0) {
            requestAnimationFrame(() => setTimeout(snapshot, 0));
            return;
          }
          requestAnimationFrame(waitForDrain);
        };
        waitForDrain();
      }));
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
        flood: floodFrames,
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

    // Engine-independent pipeline invariants. These assert that the client
    // consumed the whole flood and left nothing queued, and hold on every
    // engine because they measure the output path, not rasterization speed.
    expect(results.every((result) => result.pendingWriteBytes === 0)).toBeTruthy();
    expect(results.every((result) => result.planDetectBytes < 256 * 1024)).toBeTruthy();
    expect(results.every((result) => result.flood.sampleCount > 0)).toBeTruthy();
    // Server-side coalescing still holds: ~330-370KB of flood must not arrive
    // as hundreds of unbatched frames.
    expect(results.every((result) => result.wireFrames > 0 && result.wireFrames <= 120)).toBeTruthy();
    expect(results.every((result) => result.scroll.scrollbackLines > 500)).toBeTruthy();

    // Frame-time budgets. Scoped to the phase each one is named for: the flood
    // budget is sampled across the flood window only, the scroll budget across
    // the 60-step deep-scrollback loop. The whole-test `maxRafGapMs` is
    // reported for context but is NOT a budget -- it spans the deliberate
    // scroll-jank loop and every harness round-trip.
    //
    // The flood gate reads the MEDIAN frame gap, not the maximum. A max over
    // ~20 samples on a shared two-core runner measures contention: the same
    // healthy pipeline (queue drained, 10-12 coalesced wire frames for ~336KB)
    // produced a flood max of 16.8ms locally, 50ms on the Windows runner and
    // 66.6ms on the Linux runner within one hour. The median is robust to that
    // and still fails hard on a real regression, because a pipeline that
    // stopped bounding work per frame moves the whole distribution, not just
    // its tail. Single-task blocking is separately gated by maxLongTaskMs.
    //
    // Ceilings apply to Chromium only, per ADR-0049. They are absolute
    // frame-time numbers calibrated on the CI runner's Chromium; headless
    // WebKit on Linux composites in software with no GPU and measures roughly
    // an order of magnitude slower for identical client code, so the same
    // ceilings there would grade the CI container rather than the product.
    // WebKit still runs this spec and still gates on the invariants above.
    if (browserName === 'chromium') {
      // maxLongTaskMs is platform-aware, and the reason is a real property of
      // the design rather than runner noise. The output batcher budgets work in
      // BYTES (96 KiB per animation frame), which does not bound TIME: the same
      // 96 KiB costs proportionally longer to parse on a slower CPU. So a
      // byte-budget that yields a sub-100ms task on the Linux runner yields a
      // longer one on the Windows runner for identical client code.
      //
      // Measured on Windows CI: flood maxLongTaskMs 184 against this ceiling of
      // 100, while every gap metric passed comfortably (median 16.7ms, p95
      // 16.8-33.4ms vs a 50.5 ceiling). So the frame cadence is healthy and it
      // is specifically the single longest task that overruns.
      //
      // These ceilings were calibrated on the Linux runner only — ADR-0049 pins
      // the client-shell job to ubuntu, so this spec had never run on Windows
      // until the derived browser matrix picked the project up. Windows is this
      // project's PRIMARY target, so the answer is to gate there too rather than
      // exclude it, at a bound taken from what Windows actually measures.
      //
      // 300 is deliberately loose: it comes from ONE Windows observation (184),
      // and calibrating a ceiling from a single sample is the mistake this file
      // is already recovering from elsewhere. It still catches a real regression
      // (a 3x jump from observed) and should be tightened once several runs give
      // a distribution. Tightening it is a follow-up, not a nice-to-have.
      const longTaskCeilingMs = process.platform === 'win32' ? 300 : 100;
      expect(results.every((result) => result.flood.maxLongTaskMs <= longTaskCeilingMs)).toBeTruthy();
      expect(results.every((result) => result.flood.medianGapMs <= 50.5)).toBeTruthy();
      expect(results.every((result) => result.scroll.p95GapMs <= 50.5)).toBeTruthy();
    }
  });
});
