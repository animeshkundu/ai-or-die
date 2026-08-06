'use strict';

// AC-9 / AC-10 (Part B): accessibility and visual evidence, in BOTH themes.
//
// The static audit (test/design-system-audit.test.js) derives token pairs from
// authored CSS. That catches a badly chosen pair at source, but it cannot see
// the cascade: an override, a specificity accident, or an inherited colour can
// produce a rendered combination no single rule declares. This measures what
// the browser actually painted.
//
// It also captures the light theme, which the existing visual gate never
// exercised — and light is where the token corrections landed.

const { test, expect } = require('@playwright/test');
const { waitForAppReady, waitForTerminalCanvas } = require('../helpers/terminal-helpers');
const { createServer } = require('../helpers/server-factory');

const THEMES = ['dark', 'light'];

test.describe('AC-9 rendered accessibility', () => {
  let server; let url;

  test.beforeAll(async () => { ({ server, url } = await createServer()); });
  test.afterAll(async () => { if (server) await server.close().catch(() => {}); });

  for (const theme of THEMES) {
    test(`${theme}: rendered text meets WCAG AA against its painted background`, async ({ page }) => {
      await page.goto(url);
      await waitForAppReady(page);
      await waitForTerminalCanvas(page);
      await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
      await page.waitForTimeout(400);

      const failures = await page.evaluate(() => {
        const parse = (s) => {
          const m = String(s).match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/);
          if (!m) return null;
          const c = [1, 2, 3].map((i) => Math.round(parseFloat(m[i])));
          c.a = m[4] === undefined ? 1 : parseFloat(m[4]);
          return c;
        };
        const lum = (c) => {
          const [r, g, b] = c.map((v) => {
            const x = v / 255;
            return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (a, b) => {
          const la = lum(a); const lb = lum(b);
          return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
        };
        // Walk up for the first opaque painted background, which is what the
        // text is actually read against.
        const backdrop = (el) => {
          let node = el;
          while (node && node !== document.documentElement) {
            const bg = parse(getComputedStyle(node).backgroundColor);
            if (bg && bg.a >= 0.95) return bg;
            node = node.parentElement;
          }
          const rootBg = parse(getComputedStyle(document.body).backgroundColor);
          return rootBg && rootBg.a >= 0.95 ? rootBg : [0, 0, 0];
        };

        const out = [];
        const seen = new Set();
        for (const el of document.querySelectorAll('button, a, label, h1, h2, h3, p, span, li')) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
          const text = (el.textContent || '').trim();
          if (!text || el.children.length > 0) continue; // leaf text only

          const fg = parse(cs.color);
          if (!fg || fg.a < 0.5) continue;
          const bg = backdrop(el);
          const r = ratio(fg, bg);

          // WCAG AA: 3.0 for large text (>=24px, or >=18.66px bold), else 4.5.
          const size = parseFloat(cs.fontSize) || 16;
          const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
          const min = (size >= 24 || (bold && size >= 18.66)) ? 3.0 : 4.5;
          if (r >= min) continue;

          const key = `${cs.color}|${text.slice(0, 24)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(`"${text.slice(0, 34)}" ${cs.color} on rgb(${bg.join(',')}) = ${r.toFixed(2)} (needs ${min})`);
        }
        return out;
      });

      expect(failures, `rendered contrast failures in ${theme}:\n${failures.join('\n')}`).toEqual([]);
    });

    test(`${theme}: interactive controls meet the touch target minimum`, async ({ page }) => {
      await page.goto(url);
      await waitForAppReady(page);
      await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
      await page.waitForTimeout(300);

      const small = await page.evaluate(() => {
        // WCAG 2.2 AA (2.5.8 Target Size Minimum) is 24px and applies
        // everywhere. 44px is the touch figure (--hit-target-min) and is what
        // this client targets where the input is a finger. Asserting 44 against
        // a mouse-driven desktop would be the wrong standard, so the threshold
        // follows the input modality rather than being one global number.
        const touch = matchMedia('(pointer: coarse)').matches
          || navigator.maxTouchPoints > 0
          || window.innerWidth <= 1024;
        const tokenMin = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--hit-target-min')
        ) || 44;
        const min = touch ? tokenMin : 24;
        const out = [];
        for (const el of document.querySelectorAll('button, [role="button"], a[href]')) {
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue; // hidden
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          // Inline links in prose are exempt; this targets discrete controls.
          if (el.tagName === 'A' && cs.display.startsWith('inline')) continue;
          if (r.width + 0.5 < min || r.height + 0.5 < min) {
            out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ${Math.round(r.width)}x${Math.round(r.height)} (min ${min})`);
          }
        }
        return { min, touch, offenders: out };
      });

      console.log(`[AC-9 ${theme}] modality=${small.touch ? 'touch' : 'pointer'} min=${small.min}px offenders=${small.offenders.length}`);
      if (small.offenders.length) console.log(small.offenders.slice(0, 12).join('\n'));
      expect(small.offenders,
        `controls below the ${small.min}px target size:\n${small.offenders.join('\n')}`).toEqual([]);
    });
  }
});
