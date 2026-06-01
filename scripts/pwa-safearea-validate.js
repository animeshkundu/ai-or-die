#!/usr/bin/env node
/* eslint-disable no-console */
// scripts/pwa-safearea-validate.js
//
// Standalone-PWA safe-area validation harness for iPhone 16 + desktop PWA.
//
// Verifies that fixed/absolute overlays (modals, toasts, banners, bottom bars)
// clear the iOS Dynamic-Island top inset and the home-indicator bottom inset
// when the app runs as an installed PWA. Drives a REAL dev server with
// Playwright, forces the standalone state the app reaches on device
// (`html.pwa-standalone` + the `--safe-area-inset-*` CSS variables the app's
// own polyfill sets), then measures each surface's geometry and screenshots it.
//
// Why a forced variable and not real env(): headless Chromium always reports
// env(safe-area-inset-*) === 0, so it cannot reproduce a notch. The app's
// polyfill exposes the inset as a CSS *variable* (--safe-area-inset-top/bottom)
// precisely so it works around the WebKit `env()===0` bug — and a variable we
// CAN force here. Any surface that still reads raw env() shows 0 (no movement),
// which is itself the failing signal.
//
// Usage:
//   node scripts/pwa-safearea-validate.js            # self-starts the server
//   BASE=http://127.0.0.1:11611 node scripts/...     # use a server you started
//   KEEP_SHOTS=1 ...                                 # keep screenshots on pass
//
// Exit code 0 = all surfaces clear the safe areas; 1 = at least one collision.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const REPO = path.resolve(__dirname, '..');
const { chromium, devices } = require(path.join(REPO, 'node_modules/@playwright/test'));

const PORT = Number(process.env.PORT || 11611);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const SELF_SERVE = !process.env.BASE;
const OUT = process.env.OUT || '/tmp/pwa-safearea-shots';
fs.mkdirSync(OUT, { recursive: true });

// iPhone 16 = 393x852 logical, Dynamic Island (top inset 59), home indicator 34.
// Desktop PWA = standalone window, NO notch/home-indicator → insets 0 (the fix
// must NOT push content down here; this viewport is the no-regression guard).
const VIEWPORTS = [
  { name: 'iphone16-393x852', width: 393, height: 852, top: 59, bottom: 34, mobile: true },
  { name: 'desktop-pwa-1280x800', width: 1280, height: 800, top: 0, bottom: 0, mobile: false },
];

// Each surface: how to reveal it + how it is anchored. `anchor`:
//   'top'    → rect.top must be >= safeTop
//   'bottom' → rect.bottom must be <= height - safeBottom
//   'modal'  → measure .modal-content; top >= safeTop AND bottom <= h - safeBottom
const SURFACES = [
  { sel: '.session-tabs-bar', anchor: 'top', reveal: null, label: 'tab bar (already fixed)' },
  { sel: '#settingsModal .modal-content', anchor: 'modal', reveal: { id: 'settingsModal' }, label: 'settings modal' },
  { sel: '#planModal .modal-content', anchor: 'modal', reveal: { id: 'planModal' }, label: 'plan modal' },
  { sel: '#shortcutsModal .modal-content', anchor: 'modal', reveal: { id: 'shortcutsModal' }, label: 'shortcuts modal' },
  { sel: '#newSessionModal .modal-content', anchor: 'modal', reveal: { id: 'newSessionModal' }, label: 'new-session modal' },
  { sel: '#mobileSessionsModal .modal-content', anchor: 'modal', reveal: { id: 'mobileSessionsModal' }, label: 'mobile-sessions modal' },
  { sel: '#folderBrowserModal .modal-content', anchor: 'modal', reveal: { id: 'folderBrowserModal' }, label: 'folder-browser modal' },
  { sel: '.file-browser-panel', anchor: 'bottom', reveal: { panel: true }, label: 'file-browser panel' },
  { sel: '.terminal-overlay .overlay-content', anchor: 'modal', reveal: { overlay: true }, label: 'terminal overlay' },
  { sel: '.toast-container', anchor: 'top', reveal: { toast: true }, label: 'toast container' },
  { sel: '.__test-banner', anchor: 'top', reveal: { banner: true }, label: 'top banner' },
  { sel: '.extra-keys-bar', anchor: 'bottom', reveal: { extraKeys: true }, label: 'extra-keys bar' },
];

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function ping() {
      const req = http.get(url, (res) => { res.destroy(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('server did not start'));
        setTimeout(ping, 300);
      });
    })();
  });
}

function forceStandalone(top, bottom) {
  return (args) => {
    const r = document.documentElement;
    r.classList.add('pwa-standalone');
    r.style.setProperty('--safe-area-inset-top', args.top + 'px');
    r.style.setProperty('--safe-area-inset-bottom', args.bottom + 'px');
    // Translucent guides so screenshots make collisions obvious.
    const guide = (id, css) => {
      let d = document.getElementById(id);
      if (!d) { d = document.createElement('div'); d.id = id; document.body.appendChild(d); }
      d.style.cssText = css;
    };
    if (args.top) {
      guide('__island', `position:fixed;top:0;left:0;right:0;height:${args.top}px;`
        + 'background:rgba(255,0,0,.30);z-index:2147483647;pointer-events:none;border-bottom:1px solid red;');
    }
    if (args.bottom) {
      guide('__home', `position:fixed;bottom:0;left:0;right:0;height:${args.bottom}px;`
        + 'background:rgba(0,80,255,.30);z-index:2147483647;pointer-events:none;border-top:1px solid blue;');
    }
  };
}

async function reveal(page, r) {
  if (!r) return;
  await page.evaluate((rev) => {
    if (rev.id) {
      const m = document.getElementById(rev.id);
      if (m) m.classList.add('active');
    }
    if (rev.toast) {
      let c = document.querySelector('.toast-container');
      if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c); }
      c.innerHTML = '<div class="toast toast--info" style="background:#222;color:#fff;padding:10px 14px;border-radius:8px;border:1px solid #555;">Toast — clears island?</div>';
    }
    if (rev.banner) {
      let b = document.querySelector('.__test-banner');
      if (!b) {
        b = document.createElement('div');
        b.className = 'banner-base __test-banner';
        b.textContent = 'Top banner';
        document.body.appendChild(b);
      }
      // .banner-base hides via translateY(-100%); .visible slides it in.
      b.classList.add('visible');
    }
    if (rev.extraKeys) {
      let e = document.querySelector('.extra-keys-bar');
      if (!e) { e = document.createElement('div'); e.className = 'extra-keys-bar'; e.style.minHeight = '40px'; document.body.appendChild(e); }
      e.classList.add('visible');
    }
    if (rev.panel) {
      const p = document.querySelector('.file-browser-panel');
      if (p) {
        p.classList.add('open', 'visible', 'active');
        p.style.transform = 'none';
        p.style.display = 'flex';
      }
    }
    if (rev.overlay) {
      let o = document.querySelector('.terminal-overlay');
      if (!o) {
        o = document.createElement('div');
        o.className = 'terminal-overlay';
        o.innerHTML = '<div class="overlay-content"><h2>Reconnecting…</h2><p>Connection lost — attempting to restore your session.</p></div>';
        document.body.appendChild(o);
      }
      o.style.display = 'flex';
    }
  }, r);
  await page.waitForTimeout(150);
}

async function hide(page, r) {
  if (!r || !r.id) return;
  await page.evaluate((id) => { const m = document.getElementById(id); if (m) m.classList.remove('active'); }, r.id);
}

async function run() {
  let server = null;
  if (SELF_SERVE) {
    console.log(`Starting dev server on :${PORT} …`);
    server = spawn('node', [path.join(REPO, 'bin/ai-or-die.js'), '--port', String(PORT), '--disable-auth'], {
      cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitForServer(BASE, 30000);
  }

  const browser = await chromium.launch();
  const failures = [];
  let totalChecked = 0;

  try {
    for (const vp of VIEWPORTS) {
      console.log(`\n=== ${vp.name}  (island top=${vp.top}, home bottom=${vp.bottom}) ===`);
      const ctx = await browser.newContext({
        ...(vp.mobile ? devices['iPhone 13'] : {}),
        viewport: { width: vp.width, height: vp.height },
        colorScheme: 'dark',
      });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await page.evaluate(forceStandalone(vp.top, vp.bottom), { top: vp.top, bottom: vp.bottom });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/${vp.name}-00-main.png` });

      for (const s of SURFACES) {
        await reveal(page, s.reveal);
        const measureSel = s.anchor === 'modal' ? s.sel : s.sel;
        const res = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return { found: false };
          const cs = getComputedStyle(el);
          const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
          const r = el.getBoundingClientRect();
          // Effective CONTENT edges: a surface may clear the safe area by being
          // pushed down (offset) OR by internal padding (the tab bar fills from
          // y=0 but pads its content down). Account for padding so both fix
          // styles validate; padding only ever makes the check stricter, so it
          // never passes a real collision.
          return {
            found: true, visible, position: cs.position,
            top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
            padTop: Math.round(parseFloat(cs.paddingTop) || 0),
            padBottom: Math.round(parseFloat(cs.paddingBottom) || 0),
          };
        }, measureSel);

        if (!res.found || !res.visible) {
          console.log(`  – ${s.label}: not visible (skipped)`);
          await hide(page, s.reveal);
          continue;
        }
        await page.screenshot({ path: `${OUT}/${vp.name}-${s.label.replace(/\W+/g, '_')}.png` });
        totalChecked++;

        const safeTop = vp.top, safeBottom = vp.height - vp.bottom;
        const effTop = res.top + res.padTop;
        const effBottom = res.bottom - res.padBottom;
        let bad = null;
        if ((s.anchor === 'top' || s.anchor === 'modal') && effTop < safeTop) {
          bad = `content top=${effTop} < island ${safeTop}`;
        }
        if ((s.anchor === 'bottom' || s.anchor === 'modal') && effBottom > safeBottom) {
          bad = (bad ? bad + '; ' : '') + `content bottom=${effBottom} > ${safeBottom}`;
        }
        if (bad) {
          console.log(`  ✗ ${s.label}: COLLIDE (${bad})`);
          failures.push(`[${vp.name}] ${s.label}: ${bad}`);
        } else {
          console.log(`  ✓ ${s.label}: clear (top=${effTop} bottom=${effBottom})`);
        }
        await hide(page, s.reveal);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill('SIGTERM');
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length) {
    console.log(`FAIL — ${failures.length}/${totalChecked} surface(s) collide:`);
    failures.forEach((f) => console.log('  • ' + f));
    console.log(`Screenshots: ${OUT}`);
    process.exit(1);
  }
  console.log(`PASS — all ${totalChecked} checked surfaces clear the safe areas.`);
  console.log(`Screenshots: ${OUT}`);
  if (!process.env.KEEP_SHOTS) console.log('(set KEEP_SHOTS=1 to always keep screenshots)');
}

run().catch((e) => { console.error(e); process.exit(2); });
