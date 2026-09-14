'use strict';

// Mouse reporting: accuracy under the presentation transform + wire-rate gates.
//
// C1 measurement (plan): xterm encodes pointer position from its own layout,
// but the client presents non-owner grids through a transform on the inner
// stage. This spec measures end-to-end what cell the TUI is told was clicked:
// a real browser click at the drawn position of a target cell, decoded from
// the SGR report xterm emits. Exact regime is the control (must match);
// pan/scale (phone-width second viewer on a desktop-owned session) is the
// measurement that scopes the coordinate-correction work.
//
// Rate gate: a sustained drag must not exceed ~30 input WS messages/s
// (motion compression + 33ms floor), while every button edge still arrives.

const { test, expect } = require('@playwright/test');
const {
  waitForAppReady, waitForTerminalCanvas, joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');

const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

function lastPress(reports) {
  const all = [];
  let m;
  const re = new RegExp(SGR_RE.source, 'g');
  for (const chunk of reports) {
    while ((m = re.exec(chunk)) !== null) {
      if (m[4] === 'M') all.push({ cb: Number(m[1]), col: Number(m[2]), row: Number(m[3]) });
    }
  }
  return all.length ? all[all.length - 1] : null;
}

async function enableMouseProbe(page) {
  await page.evaluate(() => {
    window.__mouseProbe = [];
    // SGR (1006) + basic tracking (1000): press/release reports.
    window.app.terminal.write('\x1b[?1000h\x1b[?1006h');
    window.app.terminal.onData((d) => window.__mouseProbe.push(d));
  });
}

async function probeReports(page) {
  return page.evaluate(() => (window.__mouseProbe || []).slice());
}

async function presentationState(page) {
  return page.evaluate(() => {
    const P = window.TerminalPresentation;
    const outerEl = document.querySelector('.terminal-wrapper');
    const term = window.app && window.app.terminal;
    if (!P || !outerEl || !term) return { error: 'missing module/wrapper/terminal' };
    const dims = term._core && term._core._renderService && term._core._renderService.dimensions;
    const cell = dims && dims.css && dims.css.cell;
    if (!cell || !(cell.width > 0)) return { error: 'cell metric unavailable' };
    // Stage origin in client coords WITHOUT the presentation transform:
    // offsetLeft/offsetTop are layout (untransformed); getBoundingClientRect
    // would double-count scale/translate. xterm's grid starts at the stage
    // origin (not the wrapper origin — wrapper may carry padding/chrome),
    // plus the screen element's layout inset inside the stage (xterm
    // hit-tests against .xterm-screen; verified by calibration sweep).
    // Both are derived from offsetParent chains in layout space, never from
    // transform-aware rects.
    const stage = document.getElementById('terminal');
    const outerRect = outerEl.getBoundingClientRect();
    const screenEl = document.querySelector('.xterm-screen');
    const offsetWithin = (el, ancestor) => {
      let x = 0; let y = 0; let cur = el; let ok = false;
      while (cur) {
        if (cur === ancestor) { ok = true; break; }
        x += cur.offsetLeft || 0;
        y += cur.offsetTop || 0;
        cur = cur.offsetParent;
      }
      return ok ? { x, y } : null;
    };
    const absOffset = (el) => {
      let x = 0; let y = 0; let cur = el;
      while (cur) {
        x += cur.offsetLeft || 0;
        y += cur.offsetTop || 0;
        cur = cur.offsetParent;
      }
      return { x, y };
    };
    const stageInWrapper = (stage && offsetWithin(stage, outerEl)) || { x: 0, y: 0 };
    let inset = { x: 0, y: 0 };
    if (stage && screenEl) {
      const sAbs = absOffset(screenEl);
      const tAbs = absOffset(stage);
      inset = { x: sAbs.x - tAbs.x, y: sAbs.y - tAbs.y };
    }
    const pres = window.app._geometryPresentation || null;
    // Stage layout size (untransformed): the painted stage box is
    // origin + size*scale, CLIPPED by overflow — content outside it is not
    // hittable even when the grid extends further (measured: 144-col grid
    // painted, only ~25 cols inside the clipped stage box).
    const stageLayout = stage
      ? { w: stage.offsetWidth || 0, h: stage.offsetHeight || 0 }
      : { w: outerRect.width, h: outerRect.height };
    return {
      regime: pres ? pres.regime : 'exact',
      scale: pres ? pres.scale : 1,
      offsetX: pres ? pres.offsetX : 0,
      offsetY: pres ? pres.offsetY : 0,
      outer: { width: outerRect.width, height: outerRect.height },
      stage: { x: outerRect.x + stageInWrapper.x, y: outerRect.y + stageInWrapper.y },
      stageLayout,
      inset,
      cell: { width: cell.width, height: cell.height },
      cols: term.cols,
      rows: term.rows,
    };
  });
}

// Client point (viewport coords) for the center of a grid cell: invert the
// presentation exactly the way pointerToCell maps it forward, anchored at
// the untransformed stage origin plus the screen inset where xterm's grid
// actually starts.
function clientPointForCell(st, col, row) {
  return {
    x: st.stage.x + ((col + 0.5) * st.cell.width + st.inset.x) * st.scale - st.offsetX,
    y: st.stage.y + ((row + 0.5) * st.cell.height + st.inset.y) * st.scale - st.offsetY,
  };
}

test.describe('mouse reporting accuracy and rate', () => {
  let server; let port; let url;

  test.beforeAll(async () => {
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close().catch(() => {});
  });

  test('click reports the drawn cell in the exact regime (desktop control)', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'mouse-exact');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await page.waitForTimeout(1000);
    await enableMouseProbe(page);

    const st = await presentationState(page);
    expect(st.error).toBeUndefined();
    expect(st.regime).toBe('exact');

    const targets = [
      { col: 5, row: 5 },
      { col: 20, row: 10 },
      { col: Math.max(5, st.cols - 10), row: Math.max(5, st.rows - 6) },
    ];
    const mismatches = [];
    for (const t of targets) {
      // Recompute geometry per click AND discard the previous click's SGR
      // bytes from the shell line: unhandled reports are typed into zsh,
      // echo/wrap new lines, scroll the viewport, and stale the next
      // click's coordinates. Ctrl-C discards the line without output.
      const fresh = await presentationState(page);
      if (fresh.error) {
        mismatches.push({ want: { col: t.col + 1, row: t.row + 1 }, got: { error: fresh.error } });
        continue;
      }
      await page.evaluate(() => { window.__mouseProbe = []; });
      const pt = clientPointForCell(fresh, t.col, t.row);
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(300);
      const hit = lastPress(await probeReports(page));
      await page.keyboard.press('Control+C');
      await page.waitForTimeout(200);
      if (!hit || hit.col !== t.col + 1 || hit.row !== t.row + 1) {
        mismatches.push({ want: { col: t.col + 1, row: t.row + 1 }, got: hit });
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('click reports the drawn cell under pan/scale (narrow second viewer)', async ({ page, browser }) => {
    const sessionId = await createSessionViaApi(port, 'mouse-pan');
    // Owner on the wide desktop viewport: authoritative grid stays wide.
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await page.waitForTimeout(1000);

    // Narrow second viewer on the same session: non-owner presentation.
    const ctx = await browser.newContext({ viewport: { width: 420, height: 800 } });
    const narrow = await ctx.newPage();
    try {
      await narrow.goto(url);
      await waitForAppReady(narrow);
      await waitForTerminalCanvas(narrow);
      await narrow.evaluate(async (sid) => {
        await window.app.joinSession(sid);
      }, sessionId);
      await narrow.waitForTimeout(1500);

      const st = await presentationState(narrow);
      expect(st.error).toBeUndefined();
      // Vacuous guard: if the grid fits, nothing is under test.
      expect(
        st.regime !== 'exact',
        `expected a pan/scale regime on the narrow viewer, got exact (${st.cols}x${st.rows})`
      ).toBe(true);

      await enableMouseProbe(narrow);
      await narrow.evaluate(() => { window.__pointerCorrectionDebug = []; });
      // Hide floating toolbar chrome over the grid for the probe clicks:
      // a covered point would hit overlay DOM instead of terminal content
      // (correctly left unmapped). Toolbar behavior itself is covered by
      // the geometry specs; here we measure grid reporting only.
      await narrow.evaluate(() => {
        const btn = document.getElementById('fitScreenBtn');
        if (btn) btn.style.display = 'none';
      });
      // NOTE on ownership: every click (press+release) is an action batch
      // (claim:true), so each probe click deliberately transfers geometry
      // ownership to the narrow page (by design). Reclaim from the owner
      // page after every probe and re-verify the pan regime before the next
      // one; otherwise the PTY resizes to the narrow grid and later probes
      // click off-viewport. Reclaim sends claim:true input straight through
      // app.send (not keyboard) so it cannot miss on focus.
      const reclaimOwner = async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await page.evaluate(() => {
            window.app.send({ type: 'input', data: '\x03', claim: true, viewId: 'main' });
          });
          await narrow.waitForTimeout(1500);
          const check = await presentationState(narrow);
          if (!check.error && check.regime !== 'exact') return true;
        }
        return false;
      };

      // In pan/scale only a window of the grid is on screen, and the pan
      // offset moves between probes (reclaim resizes/repans). So every probe
      // re-reads fresh state, derives the visible window from it (2-cell
      // margin from all painted edges — viewport scroll and fractional
      // edges make edge cells unreliable probe targets), and targets the
      // visible-center cell.
      const mismatches = [];
      for (let probe = 0; probe < 2; probe++) {
        const fresh = await presentationState(narrow);
        if (fresh.error || fresh.regime === 'exact') {
          mismatches.push({ probe, got: { error: fresh.error || 'lost pan regime (owner not reclaimed?)' } });
          await reclaimOwner();
          continue;
        }
        const fs = fresh.scale || 1;
        // Visible window in grid cells: the painted stage box (origin +
        // layout-size*scale) clipped to the viewport — content outside it is
        // not hittable even when the grid extends further (overflow clip).
        // Intersect, convert to grid cells, apply a 2-cell margin.
        const boxL = fresh.stage.x + (0 * fs - fresh.offsetX);
        const boxT = fresh.stage.y + (0 * fs - fresh.offsetY);
        const boxR = fresh.stage.x + (fresh.stageLayout.w * fs - fresh.offsetX);
        const boxB = fresh.stage.y + (fresh.stageLayout.h * fs - fresh.offsetY);
        const visL = Math.max(fresh.stage.x, boxL);
        const visT = Math.max(fresh.stage.y, boxT);
        const visR = Math.min(fresh.stage.x + fresh.outer.width, boxR);
        const visB = Math.min(fresh.stage.y + fresh.outer.height, boxB);
        const toGridX = (cx) => (cx - fresh.stage.x + fresh.offsetX) / fs - fresh.inset.x;
        const toGridY = (cy) => (cy - fresh.stage.y + fresh.offsetY) / fs - fresh.inset.y;
        const visCol0 = Math.ceil(toGridX(visL) / fresh.cell.width) + 2;
        const visCol1 = Math.floor(toGridX(visR) / fresh.cell.width) - 2;
        const visRow0 = Math.ceil(toGridY(visT) / fresh.cell.height) + 2;
        const visRow1 = Math.floor(toGridY(visB) / fresh.cell.height) - 2;
        const t = {
          col: Math.floor((visCol0 + visCol1) / 2),
          row: Math.floor((visRow0 + visRow1) / 2),
        };
        await narrow.evaluate(() => { window.__mouseProbe = []; });
        const pt = clientPointForCell(fresh, t.col, t.row);
        // Rig validity: the click point must be over grid content, not
        // overlay chrome (which is correctly left unmapped). A miss here
        // is a bad probe target, not a product failure.
        const underTop = await narrow.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return null;
          let cur = el;
          while (cur) {
            if (cur.classList && cur.classList.contains('xterm-screen')) return 'xterm-screen';
            cur = cur.parentElement;
          }
          return (el.tagName || '?') + '.' + (el.className || '');
        }, pt);
        if (underTop !== 'xterm-screen') {
          mismatches.push({ probe, got: { error: `probe point not over grid content (top: ${underTop})` } });
          await reclaimOwner();
          continue;
        }
        await narrow.mouse.click(pt.x, pt.y);
        await narrow.waitForTimeout(300);
        const raw = await probeReports(narrow);
        const corr = await narrow.evaluate(() => (
          window.PointerCorrection ? window.PointerCorrection.takeStats().corrected : -1
        ));
        const hit = lastPress(raw);
        expect(corr, 'pointer correction must engage in pan regime').toBeGreaterThan(0);
        // Corrected clicks must still focus the terminal (xterm focuses
        // explicitly in its mousedown handler): keyboard input afterwards
        // must reach the PTY, not nowhere.
        const focused = await narrow.evaluate(() => {
          const ae = document.activeElement;
          return !!(ae && ae.classList && ae.classList.contains('xterm-helper-textarea'));
        });
        expect(focused, 'corrected click must focus the terminal').toBe(true);
        await narrow.keyboard.press('Control+C');
        await narrow.waitForTimeout(200);
        if (!hit || hit.col !== t.col + 1 || hit.row !== t.row + 1) {
          mismatches.push({ want: { col: t.col + 1, row: t.row + 1 }, got: hit });
        }
        await reclaimOwner();
      }
      expect(mismatches, `SGR reports must name the drawn cell (regime=${st.regime}, scale=${st.scale})`).toEqual([]);
    } finally {
      await ctx.close().catch(() => {});
    }
  });

  test('split-pane drag stays within the motion wire-rate budget', async ({ page }) => {
    // Pre-fix, split panes sent one WS message per mouse event (no
    // coalescing): a drag is 100+ msgs/s. Post-fix they share the main
    // terminal's rAF buffer + motion floor. This test fails pre-fix.
    const left = await createSessionViaApi(port, 'mouse-split-left');
    const right = await createSessionViaApi(port, 'mouse-split-right');
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, left);
    const opened = await page.evaluate(async (rightId) => {
      const sc = window.app && window.app.splitContainer;
      if (!sc || typeof sc.createSplit !== 'function') return { error: 'no splitContainer' };
      await sc.createSplit(rightId);
      return { enabled: sc.enabled === true };
    }, right);
    expect(opened.error).toBeUndefined();
    expect(opened.enabled).toBe(true);
    await page.waitForTimeout(2000);

    const ready = await page.evaluate(() => {
      const sc = window.app.splitContainer;
      const pane = sc && sc.splits && sc.splits[1];
      if (!pane || !pane.terminal || !pane.socket || pane.socket.readyState !== 1) {
        return { error: 'right pane has no live socket' };
      }
      pane.terminal.write('\x1b[?1002h\x1b[?1006h');
      window.__splitInputCount = 0;
      const sock = pane.socket;
      const origSend = sock.send.bind(sock);
      sock.send = (payload) => {
        try {
          if (typeof payload === 'string' && payload.includes('"input"')) window.__splitInputCount++;
        } catch (_) { /* ignore */
        }
        return origSend(payload);
      };
      const el = document.getElementById('split-terminal-1');
      if (!el) return { error: 'no split pane element' };
      const r = el.getBoundingClientRect();
      return { origin: { x: r.x, y: r.y, w: r.width, h: r.height } };
    });
    expect(ready.error).toBeUndefined();

    const ox = ready.origin.x + 40;
    const oy = ready.origin.y + 100;
    // Real press to put xterm into drag state, then a synthetic burst:
    // 300 drag moves dispatched as fast as the page can run them. Pre-fix
    // each move is its own WS message (~300); post-fix the rAF buffer +
    // motion compression + 33ms floor collapse them to a handful.
    await page.mouse.move(ox, oy);
    await page.mouse.down();
    await page.evaluate(() => { window.__splitInputCount = 0; window.__splitT0 = performance.now(); });
    await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      for (let i = 0; i < 300; i++) {
        el.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, cancelable: true,
          clientX: x + i, clientY: y + (i % 5),
          buttons: 1, button: 0,
        }));
      }
    }, { x: ox, y: oy });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const { count, elapsedMs } = await page.evaluate(() => ({
      count: window.__splitInputCount,
      elapsedMs: performance.now() - window.__splitT0,
    }));
    const perSecond = (count / Math.max(1, elapsedMs)) * 1000;
    // A 300-move burst must collapse to a handful of messages (motion
    // compression + 33ms floor); pre-fix it is ~300. Generous absolute cap
    // rather than a rate, since the burst is near-instantaneous.
    expect(count, `split drag burst produced ${count} input msgs`).toBeLessThanOrEqual(20);
    expect(perSecond, `split drag wire rate ${perSecond.toFixed(1)}/s`).toBeLessThanOrEqual(45);
  });

  test('sustained drag stays within the motion wire-rate budget', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'mouse-rate');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await page.waitForTimeout(1000);
    // Drag-motion tracking (1002) + SGR so every move is reported.
    await page.evaluate(() => {
      window.app.terminal.write('\x1b[?1002h\x1b[?1006h');
      window.__inputCount = 0;
      const origSend = window.app.send.bind(window.app);
      window.app.send = (msg) => {
        if (msg && msg.type === 'input') window.__inputCount++;
        return origSend(msg);
      };
    });

    const st = await presentationState(page);
    expect(st.error).toBeUndefined();
    const start = clientPointForCell(st, 5, 5);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.evaluate(() => { window.__inputCount = 0; window.__dragT0 = performance.now(); });
    // ~2s continuous drag across the grid.
    for (let i = 0; i < 40; i++) {
      await page.mouse.move(start.x + i * 8, start.y + (i % 5), { steps: 2 });
    }
    await page.mouse.up();
    await page.waitForTimeout(500);
    const { count, elapsedMs } = await page.evaluate(() => ({
      count: window.__inputCount,
      elapsedMs: performance.now() - window.__dragT0,
    }));
    const perSecond = (count / Math.max(1, elapsedMs)) * 1000;
    // Budget: ~30Hz motion cap with headroom for edges + CI timer slop.
    // Pre-compression main-terminal behavior is ~60+/s; splits were unbounded.
    expect(perSecond, `drag wire rate ${perSecond.toFixed(1)}/s over ${count} msgs`).toBeLessThanOrEqual(45);
  });
});
