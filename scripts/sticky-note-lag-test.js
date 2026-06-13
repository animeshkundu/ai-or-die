'use strict';
// Holistic blocking investigation: measure MAIN-THREAD event-loop lag while the
// sticky-note model downloads, loads, and runs inference. If main-thread lag
// spikes to seconds, that's what starves the terminal's PTY I/O (the hang).

const StickyNoteEngine = require('../src/sticky-note-engine');
const { buildPrompt } = require('../src/sticky-note-prompt');

let maxLag = 0;
let phase = 'idle';
const phaseMax = {};
let last = process.hrtime.bigint();
const TICK = 50;
const mon = setInterval(() => {
  const now = process.hrtime.bigint();
  const lag = Number(now - last) / 1e6 - TICK; // ms beyond the 50ms we asked for
  last = now;
  if (lag > maxLag) maxLag = lag;
  phaseMax[phase] = Math.max(phaseMax[phase] || 0, lag);
}, TICK);
mon.unref();

function mark(p) { phase = p; last = process.hrtime.bigint(); console.log(`[phase] ${p}`); }

(async () => {
  const engine = new StickyNoteEngine({ enabled: true });
  mark('download+load');
  const t0 = Date.now();
  await engine.initialize((p) => { if (p && p.percent % 25 === 0) console.log('  dl', p.percent + '%'); });
  console.log(`[init] ${Date.now() - t0}ms, status=${engine.getStatus()}`);

  mark('idle-after-load');
  await new Promise((r) => setTimeout(r, 1500));

  mark('inference');
  const prompt = buildPrompt(null, ['$ npm test', 'FAIL auth-redirect', 'Expected 302 got 500'].join('\n'));
  const ti = Date.now();
  await engine.infer(prompt);
  console.log(`[infer] ${Date.now() - ti}ms`);

  mark('idle-after-infer');
  await new Promise((r) => setTimeout(r, 1000));

  await engine.shutdown();
  clearInterval(mon);
  console.log('\n=== MAIN-THREAD event-loop lag by phase (ms beyond 50ms tick) ===');
  for (const [p, v] of Object.entries(phaseMax)) console.log(`  ${p}: max ${v.toFixed(0)}ms`);
  console.log(`  OVERALL max: ${maxLag.toFixed(0)}ms`);
  console.log(maxLag > 1000 ? '>> MAIN THREAD WAS BLOCKED (this starves PTY/terminal I/O)' : '>> main thread stayed responsive');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
