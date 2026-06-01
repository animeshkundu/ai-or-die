#!/usr/bin/env node
'use strict';

// Generate the static PWA icon PNGs from the ai-or-die brain/terminal SVG.
//
// Why static PNGs: the manifest declares icons as `image/png`. Serving SVG bytes
// under a `.png` name (the previous dynamic route) is a MIME/content mismatch that
// some installability checks and iOS `apple-touch-icon` reject. These files are the
// source of truth served by express.static at `/icon-<size>.png`.
//
// Regenerate after changing the icon art:
//   node scripts/generate-pwa-icons.js
//
// Uses the Playwright Chromium that already ships as a dev dependency to rasterize
// the SVG — no new runtime dependency is added.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const SIZES = [16, 32, 144, 180, 192, 512];
const OUT_DIR = path.join(__dirname, '..', 'src', 'public');

// Mirrors the art previously rendered inline in src/server.js. viewBox is fixed at
// 0..100 so it scales cleanly to any pixel size.
function svgFor(size) {
  const r = size * 0.1;
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <rect width="100" height="100" fill="#1a1a1a" rx="${r > 1 ? 10 : 0}"/>
    <path d="M50 18 C28 18 18 32 18 48 C18 58 24 66 32 70 L32 74 C32 78 36 80 40 78 L44 76"
          fill="none" stroke="#ff6b00" stroke-width="3.5" stroke-linecap="round" opacity="0.6"/>
    <path d="M50 18 C72 18 82 32 82 48 C82 58 76 66 68 70 L68 74 C68 78 64 80 60 78 L56 76"
          fill="none" stroke="#ff6b00" stroke-width="3.5" stroke-linecap="round" opacity="0.6"/>
    <circle cx="38" cy="38" r="3" fill="#ff6b00" opacity="0.5"/>
    <circle cx="62" cy="38" r="3" fill="#ff6b00" opacity="0.5"/>
    <circle cx="50" cy="28" r="2.5" fill="#ff6b00" opacity="0.4"/>
    <text x="50" y="62" text-anchor="middle" dominant-baseline="middle"
          font-family="monospace" font-size="28" font-weight="700" fill="#ff6b00">&gt;_</text>
  </svg>`;
}

async function main() {
  const browser = await chromium.launch();
  try {
    for (const size of SIZES) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      const html = `<!doctype html><html><head><meta charset="utf-8">
        <style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden}</style>
        </head><body>${svgFor(size)}</body></html>`;
      await page.setContent(html, { waitUntil: 'load' });
      const el = await page.$('svg');
      const buf = await el.screenshot({ type: 'png', omitBackground: false });
      const out = path.join(OUT_DIR, `icon-${size}.png`);
      fs.writeFileSync(out, buf);
      // Sanity: PNG signature.
      if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) {
        throw new Error(`generated ${out} is not a PNG`);
      }
      console.log(`wrote ${out} (${buf.length} bytes)`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('icon generation failed:', err.message);
  process.exit(1);
});
