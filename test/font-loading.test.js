const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'public');

describe('font loading infrastructure', function () {

  describe('self-hosted WOFF2 files', function () {
    const fontDir = path.join(PUBLIC_DIR, 'fonts');
    const expectedFiles = [
      // MesloLGS (4 variants)
      'MesloLGSNerdFont-Regular.woff2',
      'MesloLGSNerdFont-Bold.woff2',
      'MesloLGSNerdFont-Italic.woff2',
      'MesloLGSNerdFont-BoldItalic.woff2',
      // JetBrains Mono (4 variants)
      'JetBrainsMonoNerdFont-Regular.woff2',
      'JetBrainsMonoNerdFont-Bold.woff2',
      'JetBrainsMonoNerdFont-Italic.woff2',
      'JetBrainsMonoNerdFont-BoldItalic.woff2',
      // Fira Code (2 variants — no italics)
      'FiraCodeNerdFont-Regular.woff2',
      'FiraCodeNerdFont-Bold.woff2',
      // Cascadia Code (4 variants)
      'CaskaydiaCoveNerdFont-Regular.woff2',
      'CaskaydiaCoveNerdFont-Bold.woff2',
      'CaskaydiaCoveNerdFont-Italic.woff2',
      'CaskaydiaCoveNerdFont-BoldItalic.woff2'
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

    it('contains 14 @font-face blocks', function () {
      const count = (css.match(/@font-face/g) || []).length;
      assert.strictEqual(count, 14, `expected 14 @font-face rules, got ${count}`);
    });

    it('uses font-family MesloLGS Nerd Font', function () {
      assert.ok(css.includes("'MesloLGS Nerd Font'"), 'must declare MesloLGS Nerd Font');
    });

    it('uses font-family JetBrains Mono NF', function () {
      assert.ok(css.includes("'JetBrains Mono NF'"), 'must declare JetBrains Mono NF');
    });

    it('uses font-family Fira Code NF', function () {
      assert.ok(css.includes("'Fira Code NF'"), 'must declare Fira Code NF');
    });

    it('uses font-family Cascadia Code NF', function () {
      assert.ok(css.includes("'Cascadia Code NF'"), 'must declare Cascadia Code NF');
    });

    it('includes local() sources for v2 naming (MesloLGS NF)', function () {
      assert.ok(css.includes("local('MesloLGS NF')"), 'must include MesloLGS NF local() for v2 compatibility');
    });

    it('local MesloLGS NF appears after self-hosted WOFF2 URL', function () {
      const woff2Index = css.indexOf('MesloLGSNerdFont-Regular.woff2');
      const localIndex = css.indexOf("local('MesloLGS NF')");
      assert.ok(woff2Index !== -1, 'must contain MesloLGSNerdFont-Regular.woff2');
      assert.ok(localIndex !== -1, "must contain local('MesloLGS NF')");
      assert.ok(
        woff2Index < localIndex,
        'self-hosted WOFF2 URL must appear before local MesloLGS NF source'
      );
    });

    it('references MesloLGS WOFF2 files', function () {
      assert.ok(css.includes('MesloLGSNerdFont-Regular.woff2'), 'must reference Regular WOFF2');
      assert.ok(css.includes('MesloLGSNerdFont-Bold.woff2'), 'must reference Bold WOFF2');
      assert.ok(css.includes('MesloLGSNerdFont-Italic.woff2'), 'must reference Italic WOFF2');
      assert.ok(css.includes('MesloLGSNerdFont-BoldItalic.woff2'), 'must reference BoldItalic WOFF2');
    });

    it('references JetBrains Mono WOFF2 files', function () {
      assert.ok(css.includes('JetBrainsMonoNerdFont-Regular.woff2'), 'must reference Regular WOFF2');
      assert.ok(css.includes('JetBrainsMonoNerdFont-Bold.woff2'), 'must reference Bold WOFF2');
      assert.ok(css.includes('JetBrainsMonoNerdFont-Italic.woff2'), 'must reference Italic WOFF2');
      assert.ok(css.includes('JetBrainsMonoNerdFont-BoldItalic.woff2'), 'must reference BoldItalic WOFF2');
    });

    it('references Fira Code WOFF2 files', function () {
      assert.ok(css.includes('FiraCodeNerdFont-Regular.woff2'), 'must reference Regular WOFF2');
      assert.ok(css.includes('FiraCodeNerdFont-Bold.woff2'), 'must reference Bold WOFF2');
    });

    it('references Cascadia Code WOFF2 files', function () {
      assert.ok(css.includes('CaskaydiaCoveNerdFont-Regular.woff2'), 'must reference Regular WOFF2');
      assert.ok(css.includes('CaskaydiaCoveNerdFont-Bold.woff2'), 'must reference Bold WOFF2');
      assert.ok(css.includes('CaskaydiaCoveNerdFont-Italic.woff2'), 'must reference Italic WOFF2');
      assert.ok(css.includes('CaskaydiaCoveNerdFont-BoldItalic.woff2'), 'must reference BoldItalic WOFF2');
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

    it('every non-Meslo font option includes MesloLGS Nerd Font as fallback', function () {
      // Extract all <option> elements inside #fontFamily
      const selectMatch = html.match(/<select id="fontFamily">([\s\S]*?)<\/select>/);
      assert.ok(selectMatch, 'must have a #fontFamily select element');
      const selectBody = selectMatch[1];

      // Parse each option's value and text
      const optionRegex = /<option\s+value="([^"]+)"[^>]*>([^<]+)<\/option>/g;
      let match;
      while ((match = optionRegex.exec(selectBody)) !== null) {
        const value = match[1];
        const label = match[2].trim();

        if (label.includes('Meslo')) {
          // The Meslo option itself has MesloLGS Nerd Font as primary
          assert.ok(
            value.includes('MesloLGS Nerd Font'),
            `Meslo option should have MesloLGS Nerd Font as primary: ${value}`
          );
        } else {
          // All other options must include MesloLGS Nerd Font as a fallback
          assert.ok(
            value.includes('MesloLGS Nerd Font'),
            `Font option "${label}" must include MesloLGS Nerd Font as fallback, got: ${value}`
          );
        }
      }
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

    it('pre-caches MesloLGS (default) font WOFF2 variants', function () {
      const precachedFonts = [
        'MesloLGSNerdFont-Regular.woff2',
        'MesloLGSNerdFont-Bold.woff2',
        'MesloLGSNerdFont-Italic.woff2',
        'MesloLGSNerdFont-BoldItalic.woff2'
      ];

      for (const font of precachedFonts) {
        assert.ok(sw.includes(font), `service worker urlsToCache must include ${font}`);
      }
    });

    it('does not pre-cache non-default font WOFF2 (cached on-demand)', function () {
      // Extract just the urlsToCache array by finding content between the array brackets
      const cacheListMatch = sw.match(/urlsToCache\s*=\s*\[([\s\S]*?)\]/);
      assert.ok(cacheListMatch, 'must have urlsToCache array');
      const cacheList = cacheListMatch[1];

      // Non-default fonts should NOT be in the pre-cache list
      assert.ok(!cacheList.includes('JetBrainsMonoNerdFont'), 'JetBrains Mono should not be pre-cached');
      assert.ok(!cacheList.includes('FiraCodeNerdFont'), 'Fira Code should not be pre-cached');
      assert.ok(!cacheList.includes('CaskaydiaCoveNerdFont'), 'Cascadia Code should not be pre-cached');
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

  describe('clearTextureAtlas font reload', function () {
    it('app.js contains clearTextureAtlas', function () {
      const appSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
      assert.ok(
        appSrc.includes('clearTextureAtlas'),
        'app.js must call clearTextureAtlas to force glyph re-render after font change'
      );
    });

    it('splits.js contains clearTextureAtlas', function () {
      const splitsSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'splits.js'), 'utf8');
      assert.ok(
        splitsSrc.includes('clearTextureAtlas'),
        'splits.js must call clearTextureAtlas to force glyph re-render after font change'
      );
    });
  });
});
