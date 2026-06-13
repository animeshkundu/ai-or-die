'use strict';

// Real-model end-to-end check (NOT part of `npm test` — downloads ~1.56GB and
// runs live inference). Validates that node-llama-cpp's prebuilt actually loads
// LFM2-2.6B and that the worker + grammar produce a parseable note.

const StickyNoteEngine = require('../src/sticky-note-engine');
const { buildPrompt, parseNote } = require('../src/sticky-note-prompt');

(async () => {
  const engine = new StickyNoteEngine({ enabled: true });
  console.log('[e2e] initializing (downloads model on first run)...');
  let lastPct = -1;
  await engine.initialize((p) => {
    if (p && p.percent !== lastPct && p.percent % 10 === 0) {
      lastPct = p.percent;
      console.log(`[e2e] download ${p.percent}%`);
    }
  });
  console.log('[e2e] status =', engine.getStatus());
  if (!engine.isReady()) {
    console.error('[e2e] FAIL: engine not ready');
    process.exit(1);
  }

  const transcript = [
    '$ npm test',
    'Running auth integration tests...',
    'FAIL test/auth-redirect.test.js',
    '  ● redirects to /login when token is expired',
    '  Expected status 302 but received 500',
    'The login handler throws when refreshToken is null.',
    '$ # investigating the null refreshToken path',
  ].join('\n');

  const prompt = buildPrompt(null, transcript);
  console.log('[e2e] running inference...');
  const t0 = Date.now();
  const raw = await engine.infer(prompt);
  console.log(`[e2e] inference took ${Date.now() - t0}ms`);
  console.log('[e2e] raw output:', raw);

  const note = parseNote(raw);
  console.log('[e2e] parsed note:', JSON.stringify(note, null, 2));

  await engine.shutdown();

  if (!note || !note.title || (!note.goal && note.progress.length === 0)) {
    console.error('[e2e] FAIL: note did not parse into a usable shape');
    process.exit(1);
  }
  console.log('[e2e] PASS');
  process.exit(0);
})().catch((err) => {
  console.error('[e2e] ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
