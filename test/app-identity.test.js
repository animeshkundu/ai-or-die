const assert = require('assert');
const AppIdentity = require('../src/public/app-identity');

describe('app-identity', function () {
  const {
    sanitizeHostnameForDisplay,
    formatAppIdentity,
    formatNotificationTitle,
    formatShortName,
    applyAppIdentity,
  } = AppIdentity;

  describe('sanitizeHostnameForDisplay', function () {
    it('returns "" for empty / non-string / whitespace', function () {
      assert.strictEqual(sanitizeHostnameForDisplay(''), '');
      assert.strictEqual(sanitizeHostnameForDisplay(undefined), '');
      assert.strictEqual(sanitizeHostnameForDisplay(null), '');
      assert.strictEqual(sanitizeHostnameForDisplay(1234), '');
      assert.strictEqual(sanitizeHostnameForDisplay('   '), '');
    });

    it('trims surrounding whitespace', function () {
      assert.strictEqual(sanitizeHostnameForDisplay('  box  '), 'box');
    });

    it('takes the first DNS label of an FQDN by default', function () {
      assert.strictEqual(sanitizeHostnameForDisplay('dev.corp.example.com'), 'dev');
      assert.strictEqual(sanitizeHostnameForDisplay('mini.local'), 'mini');
    });

    it('keeps the full value when firstLabel is false', function () {
      assert.strictEqual(
        sanitizeHostnameForDisplay('dev.corp', { firstLabel: false }),
        'dev.corp'
      );
    });

    it('leaves IDN / punycode intact', function () {
      assert.strictEqual(sanitizeHostnameForDisplay('xn--mnchen-3ya'), 'xn--mnchen-3ya');
    });

    it('truncates with an ellipsis past maxLength', function () {
      assert.strictEqual(
        sanitizeHostnameForDisplay('abcdefghijklmnopqrstuvwxyz'),
        'abcdefghijklmnopqrs…'
      );
      assert.strictEqual(
        sanitizeHostnameForDisplay('abcdef', { maxLength: 4 }),
        'abc…'
      );
    });

    it('strips control, zero-width, and bidi-override characters', function () {
      assert.strictEqual(sanitizeHostnameForDisplay('abc'), 'abc');
      assert.strictEqual(sanitizeHostnameForDisplay('a​b‌c'), 'abc');
      assert.strictEqual(sanitizeHostnameForDisplay('a‮b'), 'ab');
      assert.strictEqual(sanitizeHostnameForDisplay('a﻿b'), 'ab');
    });

    it('handles a Windows NetBIOS-style all-caps name', function () {
      assert.strictEqual(sanitizeHostnameForDisplay('DESKTOP-AB12CD'), 'DESKTOP-AB12CD');
    });
  });

  describe('formatAppIdentity', function () {
    it('falls back to the bare app name when host is empty', function () {
      assert.strictEqual(formatAppIdentity({ hostname: '' }), 'ai-or-die');
      assert.strictEqual(formatAppIdentity({}), 'ai-or-die');
      assert.strictEqual(formatAppIdentity(), 'ai-or-die');
    });

    it('prefixes [host] when a host is present', function () {
      assert.strictEqual(formatAppIdentity({ hostname: 'MACBOOK' }), '[MACBOOK] ai-or-die');
      assert.strictEqual(formatAppIdentity({ hostname: 'dev.corp.example.com' }), '[dev] ai-or-die');
    });

    it('honours a custom appName', function () {
      assert.strictEqual(
        formatAppIdentity({ hostname: 'box', appName: 'tool' }),
        '[box] tool'
      );
    });
  });

  describe('formatNotificationTitle', function () {
    it('prefixes the host', function () {
      assert.strictEqual(
        formatNotificationTitle('Session done', 'MACBOOK'),
        '[MACBOOK] Session done'
      );
    });

    it('passes the title through unchanged when host is empty', function () {
      assert.strictEqual(formatNotificationTitle('Session done', ''), 'Session done');
    });

    it('is idempotent — never double-prefixes', function () {
      const once = formatNotificationTitle('Session done', 'MACBOOK');
      assert.strictEqual(formatNotificationTitle(once, 'MACBOOK'), once);
    });

    it('agrees with the title formatter on host formatting', function () {
      const host = 'dev.corp.example.com';
      // both derive the same display label ("dev")
      assert.ok(formatAppIdentity({ hostname: host }).indexOf('[dev]') === 0);
      assert.ok(formatNotificationTitle('x', host).indexOf('[dev] ') === 0);
    });
  });

  describe('formatShortName', function () {
    it('returns the hard-truncated host', function () {
      assert.strictEqual(formatShortName({ hostname: 'dev-workstation-17' }), 'dev-worksta…');
    });

    it('falls back to the app name when host is empty', function () {
      assert.strictEqual(formatShortName({ hostname: '' }), 'ai-or-die');
      assert.strictEqual(formatShortName({}), 'ai-or-die');
    });
  });

  describe('applyAppIdentity', function () {
    function fakeDoc() {
      const nodes = {
        mobileMenuTitle: { textContent: '' },
        app: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
      };
      const metas = {
        'meta[name="apple-mobile-web-app-title"]': { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
        'meta[name="application-name"]': { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
      };
      return {
        title: '',
        nodes,
        metas,
        getElementById(id) { return nodes[id] || null; },
        querySelector(sel) { return metas[sel] || null; },
      };
    }

    it('writes the identity to title, menu, aria-label, and meta tags', function () {
      const doc = fakeDoc();
      applyAppIdentity('[BOX] ai-or-die', doc);
      assert.strictEqual(doc.title, '[BOX] ai-or-die');
      assert.strictEqual(doc.nodes.mobileMenuTitle.textContent, '[BOX] ai-or-die');
      assert.strictEqual(doc.nodes.app.attrs['aria-label'], '[BOX] ai-or-die terminal interface');
      assert.strictEqual(
        doc.metas['meta[name="apple-mobile-web-app-title"]'].attrs.content,
        '[BOX] ai-or-die'
      );
      assert.strictEqual(
        doc.metas['meta[name="application-name"]'].attrs.content,
        '[BOX] ai-or-die'
      );
    });

    it('no-ops without throwing when there is no document', function () {
      assert.doesNotThrow(() => applyAppIdentity('[X] ai-or-die', null));
      assert.doesNotThrow(() => applyAppIdentity('', fakeDoc()));
    });
  });
});
