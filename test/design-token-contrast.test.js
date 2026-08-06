'use strict';

// Curated contrast pairs, checked against EVERY theme the product ships.
//
// This complements design-system-audit.test.js: that file DERIVES pairs by
// scanning components for a `color:` and `background:` in the same rule, which
// only catches foreground/background combinations written together. The pairs
// below are the ones that must hold no matter how a component expresses them,
// so they are asserted explicitly and by name.
//
// Themes are enumerated from the stylesheet rather than hardcoded. The default
// (midnight) theme lives on `:root`; the rest are `[data-theme="..."]` blocks.
// Values are resolved through var() chains to the primitive that holds the
// literal, because a theme is free to express a semantic token as an alias.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'public', 'tokens.css'),
  'utf8'
);

function luminance(rgb) {
  const linear = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function ratio(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function toRgb(value) {
  if (!value) return null;
  const hexMatch = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const digits = hexMatch[1].length === 3
      ? hexMatch[1].split('').map((c) => c + c).join('')
      : hexMatch[1];
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
  }
  const rgbMatch = value.trim().match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgbMatch) return [1, 2, 3].map((i) => Math.round(parseFloat(rgbMatch[i])));
  return null;
}

function declarationsIn(selector) {
  const start = CSS.indexOf(selector);
  assert(start >= 0, `Missing selector ${selector}`);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  const values = {};
  for (const match of CSS.slice(open + 1, close).matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    values[match[1].trim()] = match[2].trim();
  }
  return values;
}

/** Primitive palette plus the default semantic layer, both on `:root`. */
function rootLayers() {
  const layers = {};
  const blockRe = /:root\s*\{([^}]*)\}/g;
  let block;
  while ((block = blockRe.exec(CSS)) !== null) {
    for (const match of block[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      layers[match[1].trim()] = match[2].trim();
    }
  }
  return layers;
}

function resolve(scope, name, depth = 0) {
  if (depth > 8) return null;
  const raw = scope[name];
  if (!raw) return null;
  const chained = raw.match(/var\(\s*--([\w-]+)/);
  if (chained) return resolve(scope, chained[1], depth + 1);
  return toRgb(raw);
}

// Every theme selector in the stylesheet, plus the `:root` default. Enumerated
// so that adding a theme automatically brings it under this gate.
const THEME_SELECTORS = Array.from(
  new Set((CSS.match(/\[data-theme="[a-z-]+"\]/g) || []))
);
const BASE = rootLayers();

const THEMES = { midnight: BASE };
for (const selector of THEME_SELECTORS) {
  const name = selector.replace(/\[data-theme="|"\]/g, '');
  THEMES[name] = Object.assign({}, BASE, declarationsIn(selector));
}

// Body text is checked against EVERY surface it can land on, not just the page
// background. An earlier version of this list paired muted text with
// --surface-primary alone; it passed while the rendered product failed at 3.90,
// because muted labels sit on secondary, tertiary and elevated surfaces too.
// The static gate has to cover what the rendered gate covers or it predicts
// nothing.
const SURFACES = [
  'surface-primary',
  'surface-secondary',
  'surface-tertiary',
  'surface-elevated',
];

const PAIRS = [
  ...['text-primary', 'text-secondary', 'text-muted'].flatMap(
    (foreground) => SURFACES.map((surface) => [foreground, surface, 4.5])
  ),
  ['text-inverse', 'accent-default', 4.5],
];

describe('design token contrast', function () {
  for (const [theme, scope] of Object.entries(THEMES)) {
    for (const [foreground, background, minimum] of PAIRS) {
      it(`${theme}: ${foreground} on ${background} meets WCAG AA`, function () {
        const fg = resolve(scope, foreground);
        const bg = resolve(scope, background);
        assert(fg, `${theme} does not resolve --${foreground}`);
        assert(bg, `${theme} does not resolve --${background}`);
        const measured = ratio(fg, bg);
        assert(
          measured >= minimum,
          `${theme} --${foreground} on --${background} is ${measured.toFixed(2)}, needs ${minimum}`
        );
      });
    }
  }

  // Regression guard. A previous revision of this file asserted these palettes
  // were ABSENT, which made deleting five shipping themes look like a passing
  // change. Ship them or supersede them deliberately, but do not drop them by
  // accident.
  it('ships every palette the theme picker offers', function () {
    for (const expected of [
      'classic-dark',
      'classic-light',
      'light',
      'monokai',
      'nord',
      'solarized-dark',
      'solarized-light',
    ]) {
      assert(
        CSS.includes(`[data-theme="${expected}"]`),
        `Palette selector missing: ${expected}`
      );
    }
  });
});
