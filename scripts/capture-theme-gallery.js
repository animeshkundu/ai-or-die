'use strict';

// Capture one screenshot per shipped theme, for PR review.
//
// Not part of the test matrix: this produces evidence, it does not assert
// anything. The visual-regression suite is the gate. This exists because a
// reviewer cannot tell from a diff whether seven palettes still render, and
// this branch both restored five of them and moved token values in all seven.
//
// Usage: node scripts/capture-theme-gallery.js [outDir]
//
// Default output is docs/design/theme-gallery. Note it is NOT a directory named
// `screenshots`: .gitignore ignores that name anywhere in the tree, so writing
// there would silently produce untrackable evidence.

const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../e2e/helpers/server-factory');
const { waitForAppReady } = require('../e2e/helpers/terminal-helpers');

// Derived from tokens.css so a theme added later is captured without editing
// this list; `midnight` is the default and carries no data-theme attribute.
function shippedThemes() {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'public', 'tokens.css'),
    'utf8'
  );
  const named = Array.from(
    new Set((css.match(/\[data-theme="([a-z-]+)"\]/g) || [])
      .map((s) => s.replace(/\[data-theme="|"\]/g, '')))
  );
  return ['midnight'].concat(named);
}

async function main() {
  const outDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, '..', 'docs', 'design', 'theme-gallery');
  fs.mkdirSync(outDir, { recursive: true });

  const themes = shippedThemes();
  const { server, port, url } = await createServer();
  const browser = await chromium.launch();

  try {
    await createSessionViaApi(port, 'Theme gallery');
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url);
    await waitForAppReady(page);

    for (const theme of themes) {
      await page.evaluate((name) => {
        if (name === 'midnight') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', name);
      }, theme);
      // Let the transition settle so the capture is not a half-applied palette.
      await page.waitForTimeout(250);
      const file = path.join(outDir, `theme-${theme}.png`);
      await page.screenshot({ path: file });
      process.stdout.write(`captured ${path.relative(process.cwd(), file)}\n`);
    }
  } finally {
    await browser.close();
    if (server) await server.close();
  }
}

main().catch((error) => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exit(1);
});
