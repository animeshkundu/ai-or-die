#!/usr/bin/env node
'use strict';

// Does opening the file browser occlude live terminal columns?
//
// _isOverlayMode() is `innerWidth <= 1024`, so on a desktop viewport the panel
// is NOT a modal overlay: no backdrop, background not inert, terminal still
// interactive. But _adjustTerminal() is a deliberate no-op whose comment claims
// non-terminal surfaces "overlay the terminal and never change its geometry".
//
// This measures the terminal container rect against the panel rect to find out
// how many columns are actually hidden behind the panel while still being
// rendered and written to.
//
// Usage: node scripts/probe-file-browser-geometry.js

const path = require('path');
const { chromium } = require('playwright');
const {
  createServer, createSessionViaApi,
} = require(path.join(__dirname, '..', 'e2e', 'helpers', 'server-factory'));
const {
  waitForAppReady, waitForTerminalCanvas, joinSessionAndStartTerminal,
} = require(path.join(__dirname, '..', 'e2e', 'helpers', 'terminal-helpers'));

const DESKTOP = { width: 1440, height: 900 };

async function snapshot(page) {
  return page.evaluate(() => {
    const term = window.app && window.app.terminal;
    const container = document.querySelector('.terminal-container');
    const panel = document.querySelector('.file-browser-panel')
      || document.querySelector('[class*="file-browser"][class*="panel"]');
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        x: Math.round(b.x), y: Math.round(b.y),
        w: Math.round(b.width), h: Math.round(b.height),
        position: cs.position, display: cs.display, visible: b.width > 0 && b.height > 0,
      };
    };
    return {
      cols: term ? term.cols : null,
      rows: term ? term.rows : null,
      container: r(container),
      panel: r(panel),
      innerWidth: window.innerWidth,
    };
  });
}

async function main() {
  const { server, port, url } = await createServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: DESKTOP });

  try {
    const sessionId = await createSessionViaApi(port, 'fb-geometry');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await page.waitForTimeout(1500);

    const before = await snapshot(page);
    console.log(`\nviewport ${DESKTOP.width}x${DESKTOP.height}  innerWidth=${before.innerWidth}`);
    console.log(`overlay mode (innerWidth <= 1024)? ${before.innerWidth <= 1024 ? 'YES' : 'NO -> docked panel'}`);
    console.log('\n--- BEFORE opening file browser ---');
    console.log(`  terminal  cols=${before.cols} rows=${before.rows}`);
    console.log(`  container ${JSON.stringify(before.container)}`);

    // Open the file browser through the app's own API.
    const opened = await page.evaluate(async () => {
      const app = window.app;
      if (!app) return 'no window.app';
      const fb = (typeof app._ensureFileBrowser === 'function')
        ? app._ensureFileBrowser()
        : app._fileBrowserPanel;
      if (!fb) return 'no file browser instance';
      try { await fb.open(); return 'ok'; } catch (e) { return 'open() failed: ' + e.message; }
    });
    console.log(`\n  open() -> ${opened}`);
    await page.waitForTimeout(2500);

    const after = await snapshot(page);
    console.log('\n--- AFTER opening file browser ---');
    console.log(`  terminal  cols=${after.cols} rows=${after.rows}`);
    console.log(`  container ${JSON.stringify(after.container)}`);
    console.log(`  panel     ${JSON.stringify(after.panel)}`);

    console.log('\n=== VERDICT ===');
    if (!after.panel || !after.panel.visible) {
      console.log('  panel not found/visible — could not measure. Selector may be wrong.');
    } else {
      const c = after.container;
      const p = after.panel;
      const overlapPx = Math.max(0, Math.min(c.x + c.w, p.x + p.w) - Math.max(c.x, p.x));
      const cellW = c.w / (before.cols || 1);
      const hiddenCols = Math.round(overlapPx / cellW);
      console.log(`  terminal cols: ${before.cols} -> ${after.cols}  (${before.cols === after.cols ? 'UNCHANGED' : 'refit'})`);
      console.log(`  horizontal overlap panel/terminal: ${overlapPx}px  ~= ${hiddenCols} columns`);
      if (before.cols === after.cols && overlapPx > 0) {
        console.log(`\n  DEFECT: the terminal still renders ${after.cols} columns, but ~${hiddenCols} of them`);
        console.log('  are covered by the panel. Output written there is invisible while the');
        console.log('  terminal remains interactive and the PTY keeps its full width.');
      } else if (before.cols !== after.cols) {
        console.log('\n  OK: the terminal refit to the reduced area.');
      } else {
        console.log('\n  OK: no overlap — panel does not cover the terminal.');
      }
    }
    console.log('');
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
