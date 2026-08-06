// test/design-system-audit.test.js
//
// AC-9 (Part B): accessibility proven by MEASUREMENT, not inspection.
//
// The existing design-token-contrast test asserts five hand-picked pairs. A
// check that can only confirm pairs someone already believed were fine cannot
// find a defect. This one DERIVES the pairs from the authored CSS — every rule
// that sets both a foreground and a background through tokens becomes a case —
// so a new component with a bad combination fails here rather than shipping.
//
// Also covers the other AC-9 obligations that are mechanically checkable:
// reduced-motion support, a resolvable focus-visible treatment, and hit-target
// sizing on interactive controls.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'src', 'public');

function authoredCss() {
  const roots = [PUBLIC, path.join(PUBLIC, 'components')];
  const files = [];
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.css')) continue;
      const full = path.join(dir, name);
      if (full.includes(`${path.sep}vendor${path.sep}`)) continue;
      if (fs.statSync(full).isFile()) files.push(full);
    }
  }
  return files;
}

function tokenBlock(css, selector) {
  const start = css.indexOf(selector);
  if (start === -1) return {};
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const out = {};
  for (const line of body.split(';')) {
    const m = line.match(/--([\w-]+)\s*:\s*([^;]+)/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function toRgb(value) {
  if (!value) return null;
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    rgb.alpha = 1;
    return rgb;
  }
  const rgba = value.trim().match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/i);
  if (rgba) {
    const rgb = [1, 2, 3].map((i) => Math.round(parseFloat(rgba[i])));
    rgb.alpha = rgba[4] === undefined ? 1 : parseFloat(rgba[4]);
    return rgb;
  }
  return null;
}

/**
 * Composite a possibly-translucent colour over an opaque backdrop.
 *
 * Tokens like `--accent-soft: rgba(59,130,246,0.12)` are TINTS: they never
 * render alone, they sit over a surface. Measuring their raw channels would
 * compare a colour against itself and report a 1.00 ratio for text that is
 * perfectly legible in practice. Compositing first is what the eye actually
 * sees.
 */
function over(colour, backdrop) {
  if (!colour) return null;
  const a = typeof colour.alpha === 'number' ? colour.alpha : 1;
  if (a >= 1) return colour;
  if (!backdrop) return null;
  const out = [0, 1, 2].map((i) => Math.round(colour[i] * a + backdrop[i] * (1 - a)));
  out.alpha = 1;
  return out;
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(a); const lb = luminance(b);
  const hi = Math.max(la, lb); const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Resolve a token to a literal colour, following var() chains within a theme. */
function resolve(theme, name, depth) {
  if (depth > 8) return null;
  const raw = theme[name];
  if (!raw) return null;
  const chained = raw.match(/var\(\s*--([\w-]+)/);
  if (chained) return resolve(theme, chained[1], (depth || 0) + 1);
  return toRgb(raw);
}

/**
 * Every authored rule that sets BOTH a token-driven colour and a token-driven
 * background is a pair that renders together, so it is a pair that must pass.
 */
function derivedPairs() {
  const pairs = new Map();
  for (const file of authoredCss()) {
    const css = fs.readFileSync(file, 'utf8');
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let rule;
    while ((rule = ruleRe.exec(css)) !== null) {
      const body = rule[2];
      const fg = body.match(/(?:^|;)\s*color\s*:\s*var\(\s*--([\w-]+)/);
      const bg = body.match(/(?:^|;)\s*background(?:-color)?\s*:\s*var\(\s*--([\w-]+)/);
      if (!fg || !bg) continue;
      const key = `${fg[1]}|${bg[1]}`;
      if (!pairs.has(key)) {
        pairs.set(key, { fg: fg[1], bg: bg[1], where: path.basename(file), selector: rule[1].trim().slice(0, 60) });
      }
    }
  }
  return Array.from(pairs.values());
}

describe('design system audit (AC-9)', function () {
  const tokensCss = fs.readFileSync(path.join(PUBLIC, 'tokens.css'), 'utf8');
  // base.css publishes backward-compatible aliases (--accent -> --accent-default
  // and similar). Without them, every rule written against an alias resolves to
  // nothing and is silently skipped — the audit would report success on pairs it
  // never actually checked.
  const aliases = tokenBlock(fs.readFileSync(path.join(PUBLIC, 'base.css'), 'utf8'), ':root');
  // Enumerate EVERY theme the product ships, not a hand-picked two. The client
  // offers seven (classic dark/light, monokai, nord, solarized dark/light, and
  // the default), and auditing only two would leave five palettes unchecked —
  // exactly the "can only confirm what someone already looked at" failure this
  // suite exists to avoid.
  const rootBlock = tokenBlock(tokensCss, ':root');
  const themeNames = Array.from(
    new Set((tokensCss.match(/\[data-theme="([a-z-]+)"\]/g) || [])
      .map((s) => s.replace(/\[data-theme="|"\]/g, '')))
  );
  const themes = {};
  for (const name of themeNames) {
    themes[name] = Object.assign({}, aliases, rootBlock, tokenBlock(tokensCss, `[data-theme="${name}"]`));
  }
  themes.default = Object.assign({}, aliases, rootBlock);

  it('derives real foreground/background pairs from the authored CSS', function () {
    const pairs = derivedPairs();
    // Guards the audit itself: if the extraction silently stops matching, the
    // contrast assertions below would pass vacuously.
    assert.ok(pairs.length >= 5,
      `expected the audit to find token pairs in use, found ${pairs.length}`);
  });

  it('every derived pair that resolves meets WCAG AA in both themes', function () {
    const failures = [];
    for (const [themeName, theme] of Object.entries(themes)) {
      // Translucent tints composite over the page surface; that is what renders.
      const base = resolve(theme, 'surface-primary', 0);
      for (const pair of derivedPairs()) {
        const bg = over(resolve(theme, pair.bg, 0), base);
        const fg = over(resolve(theme, pair.fg, 0), bg);
        // Unresolvable pairs (gradients, non-token literals) are out of scope
        // for a static check rather than silently "passing".
        if (!fg || !bg) continue;
        const ratio = contrast(fg, bg);
        if (ratio < 4.5) {
          failures.push(`${themeName}: --${pair.fg} on --${pair.bg} = ${ratio.toFixed(2)} (${pair.where}: ${pair.selector})`);
        }
      }
    }
    assert.deepStrictEqual(failures, [], `contrast failures:\n${failures.join('\n')}`);
  });

  it('honours prefers-reduced-motion', function () {
    const found = authoredCss().some((f) =>
      /@media[^{]*prefers-reduced-motion/.test(fs.readFileSync(f, 'utf8')));
    assert.ok(found, 'no prefers-reduced-motion handling found in authored CSS');
  });

  it('defines a visible focus treatment rather than removing outlines outright', function () {
    const offenders = [];
    for (const file of authoredCss()) {
      const css = fs.readFileSync(file, 'utf8');
      const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
      let rule;
      while ((rule = ruleRe.exec(css)) !== null) {
        const selector = rule[1].trim();
        const body = rule[2];
        if (!/outline\s*:\s*(none|0)\b/.test(body)) continue;
        if (!/:focus/.test(selector)) continue;
        // `:focus:not(:focus-visible)` is the sanctioned pattern for
        // suppressing the ring on pointer focus while keeping it for keyboard.
        if (/:focus:not\(\s*:focus-visible\s*\)/.test(selector)) continue;
        // A rule that inverts the surface is itself a visible affordance; so is
        // an explicit ring or border.
        if (/box-shadow\s*:|border(?:-\w+)?\s*:|background(?:-color)?\s*:/.test(body)) continue;
        offenders.push(`${path.basename(file)}: ${selector.slice(0, 70)}`);
      }
    }
    assert.deepStrictEqual(offenders, [],
      `focus outline removed with no replacement affordance:\n${offenders.join('\n')}`);
  });

  it('keeps a documented minimum hit target for touch', function () {
    // AC-9 asks for >=44px targets. The value must exist as a token so
    // components can share one definition rather than each inventing a size.
    const hasToken = /--(?:hit-target|touch-target|min-touch)[\w-]*\s*:/.test(tokensCss);
    const sizes = tokensCss.match(/--(?:hit-target|touch-target|min-touch)[\w-]*\s*:\s*(\d+)px/);
    assert.ok(hasToken, 'no hit-target token defined in tokens.css');
    if (sizes) {
      assert.ok(parseInt(sizes[1], 10) >= 44,
        `hit-target token is ${sizes[1]}px, below the 44px minimum`);
    }
  });

  it('has no var() referencing a token that is never defined (AC-12)', function () {
    // A `var(--x, #fallback)` whose token is never defined means the FALLBACK
    // silently governs. The surface then renders outside the design system —
    // it will not follow the theme, and no amount of token work will change it.
    // This is how the artifact panel came to paint a dark palette in light mode.
    const defined = new Set();
    for (const file of ['tokens.css', 'base.css']) {
      const css = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
      let m;
      const declRe = /--([\w-]+)\s*:/g;
      while ((m = declRe.exec(css)) !== null) defined.add(m[1]);
    }

    // Supplied at runtime rather than declared in CSS, each with a documented
    // source. Listed explicitly so the guard stays meaningful: anything not
    // here and not declared is a surface silently governed by its fallback.
    const RUNTIME_PROVIDED = new Set([
      'visual-viewport-height',   // set by app.js from visualViewport
      'safe-area-inset-top',      // JS polyfill + env() fallback (tokens.css:174)
      'safe-area-inset-bottom',
      'safe-area-inset-left',
      'safe-area-inset-right',
      'fb-dock-width',           // set by FileBrowserPanel._adjustTerminal while docked
    ]);

    const missing = new Map();
    for (const file of authoredCss()) {
      const css = fs.readFileSync(file, 'utf8');
      // A file may declare its own locals; those are defined too.
      const local = new Set();
      let d;
      const declRe = /--([\w-]+)\s*:/g;
      while ((d = declRe.exec(css)) !== null) local.add(d[1]);

      let m;
      const useRe = /var\(\s*--([\w-]+)/g;
      while ((m = useRe.exec(css)) !== null) {
        const name = m[1];
        if (defined.has(name) || local.has(name) || RUNTIME_PROVIDED.has(name)) continue;
        // Interpolated names (var(--tool-${x})) cannot be resolved statically.
        if (/-$/.test(name)) continue;
        if (!missing.has(name)) missing.set(name, path.basename(file));
      }
    }

    const report = Array.from(missing.entries()).map(([n, f]) => `--${n} (${f})`);
    assert.deepStrictEqual(report, [],
      `var() references to undefined tokens — the fallback governs and the surface ignores the theme:\n${report.join('\n')}`);
  });

  it('builds component geometry on the radius scale (AC-12)', function () {
    // Coherence is structural, not a matter of taste: 67 hardcoded radii across
    // the components meant corners were only incidentally similar, and ten of
    // them (2, 3, 5, 10, 14px) were off the scale entirely. Components must
    // reference the scale so a change to it actually changes the product.
    const offenders = [];
    for (const file of authoredCss()) {
      if (!file.includes(`${path.sep}components${path.sep}`)) continue;
      const css = fs.readFileSync(file, 'utf8');
      const lines = css.split('\n');
      lines.forEach((line, i) => {
        const m = line.match(/border-radius:\s*([^;]+);/);
        if (!m) return;
        // 50% / 9999px round shapes are a shape, not a scale step.
        if (/^\s*(?:50%|9999px|var\(--radius-full\))\s*$/.test(m[1])) return;
        // A px INSIDE var(--token, fallback) is the fallback, not a bypass.
        const withoutVars = m[1].replace(/var\([^)]*\)/g, '');
        if (/\d+px/.test(withoutVars)) {
          offenders.push(`${path.basename(file)}:${i + 1} border-radius: ${m[1].trim()}`);
        }
      });
    }
    assert.deepStrictEqual(offenders, [],
      `component radii bypassing the scale:\n${offenders.join('\n')}`);
  });
});
