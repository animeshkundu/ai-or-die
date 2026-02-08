const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'public');

describe('font loading infrastructure', function () {

  describe('self-hosted WOFF2 files', function () {
    const fontDir = path.join(PUBLIC_DIR, 'fonts');
    const expectedFiles = [
      'MesloLGSNerdFont-Regular.woff2',
      'MesloLGSNerdFont-Bold.woff2',
      'MesloLGSNerdFont-Italic.woff2',
      'MesloLGSNerdFont-BoldItalic.woff2'
    ];

    for (const file of expectedFiles) {
      it(`${file} exists and is non-empty`, function () {
        const filePath = path.join(fontDir, file);
        assert.ok(fs.existsSync(filePath), `${file} must exist in src/public/fonts/`);
        const stat = fs.statSync(filePath);
        assert.ok(stat.size > 100000, `${file} should be larger than 100KB (got ${stat.size})`);
      });
    }
  });

  describe('fonts.css @font-face rules', function () {
    let css;

    before(function () {
      css = fs.readFileSync(path.join(PUBLIC_DIR, 'fonts.css'), 'utf8');
    });

    it('contains 4 @font-face blocks', function () {
      const count = (css.match(/@font-face/g) || []).length;
      assert.strictEqual(count, 4, `expected 4 @font-face rules, got ${count}`);
    });

    it('uses font-family MesloLGS Nerd Font', function () {
      assert.ok(css.includes("'MesloLGS Nerd Font'"), 'must declare MesloLGS Nerd Font');
    });

    it('includes local() sources for v2 naming (MesloLGS NF)', function () {
      assert.ok(css.includes("local('MesloLGS NF')"), 'must include MesloLGS NF local() for v2 compatibility');
    });

    it('references self-hosted WOFF2 files', function () {
      assert.ok(css.includes('MesloLGSNerdFont-Regular.woff2'), 'must reference Regular WOFF2');
      assert.ok(css.includes('MesloLGSNerdFont-Bold.woff2'), 'must reference Bold WOFF2');
      assert.ok(css.includes('MesloLGSNerdFont-Italic.woff2'), 'must reference Italic WOFF2');
      assert.ok(css.includes('MesloLGSNerdFont-BoldItalic.woff2'), 'must reference BoldItalic WOFF2');
    });

    it('CDN URLs are pinned to v3.3.0', function () {
      assert.ok(css.includes('@v3.3.0'), 'CDN URLs must be pinned to v3.3.0');
      assert.ok(!css.includes('@latest'), 'must not use @latest');
    });

    it('uses font-display: swap', function () {
      assert.ok(css.includes('font-display: swap'), 'must use font-display: swap');
    });

    it('does not use unicode-range subsetting', function () {
      assert.ok(!css.includes('unicode-range'), 'must not restrict unicode-range');
    });
  });

  describe('index.html font configuration', function () {
    let html;

    before(function () {
      html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    });

    it('does not contain the broken meslo-nerd-font.css URL', function () {
      assert.ok(!html.includes('meslo-nerd-font.css'), 'must not reference the broken meslo-nerd-font.css');
    });

    it('does not use @latest CDN tag', function () {
      assert.ok(!html.includes('@latest'), 'must not use @latest CDN tag');
    });

    it('loads fonts.css stylesheet', function () {
      assert.ok(html.includes('href="fonts.css"'), 'must include fonts.css stylesheet link');
    });

    it('preloads the Regular WOFF2', function () {
      assert.ok(
        html.includes('rel="preload"') && html.includes('MesloLGSNerdFont-Regular.woff2'),
        'must preload the Regular weight WOFF2'
      );
    });
  });

  describe('service-worker.js font caching', function () {
    let sw;

    before(function () {
      sw = fs.readFileSync(path.join(PUBLIC_DIR, 'service-worker.js'), 'utf8');
    });

    it('caches fonts.css', function () {
      assert.ok(sw.includes('/fonts.css'), 'service worker must cache fonts.css');
    });

    it('caches the Regular WOFF2', function () {
      assert.ok(sw.includes('MesloLGSNerdFont-Regular.woff2'), 'service worker must cache the Regular WOFF2');
    });
  });

  describe('server.js MIME types', function () {
    let serverSrc;

    before(function () {
      serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    });

    it('includes WOFF2 MIME type', function () {
      assert.ok(serverSrc.includes('.woff2'), 'server.js must map .woff2 MIME type');
      assert.ok(serverSrc.includes('font/woff2'), 'server.js must use font/woff2 content type');
    });
  });
});
