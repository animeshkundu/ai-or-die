'use strict';

const assert = require('assert');
const { applyLocaleFallback } = require('../src/base-bridge');

describe('base-bridge locale fallback (Linux garble fix)', function () {
  it('sets LANG=C.UTF-8 only when LANG and LC_ALL are unset', function () {
    const prevLang = process.env.LANG;
    const prevLcAll = process.env.LC_ALL;
    delete process.env.LANG;
    delete process.env.LC_ALL;
    try {
      const env = applyLocaleFallback({ TERM: 'xterm-256color' });
      if (process.platform === 'win32') {
        assert.strictEqual(env.LANG, undefined);
      } else {
        assert.strictEqual(env.LANG, 'C.UTF-8');
      }
    } finally {
      if (prevLang !== undefined) process.env.LANG = prevLang;
      if (prevLcAll !== undefined) process.env.LC_ALL = prevLcAll;
    }
  });

  it('never overrides an explicit LANG', function () {
    const env = applyLocaleFallback({ LANG: 'en_US.UTF-8' });
    assert.strictEqual(env.LANG, 'en_US.UTF-8');
  });

  it('never overrides when LC_ALL is set and never touches LC_ALL', function () {
    const env = applyLocaleFallback({ LC_ALL: 'C' });
    assert.strictEqual(env.LC_ALL, 'C');
    assert.strictEqual(env.LANG, undefined);
  });

  it('never touches LANGUAGE', function () {
    const env = applyLocaleFallback({ LANGUAGE: 'en' });
    assert.strictEqual(env.LANGUAGE, 'en');
  });
});
