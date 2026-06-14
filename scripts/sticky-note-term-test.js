'use strict';
// User-like test: does the terminal render fast? Opens several terminals against
// a real server (default config = STT lazy, sticky-notes on) and measures
// time-to-first-output (the zsh prompt). Also opens a terminal WHILE an AI
// (codex) session is starting + sticky-notes is loading, to prove real work
// isn't blocked.
const { spawn } = require('child_process');
const WebSocket = require('/Users/kundus/Software/ai-or-die/node_modules/ws');
const PORT = 12811;
const ROOT = '/Users/kundus/Software/ai-or-die';

const srv = spawn('node', ['bin/ai-or-die.js', '--port', String(PORT), '--disable-auth'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
srv.stdout.on('data', (d) => (srvLog += d));
srv.stderr.on('data', (d) => (srvLog += d));

function openTerminal(label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const t0 = Date.now();
    let started = null, firstOut = null, err = null, sid = null;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'create_session', name: label, workingDir: ROOT })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) { if (firstOut === null) firstOut = Date.now() - t0; return; }
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'session_created') { sid = m.sessionId; ws.send(JSON.stringify({ type: 'start_terminal', cols: 120, rows: 30 })); }
      else if (m.type === 'terminal_started') { started = Date.now() - t0; }
      else if (m.type === 'error') { err = m.message; }
    });
    setTimeout(() => { try { ws.close(); } catch {} resolve({ label, started, firstOut, err, sid }); }, 8000);
  });
}

function startCodex() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'create_session', name: 'codex-ai', workingDir: ROOT })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'session_created') ws.send(JSON.stringify({ type: 'start_codex', cols: 120, rows: 30 }));
      else if (m.type === 'codex_started') resolve(ws); // keep ws open (agent running)
    });
    setTimeout(() => resolve(ws), 6000);
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 2500)); // server boot
  const r1 = await openTerminal('term-1-cold');
  const r2 = await openTerminal('term-2');
  console.log('[codex] starting an AI agent (triggers sticky-note model load ~12s later)...');
  const codexWs = await startCodex();
  // Open terminals repeatedly across the next ~25s, spanning the sticky-note load window.
  const during = [];
  for (let i = 0; i < 4; i++) { during.push(await openTerminal(`term-during-load-${i}`)); }
  try { codexWs.close(); } catch {}

  const fmt = (r) => `${r.label}: started=${r.started}ms firstOutput=${r.firstOut}ms${r.err ? ' ERROR=' + r.err : ''}`;
  console.log('\n=== terminal time-to-first-output (prompt) ===');
  for (const r of [r1, r2, ...during]) console.log('  ' + fmt(r));
  const all = [r1, r2, ...during];
  const hung = all.filter((r) => r.firstOut === null);
  const slow = all.filter((r) => r.firstOut !== null && r.firstOut > 2000);
  console.log(`\nhung (no output in 8s): ${hung.length} | slow (>2s): ${slow.length} | total: ${all.length}`);
  console.log('sticky engine in server:', /sticky-notes|node-llama|Gathering/i.test(srvLog) ? 'active' : 'n/a', '| EAGAIN logged:', /EAGAIN/.test(srvLog) ? 'yes' : 'no', '| watchdog spawn-failure:', /no response within/.test(srvLog) ? 'YES' : 'no');
  srv.kill('SIGKILL');
  process.exit(hung.length ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill('SIGKILL'); process.exit(1); });
