#!/usr/bin/env node
'use strict';

// Generate branded iOS PWA splash screens (apple-touch-startup-image) and the
// manifest screenshot PNGs, rasterizing a branded SVG with the Playwright
// Chromium that already ships as a dev dependency (no new runtime dep — same
// approach as scripts/generate-pwa-icons.js).
//
// Regenerate after changing the art:
//   node scripts/gen-splash.js
//
// Splash targets cover the two primary devices (Edge on iOS = WebKit, ADR-0037):
//   iPhone 16      393x852 @3x  -> 1179x2556 (portrait) / 2556x1179 (landscape)
//   iPad (gen 11)  820x1180 @2x -> 1640x2360 (portrait) / 2360x1640 (landscape)

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const OUT_DIR = path.join(__dirname, '..', 'src', 'public');
const SPLASH_DIR = path.join(OUT_DIR, 'splash');

const BG = '#161b22';       // matches manifest background_color / theme_color
const ACCENT = '#ff6b00';   // brand orange (matches the icon art)

const SPLASH = [
  { name: 'iphone16-portrait', w: 1179, h: 2556 },
  { name: 'iphone16-landscape', w: 2556, h: 1179 },
  { name: 'ipad11-portrait', w: 1640, h: 2360 },
  { name: 'ipad11-landscape', w: 2360, h: 1640 },
];

const SCREENSHOTS = [
  { name: 'screenshot-wide', w: 1280, h: 720, sub: 'Universal AI coding terminal' },
  { name: 'screenshot-narrow', w: 540, h: 720, sub: 'Universal AI coding terminal' },
];

// The brand mark (brain arcs + ">_" terminal glyph), viewBox 0..100, from the
// icon art so splash and icon read as the same brand.
function markSvg() {
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" width="160" height="160">
    <path d="M50 18 C28 18 18 32 18 48 C18 58 24 66 32 70 L32 74 C32 78 36 80 40 78 L44 76"
          fill="none" stroke="${ACCENT}" stroke-width="3.5" stroke-linecap="round" opacity="0.6"/>
    <path d="M50 18 C72 18 82 32 82 48 C82 58 76 66 68 70 L68 74 C68 78 64 80 60 78 L56 76"
          fill="none" stroke="${ACCENT}" stroke-width="3.5" stroke-linecap="round" opacity="0.6"/>
    <circle cx="38" cy="38" r="3" fill="${ACCENT}" opacity="0.5"/>
    <circle cx="62" cy="38" r="3" fill="${ACCENT}" opacity="0.5"/>
    <circle cx="50" cy="28" r="2.5" fill="${ACCENT}" opacity="0.4"/>
    <text x="50" y="62" text-anchor="middle" dominant-baseline="middle"
          font-family="monospace" font-size="28" font-weight="700" fill="${ACCENT}">&gt;_</text>
  </svg>`;
}

function pageHtml(w, h, sub) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden}
    .wrap{width:${w}px;height:${h}px;background:${BG};display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:24px;font-family:ui-monospace,monospace}
    .word{color:${ACCENT};font-size:${Math.round(Math.min(w, h) * 0.06)}px;font-weight:700;letter-spacing:0.04em}
    .sub{color:#8b949e;font-size:${Math.round(Math.min(w, h) * 0.028)}px}
  </style></head><body><div class="wrap">
    ${markSvg()}
    <div class="word">ai-or-die</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </div></body></html>`;
}

async function render(browser, w, h, sub, outPath) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(pageHtml(w, h, sub), { waitUntil: 'load' });
  const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: w, height: h } });
  fs.writeFileSync(outPath, buf);
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) {
    throw new Error(`generated ${outPath} is not a PNG`);
  }
  console.log(`wrote ${outPath} (${w}x${h}, ${buf.length} bytes)`);
  await page.close();
}

async function main() {
  if (!fs.existsSync(SPLASH_DIR)) fs.mkdirSync(SPLASH_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const s of SPLASH) {
      await render(browser, s.w, s.h, null, path.join(SPLASH_DIR, `${s.name}.png`));
    }
    for (const s of SCREENSHOTS) {
      await render(browser, s.w, s.h, s.sub, path.join(OUT_DIR, `${s.name}.png`));
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
