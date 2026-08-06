#!/usr/bin/env node
'use strict';

// Nudge theme tokens to WCAG AA with the SMALLEST change that clears every pair
// they participate in.
//
// Written as a script rather than done by hand because there are 81 failing
// pairs across seven themes: by-eye adjustment would be inconsistent between
// themes and impossible to re-derive later. Each token is moved along its own
// lightness axis only, so a theme keeps its hue and its identity.
//
// Foreground tokens are darkened/lightened against their background. The
// exception is --text-inverse, which is pure white or black by definition: for
// those pairs the BACKGROUND is adjusted instead, because shifting "inverse"
// text is meaningless.
//
// Usage: node scripts/fix-theme-contrast.js [--apply]

const fs = require('fs');
const path = require('path');

const TOKENS = path.join(__dirname, '..', 'src', 'public', 'tokens.css');
const BASE = path.join(__dirname, '..', 'src', 'public', 'base.css');
const COMPONENTS = path.join(__dirname, '..', 'src', 'public', 'components');
const TARGET = 4.5;

function blockOf(css, selector) {
  const i = css.indexOf(selector);
  if (i === -1) return null;
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  return { start: open + 1, end: close, body: css.slice(open + 1, close) };
}

function parseDecls(body) {
  const out = {};
  for (const chunk of body.split(';')) {
    const m = chunk.match(/--([\w-]+)\s*:\s*([^;]+)/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

const toRgb = (v) => {
  if (!v) return null;
  const hex = v.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    c.alpha = 1; return c;
  }
  const r = v.trim().match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/i);
  if (r) {
    const c = [1, 2, 3].map((i) => Math.round(parseFloat(r[i])));
    c.alpha = r[4] === undefined ? 1 : parseFloat(r[4]); return c;
  }
  return null;
};
const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const over = (c, bd) => { if (!c) return null; const a = c.alpha === undefined ? 1 : c.alpha; if (a >= 1) return c; if (!bd) return null; const o = [0, 1, 2].map((i) => Math.round(c[i] * a + bd[i] * (1 - a))); o.alpha = 1; return o; };

function resolve(theme, name, depth = 0) {
  if (depth > 8) return null;
  const raw = theme[name];
  if (!raw) return null;
  const chained = raw.match(/var\(\s*--([\w-]+)/);
  if (chained) return resolve(theme, chained[1], depth + 1);
  return toRgb(raw);
}

/** Move a colour along lightness until it clears `target` against bg. */
function nudge(fg, bg, target) {
  const bgL = lum(bg);
  // Darken if the background is light, lighten if it is dark.
  const dir = bgL > 0.4 ? -1 : 1;
  let best = fg.slice(0, 3);
  for (let step = 1; step <= 255; step++) {
    const c = best.map((v) => v + dir * step);
    if (c.some((v) => v < 0 || v > 255)) break;
    if (ratio(c, bg) >= target) return c;
  }
  // Could not reach it by shifting; fall back to the extreme.
  return dir < 0 ? [0, 0, 0] : [255, 255, 255];
}

function derivedPairs() {
  const files = [BASE, path.join(__dirname, '..', 'src', 'public', 'style.css')]
    .concat(fs.readdirSync(COMPONENTS).filter((f) => f.endsWith('.css')).map((f) => path.join(COMPONENTS, f)))
    .filter((f) => fs.existsSync(f));
  const pairs = new Map();
  for (const file of files) {
    const css = fs.readFileSync(file, 'utf8');
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let rule;
    while ((rule = ruleRe.exec(css)) !== null) {
      const fg = rule[2].match(/(?:^|;)\s*color\s*:\s*var\(\s*--([\w-]+)/);
      const bg = rule[2].match(/(?:^|;)\s*background(?:-color)?\s*:\s*var\(\s*--([\w-]+)/);
      if (!fg || !bg) continue;
      pairs.set(`${fg[1]}|${bg[1]}`, { fg: fg[1], bg: bg[1] });
    }
  }
  return Array.from(pairs.values());
}

function main() {
  const apply = process.argv.includes('--apply');
  let css = fs.readFileSync(TOKENS, 'utf8');
  const aliases = parseDecls(blockOf(fs.readFileSync(BASE, 'utf8'), ':root').body);
  const rootBody = blockOf(css, ':root');
  const root = parseDecls(rootBody.body);

  const names = Array.from(new Set((css.match(/\[data-theme="([a-z-]+)"\]/g) || [])
    .map((s) => s.replace(/\[data-theme="|"\]/g, ''))));
  const pairs = derivedPairs();

  let totalEdits = 0;
  const unfixable = [];
  for (const themeName of names) {
    const blk = blockOf(css, `[data-theme="${themeName}"]`);
    if (!blk) continue;
    const theme = Object.assign({}, aliases, root, parseDecls(blk.body));
    const base = resolve(theme, 'surface-primary');
    const edits = new Map();

    for (const p of pairs) {
      const bg = over(resolve(theme, p.bg), base);
      const fg = over(resolve(theme, p.fg), bg);
      if (!fg || !bg || ratio(fg, bg) >= TARGET) continue;

      // Some tokens are never the thing to move. --text-inverse is white or
      // black by definition, and a --surface-* used as FOREGROUND (label text
      // on an accent button) is the page's own background colour — shifting it
      // to fix one button would repaint the entire theme. In both cases adjust
      // the background of that pair instead.
      const moveBg = /inverse/.test(p.fg) || /^surface-/.test(p.fg);
      const tokenName = moveBg ? p.bg : p.fg;
      // Follow a var() chain to the token that actually holds the literal —
      // otherwise a theme expressed through aliases is silently skipped and its
      // failures go unfixed.
      let literalName = tokenName;
      for (let i = 0; i < 8; i++) {
        const raw = theme[literalName];
        const chained = raw && raw.match(/var\(\s*--([\w-]+)/);
        if (!chained) break;
        literalName = chained[1];
      }
      // Never move a surface token, and check that AFTER resolving the chain:
      // an alias such as --bg-hover resolves to --surface-tertiary, so guarding
      // only the alias name would still repaint the theme. Surfaces ARE the
      // theme; a pair that can only be fixed by moving one is a component
      // choosing the wrong foreground, and is reported rather than "fixed".
      if (/^surface-/.test(literalName)) {
        unfixable.push(`${themeName}: --${p.fg} on --${p.bg} (would require moving --${literalName})`);
        continue;
      }
      if (!/^#|^rgb/.test(theme[literalName] || '')) continue;
      const target = literalName;
      const current = edits.has(target) ? edits.get(target) : toRgb(theme[target]);
      const fixed = moveBg ? nudge(current, fg, TARGET) : nudge(current, bg, TARGET);
      edits.set(target, fixed);
    }

    if (!edits.size) continue;
    let body = blk.body;
    for (const [name, colour] of edits) {
      const re = new RegExp(`(--${name}\\s*:\\s*)([^;]+)(;)`);
      if (re.test(body)) {
        body = body.replace(re, `$1${hex(colour)}$3`);
        totalEdits++;
      }
    }
    css = css.slice(0, blk.start) + body + css.slice(blk.end);
    console.log(`${themeName}: adjusted ${edits.size} token(s) -> ${Array.from(edits.keys()).join(', ')}`);
  }

  if (unfixable.length) {
    console.log('\nNOT auto-fixed (component chose a foreground the palette cannot support):');
    for (const u of Array.from(new Set(unfixable))) console.log('  ' + u);
  }

  if (apply) {
    fs.writeFileSync(TOKENS, css);
    console.log(`\napplied ${totalEdits} edit(s) to tokens.css`);
  } else {
    console.log(`\ndry run — ${totalEdits} edit(s) would be applied (pass --apply)`);
  }
}

main();
