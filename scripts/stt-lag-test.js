'use strict';
// Confirm/refute the root-cause hypothesis: does STT (sherpa, provider:'cpu')
// loading its model saturate CPU and block the main thread? Compare to the
// sticky-note (node-llama-cpp/Metal) result of 3ms. High lag here => STT was
// the terminal-hang culprit and making it lazy is the correct fix.
const SttEngine = require('../src/stt-engine');

let maxLag = 0, phase = 'idle';
const phaseMax = {};
let last = process.hrtime.bigint();
const TICK = 50;
const mon = setInterval(() => {
  const now = process.hrtime.bigint();
  const lag = Number(now - last) / 1e6 - TICK;
  last = now;
  if (lag > maxLag) maxLag = lag;
  phaseMax[phase] = Math.max(phaseMax[phase] || 0, lag);
}, TICK);
mon.unref();
const mark = (p) => { phase = p; last = process.hrtime.bigint(); console.log(`[phase] ${p}`); };

(async () => {
  const engine = new SttEngine({ enabled: true });
  mark('stt-download+load');
  const t0 = Date.now();
  await engine.initialize((p) => { if (p && p.fileIndex !== undefined) process.stdout.write(`  dl f${p.fileIndex} ${Math.round((p.downloaded/p.total)*100)}%\r`); });
  console.log(`\n[stt-init] ${Date.now() - t0}ms, status=${engine.getStatus()}`);

  mark('idle-after-load');
  await new Promise((r) => setTimeout(r, 1500));

  // One transcribe to measure inference-time main-thread lag (16kHz silence).
  mark('stt-transcribe');
  try {
    const samples = new Float32Array(16000); // 1s of silence
    await engine.transcribe(samples);
  } catch (e) { console.log('  transcribe err (ok for this test):', e.message); }

  mark('idle-after-transcribe');
  await new Promise((r) => setTimeout(r, 1000));

  await engine.shutdown();
  clearInterval(mon);
  console.log('\n=== STT main-thread event-loop lag by phase (ms beyond 50ms tick) ===');
  for (const [p, v] of Object.entries(phaseMax)) console.log(`  ${p}: max ${v.toFixed(0)}ms`);
  console.log(`  OVERALL max: ${maxLag.toFixed(0)}ms`);
  console.log(maxLag > 1000 ? '>> STT LOAD BLOCKS THE MAIN THREAD — confirms it starved the terminal at startup' : '>> STT did NOT block the main thread — look elsewhere');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
