'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ClaudeCodeWebServer } = require('../src/server');

// PWA splash + manifest hygiene. Complements pwa-assets.test.js:
//  - manifest screenshot `type` must match the file extension (regression guard
//    for the image/svg+xml-on-.png bug) and each screenshot must be a real PNG.
//  - index.html must declare apple-touch-startup-image splash for iPhone 16 and
//    iPad (gen 11) (Edge on iOS = WebKit; a blank launch otherwise). See ADR-0037.
//  - theme_color must match the <meta name=theme-color>.

describe('PWA splash + manifest hygiene', function () {
  this.timeout(20000);
  let server, port;
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');

  before(async function () {
    server = new ClaudeCodeWebServer({ port: 0, noAuth: true });
    const httpServer = await server.start();
    port = httpServer.address().port;
  });

  after(function () {
    if (server) server.close();
  });

  async function get(p) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf };
  }

  const extToType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

  it('manifest screenshots: declared type matches file extension', async function () {
    const { buf } = await get('/manifest.json');
    const m = JSON.parse(buf.toString('utf8'));
    assert.ok(Array.isArray(m.screenshots) && m.screenshots.length > 0, 'has screenshots');
    for (const s of m.screenshots) {
      const ext = (s.src.split('.').pop() || '').toLowerCase();
      assert.strictEqual(s.type, extToType[ext],
        `screenshot ${s.src} declares type ${s.type} but extension is .${ext}`);
    }
  });

  it('manifest screenshot files exist and are real images', async function () {
    const { buf } = await get('/manifest.json');
    const m = JSON.parse(buf.toString('utf8'));
    for (const s of m.screenshots) {
      const { res, buf: img } = await get(s.src);
      assert.strictEqual(res.status, 200, `status for ${s.src}`);
      assert.deepStrictEqual([...img.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], `PNG signature for ${s.src}`);
    }
  });

  it('index.html declares apple-touch-startup-image splash links', function () {
    const links = html.match(/<link[^>]*rel="apple-touch-startup-image"[^>]*>/g) || [];
    assert.ok(links.length >= 4, `expected >=4 splash links, found ${links.length}`);
    // Must cover iPhone 16 (393x852 @3x) and iPad gen 11 (820x1180 @2x).
    assert.ok(links.some(l => /device-width: 393px/.test(l) && /device-pixel-ratio: 3/.test(l)),
      'iPhone 16 splash link present');
    assert.ok(links.some(l => /device-width: 820px/.test(l) && /device-pixel-ratio: 2/.test(l)),
      'iPad gen 11 splash link present');
    // Both orientations present.
    assert.ok(links.some(l => /orientation: portrait/.test(l)), 'portrait splash present');
    assert.ok(links.some(l => /orientation: landscape/.test(l)), 'landscape splash present');
  });

  it('splash image files exist and are real PNGs', async function () {
    const hrefs = (html.match(/rel="apple-touch-startup-image"\s+href="([^"]+)"/g) || [])
      .map(s => s.match(/href="([^"]+)"/)[1]);
    // Fallback: also capture href-before-media ordering.
    const allHrefs = new Set(hrefs);
    (html.match(/href="(\/splash\/[^"]+)"/g) || []).forEach(s => allHrefs.add(s.match(/href="([^"]+)"/)[1]));
    assert.ok(allHrefs.size >= 4, `expected >=4 splash hrefs, found ${allHrefs.size}`);
    for (const href of allHrefs) {
      const { res, buf } = await get(href);
      assert.strictEqual(res.status, 200, `status for ${href}`);
      assert.deepStrictEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], `PNG signature for ${href}`);
    }
  });

  it('manifest theme_color matches the theme-color meta', async function () {
    const { buf } = await get('/manifest.json');
    const m = JSON.parse(buf.toString('utf8'));
    const meta = html.match(/<meta[^>]*name="theme-color"[^>]*content="([^"]+)"/);
    assert.ok(meta, 'theme-color meta present');
    assert.strictEqual(m.theme_color.toLowerCase(), meta[1].toLowerCase());
  });
});
