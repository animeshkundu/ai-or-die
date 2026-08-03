'use strict';

const path = require('path');
const { readLegacyClientFile } = require('../../scripts/pin-legacy-client');

async function installLegacyClientRoutes(page, options = {}) {
  const baseRef = options.baseRef || 'HEAD^';
  const files = options.files || ['app.js', 'voice-handler.js'];
  const pinned = new Map(files.map((file) => [file, readLegacyClientFile(baseRef, file)]));
  await page.route('**/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const basename = path.posix.basename(pathname);
    if (!pinned.has(basename)) return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: pinned.get(basename),
    });
  });
}

module.exports = { installLegacyClientRoutes };
