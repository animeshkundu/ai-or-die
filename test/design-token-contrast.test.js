'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function luminance(hex) {
  const rgb = hex.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16) / 255);
  const linear = rgb.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function ratio(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function valuesFromBlock(css, selector) {
  const start = css.lastIndexOf(selector);
  assert(start >= 0, `Missing selector ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const values = {};
  for (const match of css.slice(open + 1, close).matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    values[match[1]] = match[2];
  }
  return values;
}

describe('design token contrast', function () {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'tokens.css'), 'utf8');
  const themes = {
    dark: valuesFromBlock(css, '[data-theme="dark"]'),
    light: valuesFromBlock(css, '[data-theme="light"]'),
  };
  const pairs = [
    ['text-primary', 'surface-primary', 4.5],
    ['text-secondary', 'surface-primary', 4.5],
    ['text-muted', 'surface-primary', 4.5],
    ['text-primary', 'surface-secondary', 4.5],
    ['text-on-accent', 'accent-default', 4.5],
  ];

  for (const [theme, values] of Object.entries(themes)) {
    for (const [foreground, background, minimum] of pairs) {
      it(`${theme} ${foreground} on ${background} meets WCAG AA`, function () {
        assert(values[foreground], `Missing ${foreground}`);
        assert(values[background], `Missing ${background}`);
        assert(
          ratio(values[foreground], values[background]) >= minimum,
          `${foreground}/${background} contrast is ${ratio(values[foreground], values[background]).toFixed(2)}`
        );
      });
    }
  }

  it('ships only the resolved dark and light palette selectors', function () {
    for (const legacy of [
      'classic-dark',
      'classic-light',
      'midnight',
      'monokai',
      'nord',
      'solarized-dark',
      'solarized-light',
    ]) {
      assert(!css.includes(`[data-theme="${legacy}"]`), `Legacy palette selector remains: ${legacy}`);
    }
  });
});
