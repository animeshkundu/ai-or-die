#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Committed snapshot of the pre-change client, used by the backwards-
// compatibility e2e test. Regenerate with:
//   node scripts/pin-legacy-client.js <ref> e2e/fixtures/legacy-client app.js voice-handler.js
const PINNED_DIR = path.resolve(__dirname, '..', 'e2e', 'fixtures', 'legacy-client');

function readLegacyClientFile(baseRef, publicFile) {
  const safe = path.posix.normalize(publicFile).replace(/^(\.\.\/)+/, '');
  if (!/^[a-zA-Z0-9._/-]+$/.test(safe)) throw new Error('Invalid public client path');

  // Prefer the committed snapshot over reading git history.
  //
  // Reading `git show HEAD^:...` at test time breaks in two ways, one loud and
  // one silent. Loud: CI checks out shallow (fetch-depth 1), so HEAD^ does not
  // exist and the test errors — which is how this was found. Silent, and worse:
  // once this branch is squash-merged, HEAD^ becomes main's PREVIOUS commit, a
  // different tree entirely, so the test would quietly compare against the
  // wrong "legacy" client and still pass. A committed fixture is deterministic,
  // survives squash-merge and shallow clones, and is reviewable in a diff.
  const pinned = path.join(PINNED_DIR, safe);
  if (pinned.startsWith(PINNED_DIR) && fs.existsSync(pinned)) {
    return fs.readFileSync(pinned, 'utf8');
  }

  // Fallback: read from git. Used locally where full history is present.
  return readFromGit(baseRef, safe);
}

// Always reads git, never the pin. Regeneration must not copy the pinned
// snapshot onto itself — that would silently freeze the fixture forever.
function readFromGit(baseRef, publicFile) {
  const safe = path.posix.normalize(publicFile).replace(/^(\.\.\/)+/, '');
  if (!/^[a-zA-Z0-9._/-]+$/.test(safe)) throw new Error('Invalid public client path');
  return execFileSync('git', ['show', `${baseRef}:src/public/${safe}`], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function materializeLegacyClient(baseRef, files, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const file of files) {
    const destination = path.join(outputDir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, readFromGit(baseRef, file));
  }
}

if (require.main === module) {
  const [baseRef, outputDir, ...files] = process.argv.slice(2);
  if (!baseRef || !outputDir || files.length === 0) {
    console.error('Usage: pin-legacy-client <base-ref> <output-dir> <public-file...>');
    process.exit(78);
  }
  materializeLegacyClient(baseRef, files, outputDir);
}

module.exports = { readLegacyClientFile, readFromGit, materializeLegacyClient };
